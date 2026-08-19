import 'dotenv/config';
import type { Channel } from './types';

export interface ExelyCabinet {
  clientId: string;
  clientSecret: string;
  propertyId: string;
  authUrl: string;
  baseUrl: string;
  bookingEnabled: boolean;
  /**
   * Book through Exely's own booking engine instead of the documented Reservation API.
   * The API answers 403 on every Kazzhol cabinet, so this is what actually creates
   * bookings today; flip it off the moment the write scope is opened.
   */
  bookingEngine: boolean;
}

/**
 * Reads per-hotel Exely cabinets from env: EXELY_<HOTEL>_CLIENT_ID /
 * _CLIENT_SECRET / _PROPERTY_ID (+ optional _BOOKING_ENABLED). HOTEL ∈
 * {ALMATY, ASTANA, PARK_ALMATY} → property keys almaty | astana | park_almaty.
 * Only fully-specified cabinets (all three core vars) are included.
 */
export function buildExelyCabinets(env: NodeJS.ProcessEnv): Record<string, ExelyCabinet> {
  const map: Array<[string, string]> = [
    ['ALMATY', 'almaty'],
    ['ASTANA', 'astana'],
    ['PARK_ALMATY', 'park_almaty'],
  ];
  const authUrl = env.EXELY_AUTH_URL ?? 'https://connect.hopenapi.com/auth/token';
  const baseUrl = env.EXELY_BASE_URL ?? 'https://connect.hopenapi.com';
  const out: Record<string, ExelyCabinet> = {};

  // Back-compat: the original single cabinet (EXELY_CLIENT_ID/SECRET) is Almaty,
  // property 801. Registered first so an explicit EXELY_ALMATY_* pair can override it.
  if (env.EXELY_CLIENT_ID && env.EXELY_CLIENT_SECRET) {
    out.almaty = {
      clientId: env.EXELY_CLIENT_ID,
      clientSecret: env.EXELY_CLIENT_SECRET,
      propertyId: env.EXELY_PROPERTY_ID ?? '801',
      authUrl,
      baseUrl,
      bookingEnabled: env.EXELY_BOOKING_ENABLED === 'true',
      bookingEngine: env.EXELY_BOOKING_ENGINE === 'true',
    };
  }

  for (const [envKey, propKey] of map) {
    const clientId = env[`EXELY_${envKey}_CLIENT_ID`];
    const clientSecret = env[`EXELY_${envKey}_CLIENT_SECRET`];
    const propertyId = env[`EXELY_${envKey}_PROPERTY_ID`];
    if (clientId && clientSecret && propertyId) {
      out[propKey] = {
        clientId,
        clientSecret,
        propertyId,
        authUrl,
        baseUrl,
        bookingEnabled: env[`EXELY_${envKey}_BOOKING_ENABLED`] === 'true',
        // Per-hotel override, else the chain-wide switch.
        bookingEngine:
          (env[`EXELY_${envKey}_BOOKING_ENGINE`] ?? env.EXELY_BOOKING_ENGINE) === 'true',
      };
    }
  }
  return out;
}

