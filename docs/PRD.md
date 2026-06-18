# PRD — Kazzhol Social AI Concierge

**Status:** Draft v0.1 (for review)
**Date:** 2026-06-18
**Owner (project):** kza200710@gmail.com
**Client:** Kazzhol Hotel Chain (Kazakhstan) — properties: Kazzhol Almaty, Kazzhol Park Almaty, Kazzhol Astana
**Working name:** "Kazzhol Concierge" (placeholder)

---

## 1. Problem & Goal

The Kazzhol hotel chain runs guest communication and marketing across several social/messaging channels manually, with a separate presence per property (e.g. 3 distinct Instagram accounts). Staff answer the same questions repeatedly, miss messages outside working hours, and respond slowly — costing direct bookings.

Off-the-shelf tools (Simplified, SocialRails, ManyChat) are either pure schedulers with no real DM intelligence, or generic chatbots with weak Russian/Kazakh quality and no hotel context. **Decision: build a custom system the hotel owns.**

**Goal:** An AI system that (a) answers guest messages across every channel Kazzhol uses, in Russian/Kazakh/English, with real hotel knowledge and the ability to quote availability and assist bookings, escalating to humans when needed; and (b) helps create and schedule outbound social content across the same accounts.

**Primary success metric:** % of inbound guest messages fully resolved by AI without a human (target to be set with owner, suggested ≥60% in 3 months), and median first-response time (target < 1 min, 24/7).

---

## 2. Users

- **Guests / prospects** — message the hotel on WhatsApp, Instagram, Telegram, etc. Want fast answers, prices, availability, to book.
- **Hotel front-desk / reservations staff** — receive AI-escalated conversations, take over when needed, review AI activity.
- **Marketing/SMM staff** — use the outbound side to draft, schedule, and publish posts per property.
- **Owner / management** — wants oversight: volume, resolution rate, missed-message rate, conversions.

---

## 3. Scope

### In scope (v1)
**Inbound (the core ask):**
- Channels: **WhatsApp**, **Instagram DMs** (3 accounts), **Telegram**, **Facebook Messenger**. (Instagram/Facebook **comment** auto-reply: stretch, see §9.)
- Languages: **Russian, Kazakh, English** with auto-detect and reply-in-same-language.
- Capabilities:
  1. **Answer FAQs** from a per-property knowledge base (prices list, room types, amenities, check-in/out, location, parking, breakfast, policies).
  2. **Check availability & quote** for given dates/room type (requires PMS/booking-engine integration — see §7 dependency).
  3. **Assist bookings** — collect guest details and either create the reservation via the booking engine or hand off a secure payment/booking link.
  4. **Smart human handoff** — detect complaints, edge cases, or explicit "talk to a human", and route to staff with full conversation context; AI pauses on that thread until released.
- **Per-property routing:** a message to the Astana account is answered with Astana's knowledge, prices, and availability.

**Outbound:**
- AI-assisted content drafting (captions in 3 languages, on-brand) and **multi-account scheduling/publishing** to the connected social accounts.

### Out of scope (v1)
- Voice calls / IVR.
- Paid-ads management.
- Full PMS replacement.
- Public review-site management (2GIS, Google, Booking.com reviews) — candidate for v2.
- Sentiment analytics dashboards beyond basic operational metrics.

---

## 4. Key Product Decisions (recommended approach)

| Area | Recommendation | Why |
|---|---|---|
| Architecture | Channel adapters → unified message bus → AI orchestrator → tool/integration layer → storage; web dashboard for humans | Keeps each channel isolated; one AI brain serves all channels; new channels = new adapter only |
| AI model | Claude (Anthropic) as primary LLM, with RAG over a per-property knowledge base | Strong multilingual Russian/English; **Kazakh quality must be validated early** (§8 risk) |
| Conversation control | AI answers autonomously for FAQ/availability; **human-in-the-loop required** before any booking is finalized or payment taken in v1 | De-risks money/legal mistakes while AI proves itself |
| Storage / backend | Postgres (Supabase) + a backend service in TypeScript/Node | Matches owner's existing stack familiarity; fast to build |
| Outbound publishing | Use official platform publishing APIs where available; manual-assist fallback where not (e.g. Instagram personal limitations) | Avoid fragile gray-area automation that risks account bans |

