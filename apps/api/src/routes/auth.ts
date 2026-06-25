import { Router } from "express";
import crypto from "node:crypto";
import { prisma } from "../db.js";
import { hashPassword, requireAuth, signToken, verifyPassword } from "../auth.js";
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resendCodeSchema,
  resetPasswordSchema,
  verifyRegistrationSchema
} from "../validators.js";
import { handleError, publicUser } from "../utils.js";
import { sendPasswordResetEmail, sendVerificationEmail } from "../mail.js";

export const authRouter = Router();

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function generateCode() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function hashCode(code: string) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

// Step 1: validate the details, stash them, and email a verification code.
authRouter.post("/register", async (req, res) => {
  try {
    const input = registerSchema.parse(req.body);
    const email = input.email.toLowerCase();
    const username = input.username.toLowerCase();

    const existing = await prisma.user.findFirst({ where: { OR: [{ email }, { username }] } });
    if (existing) {
      res.status(409).json({ message: "Email or username already exists" });
      return;
    }

    // A different pending signup may already own this username.
    const usernameTaken = await prisma.pendingRegistration.findFirst({ where: { username, email: { not: email } } });
    if (usernameTaken) {
      res.status(409).json({ message: "Username is being registered by someone else" });
      return;
    }

    const code = generateCode();
    const data = {
      email,
      username,
      displayName: input.displayName,
      passwordHash: await hashPassword(input.password),
      codeHash: hashCode(code),
      attempts: 0,
      expiresAt: new Date(Date.now() + CODE_TTL_MS)
    };

    await prisma.pendingRegistration.upsert({ where: { email }, create: data, update: data });
    await sendVerificationEmail(email, code);

    res.status(202).json({ verificationRequired: true, email });
  } catch (error) {
    handleError(res, error);
  }
});

// Step 2: confirm the code and create the real account.
authRouter.post("/verify", async (req, res) => {
  try {
    const input = verifyRegistrationSchema.parse(req.body);
    const email = input.email.toLowerCase();
    const pending = await prisma.pendingRegistration.findUnique({ where: { email } });

    if (!pending || pending.expiresAt < new Date()) {
      res.status(400).json({ message: "Verification code expired. Please register again." });
      return;
    }
    if (pending.attempts >= MAX_ATTEMPTS) {
      await prisma.pendingRegistration.delete({ where: { email } }).catch(() => {});
      res.status(429).json({ message: "Too many attempts. Please register again." });
      return;
    }
    if (pending.codeHash !== hashCode(input.code)) {
      await prisma.pendingRegistration.update({ where: { email }, data: { attempts: { increment: 1 } } });
      res.status(400).json({ message: "Incorrect code" });
      return;
    }

    // Re-check uniqueness in case someone registered in the meantime.
    const existing = await prisma.user.findFirst({
      where: { OR: [{ email }, { username: pending.username }] }
    });
    if (existing) {
      await prisma.pendingRegistration.delete({ where: { email } }).catch(() => {});
      res.status(409).json({ message: "Email or username already exists" });
      return;
    }

    const user = await prisma.user.create({
      data: {
        email: pending.email,
        username: pending.username,
        displayName: pending.displayName,
        passwordHash: pending.passwordHash
      }
    });
    await prisma.pendingRegistration.delete({ where: { email } }).catch(() => {});

    res.status(201).json({ token: signToken(user.id), user: publicUser(user) });
  } catch (error) {
    handleError(res, error);
  }
});

authRouter.post("/resend", async (req, res) => {
  try {
    const input = resendCodeSchema.parse(req.body);
    const email = input.email.toLowerCase();
    const pending = await prisma.pendingRegistration.findUnique({ where: { email } });
    if (!pending) {
      res.status(404).json({ message: "Nothing to verify for this email" });
      return;
    }

    const code = generateCode();
    await prisma.pendingRegistration.update({
      where: { email },
      data: { codeHash: hashCode(code), attempts: 0, expiresAt: new Date(Date.now() + CODE_TTL_MS) }
    });
    await sendVerificationEmail(email, code);
    res.json({ verificationRequired: true, email });
  } catch (error) {
    handleError(res, error);
  }
});

