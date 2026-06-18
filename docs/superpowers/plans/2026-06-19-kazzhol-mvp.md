# Kazzhol MVP (Telegram Concierge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pitchable Telegram bot that answers Kazzhol Astana guest questions in Russian/Kazakh/English, captures booking leads (no PMS), and escalates to a staff Telegram group.

**Architecture:** Telegram (Telegraf) receives a guest message → conversation store loads history → AI orchestrator builds a system prompt (warm voice + Astana knowledge + language-mirroring rules) and calls Claude with two tools (`capture_booking_lead`, `escalate_to_human`) → tool calls hit the SQLite store / staff-group notifier → final text is sent back to the guest. One AI brain, per-property knowledge injected via the system prompt. No PMS, no Meta.

**Tech Stack:** Node 20 + TypeScript, Telegraf, @anthropic-ai/sdk (Claude Sonnet 4.6), better-sqlite3, Vitest, tsx, dotenv.

---

## File Structure

```
kazzhol-ai/
  package.json
  tsconfig.json
  vitest.config.ts
  .gitignore
  .env.example
  src/
    config.ts              # env loading + typed config
    types.ts               # shared types (ChatMessage, Conversation, BookingLead)
    knowledge/astana.ts    # structured Astana facts (system-prompt text)
    store.ts               # SQLite: conversations + booking leads
    ai/systemPrompt.ts     # builds the system prompt (voice + KB + language rules)
    ai/tools.ts            # Anthropic tool schemas + arg types
    ai/orchestrator.ts     # Claude tool-use loop -> reply or handoff
    telegram/bot.ts        # Telegraf wiring + staff-group notifier
    index.ts               # entry point: start the bot
  tests/
    store.test.ts
    systemPrompt.test.ts
    orchestrator.test.ts
```

Each file has one responsibility. The orchestrator is the only file that knows about Claude; the store is the only file that knows about SQLite; the bot is the only file that knows about Telegram. This keeps every unit independently testable (the orchestrator is tested with a fake Anthropic client; the store with a temp DB).

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`

- [ ] **Step 1: Initialize git + npm**

```bash
cd /Users/abzalm/kazzhol-ai
git init
npm init -y
```

- [ ] **Step 2: Install dependencies**

```bash
npm install telegraf @anthropic-ai/sdk better-sqlite3 dotenv
npm install -D typescript tsx vitest @types/node @types/better-sqlite3
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
```

- [ ] **Step 5: Set `package.json` type + scripts**

Edit `package.json` so it contains (merge with generated fields):

```json
{
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "test": "vitest run"
  }
}
```

- [ ] **Step 6: Write `.gitignore`**

```
node_modules/
dist/
*.db
.env
```

- [ ] **Step 7: Write `.env.example`**

```
TELEGRAM_BOT_TOKEN=
ANTHROPIC_API_KEY=
STAFF_GROUP_CHAT_ID=
ANTHROPIC_MODEL=claude-sonnet-4-6
DB_PATH=./kazzhol.db
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold Kazzhol MVP project"
```

---

### Task 2: Shared types + config

**Files:**
- Create: `src/types.ts`, `src/config.ts`

- [ ] **Step 1: Write `src/types.ts`**

```ts
export type Role = 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string;
}

export type ConversationStatus = 'active' | 'handed_off';

export interface Conversation {
  chatId: number;
  property: string; // e.g. 'astana'
  status: ConversationStatus;
  history: ChatMessage[];
}

