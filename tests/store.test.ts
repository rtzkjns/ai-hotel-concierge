import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store';

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe('Store: hotel_content (live per-hotel promos/announcements)', () => {
  it('listActiveContent returns only active, in-window entries for the hotel', () => {
    const s = new Store(':memory:');
    s.addContent({ property: 'almaty', kind: 'promo', title: 'Осенняя акция', body: '-15% на выходные' });
    const inactive = s.addContent({ property: 'almaty', kind: 'promo', body: 'снятая акция' });
    s.setContentActive(inactive, false);
    s.addContent({ property: 'almaty', kind: 'announcement', body: 'прошлогодняя', endsAt: '2020-01-01T00:00:00Z' });
    s.addContent({ property: 'almaty', kind: 'announcement', body: 'будущая', startsAt: '2999-01-01T00:00:00Z' });
    s.addContent({ property: 'astana', kind: 'promo', body: 'для Астаны' });

    const active = s.listActiveContent('almaty', '2026-08-12T00:00:00Z');
    expect(active.map((e) => e.body)).toEqual(['-15% на выходные']);
    expect(active[0].title).toBe('Осенняя акция');
    expect(active[0].active).toBe(true);
    // admin surface sees every entry for the hotel regardless of status/window
    expect(s.listContentForAdmin('almaty').length).toBe(4);
    expect(s.listActiveContent('astana', '2026-08-12T00:00:00Z').length).toBe(1);
  });
});

