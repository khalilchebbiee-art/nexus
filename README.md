# Nexus

Nexus is a production-shaped realtime messaging app. Phase 1 delivered the secure private messaging foundation; Phase 2 adds collaboration spaces, richer message controls, notifications, search, and media workflows.

## Stack

- Web: React 19, Vite, TypeScript, Socket.IO client, lucide-react.
- API: Express, Socket.IO, Prisma, PostgreSQL, JWT auth, bcrypt password hashing, Helmet, rate limiting, Zod validation.
- Media: Local persistent upload volume with cloud-ready public media URL support.
- Deployment: Docker Compose with `web`, `api`, and `db` services.

## Local Development

1. Copy `.env.example` to `.env` and set a long `JWT_SECRET`.
2. Install dependencies with `pnpm install`.
3. Start Postgres with `docker compose up db`.
4. Run `pnpm db:migrate`.
5. Run `pnpm dev`.
6. Open `http://localhost:5173`.

## Docker Deployment

1. Copy `.env.example` to `.env`.
2. Replace `JWT_SECRET` and database credentials.
3. Run `docker compose up --build`.
4. Open `http://localhost:5173`.

## Phase 1 Scope

- Registration and login.
- JWT-backed authenticated API.
- Editable user profile.
- Username and display-name search.
- Friend request send, accept, and decline.
- One-to-one private conversations.
- Realtime Socket.IO message delivery.
- Text, image, video, and voice-note uploads.
- Responsive desktop/mobile app shell.
- Dark and light themes.
- PostgreSQL data model and Prisma migrations.
- Dockerized web, API, and database services.

## Phase 2 Scope

- Groups and broadcast-style channels.
- Message reactions.
- Message editing and soft deletion.
- Scheduled text and media messages with a delivery worker.
- Notification inbox with unread tracking.
- Cloud-ready media URL configuration.
- Original-quality media links in the gallery.
- Global message, file, and conversation search.
- Relationship-aware user search.
- Smart media gallery with image, video, and voice filters.

## Expansion Notes

The data model separates users, friendships, conversations, members, messages, reactions, and notifications so future phases can add calls, AI, workspace features, and deeper moderation without replacing the foundation.
