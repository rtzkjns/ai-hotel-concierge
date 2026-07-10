# Kazzhol for Groups — Corporate Booking Portal (P2) — Design Spec

**Status:** Draft v0.1 (for review)
**Date:** 2026-07-01
**Project:** Kazzhol AI Program, Project 2 (see `docs/PRD.md`)
**Supersedes:** the RFP/quote model in `PRD.md` §P2 — that was an earlier, thinner idea. This is the agreed richer model.

---

## 1. Summary & Goal

A **personalized corporate booking portal** for companies/tour operators that book groups at Kazzhol. Each company has its **own contract with its own negotiated rates & conditions**. When a company logs in, it sees the **normal Kazzhol booking experience — but showing *its* rates**, not the public ones. It books at that rate; the booking and payment go through **Exely, exactly like a normal guest**. Hotel staff keep managing everything in **Exely, as they do today** — we build **no new admin tool** for them.

**Goal:** turn scattered phone/email group deals into a self-serve portal where an approved company logs in and books at its contracted rate, with zero new tooling for staff.

---

## 2. Users

- **Company / tour operator** — self-registers, gets approved, logs in, books group rooms at its negotiated rate.
- **Kazzhol staff** — approve company registrations and attach each company's contract/rates. They do **not** get a new bookings dashboard; bookings land in **Exely**, where they already work.
- **Guest (public)** — clicks a "For groups" button on the main site and is redirected to the portal to register/log in.

---

## 3. The Core Flow

1. **Entry:** a "For groups / Corporate" button on the main Kazzhol site → redirects to the portal (e.g. `groups.kazzhol.com`).
2. **Register:** a company signs up on the portal (company details + contact).
3. **Approve:** Kazzhol staff review the registration, approve it, and **attach that company's contract → its negotiated rates/conditions**.
4. **Login:** the approved company logs in and sees the booking experience showing **its** rates and terms.
5. **Book:** the company books at its rate → the reservation + payment go through **Exely** (same mechanism as a normal guest booking).
6. **Manage:** staff see and manage the booking + payment status **in Exely** — no new admin panel.

---

## 4. Scope

