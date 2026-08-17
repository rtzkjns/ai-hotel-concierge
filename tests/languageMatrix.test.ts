import { describe, expect, it } from 'vitest';
import { detectLanguage } from '../src/core/language';
import type { Language } from '../src/types';

/**
 * Языковая матрица по 4 договорным языкам. Собрана из 47 РЕАЛЬНЫХ ошибок, найденных
 * адверсариальными агентами 2026-08-14 (КАПС, односложные ответы, частицы ма/ба, пиньинь,
 * иероглиф внутри английской фразы, транслит, ссылки) плюс регрессы прошлых правок.
 * null = сигнала нет, движок сохраняет язык диалога.
 */
type L = Language | null;
const CASES: Array<[string, L, L]> = [
 ['БОС БӨЛМЕ БАР МА?',null,'kk'],['БОС ОРЫН БАР МА?',null,'kk'],['ЖАКСЫ, РАХМЕТ',null,'kk'],['РАХМЕТ САГАН',null,'kk'],
 ['Рахмет','kk','kk'],['Рахмет',null,'kk'],['Жарайды','kk','kk'],['Болады','kk','kk'],['Керек','kk','kk'],['Бар ма','kk','kk'],['Канша','kk','kk'],['Ия, керек','kk','kk'],
 ['Бар ма?',null,'kk'],['Сендерде бос орын бар ма?',null,'kk'],['Бос орын бар ма?',null,'kk'],['Wifi бар ма?',null,'kk'],
 ['Салеметсиз бе',null,'kk'],['Салеметсизбе',null,'kk'],['Ассалаумағалейкум',null,'kk'],
 ['Бронь жасайын деп едім',null,'kk'],['Ааа, тусиндим, рахмет',null,'kk'],
 ['Ni hao, you fangjian ma?',null,'zh'],['xiexie',null,'zh'],['ni hao',null,'zh'],['duoshao qian yi wan?',null,'zh'],['Wo xiang wen yixia, you meiyou kong fangjian?',null,'zh'],
 ['Hello, my name is 张伟, I have a booking for tonight','en','en'],['Do you accept 支付宝 (Alipay)?','en','en'],['Please book 2 rooms, 谢谢','en','en'],
 ['Zdravstvuyte, nujen nomer na dvoih na 20 avgusta',null,'ru'],
 ['https://www.booking.com/hotel/kz/kazzhol-astana.ru.html','ru',null],
 ['Thanks!','zh','zh'],['Breakfast?','zh','zh'],
 // регрессы, которые НЕ должны сломаться
 ['На имя Қапсих Ғалымгерей','ru','ru'],['Меня зовут Әсел Жұмабаева',null,'ru'],['Еду в Ақтау, нужен номер',null,'ru'],
 ['Здравствуйте, есть номера на завтра?',null,'ru'],['ЕСТЬ СВОБОДНЫЕ НОМЕРА?',null,'ru'],
 ['Сәлеметсіз бе! Бөлме бар ма?',null,'kk'],['Қанша тұрады екі адамға?',null,'kk'],
 ['Hello, do you have rooms tomorrow?',null,'en'],['How much is a deluxe room?',null,'en'],
 ['你好，有房间吗？',null,'zh'],['请问双人间多少钱？',null,'zh'],
 ['Ivan Petrov, +77015556677','ru','ru'],['ok','ru',null],['👍','ru',null],
];

describe('матрица языков (ru/kk/en/zh) — 47 боевых кейсов', () => {
  for (const [text, prev, want] of CASES) {
    it(`${JSON.stringify(text).slice(0, 60)} (prev=${prev}) → ${want}`, () => {
      expect(detectLanguage(text, prev)).toBe(want);
    });
  }
});
