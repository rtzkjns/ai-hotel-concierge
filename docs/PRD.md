# PRD — Kazzhol AI Program

**Status:** Draft v1.0 (program-level, supersedes v0.1 concierge PRD)
**Date:** 2026-06-28
**Owner (project):** kza200710@gmail.com
**Client:** Kazzhol Hotel Chain (Kazakhstan) — properties: Kazzhol Almaty, Kazzhol Park Almaty, Kazzhol Astana
**Booking engine:** Exely (Booking Engine + Channel Manager + PMS; has Public API + Exely Connect)

---

## 0. What changed (v0.1 → v1.0)

After meeting the owner, the engagement expanded from a single AI concierge into a **long-term program of three distinct products**. This PRD now covers all three. Two decisions from the meeting reshape the original plan:

- **Telegram is dropped.** No Telegram MVP / pitch bot. P1 launches directly on the real channels (WhatsApp first).
- **Data is pulled live.** The AI does not work off a static cached knowledge dump for facts that change — it **queries live systems on demand** (Exely, PMS, Sheets) and never invents data.

---

## 1. Program Overview

Three products under one shared platform spine (knowledge base + brand voice + per-property data + Claude LLM). Each product is built and shipped on its own spec → plan → build cycle.

| # | Product | Primary users | Core job |
|---|---------|---------------|----------|
| **P1** | **DM Automation** (inbound concierge) | Guests / prospects | AI answers guest DMs across WhatsApp / Instagram / Messenger, in RU/KK/EN, with full hotel knowledge; pulls live data instead of inventing it; quotes availability, assists bookings, hands off to humans. |
| **P2** | **"Kazzhol for Groups" Portal** | Companies / tour operators | B2B portal on the main site; a company registers a group and gets its own cabinet to request quotes and manage the group sale (RFP/quote model). |
| **P3** | **AI Social Posting** (outbound) | Hotel SMM managers | Manager uploads a batch of photos; AI understands context, writes on-brand captions in 3 languages, schedules, and publishes to all hotel social accounts (approval-first, autonomy that grows). |

**Recommended build order: P1 → P3 → P2.**
- **P1 first** — owner's core pain, fastest to value, reuses existing scaffolding in this repo.
- **P3 second** — the outbound half of social; reuses P1's Meta/account setup, so it's a cheap incremental win.
- **P2 last** — a standalone web app (company auth, cabinets, RFP workflow) sharing little infrastructure with P1/P3.

**Shared platform spine (built with P1, reused by P3 and the AI parts of P2):**
- Per-property **knowledge base** (facts + documents) + brand-voice system prompt.
- **Claude** LLM with RAG for static facts + **live-pull tools** for dynamic facts.
- Postgres (Supabase) backend, TypeScript/Node services.
- A small **integrations layer** wrapping Exely / PMS / Sheets that both P1 (read availability) and P2 (group rates) can use.

---

# PROJECT 1 — DM Automation (build now)

## P1.1 Problem & Goal

Kazzhol handles guest messaging manually, per property (e.g. 3 separate Instagram accounts). Staff answer the same questions repeatedly, miss messages after hours, and respond slowly — losing direct bookings. Off-the-shelf tools (Simplified, SocialRails, ManyChat) are generic, weak in Russian/Kazakh, and have no hotel context. **Decision: build a custom system the hotel owns.**

**Goal:** an AI that answers guest messages across every channel Kazzhol uses, in RU/KK/EN, with real hotel knowledge and the ability to quote live availability and assist bookings, escalating to humans when needed.

**Primary success metrics:**
- % of inbound messages fully resolved by AI without a human (target ≥ 60% in 3 months, confirm with owner).
- Median first-response time < 1 min, 24/7.

## P1.2 Scope

**In scope (v1):**
- **Channels:** WhatsApp first → Instagram DMs (3 accounts) → Facebook Messenger. (Comment auto-reply: stretch.)
- **Languages:** Russian, Kazakh, English — auto-detect, reply in the same language. **Every property's knowledge must exist in all three languages.**
- **Capabilities:**
  1. **Answer FAQs** from a per-property knowledge base (room types, amenities, check-in/out, location, parking, breakfast, policies).
  2. **Check live availability & quote** for dates/room type via the Exely API — fetched at ask-time, never cached-as-truth, never invented.
  3. **Assist bookings** — collect guest details and either create the reservation via Exely or hand off a secure booking/payment link. Human-in-the-loop confirms before money is taken in v1.
  4. **Smart human handoff** — detect complaints, edge cases, or "talk to a human"; route to staff with full context; AI pauses on that thread until released.
- **Per-property routing:** a message to the Astana account is answered with Astana's knowledge, prices, and availability.

**Out of scope (v1):** voice/IVR, paid-ads management, full PMS replacement, review-site management, deep sentiment analytics. **Telegram is explicitly not a channel.**

## P1.3 The "live pull" requirement (owner's key ask)

