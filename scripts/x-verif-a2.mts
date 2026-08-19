import Anthropic from '@anthropic-ai/sdk';
import { Engine } from '/Users/abzalm/kazzhol-ai/src/core/engine';
import { Store } from '/Users/abzalm/kazzhol-ai/src/store';
import { config } from '/Users/abzalm/kazzhol-ai/src/config';
import { RateLimiter } from '/Users/abzalm/kazzhol-ai/src/core/rateLimit';
const store = new Store(':memory:');
const offer = (roomType: string, price: number, available: boolean) => ({
  roomType, available, pricePerNight: price, currency: 'KZT',
  roomTypeId: 'rt-' + roomType, ratePlanId: 'rp1', ratePlanName: '基本 / Основной с завтраком',
  totalPrice: price * 2, checksum: 'chk', placements: ['adult-1', 'adult-2'],
  bookingFormLink: 'https://example.com/book', discounts: [],
  cancellationPolicy: { freeCancellationPossible: true, freeCancellationDeadline: '2026-09-11T14:59', penaltyAmount: null },
});
const availabilityProvider = {
  checkAvailability: async (q: any) => {
    console.log('   [tool check_availability] property=' + q.property + ' ' + q.checkIn + '→' + q.checkOut + ' guests=' + q.guests);
    if (q.property === 'almaty') return { property: q.property, checkIn: q.checkIn, checkOut: q.checkOut, offers: [], source: 'exely' };
    if (q.property === 'park') return { property: q.property, checkIn: q.checkIn, checkOut: q.checkOut, offers: [offer('Standard Double', 28000, true)], source: 'exely' };
    return { property: q.property, checkIn: q.checkIn, checkOut: q.checkOut, offers: [offer('Standard Twin', 32000, true)], source: 'exely' };
  },
};
const engine = new Engine({
  store, client: new Anthropic({ apiKey: config.anthropicApiKey }), model: config.anthropicModel,
  availabilityProvider: availabilityProvider as any, bookingService: {} as any,
  paymentGateway: {} as any, crm: { createLead: async () => undefined } as any,
  staffNotifier: { notify: async () => undefined }, rateLimiter: new RateLimiter(),
} as any);
const CASES: Array<[string, string, string[]]> = [
  ['A1-real-run1', 'almaty', ['Здравствуйте! Смотрю ваш отель, но для нас дороговато. Есть у вас что-то подешевле?', 'Даты 12-14 сентября, 2 взрослых.']],
  ['A1-real-run2', 'almaty', ['Здравствуйте! Смотрю ваш отель, но для нас дороговато. Есть у вас что-то подешевле?', 'Даты 12-14 сентября, 2 взрослых.']],
];
for (const [id, prop, turns] of CASES) {
  const sid = id + '-' + Math.floor(Math.random() * 1e6);
  const c = store.getOrCreateConversation('webwidget', sid);
  store.setProperty(c.id, prop);
  console.log('\n===== ' + id + ' (чат отеля: ' + prop + ') =====');
  for (const t of turns) {
    const r: any = await engine.handle({ channel: 'webwidget', senderId: sid, text: t } as any);
    const out = (Array.isArray(r) ? r : r.parts ?? []).map((p: any) => p.text).join(' ');
    console.log('ГОСТЬ: ' + t);
    console.log('БОТ [' + out.length + ']: ' + out);
  }
}
process.exit(0);
