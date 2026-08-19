/**
 * Подтверждение брони в одно нажатие.
 *
 * Гость уже назвал в переписке даты, номер, имя и телефон. Заставлять его вводить всё это
 * второй раз на форме отеля — верный способ потерять бронь на полпути. Здесь он открывает
 * ссылку, видит готовую заявку и нажимает одну кнопку; бронь при этом оформляется
 * по-настоящему, через тот же движок, что и на сайте отеля.
 *
 * Страница намеренно открыта без входа: гость приходит из WhatsApp или Instagram, сессии у
 * него нет и не будет. Защита — случайный токен, срок жизни и замаскированный телефон.
 */

import { randomBytes } from 'node:crypto';
import formbody from '@fastify/formbody';
import type { FastifyInstance } from 'fastify';
import type { CreateBookingResult } from '../core/booking';
import type { Language } from '../types';

/** Заявка живёт сутки: дольше — и цена, которую видит гость, перестаёт быть правдой. */
export const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface ConfirmationData {
  property: string;
  hotelName: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  guests: number;
  roomType: string;
  /** Коды нужны, чтобы в момент нажатия оформить ровно тот номер и тариф, что видел гость. */
  roomTypeId: string;
  ratePlanId: string;
  ratePlanName?: string | null;
  totalPrice?: number | null;
  currency?: string | null;
  guestFirstName: string;
  guestLastName: string;
  guestPhone: string;
  guestEmail?: string | null;
  comment?: string | null;
  language?: Language | null;
  conversationId: string;
  /** Форма отеля — запасной путь, если движок откажет прямо при нажатии. */
  bookingFormLink?: string | null;
  freeCancellationUntil?: string | null;
}

export interface ConfirmStore {
  saveConfirmation(rec: {
    token: string;
    conversationId: string;
    property: string;
    data: unknown;
    expiresAt: string;
  }): void;
  findConfirmation(
    token: string,
  ): { data: unknown; expiresAt: string; bookingNumber: string | null } | null;
  claimConfirmation(token: string, bookingNumber: string): boolean;
  recordEvent(
    type: string,
    data?: { conversationId?: string; property?: string; payload?: unknown },
  ): void;
}

export interface ConfirmDeps {
  store: ConfirmStore;
  /** Оформляет бронь — тот же путь, которым пользуется бот. */
  createBooking: (args: {
    conversationId: string;
    property: string;
    checkIn: string;
    checkOut: string;
    guests: number;
    roomTypeId: string;
    ratePlanId: string;
    guestFirstName: string;
    guestLastName: string;
    guestPhone: string;
    guestEmail?: string;
    comment?: string;
    language?: Language | null;
  }) => Promise<CreateBookingResult>;
  notifyStaff: (text: string, property?: string) => Promise<void>;
}

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

/** «2026-08-21» → «21 августа»: гость читает даты, а не ISO. */
export function humanDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? ''}`.trim();
}

export function nightsWord(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 14;
  const last = n % 10;
  if (!teen && last === 1) return 'ночь';
  if (!teen && last >= 2 && last <= 4) return 'ночи';
  return 'ночей';
}

export function guestsWord(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 14;
  const last = n % 10;
  if (!teen && last === 1) return 'гость';
  if (!teen && last >= 2 && last <= 4) return 'гостя';
  return 'гостей';
}

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(value?: number | null, currency?: string | null): string {
  if (value === null || value === undefined) return '';
  const sign = !currency || currency === 'KZT' ? '₸' : currency;
  return `${value.toLocaleString('ru-RU')} ${sign}`;
}

/** Ссылку может открыть кто угодно, поэтому телефон показываем частично. */
export function maskPhone(phone?: string | null): string {
  if (!phone) return '';
  const d = phone.replace(/\D/g, '');
  if (d.length < 7) return phone;
  return `+${d.slice(0, 1)} ${d.slice(1, 4)} ••• ${d.slice(-2)}`;
}

const CSS = `
*{box-sizing:border-box}
body{margin:0;padding:20px 16px 40px;background:#F6F8FB;color:#12181F;
  font:400 16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Roboto,Arial,sans-serif}
.card{max-width:480px;margin:0 auto;background:#fff;border:1px solid #E3E8EF;border-radius:14px;
  padding:24px;box-shadow:0 1px 2px rgba(18,24,31,.06)}
