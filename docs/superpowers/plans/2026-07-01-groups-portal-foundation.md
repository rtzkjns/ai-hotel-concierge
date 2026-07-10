# Groups Portal Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the new Groups Portal web app and ship its first working slice — a company can submit a registration form and it is saved as a `pending` company in a local database, behind a data-access interface that can later be swapped to Supabase.

**Architecture:** A new Next.js (App Router, TypeScript) app in `/Users/abzalm/kazzhol-groups`, separate from the DM-bot repo. Data access goes through a `CompanyRepository` interface; the first implementation is local SQLite (`better-sqlite3`), so everything runs and is testable now with zero external services. When a hosted Supabase project is provisioned, a `SupabaseCompanyRepository` implements the same interface — no page/logic changes. This mirrors the stub→real pattern used in the DM bot's Exely integration.

**Tech Stack:** Next.js (App Router) · TypeScript · React · `better-sqlite3` (local dev DB) · Vitest (unit tests) · Zod (input validation).

## Global Constraints

- Portal is a **separate app** on its own subdomain later; connects to the existing kazzhol.com site only via a redirect link. Do not build inside the existing site.
- Data access is **always** through the `CompanyRepository` interface — pages/actions never touch a DB driver directly. This is the swap point for Supabase.
- New company records start with status **`pending`** (staff approve later, in a follow-up plan).
- Strict TypeScript. Validate all external input with Zod. No secrets in code.
- Match the *look* of Kazzhol later (branding); this slice is functional, minimal styling.
- Tests run with `npm test` (Vitest). Each task ends green.

---

## File Structure

- `kazzhol-groups/` — new app root (own git repo).
- `app/page.tsx` — landing → link to register.
- `app/register/page.tsx` — company registration form (server component rendering the form).
- `app/register/actions.ts` — the `registerCompany` server action.
- `src/domain/company.ts` — `Company` type + `CompanyStatus` + the Zod schema for registration input.
- `src/data/company-repository.ts` — the `CompanyRepository` interface.
- `src/data/sqlite-company-repository.ts` — local SQLite implementation.
- `src/data/repository.ts` — `getCompanyRepository()` factory (returns the SQLite impl now).
- `tests/company-repository.test.ts` — repository behavior.
- `tests/register-action.test.ts` — registration action behavior.

---

### Task 1: Scaffold the Next.js app + running skeleton

**Files:**
- Create: the `kazzhol-groups/` app via the Next.js scaffolder, then trim to what we need.
- Create: `kazzhol-groups/vitest.config.ts`, adjust `package.json` scripts.

**Interfaces:**
- Consumes: nothing.
- Produces: a running app (`npm run dev`) and a green `npm test` command that later tasks extend.

- [ ] **Step 1: Scaffold the app**

Run (from `/Users/abzalm`):
```bash
npx create-next-app@latest kazzhol-groups --ts --app --eslint --no-tailwind --src-dir=false --import-alias "@/*" --use-npm
```
Expected: a new `kazzhol-groups/` directory with a Next.js App Router project. (If the scaffolder cannot run offline, hand-create a minimal Next.js App Router project with the same layout: `app/layout.tsx`, `app/page.tsx`, `package.json` with `next`, `react`, `react-dom`, `tsconfig.json`.)

- [ ] **Step 2: Add test + data deps**

Run (from `/Users/abzalm/kazzhol-groups`):
```bash
npm install -D vitest @types/better-sqlite3 && npm install better-sqlite3 zod
```

- [ ] **Step 3: Add Vitest config + test script**

Create `kazzhol-groups/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
```
Add to `kazzhol-groups/package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 4: Verify the skeleton runs and tests wire up**

Create a placeholder `tests/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
describe('smoke', () => { it('runs', () => { expect(1 + 1).toBe(2); }); });
```
Run: `npm test`
Expected: PASS (1 test). Also confirm `npm run build` (or `npm run dev`) starts without error.

- [ ] **Step 5: Commit**

```bash
cd /Users/abzalm/kazzhol-groups && git init -q && git add -A && git commit -q -m "chore: scaffold Kazzhol Groups portal (Next.js + Vitest)"
```

---

### Task 2: Company domain model + repository interface + SQLite implementation

**Files:**
- Create: `src/domain/company.ts`
- Create: `src/data/company-repository.ts`
- Create: `src/data/sqlite-company-repository.ts`
- Create: `src/data/repository.ts`
- Test: `tests/company-repository.test.ts`

**Interfaces:**
- Consumes: nothing (foundation).
- Produces:
  - `type CompanyStatus = 'pending' | 'approved' | 'rejected'`
  - `interface Company { id: string; name: string; contactEmail: string; contactName: string; phone: string; status: CompanyStatus; createdAt: string }`
  - `registrationSchema` (Zod) + `type RegistrationInput = { name: string; contactEmail: string; contactName: string; phone: string }`
  - `interface CompanyRepository { create(input: RegistrationInput): Promise<Company>; getByEmail(email: string): Promise<Company | null>; list(): Promise<Company[]> }`
  - `class SqliteCompanyRepository implements CompanyRepository` (constructor `(dbPath: string)`)
  - `getCompanyRepository(): CompanyRepository`

- [ ] **Step 1: Write the failing test**

```ts
// tests/company-repository.test.ts
import { describe, it, expect } from 'vitest';
import { SqliteCompanyRepository } from '../src/data/sqlite-company-repository';

