/**
 * A TENANT is one hotel brand/chain that this product serves. Kazzhol is the first tenant; the
 * whole point of the tenant model is that a second hotel is a config record, not a code fork.
 *
 * This file holds the Increment-1 slice: the values that used to be baked into the system prompt
 * and the price scrubber — persona, currency, brand, languages. The property roster and PMS
 * bindings are added in later increments.
 */

export type LangCode = 'ru' | 'kk' | 'en' | 'zh';

export interface TenantPersona {
  /** Default (Russian/Kazakh) name form the assistant answers to, e.g. «София». */
  name: string;
  /** Per-language name forms where they differ from the default, e.g. { en: 'Sofia', zh: '索菲娅' }. */
  nameByLang?: Partial<Record<LangCode, string>>;
  /**
   * Grammatical gender of the persona name. Drives the Russian "no gendered first-person
   * past-tense" rule — a female name must avoid «передала/поняла/рада».
   */
  gender: 'female' | 'male' | 'neutral';
}

export interface TenantCurrency {
  /** ISO-style code, e.g. 'KZT'. */
  code: string;
  /** Guest-facing symbol used in example prices, e.g. '₸'. */
  symbol: string;
  /**
   * Regex alternation for the invented-price scrubber, e.g. '₸|тг\\b|тенге\\b|KZT\\b'.
   * Kept as an explicit fragment (not a token list) so a tenant reproduces the exact scrubber
   * semantics, including word-boundary behaviour, byte-for-byte.
   */
  scrubPattern: string;
}

export interface TenantBrand {
  /** Chain name as guests know it, e.g. 'Kazzhol'. */
  displayName: string;
  /** Guest-facing website (no scheme), e.g. 'kazzhol.com'. */
  website: string;
}

import type { Property } from '../knowledge';

/**
 * A hotel in a tenant's roster. This IS the knowledge-base Property shape (key/name/city/
 * bookable/knowledge/…), reused so the roster carries everything the engine needs — the tenant is
 * the single source of its hotels, not a hardcoded module.
 */
export type TenantProperty = Property;

export interface TenantConfig {
  /** Stable slug, unique across tenants, e.g. 'kazzhol'. */
  id: string;
  brand: TenantBrand;
  persona: TenantPersona;
  currency: TenantCurrency;
  /** Languages the assistant detects and replies in; first is the fallback when ambiguous. */
  languages: LangCode[];
  /** The hotels this tenant runs — the roster that drives prompts, the tool enum and the selector. */
  properties: TenantProperty[];
  /**
   * Locale rule bundle: which region's guest-handling rules (code-switching / slang comprehension and
   * business-document vocabulary) the prompt emits. 'kz-cis' = Kazakh суржик + CIS docs (ЭСФ/БИН/Kaspi).
   * null/absent → a tenant outside a supported region gets none of it.
   */
  regionPack?: 'kz-cis' | null;
}

/** Property keys the assistant may act on (quote/book) — bookable ones, in roster order. */
export function bookablePropertyKeys(tenant: TenantConfig): string[] {
  return tenant.properties.filter((p) => p.bookable !== false).map((p) => p.key);
}

/** The persona name in a given language, falling back to the default form. */
export function personaName(persona: TenantPersona, lang: LangCode): string {
  return persona.nameByLang?.[lang] ?? persona.name;
}
