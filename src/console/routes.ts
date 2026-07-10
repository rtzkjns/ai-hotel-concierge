// Staff console: server-rendered HTML pages (zero external resources, zero
// client frameworks), role-gated, CSRF-protected POSTs. All PII shown to
// non-admin roles passes maskPII; all dynamic values pass escapeHtml.
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { MetricsSummary } from '../core/events';
import { maskPII } from '../core/pii';
import type {
  Booking,
  BookingLead,
  ChatMessage,
  Conversation,
  ConversationStatus,
  MiceRequest,
  StaffMember,
  StoredEvent,
} from '../types';
import {
  createSessionFor,
  csrfTokenFor,
  FORBIDDEN_HTML,
  hashPassword,
  requireAuth,
  requireRole,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  verifyPassword,
  type AuthedStaff,
  type SessionStore,
} from './auth';

/** SLA target from the ТЗ: first reaction within 5 seconds. */
const SLA_TARGET_MS = 5000;

// Verified for unknown logins so every login attempt pays the same scrypt cost.
const DUMMY_PASS_HASH = hashPassword('__dummy_timing_padding__');
const SNIPPET_CHARS = 80;

/** The subset of Store the console needs (structural, for easy faking). */
export interface ConsoleStore extends SessionStore {
  findStaffByLogin(login: string): StaffMember | null;
  deleteSession(token: string): void;
  listConversations(activeWithinDays?: number): Conversation[];
  getConversation(id: string): Conversation | null;
  setStatus(id: string, status: ConversationStatus): void;
  setTakenBy(id: string, login: string | null): void;
  appendMessage(id: string, message: ChatMessage): void;
  listLeads(): BookingLead[];
  listBookings(): Booking[];
  listMice(): MiceRequest[];
  setMiceStatus(id: number, status: string): void;
  deletePersonalData(conversationId: string): void;
  recordEvent(
    type: string,
    data?: { conversationId?: string; property?: string; channel?: string; payload?: unknown },
  ): void;
  listEvents(sinceIso: string): StoredEvent[];
}

/**
 * Channel-agnostic staff reply sender, injected from the boot code so these
 * routes never couple to individual channel adapters.
 */
export type SendToConversation = (
  convo: Conversation,
  text: string,
) => Promise<{ ok: boolean; error?: string }>;

export interface ConsoleDeps {
  store: ConsoleStore;
  metricsSummary: (store: { listEvents(sinceIso: string): StoredEvent[] }) => MetricsSummary;
  sendToConversation: SendToConversation;
}

// --- HTML helpers ------------------------------------------------------------------

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const CSS = `
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; color: #1c2430; background: #f5f6f8; }
  header { background: #1c2430; color: #fff; padding: 10px 16px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  header .brand { font-weight: 700; }
  header nav a { color: #cfd8e3; text-decoration: none; margin-right: 12px; font-size: 14px; }
  header nav a:hover { color: #fff; }
  header .who { margin-left: auto; font-size: 13px; color: #9fb0c3; display: flex; align-items: center; gap: 8px; }
  main { padding: 16px; max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 8px 0 16px; }
  table { border-collapse: collapse; width: 100%; background: #fff; font-size: 14px; }
  th, td { border: 1px solid #dde3ea; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #eef1f5; font-weight: 600; }
  .tiles { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
  .tile { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 12px 16px; min-width: 140px; }
  .tile .num { font-size: 24px; font-weight: 700; }
  .tile .cap { font-size: 12px; color: #5b6b7d; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; }
  .badge.active { background: #d9f2e0; color: #16713a; }
  .badge.handed_off { background: #fde3c9; color: #a05a10; }
  .ok { color: #16713a; font-weight: 700; }
  .bad { color: #b3261e; font-weight: 700; }
  .msg { margin: 6px 0; padding: 8px 12px; border-radius: 8px; max-width: 75%; white-space: pre-wrap; }
  .msg.user { background: #fff; border: 1px solid #dde3ea; }
  .msg.assistant { background: #dceafe; margin-left: auto; }
  form.inline { display: inline; }
  button, input[type=submit] { background: #1c2430; color: #fff; border: 0; border-radius: 4px; padding: 6px 14px; cursor: pointer; font-size: 14px; }
  button.secondary { background: #5b6b7d; }
  input[type=text], input[type=password], select, textarea { padding: 6px 8px; border: 1px solid #b9c3cf; border-radius: 4px; font-size: 14px; }
  .error { background: #fdecea; border: 1px solid #f5c6c2; color: #b3261e; padding: 8px 12px; border-radius: 4px; margin-bottom: 12px; }
`;