function repo() {
  return new SqliteCompanyRepository(':memory:');
}

describe('SqliteCompanyRepository', () => {
  it('creates a company as pending and reads it back by email', async () => {
    const r = repo();
    const created = await r.create({
      name: 'Acme Tours',
      contactEmail: 'ops@acme.example',
      contactName: 'Aigerim',
      phone: '+7 700 000 0000',
    });
    expect(created.id).toBeTruthy();
    expect(created.status).toBe('pending');
    expect(created.name).toBe('Acme Tours');

    const found = await r.getByEmail('ops@acme.example');
    expect(found?.id).toBe(created.id);
    expect(await r.getByEmail('nobody@example.com')).toBeNull();
  });

  it('lists created companies', async () => {
    const r = repo();
    await r.create({ name: 'A', contactEmail: 'a@x.com', contactName: 'A', phone: '1' });
    await r.create({ name: 'B', contactEmail: 'b@x.com', contactName: 'B', phone: '2' });
    const all = await r.list();
    expect(all.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- company-repository`
Expected: FAIL — cannot find module `sqlite-company-repository`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/domain/company.ts
import { z } from 'zod';

export type CompanyStatus = 'pending' | 'approved' | 'rejected';

export interface Company {
  id: string;
  name: string;
  contactEmail: string;
  contactName: string;
  phone: string;
  status: CompanyStatus;
  createdAt: string; // ISO
}

export const registrationSchema = z.object({
  name: z.string().min(1),
  contactEmail: z.string().email(),
  contactName: z.string().min(1),
  phone: z.string().min(3),
});

export type RegistrationInput = z.infer<typeof registrationSchema>;
```

```ts
// src/data/company-repository.ts
import type { Company, RegistrationInput } from '../domain/company';

export interface CompanyRepository {
  create(input: RegistrationInput): Promise<Company>;
  getByEmail(email: string): Promise<Company | null>;
  list(): Promise<Company[]>;
}
```

```ts
// src/data/sqlite-company-repository.ts
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { CompanyRepository } from './company-repository';
import type { Company, RegistrationInput } from '../domain/company';

export class SqliteCompanyRepository implements CompanyRepository {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS companies (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        contact_email TEXT NOT NULL UNIQUE,
        contact_name  TEXT NOT NULL,
        phone         TEXT NOT NULL,
        status        TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );
    `);
  }

  async create(input: RegistrationInput): Promise<Company> {
    const company: Company = {
      id: randomUUID(),
      name: input.name,
      contactEmail: input.contactEmail,
      contactName: input.contactName,
      phone: input.phone,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO companies (id, name, contact_email, contact_name, phone, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(company.id, company.name, company.contactEmail, company.contactName, company.phone, company.status, company.createdAt);
    return company;
  }

  async getByEmail(email: string): Promise<Company | null> {
    const row = this.db.prepare('SELECT * FROM companies WHERE contact_email = ?').get(email) as
      | Record<string, string>
      | undefined;
    return row ? this.rowToCompany(row) : null;
  }

  async list(): Promise<Company[]> {
    const rows = this.db.prepare('SELECT * FROM companies ORDER BY created_at').all() as Array<Record<string, string>>;
    return rows.map((r) => this.rowToCompany(r));
  }

  private rowToCompany(r: Record<string, string>): Company {
    return {
      id: r.id,
      name: r.name,
      contactEmail: r.contact_email,
      contactName: r.contact_name,
      phone: r.phone,
      status: r.status as Company['status'],
      createdAt: r.created_at,
    };
  }
}
```

```ts
// src/data/repository.ts
import type { CompanyRepository } from './company-repository';
import { SqliteCompanyRepository } from './sqlite-company-repository';

let instance: CompanyRepository | null = null;

// Local-first: SQLite now. Swap to SupabaseCompanyRepository here when a
// hosted Supabase project is provisioned — same interface, no caller changes.
export function getCompanyRepository(): CompanyRepository {
  if (!instance) {
    instance = new SqliteCompanyRepository(process.env.PORTAL_DB_PATH ?? './portal.db');
  }
  return instance;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- company-repository`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src tests && git commit -q -m "feat: company model + repository interface + local SQLite impl"
```

---

### Task 3: Registration server action + form page

**Files:**
- Create: `app/register/actions.ts`
- Create: `app/register/page.tsx`
- Modify: `app/page.tsx` (add a link to /register)
- Test: `tests/register-action.test.ts`

**Interfaces:**
- Consumes: `registrationSchema`, `RegistrationInput` (Task 2); `CompanyRepository` (Task 2).
- Produces:
  - `registerCompany(repo: CompanyRepository, raw: unknown): Promise<{ ok: true; id: string } | { ok: false; errors: string[] }>` — a pure, testable core that validates with Zod, rejects a duplicate email, and creates the company.
  - A thin server-action wrapper `registerAction(formData: FormData)` that calls the core with the real repository.

- [ ] **Step 1: Write the failing test**

```ts
// tests/register-action.test.ts
import { describe, it, expect } from 'vitest';
import { registerCompany } from '../app/register/actions';
import { SqliteCompanyRepository } from '../src/data/sqlite-company-repository';

describe('registerCompany', () => {
  it('creates a company from valid input', async () => {
    const repo = new SqliteCompanyRepository(':memory:');
    const res = await registerCompany(repo, {
      name: 'Acme', contactEmail: 'a@x.com', contactName: 'A', phone: '+7 700 111 2222',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.id).toBeTruthy();
  });

  it('rejects invalid input with errors', async () => {
    const repo = new SqliteCompanyRepository(':memory:');
    const res = await registerCompany(repo, { name: '', contactEmail: 'not-an-email', contactName: '', phone: '' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.length).toBeGreaterThan(0);
  });

  it('rejects a duplicate email', async () => {
    const repo = new SqliteCompanyRepository(':memory:');
    const input = { name: 'Acme', contactEmail: 'dup@x.com', contactName: 'A', phone: '123' };
    await registerCompany(repo, input);
    const res = await registerCompany(repo, input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(' ')).toMatch(/already registered/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- register-action`
Expected: FAIL — cannot find `registerCompany`.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/register/actions.ts
'use server';

import { registrationSchema } from '../../src/domain/company';
import type { CompanyRepository } from '../../src/data/company-repository';
import { getCompanyRepository } from '../../src/data/repository';

export async function registerCompany(
  repo: CompanyRepository,
  raw: unknown,
): Promise<{ ok: true; id: string } | { ok: false; errors: string[] }> {
  const parsed = registrationSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => i.message) };
  }
  const existing = await repo.getByEmail(parsed.data.contactEmail);
  if (existing) {
    return { ok: false, errors: ['This email is already registered'] };
  }
  const company = await repo.create(parsed.data);
  return { ok: true, id: company.id };
}

// Thin server-action wrapper used by the form; uses the real repository.
export async function registerAction(formData: FormData) {
  const raw = {
    name: formData.get('name'),
    contactEmail: formData.get('contactEmail'),
    contactName: formData.get('contactName'),
    phone: formData.get('phone'),
  };
  return registerCompany(getCompanyRepository(), raw);
}
```

```tsx
// app/register/page.tsx
import { registerAction } from './actions';

export default function RegisterPage() {
  return (
    <main style={{ maxWidth: 420, margin: '2rem auto', fontFamily: 'sans-serif' }}>
      <h1>Регистрация компании / Company registration</h1>
      <form action={registerAction} style={{ display: 'grid', gap: '0.75rem' }}>
        <input name="name" placeholder="Company name" required />
        <input name="contactName" placeholder="Contact name" required />
        <input name="contactEmail" type="email" placeholder="Email" required />
        <input name="phone" placeholder="Phone" required />
        <button type="submit">Register</button>
      </form>
      <p style={{ color: '#666', marginTop: '1rem' }}>
        After registering, Kazzhol staff will approve your company and attach your contract rates.
      </p>
    </main>
  );
}
```

Modify `app/page.tsx` to add a link (keep whatever the scaffold generated, add):
```tsx
import Link from 'next/link';
// inside the returned JSX:
<Link href="/register">For groups — register your company →</Link>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (smoke + repository + register-action). Also `npm run build` succeeds.

- [ ] **Step 5: Commit**

```bash
git add app tests && git commit -q -m "feat: company registration action + form page"
```

---

## Self-Review

**Spec coverage:** Implements the first item of the spec's build order (§11.1) — company registration — and the foundational data layer + swap point for Exely/Supabase. Staff approval, login, and the stub dashboard are explicitly deferred to follow-up plans (each its own working slice), matching the spec's incremental build order.

**Placeholder scan:** No "TBD"/"add validation"/"handle errors" — validation is concrete (Zod schema), the duplicate-email path is explicit, every code and test step is complete. The one adaptive note (offline fallback for the scaffolder) is a real environment contingency, not a code placeholder.

**Type consistency:** `RegistrationInput`/`Company`/`CompanyStatus` defined in Task 2 are used unchanged in Task 3. `CompanyRepository` methods (`create`, `getByEmail`, `list`) match between the interface, the SQLite impl, and the action. `registerCompany(repo, raw)` signature matches its tests.

## Follow-up plans (not in scope here)
1. **Staff approval + attach rate profile** — a staff screen to approve `pending` companies and set their rate mapping.
2. **Company auth** — login/session for approved companies (this is where Supabase Auth likely comes in).
3. **Personalized dashboard + stubbed rates** — logged-in company sees its (stub) rates; later wired to Exely.
4. **Supabase repository** — implement `SupabaseCompanyRepository` and flip the factory.
