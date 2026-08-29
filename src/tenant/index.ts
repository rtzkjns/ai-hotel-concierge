export * from './types';
export { kazzholTenant } from './kazzhol';

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TenantConfig } from './types';
import type { Property } from '../knowledge';
import { kazzholTenant } from './kazzhol';

/** Every tenant this codebase can serve. A new hotel brand is registered here (later: DB-backed). */
export const tenants: Record<string, TenantConfig> = {
  kazzhol: kazzholTenant,
};

/**
 * The tenant this instance serves — selected by the TENANT env var (default 'kazzhol'). The product
 * runs one instance per tenant, so this resolves once at boot; a DB-backed loader replaces it when
 * we pool tenants. An unknown TENANT falls back to Kazzhol rather than crashing the process.
 */
/**
 * Fail fast on a misconfigured tenant at boot, rather than silently shipping a broken bot: the
 * currency scrubPattern must compile AND recognise the tenant's own symbol, else the invented-price
 * guard would do nothing for real prices (or a malformed pattern would throw on every turn).
 */
export function assertValidTenant(t: TenantConfig): void {
  // scrubPattern runs per guest message; bound it so an ops-authored tenant file can't ship a
  // catastrophic-backtracking (ReDoS) regex that stalls the bot. Currency alternations are short.
  if (t.currency.scrubPattern.length > 120) {
    throw new Error(`Tenant "${t.id}": currency.scrubPattern too long (max 120 chars)`);
  }
  let re: RegExp;
  try {
    re = new RegExp(t.currency.scrubPattern);
  } catch (e) {
    throw new Error(`Tenant "${t.id}": invalid currency.scrubPattern — ${(e as Error).message}`);
  }
  if (!re.test(t.currency.symbol)) {
    throw new Error(
      `Tenant "${t.id}": currency.scrubPattern does not match its own symbol "${t.currency.symbol}" — ` +
        'the invented-price guard would be silently disabled.',
    );
  }
}

/** A JSON tenant file isn't compile-checked like a TS literal, so validate its shape at load. */
function validateTenantShape(t: unknown, src: string): asserts t is TenantConfig {
  const bad = (m: string): never => {
    throw new Error(`Tenant file ${src}: ${m}`);
  };
  const o = t as Record<string, unknown>;
  if (!o || typeof o !== 'object') bad('not a JSON object');
  if (typeof o.id !== 'string' || !o.id) bad('missing "id"');
  const brand = o.brand as Record<string, unknown> | undefined;
  if (!brand || typeof brand.displayName !== 'string' || typeof brand.website !== 'string')
    bad('bad "brand" (need displayName, website)');
  const persona = o.persona as Record<string, unknown> | undefined;
  if (
    !persona ||
    typeof persona.name !== 'string' ||
    !['female', 'male', 'neutral'].includes(persona.gender as string)
  )
    bad('bad "persona" (need name, gender)');
  const currency = o.currency as Record<string, unknown> | undefined;
  if (
    !currency ||
    typeof currency.code !== 'string' ||
    typeof currency.symbol !== 'string' ||
    typeof currency.scrubPattern !== 'string'
  )
    bad('bad "currency" (need code, symbol, scrubPattern)');
  if (!Array.isArray(o.languages) || o.languages.length === 0) bad('bad "languages"');
  if (!Array.isArray(o.properties) || o.properties.length === 0)
    bad('"properties" must be a non-empty array');
  for (const p of o.properties as Array<Record<string, unknown>>) {
    if (typeof p?.key !== 'string' || typeof p?.name !== 'string' || typeof p?.knowledge !== 'string')
      bad('every property needs string key, name, knowledge');
  }
}

/**
 * Load every tenants/<id>.json in a directory into TenantConfig objects. Pure (no global mutation).
 * JSON, not JS: it must finish SYNCHRONOUSLY before activeTenant resolves below (dynamic import()
 * is async and would be too late), and a tenant file is ops data, not code — JSON stays inert.
 */
export function loadTenantsFromDir(dir: string): TenantConfig[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return []; // no dir → Kazzhol-only, unchanged
  }
  return files.sort().map((f) => {
    const parsed = JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown;
    validateTenantShape(parsed, f);
    return parsed;
  });
}

// Register file-defined tenants at boot, BEFORE activeTenant resolves. Kazzhol is code-defined and
// can NEVER be overridden by a file (collision guard) — it stays the byte-identical golden tenant.
for (const t of loadTenantsFromDir(process.env.TENANTS_DIR ?? './tenants')) {
  if (t.id === 'kazzhol' || tenants[t.id]) {
    throw new Error(`Tenant "${t.id}" collides with a built-in or already-loaded tenant`);
  }
  assertValidTenant(t);
  tenants[t.id] = t;
}

export const activeTenant: TenantConfig = tenants[process.env.TENANT ?? 'kazzhol'] ?? kazzholTenant;
assertValidTenant(activeTenant);

/** The active tenant's hotels, in roster order — the roster the engine and channels read. */
export const activePropertyList: Property[] = activeTenant.properties;

/** The active tenant's hotels keyed by property key, for O(1) lookup. */
export const activeProperties: Record<string, Property> = Object.fromEntries(
  activeTenant.properties.map((p) => [p.key, p]),
);
