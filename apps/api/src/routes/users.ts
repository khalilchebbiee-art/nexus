import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../auth.js";
import { keyBackupSchema, profileSchema } from "../validators.js";
import { handleError, publicUser } from "../utils.js";

export const usersRouter = Router();

usersRouter.use(requireAuth);

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
    users: users.map((user) => {
      const relationship = relationships.find(
        (item) =>
          (item.requesterId === req.user!.id && item.receiverId === user.id) ||
          (item.requesterId === user.id && item.receiverId === req.user!.id)
      );
      return {
        ...publicUser(user),
        friendshipStatus: relationship?.status ?? null
      };
    })
  });
});

usersRouter.patch("/me", async (req, res) => {
  try {
    const input = profileSchema.parse(req.body);
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        displayName: input.displayName,
        bio: input.bio,
        avatarUrl: input.avatarUrl || undefined
      }
    });
    res.json({ user: publicUser(user) });
  } catch (error) {
    handleError(res, error);
  }
});
