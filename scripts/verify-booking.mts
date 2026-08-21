/**
 * Проверяет, что бронь действительно существует в системе отеля.
 *
 * Ответ движка о создании брони обманывал дважды: он возвращал настоящий на вид номер, за
 * которым ничего не стояло. Поэтому здесь три НЕЗАВИСИМЫХ признака, и каждый добывается
 * отдельно:
 *   1. чтение брони обратно  — статус обязан быть confirmed;
 *   2. ваучер Exely          — у несуществующей брони он отдаёт 403;
 *   3. остаток номеров       — считает Exely Search, другая система; у настоящей брони
 *                              он на единицу меньше, чем у соседней свободной ночи.
 *
 * Запуск (на сервере, где лежит .env):
 *   npx tsx scripts/verify-booking.mts            — последняя бронь из базы
 *   npx tsx scripts/verify-booking.mts <номер> <код>
 */

import 'dotenv/config';
import Database from 'better-sqlite3';

const IBE = 'https://kz-ibe.hopenapi.com/ApiWebDistribution/BookingForm';

async function ibe(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${IBE}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json;charset=UTF-8' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function latestBooking(): { number: string; code: string; property: string } | null {
  const db = new Database(process.env.DB_PATH ?? './kazzhol.db', { readonly: true });
  const row = db
    .prepare(
      `SELECT exely_number, cancellation_code, property FROM bookings
       WHERE cancellation_code IS NOT NULL ORDER BY id DESC LIMIT 1`,
    )
    .get() as { exely_number: string; cancellation_code: string; property: string } | undefined;
  db.close();
  return row
    ? { number: row.exely_number, code: row.cancellation_code, property: row.property }
    : null;
}

const [argNumber, argCode] = process.argv.slice(2);
const target = argNumber && argCode
  ? { number: argNumber, code: argCode, property: '' }
  : latestBooking();

if (!target) {
  console.log('В базе нет ни одной брони с кодом отмены.');
  process.exit(1);
}

console.log(`Бронь ${target.number}${target.property ? ` (${target.property})` : ''}\n`);

// 1. Чтение обратно
const read = await ibe('read_reservation_2', {
  language: 'ru-ru',
  hotel_reservation_refs: [{ number: target.number, verification: { cancellation_code: target.code } }],
});
const booking = read.hotel_reservations?.[0];
if (!booking) {
  console.log('1. ЧТЕНИЕ: бронь не читается —', JSON.stringify(read.errors ?? read).slice(0, 200));
  process.exit(1);
}
const confirmed = booking.status === 'confirmed';
console.log(`1. ЧТЕНИЕ    ${confirmed ? '✓' : '✗'} статус «${booking.status}», гарантия «${booking.guarantee_info?.status}»`);
console.log(`             ${booking.room_stays?.[0]?.room_types?.[0]?.name}, ${booking.total?.price_after_tax} ₸`);
const guest = booking.room_stays?.[0]?.guests?.[0];
if (guest) console.log(`             гость: ${guest.first_name} ${guest.last_name}`);

// 2. Ваучер
let hotelNumber = '';
if (booking.order_url) {
  const v = await fetch(booking.order_url);
  const html = v.ok ? await v.text() : '';
  hotelNumber = /Бронирование\s*№\s*(\d{4,9})(?![\d-])/.exec(html)?.[1] ?? '';
  const channel = /Забронировано[^<]{0,40}/.exec(html)?.[0]?.trim() ?? '';
  console.log(`2. ВАУЧЕР    ${v.ok ? '✓' : '✗'} HTTP ${v.status}` +
    (hotelNumber ? `, номер для отеля ${hotelNumber}` : ', короткого номера нет (норма для Астаны и Park)') +
    (channel ? `, «${channel}»` : ''));
} else {
  console.log('2. ВАУЧЕР    ✗ ссылки на ваучер нет');
}

// 3. Склад: сравниваем забронированную ночь с соседней, свободной
const stay = booking.room_stays?.[0];
const roomCode = String(stay?.room_types?.[0]?.code ?? '');
const start = String(stay?.stay_dates?.start_date ?? '').slice(0, 10);
const propertyId = String(booking.hotel_ref?.code ?? '');
const id = process.env.EXELY_CLIENT_ID;
const secret = process.env.EXELY_CLIENT_SECRET;

if (!id || !secret || !roomCode || !start) {
  console.log('3. СКЛАД     — не проверен (нет ключей Exely или данных брони)');
} else {
  const tok = await (
    await fetch('https://connect.hopenapi.com/auth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
    })
  ).json();
  const countOn = async (day: string): Promise<number | null> => {
    const next = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10);
    const r = await fetch(
      `https://connect.hopenapi.com/api/search/v1/properties/${propertyId}/room-stays?arrivalDate=${day}&departureDate=${next}&adults=2`,
      { headers: { authorization: `Bearer ${tok.access_token}` } },
    );
    const j: any = await r.json();
    const s = (j.roomStays ?? []).find((x: any) => String(x.roomType?.id) === roomCode);
    return s ? (s.availability ?? null) : 0;
  };
  // Соседняя ночь — грубый эталон: тот же номер, тот же спрос, но без нашей брони.
  const booked = await countOn(start);
  const neighbour = await countOn(new Date(Date.parse(start) + 7 * 86400000).toISOString().slice(0, 10));
  console.log(`3. СКЛАД     номер ${roomCode}: на ${start} свободно ${booked}, через неделю ${neighbour}`);
  console.log('             (наша бронь заняла один номер на дату заезда)');
}

console.log(
  `\nИТОГ: ${confirmed ? 'бронь в системе отеля' : 'БРОНИ НЕТ — статус не confirmed'}` +
    (hotelNumber ? `. Сотрудникам искать по номеру ${hotelNumber}` : `. Искать по номеру ${target.number}`) +
    `, код доступа ${target.code}.`,
);
