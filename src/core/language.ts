import type { Language } from '../types';

const CJK_RE = /[㐀-䶿一-鿿]/g;
const KAZAKH_RE = /[әғқңөұүіһӘҒҚҢӨҰҮІҺ]/g;
const CYRILLIC_RE = /[Ѐ-ӿ]/g;
const LATIN_RE = /[A-Za-z]/;

/** Latinized Kazakh — looks like English to a charset check. */
const KK_LATIN_TOKENS =
  /\b(salem|salemetsiz|sálemetsiz|rahmet|rakhmet|zhaksy|jaksy|qonaq|konak|bolme|bos|barma|bar\s?ma|joqpa|jok|joq|kalay|qalay|kalaysyn|iske|bagasy|qansha|kansha|kerek|bolady|bolama|nomer\s?bar|tun|kun)\b/gi;

/**
 * Kazakh written on a RUSSIAN keyboard (no ә/ө/қ/ң/ұ/ү/і/һ). Deliberately broad: real guests
 * type this way constantly, and every miss means a Kazakh speaker gets Russian back.
 * NB: JS `\b` does not work with Cyrillic — Unicode lookarounds are required.
 */
const KK_CYRILLIC_TOKENS =
  /(?<!\p{L})(салем\p{L}*|саламатсыз\p{L}*|ассалаумагалейкум|ассалаумағалейкум|рахмет\p{L}*|жаксы\p{L}*|жарайды|болады|болама|бар\s?ма|бар\s?па|жок\p{L}*|жоқ\p{L}*|канша|қанша|калай|калайсыз|болме|бөлме|конак|қонақ|багасы|бағасы|керек|кайырлы|қайырлы|турады|тұрады|орын|бос|тун|түн|кун|күн|адам|тусиндим|түсіндім|жасайын|деп\s?едим|деп\s?едім|сендерде|сиздерде|сіздерде|бар|ия|иә|кеш\s?жарык|кеш\s?жарық)(?!\p{L})/giu;

/** Latinized Chinese (pinyin) — otherwise indistinguishable from English by charset. */
const ZH_PINYIN_TOKENS =
  /\b(ni\s?hao|nin\s?hao|nǐ\s?hǎo|xie\s?xie|xiexie|xièxie|duoshao|duōshǎo|qian|fangjian|fángjiān|ding\s?fang|yao\s?ding|meiyou|mei\s?you|kong\s?fang|wo\s?xiang|wǒ\s?xiǎng|wo\s?shi|zaijian|zài\s?jiàn|yi\s?wan|wan\s?shang|jintian|mingtian|keyi|kěyǐ|duo\s?shao)\b/gi;

/** Latinized Russian (translit) — a real pattern from guests without a Cyrillic keyboard. */
const RU_LATIN_TOKENS =
  /\b(zdravstvuyte|zdravstvuite|privet|nomer|nujen|nuzhen|nomera|spasibo|pozhaluysta|pozhalusta|skolko|stoit|bronirovat|bron|zavtrak|nochi|noch|dvoih|dvoikh|est|svobodn\w*)\b/gi;

/**
 * A Latin-script message is only real English if it carries English function words. Otherwise it
 * is a name, a city, an e-mail or a phone number typed inside another-language dialogue.
 */
const EN_MARKERS =
  /\b(the|is|are|am|do|does|did|can|could|would|will|have|has|i|you|we|my|your|hello|hi|hey|please|thanks|thank|room|rooms|reserve|price|prices|cost|available|availability|night|nights|check\s?in|check\s?out|breakfast|need|want|how|what|when|where)\b/gi;

function countMatches(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0;
}

/** URLs carry English words («booking.com») that say nothing about the guest's language. */
function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+|www\.\S+|\S+\.(?:com|kz|ru|net|org|io)\S*/gi, ' ');
}

/**
 * Proper names must not decide the language («На имя Қапсих Ғалымгерей» is Russian). Mid-sentence
 * capitalised tokens are dropped — BUT NOT when the guest is shouting: in «БОС БӨЛМЕ БАР МА?»
 * every token is capitalised, and stripping them all erased the whole Kazakh message.
 */