.brand{font:600 19px/1.2 inherit;color:#14385F;letter-spacing:.04em}
.sub{color:#66768A;font-size:14px;margin:4px 0 22px}
h1{font-size:20px;line-height:1.3;margin:0 0 18px}
.row{display:flex;justify-content:space-between;gap:14px;padding:11px 0;border-bottom:1px solid #EEF2F7}
.row:last-of-type{border-bottom:0}
.k{color:#4A5A6E;flex:none}
.v{text-align:right;font-weight:500}
.total{margin-top:14px;padding-top:16px;border-top:2px solid #E3E8EF;
  display:flex;justify-content:space-between;align-items:baseline}
.total .v{font-size:23px;font-weight:600}
button.btn{display:block;width:100%;margin-top:24px;padding:17px;border:0;border-radius:10px;
  background:#14385F;color:#fff;font:600 17px/1 inherit;cursor:pointer}
button.btn:hover{background:#0E2947}
button.btn[disabled]{background:#8A99AB;cursor:progress}
.note{color:#66768A;font-size:14px;margin-top:16px}
.ok{background:#E6F4EC;border:1px solid #107D32;color:#0c5f26;border-radius:10px;
  padding:14px 16px;margin-bottom:18px;font-weight:500}
.warn{background:#FDF3E3;border:1px solid #B26B00;color:#7A4A00;border-radius:10px;
  padding:14px 16px;margin-bottom:18px}
.num{font:600 20px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.02em}
.alt{display:block;text-align:center;margin-top:16px;color:#14385F;font-size:15px}
`;

function page(title: string, inner: string): string {
  return (
    `<!doctype html><html lang="ru"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow">` +
    `<title>${esc(title)}</title><style>${CSS}</style></head><body>` +
    `<div class="card"><div class="brand">KAZZHOL</div>${inner}</div></body></html>`
  );
}

function rows(d: ConfirmationData): string {
  const list: Array<[string, string]> = [
    ['Отель', d.hotelName],
    ['Номер', d.roomType],
    ['Заезд', humanDate(d.checkIn)],
    ['Выезд', humanDate(d.checkOut)],
    ['Срок', `${d.nights} ${nightsWord(d.nights)}`],
    ['Гостей', `${d.guests} ${guestsWord(d.guests)}`],
  ];
  if (d.ratePlanName) list.push(['Тариф', d.ratePlanName]);
  const name = [d.guestFirstName, d.guestLastName].filter(Boolean).join(' ');
  if (name) list.push(['Имя', name]);
  if (d.guestPhone) list.push(['Телефон', maskPhone(d.guestPhone)]);
  if (d.guestEmail) list.push(['Почта', d.guestEmail]);
  return list
    .map(([k, v]) => `<div class="row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`)
    .join('');
}

const GONE = page(
  'Ссылка устарела',
  `<h1>Ссылка больше не действует</h1>` +
    `<p class="note">Напишите нам в чат — подберём номер заново, это займёт минуту.</p>`,
);

/** Готовая страница «бронь оформлена» — её же видит гость, обновивший страницу. */
function bookedPage(d: ConfirmationData, number: string): string {
  return page(
    'Бронирование подтверждено',
    `<div class="ok">Бронирование подтверждено</div>` +
      `<p class="sub">Номер брони</p><p class="num">${esc(number)}</p>` +
      rows(d) +
      (d.totalPrice
        ? `<div class="total"><span class="k">К оплате при заселении</span>` +
          `<span class="v">${esc(money(d.totalPrice, d.currency))}</span></div>`
        : '') +
      `<p class="note">Номер за вами. Оплата — при заселении. ` +
      `Если планы изменятся, напишите нам в чат и назовите номер брони.</p>`,
  );
}

/** Случайный токен: угадать ссылку на чужую заявку должно быть невозможно. */
export function newConfirmationToken(): string {
  return randomBytes(16).toString('base64url');
}

export function registerConfirmRoutes(app: FastifyInstance, deps: ConfirmDeps): void {
  // Своя область видимости с разбором форм. Браузер отправляет кнопку как
  // application/x-www-form-urlencoded, а Fastify без этого плагина отвечает 415 —
  // и гость упирается в ошибку ровно в момент подтверждения брони.
  void app.register(async (scope) => {
    await scope.register(formbody);
    registerRoutes(scope, deps);
  });
}

function registerRoutes(app: FastifyInstance, deps: ConfirmDeps): void {
  const { store } = deps;

  const load = (token: string): { d: ConfirmationData; bookingNumber: string | null } | null => {
    const found = store.findConfirmation(token);
    if (!found) return null;
    // Уже оформленную бронь показываем всегда, даже когда срок ссылки вышел: гость
    // возвращается на неё за номером брони.
    if (!found.bookingNumber && Date.parse(found.expiresAt) < Date.now()) return null;
    return { d: found.data as ConfirmationData, bookingNumber: found.bookingNumber };
  };

  app.get('/b/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const hit = load(token);
    if (!hit) return reply.code(410).type('text/html; charset=utf-8').send(GONE);

    if (hit.bookingNumber) {
      return reply.type('text/html; charset=utf-8').send(bookedPage(hit.d, hit.bookingNumber));
    }

    const d = hit.d;
    return reply.type('text/html; charset=utf-8').send(
      page(
        'Подтверждение бронирования',
        `<p class="sub">Подтверждение бронирования</p><h1>Проверьте и подтвердите</h1>` +
          rows(d) +
          (d.totalPrice
            ? `<div class="total"><span class="k">Итого</span>` +
              `<span class="v">${esc(money(d.totalPrice, d.currency))}</span></div>`
            : '') +
          `<form method="post" action="/b/${esc(token)}/confirm" ` +
          `onsubmit="this.querySelector('button').disabled=true;` +
          `this.querySelector('button').textContent='Оформляем…'">` +
          `<button class="btn" type="submit">Подтвердить бронирование</button></form>` +
          (d.freeCancellationUntil
            ? `<p class="note">Бесплатная отмена до ${esc(humanDate(d.freeCancellationUntil))}.</p>`
            : '') +
          `<p class="note">Данные уже заполнены — вводить ничего не нужно. Оплата при заселении.</p>`,
      ),
    );
  });

  app.post('/b/:token/confirm', async (req, reply) => {
    const { token } = req.params as { token: string };
    const hit = load(token);
    if (!hit) return reply.code(410).type('text/html; charset=utf-8').send(GONE);
    const d = hit.d;

    // Повторное нажатие или обновление страницы не должно оформлять вторую бронь.
    if (hit.bookingNumber) {
      return reply.type('text/html; charset=utf-8').send(bookedPage(d, hit.bookingNumber));
    }

    const booked = await deps.createBooking({
      conversationId: d.conversationId,
      property: d.property,
      checkIn: d.checkIn,
      checkOut: d.checkOut,
      guests: d.guests,
      roomTypeId: d.roomTypeId,
      ratePlanId: d.ratePlanId,
      guestFirstName: d.guestFirstName,
      guestLastName: d.guestLastName,
      guestPhone: d.guestPhone,
      guestEmail: d.guestEmail ?? undefined,
      comment: d.comment ?? undefined,
      language: d.language,
    });

    if (booked.mode !== 'confirmed') {
      // Номер мог уйти, пока гость думал, или движок недоступен. Врать нельзя: говорим как
      // есть, зовём человека и оставляем форму отеля как рабочий путь.
      store.recordEvent('confirmation_failed', {
        conversationId: d.conversationId,
        property: d.property,
        payload: { reason: booked.reason },
      });
      await deps
        .notifyStaff(
          `Гость нажал «Подтвердить», но бронь не оформилась (${booked.reason}) — ${d.hotelName}\n` +
            `${d.roomType}, ${humanDate(d.checkIn)} — ${humanDate(d.checkOut)}, ` +
            `${d.guests} ${guestsWord(d.guests)}\n` +
            `Гость: ${d.guestFirstName} ${d.guestLastName}, ${d.guestPhone}\n` +
            `Свяжитесь с гостем и оформите вручную. Диалог: ${d.conversationId}`,
          d.property,
        )
        .catch(() => undefined);
      return reply.type('text/html; charset=utf-8').send(
        page(
          'Нужна минута',
          `<div class="warn">Не получилось оформить бронь автоматически.</div>` +
            rows(d) +
            `<p class="note">Мы уже передали заявку администратору — он свяжется с вами ` +
            `в ближайшее время. Заявка не потеряна.</p>` +
            (d.bookingFormLink
              ? `<a class="alt" href="${esc(d.bookingFormLink)}">Или оформить самому на сайте отеля</a>`
              : ''),
        ),
      );
    }

    // Гонка двух вкладок: бронь уже создана, но записать номер должен только один.
    store.claimConfirmation(token, booked.number);
    store.recordEvent('booking_confirmed', {
      conversationId: d.conversationId,
      property: d.property,
      payload: { number: booked.number, room: d.roomType, checkIn: d.checkIn },
    });
    await deps
      .notifyStaff(
        `Гость подтвердил бронирование — ${d.hotelName}\n` +
          `Бронь ${booked.number}\n` +
          `${booked.roomType}\n` +
          `${humanDate(booked.checkIn)} — ${humanDate(booked.checkOut)}, ` +
          `${d.nights} ${nightsWord(d.nights)}, ${booked.guests} ${guestsWord(booked.guests)}\n` +
          (booked.total ? `Сумма: ${money(booked.total, booked.currency)}\n` : '') +
          `Гость: ${d.guestFirstName} ${d.guestLastName}, ${d.guestPhone}` +
          (d.guestEmail ? `, ${d.guestEmail}` : '') +
          `\nДиалог: ${d.conversationId}`,
        d.property,
      )
      .catch(() => undefined);

    return reply
      .type('text/html; charset=utf-8')
      .send(bookedPage({ ...d, totalPrice: booked.total ?? d.totalPrice }, booked.number));
  });
}
