import type { Channel } from '../types';

/** A normalized guest message from any channel, ready for the engine. */
export interface InboundMessage {
  channel: Channel;
  senderId: string;
  /**
   * Channel-provided hint about which hotel this message belongs to:
   * a property key, or a WhatsApp phone_number_id the engine resolves via its map.
   */
  propertyHint?: string;
  text?: string;
  audio?: { data: Buffer; mime: string };
  /** Channel-native message id (used e.g. for WhatsApp read receipts). */
  inboundId?: string;
}

/** One outgoing chat bubble plus the human-feeling pause before sending it. */
export interface OutboundPart {
  text: string;
  delayMs: number;
}

export interface ChannelAdapter {
  channel: Channel;
  send(senderId: string, parts: OutboundPart[]): Promise<void>;
  typing?(senderId: string, inboundId?: string): Promise<void>;
}

/** Where staff alerts go (Telegram staff chat or console fallback). Text must be pre-masked. */
export interface StaffNotifier {
  /**
   * `property` маршрутизирует уведомление в чат КОНКРЕТНОГО отеля: менеджеры Астаны не должны
   * видеть заявки Алматы. Без него — в общий чат (владелец/дежурный).
   */
  notify(text: string, property?: string): Promise<void> | void;
}
