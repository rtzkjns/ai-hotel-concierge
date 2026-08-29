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
  const known = new Set((knowledge.match(money) ?? []).map(digitsOf));
  // В знаниях цены встречаются и без валюты рядом («завтрак 5000, обед 11500»), поэтому
  // добираем все длинные числа: пропустить лишнее безопаснее, чем срезать верный ответ.
  for (const n of knowledge.match(/\d[\d\s ]{2,}/g) ?? []) known.add(digitsOf(n));

  const invented: string[] = [];
  const kept = sentences(reply).filter((s) => {
    const sums = (s.match(money) ?? []).map(digitsOf).filter((d) => d.length >= 3);
    const bad = sums.filter((d) => !known.has(d));
    if (bad.length === 0) return true;
    invented.push(...bad);
    return false;
  });

  if (!invented.length) return { reply, invented: [] };
  const left = kept.join(' ').trim();
  // Совсем без ответа гостя не оставляем: пустой ответ хуже, чем честное «уточню».
  return {
    reply: left || 'Уточню это у коллег и вернусь с точным ответом.',
    invented,
  };
}
