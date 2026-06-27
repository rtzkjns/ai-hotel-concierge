# P1 Live Availability (Exely, stubbed) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the concierge AI a `check_availability` capability that returns live room availability/prices through a swappable provider — built and fully testable now on a deterministic **stub**, so the real Exely client drops in later (when credentials + Swagger arrive) with no change to the orchestrator, tools, or prompt.

**Architecture:** Introduce an `AvailabilityProvider` interface in a new `src/integrations/exely/` module. A `StubAvailabilityProvider` returns deterministic fake offers now. A factory chooses the provider from config. The orchestrator gains a `checkAvailability` dependency and handles a new `check_availability` tool whose result is fed back to the model. The real Exely HTTP client is a **separate follow-up plan** (it needs the owner's `client_id`/`client_secret` and the Exely Connect Swagger spec for the availability endpoint, which we don't have yet). This plan also builds the Exely **OAuth token manager** (whose spec we *do* have) so the follow-up plan only has to add the one availability request.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), Node 25, `@anthropic-ai/sdk`, Vitest, native `fetch`.

## Global Constraints

- Module system: **ESM** (`"type": "module"`); relative imports are extensionless in source (matches existing `import { Store } from './store'`), `moduleResolution: "Bundler"`.
- Strict TypeScript (`strict: true`). No `any` in new code; use `unknown` + narrowing.
- **Never present stub data as real.** Every `AvailabilityResult` carries a `source: 'stub' | 'exely'` field so callers can tell provenance; the system prompt must instruct the AI to never invent prices and to rely only on the tool result.
- Languages: the concierge replies in **RU / KK / EN**; this plan adds no user-facing copy except inside tool descriptions (English, model-facing).
- Tests: `vitest run` (script `npm test`). Each task ends green.
- Exely auth (confirmed from Exely docs kb350837): `POST https://connect.hopenapi.com/auth/token`, body `grant_type=client_credentials` + `client_id` + `client_secret`, returns a JWT valid **15 min**, **no refresh token**, rate limits 3/sec · 15/min · 300/hr per IP. The availability **request** endpoint shape is NOT yet known — it is out of scope here (follow-up plan).

---

## File Structure

- `src/integrations/exely/types.ts` — domain types: `AvailabilityQuery`, `RoomOffer`, `AvailabilityResult`.
- `src/integrations/exely/provider.ts` — the `AvailabilityProvider` interface.
- `src/integrations/exely/stub.ts` — `StubAvailabilityProvider` (deterministic fake offers).
- `src/integrations/exely/token.ts` — `ExelyTokenManager` (OAuth client-credentials + 15-min cache).
- `src/integrations/exely/index.ts` — `createAvailabilityProvider(cfg)` factory (stub now; throws a clear "not implemented" for real until follow-up plan).
- `src/ai/tools.ts` — **modify**: add `check_availability` tool definition + `CheckAvailabilityArgs` type.
- `src/ai/orchestrator.ts` — **modify**: add `checkAvailability` dep + handle the tool, feeding the result back to the model.
- `src/ai/systemPrompt.ts` — **modify**: instruct the AI to use `check_availability` for live availability/price and never invent it.
- `src/config.ts` — **modify**: add optional `exely` config block.
- Tests: `tests/exely.stub.test.ts`, `tests/exely.token.test.ts`, `tests/exely.factory.test.ts`, `tests/orchestrator.availability.test.ts`, `tests/systemPrompt.test.ts` (extend).

---

### Task 1: Availability domain types, provider interface, and stub provider

