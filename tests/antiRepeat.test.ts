import { describe, it, expect } from 'vitest';
import { dropRepeatedSentences } from '../src/style/engine';
import { actionTrace, ACTION_TRACE_PREFIX, needsSubstance } from '../src/core/engine';

describe('dropRepeatedSentences', () => {
  it('removes the WhatsApp promise a real guest received three times', () => {
    // Дословно из прода: Анастасия, Kazzhol Almaty, 18.08. Три ответа подряд,
    // каждый снова обещал, что коллеги свяжутся в WhatsApp.
    const first = 'Заявку передаю коллегам, Анастасия. Они свяжутся с вами в WhatsApp по номеру +77756921010 и пришлют фото залов и прайс.';
    const second = 'Заявка на зал для 30 человек на 3 октября передана коллегам, они свяжутся с вами в WhatsApp. Вложение не могу открыть — опишите, пожалуйста, детали коротко.';
    const trimmed = dropRepeatedSentences(second, [first]);
    expect(trimmed).toContain('Вложение не могу открыть');

    // Третий ответ был целиком повтором — от него не должно остаться содержания.
    const third = 'Коллеги свяжутся с вами в WhatsApp с прайсом и фотографиями.';
    expect(dropRepeatedSentences(third, [first, second, third])).toBe('');
  });

  it('keeps a genuinely new answer that shares wording with an old one', () => {
    const before = 'Завтрак «шведский стол» в ресторане Salt с 07:00 до 10:00.';
    const now = 'Ужин в ресторане Salt подаётся с 18:00 до 23:00.';
    expect(dropRepeatedSentences(now, [before])).toBe(now);
  });

  it('ignores punctuation and case when comparing', () => {
    const before = 'Парковка бесплатная для гостей отеля';
    const now = 'Парковка — бесплатная для гостей отеля!';
    expect(dropRepeatedSentences(now, [before])).toBe('');
  });

  it('lets short courtesies repeat', () => {
    expect(dropRepeatedSentences('Пожалуйста.', ['Пожалуйста.'])).toBe('Пожалуйста.');
    expect(dropRepeatedSentences('Здравствуйте!', ['Здравствуйте!'])).toBe('Здравствуйте!');
  });

  it('does nothing when there is no history', () => {
    expect(dropRepeatedSentences('Любой ответ.', [])).toBe('Любой ответ.');
  });
});

describe('actionTrace', () => {
  it('records what was done so the next turn does not do it again', () => {
    const trace = actionTrace(['submit_mice_request']);
    expect(trace).toContain(ACTION_TRACE_PREFIX);
    expect(trace).toContain('заявка на мероприятие отправлена');
    expect(trace).toContain('не повторяй');
  });

  it('collapses the same tool called twice in one turn', () => {
    expect(actionTrace(['capture_lead', 'capture_lead'])).toBe(actionTrace(['capture_lead']));
  });

  it('stays silent when nothing was done', () => {
    expect(actionTrace([])).toBeNull();
    expect(actionTrace(['check_availability'])).toBeNull();
  });
});

describe('needsSubstance', () => {
  it('rewrites a reply that passed the guest on without telling them anything', () => {
    expect(needsSubstance('Передал вопрос коллегам.', ['capture_lead'])).toBe(true);
    expect(needsSubstance('', ['capture_lead'])).toBe(true);
  });

  it('leaves a limitation alone — it IS the answer', () => {
    // Переписав это, второй проход однажды предложил гостю выбрать даты в отеле,
    // который ещё не открылся.
    expect(
      needsSubstance('Отель пока не принимает бронирования, уточню дату открытия у коллег.', ['capture_lead']),
    ).toBe(false);
  });

  it('leaves a reply that already carries a number', () => {
    expect(needsSubstance('Разовое посещение 7 500 ₸, детский 4 500 ₸. Остальное уточню.', ['capture_lead'])).toBe(false);
  });

  it('never touches a turn that called no lead tool', () => {
    expect(needsSubstance('Уточню у коллег.', [])).toBe(false);
    expect(needsSubstance('Уточню у коллег.', ['check_availability'])).toBe(false);
  });
});
