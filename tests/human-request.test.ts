/**
 * Task 2: the manager-request detector must catch EVERY explicit "switch me to a human" so a
 * heads-up reaches the manager — but must NOT fire on booking phrases like "на 2 человека".
 */
import { describe, it, expect } from 'vitest';
import { HUMAN_REQUEST_RE } from '../src/core/engine';

const match = (s: string) => HUMAN_REQUEST_RE.test(s);

describe('HUMAN_REQUEST_RE — explicit manager/human requests', () => {
  it('matches clear requests (ru/kk/en)', () => {
    for (const s of [
      'дайте менеджера пожалуйста',
      'соедините с оператором',
      'переключите на живого человека',
      'хочу поговорить с человеком',
      'можно менеджера позовите',
      'give me a manager',
      'I want to talk to a human',
      'connect me to a real person',
      'speak to an agent please',
    ]) {
      expect(match(s), s).toBe(true);
    }
  });

  it('does NOT fire on booking / guest-count phrases (no false alarms)', () => {
    for (const s of [
      'на 2 человека номер',
      'сколько человек можно заселить',
      'нас будет 4 человека',
      'a room for 2 people',
      'какие цены на завтра',
      'менеджер по продажам приходил вчера', // mentions менеджер but not a request
      'нужна бронь на 10 сотрудников', // corporate booking — сотрудник is not a "human" role
      'можно оставить вещи на ресепшене?', // reception luggage — not a manager request
    ]) {
      expect(match(s), s).toBe(false);
    }
  });
});