describe('Store', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:'); // in-memory SQLite for tests
  });

  describe('conversations', () => {
    it('creates a new active conversation keyed by channel:senderId', () => {
      const convo = store.getOrCreateConversation('telegram', '111');
      expect(convo.id).toBe('telegram:111');
      expect(convo.channel).toBe('telegram');
      expect(convo.senderId).toBe('111');
      expect(convo.property).toBe('');
      expect(convo.status).toBe('active');
      expect(convo.language).toBeNull();
      expect(convo.history).toEqual([]);
      expect(convo.updatedAt).toBeTruthy();
    });

    it('getOrCreate is idempotent — same id back, state preserved', () => {
      const first = store.getOrCreateConversation('whatsapp', '77001234567');
      store.setProperty(first.id, 'almaty');
      const again = store.getOrCreateConversation('whatsapp', '77001234567');
      expect(again.id).toBe(first.id);
      expect(again.property).toBe('almaty');
    });

    it('appends messages and persists history', () => {
      const { id } = store.getOrCreateConversation('telegram', '111');
      store.appendMessage(id, { role: 'user', content: 'Привет' });
      store.appendMessage(id, { role: 'assistant', content: 'Здравствуйте!' });
      const convo = store.getOrCreateConversation('telegram', '111');
      expect(convo.history).toHaveLength(2);
      expect(convo.history[0]).toMatchObject({ role: 'user', content: 'Привет' });
      expect(convo.history[0].createdAt).toBeTruthy();
    });

    it('caps history at 60 messages, dropping the oldest', () => {
      const { id } = store.getOrCreateConversation('telegram', '111');
      for (let i = 0; i < 65; i++) {
        store.appendMessage(id, { role: 'user', content: `m${i}` });
      }
      const convo = store.getOrCreateConversation('telegram', '111');
      expect(convo.history).toHaveLength(60);
      expect(convo.history[0].content).toBe('m5');
      expect(convo.history[59].content).toBe('m64');
    });

    it('sets language and status', () => {
      const { id } = store.getOrCreateConversation('webwidget', 'v1');
      store.setLanguage(id, 'kk');
      store.setStatus(id, 'handed_off');
      const convo = store.getOrCreateConversation('webwidget', 'v1');
      expect(convo.language).toBe('kk');
      expect(convo.status).toBe('handed_off');
    });

    it('resetConversation clears hotel, status, language, and history', () => {
      const { id } = store.getOrCreateConversation('telegram', '333');
      store.setProperty(id, 'almaty');
      store.setLanguage(id, 'ru');
      store.appendMessage(id, { role: 'user', content: 'hi' });
      store.setStatus(id, 'handed_off');
      store.resetConversation(id);
      const convo = store.getOrCreateConversation('telegram', '333');
      expect(convo.property).toBe('');
      expect(convo.status).toBe('active');
      expect(convo.language).toBeNull();
      expect(convo.history).toEqual([]);
    });

    it('listConversations returns recent conversations newest-first', () => {
      const dir = mkdtempSync(join(tmpdir(), 'kazzhol-store-'));
      const dbPath = join(dir, 'test.db');
      try {
        const fileStore = new Store(dbPath);
        fileStore.getOrCreateConversation('telegram', 'old');
        fileStore.getOrCreateConversation('telegram', 'a');
        fileStore.appendMessage('telegram:a', { role: 'user', content: 'x' });
        fileStore.getOrCreateConversation('whatsapp', 'b');
        fileStore.appendMessage('whatsapp:b', { role: 'user', content: 'y' });
        // Backdate one conversation beyond the 7-day window.
        const raw = new Database(dbPath);
        raw.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(
          daysAgoIso(10),
          'telegram:old',
        );
        raw.close();
        const list = fileStore.listConversations(7);
        expect(list.map((c) => c.id)).toEqual(['whatsapp:b', 'telegram:a']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('legacy schema migration', () => {
    it('does not crash on a db file with the old chat_id schema', () => {
      const dir = mkdtempSync(join(tmpdir(), 'kazzhol-legacy-'));
      const dbPath = join(dir, 'legacy.db');
      try {
        const raw = new Database(dbPath);
        raw.exec(`
          CREATE TABLE conversations (chat_id INTEGER PRIMARY KEY, property TEXT NOT NULL,
            status TEXT NOT NULL, history TEXT NOT NULL);
          CREATE TABLE leads (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL,
            check_in TEXT NOT NULL, check_out TEXT NOT NULL, guests INTEGER NOT NULL,
            room_type TEXT NOT NULL, contact_name TEXT NOT NULL, contact_phone TEXT NOT NULL,
            special_requests TEXT, created_at TEXT NOT NULL);
          INSERT INTO conversations VALUES (1, 'astana', 'active', '[]');
        `);
        raw.close();
        const migrated = new Store(dbPath);
        const convo = migrated.getOrCreateConversation('telegram', '1');
        expect(convo.id).toBe('telegram:1');
        expect(migrated.listLeads()).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('leads', () => {
    it('saves a booking lead with special requests', () => {
      store.saveLead({
        conversationId: 'telegram:111',
        kind: 'booking',
        checkIn: '2026-07-01',
        checkOut: '2026-07-03',
        guests: 2,
        roomType: 'Comfort',
        contactName: 'Aibek',
        contactPhone: '+7700',
        specialRequests: 'Traveling with a dog and an infant; needs a cot',
        createdAt: new Date().toISOString(),
      });
      const leads = store.listLeads();
      expect(leads).toHaveLength(1);
      expect(leads[0].conversationId).toBe('telegram:111');
      expect(leads[0].kind).toBe('booking');
      expect(leads[0].contactName).toBe('Aibek');
      expect(leads[0].specialRequests).toContain('dog');
    });

    it('saves a generic lead with booking fields absent', () => {
      store.saveLead({
        conversationId: 'whatsapp:222',
        kind: 'generic',
        contactName: 'Dana',
        contactPhone: '+7701',
        createdAt: new Date().toISOString(),
      });
      const [lead] = store.listLeads();
      expect(lead.kind).toBe('generic');
      expect(lead.checkIn).toBeUndefined();
      expect(lead.guests).toBeUndefined();
      expect(lead.specialRequests).toBeUndefined();
    });
  });

  describe('bookings', () => {
    it('saves a booking and updates its status by exely number', () => {
      store.saveBooking({
        conversationId: 'whatsapp:1',
        property: 'almaty',
        exelyNumber: 'EX-1001',
        status: 'confirmed',
        checkIn: '2026-08-10',
        checkOut: '2026-08-12',
        guests: 2,
        roomType: 'Standard',
        ratePlanId: 'rp1',
        total: 147050,
        currency: 'KZT',
        guestName: 'Aibek',
        guestPhone: '+7700',
        createdAt: new Date().toISOString(),
      });
      store.updateBookingStatus('EX-1001', 'cancelled');
      const [b] = store.listBookings();
      expect(b.exelyNumber).toBe('EX-1001');
      expect(b.status).toBe('cancelled');
      expect(b.total).toBe(147050);
      expect(b.upsellOffered).toBe(false);
      expect(b.upsellAccepted).toBe(false);
    });
  });

  describe('mice requests', () => {
    it('saves a MICE request with default status new and moves it through statuses', () => {
      store.saveMice({
        conversationId: 'webwidget:9',
        property: 'almaty',
        eventDate: '2026-09-01',
        peopleCount: 80,
        halls: 'Main hall',
        catering: '2 coffee breaks',
        budget: '1.5M KZT',
        contactName: 'Saule',
        contactPhone: '+7702',
        notes: 'Corporate training',
        createdAt: new Date().toISOString(),
      });
      let [m] = store.listMice();
      expect(m.status).toBe('new');
      expect(m.peopleCount).toBe(80);
      store.setMiceStatus(m.id!, 'in_progress');
      [m] = store.listMice();
      expect(m.status).toBe('in_progress');
    });
  });

  describe('events', () => {
    it('records, lists since a timestamp, and counts by type', () => {
      store.recordEvent('message_in', {
        conversationId: 'telegram:1',
        property: 'almaty',
        channel: 'telegram',
        payload: { language: 'ru' },
      });
      store.recordEvent('message_in', { channel: 'whatsapp' });
      store.recordEvent('escalation', { conversationId: 'telegram:1' });
      const since = daysAgoIso(1);
      const events = store.listEvents(since);
      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('message_in');
      expect(events[0].payload).toEqual({ language: 'ru' });
      expect(store.countEvents('message_in', since)).toBe(2);
      expect(store.countEvents('escalation', since)).toBe(1);
      expect(store.countEvents('booking_created', since)).toBe(0);
    });
  });

  describe('staff and sessions', () => {
    it('creates staff, finds by login, and counts', () => {
      expect(store.countStaff()).toBe(0);
      store.createStaff('admin', 'hash1', 'admin');
      store.createStaff('mice', 'hash2', 'mice_manager');
      expect(store.countStaff()).toBe(2);
      const staff = store.findStaffByLogin('mice');
      expect(staff?.role).toBe('mice_manager');
      expect(staff?.passHash).toBe('hash2');
      expect(store.findStaffByLogin('ghost')).toBeNull();
    });

    it('finds a live session with staff role/login, returns null when expired', () => {
      const staffId = store.createStaff('admin', 'hash1', 'admin');
      store.createSession('tok-live', staffId, daysAgoIso(-1)); // expires tomorrow
      store.createSession('tok-dead', staffId, daysAgoIso(1)); // expired yesterday
      const live = store.findSession('tok-live');
      expect(live?.login).toBe('admin');
      expect(live?.role).toBe('admin');
      expect(live?.staffId).toBe(staffId);
      expect(store.findSession('tok-dead')).toBeNull();
      expect(store.findSession('tok-missing')).toBeNull();
      store.deleteSession('tok-live');
      expect(store.findSession('tok-live')).toBeNull();
    });
  });

  describe('retention and privacy', () => {
    it('purgeOlderThan removes old events and empties old histories but not recent ones', () => {
      const dir = mkdtempSync(join(tmpdir(), 'kazzhol-purge-'));
      const dbPath = join(dir, 'test.db');
      try {
        const fileStore = new Store(dbPath);
        fileStore.getOrCreateConversation('telegram', 'old');
        fileStore.appendMessage('telegram:old', { role: 'user', content: 'ancient' });
        fileStore.getOrCreateConversation('telegram', 'new');
        fileStore.appendMessage('telegram:new', { role: 'user', content: 'fresh' });
        fileStore.recordEvent('message_in', { conversationId: 'telegram:old' });
        fileStore.recordEvent('message_in', { conversationId: 'telegram:new' });
        const raw = new Database(dbPath);
        raw.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(
          daysAgoIso(100),
          'telegram:old',
        );
        raw.prepare(
          "UPDATE events SET created_at = ? WHERE conversation_id = 'telegram:old'",
        ).run(daysAgoIso(100));
        raw.close();

        fileStore.purgeOlderThan(90);

        expect(fileStore.getOrCreateConversation('telegram', 'old').history).toEqual([]);
        expect(fileStore.getOrCreateConversation('telegram', 'new').history).toHaveLength(1);
        const events = fileStore.listEvents(daysAgoIso(365));
        expect(events).toHaveLength(1);
        expect(events[0].conversationId).toBe('telegram:new');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('deletePersonalData empties history and masks names/phones everywhere', () => {
      const { id } = store.getOrCreateConversation('whatsapp', '777');
      store.appendMessage(id, { role: 'user', content: 'my number is +77001234567' });
      const createdAt = new Date().toISOString();
      store.saveLead({
        conversationId: id,
        kind: 'booking',
        checkIn: '2026-07-01',
        checkOut: '2026-07-02',
        guests: 1,
        roomType: 'Standard',
        contactName: 'Aibek',
        contactPhone: '+77001234567',
        createdAt,
      });
      store.saveBooking({
        conversationId: id,
        property: 'almaty',
        exelyNumber: 'EX-2',
        status: 'confirmed',
        checkIn: '2026-07-01',
        checkOut: '2026-07-02',
        guests: 1,
        roomType: 'Standard',
        guestName: 'Aibek',
        guestPhone: '+77001234567',
        createdAt,
      });
      store.saveMice({
        conversationId: id,
        property: 'almaty',
        contactName: 'Aibek',
        contactPhone: '+77001234567',
        createdAt,
      });
      // Unrelated conversation must stay untouched.
      store.saveLead({
        conversationId: 'telegram:other',
        kind: 'booking',
        contactName: 'Dana',
        contactPhone: '+7701',
        createdAt,
      });

      store.deletePersonalData(id);

      expect(store.getOrCreateConversation('whatsapp', '777').history).toEqual([]);
      const leads = store.listLeads();
      const masked = leads.find((l) => l.conversationId === id)!;
      expect(masked.contactName).toBe('***');
      expect(masked.contactPhone).toBe('***');
      const other = leads.find((l) => l.conversationId === 'telegram:other')!;
      expect(other.contactName).toBe('Dana');
      const [booking] = store.listBookings();
      expect(booking.guestName).toBe('***');
      expect(booking.guestPhone).toBe('***');
      const [mice] = store.listMice();
      expect(mice.contactName).toBe('***');
      expect(mice.contactPhone).toBe('***');
    });
  });
});

describe('мёртвые получатели заявок', () => {
  it('отключается тот, кому Telegram отвечает 403', () => {
    // Заблокировавший бота менеджер иначе остаётся в списке навсегда: каждая заявка
    // даёт ошибку, и за этим шумом перестают быть видны настоящие сбои доставки.
    const s = new Store(':memory:');
    s.setStaffChat('almaty', '111', 'Живой');
    s.setStaffChat('almaty', '222', 'Заблокировал бота');
    expect(s.staffChatsFor('almaty')).toHaveLength(2);

    expect(s.deactivateStaffChat('222')).toBe(true);
    const left = s.staffChatsFor('almaty');
    expect(left).toHaveLength(1);
    expect(left[0].chatId).toBe('111');
  });

  it('повторное отключение ничего не меняет', () => {
    const s = new Store(':memory:');
    s.setStaffChat('almaty', '222', 'Кто-то');
    expect(s.deactivateStaffChat('222')).toBe(true);
    expect(s.deactivateStaffChat('222')).toBe(false);
    expect(s.deactivateStaffChat('нет такого')).toBe(false);
  });
});