---

## 5. High-Level Architecture

```
   WhatsApp   Instagram   Telegram   Messenger
       │          │           │          │
       ▼          ▼           ▼          ▼
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
   │          AI Orchestrator (LLM)           │  (system prompt + RAG + tools)
   │   tools: KB search, check_availability,  │
   │          create_booking, escalate        │
   └─────────────────────────────────────────┘
        │              │              │
        ▼              ▼              ▼
   Knowledge Base   Booking/PMS   Human Handoff
   (per property)   integration   Dashboard (web)

   Outbound: Content Composer ──► Scheduler ──► Publishing APIs (per account)
   Shared store: Postgres (conversations, guests, KB, schedule, metrics)
```

**Components (each independently buildable/testable):**
1. **Channel adapters** — one per platform; receive webhooks, normalize to a common message schema, send replies. Stateless.
2. **Conversation engine** — threads messages by guest+channel+property, detects language, holds conversation state, enforces handoff pause.
3. **AI orchestrator** — builds the prompt (brand voice + property context), runs RAG over the KB, exposes tools, returns a reply or a tool call.
4. **Knowledge base** — structured per-property facts + documents; updatable by staff without code.
5. **Booking integration adapter** — wraps the hotel's PMS/booking engine: `check_availability(dates, property, room_type)`, `create_booking(...)`. (Blocked on §7.)
6. **Human handoff dashboard** — web app: live queue, take-over, AI on/off per thread, conversation history, basic metrics.
7. **Outbound composer + scheduler** — draft captions, attach media, schedule, publish per account; calendar view.

---

## 6. Channel Notes & Requirements

| Channel | API path | Notes / prerequisites |
|---|---|---|
| **WhatsApp** | WhatsApp Business Platform (Cloud API) via Meta or a BSP (360dialog/Twilio) | Highest-value channel in KZ. Needs Meta Business verification, a verified phone number per property (or one shared), template approval for proactive messages. Per-conversation pricing applies. |
| **Instagram DMs** | Instagram Messaging API (Meta) | Each account must be a **Professional** account linked to a **Facebook Page**; requires a Meta app with `instagram_manage_messages` + App Review. 3 accounts to connect. |
| **Telegram** | Telegram Bot API | Cheapest/easiest; free. One bot, or one per property. Great channel to launch first as a pilot. |
| **Facebook Messenger** | Messenger Platform API | Per-Page; same Meta app/review as Instagram. |
| **Instagram/FB comments** (stretch) | Graph API webhooks | Auto-reply to public comments; higher spam/abuse risk, gate behind moderation. |

**Recommended build order:** Telegram pilot → WhatsApp → Instagram DMs → Messenger.

---

## 7. Critical External Dependency — Booking System

The "check availability / quote / book" features **cannot be built without knowing and getting API access to Kazzhol's PMS / booking engine / channel manager.** Public data shows they sell on Booking.com + website + Guest Reservations, but the backend system is unknown (in CIS commonly **TravelLine** or **Bnovo**).

**Action required from owner before §3 booking features start:**
- Which PMS / booking engine / channel manager do the hotels use?
- Is API access available, and read-only vs read-write?
- If no API: fallback v1 = AI collects the request and hands a structured booking lead to staff (no live availability).

Until this is answered, availability/booking is **specced but not started**; FAQ + handoff + outbound proceed independently.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| **Kazakh LLM quality** weaker than Russian | Validate with a Kazakh test set in week 1; consider curated Kazakh answer templates / human review for Kazakh threads if quality is low |
| **Platform ToS / account bans** (esp. Instagram automation) | Use only official APIs; no unofficial scraping/automation; rate-limit; human-approval for outbound where APIs are restricted |
| **AI gives wrong price / overbooks** | Human-in-the-loop before any booking is finalized in v1; availability comes from PMS source of truth, never invented |
| **WhatsApp per-message cost** at scale | Monitor cost per conversation; AI keeps threads efficient; budget alerts |
| **PMS has no API** | Lead-handoff fallback (§7) so the rest of the product still ships |
| **Hallucinated hotel facts** | Strict RAG grounding; "I'll check with the team" + handoff when KB lacks the answer, never guess |

