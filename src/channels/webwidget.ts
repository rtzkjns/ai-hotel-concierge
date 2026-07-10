// Web widget channel: WS protocol on /ws/widget + the self-contained chat page
// on /widget. The server paces reply parts so the page stays dumb.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { properties } from '../knowledge';
import type { Channel, Conversation } from '../types';
import type { InboundMessage, OutboundPart } from './types';

const TOKEN_TTL_MS = 60 * 60 * 1000;
const MAX_SENDER_ID_CHARS = 64;

export interface WidgetEngine {
  handle(msg: InboundMessage): Promise<OutboundPart[] | null>;
}

export interface WidgetStore {
  getOrCreateConversation(channel: Channel, senderId: string): Conversation;
  setProperty(id: string, property: string): void;
}

export interface WebWidgetDeps {
  engine: WidgetEngine;
  store: WidgetStore;
  /** Clock injection for token-expiry tests. */
  now?: () => number;
}

/** The subset of a ws socket the protocol needs (structural, for easy faking). */
export interface WidgetSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface WidgetSession {
  authed: boolean;
  senderId: string | null;
}

export class WebWidgetChannel {
  /** Anti-bot tokens embedded in served pages: token → expiry epoch ms. */
  private readonly tokens = new Map<string, number>();

  constructor(private readonly deps: WebWidgetDeps) {}

  /** Issue a page-load token, pruning expired ones so the map stays bounded. */
  issueToken(): string {
    const now = this.now();
    for (const [token, expiry] of this.tokens) {
      if (expiry <= now) this.tokens.delete(token);
    }
    const token = randomUUID();
    this.tokens.set(token, now + TOKEN_TTL_MS);
    return token;
  }

  newSession(): WidgetSession {
    return { authed: false, senderId: null };
  }

  /**
   * One protocol message. hello{token, senderId?} → session{senderId};
   * pick_hotel{property} → hotel ack; msg{text} → typing, paced replies, idle.
   * Anything before a valid hello closes the socket with 4001.
   */
  async onMessage(session: WidgetSession, raw: string, socket: WidgetSocket): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
      msg = parsed as Record<string, unknown>;
    } catch {
      if (!session.authed) socket.close(4001, 'invalid message');
      return; // garbage after auth is ignored, never crashes
    }

    if (!session.authed) {
      if (msg.type !== 'hello' || !this.isValidToken(msg.token)) {
        socket.close(4001, 'invalid token');
        return;
      }
      session.authed = true;
      session.senderId = this.acceptSenderId(msg.senderId) ?? randomUUID();
      const convo = this.deps.store.getOrCreateConversation('webwidget', session.senderId);
      socket.send(
        JSON.stringify({
          type: 'session',
          senderId: session.senderId,
          property: convo.property || null,
        }),
      );
      return;
    }

    const senderId = session.senderId!;
    if (msg.type === 'pick_hotel') {
      const key = typeof msg.property === 'string' ? msg.property : '';
      if (!properties[key]) return;
      const convo = this.deps.store.getOrCreateConversation('webwidget', senderId);
      this.deps.store.setProperty(convo.id, key);
      socket.send(JSON.stringify({ type: 'hotel', property: key, name: properties[key].name }));
      return;
    }

    if (msg.type === 'msg' && typeof msg.text === 'string' && msg.text.trim() !== '') {
      socket.send(JSON.stringify({ type: 'typing' }));
      let parts: OutboundPart[] | null = null;
      try {
        parts = await this.deps.engine.handle({ channel: 'webwidget', senderId, text: msg.text });
      } catch {
        parts = null; // the engine already degrades gracefully; belt and braces here
      }
      for (const part of parts ?? []) {
        if (part.delayMs > 0) await new Promise((r) => setTimeout(r, part.delayMs));
        socket.send(JSON.stringify({ type: 'reply', text: part.text }));
      }
      socket.send(JSON.stringify({ type: 'idle' }));
    }
  }

  /** Register GET /widget (page with injected token) and the /ws/widget socket route. */
  async register(app: FastifyInstance): Promise<void> {
    await app.register(websocket);
    const template = readFileSync(new URL('../server/widget.html', import.meta.url), 'utf8');

    app.get('/widget', async (_req, reply) => {
      return reply
        .type('text/html; charset=utf-8')
        .send(template.replace('%%TOKEN%%', this.issueToken()));
    });

    app.get('/ws/widget', { websocket: true }, (socket) => {
      const session = this.newSession();
      socket.on('message', (data: Buffer) => {
        void this.onMessage(session, data.toString(), socket).catch(() => {});
      });
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private isValidToken(token: unknown): boolean {
    if (typeof token !== 'string') return false;
    const expiry = this.tokens.get(token);
    return expiry !== undefined && expiry > this.now();
  }

  private acceptSenderId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    return /^[A-Za-z0-9_-]{8,64}$/.test(value) && value.length <= MAX_SENDER_ID_CHARS
      ? value
      : null;
  }
}