The AI must **"make pull requests for data to the sources we'll be given"** = **live system pull**:
- **Dynamic facts** (availability, current rates, specific-date pricing) are fetched live from the source of truth (**Exely** primarily; PMS/Sheets as applicable) the moment a guest asks. Tokens/results are short-lived; nothing is invented or served stale as if live.
- **Static facts** (amenities, policies, location, room descriptions) live in the per-property knowledge base for RAG.
- **On missing/unknown data:** the AI says "let me check with the team" and **escalates** — it never guesses. Strict RAG grounding; no hallucinated hotel facts.

## P1.4 Architecture

```
   WhatsApp   Instagram   Messenger
       │          │           │
       ▼          ▼           ▼
   ┌─────────────────────────────────────────┐
   │            Channel Adapters              │  (webhooks in / send out, normalize)
   └─────────────────────────────────────────┘
                       │  normalized message
                       ▼
   ┌─────────────────────────────────────────┐
   │           Conversation Engine            │  (threading, per-property routing,
   │                                          │   language detect, state, handoff flag)
   └─────────────────────────────────────────┘
                       │
                       ▼
   ┌─────────────────────────────────────────┐
   │          AI Orchestrator (Claude)        │  (system prompt + RAG + live-pull tools)
   │   tools: kb_search, check_availability,  │
   │          create_booking, escalate        │
   └─────────────────────────────────────────┘
        │              │              │
        ▼              ▼              ▼
   Knowledge Base   Integrations    Human Handoff
   (per property)   (Exely live)    Dashboard (web)
```

**Components (each independently buildable/testable):**
1. **Channel adapters** — one per platform; receive webhooks, normalize to a common schema, send replies. Stateless. WhatsApp first.
2. **Conversation engine** — threads by guest+channel+property, detects language, holds state, enforces handoff pause.
3. **AI orchestrator** — builds the prompt (brand voice + property context), runs RAG over the KB, exposes live-pull tools, returns a reply or tool call.
4. **Knowledge base** — structured per-property facts + documents, in 3 languages; staff-updatable without code.
5. **Integrations layer (Exely)** — `check_availability(dates, property, room_type)`, `create_booking(...)`; OAuth2.0 token cache (15-min TTL) + rate-limit-aware wrapper. **Shared with P2.**
6. **Human handoff dashboard** — web: live queue, take-over, AI on/off per thread, history, basic metrics.

## P1.5 Channel notes

| Channel | API path | Prerequisites |
|---|---|---|
| **WhatsApp** (first) | WhatsApp Business Platform (Cloud API) via Meta or a BSP (360dialog/Twilio) | Meta Business verification, a verified number (per property or shared), template approval for proactive messages, per-conversation pricing. |
| **Instagram DMs** | Instagram Messaging API (Meta) | Each account = Professional + linked FB Page; Meta app with `instagram_manage_messages` + App Review. 3 accounts. |
| **Facebook Messenger** | Messenger Platform API | Per-Page; same Meta app/review as IG. |
| Comments (stretch) | Graph API webhooks | Auto-reply to public comments; gate behind moderation. |

## P1.6 Critical dependencies (P1)

1. **Meta Business Manager** — must be **rebuilt from scratch** (prior attempt failed). Now an **upfront** dependency since Telegram is gone. Required for WhatsApp + IG + Messenger.
2. **Exely API credentials** — `client_id` + `client_secret` generated in the hotel's Exely Extranet (Hotel Settings → API Connections → Create Connection → enable availability + reservations → Save & Open Access). Auth: `POST https://connect.hopenapi.com/auth/token`, `grant_type=client_credentials`, JWT valid 15 min, no refresh; limits 3/sec, 15/min, 300/hr per IP. **Owner must provide these** (or grant Extranet access + the Exely Hotelier 2FA app). Confirm the API section is enabled on the plan; confirm one cabinet for all 3 hotels vs. three separate.
3. **Knowledge content** — per-property facts in RU/KK/EN from owner-provided sources.

---

# PROJECT 2 — "Kazzhol for Groups" Portal

## P2.1 Goal

A B2B portal on the main Kazzhol site for **group sales**. Companies / tour operators that bring groups register, get their own cabinet, and transact group business with the hotels there instead of over scattered calls/emails.

## P2.2 Model — RFP / Quote (confirmed)

- A company **registers** → gets a **personal cabinet**.
- In the cabinet it **submits a group request** (RFP): dates, number of rooms / guests, property, requirements.
- Hotel sales staff **respond with a custom quote/offer** inside the cabinet.
- The company **reviews and accepts**; the deal proceeds.
- **Not** a live self-serve B2B booking engine in v1 — this is negotiation-style group sales, which matches how group business actually works.

## P2.3 Users
- **Group company / tour operator** — registers, submits RFPs, tracks offers, manages accepted groups.
- **Kazzhol group-sales staff** — receive RFPs, build and send quotes, manage the pipeline.
- **Owner / management** — oversight of group pipeline and revenue.

## P2.4 Scope (v1)
- Company **registration + auth + per-company cabinet**.
- **RFP submission** form (dates, rooms/pax, property, needs).
- **Staff quote builder** + send offer; company accept/decline.
- **Status tracking** per request (submitted → quoted → accepted/declined).
- Group/company **profile + history** of past requests.

