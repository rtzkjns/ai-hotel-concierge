import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';
import { Store } from '../src/store';
import { hashPassword, verifyPassword, csrfTokenFor, resetLoginAttempts } from '../src/console/auth';
import { registerConsoleRoutes, type SendToConversation } from '../src/console/routes';
import { CSS_HASH } from '../src/console/ui';
import { metricsSummary } from '../src/core/events';

// --- Harness -------------------------------------------------------------------

interface Harness {
  app: FastifyInstance;
  store: Store;
  sendCalls: Array<{ conversationId: string; text: string }>;
  sendResult: { ok: boolean; error?: string };
}

async function makeApp(): Promise<Harness> {
  const store = new Store(':memory:');
  store.createStaff('admin', hashPassword('admin-pass'), 'admin');
  store.createStaff('aigul', hashPassword('mice-pass'), 'mice_manager');
  // Ресепшен, привязанный к отелю: видит только своих гостей.
  store.createStaff('astana-desk', hashPassword('desk-pass'), 'mice_manager', 'astana');

  const harness: Partial<Harness> = { sendCalls: [], sendResult: { ok: true } };
  const sendToConversation: SendToConversation = async (convo, text) => {
    harness.sendCalls!.push({ conversationId: convo.id, text });
    return harness.sendResult!;
  };

  const app = await buildServer({
    engine: { handle: vi.fn(async () => null) },
    adapters: {},
    store,
    config: { whatsapp: { phoneNumberIds: {} } },
    extraRoutes: [
      (a) =>
        registerConsoleRoutes(a, {
          store,
          metricsSummary,
          sendToConversation,
          // Настоящий разбор файла: тест проверяет всю цепочку, а не заглушку.
          extractFile: async (buf: Buffer, filename: string) =>
            (await import('../src/knowledge/documents')).extractText(buf, filename),
          refreshSource: async (entry) => {
            // Подменяем сеть: важно, что панель зовёт вычитку и показывает её результат.
            if (entry.url?.includes('bad')) return { ok: false, error: 'Страница не найдена (404)' };
            store.updateKbEntry(entry.id, { body: `Со страницы ${entry.url}:\nСкидка 20% осенью.` });
            store.markKbFetched(entry.id, new Date().toISOString(), null);
            return { ok: true };
          },
        }),
    ],
  });
  harness.app = app;
  harness.store = store;
  return harness as Harness;
}

