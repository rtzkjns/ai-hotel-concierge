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

    const bookings = await app.inject({ method: 'GET', url: '/console/bookings', headers: { cookie } });
    expect(bookings.statusCode).toBe(200);
    expect(bookings.body).toContain('BK-100');
    expect(bookings.body).toContain('Ivan Petrov');

    const leads = await app.inject({ method: 'GET', url: '/console/leads', headers: { cookie } });
    expect(leads.statusCode).toBe(200);
    await app.close();
  });

  it('mice_manager gets 403 on bookings and leads but sees /console/mice and metrics', async () => {
    const { app } = await makeApp();
    const { cookie } = await login(app, 'aigul', 'mice-pass');

    expect((await app.inject({ method: 'GET', url: '/console/bookings', headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/console/leads', headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/console/data-deletion', headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/console/mice', headers: { cookie } })).statusCode).toBe(200);
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
    const list = await app.inject({ method: 'GET', url: '/console/chats', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain('guest-handed');
    expect(list.body).not.toContain('guest-active');
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
    expect(history[history.length - 1]).toEqual({
      role: 'assistant',
      content: '[менеджер] сейчас всё решим',
    });
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
    expect(res.body).toContain('guest offline');
    expect(store.getConversation(convo.id)!.history).toEqual([]);
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
  it('GET /console renders metric tiles with an SLA indicator', async () => {
    const { app, store } = await makeApp();
    store.recordEvent('reply_timing', { payload: { ms: 1200 } });
    const { cookie } = await login(app, 'admin', 'admin-pass');
    const res = await app.inject({ method: 'GET', url: '/console', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('SLA');
    expect(res.body).toContain('p95');
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
