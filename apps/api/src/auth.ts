import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { env } from "./env.js";
import { prisma } from "./db.js";

export type AuthUser = {
  id: string;
  email: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function signToken(userId: string) {
  return jwt.sign({ sub: userId }, env.JWT_SECRET, { expiresIn: "7d" });
}

export async function getUserFromToken(token: string): Promise<AuthUser | null> {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET);
    if (typeof payload !== "object" || typeof payload.sub !== "string") return null;
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, username: true, displayName: true, avatarUrl: true }
    });
    return user;
  } catch {
    return null;
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ message: "Authentication required" });
    return;
  }

  const user = await getUserFromToken(token);
  if (!user) {
    res.status(401).json({ message: "Invalid or expired session" });
    return;
  }

  req.user = user;
  next();
}