async function login(app: FastifyInstance, user: string, password: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/console/login',
    payload: `login=${encodeURIComponent(user)}&password=${encodeURIComponent(password)}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie ?? '');
  const token = /kz_session=([^;]+)/.exec(raw)?.[1];
  return { res, token, cookie: token ? `kz_session=${token}` : '' };
}

function form(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

async function post(
  app: FastifyInstance,
  url: string,
  cookie: string,
  csrf: string | undefined,
  fields: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url,
    payload: form(csrf === undefined ? fields : { ...fields, _csrf: csrf }),
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
  });
}

// --- Password hashing -------------------------------------------------------------

describe('console auth primitives', () => {
  it('hashPassword produces salt:hash and verifyPassword round-trips', () => {
    const stored = hashPassword('s3cret');
    expect(stored).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(verifyPassword('s3cret', stored)).toBe(true);
    expect(verifyPassword('wrong', stored)).toBe(false);
    expect(verifyPassword('s3cret', 'garbage-no-separator')).toBe(false);
  });

  it('two hashes of the same password differ (random salt)', () => {
    expect(hashPassword('x')).not.toBe(hashPassword('x'));
  });
});

// --- Login / logout ----------------------------------------------------------------

describe('console login', () => {
  it('valid credentials set an httpOnly session cookie and redirect to /console', async () => {
    const { app } = await makeApp();
    const { res, token } = await login(app, 'admin', 'admin-pass');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/console');
    expect(token).toBeTruthy();
    const raw = String(res.headers['set-cookie']);
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
    await app.close();
  });

  it('wrong password returns 401 and no cookie', async () => {
    const { app } = await makeApp();
    const { res, token } = await login(app, 'admin', 'nope');
    expect(res.statusCode).toBe(401);
    expect(token).toBeUndefined();
    await app.close();
  });

  it('unauthenticated /console/chats redirects to the login page', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/console/chats' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/console/login');
    await app.close();
  });

  it('logout deletes the session: the old cookie no longer works', async () => {
    const { app } = await makeApp();
    const { token, cookie } = await login(app, 'admin', 'admin-pass');
    const out = await post(app, '/console/logout', cookie, csrfTokenFor(token!));
    expect(out.statusCode).toBe(302);

    const after = await app.inject({ method: 'GET', url: '/console', headers: { cookie } });
    expect(after.statusCode).toBe(302);
    expect(after.headers.location).toBe('/console/login');
    await app.close();
  });
});

// --- Roles --------------------------------------------------------------------------

describe('console roles', () => {
  it('admin sees bookings and leads', async () => {
    const { app, store } = await makeApp();
    store.saveBooking({
      conversationId: 'webwidget:g1',
      property: 'almaty',
      exelyNumber: 'BK-100',
      status: 'confirmed',
      checkIn: '2026-08-10',
      checkOut: '2026-08-12',
      guests: 2,
      roomType: 'Standard',
      guestName: 'Ivan Petrov',
      guestPhone: '+77015556677',
      createdAt: new Date().toISOString(),
    });
    const { cookie } = await login(app, 'admin', 'admin-pass');

    const bookings = await app.inject({
      method: 'GET',
      url: '/console/requests?tab=bookings',
      headers: { cookie },
    });
    expect(bookings.statusCode).toBe(200);
    expect(bookings.body).toContain('BK-100');
    expect(bookings.body).toContain('Ivan Petrov');

    const leads = await app.inject({ method: 'GET', url: '/console/requests?tab=all', headers: { cookie } });
    expect(leads.statusCode).toBe(200);
    await app.close();
  });

  it('mice_manager sees no bookings or leads data, but can work requests and the inbox', async () => {
    const { app, store } = await makeApp();
    const bookingConvo = store.getOrCreateConversation('webwidget', 'guest-booked');
    store.saveBooking({
      conversationId: bookingConvo.id,
      exelyNumber: 'BK-777',
      status: 'confirmed',
      property: 'almaty',
      checkIn: '2026-09-01',
      checkOut: '2026-09-03',
      guests: 2,
      roomType: 'Standard',
      guestName: 'Ivan Petrov',
      guestPhone: '+77015556677',
      createdAt: new Date().toISOString(),
    });
    const { cookie } = await login(app, 'aigul', 'mice-pass');

    // Заявки открываются всем — но чужих данных на экране нет.
    const requests = await app.inject({
      method: 'GET',
      url: '/console/requests?tab=bookings',
      headers: { cookie },
    });
    expect(requests.statusCode).toBe(200);
    expect(requests.body).not.toContain('BK-777');
    expect(requests.body).not.toContain('Ivan Petrov');

    // Знания, итоги и удаление ПД остаются админскими.
    expect((await app.inject({ method: 'GET', url: '/console/kb', headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/console/summary', headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/console/data-deletion', headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/console', headers: { cookie } })).statusCode).toBe(200);
    await app.close();
  });

  it('a manager sees and can open ANY chat, with guest PII masked on shared screens', async () => {
    const { app, store } = await makeApp();
    const active = store.getOrCreateConversation('webwidget', 'guest-active');
    store.appendMessage(active.id, { role: 'user', content: 'мой номер +77014126353' });
    const handed = store.getOrCreateConversation('webwidget', 'guest-handed');
    store.appendMessage(handed.id, { role: 'user', content: 'позовите кого-нибудь, +77776665544' });
    store.setStatus(handed.id, 'handed_off');

    const { cookie } = await login(app, 'aigul', 'mice-pass');
    const list = await app.inject({ method: 'GET', url: '/console', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    // Гость показан человеческим именем, а не машинным id диалога.
    expect(list.body).toContain('Гость #');
    // Полный доступ: менеджер видит и переданный диалог, и тот, что ведёт бот.
    expect(list.body).toContain(`/console/chats/${encodeURIComponent(handed.id)}`);
    expect(list.body).toContain(`/console/chats/${encodeURIComponent(active.id)}`);
    expect(list.body).not.toContain('+77776665544'); // masked

    // И может открыть любой из них (просмотр + возможность ответить).
    const detail = await app.inject({
      method: 'GET',
      url: `/console/chats/${encodeURIComponent(active.id)}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    await app.close();
  });

  it('shows the right handoff state: bot answering, unclaimed, or led by you', async () => {
    const { app, store } = await makeApp();
    const bot = store.getOrCreateConversation('webwidget', 'st-bot');
    const free = store.getOrCreateConversation('webwidget', 'st-free');
    store.setStatus(free.id, 'handed_off');
    const mine = store.getOrCreateConversation('webwidget', 'st-mine');
    store.setStatus(mine.id, 'handed_off');
    store.setTakenBy(mine.id, 'admin');
    const { cookie } = await login(app, 'admin', 'admin-pass');
    const open = async (id: string) =>
      (await app.inject({ method: 'GET', url: `/console/chats/${encodeURIComponent(id)}`, headers: { cookie } })).body;

    expect(await open(bot.id)).toContain('Сейчас отвечает бот');
    // Переданный, но никем не взятый диалог не должен утверждать, что его уже ведут.
    const freeBody = await open(free.id);
    expect(freeBody).toContain('Гость ждёт человека');
    expect(freeBody).not.toContain('Вы ведёте диалог');
    expect(await open(mine.id)).toContain('Вы ведёте диалог');
    await app.close();
  });

  it('a manager can open any chat, including one a colleague is leading (read view)', async () => {
    const { app, store } = await makeApp();
    const taken = store.getOrCreateConversation('webwidget', 'guest-taken');
    store.setStatus(taken.id, 'handed_off');
    store.setTakenBy(taken.id, 'someone-else');
    const unclaimed = store.getOrCreateConversation('webwidget', 'guest-unclaimed');
    store.setStatus(unclaimed.id, 'handed_off');

    const { cookie } = await login(app, 'aigul', 'mice-pass');
    const list = await app.inject({ method: 'GET', url: '/console', headers: { cookie } });
    expect(list.body).toContain(`/console/chats/${encodeURIComponent(unclaimed.id)}`);
    // Полный доступ: диалог коллеги теперь тоже виден в списке.
    expect(list.body).toContain(`/console/chats/${encodeURIComponent(taken.id)}`);

    const detail = await app.inject({
      method: 'GET',
      url: `/console/chats/${encodeURIComponent(taken.id)}`,
      headers: { cookie },
    });
    // Открыть и прочитать можно, но перехватывать чужой диалог не предлагаем.
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain('someone-else');
    await app.close();
  });

  it('admin sees unmasked PII in the transcript', async () => {
    const { app, store } = await makeApp();
    const convo = store.getOrCreateConversation('webwidget', 'guest-1');
    store.appendMessage(convo.id, { role: 'user', content: 'тел +77014126353' });
    const { cookie } = await login(app, 'admin', 'admin-pass');
    const res = await app.inject({
      method: 'GET',
      url: `/console/chats/${encodeURIComponent(convo.id)}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('+77014126353');
    await app.close();
  });
});

// --- Takeover / release / send -------------------------------------------------------

describe('chat takeover and staff replies', () => {
  it('takeover flips status to handed_off and records a takeover event', async () => {
    const { app, store } = await makeApp();
    const convo = store.getOrCreateConversation('webwidget', 'guest-2');
    const { cookie, token } = await login(app, 'admin', 'admin-pass');

    const res = await post(
      app,
      `/console/chats/${encodeURIComponent(convo.id)}/takeover`,
      cookie,
      csrfTokenFor(token!),
    );
    expect(res.statusCode).toBe(302);
    expect(store.getConversation(convo.id)?.status).toBe('handed_off');
    const events = store.listEvents('1970-01-01');
    expect(events.some((e) => e.type === 'takeover' && e.conversationId === convo.id)).toBe(true);

    // Release brings the bot back.
    await post(app, `/console/chats/${encodeURIComponent(convo.id)}/release`, cookie, csrfTokenFor(token!));
    expect(store.getConversation(convo.id)?.status).toBe('active');
    expect(store.listEvents('1970-01-01').some((e) => e.type === 'release')).toBe(true);
    await app.close();
  });

  it('send calls the injected sender with plain text and stores it with the [менеджер] prefix', async () => {
    const { app, store, sendCalls } = await makeApp();
    const convo = store.getOrCreateConversation('webwidget', 'guest-3');
    store.setStatus(convo.id, 'handed_off');
    const { cookie, token } = await login(app, 'admin', 'admin-pass');

    const res = await post(
      app,
      `/console/chats/${encodeURIComponent(convo.id)}/send`,
      cookie,
      csrfTokenFor(token!),
      { text: 'сейчас всё решим' },
    );
    expect(res.statusCode).toBe(302);
    expect(sendCalls).toEqual([{ conversationId: convo.id, text: 'сейчас всё решим' }]);
    const history = store.getConversation(convo.id)!.history;
    expect(history[history.length - 1]).toMatchObject({
      role: 'assistant',
      content: '[менеджер] сейчас всё решим',
    });
    // Время проставляется хранилищем — на нём держатся часы и разделители дней в консоли.
    expect(history[history.length - 1].createdAt).toBeTruthy();
    await app.close();
  });

  it('send shows the sender error (guest offline) and stores nothing', async () => {
    const harness = await makeApp();
    const { app, store } = harness;
    harness.sendResult.ok = false;
    harness.sendResult.error = 'guest offline';
    const convo = store.getOrCreateConversation('webwidget', 'guest-4');
    const { cookie, token } = await login(app, 'admin', 'admin-pass');

    const res = await post(
      app,
      `/console/chats/${encodeURIComponent(convo.id)}/send`,
      cookie,
      csrfTokenFor(token!),
      { text: 'ау' },
    );
    // Ошибка возвращает менеджера в тот же диалог: набранный текст не теряется.
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('err=');
    expect(decodeURIComponent(res.headers.location as string)).toContain('guest offline');
    expect(store.getConversation(convo.id)!.history).toEqual([]);
    await app.close();
  });
});

// --- Регрессии, найденные разбором редизайна ------------------------------------------

describe('console redesign regressions', () => {
  it('serves the stylesheet without a session — the login screen must not render bare', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/console/app.v1.css' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
    expect(res.body).toContain('--brand');
    await app.close();
  });

  it('keeps the typed reply when delivery fails', async () => {
    const harness = await makeApp();
    const { app, store } = harness;
    harness.sendResult.ok = false;
    harness.sendResult.error = 'guest offline';
    const convo = store.getOrCreateConversation('webwidget', 'draft-1');
    store.setStatus(convo.id, 'handed_off');
    const { cookie, token } = await login(app, 'admin', 'admin-pass');

    const res = await post(app, `/console/chats/${encodeURIComponent(convo.id)}/send`, cookie, csrfTokenFor(token!), {
      text: 'Добрый день! Счёт на компанию подготовим сегодня.',
    });
    const back = await app.inject({
      method: 'GET',
      url: res.headers.location as string,
      headers: { cookie },
    });
    // Текст обязан вернуться в поле: баннер обещает именно это.
    expect(back.body).toContain('Счёт на компанию подготовим сегодня.');
    expect(back.body).toContain('Не доставлено');
    await app.close();
  });

  it('does not 500 when the delivery error contains a percent sign', async () => {
    const { app, store } = await makeApp();
    const convo = store.getOrCreateConversation('webwidget', 'pct-1');
    store.setStatus(convo.id, 'handed_off');
    const { cookie } = await login(app, 'admin', 'admin-pass');
    const res = await app.inject({
      method: 'GET',
      url: `/console/chats/${encodeURIComponent(convo.id)}?err=${encodeURIComponent('timeout 50%')}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('timeout 50%');
    await app.close();
  });

  it('saves a knowledge entry moved to another hotel instead of silently dropping it', async () => {
    const { app, store } = await makeApp();
    const id = store.addKbEntry({ property: '', kind: 'fact', title: 'Поздний выезд', body: 'до 16:00', url: null, active: true });
    const { cookie, token } = await login(app, 'admin', 'admin-pass');
    await post(app, `/console/kb/${id}`, cookie, csrfTokenFor(token!), {
      kind: 'fact',
      title: 'Поздний выезд',
      body: 'до 16:00',
      property: 'almaty',
    });
    expect(store.getKbEntry(id)?.property).toBe('almaty');
    await app.close();
  });

  it('restoring from the archive brings the entry back into service', async () => {
    const { app, store } = await makeApp();
    const id = store.addKbEntry({ property: '', kind: 'fact', title: 'Парковка', body: 'бесплатно', url: null, active: true });
    const { cookie, token } = await login(app, 'admin', 'admin-pass');
    await post(app, `/console/kb/${id}/archive`, cookie, csrfTokenFor(token!), {});
    expect(store.listKbEntries().some((e) => Number(e.id) === id)).toBe(false);
    await post(app, `/console/kb/${id}/restore`, cookie, csrfTokenFor(token!), {});
    const back = store.listKbEntries().find((e) => Number(e.id) === id);
    // Вернуть запись и оставить её выключенной — то же самое, что не вернуть.
    expect(back).toBeTruthy();
    expect(Boolean(back!.active)).toBe(true);
    await app.close();
  });

  it('sends a receptionist back to the inbox after handing a chat to the bot', async () => {
    const { app, store } = await makeApp();
    const convo = store.getOrCreateConversation('webwidget', 'rel-1');
    store.setStatus(convo.id, 'handed_off');
    store.setTakenBy(convo.id, 'aigul');
    const { cookie, token } = await login(app, 'aigul', 'mice-pass');
    const res = await post(app, `/console/chats/${encodeURIComponent(convo.id)}/release`, cookie, csrfTokenFor(token!), {});
    // Диалог снова у бота и ресепшену недоступен — возврат на него дал бы голое 403.
    expect(res.headers.location).toBe('/console');
    await app.close();
  });
});

