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
  // The roster IS the Kazzhol knowledge base (full Property objects, knowledge blobs included).
  // src/knowledge holds Kazzhol's hotel data; the tenant owns it. A second tenant supplies its own.
  properties: propertyList,
};