const REFRESH_SCRIPT = `<script>
setInterval(async function () {
  try {
    var r = await fetch(location.href, { headers: { 'x-refresh': '1' } });
    if (!r.ok) return;
    var doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    var next = doc.getElementById('live');
    var cur = document.getElementById('live');
    if (next && cur) cur.innerHTML = next.innerHTML;
  } catch (e) {}
}, 5000);
</script>`;

interface PageOpts {
  staff?: AuthedStaff;
  csrf?: string;
  /** Re-fetch the page every 5s and swap the #live region (keeps forms intact). */
  refresh?: boolean;
}

function nav(staff: AuthedStaff): string {
  const links: Array<[string, string]> = [
    ['/console', 'Метрики'],
    ['/console/chats', 'Чаты'],
  ];
  if (staff.role === 'admin') {
    links.push(['/console/leads', 'Лиды'], ['/console/bookings', 'Брони']);
  }
  links.push(['/console/mice', 'MICE']);
  if (staff.role === 'admin') links.push(['/console/data-deletion', 'Удаление ПД']);
  return links.map(([href, label]) => `<a href="${href}">${label}</a>`).join('');
}

function page(title: string, body: string, opts: PageOpts = {}): string {
  const { staff, csrf, refresh } = opts;
  const header = staff
    ? `<header><span class="brand">Kazzhol AI · консоль</span><nav>${nav(staff)}</nav>` +
      `<span class="who">${escapeHtml(staff.login)} (${escapeHtml(staff.role)})` +
      `<form class="inline" method="post" action="/console/logout">` +
      `<input type="hidden" name="_csrf" value="${escapeHtml(csrf ?? '')}">` +
      `<button class="secondary" type="submit">Выйти</button></form></span></header>`
    : '';
  return (
    `<!doctype html><html lang="ru"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>` +
    header +
    `<main>${body}</main>` +
    (refresh ? REFRESH_SCRIPT : '') +
    `</body></html>`
  );
}

function sendHtml(reply: FastifyReply, html: string, code = 200): FastifyReply {
  return reply.code(code).type('text/html; charset=utf-8').send(html);
}

function statusBadge(status: string): string {
  const label = status === 'handed_off' ? 'у менеджера' : 'бот';
  return `<span class="badge ${escapeHtml(status)}">${label}</span>`;
}

function chatUrl(id: string): string {
  return `/console/chats/${encodeURIComponent(id)}`;
}

// --- Route registration ----------------------------------------------------------------

