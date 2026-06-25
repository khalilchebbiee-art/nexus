import type { Server, Socket } from "socket.io";
import { CallStatus, CallType, MessageType, NotificationType } from "@prisma/client";
import { getUserFromToken } from "./auth.js";
import { prisma } from "./db.js";
import { iceServers } from "./ice.js";
import { AppError, publicUser } from "./utils.js";
import { onlineUsers } from "./io.js";
import { createMessage, notifyMembers } from "./routes/conversations.js";
import { textMessageSchema } from "./validators.js";

async function friendIds(userId: string) {
  const rows = await prisma.friendship.findMany({
    where: { status: "ACCEPTED", OR: [{ requesterId: userId }, { receiverId: userId }] },
    select: { requesterId: true, receiverId: true }
  });
  return rows.map((row) => (row.requesterId === userId ? row.receiverId : row.requesterId));
}

const RING_TIMEOUT_MS = 35_000;
const ringTimers = new Map<string, NodeJS.Timeout>();

function userRoom(userId: string) {
  return `user:${userId}`;
}

export function configureRealtime(io: Server) {
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (typeof token !== "string") {
      next(new Error("Authentication required"));
      return;
    }
    const user = await getUserFromToken(token);
    if (!user) {
      next(new Error("Invalid session"));
      return;
    }
    socket.data.user = user;
    next();
  });

  io.on("connection", (socket) => {
    const userId = socket.data.user.id as string;
    // Personal room so calls and receipts can target a specific user.
    socket.join(userRoom(userId));

    // Join every conversation the user belongs to, so message:new / receipts /
    // typing arrive live for ALL chats — not just the one currently open. The
    // client only renders messages for the active chat and bumps unread badges
    // for the rest, so receiving these events everywhere is what makes unread
    // counts and list reordering update in real time.
    void prisma.conversationMember
      .findMany({ where: { userId }, select: { conversationId: true } })
      .then((rows) => {
        for (const row of rows) socket.join(row.conversationId);
      })
      .catch(() => {});

    // Presence: announce online to friends.
    const wasOffline = !onlineUsers.has(userId);
    onlineUsers.add(userId);
    if (wasOffline) {
      void friendIds(userId).then((ids) => {
        for (const id of ids) io.to(userRoom(id)).emit("presence:update", { userId, online: true });
      });
    }

    // Coming online means every pending message addressed to this user is now
    // delivered to a device. Stamp all their memberships and let senders know.
    void markAllDelivered(io, userId);

    socket.on("disconnect", async () => {
      const sockets = await io.in(userRoom(userId)).fetchSockets();
      if (sockets.length === 0) {
        onlineUsers.delete(userId);
        const lastSeenAt = new Date();
        await prisma.user.update({ where: { id: userId }, data: { lastSeenAt } }).catch(() => {});
        const ids = await friendIds(userId);
        for (const id of ids) io.to(userRoom(id)).emit("presence:update", { userId, online: false, lastSeenAt: lastSeenAt.toISOString() });
      }
    });

    socket.on("conversation:join", async (conversationId: string) => {
      const member = await prisma.conversationMember.findUnique({
        where: { userId_conversationId: { userId, conversationId } }
      });
      if (member) socket.join(conversationId);
    });

    // Recipient opened / is viewing a conversation: mark everything read.
    socket.on("conversation:read", async (conversationId: string) => {
      const now = new Date();
      const result = await prisma.conversationMember.updateMany({
        where: { userId, conversationId },
        data: { lastReadAt: now, lastDeliveredAt: now }
      });
      if (result.count > 0) {
        io.to(conversationId).emit("receipt:update", {
          conversationId,
          userId,
          lastReadAt: now.toISOString(),
          lastDeliveredAt: now.toISOString()
        });
      }
    });

    // Send a text message over the open socket — saves an HTTP round-trip and
    // the REST middleware/rate-limiter on the hot path. createMessage enforces
    // membership, channel-post rights, and blocks; a light per-socket bucket
    // caps write spam (REST limiter doesn't cover WS).
    const sendTimes: number[] = [];
    socket.on(
      "message:send",
      async (
        payload: { conversationId?: string; body?: string; encrypted?: boolean; replyToId?: string; scheduledFor?: string },
        ack?: (response: { message: unknown } | { error: string }) => void
      ) => {
        try {
          const now = Date.now();
          while (sendTimes.length && now - sendTimes[0] > 10_000) sendTimes.shift();
          if (sendTimes.length >= 30) {
            ack?.({ error: "Slow down" });
            return;
          }
          sendTimes.push(now);

          const conversationId = String(payload?.conversationId ?? "");
          if (!conversationId) {
            ack?.({ error: "Conversation required" });
            return;
          }
          const input = textMessageSchema.parse({
            body: payload?.body,
            encrypted: payload?.encrypted,
            replyToId: payload?.replyToId,
            scheduledFor: payload?.scheduledFor
          });
          const message = await createMessage(conversationId, userId, {
            type: MessageType.TEXT,
            body: input.body,
            encrypted: input.encrypted ?? false,
            replyToId: input.replyToId,
            scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : undefined
          });
          if (message.deliveredAt) io.to(conversationId).emit("message:new", message);
          void notifyMembers(message, input.scheduledFor ? NotificationType.SCHEDULED : NotificationType.MESSAGE).catch((error) =>
            console.error("notifyMembers", error)
          );
          ack?.({ message });
        } catch (error) {
          ack?.({ error: error instanceof AppError ? error.message : "Unable to send" });
        }
      }
    );

    socket.on("typing:start", (conversationId: string) => {
      socket.to(conversationId).emit("typing:start", { conversationId, user: socket.data.user });
    });

    socket.on("typing:stop", (conversationId: string) => {
      socket.to(conversationId).emit("typing:stop", { conversationId, userId });
    });

    registerCallHandlers(io, socket, userId);
  });
}

