import type { AvailabilityProvider } from './provider';
import { ExelyHttp } from './http';
import { LiveAvailabilityProvider, type PropertyIdResolver } from './live';
import { StubAvailabilityProvider } from './stub';
import { ExelyTokenManager } from './token';

export interface ExelyConfig {
  clientId?: string;
  clientSecret?: string;
  authUrl: string;
  baseUrl: string;
}

export function createAvailabilityProvider(
  cfg: ExelyConfig,
  propertyIdResolver: PropertyIdResolver,
): AvailabilityProvider {
  if (cfg.clientId && cfg.clientSecret) {
    const tokens = new ExelyTokenManager({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      authUrl: cfg.authUrl,
    });
    const http = new ExelyHttp({ baseUrl: cfg.baseUrl }, tokens);
    return new LiveAvailabilityProvider(http, propertyIdResolver);
  }
  return new StubAvailabilityProvider();
}

export { createCabinetProviders, type CabinetProviders } from './router';
export type { AvailabilityProvider } from './provider';
export type { AvailabilityQuery, AvailabilityResult, RoomOffer } from './types';
export type { PropertyIdResolver } from './live';
