# Kazzhol Social AI Concierge — Project Rules & Vision

The single source of truth for *how we work on this project* and *what it is*. Read this first every session.

## What this is
A **custom-built** AI system for the **Kazzhol hotel chain** (Kazakhstan: Astana, Almaty, Park Almaty) that:
- Answers guest messages across every channel the hotel uses — WhatsApp, Instagram DMs (3 accounts), Telegram, Facebook Messenger.
- Works in **Russian, Kazakh, and English** (auto-detect, reply in same language).
- Does FAQs → availability/quotes → assisted bookings → smart human handoff.
- Also helps create + schedule outbound social content (later phase).

Full spec: `docs/PRD.md`.

## Core rules (do not violate)
1. **Build custom, not SaaS.** The owner's existing tools (Simplified, SocialRails, ManyChat) are generic "AI slop" with poor RU/KK quality and no hotel context. Our value is doing RU/KK DM handling + real hotel knowledge well. Don't propose just reselling an off-the-shelf tool.
2. **MVP first, ask for access later.** We do NOT yet have the PMS or a working Meta account. Build a **pitchable demo that depends on neither**, show the owner, win buy-in, *then* request PMS access + Meta setup. Never block the MVP on something we have to ask the owner for.
3. **Never invent hotel facts, prices, or availability.** Ground every answer in the knowledge base / PMS source of truth. If unknown → say a human will confirm + hand off. No hallucinated bookings.
4. **Human-in-the-loop for money.** No booking is finalized / no payment taken by AI alone in early versions. AI assists; a human confirms.
5. **Official APIs only.** No scraping/unofficial automation that risks account bans (esp. Instagram). Telegram Bot API, WhatsApp Business Platform, Meta Graph/Messaging APIs.
6. **One AI brain, per-property knowledge.** Not three separate bots — one system that routes by which account/property the message came to.
7. **Validate Kazakh quality early.** Kazakh LLM output is the biggest quality risk; test it in week 1, add templates/human review if weak.

## Current status (update as it changes)
- Phase: **Phase 0 — building the MVP / owner-pitch demo.**
- MVP = Telegram bot, FAQ in RU/KK/EN, booking lead-capture fallback, human handoff, one property (Astana first). No PMS, no Meta.
- Locked MVP decisions: channel=Telegram bot · voice=warm & friendly · handoff=private Telegram staff group · first property=Astana. (Chain has no unified guest inbox today — that gap is part of the value pitch.)
- Blocked/pending owner: PMS identity + API access; Meta Business Manager (must rebuild from scratch — prior attempt failed).

## Tech direction (recommended, not yet locked)
- Backend: TypeScript/Node. Storage: Postgres (Supabase — owner's familiar stack).
- LLM: Claude (Anthropic) + RAG over per-property knowledge base.
- Architecture: channel adapters → conversation engine → AI orchestrator (tools) → integration adapters → human dashboard.

## Open questions (see docs/PRD.md §10)
PMS system & API • handoff destination/agents • brand voice • Meta control • hosting/data-residency • budget.