**Likely v2 (mark as open):** online payment, live group-rate pricing from Exely, post-booking management (rooming lists, guest names, invoices/documents).

## P2.5 Notes
- Standalone web app on the main site; shares the **integrations layer** and brand assets but little else with P1/P3.
- **Open:** where group pricing comes from (manual by sales vs. Exely group rates) — defaults to manual/sales-built quotes in v1.

---

# PROJECT 3 — AI Social Posting (outbound)

## P3.1 Goal

Let an SMM manager hand the AI a batch of photos and get finished, on-brand social posts out the door across all the hotels' accounts — with the AI doing the understanding, writing, and publishing.

## P3.2 Flow
1. Manager **uploads a batch** of photos (e.g. ~50) for a property.
2. AI **understands the context** — groups related photos into post-sets, infers what each set is about (event, room, restaurant, amenity, etc.).
3. AI is **grounded/trained on the hotel's brand + management style** (tone, recurring themes, do/don't), so captions sound like Kazzhol.
4. AI **writes the caption/description** in RU/KK/EN (per account's audience).
5. AI **schedules and publishes** to the relevant social accounts.

## P3.3 Control — approval-first, autonomy that grows (confirmed)
- **v1:** AI drafts caption + photo grouping + schedule; a **manager approves** before anything publishes.
- **Later:** once captions are consistently trusted, graduate specific accounts/post-types to **auto-publish**.
- Rationale: protects the brand and stays within platform automation rules while the model proves itself; still reaches the owner's hands-off end-state.

## P3.4 Scope (v1)
- Photo **batch upload** + AI **grouping into post-sets**.
- AI **caption generation** (3 languages, on-brand) with an editable draft.
- **Approval queue** for managers.
- **Scheduling + publishing** to connected accounts (official publishing APIs; reuses P1's Meta setup).
- **Brand/style grounding** store (examples of past good posts, tone guide, banned phrases).

**Out of scope (v1):** paid promotion, video editing, fully autonomous publishing.

## P3.5 Notes
- Reuses **Meta Business setup + account connections** from P1 (key reason it's built second).
- Publishing limited to what official APIs allow; manual-assist fallback where an API is restricted (avoid ban-risk gray-area automation).

---

## 4. Cross-Program Risks

| Risk | Mitigation |
|---|---|
| **Kazakh LLM quality** weaker than Russian | Validate with a Kazakh test set in week 1; curated KK templates / human review for KK threads if quality is low. |
| **Platform ToS / account bans** (IG/WhatsApp automation, P3 auto-posting) | Official APIs only; no scraping; rate-limit; **approval-first** posting; human approval for restricted outbound. |
| **AI gives wrong price / overbooks** (P1) | Live availability from Exely as source of truth, never invented; human-in-the-loop before bookings finalize in v1. |
| **Meta rebuild delays everything social** | Start the Meta Business Manager rebuild immediately — it gates P1 (WhatsApp/IG) and P3 publishing. |
| **Exely API access not granted** | Owner provides `client_id`/`client_secret` or Extranet access; until then P1 ships FAQ + handoff and a booking lead-capture fallback (no live availability). |
| **WhatsApp per-conversation cost** at scale | Monitor cost/conversation; AI keeps threads efficient; budget alerts. |
| **Hallucinated hotel facts** | Strict RAG grounding + live pull; "I'll check with the team" + handoff when data is missing, never guess. |

## 5. Open Questions (need owner / you)

1. **Exely API** — provide `client_id`/`client_secret` (or Extranet access + 2FA app); is the API section enabled on the plan? **One cabinet for all 3 hotels or three separate?**
2. **Meta** — confirm we rebuild Business Manager from scratch; one shared WhatsApp number or one per property? Existing WhatsApp Business presence?
3. **Knowledge sources** — what live systems / documents feed P1's data (Exely only, or also PMS, Sheets, price lists)? Who keeps them current?
4. **Brand voice** — formal or warm/casual? Default language if none detected? Existing tone/style guide or banned phrases? (Feeds P1 + P3.)
5. **P2 group pricing** — manual quotes by sales (v1 default) or live Exely group rates?
6. **P2 v2 features** — do they want online payment + post-booking management (rooming lists, invoices) eventually?
7. **P3 brand training data** — can they give past best-performing posts + a style guide to ground the model?
8. **Hosting / data residency** — any Kazakhstan data-localization requirement for guest/company PII?
9. **Budget envelope** — to choose WhatsApp BSP, LLM usage tier, hosting, and P2 web stack.
10. **Success metrics & timeline** — confirm targets and the order/dates for P1 → P3 → P2.

## 6. Assumptions (correct me if wrong)
- Owner controls all social accounts and the Exely cabinet and can grant access.
- Build order is **P1 → P3 → P2**.
- One unified AI brain + per-property knowledge, not separate bots.
- Cloud-hosted, not on-prem.
- P1 ships FAQ + handoff first; live availability/booking switches on when Exely credentials arrive.