describe('per-hotel access', () => {
  it('shows a hotel receptionist only their own hotel', async () => {
    const { app, store } = await makeApp();
    const ast = store.getOrCreateConversation('webwidget', 'g-ast');
    store.setProperty(ast.id, 'astana');
    store.setStatus(ast.id, 'handed_off');
    const alm = store.getOrCreateConversation('webwidget', 'g-alm');
    store.setProperty(alm.id, 'almaty');
    store.setStatus(alm.id, 'handed_off');

    const { cookie } = await login(app, 'astana-desk', 'desk-pass');
    const inbox = await app.inject({ method: 'GET', url: '/console', headers: { cookie } });
    expect(inbox.body).toContain(`/console/chats/${encodeURIComponent(ast.id)}`);
    expect(inbox.body).not.toContain(`/console/chats/${encodeURIComponent(alm.id)}`);

    // И открыть чужой диалог напрямую по ссылке тоже нельзя.
    const direct = await app.inject({
      method: 'GET',
      url: `/console/chats/${encodeURIComponent(alm.id)}`,
      headers: { cookie },
    });
    // Именно 404, а не 403: по разнице ответов можно было бы выяснить, что этот
    // гость обслуживается в другом отеле сети.
    expect(direct.statusCode).toBe(404);
    await app.close();
  });

  it('keeps a network-wide account seeing every hotel', async () => {
    const { app, store } = await makeApp();
    const alm = store.getOrCreateConversation('webwidget', 'w-alm');
    store.setProperty(alm.id, 'almaty');
    store.setStatus(alm.id, 'handed_off');
    const { cookie } = await login(app, 'admin', 'admin-pass');
    const inbox = await app.inject({ method: 'GET', url: '/console', headers: { cookie } });
    expect(inbox.body).toContain(`/console/chats/${encodeURIComponent(alm.id)}`);
    await app.close();
  });
});

