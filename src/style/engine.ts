/**
 * Style engine: turns one model reply into 1-3 messenger-sized messages with
 * human-feeling send delays. Deterministic on purpose (no Math.random) so both
 * tests and guest experience are reproducible.
 */

const MAX_PARTS = 3;
const MAX_PART_CHARS = 900;

/**
 * Emoji / pictographs the hotel voice must never send. Deliberately range-based and
 * NOT greedy: «₸» (U+20B8), «—» (U+2014) and «№» must survive untouched.
 */
const EMOJI_RE =
  /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu;

/** Text emoticons: «:)», «:-)», «=)», «:(» — always dropped. */
const EMOTICON_RE = /[:=;]-?[)(]/g;

/**
 * Canned assistant openers. Prompt-level bans are probabilistic; this is the guarantee.
 * Anchored at the start of a message part only — «конечно» mid-sentence is legitimate.
 */
/**
 * The bot has no gender, but the model keeps slipping into gendered past-tense forms («передал»,
 * «уточнила»), so the persona flips between messages. Prompt bans are probabilistic — this is the
 * guarantee. Only whole words, only first-person reports about our own action.
 */
const GENDERED_SELF: Array<[RegExp, string]> = [
  [/(?<!\p{L})[Пп]ередал[аи]?(?!\p{L})/gu, 'Передаю'],
  [/(?<!\p{L})[Уу]точнил[аи]?(?!\p{L})/gu, 'Уточняю'],
  [/(?<!\p{L})[Зз]аписал[аи]?(?!\p{L})/gu, 'Записываю'],
  [/(?<!\p{L})[Пп]роверил[аи]?(?!\p{L})/gu, 'Проверяю'],
  [/(?<!\p{L})[Пп]осмотрел[аи]?(?!\p{L})/gu, 'Смотрю'],
  [/(?<!\p{L})[Пп]онял[аи]?(?!\p{L})/gu, 'Принято'],
  [/(?<!\p{L})[Оо]формил[аи]?(?!\p{L})/gu, 'Оформляю'],
];

/** English filler that reads as chatty, not as a hotel: stripped at the start of a message. */
const EN_FILLER_RE = /^\s*(?:hmm+|umm+|oops|okay|alright|yeah|yep|nope)\b[\s,!.—–-]*/i;

