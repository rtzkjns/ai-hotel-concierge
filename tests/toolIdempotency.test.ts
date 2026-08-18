import { describe, it, expect, vi } from 'vitest';
import { Engine } from '../src/core/engine';
import { Store } from '../src/store';
import { RateLimiter } from '../src/core/rateLimit';

/** Модель, которая на КАЖДОМ ходу зовёт submit_mice_request — ровно так и вышло на проде. */
function eagerClient() {
  let call = 0;
  return {
    messages: {
      create: vi.fn(async () => {
        call += 1;
        if (call % 2 === 1) {
          return {
            stop_reason: 'tool_use',
            content: [
              {
                type: 'tool_use',
                id: `t${call}`,
                name: 'submit_mice_request',
                input: { eventDate: '2026-10-03', peopleCount: 30, contactName: 'Анастасия', contactPhone: '+77756921010' },
              },
            ],
          };
        }
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Заявку передаю коллегам.' }] };
      }),
    },
  };
}

describe('tool idempotency', () => {
  it('does not create a second event request for the same conversation and date', async () => {
    const store = new Store(':memory:');
    const notify = vi.fn(async () => undefined);
    const engine = new Engine({
      store,
      client: eagerClient() as never,
      model: 'test',
      availabilityProvider: { search: async () => [] } as never,
      bookingService: {} as never,
      paymentGateway: {} as never,
      crm: { createLead: async () => undefined } as never,
      staffNotifier: { notify },
      rateLimiter: new RateLimiter(),
    } as never);

    const convo = store.getOrCreateConversation('webwidget', 'anastasia');
    store.setProperty(convo.id, 'almaty');

    for (const text of ['Нужен зал на 30 человек 3 октября', 'вот вложение', 'Спасибо']) {
      await engine.handle({ channel: 'webwidget', senderId: 'anastasia', text, property: 'almaty' } as never);
    }

    // Один разговор — одна заявка и одно уведомление менеджерам, а не три.
    expect(store.listMice()).toHaveLength(1);
    expect(notify.mock.calls.length).toBe(1);
  });
});
