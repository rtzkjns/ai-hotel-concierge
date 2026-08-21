/**
 * Проверка, что оформленная бронь действительно заняла номер.
 *
 * Ответ движка о создании обманывал дважды: он возвращал настоящий на вид номер брони,
 * за которым в отеле не стояло ничего. Единственный признак, который движок нарисовать не
 * может, — остаток свободных номеров в Exely Search: это отдельная система, и она считает
 * склад сама. У настоящей брони он падает ровно на один, у фантома не двигается.
 *
 * Проверка идёт ФОНОМ и НЕ решает судьбу ответа гостю. Иначе одна случайная бронь с сайта,
 * прошедшая в ту же секунду, сделала бы дельту нулевой, и мы сказали бы гостю, что его
 * бронь не удалась, — соврав ровно так же, только в другую сторону. Поэтому расхождение
 * поднимает тревогу для людей, а не разворачивает гостя.
 */

import type { AvailabilityProvider } from '../integrations/exely/provider';

export interface AuditDeps {
  provider: AvailabilityProvider;
  recordEvent: (
    type: string,
    data?: { conversationId?: string; property?: string; payload?: unknown },
  ) => void;
  notifyStaff: (text: string, property?: string) => Promise<void>;
  /** Пауза перед пересчётом: Exely обновляет остаток не мгновенно. */
  delayMs?: number;
  wait?: (ms: number) => Promise<void>;
}

export interface AuditArgs {
  property: string;
  hotelName: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  roomTypeId: string;
  roomType: string;
  /** Сколько таких номеров было свободно ДО брони. */
  countBefore: number;
  bookingNumber: string;
  conversationId: string;
}

const DEFAULT_DELAY_MS = 25_000;

export type AuditOutcome = 'held' | 'not_held' | 'unknown';

/**
 * Пересчитывает остаток и сообщает людям, если он не сдвинулся.
 * Возвращает исход — ради тестов и журнала; вызывающему ждать его не нужно.
 */
export async function auditBookingHeldInventory(
  deps: AuditDeps,
  args: AuditArgs,
): Promise<AuditOutcome> {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  await wait(deps.delayMs ?? DEFAULT_DELAY_MS);

  let after: number | null = null;
  try {
    const res = await deps.provider.checkAvailability({
      property: args.property,
      checkIn: args.checkIn,
      checkOut: args.checkOut,
      guests: args.guests,
    });
    const offer = res.offers.find((o) => o.roomTypeId === args.roomTypeId);
    // Категория пропала из выдачи — значит свободных не осталось: это тоже занятый номер.
    after = offer ? (offer.availableCount ?? null) : 0;
  } catch {
    // Поиск недоступен — молчим: тревога без данных хуже её отсутствия.
    return 'unknown';
  }
  if (after === null) return 'unknown';

  const held = after < args.countBefore;
  deps.recordEvent(held ? 'booking_inventory_held' : 'booking_inventory_not_held', {
    conversationId: args.conversationId,
    property: args.property,
    payload: {
      number: args.bookingNumber,
      room: args.roomTypeId,
      before: args.countBefore,
      after,
    },
  });
  if (held) return 'held';

  await deps
    .notifyStaff(
      `ПРОВЕРЬТЕ БРОНЬ ${args.bookingNumber} — ${args.hotelName}\n` +
        `${args.roomType}, ${args.checkIn} — ${args.checkOut}\n` +
        `Свободных номеров этой категории было ${args.countBefore}, после брони ${after} — ` +
        `бронь могла не занять номер.\n` +
        `Гостю уже сказано, что бронь оформлена. Проверьте её в Exely и свяжитесь с гостем, ` +
        `если брони нет.`,
      args.property,
    )
    .catch(() => undefined);
  return 'not_held';
}