function registerCallHandlers(io: Server, socket: Socket, userId: string) {
  const caller = socket.data.user;

  // Place a call. Acks back with the call id + ICE servers for the offerer.
  socket.on(
    "call:invite",
    async (
      payload: { conversationId: string; type: "AUDIO" | "VIDEO" },
      ack?: (response: { callId: string; iceServers: unknown } | { error: string }) => void
    ) => {
      try {
        const others = await otherMemberIds(userId, payload.conversationId);
        if (others.length === 0) {
          ack?.({ error: "Conversation unavailable" });
          return;
        }

        const call = await prisma.callSession.create({
          data: {
            conversationId: payload.conversationId,
            callerId: userId,
            type: payload.type === "VIDEO" ? CallType.VIDEO : CallType.AUDIO,
            status: CallStatus.RINGING,
            participants: {
              create: [
                { userId, joinedAt: new Date() },
                ...others.map((id) => ({ userId: id }))
              ]
            }
          }
        });

        const incoming = {
          id: call.id,
          conversationId: call.conversationId,
          type: call.type,
          caller: publicUser(caller)
        };
        for (const id of others) io.to(userRoom(id)).emit("call:incoming", incoming);
        ack?.({ callId: call.id, iceServers: iceServers() });

        // Auto-miss if nobody answers in time.
        ringTimers.set(
          call.id,
          setTimeout(() => {
            void expireCall(io, call.id);
          }, RING_TIMEOUT_MS)
        );
      } catch (error) {
        console.error("call:invite", error);
        ack?.({ error: "Unable to start call" });
      }
    }
  );

  socket.on("call:accept", async (payload: { callId: string }, ack?: (response: { iceServers: unknown } | { error: string }) => void) => {
    const call = await prisma.callSession.findUnique({ where: { id: payload.callId } });
    if (!call || call.status !== CallStatus.RINGING) {
      ack?.({ error: "Call no longer available" });
      return;
    }
    clearRing(call.id);
    await prisma.callSession.update({
      where: { id: call.id },
      data: { status: CallStatus.ONGOING, answeredAt: new Date() }
    });
    await prisma.callParticipant.updateMany({
      where: { callId: call.id, userId },
      data: { joinedAt: new Date() }
    });
    io.to(userRoom(call.callerId)).emit("call:accepted", { callId: call.id, userId });
    ack?.({ iceServers: iceServers() });
  });

  socket.on("call:reject", async (payload: { callId: string }) => {
    const call = await prisma.callSession.findUnique({ where: { id: payload.callId } });
    if (!call || call.status !== CallStatus.RINGING) return;
    clearRing(call.id);
    await prisma.callSession.update({
      where: { id: call.id },
      data: { status: CallStatus.DECLINED, endedAt: new Date(), endedReason: "declined" }
    });
    io.to(userRoom(call.callerId)).emit("call:rejected", { callId: call.id, userId });
  });

  socket.on("call:cancel", async (payload: { callId: string }) => {
    const call = await prisma.callSession.findUnique({ where: { id: payload.callId } });
    if (!call || call.status !== CallStatus.RINGING) return;
    clearRing(call.id);
    await prisma.callSession.update({
      where: { id: call.id },
      data: { status: CallStatus.MISSED, endedAt: new Date(), endedReason: "canceled" }
    });
    const others = await otherMemberIds(call.callerId, call.conversationId);
    for (const id of others) io.to(userRoom(id)).emit("call:canceled", { callId: call.id });
  });

  socket.on("call:end", async (payload: { callId: string }) => {
    await endCall(io, payload.callId, userId);
  });

  // Relay SDP offers/answers and ICE candidates to a specific peer.
  socket.on("call:signal", (payload: { callId: string; to: string; data: unknown }) => {
    if (!payload?.to) return;
    io.to(userRoom(payload.to)).emit("call:signal", { callId: payload.callId, from: userId, data: payload.data });
  });
}

