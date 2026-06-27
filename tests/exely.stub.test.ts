import { describe, it, expect } from 'vitest';
import { StubAvailabilityProvider } from '../src/integrations/exely/stub';

describe('StubAvailabilityProvider', () => {
  it('returns deterministic offers tagged as stub source', async () => {
    const provider = new StubAvailabilityProvider();
    const result = await provider.checkAvailability({
      property: 'astana',
      checkIn: '2026-08-01',
      checkOut: '2026-08-03',
      guests: 2,
    });

    expect(result.source).toBe('stub');
    expect(result.property).toBe('astana');
    expect(result.checkIn).toBe('2026-08-01');
    expect(result.offers.length).toBeGreaterThan(0);
    for (const offer of result.offers) {
      expect(typeof offer.roomType).toBe('string');
      expect(offer.currency).toBe('KZT');
    }
    // Deterministic: same query → same prices.
    const again = await provider.checkAvailability({
      property: 'astana',
      checkIn: '2026-08-01',
      checkOut: '2026-08-03',
      guests: 2,
    });
    expect(again.offers).toEqual(result.offers);
  });

  it('filters to a requested room type when given', async () => {
    const provider = new StubAvailabilityProvider();
    const result = await provider.checkAvailability({
      property: 'almaty',
      checkIn: '2026-08-01',
      checkOut: '2026-08-02',
      guests: 1,
      roomType: 'Suite',
    });
    expect(result.offers.every((o) => o.roomType === 'Suite')).toBe(true);
  });
});
