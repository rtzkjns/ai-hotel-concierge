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
  ['W1-группа', 'astana', ['нас 6 человек, командировка, 10-12 сентября. что предложите?']],
  ['W2-сумбур', 'almaty', ['здравствуйте на 3 сут двое взрослых ребенок 4 года с 1 сентября номер с двумя кроватями завтрак входит? и парковка есть? оплата картой на месте можно']],
  ['W3-booking-дорого', 'almaty', ['Почему у вас так дорого? На Booking такой же отель рядом в два раза дешевле']],
  ['W4-en-2вопроса', 'park_almaty', ['Hi, is breakfast included and do you have airport pickup?']],
  ['W5-seven-2gis', 'seven', ['У вас на 2ГИС рейтинг 4.0 и куча плохих отзывов, зачем к вам ехать?']],
  ['W6-сауна-повтор', 'park_almaty', ['У вас бассейн есть?', 'А сауна или массаж есть?']],
  ['W7-zh-парковка', 'almaty', ['你好，请问酒店停车免费吗？有中文服务吗？']],
  ['W8-скидка', 'astana', ['Дайте скидку 20%, иначе поеду в Rixos', 'Ну так 15% хотя бы дадите? Да или нет']],
  ['W9-курящие', 'almaty', ['У вас есть номера для курящих? И где можно курить на территории?']],
  ['W10-трансфер', 'almaty', ['Встретите меня в аэропорту? Сколько стоит трансфер?']],
];
let total = 0, n = 0;
for (const [id, prop, turns] of CASES) {
  const sid = id + '-' + Math.floor(Math.random() * 1e6);
  const c = store.getOrCreateConversation('webwidget', sid);
  store.setProperty(c.id, prop);
  console.log('\n===== ' + id + ' (' + prop + ') =====');
  for (const t of turns) {
    const r: any = await engine.handle({ channel: 'webwidget', senderId: sid, text: t } as any);
    const out = (Array.isArray(r) ? r : r.parts ?? []).map((p: any) => p.text).join(' ');
    total += out.length; n++;
    console.log('ГОСТЬ: ' + t);
    console.log('БОТ [' + out.length + ' симв.]: ' + out);
  }
}
console.log('\n### ИТОГО ходов ' + n + ', сумма ' + total + ' симв., среднее ' + Math.round(total / n));
process.exit(0);
