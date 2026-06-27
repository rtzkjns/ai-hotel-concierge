export type Role = 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string;
}

export type ConversationStatus = 'active' | 'handed_off';

export interface Conversation {
  chatId: number;
  property: string; // e.g. 'astana'
  status: ConversationStatus;
  history: ChatMessage[];
}

export interface BookingLead {
  chatId: number;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  guests: number;
  roomType: string;
  contactName: string;
  contactPhone: string;
  specialRequests?: string;
  createdAt: string; // ISO timestamp
}
