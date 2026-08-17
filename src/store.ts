import Database from 'better-sqlite3';
import type {
  Booking,
  BookingLead,
  Channel,
  ChatMessage,
  Conversation,
  ConversationStatus,
  HotelContent,
  KbEntry,
  Language,
  LeadKind,
  MiceRequest,
  StaffMember,
  StaffSession,
  StoredEvent,
} from './types';

const HISTORY_CAP = 60;

function nowIso(): string {
  return new Date().toISOString();
}

function cutoffIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export class Store {
  private db: Database.Database;


  /**
   * База знаний, редактируемая владельцем и менеджерами из панели.
   * kind: 'fact'   — факт об отеле, попадает в промпт как знание
   *       'tone'   — правило общения («как говорить / как не говорить»)
   *       'source' — ссылка-источник, содержимое подтягивается фоново в body
   * Смысл: отель может сам добавить акцию, новую услугу или сайт, и бот учтёт это
   * со следующего сообщения гостя — без разработчика и без редеплоя.
   */
  listKbEntries(property?: string, kind?: string, includeArchived = false): KbEntry[] {
    let sql = 'SELECT * FROM kb_entries WHERE 1=1';
    const args: unknown[] = [];
    // Архивные записи не участвуют ни в ответах бота, ни в списке — только на своей странице.
    sql += includeArchived ? ' AND archived = 1' : ' AND archived = 0';
    if (property) { sql += " AND (property = ? OR property = '')"; args.push(property); }
    if (kind) { sql += ' AND kind = ?'; args.push(kind); }
    sql += ' ORDER BY kind, id DESC';
    return this.db.prepare(sql).all(...(args as never[])) as KbEntry[];
  }

  addKbEntry(e: Omit<KbEntry, 'id' | 'updatedAt'>): number {
    const r = this.db
      .prepare(
        `INSERT INTO kb_entries (property, kind, title, body, url, active, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.property, e.kind, e.title, e.body, e.url ?? null, e.active ? 1 : 0, new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  getKbEntry(id: number): KbEntry | null {
    return (this.db.prepare('SELECT * FROM kb_entries WHERE id = ?').get(id) as KbEntry) ?? null;
  }

  /**
   * «В архив» вместо DELETE: правка отеля обратима, а удаление навсегда живёт
   * отдельной страницей. Так владелец не боится трогать базу знаний.
   */
  archiveKbEntry(id: number, archived = true): void {
    this.db
      .prepare('UPDATE kb_entries SET archived = ?, active = CASE WHEN ? THEN 0 ELSE active END, updated_at = ? WHERE id = ?')
      .run(archived ? 1 : 0, archived ? 1 : 0, new Date().toISOString(), id);
  }

  updateKbEntry(id: number, patch: Partial<Pick<KbEntry, 'title' | 'body' | 'url' | 'active'>>): void {
    const cur = this.db.prepare('SELECT * FROM kb_entries WHERE id = ?').get(id) as KbEntry | undefined;
    if (!cur) return;
    this.db
      .prepare('UPDATE kb_entries SET title=?, body=?, url=?, active=?, updated_at=? WHERE id=?')
      .run(
        patch.title ?? cur.title,
        patch.body ?? cur.body,
        patch.url ?? cur.url ?? null,
        (patch.active ?? cur.active) ? 1 : 0,
        new Date().toISOString(),
        id,
      );
  }

  /**
   * Привязка Telegram-группы к отелю. Менеджеры добавляют бота в свою группу и пишут
   * «/привязать <отель>» — id чата определяется сам, вручную ничего копировать не нужно.
   * Хранится в kb_entries (kind='staffchat'), чтобы не плодить таблицы.
   */
  setStaffChat(property: string, chatId: string): void {
    const existing = this.db
      .prepare("SELECT id FROM kb_entries WHERE kind='staffchat' AND property=?")
      .get(property) as { id: number } | undefined;
    if (existing) {
      this.db
        .prepare('UPDATE kb_entries SET body=?, updated_at=? WHERE id=?')
        .run(chatId, new Date().toISOString(), existing.id);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO kb_entries (property, kind, title, body, url, active, updated_at)
         VALUES (?, 'staffchat', 'Чат менеджеров', ?, NULL, 1, ?)`,
      )
      .run(property, chatId, new Date().toISOString());
  }

  staffChatFor(property: string): string | undefined {
    const r = this.db
      .prepare("SELECT body FROM kb_entries WHERE kind='staffchat' AND property=? AND active=1")
      .get(property) as { body: string } | undefined;
    return r?.body;
  }

  deleteKbEntry(id: number): void {
    this.db.prepare('DELETE FROM kb_entries WHERE id = ?').run(id);
  }

  /** Flush and release the SQLite handle on shutdown (WAL checkpoint happens on close). */
  close(): void {
    this.db.close();
  }

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.dropLegacyTables();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id         TEXT PRIMARY KEY,
        channel    TEXT NOT NULL,
        sender_id  TEXT NOT NULL,
        property   TEXT NOT NULL DEFAULT '',
        status     TEXT NOT NULL DEFAULT 'active',
        language   TEXT,
        history    TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        taken_by   TEXT
      );
      CREATE TABLE IF NOT EXISTS leads (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        kind            TEXT NOT NULL,
        check_in        TEXT,
        check_out       TEXT,
        guests          INTEGER,
        room_type       TEXT,
        contact_name    TEXT,
        contact_phone   TEXT,
        special_requests TEXT,
        created_at      TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kb_entries (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        property   TEXT NOT NULL DEFAULT '',
        kind       TEXT NOT NULL,
        title      TEXT NOT NULL DEFAULT '',
        body       TEXT NOT NULL DEFAULT '',
        url        TEXT,
        active     INTEGER NOT NULL DEFAULT 1,
        archived   INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hotel_content (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        property   TEXT NOT NULL,
        kind       TEXT NOT NULL DEFAULT 'promo',
        title      TEXT NOT NULL DEFAULT '',
        body       TEXT NOT NULL,
        source     TEXT NOT NULL DEFAULT 'staff',
        active     INTEGER NOT NULL DEFAULT 1,
        starts_at  TEXT,
        ends_at    TEXT,
        updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_hotel_content_prop ON hotel_content(property, active);
      CREATE TABLE IF NOT EXISTS bookings (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        property        TEXT NOT NULL,
        exely_number    TEXT,
        status          TEXT NOT NULL,
        check_in        TEXT,
        check_out       TEXT,
        guests          INTEGER,
        room_type       TEXT,
        rate_plan_id    TEXT,
        total           REAL,
        currency        TEXT,
        guest_name      TEXT,
        guest_phone     TEXT,
        upsell_offered  INTEGER DEFAULT 0,
        upsell_accepted INTEGER DEFAULT 0,
        created_at      TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mice_requests (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        property        TEXT NOT NULL,
        event_date      TEXT,
        people_count    INTEGER,
        halls           TEXT,
        catering        TEXT,
        budget          TEXT,
        contact_name    TEXT,
        contact_phone   TEXT,
        notes           TEXT,
        status          TEXT NOT NULL DEFAULT 'new',
        created_at      TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        type            TEXT NOT NULL,
        conversation_id TEXT,
        property        TEXT,
        channel         TEXT,
        payload         TEXT,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(type, created_at);
      CREATE TABLE IF NOT EXISTS staff (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        login      TEXT NOT NULL UNIQUE,
        pass_hash  TEXT NOT NULL,
        role       TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT PRIMARY KEY,
        staff_id   INTEGER NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
  }

  /** Pre-multichannel schemas keyed conversations/leads by Telegram chat_id. No prod data exists. */
  private dropLegacyTables(): void {
    const hasColumn = (table: string, column: string): boolean => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return cols.some((c) => c.name === column);
    };
    if (hasColumn('conversations', 'chat_id')) this.db.exec('DROP TABLE IF EXISTS conversations');
    if (hasColumn('leads', 'chat_id')) this.db.exec('DROP TABLE IF EXISTS leads');
    // Databases created before the takeover-ownership column existed.
    const hasConversations = (
      this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'").get()
    ) !== undefined;
    if (hasConversations && !hasColumn('conversations', 'taken_by')) {
      this.db.exec('ALTER TABLE conversations ADD COLUMN taken_by TEXT');
    }
    // «В архив» появилось позже самой базы знаний — доливаем колонку на живой базе.
    const hasKb = (
      this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kb_entries'").get()
    ) !== undefined;
    if (hasKb && !hasColumn('kb_entries', 'archived')) {
      this.db.exec('ALTER TABLE kb_entries ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
    }
  }

  // --- Conversations -----------------------------------------------------

  getOrCreateConversation(channel: Channel, senderId: string): Conversation {
    const id = `${channel}:${senderId}`;
    const row = this.db
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (row) return this.mapConversation(row);
    const updatedAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO conversations (id, channel, sender_id, property, status, language, history, updated_at)
         VALUES (?, ?, ?, '', 'active', NULL, '[]', ?)`,
      )
      .run(id, channel, senderId, updatedAt);
    return {
      id,
      channel,
      senderId,
      property: '',
      status: 'active',
      language: null,
      history: [],
      updatedAt,
      takenBy: null,
    };
  }

  /** Read-only lookup by id (console pages must never create conversations). */
  getConversation(id: string): Conversation | null {
    const row = this.db
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapConversation(row) : null;
  }

  setProperty(id: string, property: string): void {
    this.db
      .prepare('UPDATE conversations SET property = ?, updated_at = ? WHERE id = ?')
      .run(property, nowIso(), id);
  }

  setStatus(id: string, status: ConversationStatus): void {
    this.db
      .prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowIso(), id);
  }

  /** Records which console login owns a taken-over chat (null = bot-owned again). */
  setTakenBy(id: string, login: string | null): void {
    this.db.prepare('UPDATE conversations SET taken_by = ? WHERE id = ?').run(login, id);
  }

  setLanguage(id: string, language: Language | null): void {
    this.db.prepare('UPDATE conversations SET language = ? WHERE id = ?').run(language, id);
  }

  /** Reset to a fresh session: no hotel chosen, active, no language, empty history. */
  resetConversation(id: string): void {
    this.db
      .prepare(
        `UPDATE conversations
         SET property = '', status = 'active', language = NULL, history = '[]', updated_at = ?
         WHERE id = ?`,
      )
      .run(nowIso(), id);
  }

  appendMessage(id: string, message: ChatMessage): void {
    const row = this.db.prepare('SELECT history FROM conversations WHERE id = ?').get(id) as
      | { history: string }
      | undefined;
    const history = row ? (JSON.parse(row.history) as ChatMessage[]) : [];
    history.push(message);
    const capped = history.slice(-HISTORY_CAP);
    this.db
      .prepare('UPDATE conversations SET history = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(capped), nowIso(), id);
  }

  listConversations(activeWithinDays = 7): Conversation[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM conversations WHERE updated_at >= ? ORDER BY updated_at DESC, rowid DESC',
      )
      .all(cutoffIso(activeWithinDays)) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapConversation(r));
  }

  private mapConversation(row: Record<string, unknown>): Conversation {
    return {
      id: row.id as string,
      channel: row.channel as Channel,
      senderId: row.sender_id as string,
      property: row.property as string,
      status: row.status as ConversationStatus,
      language: (row.language as Language | null) ?? null,
      history: JSON.parse(row.history as string) as ChatMessage[],
      updatedAt: row.updated_at as string,
      takenBy: (row.taken_by as string | null) ?? null,
    };
  }

  // --- Leads --------------------------------------------------------------

  saveLead(lead: BookingLead): void {
    this.db
      .prepare(
        `INSERT INTO leads
         (conversation_id, kind, check_in, check_out, guests, room_type,
          contact_name, contact_phone, special_requests, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        lead.conversationId,
        lead.kind,
        lead.checkIn ?? null,
        lead.checkOut ?? null,
        lead.guests ?? null,
        lead.roomType ?? null,
        lead.contactName ?? null,
        lead.contactPhone ?? null,
        lead.specialRequests ?? null,
        lead.createdAt,
      );
  }

  listLeads(): BookingLead[] {
    const rows = this.db.prepare('SELECT * FROM leads ORDER BY id').all() as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => ({
      id: r.id as number,
      conversationId: r.conversation_id as string,
      kind: r.kind as LeadKind,
      checkIn: (r.check_in as string | null) ?? undefined,
      checkOut: (r.check_out as string | null) ?? undefined,
      guests: (r.guests as number | null) ?? undefined,
      roomType: (r.room_type as string | null) ?? undefined,
      contactName: (r.contact_name as string | null) ?? undefined,
      contactPhone: (r.contact_phone as string | null) ?? undefined,
      specialRequests: (r.special_requests as string | null) ?? undefined,
      createdAt: r.created_at as string,
    }));
  }

  // --- Hotel content (live promos / announcements / facts, editable per hotel) ----

  private mapContent(r: Record<string, unknown>): HotelContent {
    return {
      id: r.id as number,
      property: r.property as string,
      kind: r.kind as HotelContent['kind'],
      title: (r.title as string) ?? '',
      body: r.body as string,
      source: r.source as HotelContent['source'],
      active: Number(r.active) === 1,
      startsAt: (r.starts_at as string | null) ?? null,
      endsAt: (r.ends_at as string | null) ?? null,
      updatedAt: r.updated_at as string,
      createdAt: r.created_at as string,
    };
  }

  /** Active, in-window content for a hotel — injected into the prompt each turn. */
  listActiveContent(property: string, now: string = nowIso()): HotelContent[] {
    // Kazakhstan is UTC+5 (no DST) — compare on the hotel's LOCAL calendar date so a promo
    // dated "starts today" is live from local 00:00, not from 05:00 (the UTC-midnight skew).
    // substr(...,1,10) normalizes any stored value (bare YYYY-MM-DD or full ISO) to its date.
    const localDate = new Date(Date.parse(now) + 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const rows = this.db
      .prepare(
        `SELECT * FROM hotel_content
         WHERE property = ? AND active = 1
           AND (starts_at IS NULL OR substr(starts_at, 1, 10) <= ?)
           AND (ends_at   IS NULL OR substr(ends_at, 1, 10)   >= ?)
         ORDER BY kind, updated_at DESC`,
      )
      .all(property, localDate, localDate) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapContent(r));
  }

  /** All content (any status) for the admin console; optionally scoped to one hotel. */
  listContentForAdmin(property?: string): HotelContent[] {
    const rows = (
      property
        ? this.db
            .prepare('SELECT * FROM hotel_content WHERE property = ? ORDER BY id DESC')
            .all(property)
        : this.db.prepare('SELECT * FROM hotel_content ORDER BY property, id DESC').all()
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapContent(r));
  }

  addContent(c: {
    property: string;
    kind: HotelContent['kind'];
    title?: string;
    body: string;
    source?: HotelContent['source'];
    startsAt?: string | null;
    endsAt?: string | null;
  }): number {
    const ts = nowIso();
    const info = this.db
      .prepare(
        `INSERT INTO hotel_content
         (property, kind, title, body, source, active, starts_at, ends_at, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        c.property,
        c.kind,
        c.title ?? '',
        c.body,
        c.source ?? 'staff',
        c.startsAt ?? null,
        c.endsAt ?? null,
        ts,
        ts,
      );
    return Number(info.lastInsertRowid);
  }

  setContentActive(id: number, active: boolean): void {
    this.db
      .prepare('UPDATE hotel_content SET active = ?, updated_at = ? WHERE id = ?')
      .run(active ? 1 : 0, nowIso(), id);
  }

  deleteContent(id: number): void {
    this.db.prepare('DELETE FROM hotel_content WHERE id = ?').run(id);
  }

  // --- Bookings -----------------------------------------------------------

  saveBooking(b: Booking): void {
    this.db
      .prepare(
        `INSERT INTO bookings
         (conversation_id, property, exely_number, status, check_in, check_out, guests,
          room_type, rate_plan_id, total, currency, guest_name, guest_phone,
          upsell_offered, upsell_accepted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        b.conversationId,
        b.property,
        b.exelyNumber,
        b.status,
        b.checkIn,
        b.checkOut,
        b.guests,
        b.roomType,
        b.ratePlanId ?? null,
        b.total ?? null,
        b.currency ?? null,
        b.guestName ?? null,
        b.guestPhone ?? null,
        b.upsellOffered ? 1 : 0,
        b.upsellAccepted ? 1 : 0,
        b.createdAt,
      );
  }

  updateBookingStatus(exelyNumber: string, status: string): void {
    this.db.prepare('UPDATE bookings SET status = ? WHERE exely_number = ?').run(status, exelyNumber);
  }

  listBookings(): Booking[] {
    const rows = this.db.prepare('SELECT * FROM bookings ORDER BY id').all() as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => ({
      id: r.id as number,
      conversationId: r.conversation_id as string,
      property: r.property as string,
      exelyNumber: r.exely_number as string,
      status: r.status as string,
      checkIn: r.check_in as string,
      checkOut: r.check_out as string,
      guests: r.guests as number,
      roomType: r.room_type as string,
      ratePlanId: (r.rate_plan_id as string | null) ?? undefined,
      total: (r.total as number | null) ?? undefined,
      currency: (r.currency as string | null) ?? undefined,
      guestName: (r.guest_name as string | null) ?? undefined,
      guestPhone: (r.guest_phone as string | null) ?? undefined,
      upsellOffered: (r.upsell_offered as number) === 1,
      upsellAccepted: (r.upsell_accepted as number) === 1,
      createdAt: r.created_at as string,
    }));
  }

  // --- MICE ----------------------------------------------------------------

  saveMice(m: MiceRequest): void {
    this.db
      .prepare(
        `INSERT INTO mice_requests
         (conversation_id, property, event_date, people_count, halls, catering, budget,
          contact_name, contact_phone, notes, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.conversationId,
        m.property,
        m.eventDate ?? null,
        m.peopleCount ?? null,
        m.halls ?? null,
        m.catering ?? null,
        m.budget ?? null,
        m.contactName ?? null,
        m.contactPhone ?? null,
        m.notes ?? null,
        m.status ?? 'new',
        m.createdAt,
      );
  }

  listMice(): MiceRequest[] {
    const rows = this.db.prepare('SELECT * FROM mice_requests ORDER BY id').all() as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => ({
      id: r.id as number,
      conversationId: r.conversation_id as string,
      property: r.property as string,
      eventDate: (r.event_date as string | null) ?? undefined,
      peopleCount: (r.people_count as number | null) ?? undefined,
      halls: (r.halls as string | null) ?? undefined,
      catering: (r.catering as string | null) ?? undefined,
      budget: (r.budget as string | null) ?? undefined,
      contactName: (r.contact_name as string | null) ?? undefined,
      contactPhone: (r.contact_phone as string | null) ?? undefined,
      notes: (r.notes as string | null) ?? undefined,
      status: r.status as string,
      createdAt: r.created_at as string,
    }));
  }

  setMiceStatus(id: number, status: string): void {
    this.db.prepare('UPDATE mice_requests SET status = ? WHERE id = ?').run(status, id);
  }

  // --- Events (append-only analytics) ---------------------------------------

  recordEvent(
    type: string,
    data: { conversationId?: string; property?: string; channel?: string; payload?: unknown } = {},
  ): void {
    this.db
      .prepare(
        `INSERT INTO events (type, conversation_id, property, channel, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        type,
        data.conversationId ?? null,
        data.property ?? null,
        data.channel ?? null,
        data.payload === undefined ? null : JSON.stringify(data.payload),
        nowIso(),
      );
  }

  listEvents(sinceIso: string): StoredEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE created_at >= ? ORDER BY id')
      .all(sinceIso) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      type: r.type as string,
      conversationId: (r.conversation_id as string | null) ?? null,
      property: (r.property as string | null) ?? null,
      channel: (r.channel as string | null) ?? null,
      payload: r.payload === null ? undefined : JSON.parse(r.payload as string),
      createdAt: r.created_at as string,
    }));
  }

  countEvents(type: string, sinceIso: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE type = ? AND created_at >= ?')
      .get(type, sinceIso) as { n: number };
    return row.n;
  }

  // --- Staff & sessions ------------------------------------------------------

  createStaff(login: string, passHash: string, role: string): number {
    const result = this.db
      .prepare('INSERT INTO staff (login, pass_hash, role, created_at) VALUES (?, ?, ?, ?)')
      .run(login, passHash, role, nowIso());
    return Number(result.lastInsertRowid);
  }

  findStaffByLogin(login: string): StaffMember | null {
    const row = this.db.prepare('SELECT * FROM staff WHERE login = ?').get(login) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as number,
      login: row.login as string,
      passHash: row.pass_hash as string,
      role: row.role as string,
      createdAt: row.created_at as string,
    };
  }

  countStaff(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM staff').get() as { n: number };
    return row.n;
  }

  createSession(token: string, staffId: number, expiresAtIso: string): void {
    this.db
      .prepare('INSERT INTO sessions (token, staff_id, expires_at) VALUES (?, ?, ?)')
      .run(token, staffId, expiresAtIso);
  }

  findSession(token: string): StaffSession | null {
    const row = this.db
      .prepare(
        `SELECT s.token, s.staff_id, s.expires_at, st.login, st.role
         FROM sessions s JOIN staff st ON st.id = s.staff_id
         WHERE s.token = ?`,
      )
      .get(token) as
      | { token: string; staff_id: number; expires_at: string; login: string; role: string }
      | undefined;
    if (!row || row.expires_at <= nowIso()) return null;
    return {
      token: row.token,
      staffId: row.staff_id,
      login: row.login,
      role: row.role,
      expiresAt: row.expires_at,
    };
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  // --- Retention & privacy -----------------------------------------------------

  /** Delete old events; empty histories of conversations idle for more than N days. */
  purgeOlderThan(days: number): void {
    const cutoff = cutoffIso(days);
    this.db.prepare('DELETE FROM events WHERE created_at < ?').run(cutoff);
    this.db
      .prepare("UPDATE conversations SET history = '[]' WHERE updated_at < ?")
      .run(cutoff);
    // Abandoned console sessions must not accumulate forever.
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
  }

  /** Guest right-to-erasure: wipe history and mask names/phones tied to a conversation. */
  deletePersonalData(conversationId: string): void {
    this.db
      .prepare("UPDATE conversations SET history = '[]' WHERE id = ?")
      .run(conversationId);
    this.db
      .prepare(
        "UPDATE leads SET contact_name = '***', contact_phone = '***' WHERE conversation_id = ?",
      )
      .run(conversationId);
    this.db
      .prepare(
        "UPDATE bookings SET guest_name = '***', guest_phone = '***' WHERE conversation_id = ?",
      )
      .run(conversationId);
    this.db
      .prepare(
        "UPDATE mice_requests SET contact_name = '***', contact_phone = '***' WHERE conversation_id = ?",
      )
      .run(conversationId);
  }
}
