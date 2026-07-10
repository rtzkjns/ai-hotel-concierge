import type { Language } from '../types';

const CJK_RE = /[㐀-䶿一-鿿]/;
const KAZAKH_RE = /[әғқңөұүіһӘҒҚҢӨҰҮІҺ]/;
const CYRILLIC_RE = /[Ѐ-ӿ]/;
const LATIN_RE = /[A-Za-z]/;

/**
 * Heuristic language detection from a single message.
 * Kazakh-specific letters win over generic Cyrillic (surzhik-friendly);
 * very short or letterless texts are ambiguous -> null.
 */
export function detectLanguage(text: string): Language | null {
  if (CJK_RE.test(text)) return 'zh';
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 3) return null;
  if (KAZAKH_RE.test(text)) return 'kk';
  if (CYRILLIC_RE.test(text)) return 'ru';
  if (LATIN_RE.test(text)) return 'en';
  return null;
}
