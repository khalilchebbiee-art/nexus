import { ConversationRole, ConversationType, MessageType, NotificationType } from "@prisma/client";
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
  mediaCaptionSchema,
  reactionSchema,
  textMessageSchema,
  updateConversationSchema
} from "../validators.js";
import { handleError, publicUser } from "../utils.js";
import { onlineUsers } from "../io.js";
import type { Server } from "socket.io";

const uploadRoot = path.resolve("uploads");
fs.mkdirSync(uploadRoot, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, uploadRoot),
  filename: (_req, file, callback) => {
    const safeExt = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, "");
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
    const conversations = await prisma.conversation.findMany({
      where: { members: { some: { userId: req.user!.id } } },
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

    res.json({ conversations: conversations.map(serializeConversation) });
  });

  router.post("/", async (req, res) => {
    try {
      const input = conversationSchema.parse(req.body);
      const memberIds = Array.from(new Set([req.user!.id, ...input.memberIds]));
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
      const conversation = await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          name: input.name,
          description: input.description,
          members: input.memberIds
            ? {
                create: input.memberIds.map((userId) => ({
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

    res.json({ messages, files, conversations: conversations.map(serializeConversation) });
  });

  router.get("/:conversationId/messages", async (req, res) => {
    const conversationId = String(req.params.conversationId);
    const canRead = await canAccess(req.user!.id, conversationId);
    if (!canRead) {
      res.status(403).json({ message: "Conversation unavailable" });
      return;
    }

    const messages = await prisma.message.findMany({
      where: { conversationId, deliveredAt: { not: null } },
      include: messageInclude(),
      orderBy: { createdAt: "asc" },
      take: 150
    });
    res.json({ messages });
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

      const mediaUrl = mediaUrlFor(req.file.filename);
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
  if (!membership) throw new Error("Conversation unavailable");
  if (membership.conversation.type === ConversationType.CHANNEL && membership.role === ConversationRole.MEMBER) {
    throw new Error("Only channel admins can post");
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

async function isManager(userId: string, conversationId: string) {
  const member = await canAccess(userId, conversationId);
  return member?.role === ConversationRole.OWNER || member?.role === ConversationRole.ADMIN;
}

async function requireManager(userId: string, conversationId: string) {
  if (!(await isManager(userId, conversationId))) throw new Error("Conversation admin access required");
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
}

function mediaUrlFor(filename: string) {
  if (env.MEDIA_PUBLIC_BASE_URL) return `${env.MEDIA_PUBLIC_BASE_URL.replace(/\/$/, "")}/${filename}`;
  return `/uploads/${filename}`;
}

function serializeConversation(conversation: {
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
}) {
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
    lastMessage: conversation.messages?.[0] ?? null
  };
}
