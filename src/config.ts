import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
  anthropicApiKey: required('ANTHROPIC_API_KEY'),
  staffGroupChatId: required('STAFF_GROUP_CHAT_ID'),
  anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
  dbPath: process.env.DB_PATH ?? './kazzhol.db',
};
