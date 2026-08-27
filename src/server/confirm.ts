/**
 * Подтверждение брони в одно нажатие.
 *
 * Гость уже назвал в переписке даты, номер, имя и телефон. Здесь он открывает ссылку, видит
 * собранную бронь целиком — отель, номер, тариф, даты, себя, цену — и подтверждает одной
 * кнопкой, ничего не перевыбирая.
 *
 * Нажатие оформляет бронь в системе отеля. «Оформлена» здесь значит,
 * что бронь прочитана обратно из системы и лежит там в статусе confirmed, — на слово ответу
 * о создании мы больше не верим: однажды он вернул номер брони, которой не существовало, и
 * гость получил ложное подтверждение.
 *
 * Если оформить не удалось — номер разобрали, движок молчит, — гостю говорится об этом
 * прямо, заявка со всеми данными уходит менеджерам, а форма отеля остаётся как способ
 * забронировать самому.
 *
 * Страница намеренно открыта без входа: гость приходит из WhatsApp или Instagram, сессии у
 * него нет и не будет. Защита — случайный токен, срок жизни и замаскированный телефон.
 */

import { randomBytes } from 'node:crypto';
import formbody from '@fastify/formbody';
import type { FastifyInstance } from 'fastify';
import type { CreateBookingResult } from '../core/booking';
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
  /**
   * Дополнительные номера ТОЙ ЖЕ брони — когда компания не помещается в один номер.
   * Поля выше описывают первый номер. Пусто — обычная бронь одного номера.
   */
  extraRooms?: Array<{
    roomTypeId: string;
    ratePlanId: string;
    roomType: string;
    guests: number;
    childAges?: number[];
    totalPrice?: number | null;
  }> | null;
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
  /** Атомарно занимает свободный токен. Возвращает false, если его уже занял кто-то другой. */
  claimConfirmation(token: string, bookingNumber: string): boolean;
  /** Записывает итог поверх метки «оформляем». */
  settleConfirmation(token: string, bookingNumber: string, from: string): boolean;
  /** Снимает метку «оформляем», если оформление сорвалось. */
  releaseConfirmation(token: string, from: string): void;
  /** Запоминает сумму от движка, чтобы она не разошлась с показанной при обновлении. */
  updateConfirmationTotal?(token: string, total: number, currency?: string): void;
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
    /** Дополнительные номера ТОЙ ЖЕ брони. */
    extraRooms?: Array<{
      roomTypeId: string;
      ratePlanId: string;
      guests: number;
      childAges?: number[];
    }>;
  }) => Promise<CreateBookingResult>;
  /** Заявка менеджерам — на случай, когда бронь оформить не удалось. */
  saveRequest: (lead: BookingLead) => void;
  notifyStaff: (text: string, property?: string) => Promise<void>;
  /** Ссылка на диалог в панели — чтобы менеджер попал в переписку одним нажатием. */
  chatLink?: (conversationId: string) => string;
  /**
   * Пишет гостю в его же чат — туда, откуда он пришёл.
   *
   * Гость жмёт кнопку в браузере и закрывает вкладку; если подтверждение осталось только
   * на той странице, у него на руках не остаётся ничего. В переписке оно остаётся навсегда.
   */
  notifyGuest?: (conversationId: string, text: string) => Promise<void>;
  /**
   * Дорешивает короткий номер Exely, если к моменту нажатия его ещё не было.
   *
   * Он присваивается через минуту-полторы, а держать гостя на странице всё это время
   * нельзя. Поэтому бронь отдаётся сразу, а номер, по которому отель её ищет, догоняет
   * фоном — иначе сотрудники снова остаются с одним служебным номером на руках, ровно с
   * той жалобы всё и началось.
   */
  resolveHotelNumber?: (args: {
    number: string;
    voucherUrl: string;
    property: string;
    hotelName: string;
  }) => void;
  /**
   * Сверяет через минуту, что бронь действительно заняла номер.
   *
   * Гостю к этому моменту уже сказано «оформлено» — и это правильно, ответ движка
   * подтверждён чтением. Но склад считает отдельная система, и если он не сдвинулся,
   * об этом должны узнать люди, а не выяснить это гость на ресепшене.
   */
  auditBooking?: (args: {
    property: string;
    hotelName: string;
    checkIn: string;
    checkOut: string;
    guests: number;
    roomTypeId: string;
    roomType: string;
    countBefore: number;
    bookingNumber: string;
    conversationId: string;
  }) => void;
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
  const extras = d.extraRooms ?? [];
  const totalGuests = d.guests + extras.reduce((n, r) => n + r.guests, 0);
  const list: Array<[string, string]> = [['Отель', d.hotelName]];
  // Несколько номеров в одной брони: гость должен видеть КАЖДЫЙ и с кем он едет,
  // иначе «2 номера» на странице выглядят как одна комната и сюрприз на стойке.
  if (extras.length) {
    list.push([`Номер 1`, `${d.roomType} — ${d.guests} ${guestsWord(d.guests)}`]);
    extras.forEach((r, i) => {
      list.push([`Номер ${i + 2}`, `${r.roomType} — ${r.guests} ${guestsWord(r.guests)}`]);
    });
  } else {
    list.push(['Номер', d.roomType]);
  }
  list.push(
    ['Заезд', humanDate(d.checkIn)],
    ['Выезд', humanDate(d.checkOut)],
    ['Срок', `${d.nights} ${nightsWord(d.nights)}`],
    ['Гостей', `${totalGuests} ${guestsWord(totalGuests)}`],
  );
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
 * Метка «оформляем прямо сейчас». Ставится ДО обращения к движку и этим закрывает гонку:
 * гость нажимает «Подтвердить» дважды (а ждать приходится до пятнадцати секунд, пока
 * присваивается номер ваучера), и раньше это давало ДВЕ настоящие брони в отеле —
 * обе страницы рапортовали успех, персонал получал два уведомления.
 * Значение намеренно не начинается с «KZ-», иначе оно прочтётся как код заявки.
 */
