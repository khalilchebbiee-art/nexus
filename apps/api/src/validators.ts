import { z } from "zod";

export const registerSchema = z.object({
  email: z.string().email().max(254),
  username: z.string().min(3).max(24).regex(/^[a-zA-Z0-9_]+$/),
  displayName: z.string().min(2).max(60),
  password: z.string().min(10).max(128)
});

export const verifyRegistrationSchema = z.object({
  email: z.string().email().max(254),
  code: z.string().regex(/^\d{6}$/)
});

export const resendCodeSchema = z.object({
  email: z.string().email().max(254)
});

export const loginSchema = z.object({
  emailOrUsername: z.string().min(3).max(254),
  password: z.string().min(1).max(128)
});

export const keyBackupSchema = z.object({
  publicKey: z.string().min(1).max(4000),
  encryptedPrivateKey: z.string().min(1).max(8000),
  keySalt: z.string().min(1).max(512),
  keyIv: z.string().min(1).max(512)
});

export const profileSchema = z.object({
  displayName: z.string().min(2).max(60).optional(),
  bio: z.string().max(180).optional(),
  avatarUrl: z.string().url().max(500).optional().or(z.literal(""))
});

export const textMessageSchema = z.object({
  body: z.string().min(1).max(8000),
  scheduledFor: z.string().datetime().optional(),
  encrypted: z.boolean().optional(),
  replyToId: z.string().min(1).optional()
});

export const conversationSchema = z.object({
  type: z.enum(["GROUP", "CHANNEL"]),
  name: z.string().min(2).max(80),
  description: z.string().max(240).optional(),
  memberIds: z.array(z.string().min(1)).max(50).default([])
});

export const updateConversationSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  description: z.string().max(240).optional(),
  memberIds: z.array(z.string().min(1)).max(50).optional()
});

export const editMessageSchema = z.object({
  body: z.string().min(1).max(8000)
});

export const reactionSchema = z.object({
  emoji: z.string().min(1).max(12)
});

export const mediaCaptionSchema = z.object({
  caption: z.string().max(4000).optional(),
  scheduledFor: z.string().datetime().optional()
});
