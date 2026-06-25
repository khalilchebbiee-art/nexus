import { ConversationRole, ConversationType, MessageType, NotificationType, Prisma } from "@prisma/client";
import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { requireAuth } from "../auth.js";
import {
  conversationSchema,
  editMessageSchema,
  forwardMessageSchema,
  mediaCaptionSchema,
  muteSchema,
  reactionSchema,
  textMessageSchema,
  updateConversationSchema
} from "../validators.js";
import { AppError, handleError, publicUser } from "../utils.js";
import { extensionForMime } from "../media.js";
import { persistUpload } from "../storage.js";
import { sendPushToUser } from "../push.js";
import { onlineUsers, emitToUser } from "../io.js";
import { blockedBetween } from "./friends.js";
import { FriendshipStatus } from "@prisma/client";
import type { Server } from "socket.io";

const uploadRoot = path.resolve("uploads");
fs.mkdirSync(uploadRoot, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, uploadRoot),
  filename: (_req, file, callback) => {
    // Derive the extension from the (allow-listed) mimetype, never from the
    // client-supplied originalname — otherwise an attacker could upload
    // `x.html` with an image mimetype and have it served as executable HTML.
    const safeExt = extensionForMime(file.mimetype);
    callback(null, `${Date.now()}-${crypto.randomUUID()}${safeExt}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const allowed = ["image/", "video/", "audio/"];
    callback(null, allowed.some((prefix) => file.mimetype.startsWith(prefix)));
  }
});

export function conversationsRouter(io: Server) {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (req, res) => {
    const userId = req.user!.id;
    const conversations = await prisma.conversation.findMany({
      where: { members: { some: { userId } } },
      include: {
        members: { include: { user: true } },
        messages: {
          where: { deliveredAt: { not: null } },
          orderBy: { createdAt: "desc" },
          take: 1,
          include: messageInclude()
        }
      },
      orderBy: { updatedAt: "desc" }
    });

    const myMembership = new Map(
      conversations.flatMap((conversation) =>
        conversation.members
          .filter((member) => member.userId === userId)
          .map((member) => [conversation.id, member] as const)
      )
    );

    // Hide conversations the user "deleted" until a newer message arrives.
    const visible = conversations.filter((conversation) => {
      const hiddenAt = myMembership.get(conversation.id)?.hiddenAt;
      if (!hiddenAt) return true;
      const last = conversation.messages[0];
      return Boolean(last && new Date(last.createdAt).getTime() > new Date(hiddenAt).getTime());
    });

    const unread = await unreadCounts(userId, visible.map((conversation) => conversation.id));
    const now = Date.now();

    res.json({
      conversations: visible.map((conversation) => {
        const membership = myMembership.get(conversation.id);
        return serializeConversation(conversation, {
          unreadCount: unread.get(conversation.id) ?? 0,
          muted: Boolean(membership?.mutedUntil && new Date(membership.mutedUntil).getTime() > now),
          archived: Boolean(membership?.archivedAt)
        });
      })
    });
  });

  router.post("/", async (req, res) => {
    try {
      const input = conversationSchema.parse(req.body);
      // Only the creator's accepted friends may be added — no unconsented adds.
      const allowed = await acceptedFriendIds(req.user!.id, input.memberIds);
      const memberIds = Array.from(new Set([req.user!.id, ...allowed]));
      const conversation = await prisma.conversation.create({
        data: {
          type: input.type as ConversationType,
          name: input.name,
          description: input.description ?? "",
          ownerId: req.user!.id,
          members: {
            create: memberIds.map((userId) => ({
              userId,
              role: userId === req.user!.id ? ConversationRole.OWNER : ConversationRole.MEMBER
            }))
          }
        },
        include: { members: { include: { user: true } }, messages: { include: messageInclude() } }
      });
      res.status(201).json({ conversation: serializeConversation(conversation) });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.patch("/:conversationId", async (req, res) => {
    try {
      const conversationId = String(req.params.conversationId);
      await requireManager(req.user!.id, conversationId);
      const input = updateConversationSchema.parse(req.body);
      const newMemberIds = input.memberIds ? await acceptedFriendIds(req.user!.id, input.memberIds) : undefined;
      const conversation = await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          name: input.name,
          description: input.description,
          members: newMemberIds
            ? {
                create: newMemberIds.map((userId) => ({
                  userId,
                  role: ConversationRole.MEMBER
                }))
              }
            : undefined
        },
        include: { members: { include: { user: true } }, messages: { take: 1, include: messageInclude() } }
      });
      res.json({ conversation: serializeConversation(conversation) });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/search", async (req, res) => {
    const query = String(req.query.q ?? "").trim();
    if (query.length < 2) {
      res.json({ messages: [], files: [], conversations: [] });
      return;
    }

    const memberConversationIds = await prisma.conversationMember.findMany({
      where: { userId: req.user!.id },
      select: { conversationId: true }
    });
    const conversationIds = memberConversationIds.map((item) => item.conversationId);
    const [messages, files, conversations] = await Promise.all([
      prisma.message.findMany({
        where: {
          conversationId: { in: conversationIds },
          deliveredAt: { not: null },
          deletedAt: null,
          encrypted: false,
          body: { contains: query, mode: "insensitive" }
        },
        include: messageInclude(),
        orderBy: { createdAt: "desc" },
        take: 20
      }),
      prisma.message.findMany({
        where: {
          conversationId: { in: conversationIds },
          deliveredAt: { not: null },
          deletedAt: null,
          mediaUrl: { not: null },
          OR: [{ mediaMime: { contains: query, mode: "insensitive" } }, { body: { contains: query, mode: "insensitive" } }]
        },
        include: messageInclude(),
        orderBy: { createdAt: "desc" },
        take: 20
      }),
      prisma.conversation.findMany({
        where: {
          id: { in: conversationIds },
          OR: [{ name: { contains: query, mode: "insensitive" } }, { description: { contains: query, mode: "insensitive" } }]
        },
        include: { members: { include: { user: true } }, messages: { take: 1, include: messageInclude() } },
        take: 12
      })
    ]);

    res.json({ messages, files, conversations: conversations.map((conversation) => serializeConversation(conversation)) });
  });

  router.get("/:conversationId/messages", async (req, res) => {
    const conversationId = String(req.params.conversationId);
    const canRead = await canAccess(req.user!.id, conversationId);
    if (!canRead) {
      res.status(403).json({ message: "Conversation unavailable" });
      return;
    }

    // Fetch the most RECENT page (desc + take), then flip to chronological order
    // for display. With `before=<messageId>` we page backwards through history
    // for infinite scroll-up; `hasMore` tells the client another page exists.
    const PAGE = 40;
    const before = req.query.before ? String(req.query.before) : undefined;
    let cursorDate: Date | undefined;
    if (before) {
      const anchor = await prisma.message.findFirst({ where: { id: before, conversationId }, select: { createdAt: true } });
      cursorDate = anchor?.createdAt;
    }

    const page = await prisma.message.findMany({
      where: { conversationId, deliveredAt: { not: null }, ...(cursorDate ? { createdAt: { lt: cursorDate } } : {}) },
      include: messageInclude(),
      orderBy: { createdAt: "desc" },
      take: PAGE + 1
    });
    const hasMore = page.length > PAGE;
    const messages = page.slice(0, PAGE).reverse();
    res.json({ messages, hasMore });
  });

  router.get("/:conversationId/media", async (req, res) => {
    const conversationId = String(req.params.conversationId);
    const canRead = await canAccess(req.user!.id, conversationId);
    if (!canRead) {
      res.status(403).json({ message: "Conversation unavailable" });
      return;
    }

    const media = await prisma.message.findMany({
      where: { conversationId, deliveredAt: { not: null }, deletedAt: null, mediaUrl: { not: null } },
      include: messageInclude(),
      orderBy: { createdAt: "desc" },
      take: 80
    });
    res.json({ media });
  });

  router.post("/:conversationId/messages", async (req, res) => {
    try {
      const conversationId = String(req.params.conversationId);
      const input = textMessageSchema.parse(req.body);
      const message = await createMessage(conversationId, req.user!.id, {
        type: MessageType.TEXT,
        body: input.body,
        encrypted: input.encrypted ?? false,
        replyToId: input.replyToId,
        scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : undefined
      });
      await notifyMembers(message, input.scheduledFor ? NotificationType.SCHEDULED : NotificationType.MESSAGE);
      if (message.deliveredAt) io.to(conversationId).emit("message:new", message);
      res.status(201).json({ message });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/:conversationId/media", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ message: "Media file required" });
        return;
      }

      const input = mediaCaptionSchema.parse({
        caption: req.body.caption,
        scheduledFor: req.body.scheduledFor || undefined
      });
      const type = req.file.mimetype.startsWith("image/")
        ? MessageType.IMAGE
        : req.file.mimetype.startsWith("video/")
          ? MessageType.VIDEO
          : MessageType.VOICE;

      const mediaUrl = await persistUpload(req.file);
      const conversationId = String(req.params.conversationId);
      const message = await createMessage(conversationId, req.user!.id, {
        type,
        body: input.caption ?? "",
        mediaUrl,
        originalMediaUrl: mediaUrl,
        mediaMime: req.file.mimetype,
        mediaSize: req.file.size,
        scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : undefined
      });
      await notifyMembers(message, input.scheduledFor ? NotificationType.SCHEDULED : NotificationType.MESSAGE);
      if (message.deliveredAt) io.to(conversationId).emit("message:new", message);
      res.status(201).json({ message });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.patch("/:conversationId/messages/:messageId", async (req, res) => {
    try {
      const { conversationId, messageId } = req.params;
      const input = editMessageSchema.parse(req.body);
      const message = await prisma.message.findFirst({ where: { id: messageId, conversationId } });
      if (!message || message.senderId !== req.user!.id || message.deletedAt) {
        res.status(403).json({ message: "Message cannot be edited" });
        return;
      }
      const updated = await prisma.message.update({
        where: { id: messageId },
        data: { body: input.body, editedAt: new Date() },
        include: messageInclude()
      });
      io.to(conversationId).emit("message:updated", updated);
      res.json({ message: updated });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.delete("/:conversationId/messages/:messageId", async (req, res) => {
    const { conversationId, messageId } = req.params;
    const message = await prisma.message.findFirst({ where: { id: messageId, conversationId } });
    const manager = await isManager(req.user!.id, conversationId);
    if (!message || (message.senderId !== req.user!.id && !manager)) {
      res.status(403).json({ message: "Message cannot be deleted" });
      return;
    }
    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { deletedAt: new Date(), body: "", mediaUrl: null, originalMediaUrl: null },
      include: messageInclude()
    });
    io.to(conversationId).emit("message:updated", updated);
    res.json({ message: updated });
  });

  router.post("/:conversationId/messages/:messageId/reactions", async (req, res) => {
    try {
      const { conversationId, messageId } = req.params;
      const input = reactionSchema.parse(req.body);
      const canRead = await canAccess(req.user!.id, conversationId);
      if (!canRead) {
        res.status(403).json({ message: "Conversation unavailable" });
        return;
      }

      await prisma.messageReaction.upsert({
        where: { messageId_userId_emoji: { messageId, userId: req.user!.id, emoji: input.emoji } },
        create: { messageId, userId: req.user!.id, emoji: input.emoji },
        update: {}
      });
      const message = await prisma.message.findUniqueOrThrow({ where: { id: messageId }, include: messageInclude() });
      await notifyMembers(message, NotificationType.REACTION, `${req.user!.displayName} reacted ${input.emoji}`);
      io.to(conversationId).emit("message:updated", message);
      res.status(201).json({ message });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.delete("/:conversationId/messages/:messageId/reactions/:emoji", async (req, res) => {
    const { conversationId, messageId, emoji } = req.params;
    await prisma.messageReaction.deleteMany({ where: { messageId, userId: req.user!.id, emoji: decodeURIComponent(emoji) } });
    const message = await prisma.message.findUniqueOrThrow({ where: { id: messageId }, include: messageInclude() });
    io.to(conversationId).emit("message:updated", message);
    res.json({ message });
  });

  router.get("/:conversationId/pins", async (req, res) => {
    const conversationId = String(req.params.conversationId);
    if (!(await canAccess(req.user!.id, conversationId))) {
      res.status(403).json({ message: "Conversation unavailable" });
      return;
    }
    const pins = await prisma.message.findMany({
      where: { conversationId, pinnedAt: { not: null }, deletedAt: null },
      include: messageInclude(),
      orderBy: { pinnedAt: "desc" },
      take: 50
    });
    res.json({ pins });
  });

  // Forward an existing (readable) message into another conversation the caller
  // belongs to. Encrypted messages can't be forwarded — the server can't read
  // them and the destination peer couldn't decrypt the copied ciphertext.
  router.post("/:conversationId/messages/:messageId/forward", async (req, res) => {
    try {
      const { conversationId, messageId } = req.params;
      const input = forwardMessageSchema.parse(req.body);
      if (!(await canAccess(req.user!.id, conversationId))) {
        res.status(403).json({ message: "Conversation unavailable" });
        return;
      }
      const source = await prisma.message.findFirst({ where: { id: messageId, conversationId } });
      if (!source || source.deletedAt) {
        res.status(404).json({ message: "Message not found" });
        return;
      }
      if (source.encrypted) {
        res.status(400).json({ message: "Encrypted messages can't be forwarded" });
        return;
      }
      const message = await createMessage(input.toConversationId, req.user!.id, {
        type: source.type,
        body: source.body,
        mediaUrl: source.mediaUrl ?? undefined,
        originalMediaUrl: source.originalMediaUrl ?? undefined,
        mediaMime: source.mediaMime ?? undefined,
        mediaSize: source.mediaSize ?? undefined
      });
      await notifyMembers(message, NotificationType.MESSAGE);
      io.to(input.toConversationId).emit("message:new", message);
      res.status(201).json({ message });
    } catch (error) {
      handleError(res, error);
    }
  });

  // Mute / unmute notifications for this member.
  router.post("/:conversationId/mute", async (req, res) => {
    try {
      const conversationId = String(req.params.conversationId);
      if (!(await canAccess(req.user!.id, conversationId))) {
        res.status(403).json({ message: "Conversation unavailable" });
        return;
      }
      const input = muteSchema.parse(req.body ?? {});
      const mutedUntil = input.minutes ? new Date(Date.now() + input.minutes * 60_000) : new Date("9999-12-31T00:00:00.000Z");
      await prisma.conversationMember.updateMany({ where: { userId: req.user!.id, conversationId }, data: { mutedUntil } });
      res.json({ muted: true, mutedUntil });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/:conversationId/unmute", async (req, res) => {
    const conversationId = String(req.params.conversationId);
    await prisma.conversationMember.updateMany({ where: { userId: req.user!.id, conversationId }, data: { mutedUntil: null } });
    res.json({ muted: false });
  });

  // Archive / unarchive for this member (sticky — new messages don't unarchive).
  router.post("/:conversationId/archive", async (req, res) => {
    const conversationId = String(req.params.conversationId);
    await prisma.conversationMember.updateMany({ where: { userId: req.user!.id, conversationId }, data: { archivedAt: new Date() } });
    res.json({ archived: true });
  });

  router.post("/:conversationId/unarchive", async (req, res) => {
    const conversationId = String(req.params.conversationId);
    await prisma.conversationMember.updateMany({ where: { userId: req.user!.id, conversationId }, data: { archivedAt: null } });
    res.json({ archived: false });
  });

  // Leave a group/channel. Direct chats can't be "left" — they're hidden via DELETE.
  router.post("/:conversationId/leave", async (req, res) => {
    const conversationId = String(req.params.conversationId);
    const membership = await prisma.conversationMember.findUnique({
      where: { userId_conversationId: { userId: req.user!.id, conversationId } },
      include: { conversation: true }
    });
    if (!membership) {
      res.status(404).json({ message: "Conversation not found" });
      return;
    }
    if (membership.conversation.type === ConversationType.DIRECT) {
      res.status(400).json({ message: "Direct chats can't be left" });
      return;
    }
    await leaveConversation(io, conversationId, req.user!.id, membership.role === ConversationRole.OWNER);
    res.status(204).end();
  });

  // Generic "delete chat": hide a direct chat; leave (or delete, if owner) a group.
  router.delete("/:conversationId", async (req, res) => {
    const conversationId = String(req.params.conversationId);
    const membership = await prisma.conversationMember.findUnique({
      where: { userId_conversationId: { userId: req.user!.id, conversationId } },
      include: { conversation: true }
    });
    if (!membership) {
      res.status(404).json({ message: "Conversation not found" });
      return;
    }

    if (membership.conversation.type === ConversationType.DIRECT) {
      await prisma.conversationMember.update({
        where: { userId_conversationId: { userId: req.user!.id, conversationId } },
        data: { hiddenAt: new Date() }
      });
      res.json({ hidden: true });
      return;
    }

    if (membership.role === ConversationRole.OWNER) {
      const memberIds = await allMemberIds(conversationId);
      await prisma.conversation.delete({ where: { id: conversationId } });
      for (const id of memberIds) emitToUser(id, "conversation:removed", { conversationId });
      res.json({ deleted: true });
      return;
    }

    await leaveConversation(io, conversationId, req.user!.id, false);
    res.json({ left: true });
  });

  // Remove a member from a group/channel (managers only). Can't remove the owner.
  router.delete("/:conversationId/members/:userId", async (req, res) => {
    try {
      const { conversationId, userId } = req.params;
      await requireManager(req.user!.id, conversationId);
      const target = await prisma.conversationMember.findUnique({
        where: { userId_conversationId: { userId, conversationId } }
      });
      if (!target) {
        res.status(404).json({ message: "Member not found" });
        return;
      }
      if (target.role === ConversationRole.OWNER) {
        res.status(403).json({ message: "The owner can't be removed" });
        return;
      }
      await prisma.conversationMember.delete({ where: { userId_conversationId: { userId, conversationId } } });
      const conversation = await loadSerialized(conversationId);
      if (conversation) io.to(conversationId).emit("conversation:updated", conversation);
      emitToUser(userId, "conversation:removed", { conversationId });
      res.json({ conversation });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/:conversationId/messages/:messageId/pin", async (req, res) => {
    const { conversationId, messageId } = req.params;
    if (!(await canAccess(req.user!.id, conversationId))) {
      res.status(403).json({ message: "Conversation unavailable" });
      return;
    }
    const existing = await prisma.message.findFirst({ where: { id: messageId, conversationId } });
    if (!existing) {
      res.status(404).json({ message: "Message not found" });
      return;
    }
    const pinning = !existing.pinnedAt;
    const message = await prisma.message.update({
      where: { id: messageId },
      data: { pinnedAt: pinning ? new Date() : null, pinnedById: pinning ? req.user!.id : null },
      include: messageInclude()
    });
    io.to(conversationId).emit("message:updated", message);
    res.json({ message });
  });

  return router;
}

export function startScheduledMessageWorker(io: Server) {
  setInterval(() => {
    void deliverScheduledMessages(io);
  }, 15_000);
}

async function deliverScheduledMessages(io: Server) {
  const due = await prisma.message.findMany({
    where: { scheduledFor: { lte: new Date() }, deliveredAt: null, deletedAt: null },
    include: messageInclude(),
    take: 25
  });
  for (const message of due) {
    const delivered = await prisma.message.update({
      where: { id: message.id },
      data: { deliveredAt: new Date() },
      include: messageInclude()
    });
    await notifyMembers(delivered, NotificationType.MESSAGE);
    io.to(delivered.conversationId).emit("message:new", delivered);
  }
}

function messageInclude() {
  return {
    sender: true,
    replyTo: { include: { sender: true } },
    reactions: { include: { user: true }, orderBy: { createdAt: "asc" as const } }
  };
}

async function createMessage(
  conversationId: string,
  senderId: string,
  data: {
    type: MessageType;
    body?: string;
    encrypted?: boolean;
    replyToId?: string;
    mediaUrl?: string;
    originalMediaUrl?: string;
    mediaMime?: string;
    mediaSize?: number;
    scheduledFor?: Date;
  }
) {
  const membership = await prisma.conversationMember.findUnique({
    where: { userId_conversationId: { userId: senderId, conversationId } },
    include: { conversation: true }
  });
  if (!membership) throw new AppError(403, "Conversation unavailable");
  if (membership.conversation.type === ConversationType.CHANNEL && membership.role === ConversationRole.MEMBER) {
    throw new AppError(403, "Only channel admins can post");
  }
  // Can't message someone you've blocked or who has blocked you.
  if (membership.conversation.type === ConversationType.DIRECT) {
    const other = await prisma.conversationMember.findFirst({
      where: { conversationId, userId: { not: senderId } },
      select: { userId: true }
    });
    if (other && (await blockedBetween(senderId, other.userId))) {
      throw new AppError(403, "You can't message this person");
    }
  }

  const scheduled = data.scheduledFor && data.scheduledFor > new Date();
  return prisma.message.create({
    data: {
      conversationId,
      senderId,
      ...data,
      storageProvider: env.MEDIA_STORAGE_PROVIDER,
      deliveredAt: scheduled ? null : new Date()
    },
    include: messageInclude()
  });
}

async function canAccess(userId: string, conversationId: string) {
  return prisma.conversationMember.findUnique({
    where: { userId_conversationId: { userId, conversationId } }
  });
}

async function allMemberIds(conversationId: string): Promise<string[]> {
  const members = await prisma.conversationMember.findMany({ where: { conversationId }, select: { userId: true } });
  return members.map((member) => member.userId);
}

// Re-fetch a conversation in the same shape the list/patch endpoints return, so
// realtime "conversation:updated" payloads match what the client already holds.
async function loadSerialized(conversationId: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { members: { include: { user: true } }, messages: { where: { deliveredAt: { not: null } }, orderBy: { createdAt: "desc" }, take: 1, include: messageInclude() } }
  });
  return conversation ? serializeConversation(conversation) : null;
}

// Remove a member from a group/channel. If the owner leaves, ownership passes to
// the earliest-joined remaining member so the group never becomes orphaned.
async function leaveConversation(io: Server, conversationId: string, userId: string, wasOwner: boolean) {
  await prisma.conversationMember.delete({ where: { userId_conversationId: { userId, conversationId } } });
  if (wasOwner) {
    const heir = await prisma.conversationMember.findFirst({
      where: { conversationId },
      orderBy: { joinedAt: "asc" }
    });
    if (heir) {
      await prisma.$transaction([
        prisma.conversationMember.update({ where: { id: heir.id }, data: { role: ConversationRole.OWNER } }),
        prisma.conversation.update({ where: { id: conversationId }, data: { ownerId: heir.userId } })
      ]);
    } else {
      // Last member left — nothing to own; drop the empty conversation.
      await prisma.conversation.delete({ where: { id: conversationId } }).catch(() => {});
    }
  }
  emitToUser(userId, "conversation:removed", { conversationId });
  const conversation = await loadSerialized(conversationId);
  if (conversation) io.to(conversationId).emit("conversation:updated", conversation);
}

async function isManager(userId: string, conversationId: string) {
  const member = await canAccess(userId, conversationId);
  return member?.role === ConversationRole.OWNER || member?.role === ConversationRole.ADMIN;
}

async function requireManager(userId: string, conversationId: string) {
  if (!(await isManager(userId, conversationId))) throw new AppError(403, "Conversation admin access required");
}

// Narrows a requested member-id list to the subset that are accepted friends of
// the actor — prevents adding arbitrary users to a group/channel.
async function acceptedFriendIds(userId: string, requested: string[]): Promise<string[]> {
  if (requested.length === 0) return [];
  const wanted = new Set(requested);
  const rows = await prisma.friendship.findMany({
    where: {
      status: FriendshipStatus.ACCEPTED,
      OR: [{ requesterId: userId }, { receiverId: userId }]
    },
    select: { requesterId: true, receiverId: true }
  });
  const friends = new Set(rows.map((r) => (r.requesterId === userId ? r.receiverId : r.requesterId)));
  return [...wanted].filter((id) => friends.has(id));
}

async function notifyMembers(
  message: { id: string; conversationId: string; senderId: string; body: string; type: MessageType; encrypted?: boolean },
  type: NotificationType,
  overrideBody?: string
) {
  const members = await prisma.conversationMember.findMany({
    where: { conversationId: message.conversationId, userId: { not: message.senderId } }
  });
  if (members.length === 0) return;
  const body =
    overrideBody ??
    (message.encrypted
      ? "Encrypted message"
      : message.type === MessageType.TEXT
        ? message.body.slice(0, 120)
        : `${message.type.toLowerCase()} shared`);
  await prisma.notification.createMany({
    data: members.map((member) => ({
      userId: member.userId,
      type,
      title: type === NotificationType.SCHEDULED ? "Scheduled message" : "New activity",
      body,
      conversationId: message.conversationId,
      messageId: message.id
    }))
  });

  // Web Push to recipients who are currently offline (no live socket) so the
  // message reaches them with the app closed. Online users already get the
  // realtime event + in-app notification. Skip reaction noise.
  if (type === NotificationType.MESSAGE || type === NotificationType.SCHEDULED) {
    const now = Date.now();
    const offline = members.filter(
      (member) => !onlineUsers.has(member.userId) && !(member.mutedUntil && member.mutedUntil.getTime() > now)
    );
    if (offline.length > 0) {
      const sender = await prisma.user.findUnique({
        where: { id: message.senderId },
        select: { displayName: true, avatarUrl: true }
      });
      const title = sender?.displayName ?? "Nexus";
      for (const member of offline) {
        void sendPushToUser(member.userId, {
          title,
          body,
          conversationId: message.conversationId,
          icon: sender?.avatarUrl ?? null
        });
      }
    }
  }
}

function serializeConversation(
  conversation: {
    id: string;
    type: ConversationType;
    name: string | null;
    description: string;
    ownerId: string | null;
    members: Array<{
      role?: ConversationRole;
      lastDeliveredAt?: Date | null;
      lastReadAt?: Date | null;
      user: Parameters<typeof publicUser>[0] & { lastSeenAt?: Date | null };
    }>;
    messages?: unknown[];
  },
  extra: { unreadCount?: number; muted?: boolean; archived?: boolean } = {}
) {
  return {
    id: conversation.id,
    type: conversation.type,
    name: conversation.name,
    description: conversation.description,
    ownerId: conversation.ownerId,
    members: conversation.members.map((member) => ({
      ...publicUser(member.user),
      role: member.role ?? ConversationRole.MEMBER,
      lastDeliveredAt: member.lastDeliveredAt ?? null,
      lastReadAt: member.lastReadAt ?? null,
      online: onlineUsers.has(member.user.id),
      lastSeenAt: member.user.lastSeenAt ?? null
    })),
    lastMessage: conversation.messages?.[0] ?? null,
    unreadCount: extra.unreadCount ?? 0,
    muted: extra.muted ?? false,
    archived: extra.archived ?? false
  };
}

// Per-conversation unread count for a user in one query: messages from other
// people, delivered, not deleted, newer than the member's lastReadAt.
async function unreadCounts(userId: string, conversationIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (conversationIds.length === 0) return result;
  const rows = await prisma.$queryRaw<Array<{ conversationId: string; unread: bigint }>>`
    SELECT m."conversationId" AS "conversationId", COUNT(*)::bigint AS unread
    FROM "Message" m
    JOIN "ConversationMember" cm
      ON cm."conversationId" = m."conversationId" AND cm."userId" = ${userId}
    WHERE m."conversationId" IN (${Prisma.join(conversationIds)})
      AND m."senderId" <> ${userId}
      AND m."deletedAt" IS NULL
      AND m."deliveredAt" IS NOT NULL
      AND (cm."lastReadAt" IS NULL OR m."createdAt" > cm."lastReadAt")
    GROUP BY m."conversationId"
  `;
  for (const row of rows) result.set(row.conversationId, Number(row.unread));
  return result;
}
