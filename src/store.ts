import Database from 'better-sqlite3';
import type { ChatMessage, Conversation, ConversationStatus, BookingLead } from './types';

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        chat_id   INTEGER PRIMARY KEY,
        property  TEXT NOT NULL,
        status    TEXT NOT NULL,
        history   TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS leads (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id       INTEGER NOT NULL,
        check_in      TEXT NOT NULL,
        check_out     TEXT NOT NULL,
        guests        INTEGER NOT NULL,
        room_type     TEXT NOT NULL,
        contact_name  TEXT NOT NULL,
        contact_phone TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );
    `);
  }

  getOrCreateConversation(chatId: number, property: string): Conversation {
    const row = this.db
      .prepare('SELECT chat_id, property, status, history FROM conversations WHERE chat_id = ?')
      .get(chatId) as
      | { chat_id: number; property: string; status: ConversationStatus; history: string }
      | undefined;

    if (row) {
      return {
        chatId: row.chat_id,
        property: row.property,
        status: row.status,
        history: JSON.parse(row.history) as ChatMessage[],
      };
    }
    this.db
      .prepare('INSERT INTO conversations (chat_id, property, status, history) VALUES (?, ?, ?, ?)')
      .run(chatId, property, 'active', '[]');
    return { chatId, property, status: 'active', history: [] };
  }

  appendMessage(chatId: number, message: ChatMessage): void {
    const convo = this.getOrCreateConversation(chatId, 'astana');
    const history = [...convo.history, message];
    this.db
      .prepare('UPDATE conversations SET history = ? WHERE chat_id = ?')
      .run(JSON.stringify(history), chatId);
  }

  setStatus(chatId: number, status: ConversationStatus): void {
    this.db.prepare('UPDATE conversations SET status = ? WHERE chat_id = ?').run(status, chatId);
  }

  saveLead(lead: BookingLead): void {
    this.db
      .prepare(
        `INSERT INTO leads
        (chat_id, check_in, check_out, guests, room_type, contact_name, contact_phone, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        lead.chatId,
        lead.checkIn,
        lead.checkOut,
        lead.guests,
        lead.roomType,
        lead.contactName,
        lead.contactPhone,
        lead.createdAt,
      );
  }

  listLeads(): BookingLead[] {
    const rows = this.db.prepare('SELECT * FROM leads ORDER BY id').all() as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => ({
      chatId: r.chat_id as number,
      checkIn: r.check_in as string,
      checkOut: r.check_out as string,
      guests: r.guests as number,
      roomType: r.room_type as string,
      contactName: r.contact_name as string,
      contactPhone: r.contact_phone as string,
      createdAt: r.created_at as string,
    }));
  }
}
