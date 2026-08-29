import { describe, it, expect } from 'vitest';
import { ManualProvider } from '../src/integrations/manual/provider';
import { createProviders } from '../src/integrations/registry';

const query = { property: 'x', checkIn: '2026-09-01', checkOut: '2026-09-02', guests: 2 };

describe('ManualProvider — a hotel with no PMS API', () => {
  it('returns no offers and source "manual" (never a fake price)', async () => {
    const r = await new ManualProvider().checkAvailability(query);
    expect(r.source).toBe('manual');
    expect(r.offers).toEqual([]);
    expect(r.property).toBe('x');
  });
});

describe('provider registry — PMS-agnostic routing', () => {
  it('with no manual properties, behaves exactly like the Exely/stub path', async () => {
    const p = createProviders({}); // no cabinets, no manual → everything is stub
    const r = await p.availability.checkAvailability(query);
    expect(r.source).toBe('stub');
    expect(r.offers.length).toBeGreaterThan(0); // stub returns its fake catalogue
  });

  it('routes a manual property to ManualProvider, others stay on the base path', async () => {
    const p = createProviders({}, { manualProperties: ['manualhotel'] });

    const manual = await p.availability.checkAvailability({ ...query, property: 'manualhotel' });
    expect(manual.source).toBe('manual');
    expect(manual.offers).toEqual([]);

    const other = await p.availability.checkAvailability({ ...query, property: 'other' });
    expect(other.source).toBe('stub');
    expect(other.offers.length).toBeGreaterThan(0);
  });

  it('a manual property has no reservation client and booking disabled (falls to lead+link)', () => {
    const p = createProviders({}, { manualProperties: ['manualhotel'] });
    expect(p.reservationFor('manualhotel')).toBeUndefined();
    expect(p.bookingEnabledFor('manualhotel')).toBe(false);
    expect(p.propertyIdResolver('manualhotel')).toBeUndefined();
    expect(p.contentFor('manualhotel')).toBeUndefined();
  });
});