/** Pure config builder — testable without touching process.env. */
export function buildConfig(env: NodeJS.ProcessEnv) {
  const required = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
  };

  const phoneNumberIds: Record<string, string> = {};
  if (env.WHATSAPP_PHONE_ID_ALMATY) phoneNumberIds.almaty = env.WHATSAPP_PHONE_ID_ALMATY;
  if (env.WHATSAPP_PHONE_ID_ASTANA) phoneNumberIds.astana = env.WHATSAPP_PHONE_ID_ASTANA;
  if (env.WHATSAPP_PHONE_ID_PARK_ALMATY) {
    phoneNumberIds.park_almaty = env.WHATSAPP_PHONE_ID_PARK_ALMATY;
  }

  const instagramIgIds: Record<string, string> = {};
  if (env.INSTAGRAM_IG_ID_ALMATY) instagramIgIds.almaty = env.INSTAGRAM_IG_ID_ALMATY;
  if (env.INSTAGRAM_IG_ID_ASTANA) instagramIgIds.astana = env.INSTAGRAM_IG_ID_ASTANA;
  if (env.INSTAGRAM_IG_ID_PARK_ALMATY) instagramIgIds.park_almaty = env.INSTAGRAM_IG_ID_PARK_ALMATY;
  if (env.INSTAGRAM_IG_ID_SEVEN) instagramIgIds.seven = env.INSTAGRAM_IG_ID_SEVEN;
  // Back-compat: a lone INSTAGRAM_IG_ID maps to Almaty when no per-hotel ids are set.
  if (Object.keys(instagramIgIds).length === 0 && env.INSTAGRAM_IG_ID) {
    instagramIgIds.almaty = env.INSTAGRAM_IG_ID;
  }

  // Per-account access tokens — "Instagram API with Instagram Login" issues one token per account.
  const instagramTokens: Record<string, string> = {};
  if (env.INSTAGRAM_TOKEN_ALMATY) instagramTokens.almaty = env.INSTAGRAM_TOKEN_ALMATY;
  if (env.INSTAGRAM_TOKEN_ASTANA) instagramTokens.astana = env.INSTAGRAM_TOKEN_ASTANA;
  if (env.INSTAGRAM_TOKEN_PARK_ALMATY) instagramTokens.park_almaty = env.INSTAGRAM_TOKEN_PARK_ALMATY;
  if (env.INSTAGRAM_TOKEN_SEVEN) instagramTokens.seven = env.INSTAGRAM_TOKEN_SEVEN;

  // Chatfuel bridge (temporary IG tenant path while our own App Review is pending):
  // property key → that hotel's Chatfuel bot id + broadcasting token.
  const chatfuelBots: Record<string, { botId: string; token: string }> = {};
  for (const [h, key] of [
    ['ALMATY', 'almaty'],
    ['ASTANA', 'astana'],
    ['PARK_ALMATY', 'park_almaty'],
    ['SEVEN', 'seven'],
  ] as const) {
    const botId = env[`CHATFUEL_BOT_ID_${h}`];
    const token = env[`CHATFUEL_TOKEN_${h}`];
    if (botId && token) chatfuelBots[key] = { botId, token };
  }

  return {
    anthropicApiKey: required('ANTHROPIC_API_KEY'),
    anthropicModel: env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
    dbPath: env.DB_PATH ?? './kazzhol.db',
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN,
      // Нужно, чтобы панель собирала ссылки-приглашения для менеджеров.
      botUsername: env.TELEGRAM_BOT_USERNAME ?? 'kazzzholBot',
      staffGroupChatId: env.STAFF_GROUP_CHAT_ID,
      // Отдельный Telegram-чат на каждый отель: STAFF_CHAT_ID_ALMATY и т.д.
      // Если для отеля чат не задан — уведомление уходит в общий staffGroupChatId.
      staffChatByProperty: {
        almaty: env.STAFF_CHAT_ID_ALMATY,
        astana: env.STAFF_CHAT_ID_ASTANA,
        park_almaty: env.STAFF_CHAT_ID_PARK_ALMATY,
        seven: env.STAFF_CHAT_ID_SEVEN,
      } as Record<string, string | undefined>,
    },
    whatsapp: {
      // Meta: system-user/Bearer token. 360dialog: the D360-API-KEY (set WHATSAPP_PROVIDER=d360).
      accessToken: env.WHATSAPP_ACCESS_TOKEN,
      verifyToken: env.WHATSAPP_VERIFY_TOKEN,
      appSecret: env.WHATSAPP_APP_SECRET,
      // Shared secret for the d360 path, where Meta-style HMAC signatures do not exist.
      webhookSecret: env.WHATSAPP_WEBHOOK_SECRET,
      phoneNumberIds,
      // 'meta' (direct Cloud API) or 'd360' (360dialog, for zero-downtime Coexistence).
      provider: env.WHATSAPP_PROVIDER === 'd360' ? ('d360' as const) : ('meta' as const),
    },
    instagram: {
      accessToken: env.INSTAGRAM_ACCESS_TOKEN,
      // Single-account (legacy) id, kept for back-compat.
      igId: env.INSTAGRAM_IG_ID,
      // Multi-account: one Instagram account per hotel (recipient.id in the
      // webhook → property), mirroring the WhatsApp phone_number_ids design.
      igIds: instagramIgIds,
      // Per-account tokens (Instagram Login): property key → that account's own token.
      tokens: instagramTokens,
      // Override API host+version (default graph.instagram.com/v26.0, Instagram Login path).
      baseUrl: env.INSTAGRAM_API_BASE,
    },
    exely: {
      clientId: env.EXELY_CLIENT_ID,
      clientSecret: env.EXELY_CLIENT_SECRET,
      authUrl: env.EXELY_AUTH_URL ?? 'https://connect.hopenapi.com/auth/token',
      baseUrl: env.EXELY_BASE_URL ?? 'https://connect.hopenapi.com',
      bookingEnabled: env.EXELY_BOOKING_ENABLED === 'true',
    },
    // Per-hotel Exely cabinets. Astana & Park Almaty are SEPARATE Exely accounts
    // (the default cabinet above only exposes property 801 / Almaty — verified
    // 2026-07-17 via /api/content/v1/properties). Each hotel drops in with its own
    // client_id/secret/property_id and (optionally) its own booking flag; nothing
    // else changes. A hotel with no vars here falls back to stub availability.
    exelyByProperty: buildExelyCabinets(env),
    openaiApiKey: env.OPENAI_API_KEY,
    amoAccessToken: env.AMO_ACCESS_TOKEN,
    chatfuelBots,
    server: {
      port: Number(env.PORT ?? 3000),
      publicBaseUrl: env.PUBLIC_BASE_URL,
    },
    console: {
      adminLogin: env.CONSOLE_ADMIN_LOGIN ?? 'admin',
      adminPassword: env.CONSOLE_ADMIN_PASSWORD,
    },
  };
}

export type AppConfig = ReturnType<typeof buildConfig>;

export const config: AppConfig = buildConfig(process.env);

/** Channels this deployment can serve, based on which credentials are present. */
export function enabledChannels(cfg: AppConfig = config): Channel[] {
  const channels: Channel[] = ['webwidget'];
  if (cfg.telegram.botToken) channels.push('telegram');
  if (
    cfg.whatsapp.accessToken &&
    cfg.whatsapp.verifyToken &&
    Object.keys(cfg.whatsapp.phoneNumberIds).length > 0
  ) {
    channels.push('whatsapp');
  }
  if (
    Object.keys(cfg.instagram.igIds).length > 0 &&
    (cfg.instagram.accessToken || Object.keys(cfg.instagram.tokens).length > 0)
  ) {
    channels.push('instagram');
  }
  return channels;
}
