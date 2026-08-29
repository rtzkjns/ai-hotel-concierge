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

## Re-audit (2nd pass, after all fixes): 3 dimensions → GAPS, 3 still BLOCKER

Security, Reliability, Scalability moved from blocker/gaps → **GAPS** (SSRF closed, primitives solid).
Then closed the two confirmed ONBOARDING blockers (Exely integration key + RETURN_URL path are now
per-cabinet env config) and the isolation gap (one-DB-per-tenant boot guard) + unbounded-growth
(retention now purges inbound_queue/confirmations). **All code-controllable BLOCKERS are closed.**
The sole remaining confirmed blocker is KZ data residency (below) — infra/legal, not code.

Remaining GAPS (code-fixable, not blockers): webhook fail-closed on misconfig, a staff alert on LLM
outage, read-back verification on the documented Exely path (Kazzhol uses the IBE path which already
has it), CI activation (needs `workflow` scope), offsite backups, and fleet/onboarding tooling.

## KZ data-residency law — what CODE has now done, and the residual (non-code)

The code side is now implemented as far as it can go:
- **Reversible PII pseudonymization** (`src/core/pseudonymize.ts`): for a residency-strict tenant,
  guest phone + email are tokenized before every Anthropic (US) call and restored in tool inputs +
  the reply — raw identifiers no longer cross the border. Gated per tenant (`dataResidency.pseudonymizePII`);
  OFF for Kazzhol → its model path is byte-identical. (v1 = phone/email; names are NLP-hard → v2.)
- **Per-tenant residency policy** (`dataResidency.inCountry`) with a **boot-enforced contract**: such a
  tenant refuses to start unless `DATA_RESIDENCY_CONFIRMED=true`, turning "host in KZ" from a silent
  assumption into a hard startup check. `DB_PATH` already points anywhere (incl. a KZ volume).
- **Cross-border transfer disclosed** in `/privacy`.

**Residual — genuinely NOT code (a deploy + a signature):**
- Physically host the DB/instance in Kazakhstan (set `DB_PATH` → a KZ volume + `DATA_RESIDENCY_CONFIRMED=true`).
- Sign a DPA with Anthropic (a legal contract — cannot be produced in code).
- A formal consent-capture step if counsel requires more than the policy disclosure.

These are a hosting choice + a legal signature. No further code closes them.
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