### In scope (v1)
- Company **self-registration**.
- Staff **approval** of a company + **attaching its contract/rates** (a minimal staff screen — this is the *only* new staff-facing surface, and it's about onboarding companies, not managing bookings).
- Company **login/auth**.
- **Personalized booking view** — the booking experience showing the logged-in company's negotiated rates/conditions.
- **Booking via Exely** — the actual reservation + payment ride on Exely (reusing the same integration layer built for P1).
- **Entry button** on the main site linking to the portal.

### Out of scope (v1)
- A staff bookings/payments dashboard (they use Exely).
- Custom online payment handling (payment = whatever Exely does for a normal guest).
- Post-booking group management (rooming lists, guest-name collection, invoices) — candidate v2.
- Editing/negotiating the contract itself inside the portal (contracts are agreed offline; staff just attach the resulting rates).

---

## 5. Architecture — Thin Layer over Exely

The portal is a **small separate web app** on a subdomain, styled to look like the Kazzhol site. It owns only the *new* concerns (accounts, approval, rate-personalization, entry) and **hands the heavy lifting (availability, rates, reservations, payment) to Exely** — the same source of truth staff already use.

```
  Main Kazzhol site (existing, on Plesk)
        │  "For groups" button  → redirect
        ▼
  ┌───────────────────────────────────────────┐
  │        Groups Portal (new, subdomain)      │
  │                                            │
  │  Registration → Staff Approval → Login     │
  │  → Company Dashboard (personalized rates)  │
  │  → Booking view                            │
  └───────────────────────────────────────────┘
        │  availability / rates / create booking / payment
        ▼
  ┌───────────────────────────────────────────┐
  │   Exely (Booking Engine + Channel Mgr +    │
  │   PMS) — SOURCE OF TRUTH. Staff manage      │
  │   all bookings & payments here as today.    │
  └───────────────────────────────────────────┘
```

**Why this shape:** least custom code (Exely already does rooms/rates/reservations/payment), matches "payment = same as a normal guest," keeps staff in the tools they know, and touches the fragile existing site only to add one button.

**Feasibility hinge (must verify with Exely creds):** this assumes Exely can express **per-company negotiated rates** via its API — e.g. corporate rate plans, negotiated-rate codes, or promo codes tied to a company. If Exely cannot serve per-company rates through the API/widget, we fall back to a **fuller custom booking view** that fetches availability from Exely and applies the company's stored rate on our side. The architecture below isolates this behind one interface so the fallback is contained.

---

## 6. Components (each isolated & independently testable)

1. **Entry link (main site)** — a "For groups" button added via the CMS that redirects to the portal. Tiny, additive change to the existing site.
2. **Registration** — company sign-up form → creates a `pending` company account.
3. **Staff approval + contract attach** — a minimal authenticated staff screen: list pending companies, approve/reject, and attach the company's rate profile (which rate plan / code / rate set applies to them).
4. **Auth/session** — company login, sessions, password reset. Standard, self-contained.
5. **Rate resolver** — given a logged-in company, returns its negotiated rate context. **This is the swappable interface**: a stub now, an Exely-backed implementation when creds arrive (mirrors P1's `AvailabilityProvider` pattern — likely reuses/extends `src/integrations/exely/`).
6. **Personalized booking view** — the booking UI that shows the company's rates and drives a booking through Exely.
7. **Exely integration (shared)** — reuses the P1 integration layer (`src/integrations/exely/`): availability, and (new) rate resolution + reservation creation. Stubbed until creds land.

---

## 7. Data Model (portal's own DB — the parts Exely doesn't own)

- **Company** — id, name, contact, status (`pending` / `approved` / `rejected`), created_at.
- **CompanyUser** — id, company_id, email, password_hash, role.
- **RateProfile** — id, company_id, and the mapping to the company's Exely rate (e.g. rate-plan id / negotiated code / promo code) + any human-readable notes about conditions. *(Exact fields depend on what Exely exposes — finalized after recon/creds.)*
- **BookingReference** — id, company_id, Exely reservation id, created_at. A thin local pointer; Exely holds the real booking + payment state.

The portal deliberately stores **as little as possible** — companies, logins, and the company→rate mapping. Everything about rooms, availability, prices, reservations, and payments lives in **Exely**.

---

## 8. Stub Strategy — what's buildable NOW (no access needed)

Same proven pattern as P1: build the whole shell against stubbed Exely data.
- Registration, approval, contract-attach, login, sessions — **fully buildable now**, no Exely.
- Rate resolver + booking view — build against a **stub** that returns fake per-company rates and fake availability. When Exely creds arrive, swap the stub for the real implementation behind the same interface.
- Entry button — buildable/previewable; actually placed on the live site during deployment.

This means we can build ~70–80% of P2 before any Exely key or live-site change.

---

## 9. Open Items (resolve via recon + Exely creds)

1. **Exely per-company rates** — does the API/widget support corporate/negotiated rates tied to a company? (Determines Component 5's real implementation; verified the moment creds arrive.)
2. **Site stack & integration** — confirmed via Plesk/CMS recon: what the site runs on, how Exely is embedded today, whether a subdomain is trivial.
3. **RateProfile exact fields** — finalized once we see how Exely represents corporate rates.
4. **Staff auth for the approval screen** — do approving staff log into the portal, or is approval done another way? (Default: a simple portal staff login.)

---

## 10. Security & Ops

- The portal is a **new, isolated app** — it does not run inside the existing site's code, limiting blast radius.
- Live-site changes are **additive & reversible only** (create a subdomain, add one button); never touch/delete existing content.
- The website/hosting credentials shared for this work should be **rotated after** the engagement, and ideally replaced with a **scoped account** for us.
- The portal stores company logins + a rate mapping; passwords hashed; standard web-auth hygiene. No card/payment data stored (Exely handles payment).

---

## 11. Build Order (within P2)
1. Company accounts: registration → approval + contract attach → login (stub rates). *No access needed.*
2. Personalized booking view against stubbed rates/availability. *No access needed.*
3. Wire the real Exely rate resolver + booking (needs creds + confirmed rate mechanism).
4. Deploy to the subdomain + add the entry button on the main site (needs live-site access — granted).
