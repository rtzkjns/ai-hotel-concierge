import { describe, it, expect, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';
import { Store } from '../src/store';
import { hashPassword, verifyPassword, csrfTokenFor } from '../src/console/auth';
import { registerConsoleRoutes, type SendToConversation } from '../src/console/routes';
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
    extraRoutes: [(a) => registerConsoleRoutes(a, { store, metricsSummary, sendToConversation })],
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

  it('mice_manager only sees handed_off chats, with PII masked', async () => {
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
    expect(list.body).toContain('Гость с сайта');
    expect(list.body).toContain(`/console/chats/${encodeURIComponent(handed.id)}`);
    expect(list.body).not.toContain(`/console/chats/${encodeURIComponent(active.id)}`);
    expect(list.body).not.toContain('+77776665544'); // masked

    // Detail of an active chat is off-limits for mice_manager.
    const detail = await app.inject({
      method: 'GET',
      url: `/console/chats/${encodeURIComponent(active.id)}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(403);
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

  it('mice_manager cannot open a handed_off chat taken by ANOTHER manager', async () => {
    const { app, store } = await makeApp();
    const taken = store.getOrCreateConversation('webwidget', 'guest-taken');
    store.setStatus(taken.id, 'handed_off');
    store.setTakenBy(taken.id, 'someone-else');
    const unclaimed = store.getOrCreateConversation('webwidget', 'guest-unclaimed');
    store.setStatus(unclaimed.id, 'handed_off');

    const { cookie } = await login(app, 'aigul', 'mice-pass');
    const list = await app.inject({ method: 'GET', url: '/console', headers: { cookie } });
    expect(list.body).toContain(`/console/chats/${encodeURIComponent(unclaimed.id)}`);
    expect(list.body).not.toContain(`/console/chats/${encodeURIComponent(taken.id)}`);

    const detail = await app.inject({
      method: 'GET',
      url: `/console/chats/${encodeURIComponent(taken.id)}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(403);
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
