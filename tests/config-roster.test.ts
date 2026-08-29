/**
 * GOLDEN LOCK for the config credential loaders, ahead of making them roster-driven.
 *
 * buildExelyCabinets / buildConfig currently hardcode the Kazzhol hotel keys in ~5 places. We are
 * about to replace those hardcoded lists with a loop over the tenant's property roster (env prefix
 * = key.toUpperCase()). These tests pin the EXACT maps a full Kazzhol-shaped env produces, so the
 * refactor is provably byte-identical for Kazzhol while generalising to any tenant.
 */
import { describe, it, expect } from 'vitest';
import { buildConfig, buildExelyCabinets } from '../src/config';

// A synthetic env that exercises every per-hotel branch (all 4 hotels where they exist today).
function fullEnv(): NodeJS.ProcessEnv {
  return {
    ANTHROPIC_API_KEY: 'k',
    EXELY_ALMATY_CLIENT_ID: 'a-id',
    EXELY_ALMATY_CLIENT_SECRET: 'a-sec',
    EXELY_ALMATY_PROPERTY_ID: '801',
    EXELY_ASTANA_CLIENT_ID: 'as-id',
    EXELY_ASTANA_CLIENT_SECRET: 'as-sec',
    EXELY_ASTANA_PROPERTY_ID: '1105',
    EXELY_PARK_ALMATY_CLIENT_ID: 'p-id',
    EXELY_PARK_ALMATY_CLIENT_SECRET: 'p-sec',
    EXELY_PARK_ALMATY_PROPERTY_ID: '13617',
    WHATSAPP_PHONE_ID_ALMATY: 'wa-al',
    WHATSAPP_PHONE_ID_ASTANA: 'wa-as',
    WHATSAPP_PHONE_ID_PARK_ALMATY: 'wa-pa',
    INSTAGRAM_IG_ID_ALMATY: 'ig-al',
    INSTAGRAM_IG_ID_ASTANA: 'ig-as',
    INSTAGRAM_IG_ID_PARK_ALMATY: 'ig-pa',
    INSTAGRAM_IG_ID_SEVEN: 'ig-sv',
    INSTAGRAM_TOKEN_ALMATY: 'tok-al',
    INSTAGRAM_TOKEN_ASTANA: 'tok-as',
    INSTAGRAM_TOKEN_PARK_ALMATY: 'tok-pa',
    INSTAGRAM_TOKEN_SEVEN: 'tok-sv',
    CHATFUEL_BOT_ID_PARK_ALMATY: 'cf-bot',
    CHATFUEL_TOKEN_PARK_ALMATY: 'cf-tok',
    STAFF_CHAT_ID_ALMATY: 's-al',
    STAFF_CHAT_ID_ASTANA: 's-as',
    STAFF_CHAT_ID_PARK_ALMATY: 's-pa',
    STAFF_CHAT_ID_SEVEN: 's-sv',
  } as NodeJS.ProcessEnv;
}

describe('config roster golden — per-hotel maps built from a full Kazzhol env', () => {
  it('exelyByProperty: exactly the 3 wired cabinets with their property ids', () => {
    const cabs = buildExelyCabinets(fullEnv());
    expect(Object.keys(cabs).sort()).toEqual(['almaty', 'astana', 'park_almaty']);
    expect(cabs.almaty.propertyId).toBe('801');
    expect(cabs.astana.propertyId).toBe('1105');
    expect(cabs.park_almaty.propertyId).toBe('13617');
  });

  it('whatsapp.phoneNumberIds: 3 hotels (no seven)', () => {
    const c = buildConfig(fullEnv());
    expect(Object.keys(c.whatsapp.phoneNumberIds).sort()).toEqual(['almaty', 'astana', 'park_almaty']);
  });

  it('instagram igIds + tokens: 4 hotels including seven', () => {
    const c = buildConfig(fullEnv());
    expect(Object.keys(c.instagram.igIds).sort()).toEqual(['almaty', 'astana', 'park_almaty', 'seven']);
    expect(Object.keys(c.instagram.tokens).sort()).toEqual(['almaty', 'astana', 'park_almaty', 'seven']);
  });

  it('chatfuelBots: only the hotels with both bot id and token', () => {
    const c = buildConfig(fullEnv());
    expect(Object.keys(c.chatfuelBots)).toEqual(['park_almaty']);
    expect(c.chatfuelBots.park_almaty).toEqual({ botId: 'cf-bot', token: 'cf-tok' });
  });

  it('staffChatByProperty: all 4 keys present (undefined where unset)', () => {
    const c = buildConfig(fullEnv());
    expect(c.telegram.staffChatByProperty.almaty).toBe('s-al');
    expect(c.telegram.staffChatByProperty.seven).toBe('s-sv');
  });

  it('back-compat: bare EXELY_CLIENT_ID → almaty cabinet, property 801 default', () => {
    const cabs = buildExelyCabinets({
      EXELY_CLIENT_ID: 'legacy',
      EXELY_CLIENT_SECRET: 'legacy-sec',
    } as NodeJS.ProcessEnv);
    expect(cabs.almaty.clientId).toBe('legacy');
    expect(cabs.almaty.propertyId).toBe('801');
  });

  it('back-compat: explicit EXELY_ALMATY_* overrides the bare single cabinet', () => {
    const cabs = buildExelyCabinets({
      EXELY_CLIENT_ID: 'legacy',
      EXELY_CLIENT_SECRET: 'legacy-sec',
      EXELY_ALMATY_CLIENT_ID: 'explicit',
      EXELY_ALMATY_CLIENT_SECRET: 'explicit-sec',
      EXELY_ALMATY_PROPERTY_ID: '801',
    } as NodeJS.ProcessEnv);
    expect(cabs.almaty.clientId).toBe('explicit');
  });

  it('back-compat: lone INSTAGRAM_IG_ID → almaty when no per-hotel ids set', () => {
    const c = buildConfig({ ANTHROPIC_API_KEY: 'k', INSTAGRAM_IG_ID: 'solo' } as NodeJS.ProcessEnv);
    expect(c.instagram.igIds).toEqual({ almaty: 'solo' });
  });
});
