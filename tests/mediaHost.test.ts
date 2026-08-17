import { describe, expect, it } from 'vitest';
import { isAllowedMediaHost } from '../src/channels/whatsapp';

/**
 * Регресс аудита 2026-08-14: медиа (голосовые) качались только с доменов Meta, поэтому на
 * провайдере 360dialog каждое голосовое молча не читалось.
 */
describe('isAllowedMediaHost', () => {
  it('на d360 разрешает домены 360dialog', () => {
    expect(isAllowedMediaHost('https://waba-v2.360dialog.io/media/abc', true)).toBe(true);
    expect(isAllowedMediaHost('https://cdn.360dialog.com/x', true)).toBe(true);
  });

  it('на Meta-пути домены 360dialog НЕ разрешены', () => {
    expect(isAllowedMediaHost('https://waba-v2.360dialog.io/media/abc', false)).toBe(false);
  });

  it('домены Meta разрешены на обоих путях', () => {
    expect(isAllowedMediaHost('https://lookaside.fbcdn.net/x', false)).toBe(true);
    expect(isAllowedMediaHost('https://lookaside.fbcdn.net/x', true)).toBe(true);
  });

  it('чужой домен и http отвергаются — токен туда не уедет', () => {
    expect(isAllowedMediaHost('https://evil.com/x', true)).toBe(false);
    expect(isAllowedMediaHost('http://waba-v2.360dialog.io/x', true)).toBe(false);
    expect(isAllowedMediaHost('https://360dialog.io.evil.com/x', true)).toBe(false);
    expect(isAllowedMediaHost('не-url', true)).toBe(false);
  });
});
