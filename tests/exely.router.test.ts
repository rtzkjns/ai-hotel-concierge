import { describe, it, expect, vi } from 'vitest';
import { createCabinetProviders } from '../src/integrations/exely/router';
import type { ExelyCabinet } from '../src/config';

function cabinet(propertyId: string, bookingEnabled = false): ExelyCabinet {
  return {
    clientId: `id-${propertyId}`,
    clientSecret: `sec-${propertyId}`,
    propertyId,
    authUrl: 'https://auth.test/token',
    baseUrl: 'https://exely.test',
    bookingEnabled,
  };
}

// Fake fetch: token endpoint returns a token; search returns an empty roomStays
// list but records which propertyId was requested so we can assert routing.
function fakeFetch() {
  const searched: string[] = [];
  const fn = vi.fn(async (url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (u.endsWith('/token')) {
      return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    }
    // Наличие спрашивается GET-ом по конкретному отелю: id теперь в пути, а не в теле.
    const perProperty = /\/properties\/([^/]+)\/room-stays/.exec(u);
    if (perProperty) {
      searched.push(decodeURIComponent(perProperty[1]));
      return new Response(JSON.stringify({ roomStays: [] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  return { fn: fn as unknown as typeof fetch, searched };
}

describe('createCabinetProviders', () => {
  it('routes each hotel to its own cabinet propertyId', async () => {
    const { fn, searched } = fakeFetch();
    const providers = createCabinetProviders(
      { almaty: cabinet('801'), astana: cabinet('900') },
      fn,
    );
    await providers.availability.checkAvailability({
      property: 'almaty',
      checkIn: '2026-08-10',
      checkOut: '2026-08-12',
      guests: 2,
    });
    await providers.availability.checkAvailability({
      property: 'astana',
      checkIn: '2026-08-10',
      checkOut: '2026-08-12',
      guests: 2,
    });
    expect(searched).toEqual(['801', '900']);
  });

  it('falls back to stub availability for an unconfigured hotel', async () => {
    const { fn } = fakeFetch();
    const providers = createCabinetProviders({ almaty: cabinet('801') }, fn);
    const result = await providers.availability.checkAvailability({
      property: 'park_almaty',
      checkIn: '2026-08-10',
      checkOut: '2026-08-12',
      guests: 2,
    });
    expect(result.source).toBe('stub');
    expect(result.offers.length).toBeGreaterThan(0); // stub always offers rooms
  });

  it('exposes reservation client, booking flag and property id per hotel', () => {
    const { fn } = fakeFetch();
    const providers = createCabinetProviders(
      { almaty: cabinet('801', true), astana: cabinet('900', false) },
      fn,
    );
    expect(providers.reservationFor('almaty')).toBeDefined();
    expect(providers.reservationFor('park_almaty')).toBeUndefined();
    expect(providers.bookingEnabledFor('almaty')).toBe(true);
    expect(providers.bookingEnabledFor('astana')).toBe(false);
    expect(providers.bookingEnabledFor('park_almaty')).toBe(false);
    expect(providers.propertyIdResolver('astana')).toBe('900');
    expect(providers.propertyIdResolver('park_almaty')).toBeUndefined();
  });
});
