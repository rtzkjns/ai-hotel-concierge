export * from './types';
export { kazzholTenant } from './kazzhol';

import type { TenantConfig } from './types';
import { kazzholTenant } from './kazzhol';

/**
 * The tenant this instance serves. Today the product runs one instance per tenant, so this is a
 * single record; a config/DB-backed loader replaces this constant when we pool tenants.
 */
export const activeTenant: TenantConfig = kazzholTenant;
