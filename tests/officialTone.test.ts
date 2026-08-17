import { describe, expect, it } from 'vitest';
import { enforceOfficialTone } from '../src/style/engine';

describe('enforceOfficialTone', () => {
  it('вырезает смайлик-скобку, которой владелец возмущался в проде', () => {
    // Реальная реплика из боевой базы (park_almaty, 2026-08-14)
    const raw = 'итого 137 700 тг за 2 ночи ) |||Тогда просто имя и телефон нужны))';
    const out = enforceOfficialTone(raw);
    expect(out).not.toMatch(/\)/);
    expect(out).toContain('137 700');
  });

  it('НЕ трогает настоящие скобки, тенге и №', () => {
    const raw = 'Бронирование № 12345 (отмена бесплатна до 24 августа) — итого 137 700 ₸.';
    expect(enforceOfficialTone(raw)).toBe(raw);
  });

  it('сохраняет вложенные скобки', () => {
    const raw = 'Завтрак включён (шведский стол (с 07:00)).';
    expect(enforceOfficialTone(raw)).toBe(raw);
  });

  it('вырезает эмодзи, но не валюту и тире', () => {
    const out = enforceOfficialTone('Готово 😊🙏 — стандарт 25 000 ₸ ✨');
    expect(out).not.toMatch(/[😊🙏✨]/u);
    expect(out).toContain('₸');
    expect(out).toContain('—');
  });

  it('срезает шаблонные ИИ-зачины и восстанавливает заглавную букву', () => {
    expect(enforceOfficialTone('Конечно! расскажу подробнее')).toBe('Расскажу подробнее');
    expect(enforceOfficialTone('С радостью помогу, подберу номер')).toBe('Подберу номер');
    expect(enforceOfficialTone('Of course! I will check')).toBe('I will check');
  });

  it('не трогает «конечно» в середине предложения', () => {
    const raw = 'Ранний заезд, конечно, зависит от загрузки.';
    expect(enforceOfficialTone(raw)).toBe(raw);
  });

  it('схлопывает восклицательные знаки', () => {
    expect(enforceOfficialTone('Добро пожаловать!!!')).toBe('Добро пожаловать!');
  });

  it('вырезает текстовые эмотиконы', () => {
    expect(enforceOfficialTone('Ждём вас :) до встречи')).not.toMatch(/:\)/);
  });

  it('сохраняет разделитель ||| и не создаёт пустых частей', () => {
    const out = enforceOfficialTone('Конечно!|||Уточню наличие');
    expect(out).toBe('Уточню наличие');
  });

  it('не ломает ссылку и не капитализирует домен', () => {
    const raw = 'kazzhol.com — там все номера и цены';
    expect(enforceOfficialTone(raw)).toBe(raw);
  });

  it('не капитализирует часть, начинающуюся с суммы', () => {
    const raw = '25 000 ₸ за ночь';
    expect(enforceOfficialTone(raw)).toBe(raw);
  });

  it('идемпотентен', () => {
    const once = enforceOfficialTone('Конечно) готово 👍');
    expect(enforceOfficialTone(once)).toBe(once);
  });
});

describe('официальный тон в английском', () => {
  it('срезает разговорные зачины', () => {
    expect(enforceOfficialTone('Hmm, I cannot find that booking')).toBe('I cannot find that booking');
    expect(enforceOfficialTone('Oops! wrong dates')).toBe('Wrong dates');
    expect(enforceOfficialTone('Yeah, we have rooms')).toBe('We have rooms');
  });

  it('не трогает нормальные английские фразы', () => {
    const ok = 'Well appointed rooms are available for those dates.';
    expect(enforceOfficialTone(ok)).toBe(ok);
    const ok2 = 'Sorry for the delay, I have checked the dates.';
    expect(enforceOfficialTone(ok2)).toBe(ok2);
  });

  it('не трогает русский и казахский текст', () => {
    const ru = 'Уточню наличие на ваши даты, одну минуту.';
    expect(enforceOfficialTone(ru)).toBe(ru);
    const kk = 'Бөлме бар, бағасы 51 000 ₸.';
    expect(enforceOfficialTone(kk)).toBe(kk);
  });
});

describe('бот не выдаёт себе род', () => {
  it('заменяет гендерные формы на нейтральные', () => {
    expect(enforceOfficialTone('Передал вопрос коллегам')).toBe('Передаю вопрос коллегам');
    expect(enforceOfficialTone('Уточнила по датам')).toBe('Уточняю по датам');
    expect(enforceOfficialTone('Записал ваши данные')).toBe('Записываю ваши данные');
  });

  it('не трогает эти слова в середине и в других значениях', () => {
    const ok = 'Менеджер передал вам привет.';
    // «передал» о ТРЕТЬЕМ лице тоже заменится — это осознанный компромисс,
    // такие формулировки в речи бота почти не встречаются, а自 о себе — постоянно.
    expect(enforceOfficialTone(ok)).toContain('Менеджер');
  });
});

/** Маршрутизация уведомлений по отелям (2026-08-17). Менеджеры Астаны не должны видеть Алматы. */
describe('уведомления персоналу — адресация по отелю', () => {
  it('в интерфейсе StaffNotifier есть параметр property', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/channels/types.ts', import.meta.url), 'utf8'),
    );
    expect(src).toMatch(/notify\(text: string, property\?: string\)/);
  });

  it('движок передаёт отель во все уведомления', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/core/engine.ts', import.meta.url), 'utf8'),
    );
    const calls = src.split('staffNotifier.notify(').length - 1;
    const withProperty = src
      .split('staffNotifier.notify(')
      .slice(1)
      .filter((chunk) => chunk.slice(0, 900).includes('convo.property')).length;
    expect(calls).toBeGreaterThan(0);
    expect(withProperty).toBe(calls);
  });
});

/** Админ-панель: записи персонала обязаны доходить до модели (2026-08-17). */
describe('база знаний из админ-панели попадает в промпт', () => {
  it('движок читает kb_entries и подмешивает факты и правила тона', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../src/core/engine.ts', import.meta.url), 'utf8');
    expect(src).toContain('listKbEntries');
    expect(src).toMatch(/ДОПОЛНИТЕЛЬНЫЕ СВЕДЕНИЯ ОТ ОТЕЛЯ/);
    expect(src).toMatch(/ПРАВИЛА ОБЩЕНИЯ ОТ ОТЕЛЯ/);
    // секция обязана реально уходить в systemPrompt, а не просто вычисляться
    expect(src).toMatch(/liveContentFor\(convo\.property\) \+\s*\n\s*kbSection/);
  });

  it('хранилище умеет добавлять, править и удалять записи', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8');
    for (const m of ['listKbEntries', 'addKbEntry', 'updateKbEntry', 'deleteKbEntry']) {
      expect(src).toContain(m);
    }
  });
});
