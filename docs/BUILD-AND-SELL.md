# How We Build & How We Sell — Kazzhol AI Program

**Date:** 2026-06-28
**Companion to:** `PRD.md` (what we build) and `OWNER-REQUIREMENTS.md` (what we need)
**This doc:** the execution approach for each product + the commercial model.

---

## Part 1 — Commercial Strategy (the form we sell in)

### 1.1 Core positioning
A **custom AI system built for Kazzhol**, that Kazzhol uses exclusively — **we keep ownership of the code/IP**. Sold as a **project + ongoing service**, per product. Pricing model: **setup fee + monthly retainer**.

### 1.2 The ownership decision (settled)
- **Kazzhol gets exclusive use.** They do not get the source code or the right to resell it.
- **We retain the IP**, so the same system can be offered to other hotels later.
- **Single-tenant, config-driven build now** — not a multi-tenant SaaS yet. Everything hotel-specific (knowledge, prices, brand voice, accounts, languages) lives in **config/database, never hardcoded**. This is ~10% extra discipline that buys ~80% of future resellability. True multi-tenant SaaS is deferred until a **second paying hotel** exists.

### 1.3 Pricing structure (per product)
Each of the 3 products is sold as its own line item:

| | One-time **Setup fee** | **Monthly retainer** | Pass-through costs |
|---|---|---|---|
| **P1 — DM Automation** | Build, integrate (Exely + Meta), KB load, launch | Hosting, monitoring, KB updates, support, model improvements | WhatsApp per-conversation + LLM usage (billed on top or bundled with a cap) |
| **P2 — Groups Portal** | Build portal, cabinets, RFP flow, deploy on their site | Hosting, support, changes | minimal |
| **P3 — Social Posting** | Build, train on brand, connect accounts | Hosting, support, model tuning | LLM usage |

**Why setup + monthly:** the setup fee covers the real build cost so you're not financing their project; the monthly retainer turns one client into **recurring revenue** and pays for the things that genuinely keep costing money (hosting, the WhatsApp/LLM bills, support, and ongoing improvements). It also keeps you in the relationship to upsell P2 and P3 after P1 lands.

**Pass-through rule:** WhatsApp and LLM usage are real variable costs. Either bill them at cost on top of the retainer, or bundle a usage cap into the retainer and charge overage. Never absorb them silently — at scale they bite.

### 1.4 Sales sequence (how the deal unfolds)
1. **Land P1** — it's the owner's core pain and the fastest to show working. This is the trust-builder.
2. **Prove it live**, then use that credibility to sell **P3** (cheap to add, reuses P1's Meta setup) and **P2** (standalone, higher value).
3. Each product = its own setup fee + adds to the monthly retainer. The retainer **grows** as products stack.

### 1.5 What protects you commercially
- **Phased payment:** deposit before build, balance at launch, then monthly. Don't build P1 fully before any money moves.
- **Owner-side dependencies are theirs:** Exely keys, Meta rebuild, account access (see `OWNER-REQUIREMENTS.md`). Make clear in writing that timelines depend on them delivering these.
- **You keep the IP**, so the months you invest become a reusable asset, not a throwaway.

---

## Part 2 — How We Build Each Product

### Shared platform spine (built once, with P1; reused by P3 and P2's AI parts)
- **Backend:** TypeScript/Node services + **Postgres (Supabase)**.
- **AI:** **Claude** with RAG over the per-property knowledge base for static facts, plus **live-pull tools** for dynamic facts (availability/prices).
- **Integrations layer:** a module wrapping **Exely** (OAuth2.0, 15-min token cache, rate-limit-aware) — `check_availability()`, `create_booking()`. Reused by P1 (read) and P2 (group rates, if/when live).
- **Config-driven per-property:** each hotel is a config + knowledge set, not code. This is what makes it resellable later.

---

### P1 — DM Automation (build first)

**What we actually build, in order:**
1. **Knowledge base** — structure the per-property facts (RU/KK/EN) the owner provides into the KB; set up RAG.
2. **AI orchestrator** — system prompt (brand voice + property context), RAG, and tools: `kb_search`, `check_availability`, `create_booking`, `escalate`. Strict grounding: never invent, escalate when unsure.
3. **Exely integration** — live availability/quote + assisted booking. (Can stub with a lead-capture fallback until keys arrive, so the rest ships.)
4. **Conversation engine** — threading by guest+channel+property, language auto-detect, state, handoff pause.
5. **WhatsApp adapter first** (via Meta/BSP) — webhook in, normalize, reply out. Then **Instagram**, then **Messenger** adapters (same interface).
6. **Human handoff dashboard** — web: live queue, take-over, AI on/off per thread, history, basic metrics.
7. **Launch on WhatsApp** for one property → expand to all 3 → add IG + Messenger.

**Build order rationale:** the brain + KB + Exely work regardless of channel; channels are thin adapters bolted on after. WhatsApp first = highest value in KZ.

**Gated on (owner):** Meta Business rebuild, WhatsApp number/templates, Exely keys, KB content in 3 languages.

---

### P3 — AI Social Posting (build second)

**What we actually build, in order:**
1. **Brand-grounding store** — ingest the hotel's past best posts + style guide so the AI writes like Kazzhol.
2. **Photo batch upload + grouping** — manager uploads ~50 photos; AI clusters them into post-sets and infers context per set.
3. **Caption generation** — on-brand captions in RU/KK/EN, editable drafts.
4. **Approval queue** — manager reviews/edits/approves before anything publishes.
5. **Scheduling + publishing** — to connected accounts via official publishing APIs (**reuses P1's Meta setup** — the main reason it's built second).
6. **Autonomy ramp** — start approval-first; graduate trusted accounts/post-types to auto-publish.

**Gated on (owner):** brand training material, SMM manager list, the same Meta/account access from P1.

---

### P2 — Groups Portal (build third)

**What we actually build, in order:**
1. **Company auth + registration** — a company signs up, gets a **personal cabinet**.
2. **RFP submission** — group request form (dates, rooms, pax, property, needs).
3. **Staff quote builder** — sales receives the RFP, builds and sends a custom offer in the cabinet.
4. **Accept/decline + status tracking** — submitted → quoted → accepted/declined; request history per company.
5. **Deploy on the main site** — subdomain/section of kazzhol's site.
6. **(v2, later)** online payment, live Exely group rates, post-booking management (rooming lists, names, invoices).

**Build order rationale:** standalone web app sharing little infra with P1/P3 — most net-new work, lowest reuse, so it goes last. RFP/quote model keeps v1 small (no live booking engine).

**Gated on (owner):** group-sales staff, RFP fields, pricing source (manual vs Exely), site/domain access.

---

## Part 3 — One-line summary

> Build a **single, config-driven custom system for Kazzhol** that **we own the IP to**, ship **P1 (DM automation) first** to earn trust, then stack **P3 (posting)** and **P2 (groups portal)** on top — each sold as a **setup fee + monthly retainer**, with WhatsApp/LLM usage passed through. Resellability to other hotels comes for nearly free later because everything hotel-specific is config, not code.
