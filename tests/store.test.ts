import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../src/store';

describe('Store', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:'); // in-memory SQLite for tests
  });

  it('creates a new active conversation on first access', () => {
    const convo = store.getOrCreateConversation(111, 'astana');
    expect(convo.status).toBe('active');
    expect(convo.history).toEqual([]);
    expect(convo.property).toBe('astana');
  });

  it('appends messages and persists history', () => {
    store.getOrCreateConversation(111, 'astana');
    store.appendMessage(111, { role: 'user', content: 'Привет' });
    store.appendMessage(111, { role: 'assistant', content: 'Здравствуйте!' });
    const convo = store.getOrCreateConversation(111, 'astana');
    expect(convo.history).toHaveLength(2);
    expect(convo.history[0]).toEqual({ role: 'user', content: 'Привет' });
  });

  it('marks a conversation handed off', () => {
    store.getOrCreateConversation(111, 'astana');
    store.setStatus(111, 'handed_off');
    expect(store.getOrCreateConversation(111, 'astana').status).toBe('handed_off');
  });

  it('saves a booking lead', () => {
    store.saveLead({
      chatId: 111,
      checkIn: '2026-07-01',
      checkOut: '2026-07-03',
      guests: 2,
      roomType: 'Comfort',
      contactName: 'Aibek',
      contactPhone: '+7700',
      createdAt: new Date().toISOString(),
    });
    const leads = store.listLeads();
    expect(leads).toHaveLength(1);
    expect(leads[0].contactName).toBe('Aibek');
  });
});
