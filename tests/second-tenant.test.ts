/**
 * Proof that the product is universal, not Kazzhol-only: a fully non-Kazzhol tenant (different
 * persona, currency, brand, roster, and a manual/no-PMS hotel) drives the system prompt, the tool
 * roster and the price scrubber with ITS OWN values — no Kazzhol string leaks through. This is the
 * end-to-end validation of the whole tenant model.
 */
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../src/ai/systemPrompt';
import { guardInventedPrices } from '../src/style/prices';
import { bookablePropertyKeys, type TenantConfig } from '../src/tenant';

const demo: TenantConfig = {
  id: 'demostay',
  brand: { displayName: 'DemoStay', website: 'demostay.com' },
  persona: { name: 'Aida', nameByLang: { en: 'Aida', zh: 'Aida' }, gender: 'female' },
  currency: { code: 'USD', symbol: '$', scrubPattern: '\\$|USD\\b' },
  languages: ['ru', 'en'],
  properties: [
    { key: 'grand', name: 'DemoStay Grand', city: 'dubai', bookable: true, knowledge: 'A demo hotel.' },
    { key: 'annex', name: 'DemoStay Annex', city: 'dubai', bookable: false, knowledge: 'Not open yet.' },
  ],
};

describe('a second tenant works with none of Kazzhol’s values (product is universal)', () => {
  it('system prompt uses the demo persona / currency / brand, not Kazzhol', () => {
    const prompt = buildSystemPrompt(
      { key: 'grand', name: 'DemoStay Grand', knowledge: 'A demo hotel.', bookable: true },
      { tenant: demo },
    );
    // Demo values present:
    expect(prompt).toContain('YOU ARE AIDA');
    expect(prompt).toContain('Меня зовут Aida');
    expect(prompt).toContain('I am Aida');
    expect(prompt).toContain('25 000 $'); // currency symbol swapped in the price example
    expect(prompt).toContain('demostay.com'); // brand website swapped
    // No Kazzhol values leak through:
    expect(prompt).not.toContain('София');
    expect(prompt).not.toContain('₸');
    expect(prompt).not.toContain('kazzhol.com');
  });

  it('bookable roster (the tool enum source) comes from the demo tenant — excludes the closed hotel', () => {
    expect(bookablePropertyKeys(demo)).toEqual(['grand']);
  });

  it('price scrubber uses the demo currency ($/USD), catching an invented dollar price', () => {
    const r = guardInventedPrices('The room is 500 $ per night.', '', false, demo.currency.scrubPattern);
    expect(r.invented).toContain('500');
    expect(r.reply).not.toContain('500 $');
  });
});
