import { describe, expect, it } from 'vitest';
import { detectLanguage } from '../src/core/language';

/**
 * Регрессы, найденные аудитом 2026-08-14 (ось «4 языка»).
 * По договору ru/kk/en/zh равнозначны, а детектор ошибался на самых частых реальных входах.
 */
describe('detectLanguage: контекст диалога', () => {
  it('латинское имя и телефон посреди русской брони НЕ переключают на английский', () => {
    expect(detectLanguage('Ivan Petrov, +77015556677', 'ru')).toBe('ru');
    expect(detectLanguage('Wang Li', 'zh')).toBe('zh');
    expect(detectLanguage('Almaty Towers', 'ru')).toBe('ru');
  });

  it('настоящее английское сообщение всё равно переключает', () => {
    expect(detectLanguage('Do you have a room for tomorrow?', 'ru')).toBe('en');
    expect(detectLanguage('hi, what is the price', 'ru')).toBe('en');
  });

  it('одна казахская буква в русском тексте (имя/топоним) не делает ответ казахским', () => {
    expect(detectLanguage('Забронируйте номер, меня зовут Әсел', 'ru')).toBe('ru');
    expect(detectLanguage('Еду в Ақтау на выходные, нужен номер', null)).toBe('ru');
  });

  it('настоящий казахский по-прежнему определяется', () => {
    expect(detectLanguage('Сәлеметсіз бе, бөлме бар ма?', null)).toBe('kk');
    expect(detectLanguage('Қанша тұрады екі адамға?', null)).toBe('kk');
  });

  it('казахский на РУССКОЙ раскладке (без ә/ө/қ) определяется как казахский', () => {
    // Реальный кейс: гость пишет по-казахски, но без казахских букв на клавиатуре.
    expect(detectLanguage('салем, болме бар ма?', null)).toBe('kk');
    expect(detectLanguage('рахмет, канша турады?', null)).toBe('kk');
  });

  it('обычный русский остаётся русским', () => {
    expect(detectLanguage('Здравствуйте, есть номера на завтра?', null)).toBe('ru');
    expect(detectLanguage('Спасибо, подтверждаю бронь', 'ru')).toBe('ru');
  });

  it('китайский определяется всегда', () => {
    expect(detectLanguage('你好，有房间吗？', 'ru')).toBe('zh');
  });

  it('латинизированный казахский по-прежнему ловится', () => {
    expect(detectLanguage('salem, bolme bar ma?', null)).toBe('kk');
  });

  it('слишком короткий текст не определяется (язык берётся из диалога выше)', () => {
    expect(detectLanguage('ok', 'ru')).toBeNull();
    expect(detectLanguage('👍', 'kk')).toBeNull();
  });
});

/** Реальные боевые случаи, найденные в проде 2026-08-14. */
describe('detectLanguage: имена собственные не меняют язык', () => {
  it('«На имя Қапсих Ғалымгерей» — русская фраза с казахским именем', () => {
    expect(detectLanguage('На имя Қапсих Ғалымгерей', 'ru')).toBe('ru');
    expect(detectLanguage('На имя Қапсих Ғалымгерей', null)).toBe('ru');
  });

  it('другие казахские имена в русском тексте', () => {
    expect(detectLanguage('Меня зовут Әсел Жұмабаева', null)).toBe('ru');
    expect(detectLanguage('Бронь на Нұрсұлтан Әбішұлы', null)).toBe('ru');
  });

  it('но настоящий казахский с заглавной первой буквы всё ещё казахский', () => {
    expect(detectLanguage('Қанша тұрады?', null)).toBe('kk');
    expect(detectLanguage('Сәлеметсіз бе', null)).toBe('kk');
    expect(detectLanguage('Бөлме бар ма?', null)).toBe('kk');
  });
});
