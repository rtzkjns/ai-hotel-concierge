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
export const activeTenant: TenantConfig = tenants[process.env.TENANT ?? 'kazzhol'] ?? kazzholTenant;

/** The active tenant's hotels, in roster order — the roster the engine and channels read. */
export const activePropertyList: Property[] = activeTenant.properties;

/** The active tenant's hotels keyed by property key, for O(1) lookup. */
export const activeProperties: Record<string, Property> = Object.fromEntries(
  activeTenant.properties.map((p) => [p.key, p]),
);
