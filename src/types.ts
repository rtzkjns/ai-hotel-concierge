export type Role = 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string;
}

export type Channel = 'whatsapp' | 'telegram' | 'webwidget' | 'instagram';

export type ConversationStatus = 'active' | 'handed_off';

export type Language = 'ru' | 'kk' | 'en' | 'zh';

export interface Conversation {
  /** `${channel}:${senderId}` */
  id: string;
  channel: Channel;
  senderId: string;
  property: string; // e.g. 'almaty'; '' until the guest picks a hotel
  status: ConversationStatus;
  language: Language | null;
  history: ChatMessage[];
  updatedAt: string; // ISO timestamp
  /** Console login of the staff member who took the chat over; null when bot-owned. */
  takenBy: string | null;
}

export type LeadKind = 'booking' | 'generic';

export interface BookingLead {
  id?: number;
  conversationId: string;
  kind: LeadKind;
  // Booking fields are absent for kind='generic'.
  checkIn?: string; // YYYY-MM-DD
  checkOut?: string; // YYYY-MM-DD
  guests?: number;
  roomType?: string;
  contactName?: string;
  contactPhone?: string;
  specialRequests?: string;
  createdAt: string; // ISO timestamp
}

export interface Booking {
  id?: number;
  conversationId: string;
  property: string;
  exelyNumber: string;
  status: string;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  guests: number;
  roomType: string;
  ratePlanId?: string;
  total?: number;
  currency?: string;
  guestName?: string;
  guestPhone?: string;
  upsellOffered?: boolean;
  upsellAccepted?: boolean;
  createdAt: string; // ISO timestamp
}

export interface MiceRequest {
  id?: number;
  conversationId: string;
  property: string;
  eventDate?: string;
  peopleCount?: number;
  halls?: string;
  catering?: string;
  budget?: string;
  contactName?: string;
  contactPhone?: string;
  notes?: string;
  status?: string; // defaults to 'new'
  createdAt: string; // ISO timestamp
}

export interface StoredEvent {
  id: number;
  type: string;
  conversationId: string | null;
  property: string | null;
  channel: string | null;
  payload: unknown;
  createdAt: string; // ISO timestamp
}

export interface StaffMember {
  id: number;
  login: string;
  passHash: string;
  role: string;
  createdAt: string; // ISO timestamp
}

export interface StaffSession {
  token: string;
  staffId: number;
  login: string;
  role: string;
  expiresAt: string; // ISO timestamp
}
