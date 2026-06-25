import { CallStatus, CallType } from "@prisma/client";
import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { prisma } from "../db.js";
import { requireAuth } from "../auth.js";
import { iceServers } from "../ice.js";
import { publicUser } from "../utils.js";
import { extensionForMime } from "../media.js";
import { persistUpload } from "../storage.js";

const recordingRoot = path.resolve("uploads", "recordings");
fs.mkdirSync(recordingRoot, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, recordingRoot),
  filename: (_req, file, callback) => {
    // Server-chosen extension from the mimetype (never the client filename).
    const safeExt = extensionForMime(file.mimetype);
    callback(null, `${Date.now()}-${crypto.randomUUID()}${safeExt}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 512 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => callback(null, file.mimetype.startsWith("audio/") || file.mimetype.startsWith("video/"))
});

export function callsRouter() {
  const router = Router();
  router.use(requireAuth);

  // ICE servers (STUN/TURN) for the client RTCPeerConnection.
  router.get("/ice", (_req, res) => {
    res.json({ iceServers: iceServers() });
  });

  // Call history for the current user across all their conversations.
  router.get("/", async (req, res) => {
    const conversationId = req.query.conversationId ? String(req.query.conversationId) : undefined;
    const memberships = await prisma.conversationMember.findMany({
      where: { userId: req.user!.id },
      select: { conversationId: true }
    });
    const conversationIds = memberships.map((m) => m.conversationId);

    const calls = await prisma.callSession.findMany({
      where: {
        conversationId: conversationId ? conversationId : { in: conversationIds },
        status: { not: CallStatus.RINGING }
      },
      include: { caller: true, participants: { include: { user: true } } },
      orderBy: { startedAt: "desc" },
      take: 50
    });

    res.json({ calls: calls.map(serializeCall) });
  });

  // Aggregate analytics for the current user's calls.
  router.get("/stats", async (req, res) => {
    const memberships = await prisma.conversationMember.findMany({
      where: { userId: req.user!.id },
      select: { conversationId: true }
    });
    const conversationIds = memberships.map((m) => m.conversationId);

    const calls = await prisma.callSession.findMany({
      where: { conversationId: { in: conversationIds } },
      select: { type: true, status: true, durationSec: true }
    });

    const completed = calls.filter((call) => call.status === CallStatus.ENDED);
    const totalDuration = completed.reduce((sum, call) => sum + call.durationSec, 0);

    res.json({
      total: calls.length,
      completed: completed.length,
      missed: calls.filter((call) => call.status === CallStatus.MISSED).length,
      declined: calls.filter((call) => call.status === CallStatus.DECLINED).length,
      video: calls.filter((call) => call.type === CallType.VIDEO).length,
      audio: calls.filter((call) => call.type === CallType.AUDIO).length,
      totalDurationSec: totalDuration,
      avgDurationSec: completed.length ? Math.round(totalDuration / completed.length) : 0
    });
  });

  // Recording upload (call recording architecture). The client records the
  // session locally and uploads the artifact, which is attached to the call.
  router.post("/:callId/recording", upload.single("file"), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ message: "Recording file required" });
      return;
    }

    const call = await prisma.callSession.findUnique({ where: { id: String(req.params.callId) } });
    if (!call) {
      res.status(404).json({ message: "Call not found" });
      return;
    }

    const member = await prisma.conversationMember.findUnique({
      where: { userId_conversationId: { userId: req.user!.id, conversationId: call.conversationId } }
    });
    if (!member) {
      res.status(403).json({ message: "Not a participant" });
      return;
    }

    const recordingUrl = await persistUpload(req.file, "recordings");

    await prisma.callSession.update({ where: { id: call.id }, data: { recordingUrl } });
    res.status(201).json({ recordingUrl });
  });

  return router;
}

function serializeCall(call: {
  id: string;
  conversationId: string;
  callerId: string;
  type: CallType;
  status: CallStatus;
  startedAt: Date;
  answeredAt: Date | null;
  endedAt: Date | null;
  durationSec: number;
  recordingUrl: string | null;
  caller: Parameters<typeof publicUser>[0];
  participants: Array<{ userId: string; joinedAt: Date | null; leftAt: Date | null; user: Parameters<typeof publicUser>[0] }>;
}) {
  return {
    id: call.id,
    conversationId: call.conversationId,
    callerId: call.callerId,
    type: call.type,
    status: call.status,
    startedAt: call.startedAt,
    answeredAt: call.answeredAt,
    endedAt: call.endedAt,
    durationSec: call.durationSec,
    recordingUrl: call.recordingUrl,
    caller: publicUser(call.caller),
    participants: call.participants.map((participant) => ({
      userId: participant.userId,
      joinedAt: participant.joinedAt,
      leftAt: participant.leftAt,
      user: publicUser(participant.user)
    }))
  };
}