export interface BookingLead {
  chatId: number;
  checkIn: string;   // YYYY-MM-DD
  checkOut: string;  // YYYY-MM-DD
  guests: number;
  roomType: string;
  contactName: string;
  contactPhone: string;
  createdAt: string; // ISO timestamp
}
```

- [ ] **Step 2: Write `src/config.ts`**

```ts
import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
  anthropicApiKey: required('ANTHROPIC_API_KEY'),
  staffGroupChatId: required('STAFF_GROUP_CHAT_ID'),
  anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
  dbPath: process.env.DB_PATH ?? './kazzhol.db',
};
```

- [ ] **Step 3: Commit**

```bash
git add src/types.ts src/config.ts
git commit -m "feat: shared types and typed config"
```

---

### Task 3: Astana knowledge base

**Files:**
- Create: `src/knowledge/astana.ts`

- [ ] **Step 1: Write `src/knowledge/astana.ts`**

> NOTE TO BUILDER: the figures below are from public research and must be confirmed with the owner before the live pitch. They are real enough to demo; replace with exact values when the owner provides them.

```ts
export const astanaKnowledge = `
PROPERTY: Hotel Kazzhol Astana — a 4-star business hotel in Astana, Kazakhstan.

LOCATION: ~10 minutes by car from the Bayterek monument, central Astana.
CHECK-IN / CHECK-OUT: Check-in from 14:00, check-out until 12:00.
ROOMS: Standard, Comfort, and Suite rooms. Indicative rates from about 25,000 KZT (~USD 55) per night; exact prices depend on dates and room type.
AMENITIES: Free Wi-Fi throughout, on-site restaurant (Kazakh and European cuisine), breakfast available, conference / meeting halls, free parking, 24-hour front desk.
LANGUAGES SPOKEN BY STAFF: Kazakh, Russian, English.
BOOKING: Guests can book directly with the hotel; for specific dates and live availability the reservations team confirms by message or phone.
CONTACT: Reservations are handled by the hotel team; this assistant can take a booking request and the team will confirm availability.
`.trim();
```

- [ ] **Step 2: Commit**

```bash
git add src/knowledge/astana.ts
git commit -m "feat: Astana property knowledge base"
```

---

### Task 4: SQLite store (conversations + leads)

**Files:**
- Create: `src/store.ts`
- Test: `tests/store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/store.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../src/store';

describe('Store', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:'); // in-memory SQLite for tests
  });

  it('creates a new active conversation on first access', () => {
    const convo = store.getOrCreateConversation(111, 'astana');
    expect(convo.status).toBe('active');
    expect(convo.history).toEqual([]);
    expect(convo.property).toBe('astana');
  });

  it('appends messages and persists history', () => {
    store.getOrCreateConversation(111, 'astana');
    store.appendMessage(111, { role: 'user', content: 'Привет' });
    store.appendMessage(111, { role: 'assistant', content: 'Здравствуйте!' });
    const convo = store.getOrCreateConversation(111, 'astana');
    expect(convo.history).toHaveLength(2);
    expect(convo.history[0]).toEqual({ role: 'user', content: 'Привет' });
  });

  it('marks a conversation handed off', () => {
    store.getOrCreateConversation(111, 'astana');
    store.setStatus(111, 'handed_off');
    expect(store.getOrCreateConversation(111, 'astana').status).toBe('handed_off');
  });

  it('saves a booking lead', () => {
    store.saveLead({
      chatId: 111, checkIn: '2026-07-01', checkOut: '2026-07-03',
      guests: 2, roomType: 'Comfort', contactName: 'Aibek',
      contactPhone: '+7700', createdAt: new Date().toISOString(),
    });
    const leads = store.listLeads();
    expect(leads).toHaveLength(1);
    expect(leads[0].contactName).toBe('Aibek');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/store.test.ts`
Expected: FAIL — cannot find module `../src/store`.

- [ ] **Step 3: Write `src/store.ts`**

```ts
import Database from 'better-sqlite3';
import type { ChatMessage, Conversation, ConversationStatus, BookingLead } from './types';

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        chat_id   INTEGER PRIMARY KEY,
        property  TEXT NOT NULL,
        status    TEXT NOT NULL,
        history   TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS leads (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id       INTEGER NOT NULL,
        check_in      TEXT NOT NULL,
        check_out     TEXT NOT NULL,
        guests        INTEGER NOT NULL,
        room_type     TEXT NOT NULL,
        contact_name  TEXT NOT NULL,
        contact_phone TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );
    `);
  }

  getOrCreateConversation(chatId: number, property: string): Conversation {
    const row = this.db
      .prepare('SELECT chat_id, property, status, history FROM conversations WHERE chat_id = ?')
      .get(chatId) as { chat_id: number; property: string; status: ConversationStatus; history: string } | undefined;

    if (row) {
      return {
        chatId: row.chat_id,
        property: row.property,
        status: row.status,
        history: JSON.parse(row.history) as ChatMessage[],
      };
    }
    this.db
      .prepare('INSERT INTO conversations (chat_id, property, status, history) VALUES (?, ?, ?, ?)')
      .run(chatId, property, 'active', '[]');
    return { chatId, property, status: 'active', history: [] };
  }

  appendMessage(chatId: number, message: ChatMessage): void {
    const convo = this.getOrCreateConversation(chatId, 'astana');
    const history = [...convo.history, message];
    this.db
      .prepare('UPDATE conversations SET history = ? WHERE chat_id = ?')
      .run(JSON.stringify(history), chatId);
  }

  setStatus(chatId: number, status: ConversationStatus): void {
    this.db.prepare('UPDATE conversations SET status = ? WHERE chat_id = ?').run(status, chatId);
  }

  saveLead(lead: BookingLead): void {
    this.db
      .prepare(`INSERT INTO leads
        (chat_id, check_in, check_out, guests, room_type, contact_name, contact_phone, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(lead.chatId, lead.checkIn, lead.checkOut, lead.guests, lead.roomType,
           lead.contactName, lead.contactPhone, lead.createdAt);
  }

  listLeads(): BookingLead[] {
    const rows = this.db
      .prepare('SELECT * FROM leads ORDER BY id')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      chatId: r.chat_id as number,
      checkIn: r.check_in as string,
      checkOut: r.check_out as string,
      guests: r.guests as number,
      roomType: r.room_type as string,
      contactName: r.contact_name as string,
      contactPhone: r.contact_phone as string,
      createdAt: r.created_at as string,
    }));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/store.ts tests/store.test.ts