describe('escalation recipients', () => {
  it('sends a hotel enquiry to that hotel managers and not to the owner', async () => {
    const { store } = await makeApp();
    store.setStaffChat('almaty', '111', 'Айгуль');
    store.setStaffChat('almaty', '222', 'Ресепшен Алматы');
    store.setStaffChat('astana', '333', 'Данияр');

    expect(store.staffChatsFor('almaty').map((c) => c.chatId)).toEqual(['111', '222']);
    expect(store.staffChatsFor('astana').map((c) => c.chatId)).toEqual(['333']);
    // Отель без получателей — заявка не должна исчезнуть, её подхватывает владелец.
    expect(store.staffChatsFor('seven')).toEqual([]);
  });

  it('lets a manager unsubscribe and does not duplicate on repeat registration', async () => {
    const { store } = await makeApp();
    store.setStaffChat('park_almaty', '444', 'Марат');
    store.setStaffChat('park_almaty', '444', 'Марат Ж.');
    expect(store.staffChatsFor('park_almaty')).toHaveLength(1);
    expect(store.staffChatsFor('park_almaty')[0].title).toBe('Марат Ж.');

    const entry = store.listStaffChats().find((c) => c.chatId === '444')!;
    store.removeStaffChat(entry.id);
    expect(store.staffChatsFor('park_almaty')).toEqual([]);
  });

  it('shows the owner an invite link per hotel', async () => {
    const { app } = await makeApp();
    const { cookie } = await login(app, 'admin', 'admin-pass');
    const res = await app.inject({ method: 'GET', url: '/console/managers', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    // Телефон менеджера подключить нельзя — работает только переход по ссылке.
    expect(res.body).toContain('start=staff-almaty');
    expect(res.body).toContain('start=staff-astana');
    expect(res.body).toContain('нет получателей');
    await app.close();
  });

  it('keeps the managers screen away from reception', async () => {
    const { app } = await makeApp();
    const { cookie } = await login(app, 'aigul', 'mice-pass');
    const res = await app.inject({ method: 'GET', url: '/console/managers', headers: { cookie } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe('per-hotel writes', () => {
  it('refuses to change the status of another hotel request, even by guessing its id', async () => {
    const { app, store } = await makeApp();
    store.saveMice({
      conversationId: 'webwidget:m1',
      property: 'astana',
      status: 'in_work',
      createdAt: new Date().toISOString(),
    } as never);
    store.saveMice({
      conversationId: 'webwidget:m2',
      property: 'almaty',
      status: 'in_work',
      createdAt: new Date().toISOString(),
    } as never);
    const almaty = store.listMice().find((m) => m.property === 'almaty')!;

    const { cookie, token } = await login(app, 'astana-desk', 'desk-pass');
    // Список чужих заявок ресепшен не видит, но id — обычные автоинкременты,
    // поэтому запись обязана проверяться отдельно от чтения.
    const res = await post(app, `/console/mice/${almaty.id}/status`, cookie, csrfTokenFor(token!), {
      status: 'done',
    });
    expect(res.statusCode).toBe(403);
    expect(store.listMice().find((m) => m.id === almaty.id)!.status).toBe('in_work');
    await app.close();
  });
});

describe('profile password change', () => {
  it('changes the password and refuses a wrong current one', async () => {
    const { app, store } = await makeApp();
    const { cookie, token } = await login(app, 'aigul', 'mice-pass');

    const wrong = await post(app, '/console/profile', cookie, csrfTokenFor(token!), {
      current: 'not-my-pass',
      next: 'freshpass1',
      repeat: 'freshpass1',
    });
    expect(wrong.statusCode).toBe(400);
    expect(verifyPassword('mice-pass', store.findStaffByLogin('aigul')!.passHash)).toBe(true);

    const ok = await post(app, '/console/profile', cookie, csrfTokenFor(token!), {
      current: 'mice-pass',
      next: 'freshpass1',
      repeat: 'freshpass1',
    });
    expect(ok.statusCode).toBe(200);
    expect(verifyPassword('freshpass1', store.findStaffByLogin('aigul')!.passHash)).toBe(true);
    await app.close();
  });

  it('rejects a short password and a mismatched repeat', async () => {
    const { app, store } = await makeApp();
    const { cookie, token } = await login(app, 'aigul', 'mice-pass');
    for (const body of [
      { current: 'mice-pass', next: 'short', repeat: 'short' },
      { current: 'mice-pass', next: 'longenough1', repeat: 'longenough2' },
    ]) {
      const res = await post(app, '/console/profile', cookie, csrfTokenFor(token!), body);
      expect(res.statusCode).toBe(400);
    }
    expect(verifyPassword('mice-pass', store.findStaffByLogin('aigul')!.passHash)).toBe(true);
    await app.close();
  });
});

describe('duplicate uploads', () => {
  it('warns when the uploaded file repeats a fact already in the base', async () => {
    const { app, store } = await makeApp();
    const priceList = [
      'Разовое посещение взрослый 7 500 тенге',
      'Детский абонемент до 12 лет 4 500 тенге',
      'Семейный на двоих 13 000 тенге',
      'Часы работы с 07:00 до 22:00 ежедневно',
    ].join('\n');
    store.addKbEntry({
      property: 'almaty',
      kind: 'fact',
      title: 'Прайс AquaFit',
      body: priceList,
      url: null,
      active: true,
    });
    const { cookie, token } = await login(app, 'admin', 'admin-pass');
    const res = await app.inject({
      method: 'POST',
      url: '/console/kb/upload',
      headers: { cookie, 'content-type': 'multipart/form-data; boundary=X' },
      payload:
        `--X\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${csrfTokenFor(token!)}\r\n` +
        `--X\r\nContent-Disposition: form-data; name="property"\r\n\r\nalmaty\r\n` +
        `--X\r\nContent-Disposition: form-data; name="file"; filename="price.txt"\r\n` +
        `Content-Type: text/plain\r\n\r\n${priceList}\r\n--X--\r\n`,
    });
    // Второй раз тот же прайс удвоил бы его в промпте — бот выбирал бы между копиями.
    expect(res.body).toContain('уже есть в базе');
    expect(res.body).toContain('Прайс AquaFit');
    await app.close();
  });
});

describe('knowledge sources', () => {
  it('reads the page as soon as the owner pastes the link', async () => {
    const { app, store } = await makeApp();
    const { cookie, token } = await login(app, 'admin', 'admin-pass');
    const res = await post(app, '/console/kb/add', cookie, csrfTokenFor(token!), {
      kind: 'source',
      url: 'https://kazzhol.com/promo',
      title: 'Осенняя акция',
    });
    expect(res.headers.location).toContain('read=1');

    const entry = store.listKbEntries(undefined, 'source')[0];
    // Ссылка обещает боту знание страницы — значит текст обязан лежать в базе знаний.
    expect(entry.body).toContain('Скидка 20% осенью');
    expect(entry.fetchedAt).toBeTruthy();

    const list = await app.inject({ method: 'GET', url: '/console/kb?kind=source', headers: { cookie } });
    expect(list.body).toContain('Прочитано');
    await app.close();
  });

  it('tells the owner in plain words when the page cannot be read', async () => {
    const { app, store } = await makeApp();
    const { cookie, token } = await login(app, 'admin', 'admin-pass');
    const res = await post(app, '/console/kb/add', cookie, csrfTokenFor(token!), {
      kind: 'source',
      url: 'https://kazzhol.com/bad',
      title: 'Битая страница',
    });
    expect(decodeURIComponent(res.headers.location as string)).toContain('Страница не найдена');
    // Запись всё равно сохранена: отель поправит ссылку, а не заводит её заново.
    expect(store.listKbEntries(undefined, 'source')).toHaveLength(1);
    await app.close();
  });
});

// --- CSRF ------------------------------------------------------------------------------

describe('CSRF protection', () => {
  it('POST without a CSRF token is rejected with 403', async () => {
    const { app, store } = await makeApp();
    const convo = store.getOrCreateConversation('webwidget', 'guest-5');
    const { cookie } = await login(app, 'admin', 'admin-pass');

    const res = await post(
      app,
      `/console/chats/${encodeURIComponent(convo.id)}/takeover`,
      cookie,
      undefined,
    );
    expect(res.statusCode).toBe(403);
    expect(store.getConversation(convo.id)?.status).toBe('active');
    await app.close();
  });

  it('POST with a wrong CSRF token is rejected with 403', async () => {
    const { app, store } = await makeApp();
    const convo = store.getOrCreateConversation('webwidget', 'guest-6');
    const { cookie } = await login(app, 'admin', 'admin-pass');
    const res = await post(
      app,
      `/console/chats/${encodeURIComponent(convo.id)}/takeover`,
      cookie,
      'not-the-right-token',
    );
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

// --- MICE status ---------------------------------------------------------------------------

describe('MICE requests', () => {
  it('mice_manager can move a request to in_work; invalid status is rejected', async () => {
    const { app, store } = await makeApp();
    store.saveMice({
      conversationId: 'webwidget:g',
      property: 'almaty',
      peopleCount: 50,
      contactName: 'Айгуль',
      contactPhone: '+77012223344',
      status: 'new',
      createdAt: new Date().toISOString(),
    });
    const id = store.listMice()[0].id!;
    const { cookie, token } = await login(app, 'aigul', 'mice-pass');

    const ok = await post(app, `/console/mice/${id}/status`, cookie, csrfTokenFor(token!), {
      status: 'in_work',
    });
    expect(ok.statusCode).toBe(302);
    expect(store.listMice()[0].status).toBe('in_work');

    const bad = await post(app, `/console/mice/${id}/status`, cookie, csrfTokenFor(token!), {
      status: 'hacked',
    });
    expect(bad.statusCode).toBe(400);
    expect(store.listMice()[0].status).toBe('in_work');
    await app.close();
  });
});

// --- Data deletion -------------------------------------------------------------------------

describe('data deletion (admin)', () => {
  it('deletes personal data only with the confirmation checkbox, and records an event', async () => {
    const { app, store } = await makeApp();
    const convo = store.getOrCreateConversation('whatsapp', 'guest-7');
    store.appendMessage(convo.id, { role: 'user', content: 'мой паспорт N12345678' });
    store.saveLead({
      conversationId: convo.id,
      kind: 'generic',
      contactName: 'Гость',
      contactPhone: '+77014126353',
      createdAt: new Date().toISOString(),
    });
    const { cookie, token } = await login(app, 'admin', 'admin-pass');

    // Without the checkbox: nothing happens.
    const refused = await post(app, '/console/data-deletion', cookie, csrfTokenFor(token!), {
      conversationId: convo.id,
    });
    expect(refused.statusCode).toBe(400);
    expect(store.listLeads()[0].contactPhone).toBe('+77014126353');

    const res = await post(app, '/console/data-deletion', cookie, csrfTokenFor(token!), {
      conversationId: convo.id,
      confirm: 'on',
    });
    expect(res.statusCode).toBe(200);
    expect(store.listLeads()[0].contactPhone).toBe('***');
    expect(store.getConversation(convo.id)!.history).toEqual([]);
    expect(store.listEvents('1970-01-01').some((e) => e.type === 'data_deletion')).toBe(true);
    await app.close();
  });
});

// --- Dashboard & XSS -------------------------------------------------------------------------

describe('dashboard and output escaping', () => {
  it('GET /console/summary states the speed in words and hides the milliseconds', async () => {
    const { app, store } = await makeApp();
    store.recordEvent('reply_timing', { payload: { ms: 1200 } });
    const { cookie } = await login(app, 'admin', 'admin-pass');
    const res = await app.inject({ method: 'GET', url: '/console/summary', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Скорость ответа в норме');
    // Телеметрия остаётся, но убрана под «Технику» — владелец видит смысл, не миллисекунды.
    expect(res.body).toContain('p95');
    expect(res.body).toContain('<details');
    await app.close();
  });

  it('escapes guest-controlled content in chat pages (XSS)', async () => {
    const { app, store } = await makeApp();
    const convo = store.getOrCreateConversation('webwidget', 'guest-8');
    store.appendMessage(convo.id, { role: 'user', content: '<script>alert(1)</script>' });
    const { cookie } = await login(app, 'admin', 'admin-pass');
    const res = await app.inject({
      method: 'GET',
      url: `/console/chats/${encodeURIComponent(convo.id)}`,
      headers: { cookie },
    });
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
    await app.close();
  });
});

describe('login brute-force protection', () => {
  it('locks the door after repeated wrong passwords and lets the right one back in', async () => {
    const { app } = await makeApp();
    // Простой постоянный пароль безопасен ровно настолько, насколько защищена дверь.
    for (let i = 0; i < 8; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/console/login',
        payload: 'login=admin&password=wrong',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(res.statusCode).toBe(401);
    }
    const locked = await app.inject({
      method: 'POST',
      url: '/console/login',
      payload: 'login=admin&password=admin-pass',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    // Даже верный пароль не проходит, пока идёт блокировка.
    expect(locked.statusCode).toBe(429);
    expect(locked.body).toContain('Слишком много попыток');
    await app.close();
  });

  it('does not lock the whole shift when one login is being guessed', async () => {
    const { app } = await makeApp();
    for (let i = 0; i < 8; i += 1) {
      await app.inject({
        method: 'POST',
        url: '/console/login',
        payload: 'login=someone-else&password=wrong',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
    }
    const ok = await login(app, 'aigul', 'mice-pass');
    expect(ok.token).toBeTruthy();
    await app.close();
  });
});

describe('forgot password', () => {
  it('sends a one-time link to Telegram and lets the manager set a new password', async () => {
    const sent: string[] = [];
    const store = new Store(':memory:');
    store.createStaff('aigul', hashPassword('old-pass'), 'mice_manager', 'astana');
    const app = await buildServer({
      engine: { handle: vi.fn(async () => null) },
      adapters: {},
      store,
      config: { whatsapp: { phoneNumberIds: {} } },
      extraRoutes: [
        (a) =>
          registerConsoleRoutes(a, {
            store,
            metricsSummary,
            sendToConversation: async () => ({ ok: true }),
            notifyStaff: async (text) => { sent.push(text); },
            publicBaseUrl: 'https://panel.example',
          }),
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/console/forgot',
      payload: 'login=aigul',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    const link = /https:\/\/panel\.example(\/console\/reset\/[\w-]+)/.exec(sent[0])![1];

    expect((await app.inject({ method: 'GET', url: link })).statusCode).toBe(200);
    const done = await app.inject({
      method: 'POST',
      url: link,
      payload: 'next=freshpass1&repeat=freshpass1',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(done.statusCode).toBe(200);
    expect(verifyPassword('freshpass1', store.findStaffByLogin('aigul')!.passHash)).toBe(true);

    // Ссылка одноразовая: оставшись живой, она была бы вечным ключом в чате.
    expect((await app.inject({ method: 'GET', url: link })).statusCode).toBe(410);
    await app.close();
  });

  it('answers identically for an unknown login and sends nothing', async () => {
    const sent: string[] = [];
    const store = new Store(':memory:');
    store.createStaff('admin', hashPassword('p'), 'admin');
    const app = await buildServer({
      engine: { handle: vi.fn(async () => null) },
      adapters: {},
      store,
      config: { whatsapp: { phoneNumberIds: {} } },
      extraRoutes: [
        (a) =>
          registerConsoleRoutes(a, {
            store,
            metricsSummary,
            sendToConversation: async () => ({ ok: true }),
            notifyStaff: async (t) => { sent.push(t); },
          }),
      ],
    });
    const res = await app.inject({
      method: 'POST',
      url: '/console/forgot',
      payload: 'login=no-such-person',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    // Разный ответ превратил бы форму в способ узнать, какие учётки существуют.
    expect(res.body).toContain('Если такой логин есть');
    expect(sent).toHaveLength(0);
    await app.close();
  });
});

describe('back navigation', () => {
  // Счётчик неудачных входов общий на процесс: тест блокировки выше запер бы «admin».
  beforeEach(() => resetLoginAttempts());

  it('gives every screen below the tabs a visible way back', async () => {
    const { app, store } = await makeApp();
    const id = store.addKbEntry({ property: '', kind: 'fact', title: 'Тест', body: 'текст', url: null, active: true });
    const { cookie } = await login(app, 'admin', 'admin-pass');
    const screens = [
      '/console/kb',
      '/console/kb/new',
      `/console/kb/${id}`,
      '/console/kb/archive',
      '/console/kb/upload',
      '/console/requests',
      '/console/summary',
      '/console/managers',
      '/console/ask',
      '/console/profile',
      '/console/data-deletion',
    ];
    for (const url of screens) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode, url).toBe(200);
      // Без этого со второго экрана выбираются только через меню — лишний тап на каждом шаге.
      expect(res.body, url).toContain('class="backlink"');
    }
    await app.close();
  });

  it('leaves the inbox without a back link — it is the top of the tree', async () => {
    const { app } = await makeApp();
    const { cookie } = await login(app, 'admin', 'admin-pass');
    const res = await app.inject({ method: 'GET', url: '/console', headers: { cookie } });
    expect(res.body).not.toContain('class="backlink"');
    await app.close();
  });
});

describe('stylesheet cache busting', () => {
  it('changes the stylesheet URL whenever the CSS changes', async () => {
    const { app } = await makeApp();
    const { cookie } = await login(app, 'admin', 'admin-pass');
    const page = await app.inject({ method: 'GET', url: '/console', headers: { cookie } });
    const href = /href="(\/console\/app\.[^"]+\.css)"/.exec(page.body)![1];

    // Имя файла обязано зависеть от содержимого: ответ отдаётся с immutable на год,
    // и при фиксированном имени у всех остаются старые стили и новая разметка.
    expect(href).toContain(CSS_HASH);
    expect(href).not.toContain('v1');

    const css = await app.inject({ method: 'GET', url: href });
    expect(css.statusCode).toBe(200);
    expect(css.body).toContain('.backlink');
  });

  it('still answers on an older stylesheet name so open tabs do not break mid-session', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/console/app.v1.css' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
  });
});

describe('перебор пароля не запирает владельца', () => {
  it('блокировка держится за парой «логин + адрес», а не за одним логином', async () => {
    // По одному логину кто угодно, зная имя «admin», девятью запросами закрывал владельцу
    // вход на 15 минут. По одному адресу — заперли бы всю смену за общим NAT отеля.
    const { app } = await makeApp();
    const bad = (ip: string) =>
      app.inject({
        method: 'POST',
        url: '/console/login',
        headers: {
          'x-forwarded-for': ip,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: 'login=admin&password=wrong',
      });

    // Злоумышленник со своего адреса перебирает пароль, пока его не запрут.
    let attackerLocked = false;
    for (let i = 0; i < 12; i += 1) {
      if ((await bad('203.0.113.7')).statusCode === 429) {
        attackerLocked = true;
        break;
      }
    }
    expect(attackerLocked, 'перебор должен упираться в блокировку').toBe(true);

    // А владелец с другого адреса входит как ни в чём не бывало.
    const owner = await app.inject({
      method: 'POST',
      url: '/console/login',
      headers: {
        'x-forwarded-for': '198.51.100.4',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'login=admin&password=admin-pass',
    });
    expect(owner.statusCode).toBe(302);
    await app.close();
  });
});

describe('console fixes: escalations visible in Заявки + direct source delete', () => {
  it('a guest asking for a human appears in the "На менеджера" tab, and survives auto-resume', async () => {
    const { app, store } = await makeApp();
    const convo = store.getOrCreateConversation('whatsapp', '77011234567');
    store.appendMessage(convo.id, { role: 'user', content: 'позовите менеджера' });
    store.recordEvent('escalation', {
      conversationId: convo.id,
      property: convo.property,
      channel: convo.channel,
      payload: { type: 'human_requested' },
    });
    // Баг авто-возобновления мог вернуть статус в active — заявка всё равно должна остаться видимой.
    store.setStatus(convo.id, 'active');

    const { cookie } = await login(app, 'admin', 'admin-pass');
    const page = await app.inject({ method: 'GET', url: '/console/requests?tab=manager', headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('На менеджера');
    expect(page.body).toContain(`/console/chats/${encodeURIComponent(convo.id)}`);

    // Как только менеджер взял диалог — карточка уходит из очереди.
    store.setTakenBy(convo.id, 'admin');
    const after = await app.inject({ method: 'GET', url: '/console/requests?tab=manager', headers: { cookie } });
    expect(after.body).not.toContain(`/console/chats/${encodeURIComponent(convo.id)}`);
    await app.close();
  });

  it('reception can SEE, OPEN and TAKE an auto-resumed escalation (the blocker the review caught)', async () => {
    const { app, store } = await makeApp();
    const convo = store.getOrCreateConversation('whatsapp', '77019998877');
    store.appendMessage(convo.id, { role: 'user', content: 'нужен живой человек' });
    store.recordEvent('escalation', {
      conversationId: convo.id,
      property: convo.property,
      channel: convo.channel,
      payload: { type: 'human_requested' },
    });
    // Авто-возобновление вернуло статус в active — раньше это давало 403 при клике.
    store.setStatus(convo.id, 'active');

    const { cookie, token } = await login(app, 'aigul', 'mice-pass');
    const page = await app.inject({ method: 'GET', url: '/console/requests?tab=manager', headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(`/console/chats/${encodeURIComponent(convo.id)}`);

    // Клик по «Открыть и ответить» должен ОТКРЫТЬ диалог (200), а не 403.
    const open = await app.inject({
      method: 'GET',
      url: `/console/chats/${encodeURIComponent(convo.id)}`,
      headers: { cookie },
    });
    expect(open.statusCode).toBe(200);

    // И ресепшен может взять диалог — после этого карточка уходит из очереди.
    const take = await post(app, `/console/chats/${encodeURIComponent(convo.id)}/takeover`, cookie, csrfTokenFor(token!), {});
    expect(take.statusCode).toBe(302);
    expect(store.getConversation(convo.id)?.takenBy).toBe('aigul');
    const after = await app.inject({ method: 'GET', url: '/console/requests?tab=manager', headers: { cookie } });
    expect(after.body).not.toContain(`/console/chats/${encodeURIComponent(convo.id)}`);
    await app.close();
  });

  it('a manager can open ANY active bot chat (full access from the panel)', async () => {
    const { app, store } = await makeApp();
    const convo = store.getOrCreateConversation('whatsapp', '77010000000');
    store.appendMessage(convo.id, { role: 'user', content: 'какие цены?' });
    // Обычный активный диалог с ботом — менеджер должен мочь открыть и ответить.
    const { cookie } = await login(app, 'aigul', 'mice-pass');
    const open = await app.inject({
      method: 'GET',
      url: `/console/chats/${encodeURIComponent(convo.id)}`,
      headers: { cookie },
    });
    expect(open.statusCode).toBe(200);
    // На странице есть кнопка перехватить у бота и ответить.
    expect(open.body).toContain('/takeover');
    await app.close();
  });

  it('a source can be permanently deleted; it disappears from the KB the bot reads', async () => {
    const { app, store } = await makeApp();
    const id = store.addKbEntry({
      property: '',
      kind: 'source',
      title: 'Акции',
      body: 'Скидка 20% осенью',
      url: 'https://example.com/promo',
      active: true,
    });
    expect(store.getKbEntry(id)).not.toBeNull();

    const { cookie, token } = await login(app, 'admin', 'admin-pass');
    const res = await post(app, '/console/kb/delete', cookie, csrfTokenFor(token!), {
      id: String(id),
      kind: 'source',
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).toContain('kind=source');
    // Полностью удалено — ни в активных, ни в архиве; бот перечитывает KB каждый ход, значит источник ушёл.
    expect(store.getKbEntry(id)).toBeNull();
    expect(store.listKbEntries(undefined, undefined, true).some((e) => e.id === id)).toBe(false);
    await app.close();
  });

  it('a handled-then-released escalation leaves the "На менеджера" queue', async () => {
    const { app, store } = await makeApp();
    const convo = store.getOrCreateConversation('whatsapp', '77012223344');
    store.recordEvent('escalation', {
      conversationId: convo.id,
      property: convo.property,
      channel: convo.channel,
      payload: { type: 'human_requested' },
    });
    // Менеджер взял диалог и вернул боту — заявка обработана.
    store.recordEvent('takeover', { conversationId: convo.id });
    store.recordEvent('release', { conversationId: convo.id });
    store.setTakenBy(convo.id, null);
    store.setStatus(convo.id, 'active');

    const { cookie } = await login(app, 'aigul', 'mice-pass');
    const page = await app.inject({ method: 'GET', url: '/console/requests?tab=manager', headers: { cookie } });
    // Обработанная заявка больше не висит в очереди «На менеджера».
    expect(page.body).not.toContain(`/console/chats/${encodeURIComponent(convo.id)}`);
    await app.close();
  });
});
