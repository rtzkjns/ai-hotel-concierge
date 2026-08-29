/**
 * GOLDEN LOCK for the tenant-model refactor.
 *
 * These snapshots capture the EXACT assembled system prompt for every Kazzhol property,
 * plus the price-scrubber behaviour, as produced by the code BEFORE persona/currency/brand
 * were lifted into a TenantConfig. The refactor must reproduce these bytes identically for
 * the Kazzhol tenant — that is the guarantee that we did not change the live bot's brain.
 *
 * If a snapshot here changes, either the refactor altered Kazzhol behaviour (a regression to
 * fix) or the change is intentional and the snapshot must be updated deliberately.
 */
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../src/ai/systemPrompt';
import { guardInventedPrices } from '../src/style/prices';
import { propertyList } from '../src/knowledge';
import { bookablePropertyKeys, kazzholTenant } from '../src/tenant';
import { toolDefinitions } from '../src/ai/tools';

// Rebuild the sister-hotel set exactly the way HotelEngine.buildPrompts() does, so the golden
// prompt is the real production prompt (minus live Exely sync + styleGuide, which are env-driven).
function sisters(selfKey: string) {
  return propertyList
    .filter((s) => s.key !== selfKey)
    .map((s) => ({ key: s.key, name: s.name, knowledge: s.knowledge, bookable: s.bookable }));
}

describe('tenant golden — Kazzhol system prompt is byte-identical through the refactor', () => {
  for (const p of propertyList) {
    it(`prompt for ${p.key}`, () => {
      const prompt = buildSystemPrompt(
        { key: p.key, name: p.name, knowledge: p.knowledge, bookable: p.bookable },
        { sisterHotels: sisters(p.key) },
      );
      expect(prompt).toMatchSnapshot();
    });
  }

  it('persona name «София» appears in every language greeting', () => {
    const prompt = buildSystemPrompt(
      { key: 'almaty', name: 'Hotel Kazzhol Almaty', knowledge: 'X', bookable: true },
      {},
    );
    expect(prompt).toContain('Меня зовут София');
    expect(prompt).toContain('Менің атым София');
    expect(prompt).toContain('I am Sofia');
    expect(prompt).toContain('我是索菲娅');
    expect(prompt).toContain('YOU ARE СОФИЯ');
  });

  it('currency symbol ₸ is used in the in-prompt price examples', () => {
    const prompt = buildSystemPrompt(
      { key: 'almaty', name: 'Hotel Kazzhol Almaty', knowledge: 'X', bookable: true },
      {},
    );
    expect(prompt).toContain('25 000 ₸');
    expect(prompt).toContain('55 250 ₸');
  });

  it('brand website kazzhol.com is used in the dead-end fallback', () => {
    const prompt = buildSystemPrompt(
      { key: 'almaty', name: 'Hotel Kazzhol Almaty', knowledge: 'X', bookable: true },
      {},
    );
    expect(prompt).toContain('kazzhol.com');
  });
});

describe('tenant golden — tool property enum is tenant-derived, unchanged for Kazzhol', () => {
  it('bookable keys are exactly astana/almaty/park_almaty (seven excluded), in roster order', () => {
    expect(bookablePropertyKeys(kazzholTenant)).toEqual(['astana', 'almaty', 'park_almaty']);
  });

  it('check_availability tool exposes that exact enum', () => {
    const tool = toolDefinitions.find((d) => d.name === 'check_availability');
    const enumVals = (tool?.input_schema as { properties?: { property?: { enum?: string[] } } })
      ?.properties?.property?.enum;
    expect(enumVals).toEqual(['astana', 'almaty', 'park_almaty']);
  });
});

describe('tenant golden — price scrubber recognises KZT tokens exactly as today', () => {
  const knowledge = 'Разовое посещение — 7 500 ₸ взрослый.';

  it('drops an invented ₸ price the knowledge does not contain', () => {
    const r = guardInventedPrices('Трансфер стоит 14 000 ₸.', knowledge, false);
    expect(r.invented).toContain('14000');
    expect(r.reply).not.toContain('14 000');
  });

  it('keeps a ₸ price that IS in the knowledge', () => {
    const r = guardInventedPrices('Взрослый билет 7 500 ₸.', knowledge, false);
    expect(r.invented).toHaveLength(0);
    expect(r.reply).toContain('7 500 ₸');
  });

  it('never scrubs when live data was used this turn', () => {
    const r = guardInventedPrices('Standard 99 999 ₸.', knowledge, true);
    expect(r.invented).toHaveLength(0);
    expect(r.reply).toContain('99 999 ₸');
  });

  // B2B hardening: a room price that only COINCIDES with a fitness figure in the KB must still be
  // caught — room prices are never static, they come only from live Exely.
  const fitnessKb = 'Фитнес: абонемент 8 посещений — 25 000 ₸ взрослый.\nPRICES: never state a room price.';

  it('drops a room price that only coincides with a fitness figure in the KB (the closed hole)', () => {
    const r = guardInventedPrices('Стандартный номер стоит 25 000 ₸ за ночь.', fitnessKb, false);
    expect(r.invented).toContain('25000');
    expect(r.reply).not.toContain('25 000');
  });

  it('keeps that same figure when quoted as the fitness price it actually is', () => {
    const r = guardInventedPrices('Абонемент на 8 посещений — 25 000 ₸.', fitnessKb, false);
    expect(r.invented).toHaveLength(0);
    expect(r.reply).toContain('25 000 ₸');
  });

  it('a room price the KB DOES list statically survives (tenant with static room rates)', () => {
    const staticKb = 'Номер «Стандарт» — 30 000 ₸ за ночь.';
    const r = guardInventedPrices('Стандарт стоит 30 000 ₸ за ночь.', staticKb, false);
    expect(r.invented).toHaveLength(0);
    expect(r.reply).toContain('30 000 ₸');
  });

  it('recognises ₸ and KZT tokens exactly as the current MONEY_RE does', () => {
    // NB: the live regex uses ASCII \b, so «тг»/«тенге» before a period/space do NOT match —
    // only ₸ and KZT (word-boundary) reliably scrub. The refactor must preserve this quirk.
    expect(guardInventedPrices('Трансфер 14 000 ₸.', '', false).invented).toContain('14000');
    expect(guardInventedPrices('Цена 2 000 KZT.', '', false).invented).toContain('2000');
    // Cyrillic token before punctuation: no match today — preserved as-is.
    expect(guardInventedPrices('Цена 3 800 тенге.', '', false).invented).toHaveLength(0);
  });
});
