import express from "express";
import http from "node:http";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { Server } from "socket.io";
import { env } from "./env.js";
import { authRouter } from "./routes/auth.js";
import { usersRouter } from "./routes/users.js";
import { friendsRouter } from "./routes/friends.js";
import { conversationsRouter, startScheduledMessageWorker } from "./routes/conversations.js";
import { notificationsRouter } from "./routes/notifications.js";
import { callsRouter } from "./routes/calls.js";
import { pushRouter } from "./routes/push.js";
import { configureRealtime } from "./realtime.js";
import { setIo } from "./io.js";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: env.CLIENT_ORIGIN, credentials: true }
});

setIo(io);
configureRealtime(io);
startScheduledMessageWorker(io);

// Behind Render/most PaaS there is exactly one proxy hop. Without this,
// express-rate-limit and req.ip see the proxy IP for every request, making the
// limiter global (an availability risk) and per-attacker throttling impossible.
app.set("trust proxy", 1);

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: env.CLIENT_ORIGIN, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
app.use("/uploads", express.static(path.resolve("uploads")));

// Tighter limiter for credential endpoints to blunt brute-force / enumeration.
const authLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.use("/auth", authLimiter, authRouter);
app.use("/users", usersRouter);
app.use("/friends", friendsRouter);
app.use("/conversations", conversationsRouter(io));
app.use("/notifications", notificationsRouter);
app.use("/calls", callsRouter());
app.use("/push", pushRouter);

// Most hosts (Render, Railway, Fly, Heroku...) inject the port to bind via PORT.
const port = process.env.PORT ? Number(process.env.PORT) : env.API_PORT;
server.listen(port, () => {
  console.log(`Nexus API listening on ${port}`);
});