async function endCall(io: Server, callId: string, byUserId: string) {
  const call = await prisma.callSession.findUnique({ where: { id: callId } });
  if (!call || call.status === CallStatus.ENDED || call.status === CallStatus.MISSED || call.status === CallStatus.DECLINED) return;
  clearRing(call.id);

  const now = new Date();
  const durationSec = call.answeredAt ? Math.max(0, Math.round((now.getTime() - call.answeredAt.getTime()) / 1000)) : 0;
  await prisma.callSession.update({
    where: { id: call.id },
    data: {
      status: call.answeredAt ? CallStatus.ENDED : CallStatus.MISSED,
      endedAt: now,
      durationSec,
      endedReason: "hangup"
    }
  });
  await prisma.callParticipant.updateMany({ where: { callId: call.id, leftAt: null }, data: { leftAt: now } });

  const members = await allMemberIds(call.conversationId);
  for (const id of members) io.to(userRoom(id)).emit("call:ended", { callId: call.id, byUserId, durationSec });
}

async function expireCall(io: Server, callId: string) {
  const call = await prisma.callSession.findUnique({ where: { id: callId } });
  if (!call || call.status !== CallStatus.RINGING) return;
  clearRing(call.id);
  await prisma.callSession.update({
    where: { id: call.id },
    data: { status: CallStatus.MISSED, endedAt: new Date(), endedReason: "timeout" }
  });
  const members = await allMemberIds(call.conversationId);
  for (const id of members) io.to(userRoom(id)).emit("call:canceled", { callId: call.id });
}

function clearRing(callId: string) {
  const timer = ringTimers.get(callId);
  if (timer) {
    clearTimeout(timer);
    ringTimers.delete(callId);
  }
}

async function otherMemberIds(userId: string, conversationId: string) {
  const member = await prisma.conversationMember.findUnique({
    where: { userId_conversationId: { userId, conversationId } }
  });
  if (!member) return [];
  const members = await prisma.conversationMember.findMany({
    where: { conversationId, userId: { not: userId } },
    select: { userId: true }
  });
  return members.map((m) => m.userId);
}

async function allMemberIds(conversationId: string) {
  const members = await prisma.conversationMember.findMany({
    where: { conversationId },
    select: { userId: true }
  });
  return members.map((m) => m.userId);
}

async function markAllDelivered(io: Server, userId: string) {
  const now = new Date();
  const memberships = await prisma.conversationMember.findMany({
    where: { userId, OR: [{ lastDeliveredAt: null }, { lastDeliveredAt: { lt: now } }] },
    select: { conversationId: true }
  });
  if (memberships.length === 0) return;
  await prisma.conversationMember.updateMany({
    where: { userId, conversationId: { in: memberships.map((m) => m.conversationId) } },
    data: { lastDeliveredAt: now }
  });
  for (const { conversationId } of memberships) {
    io.to(conversationId).emit("receipt:update", {
      conversationId,
      userId,
      lastDeliveredAt: now.toISOString()
    });
  }
}
