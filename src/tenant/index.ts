export * from './types';
export { kazzholTenant } from './kazzhol';

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

export const activeTenant: TenantConfig = tenants[process.env.TENANT ?? 'kazzhol'] ?? kazzholTenant;
assertValidTenant(activeTenant);

/** The active tenant's hotels, in roster order — the roster the engine and channels read. */
export const activePropertyList: Property[] = activeTenant.properties;

/** The active tenant's hotels keyed by property key, for O(1) lookup. */
export const activeProperties: Record<string, Property> = Object.fromEntries(
  activeTenant.properties.map((p) => [p.key, p]),
);