authRouter.post("/login", async (req, res) => {
  try {
    const input = loginSchema.parse(req.body);
    const identity = input.emailOrUsername.toLowerCase();
    const user = await prisma.user.findFirst({
      where: { OR: [{ email: identity }, { username: identity }] }
    });

    if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    res.json({ token: signToken(user.id), user: publicUser(user) });
  } catch (error) {
    handleError(res, error);
  }
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
  res.json({ user: publicUser(user) });
});

// Change password while logged in. Because the E2EE private key is wrapped with
// the password, the client re-wraps it under the new password and sends the new
// envelope as `keyBackup`; we update both atomically so messages stay readable.
authRouter.post("/change-password", requireAuth, async (req, res) => {
  try {
    const input = changePasswordSchema.parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
      res.status(400).json({ message: "Current password is incorrect" });
      return;
    }
    // If an E2EE identity exists, the caller MUST supply a re-wrapped key — else
    // the stored wrapped key would no longer match the new password and future
    // devices could never restore it. Force unlocking encryption on this device.
    if (user.publicKey && !input.keyBackup) {
      res.status(409).json({ message: "Unlock encryption on this device before changing your password" });
      return;
    }
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(input.newPassword),
        ...(input.keyBackup
          ? {
              encryptedPrivateKey: input.keyBackup.encryptedPrivateKey,
              keySalt: input.keyBackup.keySalt,
              keyIv: input.keyBackup.keyIv
            }
          : {})
      }
    });
    // Issue a fresh token so the change feels like a clean re-auth.
    res.json({ token: signToken(user.id) });
  } catch (error) {
    handleError(res, error);
  }
});

// Step 1 of reset: email a code. Always responds 200 with the same shape so the
// endpoint can't be used to enumerate which emails have accounts.
authRouter.post("/forgot-password", async (req, res) => {
  try {
    const input = forgotPasswordSchema.parse(req.body);
    const email = input.email.toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      const code = generateCode();
      await prisma.passwordReset.deleteMany({ where: { userId: user.id } });
      await prisma.passwordReset.create({
        data: { userId: user.id, codeHash: hashCode(code), expiresAt: new Date(Date.now() + CODE_TTL_MS) }
      });
      await sendPasswordResetEmail(email, code);
    }
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error);
  }
});

// Step 2 of reset: verify the code and set a new password. The E2EE identity is
// cleared because the old private key can no longer be unwrapped (the password
// that wrapped it is gone); a fresh identity is generated on next login.
authRouter.post("/reset-password", async (req, res) => {
  try {
    const input = resetPasswordSchema.parse(req.body);
    const email = input.email.toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });
    const reset = user ? await prisma.passwordReset.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "desc" } }) : null;

    if (!user || !reset || reset.expiresAt < new Date()) {
      res.status(400).json({ message: "Reset code expired. Please request a new one." });
      return;
    }
    if (reset.attempts >= MAX_ATTEMPTS) {
      await prisma.passwordReset.deleteMany({ where: { userId: user.id } });
      res.status(429).json({ message: "Too many attempts. Please request a new code." });
      return;
    }
    if (reset.codeHash !== hashCode(input.code)) {
      await prisma.passwordReset.update({ where: { id: reset.id }, data: { attempts: { increment: 1 } } });
      res.status(400).json({ message: "Incorrect code" });
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(input.newPassword),
        publicKey: null,
        encryptedPrivateKey: null,
        keySalt: null,
        keyIv: null
      }
    });
    await prisma.passwordReset.deleteMany({ where: { userId: user.id } });
    res.json({ token: signToken(user.id), user: publicUser(user) });
  } catch (error) {
    handleError(res, error);
  }
});
