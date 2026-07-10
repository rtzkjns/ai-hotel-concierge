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
  /**
   * Anti-bot tokens embedded in served pages: token → {expiry, boundSenderId}.
   * A token authenticates ONE senderId: the first successful hello binds it, so
   * a scraped token can't mint unlimited fresh senderIds (rate-limit bypass);
   * reconnects with the same token+senderId keep working.
   */
  private readonly tokens = new Map<string, { expiry: number; boundSenderId: string | null }>();

  /** Live sockets per senderId, so staff-console replies can reach an open widget. */
  private readonly liveSockets = new Map<string, Set<WidgetSocket>>();

  constructor(private readonly deps: WebWidgetDeps) {}

  /** Deliver a staff-console reply to the guest's open widget session(s). */
  pushToGuest(senderId: string, text: string): boolean {
    const sockets = this.liveSockets.get(senderId);
    if (!sockets || sockets.size === 0) return false;
    for (const socket of sockets) {
      try {
        socket.send(JSON.stringify({ type: 'reply', text }));
      } catch {
        // A dying socket must not fail the push; close cleanup removes it.
      }
    }
    return true;
  }

  /** Called when a socket closes; keeps liveSockets bounded. */
  detach(session: WidgetSession, socket: WidgetSocket): void {
    if (!session.senderId) return;
    const sockets = this.liveSockets.get(session.senderId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) this.liveSockets.delete(session.senderId);
  }

  /** Issue a page-load token, pruning expired ones so the map stays bounded. */
  issueToken(): string {
    const now = this.now();
    for (const [token, entry] of this.tokens) {
      if (entry.expiry <= now) this.tokens.delete(token);
    }
    const token = randomUUID();
    this.tokens.set(token, { expiry: now + TOKEN_TTL_MS, boundSenderId: null });
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
      const claimedSenderId = this.acceptSenderId(msg.senderId);
      if (msg.type !== 'hello' || !this.consumeToken(msg.token, claimedSenderId)) {
        socket.close(4001, 'invalid token');
        return;
      }
      session.authed = true;
      session.senderId = claimedSenderId ?? randomUUID();
      this.bindToken(msg.token as string, session.senderId);
      let live = this.liveSockets.get(session.senderId);
      if (!live) this.liveSockets.set(session.senderId, (live = new Set()));
      live.add(socket);
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
      socket.on('close', () => this.detach(session, socket));
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Valid = unexpired AND (unused, or already bound to the same senderId — a reconnect). */
  private consumeToken(token: unknown, claimedSenderId: string | null): boolean {
    if (typeof token !== 'string') return false;
    const entry = this.tokens.get(token);
    if (entry === undefined || entry.expiry <= this.now()) return false;
    return entry.boundSenderId === null || entry.boundSenderId === claimedSenderId;
  }

  private bindToken(token: string, senderId: string): void {
    const entry = this.tokens.get(token);
    if (entry) entry.boundSenderId = senderId;
  }

  private acceptSenderId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    return /^[A-Za-z0-9_-]{8,64}$/.test(value) && value.length <= MAX_SENDER_ID_CHARS
      ? value
      : null;
  }
}