git commit -m "feat: SQLite store for conversations and booking leads"
```

---

### Task 5: System prompt builder

**Files:**
- Create: `src/ai/systemPrompt.ts`
- Test: `tests/systemPrompt.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/systemPrompt.test.ts
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../src/ai/systemPrompt';
import { astanaKnowledge } from '../src/knowledge/astana';

describe('buildSystemPrompt', () => {
  const prompt = buildSystemPrompt(astanaKnowledge);

  it('embeds the property knowledge', () => {
    expect(prompt).toContain('Hotel Kazzhol Astana');
  });

  it('instructs language mirroring for the three languages', () => {
    expect(prompt).toMatch(/Russian/i);
    expect(prompt).toMatch(/Kazakh/i);
    expect(prompt).toMatch(/English/i);
    expect(prompt).toMatch(/same language/i);
  });

  it('forbids inventing facts and prices', () => {
    expect(prompt).toMatch(/do not (make up|invent)/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/systemPrompt.test.ts`
Expected: FAIL — cannot find module `../src/ai/systemPrompt`.

- [ ] **Step 3: Write `src/ai/systemPrompt.ts`**

```ts
export function buildSystemPrompt(propertyKnowledge: string): string {
  return `
You are the virtual concierge for Hotel Kazzhol Astana. You speak with guests in their
direct messages. Your personality is warm and friendly, polite, and genuinely helpful —
like a welcoming hotel receptionist.

LANGUAGE RULES:
- Guests write in Russian, Kazakh, or English. Detect the language of each guest message
  and ALWAYS reply in that same language. If a guest switches language, switch with them.
- If you are unsure of the language, default to Russian.

WHAT YOU CAN DO:
- Answer questions about the hotel using ONLY the property knowledge below.
- Help a guest who wants to book a room. Collect, conversationally and politely:
  check-in date, check-out date, number of guests, room type preference, their name,
  and a contact phone number. Once you have all of these, call the capture_booking_lead
  tool. Do NOT promise a confirmed reservation or a specific price — tell the guest the
  reservations team will confirm availability and the final price.
- When a guest is upset, makes a complaint, asks for something you cannot answer from the
  knowledge below, or explicitly asks to talk to a human, call the escalate_to_human tool
  and let the guest know a team member will reply shortly.

STRICT RULES:
- Do not make up or invent facts, prices, availability, or policies. If the knowledge below
  does not contain the answer, say you will check with the team and escalate.
- Never confirm a booking as final yourself — you only capture the request.
- Keep replies concise and friendly.

PROPERTY KNOWLEDGE:
${propertyKnowledge}
`.trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/systemPrompt.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ai/systemPrompt.ts tests/systemPrompt.test.ts
git commit -m "feat: system prompt builder with language + grounding rules"
```

---

### Task 6: Tool schemas

**Files:**
- Create: `src/ai/tools.ts`

- [ ] **Step 1: Write `src/ai/tools.ts`**

```ts
import type Anthropic from '@anthropic-ai/sdk';

export interface BookingLeadArgs {
  checkIn: string;
  checkOut: string;
  guests: number;
  roomType: string;
  contactName: string;
  contactPhone: string;
}

export interface EscalateArgs {
  reason: string;
  summary: string;
}

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'capture_booking_lead',
    description:
      'Save a guest booking request once all details are collected. Use only when you have ' +
      'check-in date, check-out date, number of guests, room type, contact name, and phone.',
    input_schema: {
      type: 'object',
      properties: {
        checkIn: { type: 'string', description: 'Check-in date, YYYY-MM-DD' },
        checkOut: { type: 'string', description: 'Check-out date, YYYY-MM-DD' },
        guests: { type: 'number', description: 'Number of guests' },
        roomType: { type: 'string', description: 'Requested room type' },
        contactName: { type: 'string', description: 'Guest name' },
        contactPhone: { type: 'string', description: 'Guest phone number' },
      },
      required: ['checkIn', 'checkOut', 'guests', 'roomType', 'contactName', 'contactPhone'],
    },
  },
  {
    name: 'escalate_to_human',
    description:
      'Hand the conversation to a human staff member. Use for complaints, upset guests, ' +
      'requests you cannot answer from the knowledge base, or explicit requests for a person.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Short reason for escalation' },
        summary: { type: 'string', description: 'One-line summary of what the guest needs' },
      },
      required: ['reason', 'summary'],
    },
  },
];
```

- [ ] **Step 2: Commit**

```bash
git add src/ai/tools.ts
git commit -m "feat: Claude tool schemas for lead capture and escalation"
```

---

### Task 7: AI orchestrator (Claude tool-use loop)

**Files:**
- Create: `src/ai/orchestrator.ts`
- Test: `tests/orchestrator.test.ts`

The orchestrator takes the conversation history and a set of callbacks, runs Claude's
tool-use loop, executes any tool calls via the callbacks, and returns the final guest-facing
text plus whether the conversation was handed off. It depends on a minimal Anthropic-like
client interface so tests can pass a fake.

- [ ] **Step 1: Write the failing test**

```ts
// tests/orchestrator.test.ts
import { describe, it, expect, vi } from 'vitest';
import { generateReply, type AnthropicLike } from '../src/ai/orchestrator';
import type { ChatMessage } from '../src/types';

const history: ChatMessage[] = [{ role: 'user', content: 'Where are you located?' }];

function fakeClient(responses: any[]): AnthropicLike {
  let i = 0;
  return { messages: { create: vi.fn(async () => responses[i++]) } };
}

describe('generateReply', () => {
  it('returns plain text when Claude does not call a tool', async () => {
    const client = fakeClient([
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'We are 10 minutes from Bayterek.' }] },
    ]);
    const result = await generateReply(history, {
      client, model: 'm', systemPrompt: 's',
      onBookingLead: vi.fn(), onEscalate: vi.fn(),
    });
    expect(result.reply).toBe('We are 10 minutes from Bayterek.');
    expect(result.handedOff).toBe(false);
  });

  it('runs capture_booking_lead then returns the follow-up text', async () => {
    const onBookingLead = vi.fn();
    const client = fakeClient([
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 't1', name: 'capture_booking_lead',
          input: { checkIn: '2026-07-01', checkOut: '2026-07-03', guests: 2,
                   roomType: 'Comfort', contactName: 'Aibek', contactPhone: '+7700' } },
      ]},
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Thank you! Our team will confirm.' }] },
    ]);
    const result = await generateReply(history, {
      client, model: 'm', systemPrompt: 's', onBookingLead, onEscalate: vi.fn(),
    });
    expect(onBookingLead).toHaveBeenCalledWith(expect.objectContaining({ contactName: 'Aibek' }));
    expect(result.reply).toBe('Thank you! Our team will confirm.');
    expect(result.handedOff).toBe(false);
  });

  it('marks handedOff when escalate_to_human is called', async () => {
    const onEscalate = vi.fn();
    const client = fakeClient([
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 't2', name: 'escalate_to_human',
          input: { reason: 'complaint', summary: 'Guest unhappy with noise' } },
      ]},
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'A team member will reply shortly.' }] },
    ]);
    const result = await generateReply(history, {
      client, model: 'm', systemPrompt: 's', onBookingLead: vi.fn(), onEscalate,
    });
    expect(onEscalate).toHaveBeenCalledWith('complaint', 'Guest unhappy with noise');
    expect(result.handedOff).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/orchestrator.test.ts`
Expected: FAIL — cannot find module `../src/ai/orchestrator`.

- [ ] **Step 3: Write `src/ai/orchestrator.ts`**

```ts
import type Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage } from '../types';
import { toolDefinitions, type BookingLeadArgs, type EscalateArgs } from './tools';

