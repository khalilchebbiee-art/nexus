import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../auth.js";

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

notificationsRouter.get("/", async (req, res) => {
  const notifications = await prisma.notification.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
    take: 50
  });
  const unread = await prisma.notification.count({ where: { userId: req.user!.id, readAt: null } });
  res.json({ notifications, unread });
});

notificationsRouter.post("/read", async (req, res) => {
  await prisma.notification.updateMany({
    where: { userId: req.user!.id, readAt: null },
    data: { readAt: new Date() }
  });
  res.status(204).end();
});
