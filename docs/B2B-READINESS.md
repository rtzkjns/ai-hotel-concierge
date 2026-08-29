# B2B Readiness — honest status

**Verdict (multi-agent adversarial audit, 2026-08-30): NO-GO for a paying second hotel.**
The bot is production-grade for **Kazzhol** (one hotel chain). It is **not yet** ready to onboard a
paying second tenant as a B2B product. This file tracks the gap honestly — do not claim "B2B-ready"
until the blockers below are closed.

## Closed (this hardening pass — each verified, Kazzhol byte-identical, tests green)

- **Security — Telegram staff binding (was a live hole, affected Kazzhol today).** `?start=staff-<hotel>`
  enrolled anyone into a hotel's guest-handoff notifications (PII) with no auth. Now gated on the
  owner bind code (`authorizeStaffDeepLink`, 7 regression tests). The channel had **zero** test
  coverage before — that is why it survived.
- **Guest-facing brand leak.** Confirmation page, `/privacy` + `/terms`, and a booking tool string
  hardcoded `kazzhol.com` / KAZZHOL → now from `activeTenant.brand`.
- **Privacy policy disclosure.** Now discloses cross-border AI processing (Anthropic, US) — was hidden.
- **Per-tenant DB file.** `DB_PATH` defaults to `./<tenant>.db` so a second tenant can't silently
  share Kazzhol's DB. Enforces the one-DB-per-tenant posture.
- **Fail-fast tenant validation.** A malformed/mismatched currency `scrubPattern` now crashes at boot
  instead of silently disabling the price guard or bricking the bot.
- **CI defined** (`deploy/ci.yml`) — typecheck + tests on push/PR.

## Remaining — Category A: needs a FOUNDER decision (not code)

- **KZ personal-data law.** Guest PII goes to Anthropic (US) and the DB sits on a VPS in DE/FI, never
  in Kazakhstan. To sell legally in KZ you must decide: host in KZ (ps.kz / RK cloud) + sign a DPA +
  a real consent flow — or sell outside the regulated perimeter for now. **This is the top commercial
  blocker.** Code can be made residency-configurable, but the hosting/legal commitment is yours.
- **Load / scale spend.** Single-file SQLite + one process per tenant is fine to ~a handful of hotels;
  a growing fleet needs Postgres + horizontal ops. That's an infra investment decision.
- **CI activation.** Move `deploy/ci.yml` → `.github/workflows/` (needs `gh auth refresh -s workflow`
  or the GitHub web UI once).

## Remaining — Category B: code-fixable (in progress, autonomous)

- **Invented-price guard is weak** — matches by value, not context; a plausible round price present
  anywhere in the KB passes even when quoted for a room. Wrong price = most expensive defect.
- **Message durability** — inbound is 200-ack-then-async in memory; a deploy/crash loses in-flight
  guest messages. Needs a durable queue (SQLite) + idempotent replay.
- **Region pack still baked in** — Kazakh суржик / CIS-doc rules apply to every tenant; a non-CIS
  hotel needs them behind a tenant `regionPack`.
- **Config-driven onboarding** — a new tenant is still registered in TypeScript (`src/tenant/tenants`).
  v1 goal: load tenants from config files, no code edit.
- **Eval battery runs on stub only** — never exercises real bookings, real prices, or a second tenant.
- **Full tenant isolation** (tenant_id-scoped queries) — deferred until tenants are pooled into one DB;
  the one-DB-per-tenant posture avoids it for now.

## The rule
Onboarding a second hotel today = TenantConfig + its Property[] roster + env creds + a separate
instance/DB. It is **not** yet a self-serve config operation. Keep closing Category B; Category A
gates the legal sale.
