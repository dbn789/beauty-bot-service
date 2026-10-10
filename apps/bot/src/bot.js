// Создание телеграм-бота (ТЗ 7.3). Каркас Э0: старт/справка/политика.
// Сцены диалога (согласие → фото → выбор → результат) — этап Э1.
const { Telegraf, Markup } = require('telegraf');
const texts = require('./helpers/texts');

const createBot = ({ token, logger }) => {
  const bot = new Telegraf(token);

  bot.catch((error) => {
    logger.error({ err: error && error.message }, 'telegraf handler error');
  });

  bot.start(async (ctx) => {
    await ctx.reply(texts.welcome, Markup.removeKeyboard());
  });

  bot.help(async (ctx) => ctx.reply(texts.help));

  bot.command('privacy', async (ctx) => ctx.reply(texts.privacy));

  bot.command('cancel', async (ctx) => ctx.reply(texts.cancelled));

  bot.command('delete_my_data', async (ctx) => ctx.reply(texts.dataDeleted));

  return bot;
};

module.exports = {
  createBot,
};
