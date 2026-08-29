import type { TenantConfig } from './types';
import { propertyList } from '../knowledge';

/**
 * The Kazzhol tenant — the product's first customer. Every value here is exactly what used to be
 * hardcoded in systemPrompt.ts and prices.ts, so routing Kazzhol through the tenant model produces
 * a byte-identical system prompt and an identical price scrubber (locked by tests/tenant-golden).
 */
export const kazzholTenant: TenantConfig = {
  id: 'kazzhol',
  brand: {
    displayName: 'Kazzhol',
    website: 'kazzhol.com',
  },
  persona: {
    name: 'София',
    nameByLang: { en: 'Sofia', zh: '索菲娅' },
    gender: 'female',
  },
  currency: {
    code: 'KZT',
    symbol: '₸',
    // Mirrors the original MONEY_RE alternation exactly, ASCII \b quirks included.
    scrubPattern: '₸|тг\\b|тенге\\b|KZT\\b',
  },
  languages: ['ru', 'kk', 'en', 'zh'],
  // The roster is projected from the Kazzhol knowledge base (single source of property truth),
  // minus the large knowledge blobs — those stay in src/knowledge keyed by property.
  properties: propertyList.map((p) => ({
    key: p.key,
    name: p.name,
    city: p.city,
    bookable: p.bookable,
  })),
};
