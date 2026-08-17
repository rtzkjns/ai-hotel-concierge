// Staff console: server-rendered HTML pages (zero external resources, zero
// client frameworks), role-gated, CSRF-protected POSTs. All PII shown to
// non-admin roles passes maskPII; all dynamic values pass escapeHtml.
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { MetricsSummary } from '../core/events';
import { maskPII } from '../core/pii';
import { propertyList } from '../knowledge';
import type { KbEntry } from '../types';
import type {
  Booking,
  BookingLead,
  ChatMessage,
  Conversation,
  ConversationStatus,
  HotelContent,
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
  /** Админ-панель базы знаний: факты, правила общения, источники. */
  listKbEntries?(property?: string, kind?: string): KbEntry[];
  addKbEntry?(e: Omit<KbEntry, 'id' | 'updatedAt'>): number;
  updateKbEntry?(
    id: number,
    patch: Partial<Pick<KbEntry, 'title' | 'body' | 'url' | 'active'>>,
  ): void;
  deleteKbEntry?(id: number): void;
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
  listContentForAdmin(property?: string): HotelContent[];
  addContent(c: {
    property: string;
    kind: HotelContent['kind'];
    title?: string;
    body: string;
    source?: HotelContent['source'];
    startsAt?: string | null;
    endsAt?: string | null;
  }): number;
  setContentActive(id: number, active: boolean): void;
  deleteContent(id: number): void;
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
  /** Last-synced status of each hotel's Exely-sourced knowledge (optional). */
  knowledgeStatus?: () => Array<{ property: string; syncedAt: string | null }>;
  /** Force a live re-pull of all hotels' catalog from Exely (optional). */
  refreshKnowledge?: () => Promise<unknown>;
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
    links.push(
      ['/console/leads', 'Лиды'],
      ['/console/bookings', 'Брони'],
      ['/console/content', 'Акции'],
      ['/console/kb', 'База знаний'],
    );
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

    // --- Hotel content: live promos / announcements the bot uses next message (ТЗ п.1.10) ---

    const CONTENT_KINDS = ['promo', 'announcement', 'fact', 'rate_plan'];

    // Админ-панель базы знаний: владелец и менеджеры сами учат бота — без разработчика.
    // Три типа записей: факт (что знать), правило общения (как говорить), источник (откуда брать).
    // Всё читается движком на КАЖДОМ сообщении гостя, поэтому правка действует сразу.
    scope.get('/console/kb', { preHandler: requireRole('admin') }, async (req, reply) => {
      const staff = req.staff!;
      const csrf = csrfTokenFor(req.sessionToken!);
      const csrfField = `<input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">`;
      const rows: KbEntry[] = store.listKbEntries?.() ?? [];
      const KIND_LABEL: Record<string, string> = {
        fact: 'Факт',
        tone: 'Правило общения',
        source: 'Источник',
      };
      const hotelOptions =
        '<option value="">Вся сеть</option>' +
        propertyList.map((h) => `<option value="${escapeHtml(h.key)}">${escapeHtml(h.name)}</option>`).join('');

      const group = (kind: string, hint: string): string => {
        const list = rows.filter((r) => r.kind === kind);
        const items = list.length
          ? list
              .map(
                (r) =>
                  `<tr><td>${escapeHtml(r.property || 'вся сеть')}</td>` +
                  `<td><b>${escapeHtml(r.title || '—')}</b><br><span class="muted">${escapeHtml(r.body).slice(0, 400)}</span>` +
                  (r.url ? `<br><a href="${escapeHtml(r.url)}" target="_blank" rel="noreferrer">${escapeHtml(r.url)}</a>` : '') +
                  `</td><td>${r.active ? '🟢 включено' : '⚪️ выключено'}</td>` +
                  `<td><form method="post" action="/console/kb/toggle" style="display:inline">${csrfField}` +
                  `<input type="hidden" name="id" value="${escapeHtml(String(r.id))}"><button>${r.active ? 'Выкл' : 'Вкл'}</button></form> ` +
                  `<form method="post" action="/console/kb/delete" style="display:inline" onsubmit="return confirm('Удалить запись?')">${csrfField}` +
                  `<input type="hidden" name="id" value="${escapeHtml(String(r.id))}"><button>Удалить</button></form></td></tr>`,
              )
              .join('')
          : `<tr><td colspan="4" class="muted">Пока пусто. ${escapeHtml(hint)}</td></tr>`;
        return `<table><tr><th>Отель</th><th>Запись</th><th>Статус</th><th></th></tr>${items}</table>`;
      };

      const body =
        '<h1>База знаний бота</h1>' +
        '<p>Всё, что вы добавите здесь, бот учтёт <b>со следующего сообщения гостя</b> — перезапуск не нужен. ' +
        'Записи можно выключать, не удаляя.</p>' +

        '<h2>Факты об отеле</h2>' +
        '<p class="muted">Услуги, цены на дополнительные услуги, правила, акции. Бот отвечает по ним прямо и считает их достоверными.</p>' +
        group('fact', 'Например: «Поздний выезд до 16:00 — 50% стоимости суток».') +
        `<form method="post" action="/console/kb/add">${csrfField}
          <input type="hidden" name="kind" value="fact">
          <p><select name="property">${hotelOptions}</select></p>
          <p><input name="title" placeholder="Короткий заголовок, например «Поздний выезд»" style="width:100%"></p>
          <p><textarea name="body" rows="3" placeholder="Что именно должен знать бот" style="width:100%" required></textarea></p>
          <p><button type="submit">Добавить факт</button></p>
        </form>` +

        '<hr><h2>Правила общения</h2>' +
        '<p class="muted">Как боту говорить и как не говорить. Эти правила приоритетнее общих настроек стиля.</p>' +
        group('tone', 'Например: «Не предлагать бронирование, если гость спросил только про услугу».') +
        `<form method="post" action="/console/kb/add">${csrfField}
          <input type="hidden" name="kind" value="tone">
          <p><select name="property">${hotelOptions}</select></p>
          <p><input name="title" placeholder="Короткий заголовок правила" style="width:100%"></p>
          <p><textarea name="body" rows="3" placeholder="Например: всегда уточнять число гостей до предложения номера" style="width:100%" required></textarea></p>
          <p><button type="submit">Добавить правило</button></p>
        </form>` +

        '<hr><h2>Источники</h2>' +
        '<p class="muted">Ссылка на страницу отеля, акцию или прайс. Текст со страницы подтягивается и попадает в знания бота.</p>' +
        group('source', 'Например: страница фитнес-центра на сайте отеля.') +
        `<form method="post" action="/console/kb/add">${csrfField}
          <input type="hidden" name="kind" value="source">
          <p><select name="property">${hotelOptions}</select></p>
          <p><input name="title" placeholder="Что это за источник" style="width:100%"></p>
          <p><input name="url" type="url" placeholder="https://kazzhol.com/..." style="width:100%" required></p>
          <p><textarea name="body" rows="2" placeholder="Необязательно: краткое пояснение для бота" style="width:100%"></textarea></p>
          <p><button type="submit">Добавить источник</button></p>
        </form>`;

      return reply.type('text/html; charset=utf-8').send(page('База знаний', body, { staff, csrf }));
    });

    scope.post('/console/kb/add', { preHandler: requireRole('admin') }, async (req, reply) => {
      const b = req.body as Record<string, string>;
      const kind = b.kind === 'tone' ? 'tone' : b.kind === 'source' ? 'source' : 'fact';
      const bodyText = (b.body ?? '').trim();
      const url = (b.url ?? '').trim();
      // Источник без ссылки и факт без текста бессмысленны — молча не сохраняем мусор.
      if (kind === 'source' ? url === '' : bodyText === '') {
        return reply.redirect('/console/kb');
      }
      store.addKbEntry?.({
        property: (b.property ?? '').trim(),
        kind,
        title: (b.title ?? '').trim(),
        body: bodyText || (kind === 'source' ? `Источник: ${url}` : ''),
        url: url || null,
        active: true,
      });
      return reply.redirect('/console/kb');
    });

    scope.post('/console/kb/toggle', { preHandler: requireRole('admin') }, async (req, reply) => {
      const id = Number((req.body as Record<string, string>).id);
      const cur = (store.listKbEntries?.() ?? []).find((r: KbEntry) => Number(r.id) === id);
      if (cur) store.updateKbEntry?.(id, { active: !cur.active });
      return reply.redirect('/console/kb');
    });

    scope.post('/console/kb/delete', { preHandler: requireRole('admin') }, async (req, reply) => {
      store.deleteKbEntry?.(Number((req.body as Record<string, string>).id));
      return reply.redirect('/console/kb');
    });

    scope.get('/console/content', { preHandler: requireRole('admin') }, async (req, reply) => {
      const staff = req.staff!;
      const csrf = csrfTokenFor(req.sessionToken!);
      const csrfField = `<input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">`;
      const rows = store.listContentForAdmin();
      const table = rows.length
        ? '<table><tr><th>Отель</th><th>Тип</th><th>Заголовок</th><th>Текст</th><th>Период</th><th>Статус</th><th></th></tr>' +
          rows
            .map(
              (c) =>
                `<tr><td>${escapeHtml(c.property)}</td><td>${escapeHtml(c.kind)}</td>` +
                `<td>${escapeHtml(c.title || '—')}</td><td>${escapeHtml(c.body)}</td>` +
                `<td>${escapeHtml((c.startsAt ?? '—') + ' … ' + (c.endsAt ?? '∞'))}</td>` +
                `<td>${c.active ? '🟢 вкл' : '⚪️ выкл'}</td>` +
                `<td><form method="post" action="/console/content/toggle" style="display:inline">${csrfField}` +
                `<input type="hidden" name="id" value="${escapeHtml(c.id)}"><button>${c.active ? 'Выкл' : 'Вкл'}</button></form> ` +
                `<form method="post" action="/console/content/delete" style="display:inline">${csrfField}` +
                `<input type="hidden" name="id" value="${escapeHtml(c.id)}"><button>Удалить</button></form></td></tr>`,
            )
            .join('') +
          '</table>'
        : '<p>Пока нет акций/анонсов. Добавьте первую ниже — бот увидит её со следующего сообщения гостя.</p>';
      // Live-from-Exely knowledge: last-synced status + a manual "refresh now" for staff.
      const knowledgePanel = deps.knowledgeStatus
        ? `<h2>Знания из Exely (авто-синхронизация)</h2>` +
          `<p>Номера, услуги и правила бот берёт напрямую из системы Exely и обновляет сам (при старте и каждые 12 ч). Цены — всегда живые из Exely на даты гостя.</p>` +
          '<table><tr><th>Отель</th><th>Обновлено из Exely</th></tr>' +
          deps
            .knowledgeStatus()
            .map(
              (s) =>
                `<tr><td>${escapeHtml(s.property)}</td><td>${escapeHtml(
                  s.syncedAt ? s.syncedAt.replace('T', ' ').slice(0, 16) + ' UTC' : '— (статичные знания)',
                )}</td></tr>`,
            )
            .join('') +
          '</table>' +
          (deps.refreshKnowledge
            ? `<form method="post" action="/console/knowledge/refresh">${csrfField}<p><button type="submit">Обновить сейчас из Exely</button></p></form>`
            : '') +
          '<hr>'
        : '';
      const hotelOpts = propertyList
        .map((p) => `<option value="${escapeHtml(p.key)}">${escapeHtml(p.name)}</option>`)
        .join('');
      const kindOpts = CONTENT_KINDS.map((k) => `<option value="${k}">${k}</option>`).join('');
      const form =
        `<h2>Добавить акцию / анонс</h2>` +
        `<form method="post" action="/console/content/add">${csrfField}` +
        `<p>Отель: <select name="property" required>${hotelOpts}</select> Тип: <select name="kind">${kindOpts}</select></p>` +
        `<p>Заголовок: <input name="title" placeholder="напр. Осенняя акция"></p>` +
        `<p>Текст: <textarea name="body" required placeholder="напр. действует раннее бронирование, работает новый спа-центр"></textarea></p>` +
        `<p style="color:#8a6d00">⚠ Не указывайте конкретную цену за номер — бот всегда берёт цену из системы бронирования на даты гостя. Опишите условия акции словами (что за акция, для кого), без суммы.</p>` +
        `<p>Действует с <input type="date" name="startsAt"> по <input type="date" name="endsAt"> (необязательно — истекает само)</p>` +
        `<p><button type="submit">Добавить</button></p></form>`;
      return sendHtml(
        reply,
        page(
          'Акции и знания — консоль',
          `<h1>Акции и знания отелей</h1>${knowledgePanel}${table}${form}`,
          { staff, csrf },
        ),
      );
    });

    scope.post(
      '/console/knowledge/refresh',
      { preHandler: requireRole('admin') },
      async (_req, reply) => {
        if (deps.refreshKnowledge) {
          try {
            await deps.refreshKnowledge();
          } catch {
            // The status table will simply show the timestamp didn't advance.
          }
        }
        return reply.redirect('/console/content');
      },
    );

    scope.post('/console/content/add', { preHandler: requireRole('admin') }, async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const property = typeof b.property === 'string' ? b.property : '';
      // A promo is a short line, not a document — cap length to keep prompt cost bounded.
      const bodyText = typeof b.body === 'string' ? b.body.trim().slice(0, 600) : '';
      const title = typeof b.title === 'string' ? b.title.trim().slice(0, 120) : '';
      const kind = CONTENT_KINDS.includes(String(b.kind)) ? (b.kind as HotelContent['kind']) : 'promo';
      if (property && bodyText) {
        store.addContent({
          property,
          kind,
          title,
          body: bodyText,
          source: 'staff',
          // Store the admin's bare calendar date (YYYY-MM-DD); the bot compares on the hotel's
          // local date (UTC+5), so no timezone suffix is needed here.
          startsAt: typeof b.startsAt === 'string' && b.startsAt ? b.startsAt : null,
          endsAt: typeof b.endsAt === 'string' && b.endsAt ? b.endsAt : null,
        });
      }
      return reply.redirect('/console/content');
    });

    scope.post('/console/content/toggle', { preHandler: requireRole('admin') }, async (req, reply) => {
      const id = Number((req.body as Record<string, unknown>)?.id);
      if (Number.isFinite(id)) {
        const cur = store.listContentForAdmin().find((c) => c.id === id);
        if (cur) store.setContentActive(id, !cur.active);
      }
      return reply.redirect('/console/content');
    });

    scope.post('/console/content/delete', { preHandler: requireRole('admin') }, async (req, reply) => {
      const id = Number((req.body as Record<string, unknown>)?.id);
      if (Number.isFinite(id)) store.deleteContent(id);
      return reply.redirect('/console/content');
    });

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
