import { createBot } from './telegram/bot';

const bot = createBot();

bot.launch().then(() => console.log('Kazzhol Astana concierge bot is running.'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
