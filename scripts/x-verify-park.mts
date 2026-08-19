import Anthropic from '@anthropic-ai/sdk';
import { Engine } from '/Users/abzalm/kazzhol-ai/src/core/engine';
import { Store } from '/Users/abzalm/kazzhol-ai/src/store';
import { config } from '/Users/abzalm/kazzhol-ai/src/config';
import { RateLimiter } from '/Users/abzalm/kazzhol-ai/src/core/rateLimit';
const store = new Store(':memory:');
const availabilityProvider: any = {
  checkAvailability: async (q: any) => {
    console.log('   >> TOOL check_availability', JSON.stringify(q));
    if (q.property === 'park_almaty') {
      return { property: q.property, checkIn: q.checkIn, checkOut: q.checkOut, offers: [], source: 'exely' };
    }
    return {
      property: q.property,
      checkIn: q.checkIn,
      checkOut: q.checkOut,
      source: 'exely',
      offers: [
        { roomTypeId: '1', roomName: 'Стандарт двухместный', ratePlanId: 'r1', ratePlanName: 'Завтрак включён', totalPrice: 42000, currency: 'KZT', available: 4 },
      ],
    };
  },
};
const engine = new Engine({
  store, client: new Anthropic({ apiKey: config.anthropicApiKey }), model: config.anthropicModel,
  availabilityProvider, bookingService: {} as any,
  paymentGateway: {} as any, crm: { createLead: async () => undefined } as any,
  staffNotifier: { notify: async () => undefined }, rateLimiter: new RateLimiter(),
} as any);
const CASES: Array<[string, string, string[]]> = [
  ['P3-netmest-A', 'park_almaty', ['Нужен номер с 20 по 22 сентября, 2 взрослых. Есть места?']],
  ['P3-netmest-B', 'park_almaty', ['Нужен номер с 20 по 22 сентября, 2 взрослых. Есть места?']],
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
