/**
 * Onboarding a tenant becomes DATA, not code: a tenant defined only by a JSON file loads into a
 * valid TenantConfig. Proves the file → TenantConfig path; second-tenant.test proves such a config
 * then drives the prompt/tools/scrubber with zero Kazzhol leakage.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTenantsFromDir } from '../src/tenant';
import { buildSystemPrompt } from '../src/ai/systemPrompt';

const DEMO = {
  id: 'demostay',
  brand: { displayName: 'DemoStay', website: 'demostay.com' },
  persona: { name: 'Aida', nameByLang: { en: 'Aida' }, gender: 'female' },
  currency: { code: 'USD', symbol: '$', scrubPattern: '\\$|USD\\b' },
  languages: ['ru', 'en'],
  properties: [{ key: 'grand', name: 'DemoStay Grand', city: 'dubai', bookable: true, knowledge: 'A demo hotel.' }],
};

describe('loadTenantsFromDir — a JSON file becomes a usable tenant', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tenants-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns [] when the directory does not exist (Kazzhol-only, unchanged)', () => {
    expect(loadTenantsFromDir(join(dir, 'nope'))).toEqual([]);
  });

  it('parses a valid tenant file and it drives a non-Kazzhol prompt', () => {
    writeFileSync(join(dir, 'demostay.json'), JSON.stringify(DEMO));
    const loaded = loadTenantsFromDir(dir);
    expect(loaded).toHaveLength(1);
    const t = loaded[0];
    expect(t.id).toBe('demostay');
    const p = t.properties[0];
    const prompt = buildSystemPrompt(
      { key: p.key, name: p.name, knowledge: p.knowledge, bookable: true },
      { tenant: t },
    );
    expect(prompt).toContain('YOU ARE AIDA');
    expect(prompt).toContain('demostay.com');
    expect(prompt).not.toContain('София');
    expect(prompt).not.toContain('₸');
  });

  it('rejects a malformed tenant file (missing currency) at load', () => {
    const broken = { ...DEMO, currency: undefined };
    writeFileSync(join(dir, 'broken.json'), JSON.stringify(broken));
    expect(() => loadTenantsFromDir(dir)).toThrow(/currency/);
  });

  it('rejects a property with no knowledge', () => {
    const broken = { ...DEMO, properties: [{ key: 'x', name: 'X' }] };
    writeFileSync(join(dir, 'broken2.json'), JSON.stringify(broken));
    expect(() => loadTenantsFromDir(dir)).toThrow(/knowledge/);
  });
});
