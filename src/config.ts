import 'dotenv/config';
import type { Channel } from './types';

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

  return {
    anthropicApiKey: required('ANTHROPIC_API_KEY'),
    anthropicModel: env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
    dbPath: env.DB_PATH ?? './kazzhol.db',
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN,
      staffGroupChatId: env.STAFF_GROUP_CHAT_ID,
    },
    whatsapp: {
      accessToken: env.WHATSAPP_ACCESS_TOKEN,
      verifyToken: env.WHATSAPP_VERIFY_TOKEN,
      appSecret: env.WHATSAPP_APP_SECRET,
      phoneNumberIds,
    },
    instagram: {
      accessToken: env.INSTAGRAM_ACCESS_TOKEN,
      igId: env.INSTAGRAM_IG_ID,
    },
    exely: {
      clientId: env.EXELY_CLIENT_ID,
      clientSecret: env.EXELY_CLIENT_SECRET,
      authUrl: env.EXELY_AUTH_URL ?? 'https://connect.hopenapi.com/auth/token',
      baseUrl: env.EXELY_BASE_URL ?? 'https://connect.hopenapi.com',
      bookingEnabled: env.EXELY_BOOKING_ENABLED === 'true',
    },
    openaiApiKey: env.OPENAI_API_KEY,
    amoAccessToken: env.AMO_ACCESS_TOKEN,
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
  if (cfg.instagram.accessToken && cfg.instagram.igId) channels.push('instagram');
  return channels;
}
