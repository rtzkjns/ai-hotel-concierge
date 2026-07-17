import { describe, it, expect } from 'vitest';
import { buildConfig, buildExelyCabinets, enabledChannels } from '../src/config';

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

describe('buildExelyCabinets', () => {
  it('maps the legacy single cabinet to almaty (property 801 default)', () => {
    const cabinets = buildExelyCabinets({ EXELY_CLIENT_ID: 'id', EXELY_CLIENT_SECRET: 'sec' });
    expect(cabinets.almaty).toMatchObject({ clientId: 'id', clientSecret: 'sec', propertyId: '801' });
    expect(cabinets.astana).toBeUndefined();
  });

  it('reads a separate Astana cabinet with its own property id', () => {
    const cabinets = buildExelyCabinets({
      EXELY_ASTANA_CLIENT_ID: 'aid',
      EXELY_ASTANA_CLIENT_SECRET: 'asec',
      EXELY_ASTANA_PROPERTY_ID: '900',
      EXELY_ASTANA_BOOKING_ENABLED: 'true',
    });
    expect(cabinets.astana).toMatchObject({ clientId: 'aid', propertyId: '900', bookingEnabled: true });
  });

  it('ignores a partially-specified cabinet (missing property id)', () => {
    const cabinets = buildExelyCabinets({
      EXELY_PARK_ALMATY_CLIENT_ID: 'pid',
      EXELY_PARK_ALMATY_CLIENT_SECRET: 'psec',
    });
    expect(cabinets.park_almaty).toBeUndefined();
  });

  it('lets an explicit EXELY_ALMATY_* cabinet override the legacy one', () => {
    const cabinets = buildExelyCabinets({
      EXELY_CLIENT_ID: 'old',
      EXELY_CLIENT_SECRET: 'oldsec',
      EXELY_ALMATY_CLIENT_ID: 'new',
      EXELY_ALMATY_CLIENT_SECRET: 'newsec',
      EXELY_ALMATY_PROPERTY_ID: '801',
    });
    expect(cabinets.almaty.clientId).toBe('new');
  });

  it('is exposed on the built config', () => {
    const cfg = buildConfig({ ANTHROPIC_API_KEY: 'x', EXELY_CLIENT_ID: 'id', EXELY_CLIENT_SECRET: 's' });
    expect(cfg.exelyByProperty.almaty.propertyId).toBe('801');
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
    // Legacy single id maps to Almaty.
    expect(cfg.instagram.igIds).toEqual({ almaty: 'ig1' });
  });

  it('builds per-hotel instagram ig ids and enables the channel', () => {
    const cfg = buildConfig({
      ANTHROPIC_API_KEY: 'x',
      INSTAGRAM_ACCESS_TOKEN: 'a',
      INSTAGRAM_IG_ID_ALMATY: 'igA',
      INSTAGRAM_IG_ID_ASTANA: 'igB',
    });
    expect(cfg.instagram.igIds).toEqual({ almaty: 'igA', astana: 'igB' });
    expect(enabledChannels(cfg)).toContain('instagram');
  });
});
