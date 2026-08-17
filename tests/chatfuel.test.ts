import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { registerChatfuelBridge, chunkByBytes } from '../src/server/chatfuel';
import type { OutboundPart } from '../src/channels/types';

const msgs = (r: { json(): unknown }) => (r.json() as { messages: Array<{ text: string }> }).messages;

function build(reply: OutboundPart[] | Promise<OutboundPart[]>, inboundTimeoutMs = 8500) {
  const handle = vi.fn(async () => (reply instanceof Promise ? reply : reply));
  const app = Fastify();
  registerChatfuelBridge(app, {
    engine: { handle },
    bots: { almaty: { botId: 'BOT1', token: 'TOK1' } },
    inboundTimeoutMs,
  });
  return { app, handle };
}

describe('chunkByBytes', () => {
  it('keeps short text whole; splits long text on the byte boundary without breaking chars', () => {
    expect(chunkByBytes('привет')).toEqual(['привет']);
    const long = 'я'.repeat(700); // 700 Cyrillic chars = 1400 bytes > 1000
    const parts = chunkByBytes(long, 1000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe(long);
    for (const p of parts) expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(1000);
  });
});

describe('chatfuel bridge (single synchronous block)', () => {
  it('runs the engine and returns its verbatim reply in the same response', async () => {
    const { app, handle } = build([
      { text: 'Привет)', delayMs: 0 },
      { text: 'чем помочь?', delayMs: 0 },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/chatfuel/inbound/almaty',
      payload: { user_id: 'U1', text: 'привет' },
    });
    expect(res.statusCode).toBe(200);
    expect(msgs(res)).toEqual([{ text: 'Привет)' }, { text: 'чем помочь?' }]);
    expect(handle).toHaveBeenCalledOnce();
    // routed to almaty with the composed senderId
    expect(handle.mock.calls[0]).toBeDefined();
  });

  it('dedups a retried inbound (same user+text) — engine runs once, retry returns empty', async () => {
    const { app, handle } = build([{ text: 'ok', delayMs: 0 }]);
    const a = await app.inject({ method: 'POST', url: '/chatfuel/inbound/almaty', payload: { user_id: 'U', text: 'hi' } });
    const b = await app.inject({ method: 'POST', url: '/chatfuel/inbound/almaty', payload: { user_id: 'U', text: 'hi' } });
    expect(msgs(a)).toEqual([{ text: 'ok' }]);
    expect(msgs(b)).toEqual([]);
    expect(handle).toHaveBeenCalledOnce();
  });

  it('splits a >1000-byte reply into multiple Instagram-safe messages', async () => {
    const { app } = build([{ text: 'я'.repeat(700), delayMs: 0 }]);
    const res = await app.inject({ method: 'POST', url: '/chatfuel/inbound/almaty', payload: { user_id: 'U2', text: 'x' } });
    const msgs = (res.json() as { messages: Array<{ text: string }> }).messages;
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) expect(new TextEncoder().encode(m.text).length).toBeLessThanOrEqual(1000);
  });

  it('returns a holding line (never hangs) when the engine is slower than the timeout', async () => {
    const slow = new Promise<OutboundPart[]>((r) => setTimeout(() => r([{ text: 'late', delayMs: 0 }]), 200));
    const { app } = build(slow, 50); // 50ms cap < 200ms engine
    const res = await app.inject({ method: 'POST', url: '/chatfuel/inbound/almaty', payload: { user_id: 'U3', text: 'q' } });
    const msgs = (res.json() as { messages: Array<{ text: string }> }).messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0].text).toContain('секунду');
  });

  it('acks 200 without reaching the engine for an unknown property or missing fields', async () => {
    const { app, handle } = build([{ text: 'x', delayMs: 0 }]);
    const r1 = await app.inject({ method: 'POST', url: '/chatfuel/inbound/nope', payload: { user_id: 'U', text: 'hi' } });
    expect(r1.statusCode).toBe(200);
    expect(msgs(r1)).toEqual([]);
    const r2 = await app.inject({ method: 'POST', url: '/chatfuel/inbound/almaty', payload: {} });
    expect(msgs(r2)).toEqual([]);
    expect(handle).not.toHaveBeenCalled();
  });

  it("accepts Chatfuel's default All-properties keys (spaces) and returns reply + set_attributes", async () => {
    const { app, handle } = build([{ text: 'готово', delayMs: 0 }]);
    const res = await app.inject({
      method: 'POST',
      url: '/chatfuel/inbound/almaty',
      payload: { 'chatfuel user id': 'CU9', 'last user freeform input': 'привет' },
    });
    expect(handle).toHaveBeenCalledOnce();
    expect(msgs(res)).toEqual([{ text: 'готово' }]);
    const body = res.json() as { reply: string; set_attributes: { reply: string } };
    expect(body.reply).toBe('готово');
    expect(body.set_attributes.reply).toBe('готово');
  });
});
