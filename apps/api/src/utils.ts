import type { Response } from "express";
import { ZodError } from "zod";

export function handleError(res: Response, error: unknown) {
  if (error instanceof ZodError) {
    res.status(400).json({ message: "Validation failed", issues: error.flatten() });
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
