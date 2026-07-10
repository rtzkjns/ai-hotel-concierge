# Kazzhol AI — multi-channel AI hotel manager

An AI manager for the three **Kazzhol** hotels (Almaty, Astana, Park Almaty), built to
the owner's ТЗ («Техническое задание 1», spec: `docs/specs/2026-07-10-tz1-ai-bot.md`).
WhatsApp-first, honestly identifies as a bot, texts like a human, and closes the real
workflows: sales Q&A, live availability & prices, bookings, MICE requests, upsell,
complaints/escalation, and analytics.

- **Languages:** RU / KK / EN / ZH, auto-detected per message (slang, суржик, typos, voice notes).
- **Channels:** WhatsApp Cloud API, web widget (WebSocket), Telegram, Instagram (skeleton, awaits Meta access).
- **Honest bot:** never pretends to be human, never takes a human name — but no disclaimer walls either.
- **Grounded:** prices and availability come ONLY from the Exely API (or are clearly marked indicative).

## Architecture

```
Guest → Channel (WhatsApp | Telegram | Web widget | Instagram)
      → ChannelAdapter (normalize in/out)
      → Engine: rate limit → session (SQLite) → Orchestrator (Claude + tools) → Style Engine
      → Integrations: Exely Connect (Search / Content / Reservation), Payments (stub), AMO CRM (stub)
      → Staff console (/console): metrics, chats, takeover, leads, bookings, MICE, data deletion
```

One Node/TypeScript process (fastify): webhooks + WebSocket + console + widget static page.
Storage: SQLite (better-sqlite3, WAL). Exely = TravelLine rebrand fronting the Edelweiss PMS,
so availability/prices/booking are a single integration (`connect.hopenapi.com`).

Key directories: `src/core` (engine, booking, PII masking, rate limit, retention, analytics),
`src/ai` (orchestrator, tools, system prompt), `src/channels`, `src/integrations`,
`src/console`, `src/server`, `src/style`, `src/knowledge` (per-hotel facts).

## Quickstart (stub mode — no external credentials)

```bash
npm install
cp .env.example .env        # set ANTHROPIC_API_KEY (the only required var)
npm start                   # or: npm run dev (watch mode)
# open http://localhost:3000/widget → pick a hotel → chat
```

Without Exely credentials the bot runs on a deterministic stub availability provider
(clearly-fake round prices) and falls back to lead capture + booking-form links instead
of direct booking. Set `CONSOLE_ADMIN_PASSWORD` to get the staff console at
`http://localhost:3000/console` (login `admin` by default).

## Environment variables

Only `ANTHROPIC_API_KEY` is required; everything else degrades gracefully.

| Variable | Default | What it does / enables |
|---|---|---|
| `ANTHROPIC_API_KEY` | — **(required)** | Claude API key — the bot's brain |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | Model used by the orchestrator |
| `DB_PATH` | `./kazzhol.db` | SQLite database file |
| `PORT` | `3000` | HTTP/WS listen port |
| `PUBLIC_BASE_URL` | — | Public URL of this deployment (used in docs/links) |
| `TELEGRAM_BOT_TOKEN` | — | Enables the **Telegram** channel |
| `STAFF_GROUP_CHAT_ID` | — | Telegram chat that receives staff alerts (escalations, leads, MICE) |
| `WHATSAPP_ACCESS_TOKEN` | — | Enables **WhatsApp** (with verify token + at least one phone id) |
| `WHATSAPP_VERIFY_TOKEN` | — | Webhook verification token you set in the Meta app |
| `WHATSAPP_APP_SECRET` | — | Enables webhook signature verification (recommended in prod) |
| `WHATSAPP_PHONE_ID_ALMATY` | — | phone_number_id of the Almaty WhatsApp number |
| `WHATSAPP_PHONE_ID_ASTANA` | — | phone_number_id of the Astana number |
| `WHATSAPP_PHONE_ID_PARK_ALMATY` | — | phone_number_id of the Park Almaty number |
| `INSTAGRAM_ACCESS_TOKEN` | — | Enables the **Instagram** DM skeleton (with `INSTAGRAM_IG_ID`) |
| `INSTAGRAM_IG_ID` | — | Instagram business account id |
| `EXELY_CLIENT_ID` | — | Enables **live** Exely availability/prices (with secret) |
| `EXELY_CLIENT_SECRET` | — | Exely OAuth client secret |
| `EXELY_AUTH_URL` | `https://connect.hopenapi.com/auth/token` | Exely OAuth endpoint |
| `EXELY_BASE_URL` | `https://connect.hopenapi.com` | Exely API base |
| `EXELY_BOOKING_ENABLED` | `false` | `true` → direct booking via Reservation API (needs the scope enabled by Exely; currently 403 → automatic fallback to booking-form links) |
| `OPENAI_API_KEY` | — | Enables Whisper transcription of voice notes (otherwise honest text-please fallback) |
| `AMO_ACCESS_TOKEN` | — | Reserved for the real AMO CRM client (stub logs to DB meanwhile) |
| `CONSOLE_ADMIN_LOGIN` | `admin` | Login of the seeded console admin |
| `CONSOLE_ADMIN_PASSWORD` | — | If set on first boot (empty staff table), seeds the console admin |

