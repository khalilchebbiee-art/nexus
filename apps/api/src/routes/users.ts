import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { FriendshipStatus } from "@prisma/client";
import { prisma } from "../db.js";
import { requireAuth } from "../auth.js";
import { deleteAccountSchema, keyBackupSchema, profileSchema } from "../validators.js";
import { verifyPassword } from "../auth.js";
import { AppError, handleError, publicUser } from "../utils.js";
import { extensionForMime } from "../media.js";
import { persistUpload } from "../storage.js";
import { onlineUsers } from "../io.js";

export const usersRouter = Router();

const avatarRoot = path.resolve("uploads", "avatars");
fs.mkdirSync(avatarRoot, { recursive: true });

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, avatarRoot),
    filename: (_req, file, callback) => callback(null, `${Date.now()}-${crypto.randomUUID()}${extensionForMime(file.mimetype)}`)
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => callback(null, file.mimetype.startsWith("image/"))
});

usersRouter.use(requireAuth);

// The set of user ids who are accepted friends of `userId`.
async function friendIdSet(userId: string): Promise<Set<string>> {
  const rows = await prisma.friendship.findMany({
    where: { status: FriendshipStatus.ACCEPTED, OR: [{ requesterId: userId }, { receiverId: userId }] },
    select: { requesterId: true, receiverId: true }
  });
  return new Set(rows.map((row) => (row.requesterId === userId ? row.receiverId : row.requesterId)));
}

// Returns the caller's own E2EE key material (public key + the password-wrapped
// private key) so a new device can restore it after the user enters their
// password locally. The server never sees the unwrapped key.
usersRouter.get("/keys", async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: req.user!.id },
    select: { publicKey: true, encryptedPrivateKey: true, keySalt: true, keyIv: true }
  });
  res.json({ keys: user.publicKey ? user : null });
});

usersRouter.put("/keys", async (req, res) => {
  try {
    const input = keyBackupSchema.parse(req.body);
    // Identity keys are write-once: never overwrite an existing key, or old
    // messages would become unreadable.
    const current = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { publicKey: true } });
    if (current.publicKey) {
      res.status(409).json({ message: "Encryption keys already exist for this account" });
      return;
    }
    await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        publicKey: input.publicKey,
        encryptedPrivateKey: input.encryptedPrivateKey,
        keySalt: input.keySalt,
        keyIv: input.keyIv
      }
    });
    res.status(201).json({ ok: true });
  } catch (error) {
    handleError(res, error);
  }
});

usersRouter.get("/search", async (req, res) => {
  const query = String(req.query.q ?? "").trim().toLowerCase();
  if (query.length < 2) {
    res.json({ users: [] });
    return;
  }

  const users = await prisma.user.findMany({
    where: {
      id: { not: req.user!.id },
      OR: [
        { username: { contains: query, mode: "insensitive" } },
        { displayName: { contains: query, mode: "insensitive" } }
      ]
    },
    select: { id: true, username: true, displayName: true, bio: true, avatarUrl: true },
    take: 12
  });
  if (users.length === 0) {
    res.json({ users: [] });
    return;
  }

  const relationships = await prisma.friendship.findMany({
    where: {
      OR: users.flatMap((user) => [
        { requesterId: req.user!.id, receiverId: user.id },
        { requesterId: user.id, receiverId: req.user!.id }
      ])
    }
  });

  res.json({
    users: users
      .map((user) => {
        const relationship = relationships.find(
          (item) =>
            (item.requesterId === req.user!.id && item.receiverId === user.id) ||
            (item.requesterId === user.id && item.receiverId === req.user!.id)
        );
        return {
          user,
          relationship,
          result: {
            ...publicUser(user),
            friendshipStatus: relationship?.status ?? null,
            // So the client can render "Cancel request" vs "Accept" correctly.
            outgoing: relationship?.requesterId === req.user!.id
          }
        };
      })
      // Hide anyone in a block relationship (either direction) from discovery.
      .filter((entry) => entry.relationship?.status !== FriendshipStatus.BLOCKED)
      .map((entry) => entry.result)
  });
});

usersRouter.patch("/me", async (req, res) => {
  try {
    const input = profileSchema.parse(req.body);

    // Username is unique and case-folded like at registration.
    let username: string | undefined;
    if (input.username !== undefined) {
      username = input.username.toLowerCase();
      const taken = await prisma.user.findFirst({ where: { username, id: { not: req.user!.id } }, select: { id: true } });
      if (taken) {
        res.status(409).json({ message: "Username is already taken" });
        return;
      }
    }

    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        displayName: input.displayName,
        bio: input.bio,
        username,
        // Allow clearing the avatar with an explicit empty string.
        avatarUrl: input.avatarUrl === undefined ? undefined : input.avatarUrl || null
      }
    });
    res.json({ user: publicUser(user) });
  } catch (error) {
    handleError(res, error);
  }
});

// Permanently delete the caller's account (password-confirmed). Cascades remove
// memberships, friendships, sent messages, notifications, calls, and keys.
usersRouter.delete("/me", async (req, res) => {
  try {
    const input = deleteAccountSchema.parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { passwordHash: true } });
    if (!(await verifyPassword(input.password, user.passwordHash))) {
      res.status(400).json({ message: "Password is incorrect" });
      return;
    }
    await prisma.user.delete({ where: { id: req.user!.id } });
    res.status(204).end();
  } catch (error) {
    handleError(res, error);
  }
});

// Upload a profile picture; returns the updated user with the new avatarUrl.
usersRouter.post("/me/avatar", avatarUpload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ message: "Image file required" });
      return;
    }
    const avatarUrl = await persistUpload(req.file, "avatars");
    const user = await prisma.user.update({ where: { id: req.user!.id }, data: { avatarUrl } });
    res.json({ user: publicUser(user) });
  } catch (error) {
    handleError(res, error);
  }
});

// View another user's public profile, including the relationship to the caller
// and the number of friends they have in common. Must stay below the dynamic
// `/:userId` matcher only — but is defined here so static routes win first.
usersRouter.get("/:userId", async (req, res) => {
  try {
    const userId = String(req.params.userId);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, displayName: true, bio: true, avatarUrl: true, lastSeenAt: true, publicKey: true }
    });
    if (!user) throw new AppError(404, "User not found");

    const relationship =
      userId === req.user!.id
        ? null
        : await prisma.friendship.findFirst({
            where: {
              OR: [
                { requesterId: req.user!.id, receiverId: userId },
                { requesterId: userId, receiverId: req.user!.id }
              ]
            }
          });

    let mutualFriends = 0;
    if (userId !== req.user!.id) {
      const [mine, theirs] = await Promise.all([friendIdSet(req.user!.id), friendIdSet(userId)]);
      for (const id of theirs) if (mine.has(id)) mutualFriends += 1;
    }

    res.json({
      user: {
        ...publicUser(user),
        online: onlineUsers.has(user.id),
        lastSeenAt: user.lastSeenAt ?? null,
        friendshipStatus: relationship?.status ?? null,
        // Whether the relationship was initiated by the caller (cancel vs. accept).
        outgoing: relationship?.requesterId === req.user!.id,
        mutualFriends
      }
    });
  } catch (error) {
    handleError(res, error);
  }
});
