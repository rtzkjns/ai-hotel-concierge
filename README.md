# Kazzhol Concierge — MVP

A pitchable **Telegram** bot that acts as a virtual concierge for all three **Kazzhol** hotels — Astana, Almaty, and Park Almaty. The guest picks their hotel first, then the bot uses that property's knowledge. It:

- Answers guest questions in **Russian, Kazakh, and English** (auto-detects and replies in the same language), grounded in a per-property knowledge base.
- Captures **booking requests** (dates, guests, room type, contact) and forwards them to staff — works with **no PMS / booking system** (lead-capture fallback).
- **Hands off to humans**: on complaints, unanswerable questions, or "talk to a person", it pauses and posts the conversation to a private **Telegram staff group**.

This is the **MVP for the owner pitch**. See `docs/PRD.md` for the full product vision and `RULES.md` for project rules.

## Deferred (after the owner is on board)
- **Real-time availability & pricing** — needs the hotel's PMS / booking engine (e.g. TravelLine, Bnovo) + API access.
- **WhatsApp + Instagram + Messenger** — need a (rebuilt) Meta Business account.
- **Outbound** content creation & scheduling.

## Tech stack
Node 20 + TypeScript · Telegraf · @anthropic-ai/sdk (Claude Sonnet 4.6) · better-sqlite3 · Vitest.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Create a private Telegram group, add the bot, and obtain the group's chat id (e.g. temporarily add `@RawDataBot`, or read it from an incoming update — group ids look like `-1001234567890`).
3. Copy env and fill it in:
   ```bash
   cp .env.example .env
   # set TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, STAFF_GROUP_CHAT_ID
   ```

## Run

```bash
npm run dev     # start the bot (watch mode)
npm test        # run the unit test suite
```

## Demo script (what to show the owner)
- Send `/start` → pick a hotel (Astana / Almaty / Park Almaty).
- Ask in Russian: «Где находится отель?» → grounded Russian answer for the chosen hotel.
- Ask the same in Kazakh and English → replies switch language to match.
- «Хочу забронировать номер на 1–3 июля, 2 гостя» → bot collects details, a lead lands in the staff group.
- «Хочу поговорить с человеком» → escalation appears in the staff group; the bot goes quiet on that thread.

## Project layout
```
src/
  config.ts            env + config
  types.ts             shared types
  knowledge/index.ts   all 3 properties' facts (confirm prices with owner before pitch)
  store.ts             SQLite: conversations + booking leads
  ai/systemPrompt.ts   system prompt (voice + KB + language rules)
  ai/tools.ts          Claude tool schemas
  ai/orchestrator.ts   Claude tool-use loop
  telegram/bot.ts      Telegraf wiring + staff-group handoff
  index.ts             entry point
```