export const IN_PROGRESS = 'IN-PROGRESS';

const workingPage = (): string =>
  page(
    'Оформляем',
    `<h1>Оформляем бронирование</h1>` +
      `<p class="note">Это занимает до полуминуты. Страница обновится сама — ` +
      `не нажимайте кнопку повторно и не закрывайте вкладку.</p>` +
      `<script>setTimeout(function(){location.reload()},5000)</script>`,
  );

/**
 * Страница оформленной брони — её же видит гость, обновивший страницу.
 *
 * Слово «оформлено» здесь появляется ТОЛЬКО после того, как бронь прочитана обратно из
 * системы отеля. Иначе — соседняя страница, с честным отказом.
 *
 * Номера брони и кода доступа здесь нет намеренно: это служебные идентификаторы, гостю
 * они ни о чём не говорят. Полное подтверждение с ними Exely присылает ему письмом.
 */
function bookedPage(d: ConfirmationData, total?: number | null): string {
  return page(
    'Бронирование оформлено',
    `<div class="ok">Бронирование оформлено</div>` +
      rows(d) +
      ((total ?? d.totalPrice)
        ? `<div class="total"><span class="k">К оплате при заселении</span>` +
          `<span class="v">${esc(money(total ?? d.totalPrice, d.currency))}</span></div>`
        : '') +
      // Про письмо говорим ТОЛЬКО когда почта есть. Раньше обещание стояло безусловно —
      // и гостю без адреса (или с опечаткой в нём) обещали письмо, которого не будет,
      // при том что номер брони мы намеренно не показываем. Гость оставался ни с чем.
      `<p class="note">Номер за вами, оплата — при заселении.` +
      (d.guestEmail
        ? ` Подтверждение с номером брони отель отправит на ${esc(d.guestEmail)}.`
        : ' Номер брони уточните у нас в чате — отправим сразу.') +
      ` Если планы изменятся — напишите нам в чат.</p>`,
  );
}

/** Оформить не удалось. Гостю — правда, отелю — заявка со всеми данными. */
function failedPage(d: ConfirmationData, code: string): string {
  return page(
    'Нужна минута',
    `<div class="warn">Не получилось оформить бронь автоматически.</div>` +
      `<p class="sub">Номер заявки</p><p class="num">${esc(code)}</p>` +
      rows(d) +
      `<p class="note">Заявка уже у отдела бронирования — с вами свяжутся и оформят бронь. ` +
      `Она не потеряна.</p>` +
      (d.bookingFormLink
        ? `<a class="alt" href="${esc(d.bookingFormLink)}">Или оформить самому на сайте отеля</a>`
        : ''),
  );
}

/**
 * Подтверждение, которое гость получает в чат. Не письмо и не квитанция — сообщение от
 * менеджера: всё нужное на заселение, без служебных слов и без ссылок.
 */
