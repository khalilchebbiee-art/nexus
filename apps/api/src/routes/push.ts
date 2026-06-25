import { Router } from "express";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { requireAuth } from "../auth.js";
import { handleError } from "../utils.js";
import { pushSubscribeSchema, pushUnsubscribeSchema } from "../validators.js";

export const pushRouter = Router();

// Public: the client needs the VAPID public key to create a subscription.
// Returns null when push isn't configured, so the client simply skips it.
pushRouter.get("/public-key", (_req, res) => {
  res.json({ key: env.VAPID_PUBLIC_KEY ?? null });
});

pushRouter.use(requireAuth);

pushRouter.post("/subscribe", async (req, res) => {
  try {
    const input = pushSubscribeSchema.parse(req.body);
    // Endpoint is unique; re-subscribing (or a device changing owner) just
    // re-points it at the current user.
    await prisma.pushSubscription.upsert({
      where: { endpoint: input.endpoint },
      create: { userId: req.user!.id, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth },
      update: { userId: req.user!.id, p256dh: input.keys.p256dh, auth: input.keys.auth }
    });
    res.status(201).json({ ok: true });
  } catch (error) {
    handleError(res, error);
  }
});

pushRouter.post("/unsubscribe", async (req, res) => {
  try {
    const input = pushUnsubscribeSchema.parse(req.body);
    await prisma.pushSubscription.deleteMany({ where: { endpoint: input.endpoint, userId: req.user!.id } });
    res.status(204).end();
  } catch (error) {
    handleError(res, error);
  }
});