**Files:**
- Create: `src/integrations/exely/types.ts`
- Create: `src/integrations/exely/provider.ts`
- Create: `src/integrations/exely/stub.ts`
- Test: `tests/exely.stub.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `AvailabilityQuery { property: string; checkIn: string; checkOut: string; guests: number; roomType?: string }`
  - `RoomOffer { roomType: string; available: boolean; pricePerNight: number | null; currency: string; notes?: string }`
  - `AvailabilityResult { property: string; checkIn: string; checkOut: string; offers: RoomOffer[]; source: 'stub' | 'exely' }`
  - `interface AvailabilityProvider { checkAvailability(query: AvailabilityQuery): Promise<AvailabilityResult> }`
  - `class StubAvailabilityProvider implements AvailabilityProvider` (constructor takes no args).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/exely.stub.test.ts
import { describe, it, expect } from 'vitest';
import { StubAvailabilityProvider } from '../src/integrations/exely/stub';

describe('StubAvailabilityProvider', () => {
  it('returns deterministic offers tagged as stub source', async () => {
    const provider = new StubAvailabilityProvider();
    const result = await provider.checkAvailability({
      property: 'astana',
      checkIn: '2026-08-01',
      checkOut: '2026-08-03',
      guests: 2,
    });

    expect(result.source).toBe('stub');
    expect(result.property).toBe('astana');
    expect(result.checkIn).toBe('2026-08-01');
    expect(result.offers.length).toBeGreaterThan(0);
    for (const offer of result.offers) {
      expect(typeof offer.roomType).toBe('string');
      expect(offer.currency).toBe('KZT');
    }
    // Deterministic: same query → same prices.
    const again = await provider.checkAvailability({
      property: 'astana',
      checkIn: '2026-08-01',
      checkOut: '2026-08-03',
      guests: 2,
    });
    expect(again.offers).toEqual(result.offers);
  });

  it('filters to a requested room type when given', async () => {
    const provider = new StubAvailabilityProvider();
    const result = await provider.checkAvailability({
      property: 'almaty',
      checkIn: '2026-08-01',
      checkOut: '2026-08-02',
      guests: 1,
      roomType: 'Suite',
    });
    expect(result.offers.every((o) => o.roomType === 'Suite')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- exely.stub`
Expected: FAIL — cannot find module `../src/integrations/exely/stub`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/integrations/exely/types.ts
export interface AvailabilityQuery {
  property: string; // property key, e.g. 'astana'
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  guests: number;
  roomType?: string;
}

export interface RoomOffer {
  roomType: string;
  available: boolean;
  pricePerNight: number | null; // KZT; null if unknown
  currency: string; // 'KZT'
  notes?: string;
}

export interface AvailabilityResult {
  property: string;
  checkIn: string;
  checkOut: string;
  offers: RoomOffer[];
  source: 'stub' | 'exely'; // provenance; never present 'stub' as live truth
}
```

```typescript
// src/integrations/exely/provider.ts
import type { AvailabilityQuery, AvailabilityResult } from './types';

export interface AvailabilityProvider {
  checkAvailability(query: AvailabilityQuery): Promise<AvailabilityResult>;
}
```

```typescript
// src/integrations/exely/stub.ts
import type { AvailabilityProvider } from './provider';
import type { AvailabilityQuery, AvailabilityResult, RoomOffer } from './types';

// Deterministic fake catalogue so development & tests are stable.
// Base prices are intentionally round and obviously-fake (NOT real Kazzhol rates).
const BASE: Record<string, number> = { Standard: 25000, Comfort: 32000, Suite: 48000 };

export class StubAvailabilityProvider implements AvailabilityProvider {
  async checkAvailability(query: AvailabilityQuery): Promise<AvailabilityResult> {
    const roomTypes = query.roomType ? [query.roomType] : Object.keys(BASE);
    const offers: RoomOffer[] = roomTypes.map((roomType) => ({
      roomType,
      available: true,
      pricePerNight: BASE[roomType] ?? 30000,
      currency: 'KZT',
      notes: 'STUB DATA — not real availability',
    }));
    return {
      property: query.property,
      checkIn: query.checkIn,
      checkOut: query.checkOut,
      offers,
      source: 'stub',
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- exely.stub`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/integrations/exely/types.ts src/integrations/exely/provider.ts src/integrations/exely/stub.ts tests/exely.stub.test.ts
git commit -m "feat(exely): availability provider interface + deterministic stub"
```

---

### Task 2: `check_availability` tool + orchestrator wiring

**Files:**
- Modify: `src/ai/tools.ts`
- Modify: `src/ai/orchestrator.ts`
- Test: `tests/orchestrator.availability.test.ts`

**Interfaces:**
- Consumes: `AvailabilityResult` from Task 1; existing `generateReply`, `toolDefinitions`.
- Produces:
  - `CheckAvailabilityArgs { checkIn: string; checkOut: string; guests: number; roomType?: string }` (model-facing; `property` is injected by the caller, not the model).
  - `GenerateDeps` gains `checkAvailability: (args: CheckAvailabilityArgs) => Promise<AvailabilityResult>`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/orchestrator.availability.test.ts
import { describe, it, expect, vi } from 'vitest';
import { generateReply } from '../src/ai/orchestrator';
import type { AnthropicLike } from '../src/ai/orchestrator';
import type { AvailabilityResult } from '../src/integrations/exely/types';

// A fake Anthropic client: first call requests check_availability, second returns text.
function fakeClient(): AnthropicLike {
  let call = 0;
  return {
    messages: {
      create: vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return {
            stop_reason: 'tool_use',
            content: [
              {
                type: 'tool_use',
                id: 'tool_1',
                name: 'check_availability',
                input: { checkIn: '2026-08-01', checkOut: '2026-08-03', guests: 2 },
              },
            ],
          } as never;
        }
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Standard rooms are available.' }],
        } as never;
      }),
    },
  };
}