export interface AnthropicLike {
  messages: {
    create: (body: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;
  };
}

export interface GenerateDeps {
  client: AnthropicLike;
  model: string;
  systemPrompt: string;
  onBookingLead: (args: BookingLeadArgs) => Promise<void> | void;
  onEscalate: (reason: string, summary: string) => Promise<void> | void;
}

export async function generateReply(
  history: ChatMessage[],
  deps: GenerateDeps,
): Promise<{ reply: string; handedOff: boolean }> {
  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let handedOff = false;

  // Tool-use loop: keep going until Claude stops requesting tools.
  // Capped to avoid infinite loops on a misbehaving model.
  for (let turn = 0; turn < 5; turn++) {
    const response = await deps.client.messages.create({
      model: deps.model,
      max_tokens: 1024,
      system: deps.systemPrompt,
      tools: toolDefinitions,
      messages,
    });

    if (response.stop_reason !== 'tool_use') {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return { reply: text, handedOff };
    }

    // Echo the assistant turn (with tool_use blocks) back into the conversation.
    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      if (block.name === 'capture_booking_lead') {
        await deps.onBookingLead(block.input as BookingLeadArgs);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Lead saved.' });
      } else if (block.name === 'escalate_to_human') {
        const args = block.input as EscalateArgs;
        await deps.onEscalate(args.reason, args.summary);
        handedOff = true;
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Escalated to staff.' });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return { reply: 'Our team will get back to you shortly.', handedOff };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/orchestrator.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ai/orchestrator.ts tests/orchestrator.test.ts
git commit -m "feat: AI orchestrator with Claude tool-use loop"
```

---

### Task 8: Telegram bot + staff-group handoff + entry point

**Files:**
- Create: `src/telegram/bot.ts`, `src/index.ts`

This task is wiring; it is verified by manual run (Step 4), not a unit test — Telegraf and the
live Claude/Telegram APIs are integration surfaces, and the logic underneath them is already
covered by Tasks 4, 5, and 7.

- [ ] **Step 1: Write `src/telegram/bot.ts`**

```ts
import { Telegraf } from 'telegraf';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { Store } from '../store';
import { buildSystemPrompt } from '../ai/systemPrompt';
import { astanaKnowledge } from '../knowledge/astana';
import { generateReply } from '../ai/orchestrator';
import type { BookingLeadArgs } from '../ai/tools';

export function createBot(): Telegraf {
  const bot = new Telegraf(config.telegramBotToken);
  const store = new Store(config.dbPath);
  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  const systemPrompt = buildSystemPrompt(astanaKnowledge);

  bot.start((ctx) =>
    ctx.reply('Сәлеметсіз бе! Здравствуйте! Hello! Я виртуальный консьерж отеля Kazzhol Astana. Чем могу помочь?'),
  );

  bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;

    const convo = store.getOrCreateConversation(chatId, 'astana');
    // If a human already took over this thread, stay silent.
    if (convo.status === 'handed_off') return;

    store.appendMessage(chatId, { role: 'user', content: text });
    const updated = store.getOrCreateConversation(chatId, 'astana');

    await ctx.sendChatAction('typing');

    const { reply, handedOff } = await generateReply(updated.history, {
      client: anthropic,
      model: config.anthropicModel,
      systemPrompt,
      onBookingLead: (args: BookingLeadArgs) => {
        store.saveLead({ chatId, createdAt: new Date().toISOString(), ...args });
        notifyStaff(bot, `📋 New booking lead from chat ${chatId}:\n` +
          `${args.contactName} (${args.contactPhone})\n` +
          `${args.checkIn} → ${args.checkOut}, ${args.guests} guест(s), ${args.roomType}`);
      },
      onEscalate: (reason, summary) => {
        const transcript = updated.history.map((m) => `${m.role}: ${m.content}`).join('\n');
        notifyStaff(bot, `🚨 Handoff needed (chat ${chatId})\nReason: ${reason}\n${summary}\n\n--- Conversation ---\n${transcript}`);
      },
    });

    if (reply) {
      store.appendMessage(chatId, { role: 'assistant', content: reply });
      await ctx.reply(reply);
    }
    if (handedOff) store.setStatus(chatId, 'handed_off');
  });

  return bot;
}

function notifyStaff(bot: Telegraf, message: string): void {
  bot.telegram.sendMessage(config.staffGroupChatId, message).catch((err) => {
    console.error('Failed to notify staff group:', err);
  });
}
```

- [ ] **Step 2: Write `src/index.ts`**

```ts
import { createBot } from './telegram/bot';

const bot = createBot();

bot.launch().then(() => console.log('Kazzhol Astana concierge bot is running.'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
```

- [ ] **Step 3: Type-check and run the full test suite**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors; all tests from Tasks 4, 5, 7 PASS.

- [ ] **Step 4: Manual smoke test (requires real credentials)**

1. Create a bot with @BotFather, copy the token.
2. Create a private Telegram group, add the bot, and get the group chat id (e.g. add @RawDataBot temporarily, or read it from an update).
3. Copy `.env.example` to `.env` and fill `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `STAFF_GROUP_CHAT_ID`.
4. Run: `npm run dev`
5. From your personal Telegram, message the bot:
   - Ask in Russian "Где находится отель?" → expect a Russian answer grounded in the KB.
   - Ask in Kazakh and English → expect replies in the same language.
   - Say "Хочу забронировать номер на 1–3 июля, 2 гостя" and follow through → expect it to collect details, then a lead appears in the staff group.
   - Say "Хочу поговорить с человеком" → expect an escalation message in the staff group and the bot to go quiet on that thread.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/bot.ts src/index.ts
git commit -m "feat: Telegram bot wiring with staff-group handoff"
```

---

### Task 9: README for the pitch

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`** documenting: what the MVP is, the setup steps from Task 8 Step 4, how to run (`npm run dev`), and the explicit note that real availability/pricing, WhatsApp, and Instagram are deferred pending PMS + Meta access (link to `docs/PRD.md` and `RULES.md`).

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README with setup and pitch instructions"
```

---

## Self-Review

**Spec coverage (vs PRD §8a MVP):**
- Telegram bot → Task 8 ✓
- FAQ in RU/KK/EN, auto-detect + mirror → Task 5 (system prompt) + Task 8 ✓
- Grounded in real Astana facts → Task 3 ✓
- Booking lead-capture fallback (no PMS) → Tasks 6, 7, 8 (`capture_booking_lead` → store) ✓
- Human handoff → private Telegram staff group → Tasks 6, 7, 8 (`escalate_to_human` → `notifyStaff`, status `handed_off`) ✓
- Warm & friendly voice → Task 5 ✓
- One property (Astana) first → Task 3 ✓
- Deferred (PMS/Meta/outbound) → not built, documented in Task 9 README ✓

**Placeholder scan:** Astana KB figures are flagged for owner confirmation (real research values, not "TBD"); all code steps contain complete code. No `TODO`/`TBD` in build steps.

**Type consistency:** `ChatMessage`, `Conversation`, `BookingLead` (types.ts) used consistently. `BookingLeadArgs`/`EscalateArgs` (tools.ts) used by the orchestrator and bot. `Store` method names (`getOrCreateConversation`, `appendMessage`, `setStatus`, `saveLead`, `listLeads`) consistent across store.ts, tests, and bot.ts. `generateReply` signature matches between orchestrator.ts, its test, and bot.ts. `AnthropicLike` satisfied by the real `Anthropic` client (has `messages.create`).

**Note for builder:** verify the exact `@anthropic-ai/sdk` block/param type names (`Anthropic.Tool`, `Anthropic.Message`, `Anthropic.TextBlock`, `Anthropic.ToolResultBlockParam`, `MessageCreateParamsNonStreaming`) against the installed SDK version during Task 7/8; adjust imports if the SDK has renamed them. Behavior is unchanged.
