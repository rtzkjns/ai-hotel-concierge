import { describe, it, expect, vi } from 'vitest';
import { ExelyHttp } from '../src/integrations/exely/http';
import { LiveAvailabilityProvider } from '../src/integrations/exely/live';
import { createAvailabilityProvider } from '../src/integrations/exely';
import { StubAvailabilityProvider } from '../src/integrations/exely/stub';

const TOKEN = 'SECRET-BEARER-TOKEN';
const tokens = { getToken: async () => TOKEN };
const cfg = { baseUrl: 'https://connect.hopenapi.com' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Two roomStays for a 3-night stay (2026-08-10 → 2026-08-13).
const searchBody = {
  roomStays: [
    {
      roomType: { id: '42', name: 'Comfort Double', placements: [{ code: 'DBL' }] },
      ratePlan: { id: '7', name: 'Best Available Rate' },
      total: { priceBeforeTax: 100000, taxAmount: 20000 },
      currencyCode: 'KZT',
      availability: 3,
      checksum: 'chk-comfort',
      bookingFormLink: 'https://book.example/comfort',
    },
    {
      roomType: { id: '41', name: 'Standard Twin' },
      ratePlan: { id: '7', name: 'Best Available Rate' },
      total: { priceBeforeTax: 80000, taxAmount: 10000 },
      currencyCode: 'KZT',
      availability: 5,
      checksum: 'chk-standard',
      bookingFormLink: 'https://book.example/standard',
      placements: [{ code: 'TWN' }],
    },
  ],
  warnings: [],
};

const resolver = (key: string): string | undefined => (key === 'almaty' ? '801' : undefined);

const query = {
  property: 'almaty',
  checkIn: '2026-08-10',
  checkOut: '2026-08-13',
  guests: 2,
};

describe('LiveAvailabilityProvider', () => {
  it('normalizes roomStays into offers sorted by total price', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(searchBody));
    const http = new ExelyHttp(cfg, tokens, fetchFn as unknown as typeof fetch);
    const provider = new LiveAvailabilityProvider(http, resolver);

    const result = await provider.checkAvailability(query);

    expect(result.source).toBe('exely');
    expect(result.offers).toHaveLength(2);

    // Sorted ascending by totalPrice: Standard (90000) before Comfort (120000).
    const [standard, comfort] = result.offers;
    expect(standard.roomType).toBe('Standard Twin');
    expect(standard.totalPrice).toBe(90000);
    expect(standard.pricePerNight).toBe(30000); // 90000 / 3 nights
    expect(standard.placements).toEqual(['TWN']);
    expect(comfort.roomType).toBe('Comfort Double');
    expect(comfort.roomTypeId).toBe('42');
    expect(comfort.ratePlanId).toBe('7');
    expect(comfort.ratePlanName).toBe('Best Available Rate');
    expect(comfort.totalPrice).toBe(120000);
    expect(comfort.pricePerNight).toBe(40000); // 120000 / 3 nights
    expect(comfort.currency).toBe('KZT');
    expect(comfort.checksum).toBe('chk-comfort');
    expect(comfort.placements).toEqual(['DBL']);
    expect(comfort.bookingFormLink).toBe('https://book.example/comfort');
    expect(comfort.available).toBe(true);

    // Request shape: bearer auth, correct endpoint and body.
    const [url, init] = (fetchFn.mock.calls as unknown as Array<[string, RequestInit]>)[0];
    expect(url).toBe('https://connect.hopenapi.com/api/search/v1/properties/room-stays/search');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init.body))).toEqual({
      propertyIds: ['801'],
      adults: 2,
      childAges: [],
      arrivalDate: '2026-08-10',
      departureDate: '2026-08-13',
      // Без include Exely отдаёт только id, и гостю называют номер «2 взрослых на основных местах».
      include: 'roomTypeShortContent|ratePlanShortContent',
    });
  });

  it('treats empty roomStays as normal no-availability, not an error', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ roomStays: [] }));
    const http = new ExelyHttp(cfg, tokens, fetchFn as unknown as typeof fetch);
    const provider = new LiveAvailabilityProvider(http, resolver);

    const result = await provider.checkAvailability(query);
    expect(result.offers).toEqual([]);
    expect(result.source).toBe('exely');
    expect(result.unavailableReason).toBeUndefined();
  });

  it('filters by roomType name substring, case-insensitive', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(searchBody));
    const http = new ExelyHttp(cfg, tokens, fetchFn as unknown as typeof fetch);
    const provider = new LiveAvailabilityProvider(http, resolver);

    const result = await provider.checkAvailability({ ...query, roomType: 'standard' });
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0].roomType).toBe('Standard Twin');
  });

  it('throws on non-2xx with method, path and status but never the token', async () => {
    const fetchFn = vi.fn(async () => new Response('boom'.repeat(200), { status: 500 }));
    const http = new ExelyHttp(cfg, tokens, fetchFn as unknown as typeof fetch);
    const provider = new LiveAvailabilityProvider(http, resolver);

    await expect(provider.checkAvailability(query)).rejects.toThrow(/500/);
    const err = await provider.checkAvailability(query).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('POST');
    expect(message).toContain('/api/search/v1/properties/room-stays/search');
    expect(message).not.toContain(TOKEN);
    // Response body truncated to 300 chars.
    expect(message.length).toBeLessThan(500);
  });

  it('reports property_not_wired when the property has no exelyPropertyId', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(searchBody));
    const http = new ExelyHttp(cfg, tokens, fetchFn as unknown as typeof fetch);
    const provider = new LiveAvailabilityProvider(http, resolver);

    const result = await provider.checkAvailability({ ...query, property: 'astana' });
    expect(result.offers).toEqual([]);
    expect(result.source).toBe('exely');
    expect(result.unavailableReason).toBe('property_not_wired');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('createAvailabilityProvider (live wiring)', () => {
  const base = {
    authUrl: 'https://connect.hopenapi.com/auth/token',
    baseUrl: 'https://connect.hopenapi.com',
  };

  it('returns the live provider when credentials are configured', () => {
    const provider = createAvailabilityProvider(
      { ...base, clientId: 'id', clientSecret: 'secret' },
      resolver,
    );
    expect(provider).toBeInstanceOf(LiveAvailabilityProvider);
  });

  it('returns the stub without credentials', () => {
    const provider = createAvailabilityProvider(base, resolver);
    expect(provider).toBeInstanceOf(StubAvailabilityProvider);
  });
});