describe('generateReply with check_availability', () => {
  it('calls the availability dep and feeds the result back to the model', async () => {
    const result: AvailabilityResult = {
      property: 'astana',
      checkIn: '2026-08-01',
      checkOut: '2026-08-03',
      offers: [{ roomType: 'Standard', available: true, pricePerNight: 25000, currency: 'KZT' }],
      source: 'stub',
    };
    const checkAvailability = vi.fn(async () => result);
    const client = fakeClient();

    const out = await generateReply([{ role: 'user', content: 'Rooms for Aug 1-3?' }], {
      client,
      model: 'test-model',
      systemPrompt: 'sp',
      onBookingLead: vi.fn(),
      onEscalate: vi.fn(),
      checkAvailability,
    });

    expect(checkAvailability).toHaveBeenCalledWith({
      checkIn: '2026-08-01',
      checkOut: '2026-08-03',
      guests: 2,
    });
    expect(out.reply).toBe('Standard rooms are available.');
    // The second model call must include a tool_result carrying the availability JSON.
    const secondCallArgs = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[1][0];
    const lastMsg = secondCallArgs.messages.at(-1);
    const toolResult = lastMsg.content[0];
    expect(toolResult.type).toBe('tool_result');
    expect(String(toolResult.content)).toContain('Standard');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- orchestrator.availability`
Expected: FAIL — `checkAvailability` not part of `GenerateDeps` / tool not handled.

- [ ] **Step 3: Write minimal implementation**

Add to `src/ai/tools.ts` (append the type and a new tool object to the array):

```typescript
export interface CheckAvailabilityArgs {
  checkIn: string;
  checkOut: string;
  guests: number;
  roomType?: string;
}
```

```typescript
// add this object inside the toolDefinitions array (before escalate_to_human is fine)
  {
    name: 'check_availability',
    description:
      'Look up LIVE room availability and price for specific dates. Always call this before ' +
      'quoting any price or saying whether rooms are free — never guess. Returns room offers ' +
      'with per-night price in KZT.',
    input_schema: {
      type: 'object',
      properties: {
        checkIn: { type: 'string', description: 'Check-in date, YYYY-MM-DD' },
        checkOut: { type: 'string', description: 'Check-out date, YYYY-MM-DD' },
        guests: { type: 'number', description: 'Number of guests' },
        roomType: { type: 'string', description: 'Optional specific room type to filter by' },
      },
      required: ['checkIn', 'checkOut', 'guests'],
    },
  },
```

In `src/ai/orchestrator.ts`, update imports, deps, and the tool loop:

```typescript
import { toolDefinitions, type BookingLeadArgs, type EscalateArgs, type CheckAvailabilityArgs } from './tools';
import type { AvailabilityResult } from '../integrations/exely/types';
```

Add to `GenerateDeps`:

```typescript
  checkAvailability: (args: CheckAvailabilityArgs) => Promise<AvailabilityResult>;
```

Inside the `for (const block of response.content)` loop, add a branch (before the closing of the loop):

```typescript
      } else if (block.name === 'check_availability') {
        const args = block.input as CheckAvailabilityArgs;
        const availability = await deps.checkAvailability(args);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(availability),
        });
      }
```

(Place it as an `else if` alongside the existing `capture_booking_lead` / `escalate_to_human` branches.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- orchestrator`
Expected: PASS (existing `orchestrator.test.ts` + new `orchestrator.availability.test.ts`). If the existing orchestrator test constructs `GenerateDeps` without `checkAvailability`, add `checkAvailability: vi.fn(async () => ({ property: '', checkIn: '', checkOut: '', offers: [], source: 'stub' as const }))` to that test's deps so it compiles.

- [ ] **Step 5: Commit**

```bash
git add src/ai/tools.ts src/ai/orchestrator.ts tests/orchestrator.availability.test.ts tests/orchestrator.test.ts
git commit -m "feat(ai): check_availability tool wired through orchestrator"
```

---

### Task 3: System-prompt instruction for live availability

**Files:**
- Modify: `src/ai/systemPrompt.ts`
- Test: `tests/systemPrompt.test.ts` (extend)

**Interfaces:**
- Consumes: existing `buildSystemPrompt(propertyName, propertyKnowledge)`.
- Produces: same signature; prompt now mentions `check_availability`.

- [ ] **Step 1: Write the failing test** (add to the existing file)

```typescript
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../src/ai/systemPrompt';

describe('buildSystemPrompt availability rules', () => {
  it('tells the AI to use check_availability and never invent prices/availability', () => {
    const prompt = buildSystemPrompt('Hotel Kazzhol Astana', 'KNOWLEDGE');
    expect(prompt).toContain('check_availability');
    expect(prompt.toLowerCase()).toContain('never invent');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- systemPrompt`
Expected: FAIL — prompt does not contain `check_availability`.

- [ ] **Step 3: Write minimal implementation**

In `src/ai/systemPrompt.ts`, add an AVAILABILITY block to the returned template (e.g. right after the `BOOKING:` section):

```typescript
// inside the template string, add:
`
LIVE AVAILABILITY & PRICES:
- For any question about whether rooms are free, or what a price is for specific dates,
  you MUST call check_availability and answer ONLY from its result. Never invent or
  estimate availability or prices. If the tool returns no offers, say the team will confirm.
`
```

Ensure the literal text contains both `check_availability` and the phrase `never invent`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- systemPrompt`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ai/systemPrompt.ts tests/systemPrompt.test.ts
git commit -m "feat(ai): prompt rule to use check_availability and never invent prices"
```

---

### Task 4: Exely OAuth token manager

**Files:**
- Create: `src/integrations/exely/token.ts`
- Test: `tests/exely.token.test.ts`

**Interfaces:**
- Consumes: nothing (uses injected `fetch` + injected clock for testability).
- Produces:
  - `interface ExelyTokenConfig { clientId: string; clientSecret: string; authUrl: string }`
  - `class ExelyTokenManager` with `constructor(cfg: ExelyTokenConfig, deps?: { fetchFn?: typeof fetch; now?: () => number })` and `getToken(): Promise<string>` (caches until 60s before the 15-min expiry, then refetches).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/exely.token.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ExelyTokenManager } from '../src/integrations/exely/token';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('ExelyTokenManager', () => {
  const cfg = { clientId: 'id', clientSecret: 'secret', authUrl: 'https://connect.hopenapi.com/auth/token' };

  it('fetches a token with client_credentials and caches it', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ access_token: 'JWT123', expires_in: 900 }));
    let t = 0;
    const mgr = new ExelyTokenManager(cfg, { fetchFn: fetchFn as unknown as typeof fetch, now: () => t });

    expect(await mgr.getToken()).toBe('JWT123');
    expect(await mgr.getToken()).toBe('JWT123'); // cached
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(cfg.authUrl);
    expect(init.method).toBe('POST');
    expect(String(init.body)).toContain('grant_type=client_credentials');
    expect(String(init.body)).toContain('client_id=id');
  });

  it('refetches after the token nears expiry', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'A', expires_in: 900 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'B', expires_in: 900 }));
    let t = 0;
    const mgr = new ExelyTokenManager(cfg, { fetchFn: fetchFn as unknown as typeof fetch, now: () => t });

    expect(await mgr.getToken()).toBe('A');
    t += 900_000; // 15 min later → expired
    expect(await mgr.getToken()).toBe('B');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('throws a clear error on a non-OK response', async () => {
    const fetchFn = vi.fn(async () => new Response('nope', { status: 401 }));
    const mgr = new ExelyTokenManager(cfg, { fetchFn: fetchFn as unknown as typeof fetch, now: () => 0 });
    await expect(mgr.getToken()).rejects.toThrow(/exely auth failed/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- exely.token`
Expected: FAIL — cannot find module `../src/integrations/exely/token`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/integrations/exely/token.ts
export interface ExelyTokenConfig {
  clientId: string;
  clientSecret: string;
  authUrl: string;
}

interface TokenDeps {
  fetchFn?: typeof fetch;
  now?: () => number;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

// Refetch this many ms before the real expiry, to avoid using a token mid-flight as it dies.
const EXPIRY_SKEW_MS = 60_000;

export class ExelyTokenManager {
  private cached: CachedToken | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly cfg: ExelyTokenConfig, deps: TokenDeps = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.now = deps.now ?? (() => Date.now());
  }

  async getToken(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAtMs - EXPIRY_SKEW_MS) {
      return this.cached.token;
    }
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
    });
    const res = await this.fetchFn(this.cfg.authUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new Error(`Exely auth failed: ${res.status}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      throw new Error('Exely auth failed: no access_token in response');
    }
    const ttlMs = (json.expires_in ?? 900) * 1000;
    this.cached = { token: json.access_token, expiresAtMs: this.now() + ttlMs };
    return this.cached.token;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- exely.token`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/integrations/exely/token.ts tests/exely.token.test.ts
git commit -m "feat(exely): OAuth client-credentials token manager with 15-min cache"
```

---

### Task 5: Provider factory + config wiring

**Files:**
- Modify: `src/config.ts`
- Create: `src/integrations/exely/index.ts`
- Test: `tests/exely.factory.test.ts`

**Interfaces:**
- Consumes: `StubAvailabilityProvider` (Task 1), `AvailabilityProvider` (Task 1).
- Produces:
  - `interface ExelyConfig { clientId?: string; clientSecret?: string; authUrl: string }`
  - `createAvailabilityProvider(cfg: ExelyConfig): AvailabilityProvider` — returns a `StubAvailabilityProvider` when credentials are absent; **throws** a clear "Exely live provider not implemented yet" error when credentials ARE present (the real client is the follow-up plan). This makes the swap point explicit and impossible to ignore.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/exely.factory.test.ts
import { describe, it, expect } from 'vitest';
import { createAvailabilityProvider } from '../src/integrations/exely';
import { StubAvailabilityProvider } from '../src/integrations/exely/stub';

const authUrl = 'https://connect.hopenapi.com/auth/token';

describe('createAvailabilityProvider', () => {
  it('returns the stub when no credentials are configured', () => {
    const provider = createAvailabilityProvider({ authUrl });
    expect(provider).toBeInstanceOf(StubAvailabilityProvider);
  });

  it('throws a clear not-implemented error when credentials ARE set (real client = follow-up plan)', () => {
    expect(() =>
      createAvailabilityProvider({ clientId: 'id', clientSecret: 'secret', authUrl }),
    ).toThrow(/not implemented/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- exely.factory`
Expected: FAIL — cannot find module `../src/integrations/exely`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/integrations/exely/index.ts
import type { AvailabilityProvider } from './provider';
import { StubAvailabilityProvider } from './stub';

export interface ExelyConfig {
  clientId?: string;
  clientSecret?: string;
  authUrl: string;
}

export function createAvailabilityProvider(cfg: ExelyConfig): AvailabilityProvider {
  if (cfg.clientId && cfg.clientSecret) {
    // Credentials are present but the live Exely availability client is built in the
    // follow-up plan (needs the Exely Connect Swagger for the availability endpoint).
    throw new Error(
      'Exely live availability provider not implemented yet — see the follow-up plan. ' +
        'Remove EXELY_CLIENT_ID/SECRET to run on the stub.',
    );
  }
  return new StubAvailabilityProvider();
}

export type { AvailabilityProvider } from './provider';
export type { AvailabilityQuery, AvailabilityResult, RoomOffer } from './types';
```

Add the optional `exely` block to `src/config.ts` (note: these are NOT `required()` — they're optional until the owner provides them):

```typescript
  exely: {
    clientId: process.env.EXELY_CLIENT_ID,
    clientSecret: process.env.EXELY_CLIENT_SECRET,
    authUrl: process.env.EXELY_AUTH_URL ?? 'https://connect.hopenapi.com/auth/token',
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- exely.factory`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — all suites green.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/integrations/exely/index.ts tests/exely.factory.test.ts
git commit -m "feat(exely): availability provider factory + optional config"
```

---

## Self-Review

**Spec coverage:** This plan delivers the "live system pull" capability from `PRD.md` §P1.3 in stub form (the owner-independent slice). It explicitly defers, to a named follow-up plan, the two genuinely owner/Swagger-gated pieces: the real Exely **availability HTTP request** and live credentials. The OAuth token manager (spec known) is built now. Channel work (Telegram→WhatsApp/local harness) is a separate plan and intentionally not in scope here.

**Placeholder scan:** No "TBD"/"add error handling"/"write tests for the above" — every code and test step is concrete. The one deliberate runtime `throw` in the factory is a designed guard, not a placeholder.

**Type consistency:** `AvailabilityQuery`/`AvailabilityResult`/`RoomOffer` defined in Task 1 are used identically in Tasks 2 and 5. `checkAvailability` dep signature in Task 2 matches `CheckAvailabilityArgs` (Task 2) → `AvailabilityResult` (Task 1). `ExelyConfig` (Task 5) matches the `config.exely` shape.

## Follow-up plans (out of scope here, listed so they aren't lost)
1. **Real Exely availability client** — implement `ExelyAvailabilityProvider` using `ExelyTokenManager` + the Exely Connect availability endpoint (needs Swagger + owner credentials); flip the factory's throw into returning it.
2. **Channel adapters** — extract a channel-agnostic `Channel` interface, add a local CLI/test harness, then a WhatsApp adapter; retire the Telegram bot as the dev harness.
3. **Per-property KB in RU/KK/EN** — replace placeholder knowledge with owner-provided content.