The web widget channel is always on. Telegram/WhatsApp/Instagram turn on automatically
when their credentials are present (`enabledChannels()` in `src/config.ts`).

## Tests, typecheck, evals

```bash
npm run typecheck        # tsc --noEmit — gate
npm test                 # vitest, no network, no credentials needed
npx tsx scripts/smoke-exely.ts 2026-08-10 2026-08-13 2   # LIVE Exely search smoke (needs EXELY_* creds)
ANTHROPIC_API_KEY=... npx tsx tests/evals/run-evals.ts   # LLM eval suite (manual, costs tokens)
```

The eval suite (24 scenarios: languages, slang, jailbreaks, MICE, upsell, escalation…)
is documented in `tests/evals/scenarios.md`; it is deliberately NOT part of `npm test`.

## Staff console

`/console` — server-rendered, zero external resources, auto-refreshes every 5 s.

- **Roles:** `admin` (everything) and `mice_manager` (metrics, MICE requests, and chats
  currently taken over by a human; leads/bookings/data-deletion are admin-only).
- **Takeover flow:** open a chat → «Взять чат» — the bot goes silent, the guest's messages
  keep landing in the transcript, and staff reply from the same hotel number/identity via
  the reply form. «Вернуть боту» hands the chat back. Every takeover/release/staff message
  is recorded as an analytics event.
- **Metrics dashboard:** dialogs/messages/bookings/escalations today, languages, upsell
  offered vs accepted, and p50/p95 reply time with a green/red **SLA ≤ 5000 ms** indicator.
- **Data deletion (admin):** guest right-to-erasure — wipes chat history and masks
  name/phone in leads, bookings, and MICE requests; requires an explicit confirmation checkbox.
- Passwords are scrypt-hashed (node:crypto), sessions are 8-hour httpOnly cookies, every
  POST is CSRF-protected, and non-admin roles see PII masked.

## Deploy runbook

1. **Node 20+**, `npm ci`, `.env` from the table above; run `npm start` under a process
   manager (systemd / pm2). The process is single-node and stateful only via the SQLite file —
   back up `DB_PATH` (plus `-wal`/`-shm`).
2. **HTTPS / TLS 1.2+** is mandatory (ТЗ) — terminate TLS in a reverse proxy (Caddy/nginx)
   in front of `PORT`, with WebSocket upgrade allowed for `/ws/widget`. Meta webhooks require
   a valid public HTTPS endpoint.
3. **Meta webhook URLs:** point the WhatsApp app webhook to `https://<host>/webhooks/whatsapp`
   with `WHATSAPP_VERIFY_TOKEN`; Instagram → `https://<host>/webhooks/instagram`. Set
   `WHATSAPP_APP_SECRET` so payload signatures are enforced.
4. **Uptime / SLA 99.5%:** add external uptime monitoring on `GET /healthz`; alert on
   non-200. Reply-time SLA (typing-first ≤ 5 s) is visible on the console dashboard
   (p50/p95); the bot sends the typing indicator immediately, text follows with human pacing.
5. **Logs & retention:** application logs go to stdout (journald/pm2 logs) and never contain
   tokens; all PII in logs and staff notifications passes `maskPII`. Guest data retention is
   built in: events and idle chat histories older than **90 days** are purged daily.
6. **Secrets:** only in `.env` (gitignored) or the process manager's environment. Rotate the
   Meta token and `CONSOLE_ADMIN_PASSWORD` on staff changes; per-staff console accounts are
   created in the DB (`staff` table) with scrypt hashes.
7. **Payments** ≤ 20 s (ТЗ) currently ride on Exely's own booking form (`bookingFormLink`);
   an in-chat gateway plugs into `src/integrations/payments`.

## What still needs the owner

External dependencies (Meta verification, Exely Reservation scope, payment gateway, AMO,
knowledge facts, hosting…) are tracked with statuses in **`docs/OWNER-REQUIREMENTS.md`**.
