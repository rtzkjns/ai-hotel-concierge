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

  it('sets the chosen property and defaults to unselected', () => {
    const fresh = store.getOrCreateConversation(222);
    expect(fresh.property).toBe('');
    store.setProperty(222, 'almaty');
    expect(store.getOrCreateConversation(222).property).toBe('almaty');
  });

  it('marks a conversation handed off', () => {
    store.getOrCreateConversation(111, 'astana');
    store.setStatus(111, 'handed_off');
    expect(store.getOrCreateConversation(111, 'astana').status).toBe('handed_off');
  });

  it('resetConversation clears hotel, status, and history', () => {
    store.getOrCreateConversation(333, 'almaty');
    store.appendMessage(333, { role: 'user', content: 'hi' });
    store.setStatus(333, 'handed_off');
    store.resetConversation(333);
    const convo = store.getOrCreateConversation(333);
    expect(convo.property).toBe('');
    expect(convo.status).toBe('active');
    expect(convo.history).toEqual([]);
  });

  it('saves a booking lead with special requests', () => {
    store.saveLead({
      chatId: 111,
      checkIn: '2026-07-01',
      checkOut: '2026-07-03',
      guests: 2,
      roomType: 'Comfort',
      contactName: 'Aibek',
      contactPhone: '+7700',
      specialRequests: 'Traveling with a dog and an infant; needs a cot; asked about airport transfer',
      createdAt: new Date().toISOString(),
    });
    const leads = store.listLeads();
    expect(leads).toHaveLength(1);
    expect(leads[0].contactName).toBe('Aibek');
    expect(leads[0].specialRequests).toContain('dog');
  });

  it('saves a booking lead without special requests', () => {
    store.saveLead({
      chatId: 112,
      checkIn: '2026-08-01',
      checkOut: '2026-08-02',
      guests: 1,
      roomType: 'Standard',
      contactName: 'Dana',
      contactPhone: '+7701',
      createdAt: new Date().toISOString(),
    });
    expect(store.listLeads()[0].specialRequests).toBeUndefined();
  });
});
