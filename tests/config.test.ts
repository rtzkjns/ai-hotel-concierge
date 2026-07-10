import { describe, it, expect } from 'vitest';
import { buildConfig, enabledChannels } from '../src/config';

describe('buildConfig', () => {
  it('is constructible with only ANTHROPIC_API_KEY set', () => {
    const cfg = buildConfig({ ANTHROPIC_API_KEY: 'x' });
    expect(cfg.anthropicApiKey).toBe('x');
    expect(cfg.anthropicModel).toBe('claude-sonnet-5');
    expect(cfg.dbPath).toBe('./kazzhol.db');
    expect(cfg.telegram.botToken).toBeUndefined();
    expect(cfg.whatsapp.phoneNumberIds).toEqual({});
    expect(cfg.exely.authUrl).toBe('https://connect.hopenapi.com/auth/token');
    expect(cfg.exely.baseUrl).toBe('https://connect.hopenapi.com');
    expect(cfg.exely.bookingEnabled).toBe(false);
    expect(cfg.server.port).toBe(3000);
    expect(cfg.console.adminLogin).toBe('admin');
  });

  it('throws when ANTHROPIC_API_KEY is missing', () => {
    expect(() => buildConfig({})).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('builds whatsapp phoneNumberIds from per-property env vars', () => {
    const cfg = buildConfig({
      ANTHROPIC_API_KEY: 'x',
      WHATSAPP_PHONE_ID_ALMATY: '101',
      WHATSAPP_PHONE_ID_PARK_ALMATY: '103',
    });
    expect(cfg.whatsapp.phoneNumberIds).toEqual({ almaty: '101', park_almaty: '103' });
  });

  it('parses EXELY_BOOKING_ENABLED === "true"', () => {
    expect(
      buildConfig({ ANTHROPIC_API_KEY: 'x', EXELY_BOOKING_ENABLED: 'true' }).exely.bookingEnabled,
    ).toBe(true);
    expect(
      buildConfig({ ANTHROPIC_API_KEY: 'x', EXELY_BOOKING_ENABLED: 'yes' }).exely.bookingEnabled,
    ).toBe(false);
  });

  it('reads server port and public base url', () => {
    const cfg = buildConfig({
      ANTHROPIC_API_KEY: 'x',
      PORT: '8080',
      PUBLIC_BASE_URL: 'https://bot.example.com',
    });
    expect(cfg.server.port).toBe(8080);
    expect(cfg.server.publicBaseUrl).toBe('https://bot.example.com');
  });
});

describe('enabledChannels', () => {
  it('always enables the web widget, nothing else without credentials', () => {
    const cfg = buildConfig({ ANTHROPIC_API_KEY: 'x' });
    expect(enabledChannels(cfg)).toEqual(['webwidget']);
  });

  it('enables telegram when a bot token is set', () => {
    const cfg = buildConfig({ ANTHROPIC_API_KEY: 'x', TELEGRAM_BOT_TOKEN: 't' });
    expect(enabledChannels(cfg)).toContain('telegram');
  });

  it('enables whatsapp only with access token, verify token, and a phone id', () => {
    const partial = buildConfig({
      ANTHROPIC_API_KEY: 'x',
      WHATSAPP_ACCESS_TOKEN: 'a',
      WHATSAPP_VERIFY_TOKEN: 'v',
    });
    expect(enabledChannels(partial)).not.toContain('whatsapp');
    const full = buildConfig({
      ANTHROPIC_API_KEY: 'x',
      WHATSAPP_ACCESS_TOKEN: 'a',
      WHATSAPP_VERIFY_TOKEN: 'v',
      WHATSAPP_PHONE_ID_ALMATY: '101',
    });
    expect(enabledChannels(full)).toContain('whatsapp');
  });

  it('enables instagram with access token and ig id', () => {
    const cfg = buildConfig({
      ANTHROPIC_API_KEY: 'x',
      INSTAGRAM_ACCESS_TOKEN: 'a',
      INSTAGRAM_IG_ID: 'ig1',
    });
    expect(enabledChannels(cfg)).toEqual(['webwidget', 'instagram']);
  });
});
