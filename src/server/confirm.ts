/**
 * Подтверждение брони в одно нажатие.
 *
 * Гость уже назвал в переписке даты, номер, имя и телефон. Здесь он открывает ссылку, видит
 * собранную бронь целиком — отель, номер, тариф, даты, себя, цену — и подтверждает одной
 * кнопкой, ничего не перевыбирая.
 *
 * Кнопка ведёт в форму бронирования отеля — это ЕДИНСТВЕННЫЙ путь, по которому бронь
 * реально попадает в Edelweiss: Exely создаёт её сам и сам шлёт гостю подтверждение, ваучер и
 * документы. Оформить бронь в обход этой формы нельзя — Reservation API закрыт (403), а
 * внутренний движок движка возвращает номера, за которыми в отеле НИЧЕГО не появляется
 * (проверено ресепшеном и отсутствием письма гостю). Поэтому здесь не изобретается свой
 * способ записи брони: страница лишь снимает с гостя всю работу, кроме контактов, и
 * передаёт его туда, где бронь оформляется по-настоящему.
 *
 * Заодно нажатие кладёт заявку менеджерам: если гость до конца формы не дошёл, отель об
 * этом узнает и сам ему перезвонит, вместо того чтобы потерять бронь молча.
 *
 * Страница намеренно открыта без входа: гость приходит из WhatsApp или Instagram, сессии у
 * него нет и не будет. Защита — случайный токен, срок жизни и замаскированный телефон.
 */

import { randomBytes } from 'node:crypto';
import formbody from '@fastify/formbody';
import type { FastifyInstance } from 'fastify';
import type { BookingLead, Language } from '../types';

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
  /** Форма отеля: гостю, который не хочет ждать менеджера и оформит бронь сам. */
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
  /** Кладёт заявку в панель — именно по ней отель заносит бронь. */
  saveRequest: (lead: BookingLead) => void;
  notifyStaff: (text: string, property?: string) => Promise<void>;
}

const CODE_ALPHABET = 'ACEFHJKLMNPRTUVWXY3479';

/**
 * Короткий код заявки: гость называет его в переписке, менеджер — ищет по нему.
 * Без похожих друг на друга знаков (0/O, 1/I/L), потому что его диктуют голосом.
 */
