import webpush from "web-push";
import { prisma } from "./db.js";
import { env } from "./env.js";

/**
 * Web Push delivery. Enabled only when a VAPID key pair is configured; otherwise
 * every call is a no-op, so the app runs fine without push set up.
 */
export const pushEnabled = Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

if (pushEnabled) {
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);
}

export type PushPayload = {
  title: string;
  body: string;
  conversationId?: string;
  icon?: string | null;
};

export async function sendPushToUser(userId: string, payload: PushPayload) {
  if (!pushEnabled) return;
  const subscriptions = await prisma.pushSubscription.findMany({ where: { userId } });
  if (subscriptions.length === 0) return;

  const message = JSON.stringify(payload);
  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          message
        );
      } catch (error) {
        // 404/410 mean the subscription is dead — prune it so we stop trying.
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await prisma.pushSubscription.delete({ where: { endpoint: sub.endpoint } }).catch(() => {});
        }
      }
    })
  );
}
