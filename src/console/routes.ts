// Staff console: server-rendered HTML pages (zero external resources, zero
// client frameworks), role-gated, CSRF-protected POSTs. All PII shown to
// non-admin roles passes maskPII; all dynamic values pass escapeHtml.
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { MetricsSummary } from '../core/events';
import { maskPII } from '../core/pii';
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
  ago,
  agoLabel,
  badge,
  banner,
  btn,
  channelLabel,
  CSS,
  CSS_VERSION,
  emptyState,
  escapeHtml,
  escalationReason,
  field,
  humanId,
  minutesSince,
  pills,
  PROPERTY_KEYS,
  propertyLabel,
  shell,
  waitLabel,
} from './ui';
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
  listKbEntries?(property?: string, kind?: string, includeArchived?: boolean): KbEntry[];
  /** «В архив» вместо удаления — правка отеля обратима. */
  archiveKbEntry?(id: number, archived?: boolean): void;
  addKbEntry?(e: Omit<KbEntry, 'id' | 'updatedAt'>): number;
  getKbEntry?(id: number): KbEntry | null;
  updateKbEntry?(
    id: number,
    patch: Partial<Pick<KbEntry, 'title' | 'body' | 'url' | 'active' | 'property'>>,
  ): void;
  deleteKbEntry?(id: number): void;
  findStaffByLogin(login: string): StaffMember | null;
  /** Смена собственного пароля — иначе выданный при заведении пароль живёт вечно. */
  setStaffPassword?(id: number, passHash: string): void;
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
  /** Прочитать конкретный источник по кнопке в панели (иначе — раз в 6 часов сам). */
  refreshSource?: (entry: KbEntry) => Promise<{ ok: boolean; error?: string }>;
}

// --- HTML helpers ------------------------------------------------------------------
// Всё оформление живёт в ./ui — здесь остаются только экраны и логика маршрутов.

export { escapeHtml };

function sendHtml(reply: FastifyReply, html: string, code = 200): FastifyReply {
  return reply.code(code).type('text/html; charset=utf-8').send(html);
}

function chatUrl(id: string): string {
  return `/console/chats/${encodeURIComponent(id)}`;
}

/**
 * Сотрудник, привязанный к отелю, работает только со своими гостями: ресепшен
 * Астаны не должен видеть переписку Алматы — ни в очереди, ни в заявках.
 * Пустой property = вся сеть (владелец).
 */
function canSee(staff: AuthedStaff, property: string | undefined): boolean {
  if (!staff.property) return true;
  // Диалог без отеля — гость ещё не выбрал, какой из них ему нужен. Такие
  // видит вся сеть, иначе они зависли бы без ответа.
  return !property || property === staff.property;
}

function visibleConversations(store: ConsoleStore, staff: AuthedStaff): Conversation[] {
  return store.listConversations().filter((c) => canSee(staff, c.property));
}

/** Диалоги, которые бот передал человеку и которые ещё никто не взял. */
function waitingFor(store: ConsoleStore, staff: AuthedStaff): Conversation[] {
  return visibleConversations(store, staff).filter((c) => c.status === 'handed_off' && !c.takenBy);
}

