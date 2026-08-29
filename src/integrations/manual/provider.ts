import type { AvailabilityProvider } from '../exely/provider';
import type { AvailabilityQuery, AvailabilityResult } from '../exely/types';

/**
 * A hotel with NO availability API — the PMS-agnostic baseline that lets ANY hotel onboard.
 *
 * The bot still does everything that doesn't need a PMS (answers from knowledge, captures leads,
 * hands off to staff, runs the B2B flows). It just never quotes a live price or claims a room is
 * free: `checkAvailability` returns no offers with source 'manual', which the engine treats exactly
 * like the stub safety guard — record a lead, alert staff, tell the guest the team will confirm.
 *
 * This is the honest counterpart to the Exely adapter: live availability is an optional enhancement,
 * not a gate on onboarding.
 */
export class ManualProvider implements AvailabilityProvider {
  async checkAvailability(query: AvailabilityQuery): Promise<AvailabilityResult> {
    return {
      property: query.property,
      checkIn: query.checkIn,
      checkOut: query.checkOut,
      offers: [],
      source: 'manual',
    };
  }
}
