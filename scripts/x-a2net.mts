import Anthropic from '@anthropic-ai/sdk';
import { Engine } from '/Users/abzalm/kazzhol-ai/src/core/engine';
import { Store } from '/Users/abzalm/kazzhol-ai/src/store';
import { config } from '/Users/abzalm/kazzhol-ai/src/config';
import { RateLimiter } from '/Users/abzalm/kazzhol-ai/src/core/rateLimit';
const store = new Store(':memory:');
const engine = new Engine({
  store, client: new Anthropic({ apiKey: config.anthropicApiKey }), model: config.anthropicModel,
  availabilityProvider: { search: async (q: any) => { console.log('   >> check_availability(' + JSON.stringify(q) + ') -> []'); return []; } } as any, bookingService: {} as any,
  paymentGateway: {} as any, crm: { createLead: async () => undefined } as any,
  staffNotifier: { notify: async () => undefined }, rateLimiter: new RateLimiter(),
} as any);
const CASES: Array<[string, string, string[]]> = [
  ['A2-netmest-run1', 'almaty', ['Добрый день! Нужен номер на 12-14 сентября, 2 взрослых.']],
  ['A2-netmest-run2', 'almaty', ['Добрый день! Нужен номер на 12-14 сентября, 2 взрослых.']],
  ['A2-netmest-run3', 'almaty', ['Добрый день! Нужен номер на 12-14 сентября, 2 взрослых.']],
  ['A2-netmest-run4', 'almaty', ['Добрый день! Нужен номер на 12-14 сентября, 2 взрослых.']],
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