export function guestConfirmation(
  d: ConfirmationData,
  booked: {
    number: string;
    hotelNumber?: string | null;
    cancellationCode?: string | null;
    total?: number | null;
    currency?: string | null;
    roomType: string;
  },
): string {
  // Ни номера брони, ни кода доступа: гостю они в переписке не нужны и выглядят как
  // служебные внутренности. Полное подтверждение с номером и кодом Exely присылает ему
  // письмом от имени отеля — там им и место. Сотрудникам номера уходят отдельно.
  const lines = [
    `Бронирование оформлено ✓`,
    ``,
    `${d.hotelName}`,
    `${booked.roomType}`,
    `Заезд ${humanDate(d.checkIn)} с 15:00, выезд ${humanDate(d.checkOut)} до 12:00`,
    `${d.guests} ${guestsWord(d.guests)}, ${d.nights} ${nightsWord(d.nights)}`,
  ];
  const total = booked.total ?? d.totalPrice;
  if (total) lines.push(`Итого ${money(total, booked.currency ?? d.currency)} — оплата при заселении`);
  const name = [d.guestFirstName, d.guestLastName].filter((x) => x && x !== '—').join(' ');
  if (name) lines.push(`На имя: ${name}`);
  if (d.freeCancellationUntil) {
    lines.push(`Бесплатная отмена до ${humanDate(d.freeCancellationUntil)}`);
  }
  if (d.guestEmail) lines.push(`Подтверждение отправили на ${d.guestEmail}`);
  lines.push('', 'Ждём вас! Если что-то нужно изменить — напишите здесь.');
  return lines.join('\n');
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

  /** Код заявки начинается с KZ- — так отличаем несостоявшуюся бронь от настоящей. */
  const isRequestCode = (v: string): boolean => v.startsWith('KZ-');

  const resultPage = (d: ConfirmationData, mark: string): string =>
    mark === IN_PROGRESS ? workingPage() : isRequestCode(mark) ? failedPage(d, mark) : bookedPage(d);

  app.get('/b/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const hit = load(token);
    if (!hit) return reply.code(410).type('text/html; charset=utf-8').send(GONE);

    if (hit.code) {
      return reply.type('text/html; charset=utf-8').send(resultPage(hit.d, hit.code));
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
    if (hit.code) {
      return reply.type('text/html; charset=utf-8').send(resultPage(d, hit.code));
    }

    // Забираем токен ДО обращения к движку. Это единственное место, где гонка двух
    // вкладок закрывается по-настоящему: UPDATE ... WHERE booking_number IS NULL
    // атомарен, и второй запрос уходит показывать состояние, а не оформлять вторую бронь.
    if (!store.claimConfirmation(token, IN_PROGRESS)) {
      const again = load(token);
      return reply
        .type('text/html; charset=utf-8')
        .send(again?.code ? resultPage(d, again.code) : GONE);
    }

    // Любой срыв ВНУТРИ оформления обязан снять метку: иначе гость навсегда останется
    // на странице «оформляем», а токен станет мёртвым. Бронь при этом могла и создаться,
    // поэтому персонал узнаёт об этом отдельно, а гостю не обещаем ни успеха, ни отказа.
    let booked: Awaited<ReturnType<typeof deps.createBooking>>;
    try {
      booked = await deps.createBooking({
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
        // Дополнительные номера оформляются ОДНОЙ бронью вместе с первым.
        extraRooms: (d.extraRooms ?? []).map((r) => ({
          roomTypeId: r.roomTypeId,
          ratePlanId: r.ratePlanId,
          guests: r.guests,
          childAges: r.childAges,
        })),
      });
    } catch (err) {
      store.releaseConfirmation(token, IN_PROGRESS);
      store.recordEvent('confirmation_crashed', {
        conversationId: d.conversationId,
        property: d.property,
        payload: { error: err instanceof Error ? err.message : String(err) },
      });
      await deps
        .notifyStaff(
          `⚠️ СБОЙ ПРИ ОФОРМЛЕНИИ — ${d.hotelName}\n` +
            `${humanDate(d.checkIn)} — ${humanDate(d.checkOut)}, ${d.roomType}\n` +
            `Гость: ${[d.guestFirstName, d.guestLastName].filter((x) => x && x !== '—').join(' ')}, ${d.guestPhone}\n` +
            'Бронь МОГЛА создаться в системе — проверьте вручную и свяжитесь с гостем.',
          d.property,
        )
        .catch(() => undefined);
      throw err;
    }

    const guestName = [d.guestFirstName, d.guestLastName].filter((x) => x && x !== '—').join(' ');

    if (booked.mode !== 'confirmed') {
      // Номер мог уйти, пока гость думал, или движок недоступен. Врать нельзя: говорим как
      // есть, отдаём заявку людям и оставляем форму отеля как рабочий путь.
      const code = requestCode();
      // Сначала СОХРАНЯЕМ заявку, только потом объявляем её гостю. При обратном порядке
      // упавшая запись оставляла гостя с обещанием «заявка у отдела бронирования»,
      // которой ни у кого не было.
      let saved = true;
      try {
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
          `ЗАЯВКА ${code} — гость подтвердил, бронь НЕ оформилась (${booked.reason})`,
          `тариф: ${d.ratePlanName ?? '—'}`,
          d.totalPrice ? `сумма: ${money(d.totalPrice, d.currency)}` : null,
          d.guestEmail ? `почта: ${d.guestEmail}` : 'почта: не указана',
          d.comment ? `пожелания: ${d.comment}` : null,
        ]
          .filter((x): x is string => x !== null)
          .join('; '),
          createdAt: new Date().toISOString(),
        });
      } catch {
        saved = false;
      }
      // Метка снимается в любом случае: токен не должен остаться мёртвым.
      store.settleConfirmation(token, code, IN_PROGRESS);
      if (!saved) {
        store.recordEvent('request_save_failed', {
          conversationId: d.conversationId,
          property: d.property,
          payload: { code, reason: booked.reason },
        });
      }
      store.recordEvent('confirmation_failed', {
        conversationId: d.conversationId,
        property: d.property,
        payload: { code, reason: booked.reason },
      });
      await deps
        .notifyStaff(
          `ЗАЯВКА ${code} — бронь НЕ оформилась (${booked.reason}) — ${d.hotelName}\n` +
            `${d.roomType}, ${humanDate(d.checkIn)} — ${humanDate(d.checkOut)}, ` +
            `${d.guests} ${guestsWord(d.guests)}\n` +
            `Гость: ${guestName || '—'}, ${d.guestPhone}` +
            (d.guestEmail ? `, ${d.guestEmail}` : '') +
            `\nСвяжитесь с гостем и оформите вручную.\n` +
            `${deps.chatLink?.(d.conversationId) ?? `Диалог: ${d.conversationId}`}`,
          d.property,
        )
        .catch(() => undefined);
      return reply.type('text/html; charset=utf-8').send(failedPage(d, code));
    }

    // Бронь создана и прочитана обратно из системы отеля. Записываем номер поверх метки
    // «оформляем» — гонку двух вкладок мы закрыли раньше, до обращения к движку.
    store.settleConfirmation(token, booked.hotelNumber || booked.number, IN_PROGRESS);
    // Сумму от движка запоминаем: иначе обновление страницы покажет подготовленную цену,
    // которой может быть уже сутки, и гость увидит два разных числа за один заказ.
    if (booked.total && booked.total > 0) {
      store.updateConfirmationTotal?.(token, booked.total, booked.currency ?? undefined);
    }
    store.recordEvent('booking_confirmed', {
      conversationId: d.conversationId,
      property: d.property,
      payload: { number: booked.number, room: d.roomType, checkIn: d.checkIn },
    });
    await deps
      .notifyStaff(
        `БРОНЬ ОФОРМЛЕНА ${booked.hotelNumber ?? `(код ${booked.cancellationCode ?? '—'})`} — ${d.hotelName}\n` +
          `${booked.roomType}${booked.ratePlanName ? ` · ${booked.ratePlanName}` : ''}\n` +
          `${humanDate(booked.checkIn)} — ${humanDate(booked.checkOut)}, ` +
          `${d.nights} ${nightsWord(d.nights)}, ${booked.guests} ${guestsWord(booked.guests)}\n` +
          (booked.total ? `Сумма: ${money(booked.total, booked.currency)}\n` : '') +
          `Гость: ${guestName || '—'}, ${d.guestPhone}` +
          (d.guestEmail ? `, ${d.guestEmail}` : '') +
          (booked.cancellationCode ? `\nКод отмены: ${booked.cancellationCode}` : '') +
          // Служебный номер нужен для поиска через API, ваучер — чтобы открыть глазами.
          `\nСлужебный номер: ${booked.number}` +
          (booked.voucherUrl ? `\nВаучер: ${booked.voucherUrl}` : '') +
          // Exely присваивает короткий номер в течение минуты. Пока его нет, сотрудник
          // откроет ваучер и увидит его там — искать по служебному номеру бесполезно.
          (booked.hotelNumber
            ? ''
            : `\nКороткий номер Exely появится в течение минуты — он в заголовке ваучера`) +
          `\nДиалог: ${d.conversationId}`,
        d.property,
      )
      .catch(() => undefined);

    if (typeof booked.availableBefore === 'number') {
      deps.auditBooking?.({
        property: d.property,
        hotelName: d.hotelName,
        checkIn: d.checkIn,
        checkOut: d.checkOut,
        guests: d.guests,
        roomTypeId: d.roomTypeId,
        roomType: d.roomType,
        countBefore: booked.availableBefore,
        bookingNumber: booked.hotelNumber ?? booked.number,
        conversationId: d.conversationId,
      });
    }

    if (!booked.hotelNumber && booked.voucherUrl) {
      deps.resolveHotelNumber?.({
        number: booked.number,
        voucherUrl: booked.voucherUrl,
        property: d.property,
        hotelName: d.hotelName,
      });
    }

    // Подтверждение в переписку — не блокируя ответ страницы: гость не должен ждать
    // доставки в Instagram, чтобы увидеть свой номер брони.
    void deps
      .notifyGuest?.(d.conversationId, guestConfirmation(d, booked))
      .catch(() => undefined);

    return reply
      .type('text/html; charset=utf-8')
      .send(bookedPage(d, booked.total));
  });
}
