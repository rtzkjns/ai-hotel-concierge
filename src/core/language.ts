import type { Language } from '../types';

const CJK_RE = /[㐀-䶿一-鿿]/;
const KAZAKH_RE = /[әғқңөұүіһӘҒҚҢӨҰҮІҺ]/;
const CYRILLIC_RE = /[Ѐ-ӿ]/;
const LATIN_RE = /[A-Za-z]/;

// Latinized Kazakh looks like English to a charset check, so spot common
// romanized Kazakh tokens/particles (salem, rahmet, bar/jok, -ma/-ba question
// particles, qonaq/bolme...). Two or more hits = treat the message as Kazakh.
const KK_LATIN_TOKENS =
  /\b(salem|salemetsiz|rahmet|rakhmet|zhaksy|jaksy|qonaq|konak|bolme|bosla?|bos|barma|bar\s?ma|joqpa|jok|joq|qanша|kalay|qalay|kalaysyn|ياхшы|iske|bagasy|qansha|nomer\s?bar|kerek|bolady|bolama)\b/gi;

/**
 * Heuristic language detection from a single message.
 * Kazakh-specific letters (Cyrillic or common romanized tokens) win over generic
 * Cyrillic/Latin (surzhik-friendly); very short/letterless texts are ambiguous -> null.
 */
export function detectLanguage(text: string): Language | null {
  if (CJK_RE.test(text)) return 'zh';
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 3) return null;
  if (KAZAKH_RE.test(text)) return 'kk';
  if (CYRILLIC_RE.test(text)) return 'ru';
  if (LATIN_RE.test(text)) {
    const kkHits = text.match(KK_LATIN_TOKENS)?.length ?? 0;
    return kkHits >= 2 ? 'kk' : 'en';
  }
  return null;
}
