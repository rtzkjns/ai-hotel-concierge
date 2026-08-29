/**
 * Заслон от выдуманных цен.
 *
 * Боту запрещено называть суммы, которых он не знает, — и он всё равно это сделал: сказал
 * гостю «трансфер из аэропорта 14 000 ₸». Числа нет ни в знаниях, ни в промпте; в знаниях
 * прямо написано, что регулярного трансфера у отеля нет. Гость, заложивший эту сумму в
 * поездку, узнал бы правду в аэропорту — это готовая жалоба и потерянное доверие.
 *
 * Правилом такое не держится: запрет в промпте существовал с самого начала. Поэтому режем
 * детерминированно — по тому же принципу, что приветствия и род.
 *
 * Заслон НАМЕРЕННО срабатывает только когда живые цены в этом ходу НЕ запрашивались. Если
 * бот сходил в Exely, любые названные им суммы законны, и трогать их нельзя — иначе
 * сломается главное: показ цен и оформление брони.
 */

import { kazzholTenant } from '../tenant';

/**
 * «55 250 ₸», «1500-4500 тг», «от 3 800 тенге» — суммы, как их пишет бот. Хвост-валюта берётся из
 * тенанта (scrubPattern); числовая часть валюто-независима — `\s` уже покрывает NBSP и узкий NBSP
 * (U+00A0 / U+202F), которыми группируют разряды в «55 250». Для Kazzhol pattern даёт ровно
 * исходное `₸|тг\b|тенге\b|KZT\b`.
 */
function moneyRe(scrubPattern: string): RegExp {
  return new RegExp(`\\d[\\d\\s ]{2,}(?=\\s*(?:${scrubPattern}))`, 'gi');
}

/** Только цифры: «55 250» и «55250» — одна и та же сумма. */
const digitsOf = (s: string): string => s.replace(/\D/g, '');

/**
 * Слова, выдающие, что сумма названа ЗА НОМЕР. Номерная цена — единственная, которой в
 * статической базе нет и быть не должно: она приходит ТОЛЬКО из живого Exely. Поэтому рядом
 * с такой суммой планка «выдумки» строже — совпадения значения с любым числом базы (цена
 * абонемента, аренда зала) уже недостаточно. RU/EN/KK/ZH — бот отвечает на всех четырёх.
 */
const ROOM_CONTEXT_RE =
  /номер|ноч[ьи]|за ночь|сутк|суток|\broom\b|\bnight|\bstay\b|бөлме|тәулік|түн|房间|每晚|一晚/i;

/** Узкое окно вокруг суммы: «абонемент для проживающих — 25 000 ₸» не должно стать номерным. */
const ROOM_CTX_WINDOW = 24;

function roomPriced(text: string, at: number, len: number): boolean {
  const around =
    text.slice(Math.max(0, at - ROOM_CTX_WINDOW), at) +
    ' ' +
    text.slice(at + len, at + len + ROOM_CTX_WINDOW);
  return ROOM_CONTEXT_RE.test(around);
}

/** Предложения целиком — чтобы убрать ровно то, где стоит выдуманная цифра. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+/).filter((s) => s.trim() !== '');
}

export interface PriceGuardResult {
  reply: string;
  /** Суммы, которых не нашлось в знаниях. Пусто — значит бот ничего не выдумал. */
  invented: string[];
}

/**
 * Убирает предложения с суммами, которых нет в знаниях отеля.
 *
 * @param knowledge текст знаний этого отеля — единственный источник цен без похода в Exely
 * @param usedLiveData вызывал ли бот в этом ходу инструмент живых цен
 * @param scrubPattern валютная альтернатива тенанта; по умолчанию — Kazzhol (₸/тг/тенге/KZT)
 */
export function guardInventedPrices(
  reply: string,
  knowledge: string,
  usedLiveData: boolean,
  scrubPattern: string = kazzholTenant.currency.scrubPattern,
): PriceGuardResult {
  if (usedLiveData || !reply.trim()) return { reply, invented: [] };

  const money = moneyRe(scrubPattern);
  // Лёгкая планка для НЕ-номерных сумм (фитнес, рестораны, залы): любое длинное число базы.
  // Валюта рядом не требуется — в базе цены пишут и без неё («завтрак 5000, обед 11500»);
  // пропустить лишнее безопаснее, чем срезать верный ответ. Широкий свип — надмножество
  // валюто-помеченных совпадений, поэтому отдельно их добирать не нужно.
  const known = new Set<string>();
  for (const n of knowledge.match(/\d[\d\s ]{2,}/g) ?? []) known.add(digitsOf(n));

  // Строгая планка для НОМЕРНЫХ сумм: значение засчитывается, только если в базе оно стоит
  // С ВАЛЮТОЙ и В НОМЕРНОМ контексте. У Kazzhol номерных цен в базе нет вовсе — значит любая
  // сумма «за номер» без похода в Exely выдумана, даже если совпала с ценой абонемента.
  // У тенанта со статическими тарифами такие цены попадут сюда из его же базы и уцелеют.
  const knownRoomPrice = new Set<string>();
  for (const m of knowledge.matchAll(money)) {
    if (roomPriced(knowledge, m.index ?? 0, m[0].length)) knownRoomPrice.add(digitsOf(m[0]));
  }

  const invented: string[] = [];
  const kept = sentences(reply).filter((s) => {
    let bad = false;
    for (const m of s.matchAll(money)) {
      const d = digitsOf(m[0]);
      if (d.length < 3) continue;
      // Номерная сумма — строгая планка; всё прочее — прежняя лёгкая.
      const ok = roomPriced(s, m.index ?? 0, m[0].length) ? knownRoomPrice.has(d) : known.has(d);
      if (!ok) {
        invented.push(d);
        bad = true;
      }
    }
    return !bad;
  });

  if (!invented.length) return { reply, invented: [] };
  const left = kept.join(' ').trim();
  // Совсем без ответа гостя не оставляем: пустой ответ хуже, чем честное «уточню».
  return {
    reply: left || 'Уточню это у коллег и вернусь с точным ответом.',
    invented,
  };
}
