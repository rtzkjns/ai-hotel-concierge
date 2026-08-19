import Anthropic from '@anthropic-ai/sdk';
import { Engine } from '/Users/abzalm/kazzhol-ai/src/core/engine';
import { Store } from '/Users/abzalm/kazzhol-ai/src/store';
import { config } from '/Users/abzalm/kazzhol-ai/src/config';
import { RateLimiter } from '/Users/abzalm/kazzhol-ai/src/core/rateLimit';
const store = new Store(':memory:');
const engine = new Engine({
  store, client: new Anthropic({ apiKey: config.anthropicApiKey }), model: config.anthropicModel,
  availabilityProvider: { search: async () => [] } as any, bookingService: {} as any,
  paymentGateway: {} as any, crm: { createLead: async () => undefined } as any,
  staffNotifier: { notify: async () => undefined }, rateLimiter: new RateLimiter(),
} as any);
const CASES: Array<[string, string, string[]]> = [
  ['P1-basseyn-run1', 'park_almaty', ['Здравствуйте! А у вас есть бассейн и сауна? Для нас это важно.']],
  ['P1-basseyn-run2', 'park_almaty', ['Здравствуйте! А у вас есть бассейн и сауна? Для нас это важно.']],
  ['P1-basseyn-run3', 'park_almaty', ['Здравствуйте! А у вас есть бассейн и сауна? Для нас это важно.']],
  ['P3-netmest-run1', 'park_almaty', ['Добрый день! Нужен номер в Алматы с 20 по 22 сентября, двухместный.', 'А если у вас нет мест на эти даты?']],
  ['P3-netmest-run2', 'park_almaty', ['Добрый день! Нужен номер в Алматы с 20 по 22 сентября, двухместный.', 'А если у вас нет мест на эти даты?']],
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