const CANNED_OPENER_RE =
  /^\s*(?:конечно|разумеется|безусловно|отличный\s+(?:выбор|вопрос)|отличное\s+решение|с\s+радостью\s+(?:помогу|подскажу|отвечу)|я\s+помогу\s+вам\s+с\s+этим|рад(?:а)?\s+сообщить|благодарю\s+за\s+ваш\s+вопрос|of\s+course|certainly|great\s+question|i'?d\s+be\s+happy\s+to\s+help|sure\s+thing)\s*[!,.—–-]*\s*/i;

/**
 * Strip an unmatched closing paren used as a smiley — «нужны))», «Здравствуйте)» — while
 * keeping real parentheses «(до 24 августа)» intact. Depth-tracked, so only the parens that
 * never had an opener are removed.
 */
function stripParenSmileys(text: string): string {
  let depth = 0;
  let out = '';
  for (const ch of text) {
    if (ch === '(') {
      depth += 1;
      out += ch;
    } else if (ch === ')') {
      if (depth === 0) continue; // smiley — drop
      depth -= 1;
      out += ch;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Enforce the hotel's official register on the model's raw reply, deterministically:
 * no emoji, no emoticons, no paren-smileys, no canned assistant openers, no «!!!» showers.
 * Runs BEFORE splitting so a stripped opener cannot leave an empty first message.
 */
/**
 * Markdown в мессенджере не рендерится: гость видит буквально «**Standard Twin**».
 * За прогон утекло в 6 ответах из 45, включая экранирование «@kazzhol\\_seven».
 * Запрет в промпте вероятностный — это гарантия.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<!\S)__(.+?)__(?!\S)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-•*]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\\([_*`[\]()])/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1: $2');
}

export function enforceOfficialTone(reply: string): string {
  const cleaned = reply
    .split('|||')
    .map((part) => {
      let p = part.replace(EMOJI_RE, '').replace(EMOTICON_RE, '');
      p = stripMarkdown(p);
      p = stripParenSmileys(p);
      // A canned opener can survive as a second clause after another one is removed.
      for (let i = 0; i < 3 && CANNED_OPENER_RE.test(p); i += 1) p = p.replace(CANNED_OPENER_RE, '');
      // The official register is not Russian-only: strip English chattiness too.
      for (let i = 0; i < 2 && EN_FILLER_RE.test(p); i += 1) p = p.replace(EN_FILLER_RE, '');
      for (const [re, to] of GENDERED_SELF) {
        p = p.replace(re, (m) => (m[0] === m[0].toLowerCase() ? to.toLowerCase() : to));
      }
      p = p
        .replace(/!{2,}/g, '!')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\s+([,.!?;:])/g, '$1')
        .trim();
      // Re-capitalise a lowercase sentence start (official register), but never touch a part
      // that opens with a URL, an e-mail or a number — «kazzhol.com» must not become «Kazzhol.com».
      const firstToken = p.split(/\s/, 1)[0] ?? '';
      const opensWithLink = /[./@]/.test(firstToken) || /^\d/.test(p);
      if (p.length > 0 && !opensWithLink) p = p[0].toLocaleUpperCase('ru-RU') + p.slice(1);
      return p;
    })
    .filter((p) => p.length > 0);

  return cleaned.join('|||');
}

/**
 * Split a reply on the '|||' marker the model was taught to use.
 * More than 3 parts are merged into the 3rd; any part longer than 900 chars is
 * split at the last sentence boundary before 900 (hard cut as a fallback).
 */
export function styleSplit(reply: string): string[] {
  const parts = reply
    .split('|||')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const capped =
    parts.length > MAX_PARTS
      ? [...parts.slice(0, MAX_PARTS - 1), parts.slice(MAX_PARTS - 1).join(' ')]
      : parts;

  const expanded = capped.flatMap(splitLongPart);
  // splitLongPart can re-expand a merged tail past 3 — re-cap so a reply is
  // never more than 3 messages (a long tail stays long rather than multiplying).
  return expanded.length > MAX_PARTS
    ? [...expanded.slice(0, MAX_PARTS - 1), expanded.slice(MAX_PARTS - 1).join(' ')]
    : expanded;
}

function splitLongPart(part: string): string[] {
  const out: string[] = [];
  let rest = part;
  while (rest.length > MAX_PART_CHARS) {
    const window = rest.slice(0, MAX_PART_CHARS);
    const cut = safeCut(rest, lastSentenceEnd(window) ?? MAX_PART_CHARS);
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/**
 * Сдвигает точку разреза назад, если она попала внутрь ссылки.
 *
 * Разрезанная ссылка — это несостоявшаяся бронь: половина адреса в одном сообщении,
 * половина в другом, и гость не может нажать ни на что. Ссылка — единственное место в
 * ответе, которое обязано дойти целиком, поэтому лучше сообщение короче, чем битый адрес.
 */
export function safeCut(text: string, cut: number): number {
  if (cut <= 0 || cut >= text.length) return cut;
  const before = text.slice(0, cut);
  const start = Math.max(before.lastIndexOf('http://'), before.lastIndexOf('https://'));
  if (start === -1) return cut;
  // Ссылка кончается на первом пробеле; если он раньше разреза — разрез вне ссылки.
  const ws = text.slice(start).search(/\s/);
  const end = ws === -1 ? text.length : start + ws;
  if (end <= cut) return cut;
  // Режем перед ссылкой, но только если до неё вообще что-то осталось.
  return start > 0 ? start : cut;
}

/** Index just past the last sentence-ending punctuation followed by whitespace, or null. */
function lastSentenceEnd(window: string): number | null {
  const re = /[.!?…](?=\s)/g;
  let cut: number | null = null;
  for (let m = re.exec(window); m !== null; m = re.exec(window)) cut = m.index + 1;
  return cut;
}

export interface DelayedPart {
  text: string;
  delayMs: number;
}

export interface HumanDelayOpts {
  /** Length of the guest's message: longer questions take longer to "read". */
  guestMsgLength?: number;
  /**
   * Channel scaling (default 1; web widget uses 0.6). Scaled delays re-clamp to
   * [200, 2500]. Pass URGENT_MULTIPLIER (0) for urgent flows: every delay becomes 0.
   */
  multiplier?: number;
}

/** Multiplier for urgent flows (complaints, guest in a hurry): no delays at all. */
export const URGENT_MULTIPLIER = 0;

/**
 * Deterministic human-feeling delays: the first message simulates reading the
 * guest and typing; subsequent ones simulate typing only.
 */
export function humanDelays(parts: string[], opts: HumanDelayOpts = {}): DelayedPart[] {
  const multiplier = opts.multiplier ?? 1;
  const guestMsgLength = opts.guestMsgLength ?? 0;

  return parts.map((text, i) => {
    const base =
      i === 0
        ? clamp(400 + text.length * 15 + guestMsgLength * 5, 400, 1200)
        : clamp(600 + text.length * 20, 600, 2500);
    const delayMs = multiplier === 0 ? 0 : Math.round(clamp(base * multiplier, 200, 2500));
    return { text, delayMs };
  });
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/* ------------------------------------------------------------------ anti-repeat */

/** Sentence-level normalisation: case, punctuation and spacing stop mattering. */
function normalise(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/[«»"'(),.!?;:—–-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Removes sentences the guest has already been sent.
 *
 * A real guest received «коллеги свяжутся с вами в WhatsApp» three times in fifteen
 * seconds, once per follow-up message they sent. The prompt forbids that, but prompt bans
 * are probabilistic — this is the guarantee. Only near-identical sentences are dropped, so
 * a genuinely new answer that happens to share a phrase survives.
 *
 * If everything was a repeat, the caller gets an empty string and substitutes a short
 * acknowledgement: saying nothing new is better than saying the same thing again.
 */
/**
 * Приветствия на всех четырёх языках, с которыми к нам пишут.
 * Порядок важен: длинные варианты идут первыми, иначе «Добрый» съест «Добрый вечер».
 */
const GREETING_RE =
  new RegExp(
    '^\\s*(?:' +
      [
        'здравствуйте', 'здравствуй', 'доброе утро', 'добрый день', 'добрый вечер',
        'доброго времени суток', 'приветствую', 'привет',
        'сәлеметсіз бе', 'сәлеметсізбе', 'қайырлы таң', 'қайырлы күн', 'қайырлы кеш', 'сәлем',
        'good morning', 'good afternoon', 'good evening', 'greetings', 'hello', 'hi there', 'hi',
        '您好', '你好',
      ].join('|') +
      ')' +
      // Дальше не может идти буква, иначе «Приветствую» откусит начало «Приветствуем».
      '(?![\\p{L}])' +
      // Съедаем знаки после приветствия, включая китайские «，。！».
      '[\\s,!.…—–\\-，。！]*',
    'iu',
  );

/**
 * Убирает приветствие, если поздоровались уже раньше.
 *
 * Модель здоровается в каждом ответе, и в переписке это читается неестественно: живой
 * человек говорит «здравствуйте» один раз. Правилом в промпте не держится — проверено, —
 * поэтому режем детерминированно.
 *
 * Если кроме приветствия в ответе ничего нет (гость написал «привет» второй раз), оставляем
 * как есть: лучше повтор, чем пустое сообщение.
 */
export function dropRepeatedGreeting(reply: string, alreadyGreeted: boolean): string {
  if (!alreadyGreeted) return reply;
  const stripped = reply.replace(GREETING_RE, '');
  if (!stripped.trim()) return reply;
  // Первая буква остатка была строчной, потому что шла после «Здравствуйте!».
  return stripped.charAt(0).toLocaleUpperCase('ru-RU') + stripped.slice(1);
}

export function dropRepeatedSentences(reply: string, previousReplies: string[]): string {
  if (!reply.trim() || !previousReplies.length) return reply;
  const seen = new Set(previousReplies.flatMap((p) => sentencesOf(p).map(normalise)).filter(Boolean));
  if (!seen.size) return reply;

  const kept = sentencesOf(reply).filter((s) => {
    const key = normalise(s);
    // Short courtesies may legitimately repeat («Пожалуйста», «Здравствуйте»).
    if (key.length < 25) return true;
    return !seen.has(key);
  });
  return kept.join(' ').replace(/\s+\|\|\|\s+/g, '|||').trim();
}