---

## 8a. MVP for Owner Pitch (build FIRST, no PMS needed)

**Strategy:** We do NOT have the PMS yet and won't ask the owner for it until we've shown something working. So the first build is a **pitchable demo MVP** that depends on zero hotel backend systems. We show it, win buy-in, *then* request PMS access + Meta setup.

**MVP = a working AI concierge the owner can message live, that:**
1. Runs on **Telegram** (free API, no Meta dependency, instant to demo).
2. Answers **FAQs in RU / KK / EN** with auto-detect, grounded in real Kazzhol facts (scraped from their site/booking pages + a small editable knowledge base).
3. Handles **booking requests via the lead-capture fallback** — collects dates, guests, room preference, contact, and says "our team will confirm availability." This demos the *entire* booking conversation **without a PMS**; when the PMS arrives later it slots in behind the same flow.
4. Demonstrates **human handoff** — on a complaint / "talk to a human" / unanswerable question, it pauses on that thread and posts the conversation + a "needs a human" alert into a **private Telegram staff group**; a manager replies there.
5. Covers **one property first — Astana** (largest following, ~18K), then clone the KB for the others.

**Locked MVP decisions:** channel = **Telegram bot** (closest analog to the real WhatsApp/IG DM product, Meta-free) · voice = **warm & friendly** · handoff = **private Telegram staff group** (chain has no unified inbox today — that's part of the value we sell) · first property = **Astana**.

**Explicitly NOT in the MVP:** real-time availability/pricing (needs PMS), WhatsApp/Instagram (need Meta), outbound posting. These come after the pitch lands.

---

## 9. Phasing

- **Phase 0 — MVP / Owner Pitch (see §8a):** Telegram bot, FAQ in RU/KK/EN, booking lead-capture fallback, handoff notification, one property. No PMS, no Meta. **This is what we build now.**
- **Phase 1 — WhatsApp + scale FAQ:** WhatsApp adapter, all 3 properties' KBs, full handoff workflow, metrics.
- **Phase 2 — Booking intelligence:** PMS integration → availability/quote → assisted booking (human-confirmed). *(Gated on §7.)*
- **Phase 3 — Instagram & Messenger DMs:** connect 3 IG accounts + FB Pages, App Review.
- **Phase 4 — Outbound:** content composer + multi-account scheduler/publisher.
- **Stretch:** comment auto-reply, review-site management, deeper analytics.

---

## 10. Open Questions (need owner/you to answer)

1. **PMS/booking engine** — which system, and is there API access? (Blocks Phase 2.) — *§7*
2. **WhatsApp numbers** — one shared business number or one per property? Existing WhatsApp Business presence already?
3. **Human handoff** — who are the agents, and do they want a new web dashboard, or should escalations land in a tool they already use (e.g. Telegram group, existing CRM/helpdesk)?
4. **Brand voice** — formal or warm/casual? Default language if none detected? Any existing tone/style guide or banned phrases?
5. **Outbound governance** — must a human approve every AI-drafted post before it publishes, or can some auto-publish?
6. **Existing accounts/credentials** — Meta Business Manager must be **rebuilt from scratch** (a prior attempt failed). Needed for WhatsApp + Instagram + Messenger. Not required for the MVP (Telegram). Treat as a setup task scheduled after the owner pitch.
7. **Hosting/data residency** — any requirement to host in Kazakhstan / data-localization constraints for guest PII?
8. **Budget envelope** — to choose WhatsApp BSP, LLM usage tier, and hosting.

---

## 11. Out-of-the-box assumptions (correct me if wrong)
- Owner controls all social accounts and can grant API access.
- v1 prioritizes **inbound DM handling**; outbound is later (Phase 4) despite both being "in scope," because inbound is the owner's core pain.
- One unified AI brain + per-property knowledge, not three separate bots.
- Cloud-hosted, not on-prem.
