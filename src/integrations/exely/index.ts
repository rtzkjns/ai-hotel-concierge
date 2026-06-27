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
