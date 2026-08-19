// Multi-cabinet Exely routing. Each Kazzhol hotel is a SEPARATE Exely account
// (own client_id/secret/property_id/booking flag), so availability, booking and
// cancellation must go to the cabinet that owns the hotel — not a shared client.
import type { ExelyCabinet } from '../../config';
import { ExelyHttp } from './http';
import { LiveAvailabilityProvider } from './live';
import type { AvailabilityProvider } from './provider';
import { IbeReservation } from './ibeBooking';
import { ExelyReservation, type ReservationClient } from './reservation';
import { StubAvailabilityProvider } from './stub';
import { ExelyTokenManager } from './token';
import type { AvailabilityQuery, AvailabilityResult } from './types';

export interface CabinetProviders {
  /** Availability provider that routes checkAvailability(query) by query.property. */
  availability: AvailabilityProvider;
  reservationFor: (property: string) => ReservationClient | undefined;
  bookingEnabledFor: (property: string) => boolean;
  propertyIdResolver: (property: string) => string | undefined;
  /** Pull the hotel's static catalog (Content API) — used to keep the bot's knowledge fresh.
   *  Returns undefined for a hotel with no configured cabinet. */
  contentFor: (property: string) => Promise<unknown> | undefined;
}

interface Cabinet {
  provider: LiveAvailabilityProvider;
  reservation: ReservationClient;
  bookingEnabled: boolean;
  propertyId: string;
  http: ExelyHttp;
}

/**
 * Build one live Exely client per configured hotel cabinet. A property with no
 * cabinet falls back to a shared stub provider (availability), no reservation
 * client, and booking disabled — exactly the pre-credentials behaviour.
 */
export function createCabinetProviders(
  cabinets: Record<string, ExelyCabinet>,
  fetchFn: typeof fetch = fetch,
): CabinetProviders {
  const stub = new StubAvailabilityProvider();
  const byProperty: Record<string, Cabinet> = {};

  for (const [propertyKey, cab] of Object.entries(cabinets)) {
    const tokens = new ExelyTokenManager(
      { clientId: cab.clientId, clientSecret: cab.clientSecret, authUrl: cab.authUrl },
      { fetchFn },
    );
    const http = new ExelyHttp({ baseUrl: cab.baseUrl }, tokens, fetchFn);
    // This cabinet only knows its own property id — its resolver returns it for
    // this hotel key and undefined for anything else.
    const resolver = (key: string): string | undefined =>
      key === propertyKey ? cab.propertyId : undefined;
    byProperty[propertyKey] = {
      provider: new LiveAvailabilityProvider(http, resolver),
      reservation: cab.bookingEngine
        ? new IbeReservation(cab.propertyId, { fetchImpl: fetchFn })
        : new ExelyReservation(http),
      // Движку write-scope не нужен, поэтому его включение и есть разрешение бронировать.
      bookingEnabled: cab.bookingEnabled || cab.bookingEngine,
      propertyId: cab.propertyId,
      http,
    };
  }

  const availability: AvailabilityProvider = {
    checkAvailability(query: AvailabilityQuery): Promise<AvailabilityResult> {
      const cabinet = byProperty[query.property];
      return cabinet ? cabinet.provider.checkAvailability(query) : stub.checkAvailability(query);
    },
  };

  return {
    availability,
    reservationFor: (property) => byProperty[property]?.reservation,
    bookingEnabledFor: (property) => byProperty[property]?.bookingEnabled ?? false,
    propertyIdResolver: (property) => byProperty[property]?.propertyId,
    contentFor: (property) => {
      const cabinet = byProperty[property];
      return cabinet ? cabinet.http.content(cabinet.propertyId) : undefined;
    },
  };
}
