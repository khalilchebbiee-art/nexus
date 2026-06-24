# Hosting Nexus securely

This guide takes you from local-only to a hardened, HTTPS-encrypted deployment
that strangers cannot eavesdrop on.

## Security model (read this first)

- **HTTPS/TLS** encrypts everything between your users and the server, so no one
  on the network (ISP, public Wi-Fi, etc.) can read messages or media in transit.
- The database is **not** end-to-end encrypted. The server operator (you) can
  read message contents in Postgres. That is normal for self-hosting. If you need
  "even the admin can't read it," that requires client-side E2EE, which is a
  separate, larger feature.
- HTTPS is also **required** for voice/video calls — browsers block camera and
  microphone access on insecure (non-localhost) origins.

## What you need

1. A small Linux VPS (1–2 vCPU, 2 GB RAM is plenty to start). Hetzner, DigitalOcean,
   Vultr, Linode all work.
2. A domain name. Create two DNS **A records** pointing at the server's IP:
   - `app.example.com`  → frontend
   - `api.example.com`  → backend / calls / media
3. Docker + Docker Compose installed on the server.

## Step 1 — Point the config at your domains

Edit `Caddyfile` and replace `app.example.com` / `api.example.com` with your real
domains (keep the two-site structure).

## Step 2 — Create the production .env

```bash
cp .env.production.example .env
# generate real secrets
openssl rand -base64 48   # paste into JWT_SECRET
openssl rand -base64 24   # paste into POSTGRES_PASSWORD (and into DATABASE_URL)
```

Fill in `CLIENT_ORIGIN`, `VITE_API_URL`, `VITE_SOCKET_URL` with your domains.
Keep `.env` out of git (it already is via `.gitignore`).

## Step 3 — Lock down the server firewall

Only the proxy ports should be open to the world.

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

The production compose does **not** publish Postgres (5432) or the API (4000),
so they are only reachable inside Docker — never from the internet.

## Step 4 — Launch

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Caddy automatically requests Let's Encrypt certificates for both domains and
renews them forever. The API container runs `prisma migrate deploy` on startup,
so the schema is created/updated automatically.

Visit `https://app.example.com` — you should have a green padlock.

## Step 5 — Verify it's secure

- The site loads over `https://` with a valid certificate.
- `https://api.example.com/health` returns `{"status":"ok"}`.
- `http://your.server.ip:5432` and `:4000` are **unreachable** from outside.
- Messaging, media, and (with HTTPS) voice/video calls work.

## Ongoing hardening checklist

- **Strong, unique secrets** for `JWT_SECRET` and `POSTGRES_PASSWORD`. Rotating
  `JWT_SECRET` logs everyone out (sessions become invalid) — that's expected.
- **Backups**: snapshot the `postgres-data` and `media-uploads` volumes
  regularly. Store backups encrypted.
- **Disk encryption**: enable full-disk encryption on the VPS if your provider
  supports it, so a stolen disk image doesn't leak the database.
- **Keep images patched**: periodically `docker compose -f docker-compose.prod.yml
  pull && ... up -d --build` and run OS updates.
- **SSH**: disable password login, use keys only, consider changing the port.
- **Limit who can register**: this build allows open registration. If it's just
  for you and friends, consider adding an invite/allowlist before going public.
- **TURN over TLS**: if you run a TURN server, prefer `turns:` (TLS) on 5349.

## Alternative: managed platforms

If you'd rather not run a VPS, you can deploy the same containers on Render,
Railway, or Fly.io: the database as a managed Postgres add-on, the API and web as
services, with the platform providing HTTPS. Set the same environment variables.
The Docker images here work unchanged; you only drop the Caddy service because the
platform terminates TLS for you.
