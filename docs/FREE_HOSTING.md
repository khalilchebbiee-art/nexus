# Hosting Nexus for free

A 100% free stack that supports everything Nexus needs (persistent WebSockets,
HTTPS for calls, a real Postgres database, and email):

| Piece | Free service | Why |
|-------|--------------|-----|
| Database | **Neon** (neon.tech) | Free Postgres that doesn't expire, no credit card |
| Backend API | **Render** web service (Docker) | Free, supports Socket.IO WebSockets, no card |
| Frontend | **Render** static site | Free global CDN + automatic HTTPS |
| Email | **Gmail SMTP** | Free verification emails (see below) |

Everything gets HTTPS automatically, which is required for voice/video calls and
for security.

---

## Step 0 — Put the code on GitHub

Render deploys from a Git repo. If you haven't already:

```bash
git add .
git commit -m "Prepare for deployment"
# create an empty repo on github.com first, then:
git remote add origin https://github.com/<you>/nexus.git
git push -u origin main
```

## Step 1 — Create the free database (Neon)

1. Sign up at https://neon.tech (free, no card).
2. Create a project → it gives you a **connection string** like
   `postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require`.
3. Copy it — you'll paste it as `DATABASE_URL` in Step 2.

## Step 2 — Deploy with the blueprint (Render)

1. Sign up at https://render.com (free, no card) and connect your GitHub.
2. **New → Blueprint** → pick your repo. Render reads `render.yaml` and creates
   `nexus-api` and `nexus-web`.
3. When prompted (or in each service's **Environment** tab) fill in:
   - `nexus-api` → **DATABASE_URL** = your Neon string.
   - (Leave `JWT_SECRET` — Render generates a strong one automatically.)
4. Click **Apply** and let both build. The API runs database migrations
   automatically on first boot.

## Step 3 — Connect the two URLs

After the first deploy each service has a public URL, e.g.
`https://nexus-api.onrender.com` and `https://nexus-web.onrender.com`.

- On **nexus-web** set both:
  - `VITE_API_URL` = `https://nexus-api.onrender.com`
  - `VITE_SOCKET_URL` = `https://nexus-api.onrender.com`
- On **nexus-api** set:
  - `CLIENT_ORIGIN` = `https://nexus-web.onrender.com`

Then **Manual Deploy → Clear build cache & deploy** on both (the frontend bakes
these in at build time, so it must rebuild).

## Step 4 — Turn on real verification emails (optional)

On **nexus-api** add (see the Gmail App Password steps in your `.env` comments):

```
SMTP_HOST = smtp.gmail.com
SMTP_USER = you@gmail.com
SMTP_PASS = your-16-char-app-password
SMTP_FROM = Nexus <you@gmail.com>
```

Without these, signup still works but the code is only printed in the API logs
(Render → nexus-api → **Logs**).

## Done

Open `https://nexus-web.onrender.com`, register, and share the link.

---

## Free-tier gotchas (important)

1. **Cold starts.** Free Render services sleep after ~15 min of no traffic; the
   next visit takes ~30–60s to wake. To keep it awake, create a free monitor at
   https://cron-job.org that GETs `https://nexus-api.onrender.com/health` every
   10 minutes. (One always-on service stays within Render's free 750 hours/mo.)

2. **Uploaded media is temporary.** Free hosts have an ephemeral disk, so images,
   videos, and voice notes are **lost when the service restarts or redeploys**.
   Text messages and calls are unaffected (they're in Postgres / peer-to-peer).
   To make media permanent, plug in free object storage later (Supabase Storage,
   Cloudflare R2, or Backblaze B2) and set `MEDIA_PUBLIC_BASE_URL`.

3. **Database sleeps too.** Neon free pauses after inactivity and wakes on the
   next query (a second or two). That's normal.

4. **Email limits.** Gmail SMTP allows ~500 emails/day — fine for friends. For a
   public launch use a transactional provider (Resend/Brevo/SendGrid) with the
   same `SMTP_*` fields.

When you outgrow free tiers (no cold starts, persistent uploads, custom domain),
the paid VPS path in `docs/HOSTING.md` is the next step.