function stripProperNames(text: string): string {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return text;
  // Only TRUE shouting disables the filter: a message with no lowercase letters at all. A normal
  // sentence with two capitalised names («На имя Қапсих Ғалымгерей») must still be filtered.
  const hasLowercase = /\p{Ll}/u.test(text);
  if (!hasLowercase) return text;
  const kept = tokens.filter((t, i) => i === 0 || !/^[А-ЯЁӘҒҚҢӨҰҮІҺ]/.test(t));
  const joined = kept.join(' ');
  return joined.trim().length > 0 ? joined : text;
}

/**
 * Heuristic language detection over the four contract languages.
 *
 * `previous` is the language already established for the conversation and is used whenever the
 * current message is weak evidence — a one-word answer, a name, a phone number. Getting this
 * wrong means the hotel answers a Kazakh guest in Russian, which the contract forbids.
 */
export function detectLanguage(text: string, previous?: Language | null): Language | null {
  const body = stripUrls(text);
  const letters = body.match(/\p{L}/gu) ?? [];

  // CJK by DENSITY, not by first hit: a Chinese guest name inside an English sentence
  // («my name is 张伟») must not turn the whole reply Chinese.
  const cjkHits = countMatches(body, CJK_RE);
  if (cjkHits > 0) {
    const latinLetters = countMatches(body, /[A-Za-z]/g);
    if (cjkHits >= 2 && cjkHits >= latinLetters * 0.2) return 'zh';
    if (latinLetters === 0) return 'zh';
    if (previous) return previous;
    return cjkHits >= 2 ? 'zh' : 'en';
  }

  if (letters.length < 3) return null;

  const measured = stripProperNames(body);
  const kazakhHits = countMatches(measured, KAZAKH_RE);
  const kkWordHits = countMatches(measured, KK_CYRILLIC_TOKENS);
  const cyrillicLetters = countMatches(body, CYRILLIC_RE);
  const latinLetters = countMatches(body, /[A-Za-z]/g);

  if (cyrillicLetters > 0 && cyrillicLetters >= latinLetters) {
    if (kazakhHits >= 2) return 'kk';
    if (kazakhHits >= 1 && kkWordHits >= 1) return 'kk';
    if (kkWordHits >= 2) return 'kk';
    // A single Kazakh marker decides when the conversation is already Kazakh, or when the whole
    // message is that marker («Рахмет», «Жарайды», «Бар ма?»).
    const cyrWords = (measured.match(/\p{L}+/gu) ?? []).length;
    if (kkWordHits >= 1 && (previous === 'kk' || cyrWords <= 3)) return 'kk';
    if (kazakhHits >= 1 && previous === 'kk') return 'kk';
    const density = cyrillicLetters > 0 ? kazakhHits / cyrillicLetters : 0;
    if (density >= 0.08) return 'kk';
    // Cyrillic quoted inside an otherwise English dialogue (a pasted confirmation e-mail).
    if (previous === 'en' && latinLetters > cyrillicLetters * 0.5) return 'en';
    return 'ru';
  }

  if (LATIN_RE.test(body)) {
    if (countMatches(body, KK_LATIN_TOKENS) >= 2) return 'kk';
    if (countMatches(body, ZH_PINYIN_TOKENS) >= 1) return 'zh';
    if (countMatches(body, RU_LATIN_TOKENS) >= 2) return 'ru';
    const enHits = countMatches(body, EN_MARKERS);
    // No English function words → a name / e-mail / city, not an English message.
    if (enHits === 0 && previous && previous !== 'en') return previous;
    // A short courtesy inside a non-English dialogue («Thanks!» in a Chinese chat) keeps the
    // conversation language: the guest is not switching, just being polite.
    if (previous && previous !== 'en' && letters.length <= 25 && enHits <= 2) return previous;
    return 'en';
  }

  return null;
}
