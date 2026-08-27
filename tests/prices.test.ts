import { describe, it, expect } from 'vitest';
import { guardInventedPrices } from '../src/style/prices';

const KB = [
  'Завтрак «шведский стол» включён в стоимость.',
  'Обед 11 500 ₸, ужин 11 500 ₸.',
  'Абонемент в фитнес-центр 25000 тенге в месяц.',
  'Регулярного трансфера из аэропорта нет — данных о цене нет.',
].join('\n');

describe('заслон от выдуманных цен', () => {
  it('убирает сумму, которой нет в знаниях', () => {
    // Ровно этот случай и произошёл с живым гостем: «трансфер из аэропорта 14 000 ₸».
    // Числа нет нигде, а в знаниях прямо написано, что трансфера нет.
    const r = guardInventedPrices('Трансфер из аэропорта стоит 14 000 ₸.', KB, false);
    expect(r.invented).toContain('14000');
    expect(r.reply).not.toContain('14 000');
  });

  it('оставляет сумму, которая в знаниях есть', () => {
    const r = guardInventedPrices('Обед стоит 11 500 ₸.', KB, false);
    expect(r.reply).toBe('Обед стоит 11 500 ₸.');
    expect(r.invented).toHaveLength(0);
  });

  it('НЕ трогает живые цены из системы отеля', () => {
    // Иначе сломается главное: показ цен и оформление брони.
    const text = 'Standard Double 55 250 ₸, Business Lux 85 500 ₸ за ночь.';
    expect(guardInventedPrices(text, KB, true).reply).toBe(text);
  });

  it('вырезает только предложение с выдумкой, остальное сохраняет', () => {
    const r = guardInventedPrices('Трансфер 14 000 ₸. Завтрак включён в стоимость.', KB, false);
    expect(r.reply).toBe('Завтрак включён в стоимость.');
  });

  it('не оставляет гостя совсем без ответа', () => {
    // Пустой ответ — это то же молчание, из-за которого была жалоба.
    const r = guardInventedPrices('Это будет стоить 14 000 ₸.', KB, false);
    expect(r.reply.trim()).not.toBe('');
    expect(r.reply).toContain('уточню'.charAt(0).toUpperCase() + 'точню');
  });

  it('не трогает текст без сумм', () => {
    const text = 'Заезд с 15:00, выезд до 12:00.';
    expect(guardInventedPrices(text, KB, false).reply).toBe(text);
  });

  it('одинаково понимает «55 250» и «55250»', () => {
    const r = guardInventedPrices('Абонемент 25 000 тенге.', KB, false);
    expect(r.invented).toHaveLength(0);
  });
});

// Заслон снимает не факт вызова инструмента, а полученные ЖИВЫЕ цены. Для отеля без
// кабинета Exely check_availability вызывается и отвечает «цен нет» — раньше этого
// хватало, чтобы разоружить защиту, и выдуманная сумма шла гостю насквозь.
describe('заслон не снимается без живых цен', () => {
  it('режет сумму, когда живых цен не было', () => {
    const r = guardInventedPrices('Стандартный номер стоит 25 000 ₸ за ночь.', 'Завтрак 5000 ₸.', false);
    expect(r.invented).toContain('25000');
    expect(r.reply).not.toContain('25 000');
  });

  it('пропускает сумму, когда живые цены пришли', () => {
    const r = guardInventedPrices('Стандартный номер — 25 000 ₸ за ночь.', 'Завтрак 5000 ₸.', true);
    expect(r.invented).toEqual([]);
    expect(r.reply).toContain('25 000');
  });

  it('не трогает суммы, которые есть в знаниях отеля', () => {
    const r = guardInventedPrices('Завтрак стоит 5000 ₸.', 'Завтрак 5000 ₸ с человека.', false);
    expect(r.invented).toEqual([]);
  });
});
