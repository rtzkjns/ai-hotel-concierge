// Локальный предпросмотр консоли с реалистичными данными — только для скриншотов.
import { buildServer } from '/Users/abzalm/kazzhol-ai/src/server';
import { Store } from '/Users/abzalm/kazzhol-ai/src/store';
import { hashPassword } from '/Users/abzalm/kazzhol-ai/src/console/auth';
import { registerConsoleRoutes } from '/Users/abzalm/kazzhol-ai/src/console/routes';
import { extractText } from '/Users/abzalm/kazzhol-ai/src/knowledge/documents';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '/Users/abzalm/kazzhol-ai/src/config';
import { metricsSummary } from '/Users/abzalm/kazzhol-ai/src/core/events';

const store = new Store(':memory:');
store.createStaff('admin', hashPassword('p'), 'admin');
store.createStaff('astana-desk', hashPassword('p'), 'mice_manager', 'astana');

const mk = (ch: any, sid: string, prop: string, msgs: Array<[string, string]>, handed = false, taken?: string) => {
  const c = store.getOrCreateConversation(ch, sid);
  store.setProperty(c.id, prop);
  for (const [role, content] of msgs) store.appendMessage(c.id, { role: role as any, content });
  if (handed) { store.setStatus(c.id, 'handed_off'); if (taken) store.setTakenBy(c.id, taken); }
  return c;
};

const a = mk('whatsapp', '77015554466', 'astana', [
  ['user', 'Здравствуйте, можно поговорить с человеком? Мне нужен счёт на компанию за проживание'],
], true);
store.recordEvent('escalation', { conversationId: a.id, payload: { type: 'human_requested' } });
mk('instagram', '178414247099', 'almaty', [
  ['user', 'Добрый день! Хотим отметить юбилей на 40 человек, есть ли зал и кейтеринг?'],
], true);
mk('telegram', '551234789', 'park_almaty', [
  ['user', 'Мне не понравился номер, шумно всю ночь было'],
], true, 'admin');
mk('webwidget', '4821', 'almaty', [['user', 'во сколько завтрак?'], ['assistant', 'Завтрак «шведский стол» в ресторане Salt — с 07:00 до 10:00 в будние дни, в выходные до 11:00.']]);
mk('webwidget', '4822', 'astana', [['user', 'парковка платная?'], ['assistant', 'Парковка бесплатная для гостей отеля.']]);

store.addKbEntry({ property: '', kind: 'fact', title: 'Поздний выезд', body: 'До 16:00 — 50% стоимости суток. Позже — полная стоимость, по наличию свободных номеров.', url: null, active: true });
store.addKbEntry({ property: 'almaty', kind: 'fact', title: 'Фитнес AquaFit', body: 'Для гостей отеля вход в бассейн, сауну и тренажёрный зал включён в стоимость проживания. Для гостей с улицы разовое посещение — 7 500 ₸ взрослый, 4 500 ₸ детский.', url: null, active: true });
store.addKbEntry({ property: 'astana', kind: 'fact', title: 'Трансфер из аэропорта', body: 'Организуем по предварительной заявке, стоимость уточняется у отдела бронирования.', url: null, active: false });
store.addKbEntry({ property: 'almaty', kind: 'source', title: 'Акции Алматы', body: 'Со страницы https://kazzhol.com/ru/almaty/offers/ (прочитано ботом):\nПри бронировании от 3 ночей — бесплатный поздний выезд до 16:00.\nПрограмма постоянного гостя: накопительные скидки.', url: 'https://kazzhol.com/ru/almaty/offers/', active: true });
store.markKbFetched(3, new Date(Date.now()-40*60000).toISOString(), null);
store.addKbEntry({ property: 'astana', kind: 'source', title: 'Меню ресторана', body: 'Источник', url: 'https://kazzhol.com/ru/astana/restaurant/', active: true });
store.markKbFetched(4, null, 'Сайт не ответил за 12 секунд');
store.addKbEntry({ property: '', kind: 'tone', title: 'Про завтрак', body: 'Всегда называйте часы завтрака сразу, без предложения забронировать номер.', url: null, active: true });

store.recordEvent('reply_timing', { payload: { ms: 900 } });
store.recordEvent('dialog_started', {});

const app = await buildServer({
  engine: { handle: async () => null } as any,
  adapters: {},
  store,
  config: { whatsapp: { phoneNumberIds: {} } } as any,
  extraRoutes: [(x: any) => registerConsoleRoutes(x, { store, metricsSummary, sendToConversation: async () => ({ ok: true }), extractFile: (b: Buffer, f: string) => extractText(b, f, { client: new Anthropic({ apiKey: config.anthropicApiKey }), model: config.anthropicModel }) } as any)],
});
await app.listen({ port: 4571, host: '127.0.0.1' });
console.log('preview on 4571');