export async function registerConsoleRoutes(
  app: FastifyInstance,
  deps: ConsoleDeps,
): Promise<void> {
  const { store } = deps;

  await app.register(async (scope) => {
    await scope.register(cookie);
    await scope.register(formbody);

    scope.addHook('onRequest', requireAuth(store));

    // CSRF: every console POST except the login form must carry the
    // per-session token in a hidden field (body is parsed by preHandler time).
    scope.addHook('preHandler', async (req, reply) => {
      if (req.method !== 'POST') return;
      if (req.url.split('?')[0] === '/console/login') return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!req.sessionToken || body._csrf !== csrfTokenFor(req.sessionToken)) {
        await reply.code(403).type('text/html; charset=utf-8').send(FORBIDDEN_HTML);
      }
    });

    // --- Login / logout ------------------------------------------------------------

    const loginPage = (error?: string): string =>
      page(
        'Вход — консоль Kazzhol AI',
        `<h1>Консоль персонала</h1>` +
          (error ? `<div class="error">${escapeHtml(error)}</div>` : '') +
          `<form method="post" action="/console/login">` +
          `<p><input type="text" name="login" placeholder="Логин" autocomplete="username" required></p>` +
          `<p><input type="password" name="password" placeholder="Пароль" autocomplete="current-password" required></p>` +
          `<p><button type="submit">Войти</button></p></form>`,
      );

    scope.get('/console/login', async (_req, reply) => sendHtml(reply, loginPage()));

    scope.post('/console/login', async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const login = typeof body.login === 'string' ? body.login.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const staff = login ? store.findStaffByLogin(login) : null;
      // Unknown logins still pay the scrypt cost — no login-existence timing oracle.
      const hashToCheck = staff?.passHash ?? DUMMY_PASS_HASH;
      const passwordOk = verifyPassword(password, hashToCheck);
      if (!staff || !passwordOk) {
        return sendHtml(reply, loginPage('Неверный логин или пароль'), 401);
      }
      const token = createSessionFor(store, staff.id);
      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        // localhost is a secure context in modern browsers, so dev login still works.
        secure: true,
        path: '/',
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
      });
      return reply.redirect('/console');
    });

    scope.post('/console/logout', async (req, reply) => {
      if (req.sessionToken) store.deleteSession(req.sessionToken);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return reply.redirect('/console/login');
    });

    // --- Dashboard -------------------------------------------------------------------

    scope.get('/console', async (req, reply) => {
      const m = deps.metricsSummary(store);
      const slaOk = m.p95ReplyMs <= SLA_TARGET_MS;
      const tile = (num: string | number, cap: string): string =>
        `<div class="tile"><div class="num">${escapeHtml(num)}</div><div class="cap">${escapeHtml(cap)}</div></div>`;
      const langs =
        Object.entries(m.byLanguage)
          .map(([lang, n]) => `${escapeHtml(lang)}: ${escapeHtml(n)}`)
          .join(', ') || '—';
      const body =
        `<h1>Метрики за сегодня</h1><div id="live"><div class="tiles">` +
        tile(m.dialogsToday, 'диалогов') +
        tile(m.messagesToday, 'сообщений') +
        tile(m.bookingsToday, 'броней') +
        tile(m.escalationsToday, 'эскалаций') +
        tile(`${m.upsellOffered} / ${m.upsellAccepted}`, 'upsell: предложено / принято') +
        tile(`${m.p50ReplyMs} ms`, 'p50 ответа') +
        `<div class="tile"><div class="num ${slaOk ? 'ok' : 'bad'}">${escapeHtml(m.p95ReplyMs)} ms</div>` +
        `<div class="cap">p95 ответа — SLA ≤ ${SLA_TARGET_MS} ms: ${slaOk ? 'в норме' : 'нарушен'}</div></div>` +
        `</div><p class="cap">Языки (входящие): ${langs}</p></div>`;
      return sendHtml(
        reply,
        page('Метрики — консоль', body, { staff: req.staff, csrf: csrfTokenFor(req.sessionToken!), refresh: true }),
      );
    });

    // --- Chats -----------------------------------------------------------------------

    const maskFor = (staff: AuthedStaff, text: string): string =>
      staff.role === 'admin' ? text : maskPII(text);

    scope.get('/console/chats', async (req, reply) => {
      const staff = req.staff!;
      let convos = store.listConversations();
      // Non-admins see only handed-off chats that are unclaimed or their own.
      if (staff.role !== 'admin') {
        convos = convos.filter(
          (c) => c.status === 'handed_off' && (c.takenBy === null || c.takenBy === staff.login),
        );
      }
      const rows = convos
        .map((c) => {
          const last = c.history[c.history.length - 1];
          const snippet = last ? maskFor(staff, last.content).slice(0, SNIPPET_CHARS) : '';
          return (
            `<tr><td><a href="${chatUrl(c.id)}">${escapeHtml(c.id)}</a></td>` +
            `<td>${escapeHtml(c.channel)}</td><td>${escapeHtml(c.property || '—')}</td>` +
            `<td>${escapeHtml(c.language ?? '—')}</td><td>${statusBadge(c.status)}</td>` +
            `<td>${escapeHtml(c.updatedAt)}</td><td>${escapeHtml(snippet)}</td></tr>`
          );
        })
        .join('');
      const body =
        `<h1>Диалоги</h1><div id="live"><table><tr><th>Диалог</th><th>Канал</th><th>Отель</th>` +
        `<th>Язык</th><th>Статус</th><th>Обновлён</th><th>Последнее сообщение</th></tr>` +
        (rows || '<tr><td colspan="7">пока пусто</td></tr>') +
        `</table></div>`;
      return sendHtml(
        reply,
        page('Чаты — консоль', body, { staff, csrf: csrfTokenFor(req.sessionToken!), refresh: true }),
      );
    });

    /** Loads the conversation and enforces the mice_manager handed_off-only rule. */
    const chatAccess = async (
      req: FastifyRequest,
      reply: FastifyReply,
    ): Promise<Conversation | null> => {
      const { id } = req.params as { id: string };
      const convo = store.getConversation(id);
      if (!convo) {
        await sendHtml(reply, page('Не найдено', '<h1>Диалог не найден</h1>', { staff: req.staff, csrf: csrfTokenFor(req.sessionToken!) }), 404);
        return null;
      }
      const notOwn =
        convo.status !== 'handed_off' ||
        (convo.takenBy !== null && convo.takenBy !== req.staff!.login);
      if (req.staff!.role !== 'admin' && notOwn) {
        await reply.code(403).type('text/html; charset=utf-8').send(FORBIDDEN_HTML);
        return null;
      }
      return convo;
    };

    scope.get('/console/chats/:id', async (req, reply) => {
      const convo = await chatAccess(req, reply);
      if (!convo) return;
      const staff = req.staff!;
      const csrf = csrfTokenFor(req.sessionToken!);
      const transcript = convo.history
        .map(
          (m) =>
            `<div class="msg ${m.role === 'user' ? 'user' : 'assistant'}">${escapeHtml(
              maskFor(staff, m.content),
            )}</div>`,
        )
        .join('');
      const csrfField = `<input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">`;
      const actions =
        convo.status === 'active'
          ? `<form class="inline" method="post" action="${chatUrl(convo.id)}/takeover">${csrfField}` +
            `<button type="submit">Взять чат (бот замолчит)</button></form>`
          : `<form class="inline" method="post" action="${chatUrl(convo.id)}/release">${csrfField}` +
            `<button type="submit">Вернуть боту</button></form>`;
      const body =
        `<h1>${escapeHtml(convo.id)} ${statusBadge(convo.status)}</h1>` +
        `<p>Канал: ${escapeHtml(convo.channel)} · Отель: ${escapeHtml(convo.property || '—')} · ` +
        `Язык: ${escapeHtml(convo.language ?? '—')}</p>` +
        `<p>${actions}</p>` +
        `<div id="live" style="display:flex;flex-direction:column">${transcript || '<p>История пуста.</p>'}</div>` +
        `<form method="post" action="${chatUrl(convo.id)}/send" style="margin-top:12px;display:flex;gap:8px">` +
        csrfField +
        `<input type="text" name="text" placeholder="Ответ гостю от имени отеля" style="flex:1" required>` +
        `<button type="submit">Отправить</button></form>`;
      return sendHtml(reply, page(`Чат ${convo.id}`, body, { staff, csrf, refresh: true }));
    });

    scope.post('/console/chats/:id/takeover', async (req, reply) => {
      const convo = await chatAccess(req, reply);
      if (!convo) return;
      store.setStatus(convo.id, 'handed_off');
      store.setTakenBy(convo.id, req.staff!.login);
      store.recordEvent('takeover', {
        conversationId: convo.id,
        property: convo.property,
        channel: convo.channel,
        payload: { staff: req.staff!.login },
      });
      return reply.redirect(chatUrl(convo.id));
    });

    scope.post('/console/chats/:id/release', async (req, reply) => {
      const convo = await chatAccess(req, reply);
      if (!convo) return;
      store.setStatus(convo.id, 'active');
      store.setTakenBy(convo.id, null);
      store.recordEvent('release', {
        conversationId: convo.id,
        property: convo.property,
        channel: convo.channel,
        payload: { staff: req.staff!.login },
      });
      return reply.redirect(chatUrl(convo.id));
    });

    scope.post('/console/chats/:id/send', async (req, reply) => {
      const convo = await chatAccess(req, reply);
      if (!convo) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) return reply.redirect(chatUrl(convo.id));

      let result: { ok: boolean; error?: string };
      try {
        result = await deps.sendToConversation(convo, text);
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : 'send failed' };
      }
      if (!result.ok) {
        const msg = maskPII(result.error ?? 'не удалось отправить');
        return sendHtml(
          reply,
          page(
            'Не доставлено',
            `<h1>Сообщение не доставлено</h1><div class="error">${escapeHtml(msg)}</div>` +
              `<p><a href="${chatUrl(convo.id)}">← назад к чату</a></p>`,
            { staff: req.staff, csrf: csrfTokenFor(req.sessionToken!) },
          ),
        );
      }
      // Stored with a staff marker; the guest just sees the plain text.
      store.appendMessage(convo.id, { role: 'assistant', content: `[менеджер] ${text}` });
      store.recordEvent('staff_message', {
        conversationId: convo.id,
        property: convo.property,
        channel: convo.channel,
        payload: { staff: req.staff!.login },
      });
      return reply.redirect(chatUrl(convo.id));
    });

    // --- Leads & bookings (admin only) ----------------------------------------------------

    scope.get('/console/leads', { preHandler: requireRole('admin') }, async (req, reply) => {
      const rows = store
        .listLeads()
        .map(
          (l) =>
            `<tr><td>${escapeHtml(l.id)}</td><td>${escapeHtml(l.kind)}</td>` +
            `<td>${escapeHtml(l.conversationId)}</td>` +
            `<td>${escapeHtml(l.checkIn ?? '')} ${escapeHtml(l.checkOut ?? '')}</td>` +
            `<td>${escapeHtml(l.contactName ?? '')} ${escapeHtml(l.contactPhone ?? '')}</td>` +
            `<td>${escapeHtml(l.specialRequests ?? '')}</td><td>${escapeHtml(l.createdAt)}</td></tr>`,
        )
        .join('');
      const body =
        `<h1>Лиды</h1><div id="live"><table><tr><th>#</th><th>Тип</th><th>Диалог</th>` +
        `<th>Даты</th><th>Контакт</th><th>Детали</th><th>Создан</th></tr>` +
        (rows || '<tr><td colspan="7">пока пусто</td></tr>') +
        `</table></div>`;
      return sendHtml(
        reply,
        page('Лиды — консоль', body, { staff: req.staff, csrf: csrfTokenFor(req.sessionToken!), refresh: true }),
      );
    });

    scope.get('/console/bookings', { preHandler: requireRole('admin') }, async (req, reply) => {
      const rows = store
        .listBookings()
        .map(
          (b) =>
            `<tr><td>${escapeHtml(b.exelyNumber)}</td><td>${escapeHtml(b.status)}</td>` +
            `<td>${escapeHtml(b.property)}</td><td>${escapeHtml(b.checkIn)} → ${escapeHtml(b.checkOut)}</td>` +
            `<td>${escapeHtml(b.guests)}</td><td>${escapeHtml(b.roomType)}</td>` +
            `<td>${escapeHtml(b.guestName ?? '')} ${escapeHtml(b.guestPhone ?? '')}</td>` +
            `<td>${escapeHtml(b.total ?? '')} ${escapeHtml(b.currency ?? '')}</td>` +
            `<td>${b.upsellAccepted ? 'да' : b.upsellOffered ? 'предложен' : '—'}</td></tr>`,
        )
        .join('');
      const body =
        `<h1>Брони</h1><div id="live"><table><tr><th>Номер</th><th>Статус</th><th>Отель</th>` +
        `<th>Даты</th><th>Гостей</th><th>Категория</th><th>Гость</th><th>Сумма</th><th>Upsell</th></tr>` +
        (rows || '<tr><td colspan="9">пока пусто</td></tr>') +
        `</table></div>`;
      return sendHtml(
        reply,
        page('Брони — консоль', body, { staff: req.staff, csrf: csrfTokenFor(req.sessionToken!), refresh: true }),
      );
    });

    // --- MICE ---------------------------------------------------------------------------------

    scope.get('/console/mice', async (req, reply) => {
      const csrf = csrfTokenFor(req.sessionToken!);
      const csrfField = `<input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">`;
      const rows = store
        .listMice()
        .map(
          (m) =>
            `<tr><td>${escapeHtml(m.id)}</td><td>${escapeHtml(m.property)}</td>` +
            `<td>${escapeHtml(m.eventDate ?? '')}</td><td>${escapeHtml(m.peopleCount ?? '')}</td>` +
            `<td>${escapeHtml(m.halls ?? '')} ${escapeHtml(m.catering ?? '')}</td>` +
            `<td>${escapeHtml(m.contactName ?? '')} ${escapeHtml(m.contactPhone ?? '')}</td>` +
            `<td>${escapeHtml(m.notes ?? '')}</td><td>${escapeHtml(m.status)}</td>` +
            `<td><form class="inline" method="post" action="/console/mice/${escapeHtml(m.id)}/status">${csrfField}` +
            `<select name="status"><option value="in_work">в работе</option><option value="done">закрыта</option></select> ` +
            `<button type="submit">OK</button></form></td></tr>`,
        )
        .join('');
      const body =
        `<h1>MICE-заявки</h1><div id="live"><table><tr><th>#</th><th>Отель</th><th>Дата</th>` +
        `<th>Чел.</th><th>Залы / кейтеринг</th><th>Контакт</th><th>Заметки</th><th>Статус</th><th>Сменить</th></tr>` +
        (rows || '<tr><td colspan="9">пока пусто</td></tr>') +
        `</table></div>`;
      return sendHtml(reply, page('MICE — консоль', body, { staff: req.staff, csrf, refresh: true }));
    });

    scope.post('/console/mice/:id/status', async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const status = typeof body.status === 'string' ? body.status : '';
      if (!Number.isInteger(id) || (status !== 'in_work' && status !== 'done')) {
        return sendHtml(
          reply,
          page('Ошибка', '<h1>Недопустимый статус</h1><p><a href="/console/mice">← назад</a></p>', {
            staff: req.staff,
            csrf: csrfTokenFor(req.sessionToken!),
          }),
          400,
        );
      }
      store.setMiceStatus(id, status);
      return reply.redirect('/console/mice');
    });

    // --- Data deletion (admin only) --------------------------------------------------------------

    const deletionForm = (staff: AuthedStaff, csrf: string, note?: string): string =>
      page(
        'Удаление ПД — консоль',
        `<h1>Удаление персональных данных</h1>` +
          (note ? `<div class="error">${escapeHtml(note)}</div>` : '') +
          `<p>Стирает историю диалога и маскирует имя/телефон в лидах, бронях и MICE-заявках. Необратимо.</p>` +
          `<form method="post" action="/console/data-deletion">` +
          `<input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">` +
          `<p><input type="text" name="conversationId" placeholder="ID диалога, напр. whatsapp:1112|7701..." style="width:420px" required></p>` +
          `<p><label><input type="checkbox" name="confirm"> Подтверждаю удаление ПД по запросу гостя</label></p>` +
          `<p><button type="submit">Удалить ПД</button></p></form>`,
        { staff, csrf },
      );

    scope.get('/console/data-deletion', { preHandler: requireRole('admin') }, async (req, reply) =>
      sendHtml(reply, deletionForm(req.staff!, csrfTokenFor(req.sessionToken!))),
    );

    scope.post('/console/data-deletion', { preHandler: requireRole('admin') }, async (req, reply) => {
      const csrf = csrfTokenFor(req.sessionToken!);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const conversationId =
        typeof body.conversationId === 'string' ? body.conversationId.trim() : '';
      if (!conversationId || body.confirm === undefined) {
        return sendHtml(
          reply,
          deletionForm(req.staff!, csrf, 'Укажите ID диалога и поставьте галочку подтверждения.'),
          400,
        );
      }
      // An erasure request must never report false success on a typo'd id.
      if (!store.getConversation(conversationId)) {
        return sendHtml(
          reply,
          deletionForm(req.staff!, csrf, `Диалог «${conversationId}» не найден — ничего не удалено.`),
          404,
        );
      }
      store.deletePersonalData(conversationId);
      store.recordEvent('data_deletion', {
        conversationId,
        payload: { staff: req.staff!.login },
      });
      return sendHtml(
        reply,
        page(
          'ПД удалены',
          `<h1>Готово</h1><p>Персональные данные диалога ${escapeHtml(conversationId)} удалены/замаскированы.</p>` +
            `<p><a href="/console/data-deletion">← ещё одно удаление</a></p>`,
          { staff: req.staff, csrf },
        ),
      );
    });
  });
}
