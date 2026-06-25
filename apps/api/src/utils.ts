import type { Response } from "express";
import { ZodError } from "zod";

// A domain/authorization error that carries an explicit HTTP status, so route
// handlers can `throw new AppError(403, "...")` and have it surface correctly
// instead of being flattened into a generic 500.
export class AppError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AppError";
    this.status = status;
  }
}

export function handleError(res: Response, error: unknown) {
  if (error instanceof ZodError) {
    res.status(400).json({ message: "Validation failed", issues: error.flatten() });
    return;
  }

  if (error instanceof AppError) {
    res.status(error.status).json({ message: error.message });
    return;
  }

  console.error(error);
  res.status(500).json({ message: "Something went wrong" });
}

export function publicUser(user: {
  id: string;
  username: string;
  displayName: string;
  bio?: string;
  avatarUrl: string | null;
  publicKey?: string | null;
}) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio ?? "",
    avatarUrl: user.avatarUrl,
    publicKey: user.publicKey ?? null
  };
}
