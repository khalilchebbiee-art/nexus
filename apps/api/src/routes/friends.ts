import { FriendshipStatus } from "@prisma/client";
import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../auth.js";
import { publicUser } from "../utils.js";
import { emitToUser, onlineUsers } from "../io.js";

export const friendsRouter = Router();

friendsRouter.use(requireAuth);

function withPresence(user: Parameters<typeof publicUser>[0] & { lastSeenAt?: Date | null }) {
  return { ...publicUser(user), online: onlineUsers.has(user.id), lastSeenAt: user.lastSeenAt ?? null };
}

// True when either user has blocked the other. Used to gate friend requests,
// search visibility, and direct messaging. Exported for reuse elsewhere.
export async function blockedBetween(a: string, b: string): Promise<boolean> {
  const row = await prisma.friendship.findFirst({
    where: {
      status: FriendshipStatus.BLOCKED,
      OR: [
        { requesterId: a, receiverId: b },
        { requesterId: b, receiverId: a }
      ]
    },
    select: { id: true }
  });
  return Boolean(row);
}

friendsRouter.get("/", async (req, res) => {
  const rows = await prisma.friendship.findMany({
    where: {
      status: FriendshipStatus.ACCEPTED,
      OR: [{ requesterId: req.user!.id }, { receiverId: req.user!.id }]
    },
    include: { requester: true, receiver: true },
    orderBy: { updatedAt: "desc" }
  });

  res.json({
    friends: rows.map((row) => withPresence(row.requesterId === req.user!.id ? row.receiver : row.requester))
  });
});

friendsRouter.get("/requests", async (req, res) => {
  const requests = await prisma.friendship.findMany({
    where: { receiverId: req.user!.id, status: FriendshipStatus.PENDING },
    include: { requester: true },
    orderBy: { createdAt: "desc" }
  });
  res.json({ requests: requests.map((request) => ({ id: request.id, user: publicUser(request.requester) })) });
});

friendsRouter.post("/:userId/request", async (req, res) => {
  const receiverId = req.params.userId;
  if (receiverId === req.user!.id) {
    res.status(400).json({ message: "You cannot add yourself" });
    return;
  }

  const existing = await prisma.friendship.findFirst({
    where: {
      OR: [
        { requesterId: req.user!.id, receiverId },
        { requesterId: receiverId, receiverId: req.user!.id }
      ]
    }
  });

  if (existing) {
    if (existing.status === FriendshipStatus.BLOCKED) {
      res.status(403).json({ message: "Unable to send request" });
      return;
    }
    res.status(409).json({ message: "Friend request already exists" });
    return;
  }

  const request = await prisma.friendship.create({ data: { requesterId: req.user!.id, receiverId } });
  emitToUser(receiverId, "friend:request", { id: request.id, user: publicUser(req.user!) });
  res.status(201).json({ request });
});

friendsRouter.post("/requests/:requestId/accept", async (req, res) => {
  const request = await prisma.friendship.findFirst({
    where: { id: req.params.requestId, receiverId: req.user!.id, status: FriendshipStatus.PENDING }
  });

  if (!request) {
    res.status(404).json({ message: "Request not found" });
    return;
  }

  await prisma.friendship.update({
    where: { id: request.id },
    data: { status: FriendshipStatus.ACCEPTED }
  });

  const conversation = await prisma.conversation.create({
    data: {
      members: {
        create: [{ userId: request.requesterId }, { userId: request.receiverId }]
      }
    },
    include: { members: true }
  });

  // Tell the original requester their request was accepted so their UI updates live.
  emitToUser(request.requesterId, "friend:accepted", { conversationId: conversation.id, user: publicUser(req.user!) });
  res.json({ conversationId: conversation.id });
});

friendsRouter.post("/requests/:requestId/decline", async (req, res) => {
  await prisma.friendship.updateMany({
    where: { id: req.params.requestId, receiverId: req.user!.id, status: FriendshipStatus.PENDING },
    data: { status: FriendshipStatus.DECLINED }
  });
  res.status(204).end();
});

// Remove a relationship: unfriend, cancel an outgoing request, or clear a
// previously declined one. Blocks are intentionally untouched here — they are
// only lifted via /unblock so a user can't quietly drop someone's block on them.
friendsRouter.delete("/:userId", async (req, res) => {
  const otherId = req.params.userId;
  const result = await prisma.friendship.deleteMany({
    where: {
      status: { not: FriendshipStatus.BLOCKED },
      OR: [
        { requesterId: req.user!.id, receiverId: otherId },
        { requesterId: otherId, receiverId: req.user!.id }
      ]
    }
  });
  if (result.count > 0) emitToUser(otherId, "friend:removed", { userId: req.user!.id });
  res.status(204).end();
});

// Block a user. Any existing relationship is converted to a block owned by the
// caller (direction encodes who blocked whom).
friendsRouter.post("/:userId/block", async (req, res) => {
  const otherId = req.params.userId;
  if (otherId === req.user!.id) {
    res.status(400).json({ message: "You cannot block yourself" });
    return;
  }
  const existing = await prisma.friendship.findFirst({
    where: {
      OR: [
        { requesterId: req.user!.id, receiverId: otherId },
        { requesterId: otherId, receiverId: req.user!.id }
      ]
    }
  });
  if (existing) {
    await prisma.friendship.update({
      where: { id: existing.id },
      data: { requesterId: req.user!.id, receiverId: otherId, status: FriendshipStatus.BLOCKED }
    });
  } else {
    await prisma.friendship.create({
      data: { requesterId: req.user!.id, receiverId: otherId, status: FriendshipStatus.BLOCKED }
    });
  }
  emitToUser(otherId, "friend:removed", { userId: req.user!.id });
  res.json({ ok: true });
});

// Unblock — only the user who created the block can lift it.
friendsRouter.post("/:userId/unblock", async (req, res) => {
  await prisma.friendship.deleteMany({
    where: { requesterId: req.user!.id, receiverId: req.params.userId, status: FriendshipStatus.BLOCKED }
  });
  res.json({ ok: true });
});

// Users the caller has blocked (for a privacy/settings screen).
friendsRouter.get("/blocked", async (req, res) => {
  const rows = await prisma.friendship.findMany({
    where: { requesterId: req.user!.id, status: FriendshipStatus.BLOCKED },
    include: { receiver: true },
    orderBy: { updatedAt: "desc" }
  });
  res.json({ blocked: rows.map((row) => publicUser(row.receiver)) });
});
