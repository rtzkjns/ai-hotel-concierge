# B2B Readiness — honest status

**Verdict (multi-agent adversarial audit, 2026-08-30): NO-GO for a paying second hotel.**
The bot is production-grade for **Kazzhol** (one hotel chain). It is **not yet** ready to onboard a
paying second tenant as a B2B product. This file tracks the gap honestly — do not claim "B2B-ready"
until the blockers below are closed.

## Closed (each verified + ADVERSARIALLY RE-VERIFIED, Kazzhol byte-identical, tests green)

- **Security — Telegram staff binding (was a live hole, affected Kazzhol today).** `?start=staff-<hotel>`
  enrolled anyone into a hotel's guest-handoff notifications (PII) with no auth. Now gated on the
  owner bind code (`authorizeStaffDeepLink`, 7 regression tests). Re-verify: FIXED (every codeless
  probe rejected). The channel had **zero** test coverage before — that is why it survived.
- **Config-driven onboarding.** A tenant loads from `tenants/<id>.json` at boot (sync, JSON = inert
  data). Registering tenant #2 is now data, not a code edit. Kazzhol un-overridable (collision guard).
  Re-verify: FIXED (proved end-to-end: JSON file → selectable tenant, zero code change).
- **Invented-price guard hardened.** Room prices held to a strict per-tenant bar at the SENTENCE
  level (empty for Kazzhol → any offline room price dropped). Re-verify caught a window-too-narrow
  bypass; fixed to sentence-level + English `accommodation`. Legit non-room KB prices survive.
- **Guest-facing brand leak.** Confirmation page, `/privacy` + `/terms`, a booking tool string, AND
  the Exely post-payment RETURN_URL (guest redirect) → now from `activeTenant.brand`. Re-verify found
  the RETURN_URL still hardcoded; fixed. (Exely integration KEY per-cabinet is not guest-visible.)
- **Privacy policy disclosure.** Now discloses cross-border AI processing (Anthropic, US) — was hidden.
- **Per-tenant DB file** + **fail-fast tenant validation** (+ ReDoS length cap on scrubPattern).
  Re-verify: FIXED (kazzhol→./kazzhol.db unchanged, demo→./demo.db; invalid/mismatched regex crashes).
- **CI defined** (`deploy/ci.yml`) — typecheck + tests on push/PR.
- **Durable inbound intake** — guest webhook messages are journalled (SQLite `inbound_queue`) BEFORE
  the slow work and replayed on boot, so a deploy/crash no longer loses them. Idempotent (native
  message id) + at-most-once reply gate (`markReplying`) → no double-reply on replay. Affected
  Kazzhol prod too. 5 store tests.

## Remaining — Category A: needs a FOUNDER decision (not code)

- **KZ personal-data law.** Guest PII goes to Anthropic (US) and the DB sits on a VPS in DE/FI, never
  in Kazakhstan. To sell legally in KZ you must decide: host in KZ (ps.kz / RK cloud) + sign a DPA +
  a real consent flow — or sell outside the regulated perimeter for now. **This is the top commercial
  blocker.** Code can be made residency-configurable, but the hosting/legal commitment is yours.
- **Load / scale spend.** Single-file SQLite + one process per tenant is fine to ~a handful of hotels;
  a growing fleet needs Postgres + horizontal ops. That's an infra investment decision.
- **CI activation.** Move `deploy/ci.yml` → `.github/workflows/` (needs `gh auth refresh -s workflow`
  or the GitHub web UI once).

## Remaining — Category B: one designed code item + two deferred

- **Region pack** (SOLE remaining designed code change) — Kazakh суржик / CIS-doc rules apply to every
  tenant; a non-CIS hotel needs them behind a tenant `regionPack`. Design ready: cut 4 verbatim spans
  from `systemPrompt.ts` into a `kzCis` pack; Kazzhol stays byte-identical (golden snapshots are the
  gate). Deliberately deferred: **lowest near-term value** (CIS beachhead first — a non-CIS tenant is
  far off) at the **highest byte-identity risk** (4 surgical newline/comma seams). The golden gate
  makes it safe to do in a focused pass; it is the one place where care beats haste.
- **Eval battery runs on stub only** — never exercises real bookings, real prices, or a second tenant.
- **Full tenant isolation** (tenant_id-scoped queries) — deferred until tenants are pooled into one DB;
  the one-DB-per-tenant posture (per-tenant DB file) avoids it for now.

## The rule
Onboarding a second hotel today = TenantConfig + its Property[] roster + env creds + a separate
instance/DB. It is **not** yet a self-serve config operation. Keep closing Category B; Category A
gates the legal sale.
