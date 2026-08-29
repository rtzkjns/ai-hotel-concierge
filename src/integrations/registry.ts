// Provider registry — picks an availability provider per property, so the product works with any
// PMS or none. This is the seam that makes onboarding PMS-agnostic:
//   - Exely cabinet configured for the property  → live Exely (with the existing stub fallback).
//   - Property listed as `manual` (no PMS API)    → ManualProvider (no live prices, staff handoff).
// Adding a new source (iCal, a channel-manager hub, another PMS) means one more adapter behind the
// same AvailabilityProvider interface and one more branch here — callers never change.
import type { ExelyCabinet } from '../config';
import { createCabinetProviders, type CabinetProviders } from './exely';
import type { AvailabilityProvider } from './exely/provider';
import type { AvailabilityQuery, AvailabilityResult } from './exely/types';
import { ManualProvider } from './manual/provider';

export interface ProviderRegistryOptions {
  /** Property keys served with no PMS API — routed to ManualProvider (live availability optional). */
  manualProperties?: string[];
  fetchFn?: typeof fetch;
}

/**
 * Build the per-property provider bag. With no manual properties this is byte-for-byte the existing
 * Exely-cabinet behaviour (live-or-stub); manual properties are layered on top without touching it.
 */
export function createProviders(
  cabinets: Record<string, ExelyCabinet>,
  opts: ProviderRegistryOptions = {},
): CabinetProviders {
  const base = createCabinetProviders(cabinets, opts.fetchFn);
  const manualKeys = new Set(opts.manualProperties ?? []);
  if (manualKeys.size === 0) return base; // Kazzhol / Exely-only path: unchanged.

  const manual = new ManualProvider();
  const availability: AvailabilityProvider = {
    checkAvailability(query: AvailabilityQuery): Promise<AvailabilityResult> {
      if (manualKeys.has(query.property)) return manual.checkAvailability(query);
      return base.availability.checkAvailability(query);
    },
  };

  // A manual property has no reservation client, no live booking and no Content API to sync —
  // booking falls to the existing lead + self-service-link path, exactly like an un-wired hotel.
  return {
    ...base,
    availability,
    reservationFor: (property) => (manualKeys.has(property) ? undefined : base.reservationFor(property)),
    bookingEnabledFor: (property) => (manualKeys.has(property) ? false : base.bookingEnabledFor(property)),
    propertyIdResolver: (property) =>
      manualKeys.has(property) ? undefined : base.propertyIdResolver(property),
    contentFor: (property) => (manualKeys.has(property) ? undefined : base.contentFor(property)),
  };
}