export function requestCode(): string {
  const bytes = randomBytes(6);
  let out = 'KZ-';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
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
a.btn,button.btn{display:block;width:100%;margin-top:24px;padding:17px;border:0;border-radius:10px;
  background:#14385F;color:#fff;font:600 17px/1 inherit;cursor:pointer}
a.btn:hover,button.btn:hover{background:#0E2947}
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

/**
 * Страница «заявка принята» — её же видит гость, обновивший страницу.
 *
 * Слово «подтверждено» здесь не звучит и звучать не должно: подтверждает отель, а не мы.
 * Гость уходит с кодом заявки и понятным следующим шагом, а не с ложной уверенностью.
 */
function requestedPage(d: ConfirmationData, code: string): string {
  // Гость сюда возвращается уже ПОСЛЕ того, как его отправили на форму отеля: либо он её
  // прошёл, либо бросил. Поэтому здесь и ссылка обратно в форму, и обещание, что о нём
  // не забудут, — но по-прежнему ни слова о том, что бронь оформлена: этого мы не знаем.
  return page(
    'Заявка передана',
    `<div class="ok">Заявка передана в отдел бронирования</div>` +
      `<p class="sub">Номер заявки</p><p class="num">${esc(code)}</p>` +
      rows(d) +
      (d.totalPrice
        ? `<div class="total"><span class="k">Стоимость</span>` +
          `<span class="v">${esc(money(d.totalPrice, d.currency))}</span></div>`
        : '') +
      (d.bookingFormLink
        ? `<a class="btn" style="text-decoration:none;text-align:center" ` +
          `href="${esc(d.bookingFormLink)}">Перейти к бронированию</a>` +
          `<p class="note">Если бронь ещё не оформлена — откройте форму, номер и даты в ней ` +
          `уже выбраны, останется указать контакты. Не получится — отель свяжется с вами сам.</p>`
        : `<p class="note">Отдел бронирования свяжется с вами и оформит бронь.</p>`),
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

  const load = (token: string): { d: ConfirmationData; code: string | null } | null => {
    const found = store.findConfirmation(token);
    if (!found) return null;
    // Отправленную заявку показываем всегда, даже когда срок ссылки вышел: гость
    // возвращается на неё за номером заявки.
    if (!found.bookingNumber && Date.parse(found.expiresAt) < Date.now()) return null;
    return { d: found.data as ConfirmationData, code: found.bookingNumber };
  };

  app.get('/b/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const hit = load(token);
    if (!hit) return reply.code(410).type('text/html; charset=utf-8').send(GONE);

    if (hit.code) {
      return reply.type('text/html; charset=utf-8').send(requestedPage(hit.d, hit.code));
    }

    const d = hit.d;
    return reply.type('text/html; charset=utf-8').send(
      page(
        'Бронирование',
        `<p class="sub">Ваша бронь</p><h1>Проверьте и подтвердите</h1>` +
          rows(d) +
          (d.totalPrice
            ? `<div class="total"><span class="k">Стоимость</span>` +
              `<span class="v">${esc(money(d.totalPrice, d.currency))}</span></div>`
            : '') +
          `<form method="post" action="/b/${esc(token)}/confirm" ` +
          `onsubmit="this.querySelector('button').disabled=true;` +
          `this.querySelector('button').textContent='Открываем…'">` +
          `<button class="btn" type="submit">Подтвердить и забронировать</button></form>` +
          (d.freeCancellationUntil
            ? `<p class="note">Бесплатная отмена до ${esc(humanDate(d.freeCancellationUntil))}.</p>`
            : '') +
          // Честно предупреждаем про контакты: гость, ожидавший «одну кнопку», не должен
          // упереться в неожиданную форму — обманутое ожидание бросают чаще, чем работу.
          (d.bookingFormLink
            ? `<p class="note">Номер, тариф и даты уже выбраны — на странице отеля останется ` +
              `указать контакты и подтвердить. Бронь и подтверждение придут вам на почту.</p>`
            : `<p class="note">Данные уже заполнены — вводить ничего не нужно.</p>`),
      ),
    );
  });

  app.post('/b/:token/confirm', async (req, reply) => {
    const { token } = req.params as { token: string };
    const hit = load(token);
    if (!hit) return reply.code(410).type('text/html; charset=utf-8').send(GONE);
    const d = hit.d;

    // Повторное нажатие не должно плодить заявки отелю, но и мешать гостю не должно:
    // он жмёт второй раз именно потому, что хочет обратно в форму.
    if (hit.code) {
      if (d.bookingFormLink) return reply.redirect(d.bookingFormLink, 303);
      return reply.type('text/html; charset=utf-8').send(requestedPage(d, hit.code));
    }

    // Код присваиваем ДО записи и проверяем, что застолбили именно мы: две вкладки,
    // нажавшие одновременно, не должны создать отелю две одинаковые заявки.
    const code = requestCode();
    if (!store.claimConfirmation(token, code)) {
      const again = load(token);
      return reply
        .type('text/html; charset=utf-8')
        .send(again?.code ? requestedPage(d, again.code) : GONE);
    }

    const guestName = [d.guestFirstName, d.guestLastName].filter((s) => s && s !== '—').join(' ');
    // Заявка ложится в панель. Пишем ВСЁ, что нужно менеджеру для заведения брони в
    // Edelweiss, — он не должен ничего доспрашивать у гостя.
    deps.saveRequest({
      conversationId: d.conversationId,
      kind: 'booking',
      checkIn: d.checkIn,
      checkOut: d.checkOut,
      guests: d.guests,
      roomType: d.roomType,
      contactName: guestName,
      contactPhone: d.guestPhone,
      specialRequests: [
        `ЗАЯВКА ${code} — гость подтвердил, занести в Edelweiss`,
        `тариф: ${d.ratePlanName ?? '—'}`,
        d.totalPrice ? `сумма: ${money(d.totalPrice, d.currency)}` : null,
        d.guestEmail ? `почта: ${d.guestEmail}` : 'почта: не указана',
        d.comment ? `пожелания: ${d.comment}` : null,
      ]
        .filter((s): s is string => s !== null)
        .join('; '),
      createdAt: new Date().toISOString(),
    });

    store.recordEvent('booking_requested', {
      conversationId: d.conversationId,
      property: d.property,
      payload: { code, room: d.roomType, checkIn: d.checkIn, total: d.totalPrice ?? null },
    });

    void deps
      .notifyStaff(
        `ЗАЯВКА НА БРОНЬ ${code} — ${d.hotelName}\n` +
          `${d.roomType}${d.ratePlanName ? ` · ${d.ratePlanName}` : ''}\n` +
          `${humanDate(d.checkIn)} — ${humanDate(d.checkOut)}, ` +
          `${d.nights} ${nightsWord(d.nights)}, ${d.guests} ${guestsWord(d.guests)}\n` +
          (d.totalPrice ? `Сумма: ${money(d.totalPrice, d.currency)}\n` : '') +
          `Гость: ${guestName || '—'}, ${d.guestPhone}` +
          (d.guestEmail ? `, ${d.guestEmail}` : '') +
          (d.comment ? `\nПожелания: ${d.comment}` : '') +
          `\nГость нажал «Забронировать» и ушёл на форму отеля. Если брони через 15 минут ` +
          `не видно — свяжитесь с ним, данные все есть.\nДиалог: ${d.conversationId}`,
        d.property,
      )
      .catch(() => undefined);

    // Отправляем гостя туда, где бронь ДЕЙСТВИТЕЛЬНО оформляется и попадает в Edelweiss.
    // Ждать доставки уведомления менеджерам он не должен — оно уходит фоном.
    if (d.bookingFormLink) return reply.redirect(d.bookingFormLink, 303);
    return reply.type('text/html; charset=utf-8').send(requestedPage(d, code));
  });
}