/** Момент последнего сообщения гостя — от него считается, сколько человек ждёт. */
function lastGuestAt(convo: Conversation): string | undefined {
  for (let i = convo.history.length - 1; i >= 0; i -= 1) {
    const m = convo.history[i];
    if (m.role === 'user') return m.createdAt ?? convo.updatedAt;
  }
  return convo.updatedAt;
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

    // CSS отдельным маршрутом с версией в имени: страница-опрос больше не тащит
    // килобайты стилей на каждом обновлении списка.
    scope.get(`/console/app.${CSS_VERSION}.css`, async (_req, reply) =>
      reply
        .type('text/css; charset=utf-8')
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .send(CSS),
    );

    const loginPage = (error?: string): string =>
      shell(
        'Вход',
        `<div class="login"><div class="logo">Kazzhol</div>` +
          `<p class="sub">Консоль персонала</p>` +
          (error ? banner('err', escapeHtml(error)) : '') +
          `<form method="post" action="/console/login">` +
          field('login', 'Логин', { attrs: 'autocomplete="username"', required: true }) +
          field('password', 'Пароль', { type: 'password', attrs: 'autocomplete="current-password"', required: true }) +
          btn('Войти', { variant: 'primary' }) +
          `</form></div>`,
        { bare: true },
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

    // --- Входящие (главный экран) ------------------------------------------------

    const maskFor = (staff: AuthedStaff, text: string): string =>
      staff.role === 'admin' ? text : maskPII(text);

    /** Причина, по которой диалог попал на стол человеку — словами, а не кодом. */
    const reasonFor = (convoId: string): string => {
      const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
      const ev = store
        .listEvents(since)
        .filter((e) => e.type === 'escalation' && e.conversationId === convoId)
        .pop();
      const payload = (ev?.payload ?? {}) as { type?: string };
      return escalationReason(payload.type);
    };

    /**
     * Карточка очереди. Четыре носителя смысла и ни одним больше: кто, сколько ждёт,
     * о чём речь, почему это у вас. Машинный id гостю на стол не кладём.
     */
    const queueCard = (
      c: Conversation,
      staff: AuthedStaff,
      opts: { waiting?: boolean; mine?: boolean; overdue?: boolean; showProperty: boolean },
    ): string => {
      const last = [...c.history].reverse().find((m) => m.role === 'user') ?? c.history[c.history.length - 1];
      const preview = last ? maskFor(staff, last.content) : '';
      const cls =
        'card' +
        (opts.waiting ? ' card--wait' : '') +
        (opts.mine ? ' card--mine' : '') +
        (opts.overdue ? ' card--overdue' : '');
      const meta = [
        opts.mine ? 'вы ведёте диалог' : reasonFor(c.id),
        channelLabel(c.channel),
        opts.showProperty && c.property ? propertyLabel(c.property) : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return (
        `<a class="${cls}" href="${chatUrl(c.id)}">` +
        `<div class="card__top"><span class="dot"></span>` +
        `<span class="card__who">${escapeHtml(humanId(c))}</span>` +
        `<span class="card__wait">${escapeHtml(waitLabel(lastGuestAt(c)))}</span></div>` +
        `<p class="card__preview">${escapeHtml(preview)}</p>` +
        `<p class="card__meta">${escapeHtml(meta)}</p></a>`
      );
    };

    scope.get('/console', async (req, reply) => {
      const staff = req.staff!;
      const all = visibleConversations(store, staff);
      const showProperty = new Set(all.map((c) => c.property)).size > 1;

      const waiting = all
        .filter((c) => c.status === 'handed_off' && !c.takenBy)
        .sort((x, y) => minutesSince(lastGuestAt(y)) - minutesSince(lastGuestAt(x)));
      const mine = all.filter((c) => c.status === 'handed_off' && c.takenBy === staff.login);
      const botHandled = all.filter((c) => c.status !== 'handed_off');

      // Красным красим только верхнюю карточку: если покрасить все, красный
      // за одну ночную смену перестанет что-либо значить.
      const bands: string[] = [];
      if (waiting.length) {
        bands.push(
          `<section class="section"><div class="section__head"><h2>Ждут вас · ${waiting.length}</h2></div>` +
            waiting
              .map((c, i) =>
                queueCard(c, staff, {
                  waiting: true,
                  overdue: i === 0 && minutesSince(lastGuestAt(c)) >= 20,
                  showProperty,
                }),
              )
              .join('') +
            `</section>`,
        );
      }
      if (mine.length) {
        bands.push(
          `<section class="section"><div class="section__head"><h2>Вы отвечаете · ${mine.length}</h2></div>` +
            mine.map((c) => queueCard(c, staff, { mine: true, showProperty })).join('') +
            `</section>`,
        );
      }
      if (!waiting.length && !mine.length) {
        bands.push(
          emptyState(
            'Никто не ждёт ответа',
            'Бот отвечает сам. Как только гость попросит человека — диалог появится здесь первым, наверху.',
            staff.role === 'admin'
              ? btn('Посмотреть, что бот знает об отеле', { variant: 'secondary', href: '/console/kb' })
              : undefined,
            'ok',
          ),
        );
      }
      if (botHandled.length && staff.role === 'admin') {
        const rows = botHandled
          .slice(0, 60)
          .map((c) => {
            const last = c.history[c.history.length - 1];
            const snippet = last ? maskFor(staff, last.content).slice(0, SNIPPET_CHARS) : '';
            return (
              `<a class="row" href="${chatUrl(c.id)}">` +
              `<span class="dot" style="color:var(--ok)"></span>` +
              `<span class="name">${escapeHtml(humanId(c))}</span>` +
              `<span class="grow">${escapeHtml(snippet)}</span>` +
              `<time>${escapeHtml(ago(c.updatedAt))}</time></a>`
            );
          })
          .join('');
        bands.push(
          `<details class="quiet"><summary>Бот справляется · ${botHandled.length}</summary>${rows}</details>`,
        );
      }

      const title = waiting.length ? `(${waiting.length}) Входящие` : 'Входящие';
      return sendHtml(
        reply,
        shell(title, `<div id="live">${bands.join('')}</div>`, {
          heading: 'Входящие',
          staff,
          csrf: csrfTokenFor(req.sessionToken!),
          active: '/console',
          waiting: waiting.length,
          refresh: true,
        }),
      );
    });

    // Старые адреса продолжают работать — закладки персонала не ломаем.
    scope.get('/console/chats', async (_req, reply) => reply.redirect('/console'));

    /** Loads the conversation and enforces the mice_manager handed_off-only rule. */
    const chatAccess = async (
      req: FastifyRequest,
      reply: FastifyReply,
    ): Promise<Conversation | null> => {
      const { id } = req.params as { id: string };
      const convo = store.getConversation(id);
      if (!convo) {
        await sendHtml(
          reply,
          shell('Диалог не найден', emptyState('Диалог не найден', 'Возможно, его удалили по запросу гостя.', btn('К входящим', { variant: 'secondary', href: '/console' }), 'lost'), {
            staff: req.staff,
            csrf: csrfTokenFor(req.sessionToken!),
            active: '/console',
          }),
          404,
        );
        return null;
      }
      // Чужой отель закрыт даже для владельца роли admin, если он привязан к отелю.
      if (!canSee(req.staff!, convo.property)) {
        await reply.code(403).type('text/html; charset=utf-8').send(FORBIDDEN_HTML);
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
      const q = req.query as { err?: string; draft?: string };
      const csrfField = `<input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">`;

      // Три типа пузыря вместо двух: гость, бот и вы — раньше свой ответ выглядел
      // ровно как ответ бота, и в истории было не разобрать, кто что сказал.
      let lastDay = '';
      const transcript = convo.history
        .map((m) => {
          const created = m.createdAt;
          const day = created ? new Date(created).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : '';
          const sep = day && day !== lastDay ? ((lastDay = day), `<div class="daysep">${escapeHtml(day)}</div>`) : '';
          const time = created
            ? new Date(created).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
            : '';
          const staffMsg = m.role === 'assistant' && m.content.startsWith('[менеджер] ');
          const text = maskFor(staff, staffMsg ? m.content.slice('[менеджер] '.length) : m.content);
          const kind = m.role === 'user' ? 'guest' : staffMsg ? 'staff' : 'bot';
          const label = kind === 'guest' ? '' : `${staffMsg ? escapeHtml(convo.takenBy ?? staff.login) : 'бот'}${time ? ` · ${time}` : ''}`;
          const meta = label ? `<p class="msg__meta msg__meta--right">${label}</p>` : '';
          return `${sep}<div class="msg msg--${kind}">${escapeHtml(text)}</div>${meta}`;
        })
        .join('');

      // Три состояния, а не два: бот ведёт / передан, но никем не взят / ведёте вы.
      // Раньше любой переданный диалог утверждал «Вы ведёте диалог», даже если
      // его никто не брал — менеджер думал, что гостя уже кто-то ведёт.
      const mine = convo.status === 'handed_off' && convo.takenBy === staff.login;
      const unclaimed = convo.status === 'handed_off' && !convo.takenBy;
      const handoff = mine
        ? `<div class="handoff"><p>${badge('brand', 'Вы ведёте диалог')}` +
          `<span class="sub">Бот молчит и не вмешивается в переписку.</span></p>` +
          `<form method="post" action="${chatUrl(convo.id)}/release">${csrfField}` +
          btn('Вернуть боту', { variant: 'ghost' }) +
          `</form></div>`
        : unclaimed
          ? `<div class="handoff"><p>${badge('wait', 'Гость ждёт человека')}` +
            `<span class="sub">Диалог никто не взял. Возьмите его, чтобы ответить.</span></p>` +
            `<form method="post" action="${chatUrl(convo.id)}/takeover">${csrfField}` +
            btn('Взять диалог', { variant: 'primary' }) +
            `</form></div>`
          : convo.takenBy
            ? `<div class="handoff"><p>Диалог ведёт ${escapeHtml(convo.takenBy)}.` +
              `<span class="sub">Вмешиваться не нужно — гость уже с человеком.</span></p></div>`
            : `<div class="handoff"><p>Сейчас отвечает бот.` +
              `<span class="sub">Бот замолчит, пока вы не вернёте его обратно.</span></p>` +
              `<form method="post" action="${chatUrl(convo.id)}/takeover">${csrfField}` +
              btn('Ответить самой', { variant: 'primary' }) +
              `</form></div>`;

      // Черновик возвращается вместе с ошибкой: менеджер у стойки не должен
      // набирать ответ заново. Раньше баннер обещал сохранённый текст, а поле было пустым.
      const draft = typeof q.draft === 'string' ? q.draft : '';
      const err = q.err
        ? banner('err', `Не доставлено: ${escapeHtml(q.err)}. Текст остался в поле — попробуйте отправить ещё раз.`)
        : '';

      const meta = [channelLabel(convo.channel), propertyLabel(convo.property), convo.language ?? '']
        .filter(Boolean)
        .join(' · ');

      const body =
        `<div class="chat">` +
        `<div class="chat__head"><div class="who">${escapeHtml(humanId(convo))}</div>` +
        `<div class="meta">${escapeHtml(meta)}</div></div>` +
        // handoff внутри #live: иначе после того как диалог взял другой менеджер,
        // страница обновляла ленту, а плашка продолжала предлагать «Взять диалог».
        `<div id="live">${handoff}` +
        `<div class="chat__log">${transcript || '<p class="note">История пуста.</p>'}</div></div>` +
        err +
        `<form class="composer" method="post" action="${chatUrl(convo.id)}/send" data-once>` +
        csrfField +
        `<textarea name="text" rows="1" data-autogrow placeholder="Ответ гостю от имени отеля" required>${escapeHtml(draft)}</textarea>` +
        btn('Отправить', { variant: 'primary', attrs: 'data-busy="Отправляю…"' }) +
        `</form>` +
        `<details class="tech"><summary>Технические данные</summary>` +
        `<p><code>${escapeHtml(convo.id)}</code></p></details>` +
        `</div>`;

      return sendHtml(
        reply,
        shell(humanId(convo), body, {
          staff,
          csrf,
          active: '/console',
          back: { href: '/console', label: 'Входящие' },
          waiting: waitingFor(store, staff).length,
          refresh: true,
        }),
      );
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
      // Диалог снова ведёт бот, а значит ресепшену он больше не доступен: если
      // вернуть его на ту же страницу, человек упрётся в голое «недостаточно прав».
      return reply.redirect(req.staff!.role === 'admin' ? chatUrl(convo.id) : '/console');
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
        // Ошибка возвращается НА экран диалога: отдельная страница-заглушка
        // стирала набранный менеджером текст вместе с контекстом.
        const msg = maskPII(result.error ?? 'не удалось отправить');
        return reply.redirect(
          `${chatUrl(convo.id)}?err=${encodeURIComponent(msg)}&draft=${encodeURIComponent(text)}`,
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
    // --- Знания: что бот знает и как говорит ------------------------------------
    // Правка действует со следующего сообщения гостя: движок читает эти записи
    // на каждом ходу, поэтому ни редеплоя, ни разработчика не требуется.

    const KB_KINDS: Array<{
      key: 'fact' | 'tone' | 'source';
      label: string;
      one: string;
      none: string;
    }> = [
      { key: 'fact', label: 'Факты', one: 'факт', none: 'Фактов пока нет' },
      { key: 'tone', label: 'Как говорить', one: 'правило общения', none: 'Правил общения пока нет' },
      { key: 'source', label: 'Источники', one: 'источник', none: 'Источников пока нет' },
    ];

    /**
     * Состояние источника словами: владелец должен видеть, прочитал бот страницу
     * или нет, не заглядывая в логи. Молчание тут читалось бы как «всё работает».
     */
    const sourceStatus = (e: KbEntry): string => {
      if (e.fetchError) {
        return `<p class="card__meta" style="color:var(--err-tx)">Не удалось прочитать: ${escapeHtml(e.fetchError)}${
          e.fetchedAt ? ` · бот пока пользуется текстом, прочитанным ${escapeHtml(agoLabel(e.fetchedAt))}` : ''
        }</p>`;
      }
      if (e.fetchedAt) {
        return `<p class="card__meta" style="color:var(--ok)">Прочитано ${escapeHtml(agoLabel(e.fetchedAt))} — бот использует эту страницу</p>`;
      }
      return `<p class="card__meta">Ещё не прочитано — бот прочитает страницу в течение часа</p>`;
    };

    const kbKindOf = (v: unknown): 'fact' | 'tone' | 'source' =>
      v === 'tone' ? 'tone' : v === 'source' ? 'source' : 'fact';

    const kbHead = (kind: string, prop: string, scoped = false): string => {
      const kindPills = pills([
        ...KB_KINDS.map((k) => ({
          href: `/console/kb?kind=${k.key}&property=${encodeURIComponent(prop)}`,
          label: k.label,
          active: k.key === kind,
        })),
        { href: '/console/content', label: 'Акции', active: false },
      ]);
      const propPills = scoped
        ? ''
        : pills([
            { href: `/console/kb?kind=${kind}&property=`, label: 'Вся сеть', active: prop === '' },
            ...PROPERTY_KEYS.map((k) => ({
              href: `/console/kb?kind=${kind}&property=${k}`,
              label: propertyLabel(k),
              active: prop === k,
            })),
          ]);
      return (
        kindPills +
        propPills +
        `<p class="note">${scoped ? 'Вы видите записи своего отеля и общие для сети. ' : 'Записи из «Вся сеть» действуют во всех четырёх отелях. '}` +
        `Изменения бот применит со следующего сообщения гостя — перезапуск не нужен.</p>`
      );
    };

    scope.get('/console/kb', { preHandler: requireRole('admin') }, async (req, reply) => {
      const staff = req.staff!;
      const q = req.query as {
        kind?: string;
        property?: string;
        saved?: string;
        readerr?: string;
        read?: string;
      };
      const kind = kbKindOf(q.kind);
      // Сотрудник, привязанный к отелю, всегда смотрит на свой — выбор ему не предлагается.
      const prop = staff.property || (typeof q.property === 'string' ? q.property : '');
      const kindMeta = KB_KINDS.find((k) => k.key === kind)!;
      const one = kindMeta.one;

      const entries = (store.listKbEntries?.(prop || undefined, kind) ?? []).filter(
        (e: KbEntry) => e.kind === kind,
      );

      const cards = entries
        .map((e: KbEntry) => {
          const on = Boolean(e.active);
          const inherited = prop !== '' && !e.property;
          const meta = [
            propertyLabel(e.property),
            inherited ? 'из общих' : '',
            e.updatedAt
              ? `изменено ${new Date(e.updatedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}`
              : '',
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            `<a class="card${on ? '' : ' card--off'}" href="/console/kb/${e.id}">` +
            `<div class="card__top"><span class="card__who">${escapeHtml(e.title || (e.url ?? 'Без заголовка'))}</span>` +
            `<span style="margin-left:auto">${on ? badge('on', 'включено') : badge('off', 'выключено', true)}</span></div>` +
            `<p class="card__body">${escapeHtml(e.url && kind === 'source' ? e.url : e.body)}</p>` +
            (kind === 'source' ? sourceStatus(e) : '') +
            `<p class="card__meta">${escapeHtml(meta)}</p></a>`
          );
        })
        .join('');

      const templates =
        kind === 'fact'
          ? `<div class="stack" style="margin-top:12px">` +
            ['Поздний выезд', 'Завтрак', 'Парковка', 'Дети и доп. кровати', 'Животные', 'Трансфер']
              .map((t) =>
                btn(t, {
                  variant: 'secondary',
                  sm: true,
                  href: `/console/kb/new?kind=fact&property=${encodeURIComponent(prop)}&title=${encodeURIComponent(t)}`,
                }),
              )
              .join('') +
            `</div>`
          : '';

      const empty = emptyState(
        kindMeta.none,
        kind === 'fact'
          ? 'Бот уже знает то, что приходит из Exely: номера, услуги, цены. Добавьте то, чего там нет.'
          : kind === 'tone'
            ? 'Здесь вы объясняете боту, как разговаривать с гостями: что подчёркивать, а чего избегать.'
            : 'Дайте ссылку на страницу с новой информацией — бот будет учитывать её в ответах.',
        templates,
      );

      const saved = q.read
        ? banner('ok', 'Страница прочитана. Бот будет пользоваться ею со следующего сообщения гостя и перечитает её сам, когда она изменится.')
        : q.readerr
        ? banner('err', `Страницу прочитать не удалось: ${escapeHtml(q.readerr)}`)
        : q.saved
          ? banner('ok', 'Изменения сохранены. Бот применит их со следующего сообщения гостя.')
          : '';

      const body =
        `<h1>Знания</h1>` +
        kbHead(kind, prop, Boolean(staff.property)) +
        saved +
        `<div class="stack" style="margin-bottom:16px">` +
        btn(`+ Добавить ${one}`, {
          variant: 'primary',
          href: `/console/kb/new?kind=${kind}&property=${encodeURIComponent(prop)}`,
        }) +
        `</div>` +
        (cards || empty);

      return sendHtml(
        reply,
        shell('Знания', body, {
          staff,
          csrf: csrfTokenFor(req.sessionToken!),
          active: '/console/kb',
          waiting: waitingFor(store, staff).length,
        }),
      );
    });

    /** Редактор одной записи — экрана правки не существовало вовсе. */
    const kbEditor = (
      req: FastifyRequest,
      entry: Partial<KbEntry> & { kind: 'fact' | 'tone' | 'source' },
      isNew: boolean,
    ): string => {
      const staff = req.staff!;
      const csrf = csrfTokenFor(req.sessionToken!);
      const one = KB_KINDS.find((k) => k.key === entry.kind)!.one;
      const prop = entry.property ?? '';
      const action = isNew ? '/console/kb/add' : `/console/kb/${entry.id}`;
      const head = entry.kind === 'tone' ? 'ПРАВИЛА ОБЩЕНИЯ ОТ ОТЕЛЯ:' : 'ДОПОЛНИТЕЛЬНЫЕ СВЕДЕНИЯ ОТ ОТЕЛЯ:';

      const propPicker =
        `<div class="field"><label for="property">Отель</label>` +
        `<select name="property" id="property">` +
        [['', 'Вся сеть'], ...PROPERTY_KEYS.map((k) => [k, propertyLabel(k)])]
          .map(([v, l]) => `<option value="${v}"${v === prop ? ' selected' : ''}>${escapeHtml(l)}</option>`)
          .join('') +
        `</select>` +
        `<p class="hint">«Вся сеть» — запись увидят все четыре отеля.</p></div>`;

      const sourceField =
        entry.kind === 'source'
          ? field('url', 'Ссылка на страницу', {
              type: 'url',
              value: entry.url ?? '',
              required: true,
              placeholder: 'https://kazzhol.com/…',
              hint: 'Бот будет учитывать информацию с этой страницы в ответах гостям.',
            })
          : `<details style="margin-bottom:16px"><summary class="note">+ добавить ссылку на страницу сайта</summary>` +
            field('url', 'Ссылка (необязательно)', { type: 'url', value: entry.url ?? '' }) +
            `</details>`;

      return (
        `<div class="narrow"><h1>${isNew ? `Новый ${one}` : `Изменить ${one}`}</h1>` +
        `<form method="post" action="${action}" data-once>` +
        `<input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">` +
        `<input type="hidden" name="kind" value="${entry.kind}">` +
        (entry.kind === 'source' ? sourceField : '') +
        field('title', 'Заголовок', {
          value: entry.title ?? '',
          required: entry.kind !== 'source',
          placeholder: 'Например: Поздний выезд',
          hint: 'Коротко, о чём это.',
        }) +
        field('body', entry.kind === 'tone' ? 'Правило общения' : 'Текст', {
          textarea: true,
          rows: 6,
          value: entry.body ?? '',
          required: entry.kind !== 'source',
          hint:
            entry.kind === 'tone'
              ? 'Например: «Всегда предлагайте ранний заезд, если гость прилетает утром».'
              : 'Пишите так, как объяснили бы новому сотруднику.',
        }) +
        `<div class="banner banner--warn" id="price-warn" hidden>Здесь указана сумма. Цену на номер бот всегда берёт ` +
        `из системы бронирования на даты гостя — опишите условие словами.</div>` +
        (entry.kind === 'source' ? '' : sourceField) +
        propPicker +
        `<div class="field"><label>Что увидит бот</label>` +
        `<div class="preview" id="kb-preview" data-head="${escapeHtml(head)}"></div>` +
        `<p class="hint">Ваш текст уходит боту дословно, вот в таком виде.</p></div>` +
        `<div class="sticky-actions">` +
        btn('Сохранить', { variant: 'primary' }) +
        (isNew ? '' : btn('Отмена', { variant: 'ghost', href: `/console/kb?kind=${entry.kind}` })) +
        `</div></form>` +
        (!isNew && entry.kind === 'source' && deps.refreshSource
          ? `<form method="post" action="/console/kb/${entry.id}/read" data-once style="margin-top:16px">` +
            `<input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">` +
            btn('Прочитать страницу сейчас', { variant: 'secondary', attrs: 'data-busy="Читаю…"' }) +
            `<p class="note">Обычно бот перечитывает источники сам, раз в несколько часов.</p></form>`
          : '') +
        (isNew
          ? ''
          : `<form method="post" action="/console/kb/${entry.id}/archive" style="margin-top:16px">` +
            `<input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">` +
            btn('В архив', { variant: 'danger' }) +
            `<p class="note">Запись перестанет влиять на ответы, но её можно вернуть.</p></form>`) +
        `</div>`
      );
    };

    scope.get('/console/kb/new', { preHandler: requireRole('admin') }, async (req, reply) => {
      const q = req.query as { kind?: string; property?: string; title?: string };
      const staff = req.staff!;
      const body = kbEditor(
        req,
        { kind: kbKindOf(q.kind), property: q.property ?? '', title: q.title ?? '', body: '', active: 1 },
        true,
      );
      return sendHtml(
        reply,
        shell('Новая запись', body, {
          staff,
          csrf: csrfTokenFor(req.sessionToken!),
          active: '/console/kb',
          waiting: waitingFor(store, staff).length,
          back: { href: '/console/kb', label: 'Знания' },
        }),
      );
    });

    scope.get('/console/kb/archive', { preHandler: requireRole('admin') }, async (req, reply) => {
      const staff = req.staff!;
      const csrf = csrfTokenFor(req.sessionToken!);
      const rows = (store.listKbEntries?.(undefined, undefined, true) ?? [])
        .filter((e: KbEntry) => e.kind === 'fact' || e.kind === 'tone' || e.kind === 'source')
        .map(
          (e: KbEntry) =>
            `<div class="card"><div class="card__top"><span class="card__who">${escapeHtml(e.title || 'Без заголовка')}</span></div>` +
            `<p class="card__body">${escapeHtml(e.body)}</p>` +
            `<div class="stack" style="margin-top:8px">` +
            `<form method="post" action="/console/kb/${e.id}/restore" class="inline">` +
            `<input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">` +
            btn('Вернуть', { variant: 'secondary', sm: true }) +
            `</form>` +
            `<form method="post" action="/console/kb/delete" class="inline">` +
            `<input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">` +
            `<input type="hidden" name="id" value="${e.id}">` +
            btn('Удалить навсегда', { variant: 'danger', sm: true }) +
            `</form></div></div>`,
        )
        .join('');
      const body =
        `<div class="narrow"><h1>Архив знаний</h1>` +
        `<p class="note">Эти записи не влияют на ответы бота. Их можно вернуть или удалить навсегда.</p>` +
        (rows || emptyState('Архив пуст', 'Сюда попадают записи, которые вы убрали из работы.')) +
        `</div>`;
      return sendHtml(
        reply,
        shell('Архив знаний', body, {
          staff,
          csrf,
          active: '/console/kb',
          waiting: waitingFor(store, staff).length,
          back: { href: '/console/kb', label: 'Знания' },
        }),
      );
    });

    scope.get('/console/kb/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      const entry = (store.listKbEntries?.(undefined, undefined) ?? []).find(
        (e: KbEntry) => Number(e.id) === id,
      );
      if (!entry) return reply.redirect('/console/kb');
      const staff = req.staff!;
      return sendHtml(
        reply,
        shell(`Изменить ${KB_KINDS.find((k) => k.key === entry.kind)?.one ?? 'запись'}`, kbEditor(req, entry as KbEntry & { kind: 'fact' }, false), {
          staff,
          csrf: csrfTokenFor(req.sessionToken!),
          active: '/console/kb',
          waiting: waitingFor(store, staff).length,
          back: { href: '/console/kb', label: 'Знания' },
        }),
      );
    });

    scope.post('/console/kb/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      const b = req.body as Record<string, string>;
      store.updateKbEntry?.(id, {
        title: (b.title ?? '').trim(),
        body: (b.body ?? '').trim(),
        url: (b.url ?? '').trim() || null,
        // Отель тоже сохраняется: селект рисовался, но правка отбрасывалась,
        // и владелец оставался уверен, что запись стала отельной.
        property: (b.property ?? '').trim(),
      });
      return reply.redirect(`/console/kb?kind=${kbKindOf(b.kind)}&saved=1`);
    });

    scope.post('/console/kb/:id/read', { preHandler: requireRole('admin') }, async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      const entry = store.getKbEntry?.(id);
      if (!entry || !deps.refreshSource) return reply.redirect('/console/kb?kind=source');
      const res = await deps.refreshSource(entry);
      return reply.redirect(
        `/console/kb?kind=source&${res.ok ? 'saved=1' : `readerr=${encodeURIComponent(res.error ?? 'не получилось')}`}`,
      );
    });

    scope.post('/console/kb/:id/archive', { preHandler: requireRole('admin') }, async (req, reply) => {
      store.archiveKbEntry?.(Number((req.params as { id: string }).id), true);
      return reply.redirect('/console/kb?saved=1');
    });

    scope.post('/console/kb/:id/restore', { preHandler: requireRole('admin') }, async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      store.archiveKbEntry?.(id, false);
      // Архивация гасит active — при возврате его нужно поднять, иначе запись
      // «вернулась», но на ответы бота по-прежнему не влияет, и включить её нечем.
      store.updateKbEntry?.(id, { active: true });
      return reply.redirect('/console/kb/archive');
    });

    scope.post('/console/kb/add', { preHandler: requireRole('admin') }, async (req, reply) => {
      const b = req.body as Record<string, string>;
      const kind = b.kind === 'tone' ? 'tone' : b.kind === 'source' ? 'source' : 'fact';
      const bodyText = (b.body ?? '').trim();
      const url = (b.url ?? '').trim();
      // Источник без ссылки и факт без текста бессмысленны — молча не сохраняем мусор.
      if (kind === 'source' ? url === '' : bodyText === '') {
        return reply.redirect(`/console/kb?kind=${kind}`);
      }
      const newId = store.addKbEntry?.({
        property: (b.property ?? '').trim(),
        kind,
        title: (b.title ?? '').trim(),
        body: bodyText || (kind === 'source' ? `Источник: ${url}` : ''),
        url: url || null,
        active: true,
      });

      // Ссылку читаем сразу: человек только что её вставил и должен тут же узнать,
      // получилось или нет. Ждать час, чтобы увидеть «страница закрыта», — издевательство.
      if (kind === 'source' && newId && deps.refreshSource) {
        const created = store.getKbEntry?.(newId);
        if (created) {
          const res = await deps.refreshSource(created);
          if (!res.ok) {
            return reply.redirect(
              `/console/kb?kind=source&readerr=${encodeURIComponent(res.error ?? 'не получилось')}`,
            );
          }
          return reply.redirect('/console/kb?kind=source&read=1');
        }
      }
      return reply.redirect(`/console/kb?kind=${kind}&saved=1`);
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
      const q = req.query as { added?: string };

      const KIND_LABEL: Record<string, string> = {
        promo: 'акция',
        announcement: 'анонс',
        fact: 'факт',
        rate_plan: 'тариф',
      };
      const period = (c: HotelContent): string => {
        if (!c.startsAt && !c.endsAt) return 'бессрочно';
        const d = (v?: string | null): string =>
          v ? new Date(v).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : '';
        if (c.endsAt && !c.startsAt) return `действует до ${d(c.endsAt)}`;
        if (c.startsAt && !c.endsAt) return `с ${d(c.startsAt)}`;
        return `${d(c.startsAt)} — ${d(c.endsAt)}`;
      };

      const rows = store.listContentForAdmin();
      const cards = rows.length
        ? rows
            .map(
              (c) =>
                `<div class="card${c.active ? '' : ' card--off'}">` +
                `<div class="card__top"><span class="card__who">${escapeHtml(c.title || KIND_LABEL[c.kind] || c.kind)}</span>` +
                `<span style="margin-left:auto">${c.active ? badge('on', 'включено') : badge('off', 'выключено', true)}</span></div>` +
                `<p class="card__body">${escapeHtml(c.body)}</p>` +
                `<p class="card__meta">${escapeHtml(propertyLabel(c.property))} · ${escapeHtml(KIND_LABEL[c.kind] ?? c.kind)} · ${escapeHtml(period(c))}</p>` +
                `<div class="stack" style="margin-top:8px">` +
                `<form method="post" action="/console/content/toggle" class="inline">${csrfField}` +
                `<input type="hidden" name="id" value="${escapeHtml(c.id)}">` +
                btn(c.active ? 'Выключить' : 'Включить', { variant: 'secondary', sm: true }) +
                `</form>` +
                `<details class="more"><summary>⋯</summary><div class="pop">` +
                `<form method="post" action="/console/content/delete">${csrfField}` +
                `<input type="hidden" name="id" value="${escapeHtml(c.id)}">` +
                `<button type="submit" style="color:var(--err-tx)">Удалить навсегда</button></form>` +
                `</div></details></div></div>`,
            )
            .join('')
        : emptyState(
            'Акций пока нет',
            'Добавьте первую — бот расскажет о ней гостю со следующего сообщения.',
          );

      const hotelOpts = PROPERTY_KEYS.map(
        (k) => `<option value="${k}">${escapeHtml(propertyLabel(k))}</option>`,
      ).join('');
      const kindOpts = CONTENT_KINDS.map(
        (k) => `<option value="${k}">${escapeHtml(KIND_LABEL[k] ?? k)}</option>`,
      ).join('');

      const form =
        `<details style="margin-top:24px"><summary class="btn btn--primary" style="list-style:none">+ Добавить акцию</summary>` +
        `<form method="post" action="/console/content/add" data-once style="margin-top:16px">${csrfField}` +
        `<div class="field"><label for="c-property">Отель</label>` +
        `<select name="property" id="c-property" required>${hotelOpts}</select></div>` +
        `<div class="field"><label for="c-kind">Тип</label>` +
        `<select name="kind" id="c-kind">${kindOpts}</select></div>` +
        field('title', 'Заголовок', { placeholder: 'Например: Осенняя акция' }) +
        field('body', 'Текст', {
          textarea: true,
          rows: 4,
          required: true,
          hint: 'Опишите условия словами: что за акция и для кого.',
        }) +
        banner(
          'warn',
          'Не указывайте цену за номер — бот всегда берёт её из системы бронирования на даты гостя.',
        ) +
        `<div class="field"><label for="startsAt">Действует с</label>` +
        `<input type="date" name="startsAt" id="startsAt"></div>` +
        `<div class="field"><label for="endsAt">по</label>` +
        `<input type="date" name="endsAt" id="endsAt">` +
        `<p class="hint">Можно не заполнять — тогда акция действует бессрочно.</p></div>` +
        btn('Добавить', { variant: 'primary' }) +
        `</form></details>`;

      // Что бот берёт из Exely сам — внизу, это справка, а не работа владельца.
      const knowledgePanel = deps.knowledgeStatus
        ? `<details class="quiet" style="margin-top:32px"><summary>Что бот берёт из Exely сам</summary>` +
          `<p class="note">Номера, услуги и правила бот получает из Exely и обновляет сам — при запуске и каждые 12 часов. ` +
          `Цены всегда живые, на даты гостя.</p>` +
          deps
            .knowledgeStatus()
            .map(
              (st) =>
                `<div class="row"><span class="name">${escapeHtml(propertyLabel(st.property))}</span>` +
                `<span class="grow">${escapeHtml(
                  st.syncedAt ? `обновлено ${agoLabel(st.syncedAt)}` : 'используются статичные знания',
                )}</span></div>`,
            )
            .join('') +
          (deps.refreshKnowledge
            ? `<form method="post" action="/console/knowledge/refresh" data-once style="margin-top:12px">${csrfField}` +
              btn('Обновить сейчас', { variant: 'secondary', sm: true }) +
              `</form>`
            : '') +
          `</details>`
        : '';

      const body =
        `<div class="narrow"><h1>Акции и анонсы</h1>` +
        pills([
          { href: '/console/kb?kind=fact', label: 'Факты', active: false },
          { href: '/console/kb?kind=tone', label: 'Как говорить', active: false },
          { href: '/console/kb?kind=source', label: 'Источники', active: false },
          { href: '/console/content', label: 'Акции', active: true },
        ]) +
        `<p class="note">Акция действует до указанной даты и исчезает сама. ` +
        `Изменения бот применит со следующего сообщения гостя.</p>` +
        (q.added ? banner('ok', 'Акция добавлена.') : '') +
        cards +
        form +
        knowledgePanel +
        `</div>`;

      return sendHtml(
        reply,
        shell('Акции', body, {
          staff,
          csrf,
          active: '/console/kb',
          back: { href: '/console/kb', label: 'Знания' },
          waiting: waitingFor(store, staff).length,
        }),
      );
    });

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
      return reply.redirect('/console/content?added=1');
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

    // --- Заявки: лиды, брони и мероприятия на одном экране -----------------------
    // Три вкладки вместо трёх пунктов меню: «Лиды» и «Брони» на слух не различались.

    scope.get('/console/requests', async (req, reply) => {
      const staff = req.staff!;
      const csrf = csrfTokenFor(req.sessionToken!);
      const csrfField = `<input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">`;
      const q = req.query as { tab?: string };
      const admin = staff.role === 'admin';
      // Ресепшен работает только с мероприятиями: показывать ему вкладку,
      // которая всегда пуста, — это обещание данных, которых он не увидит.
      const tab = !admin ? 'mice' : q.tab === 'bookings' ? 'bookings' : q.tab === 'mice' ? 'mice' : 'all';

      const tel = (phone?: string | null): string =>
        phone ? `<a href="tel:${escapeHtml(phone.replace(/[^\d+]/g, ''))}">${escapeHtml(phone)}</a>` : '';

      const tabs = pills([
        ...(admin ? [{ href: '/console/requests?tab=all', label: 'Все', active: tab === 'all' }] : []),
        ...(admin ? [{ href: '/console/requests?tab=bookings', label: 'Брони', active: tab === 'bookings' }] : []),
        { href: '/console/requests?tab=mice', label: 'Мероприятия', active: tab === 'mice' },
      ]);

      let table = '';
      if (tab === 'bookings' && admin) {
        const rows = store
          .listBookings()
          .filter((b) => canSee(staff, b.property))
          .map(
            (b) =>
              `<tr><td data-label="Номер">${escapeHtml(b.exelyNumber)}</td>` +
              `<td data-label="Статус">${escapeHtml(b.status)}</td>` +
              `<td data-label="Отель">${escapeHtml(propertyLabel(b.property))}</td>` +
              `<td data-label="Даты">${escapeHtml(b.checkIn)} → ${escapeHtml(b.checkOut)}</td>` +
              `<td data-label="Гостей">${escapeHtml(b.guests)}</td>` +
              `<td data-label="Категория">${escapeHtml(b.roomType)}</td>` +
              `<td data-label="Гость">${escapeHtml(b.guestName ?? '')} ${tel(b.guestPhone)}</td>` +
              `<td data-label="Сумма">${escapeHtml(b.total ?? '')} ${escapeHtml(b.currency ?? '')}</td></tr>`,
          )
          .join('');
        table = rows
          ? `<div class="tablewrap"><table><thead><tr><th>Номер</th><th>Статус</th><th>Отель</th><th>Даты</th>` +
            `<th>Гостей</th><th>Категория</th><th>Гость</th><th>Сумма</th></tr></thead><tbody>${rows}</tbody></table></div>`
          : emptyState('Броней пока нет', 'Здесь появятся подтверждённые брони гостей.');
      } else if (tab === 'mice') {
        const rows = store
          .listMice()
          .filter((m) => canSee(staff, m.property))
          .map(
            (m) =>
              `<tr><td data-label="Отель">${escapeHtml(propertyLabel(m.property))}</td>` +
              `<td data-label="Дата">${escapeHtml(m.eventDate ?? '')}</td>` +
              `<td data-label="Человек">${escapeHtml(m.peopleCount ?? '')}</td>` +
              `<td data-label="Залы / кейтеринг">${escapeHtml(m.halls ?? '')} ${escapeHtml(m.catering ?? '')}</td>` +
              `<td data-label="Контакт">${escapeHtml(m.contactName ?? '')} ${tel(m.contactPhone)}</td>` +
              `<td data-label="Заметки">${escapeHtml(m.notes ?? '')}</td>` +
              `<td data-label="Статус">${escapeHtml(m.status === 'done' ? 'закрыта' : 'в работе')}</td>` +
              `<td data-label="Сменить"><form class="inline" method="post" action="/console/mice/${escapeHtml(m.id)}/status">${csrfField}` +
              `<select name="status">` +
              `<option value="in_work"${m.status === 'done' ? '' : ' selected'}>в работе</option>` +
              `<option value="done"${m.status === 'done' ? ' selected' : ''}>закрыта</option></select>` +
              btn('Сохранить', { variant: 'secondary', sm: true }) +
              `</form></td></tr>`,
          )
          .join('');
        table = rows
          ? `<div class="tablewrap"><table><thead><tr><th>Отель</th><th>Дата</th><th>Человек</th>` +
            `<th>Залы / кейтеринг</th><th>Контакт</th><th>Заметки</th><th>Статус</th><th>Сменить</th></tr></thead>` +
            `<tbody>${rows}</tbody></table></div>`
          : emptyState('Заявок на мероприятия нет', 'Сюда попадают запросы на конференц-залы и банкеты.');
      } else {
        const rows = (admin ? store.listLeads() : [])
          // У лида нет своего отеля — берём его у диалога, из которого лид пришёл.
          .filter((l) => canSee(staff, store.getConversation(l.conversationId)?.property))
          .map(
            (l) =>
              `<tr><td data-label="Что нужно">${escapeHtml(l.kind)} <span class="badge badge--off">ещё не бронь</span></td>` +
              `<td data-label="Даты">${escapeHtml(l.checkIn ?? '')} ${escapeHtml(l.checkOut ?? '')}</td>` +
              `<td data-label="Контакт">${escapeHtml(l.contactName ?? '')} ${tel(l.contactPhone)}</td>` +
              `<td data-label="Детали">${escapeHtml(l.specialRequests ?? '')}</td>` +
              `<td data-label="Создан">${escapeHtml(ago(l.createdAt))}</td>` +
              `<td data-label=""><a href="${chatUrl(l.conversationId)}">Открыть диалог</a></td></tr>`,
          )
          .join('');
        table = rows
          ? `<div class="tablewrap"><table><thead><tr><th>Что нужно</th><th>Даты</th><th>Контакт</th>` +
            `<th>Детали</th><th>Создан</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
          : emptyState('Заявок пока нет', 'Когда бот запишет контакт гостя, заявка появится здесь.');
      }

      return sendHtml(
        reply,
        shell('Заявки', `<h1>Заявки</h1>${tabs}${table}`, {
          staff,
          csrf,
          active: '/console/requests',
          waiting: waitingFor(store, staff).length,
        }),
      );
    });

    scope.get('/console/leads', async (_req, reply) => reply.redirect('/console/requests?tab=all'));
    scope.get('/console/bookings', async (_req, reply) => reply.redirect('/console/requests?tab=bookings'));
    scope.get('/console/mice', async (_req, reply) => reply.redirect('/console/requests?tab=mice'));

    // --- Итоги --------------------------------------------------------------------

    scope.get('/console/summary', { preHandler: requireRole('admin') }, async (req, reply) => {
      const staff = req.staff!;
      const m = deps.metricsSummary(store);
      const slaOk = m.p95ReplyMs <= SLA_TARGET_MS;
      const tile = (num: string | number, cap: string): string =>
        `<div class="tile"><div class="num">${escapeHtml(num)}</div><div class="cap">${escapeHtml(cap)}</div></div>`;
      const langs =
        Object.entries(m.byLanguage)
          .map(([lang, n]) => `${escapeHtml(lang)}: ${escapeHtml(n)}`)
          .join(', ') || '—';
      const body =
        `<h1>Итоги за сегодня</h1><div id="live">` +
        `<p class="lede">Сегодня бот ответил ${m.dialogsToday} гостям, ${m.escalationsToday} передал вам.</p>` +
        `<div class="tiles">` +
        tile(m.dialogsToday, 'диалогов') +
        tile(m.escalationsToday, 'передано вам') +
        tile(m.bookingsToday, 'броней') +
        tile(m.messagesToday, 'сообщений') +
        `</div>` +
        `<p>${slaOk ? badge('on', 'Скорость ответа в норме') : badge('wait', 'Бот отвечает медленнее обычного')}</p>` +
        `<details class="quiet"><summary>Техника</summary>` +
        `<p class="note">p50 ${escapeHtml(m.p50ReplyMs)} мс · p95 ${escapeHtml(m.p95ReplyMs)} мс · цель ≤ ${SLA_TARGET_MS} мс<br>` +
        `Upsell: предложено ${escapeHtml(m.upsellOffered)}, принято ${escapeHtml(m.upsellAccepted)}<br>` +
        `Языки входящих: ${langs}</p></details></div>`;
      return sendHtml(
        reply,
        shell('Итоги', body, {
          staff,
          csrf: csrfTokenFor(req.sessionToken!),
          active: '/console/summary',
          waiting: waitingFor(store, staff).length,
        }),
      );
    });

    scope.post('/console/mice/:id/status', async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const status = typeof body.status === 'string' ? body.status : '';
      if (!Number.isInteger(id) || (status !== 'in_work' && status !== 'done')) {
        return sendHtml(
          reply,
          shell(
            'Ошибка',
            `<div class="narrow">${banner('err', 'Недопустимый статус заявки.')}` +
              btn('Назад к заявкам', { variant: 'secondary', href: '/console/requests?tab=mice' }) +
              `</div>`,
            { staff: req.staff, csrf: csrfTokenFor(req.sessionToken!), active: '/console/requests' },
          ),
          400,
        );
      }
      store.setMiceStatus(id, status);
      return reply.redirect('/console/requests?tab=mice');
    });

    // --- Профиль: смена пароля -----------------------------------------------------
    // Пароли выдаются при заведении учётки; без этого экрана сменить их может
    // только разработчик, и передавать панель отелю в таком виде нельзя.

    const profilePage = (
      staff: AuthedStaff,
      csrf: string,
      msg?: { kind: 'ok' | 'err'; text: string },
    ): string =>
      shell(
        'Профиль',
        `<div class="narrow"><h1>Профиль</h1>` +
          (msg ? banner(msg.kind, escapeHtml(msg.text)) : '') +
          `<div class="card"><div class="card__top">` +
          `<span class="card__who">${escapeHtml(staff.login)}</span></div>` +
          `<p class="card__meta">${escapeHtml(
            (staff.role === 'admin' ? 'Владелец' : 'Ресепшен') +
              ' · ' +
              (staff.property ? propertyLabel(staff.property) : 'вся сеть'),
          )}</p></div>` +
          `<h2 style="font-size:15px;color:var(--text-2);margin:24px 0 12px">Сменить пароль</h2>` +
          `<form method="post" action="/console/profile" data-once>` +
          `<input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">` +
          field('current', 'Текущий пароль', {
            type: 'password',
            required: true,
            attrs: 'autocomplete="current-password"',
          }) +
          field('next', 'Новый пароль', {
            type: 'password',
            required: true,
            attrs: 'autocomplete="new-password" minlength="8"',
            hint: 'Не короче 8 знаков. Запишите его — восстановить пароль сама панель не умеет.',
          }) +
          field('repeat', 'Новый пароль ещё раз', {
            type: 'password',
            required: true,
            attrs: 'autocomplete="new-password"',
          }) +
          btn('Сохранить пароль', { variant: 'primary' }) +
          `</form></div>`,
        { staff, csrf, active: '/console', waiting: waitingFor(store, staff).length },
      );

    scope.get('/console/profile', async (req, reply) =>
      sendHtml(reply, profilePage(req.staff!, csrfTokenFor(req.sessionToken!))),
    );

    scope.post('/console/profile', async (req, reply) => {
      const staff = req.staff!;
      const csrf = csrfTokenFor(req.sessionToken!);
      const b = (req.body ?? {}) as Record<string, string>;
      const record = store.findStaffByLogin(staff.login);
      const fail = (text: string) =>
        sendHtml(reply, profilePage(staff, csrf, { kind: 'err', text }), 400);

      if (!record || !verifyPassword(b.current ?? '', record.passHash)) {
        return fail('Текущий пароль не подошёл. Проверьте раскладку и попробуйте ещё раз.');
      }
      if ((b.next ?? '').length < 8) return fail('Новый пароль должен быть не короче 8 знаков.');
      if (b.next !== b.repeat) return fail('Пароли не совпали — введите новый пароль дважды одинаково.');
      if (b.next === b.current) return fail('Новый пароль совпадает со старым.');

      store.setStaffPassword?.(record.id, hashPassword(b.next));
      store.recordEvent('password_changed', { payload: { staff: staff.login } });
      return sendHtml(reply, profilePage(staff, csrf, { kind: 'ok', text: 'Пароль изменён.' }));
    });

    // --- Data deletion (admin only) --------------------------------------------------------------

    const deletionForm = (staff: AuthedStaff, csrf: string, note?: string): string =>
      shell(
        'Удаление данных гостя',
        `<div class="narrow"><h1>Удаление данных гостя</h1>` +
          (note ? banner('err', escapeHtml(note)) : '') +
          `<p class="note">Стирает историю диалога и маскирует имя и телефон в заявках, бронях ` +
          `и заявках на мероприятия. Отменить нельзя.</p>` +
          `<form method="post" action="/console/data-deletion" data-once>` +
          `<input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">` +
          field('conversationId', 'ID диалога', {
            required: true,
            placeholder: 'whatsapp:1112|7701…',
            hint: 'ID можно скопировать в самом диалоге — раздел «Технические данные».',
          }) +
          `<div class="field"><label style="font-weight:400;font-size:15px">` +
          `<input type="checkbox" name="confirm" style="width:auto;min-height:0;margin-right:8px">` +
          `Подтверждаю удаление по запросу гостя</label></div>` +
          btn('Удалить данные', { variant: 'danger' }) +
          `</form></div>`,
        { staff, csrf, active: '/console', waiting: waitingFor(store, staff).length },
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
        shell(
          'Готово',
          `<div class="narrow">` +
            banner('ok', `Данные диалога ${escapeHtml(conversationId)} удалены и замаскированы.`) +
            btn('Удалить ещё один', { variant: 'secondary', href: '/console/data-deletion' }) +
            `</div>`,
          { staff: req.staff, csrf, active: '/console' },
        ),
      );
    });
  });
}
