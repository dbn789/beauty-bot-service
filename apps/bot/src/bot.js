// Телеграм-слой (ТЗ 7.3): state-machine поверх users.dialogState в MongoDB.
// Состояние переживает рестарт контейнера (S7), сессий в памяти нет.
const { Telegraf, Input } = require('telegraf');
const { DIALOG_STEP, PRESETS_CATALOG } = require('@beauty/shared');
const texts = require('./helpers/texts');
const keyboards = require('./helpers/keyboards');
const { validatePhotoMessage, checkDownloadedPhoto, isPhotoPayload } = require('./helpers/validation');
const { nextResetTimeMoscow } = require('./helpers/day');

const EMPTY_PHOTO = {
  storagePath: null, tgFileId: null, mime: null, bytes: 0, width: null, height: null,
};

const createBot = ({ token, logger, config, models, storage, generation, retention }) => {
  const bot = new Telegraf(token);

  const getOrCreateUser = (ctx) =>
    models.User.findOneAndUpdate(
      { tgId: ctx.from.id },
      {
        $set: {
          username: ctx.from.username || null,
          firstName: ctx.from.first_name || null,
          lastName: ctx.from.last_name || null,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

  const setStep = (userId, step, extra = {}) =>
    models.User.findByIdAndUpdate(
      userId,
      { $set: { 'dialogState.step': step, ...extra } },
      { new: true }
    );

  const answerCb = (ctx, text) =>
    ctx.answerCbQuery(text).catch((error) => logger.warn({ err: error.message }, 'answerCbQuery failed'));

  const requirePrivacy = async (ctx, user) => {
    if (user.privacyAcceptedAt) return true;
    await ctx.reply(texts.privacy + '\n\n' + texts.privacyRequired, keyboards.buildPrivacyKeyboard());
    return false;
  };

  // Общий путь генерации: статус → результат/ошибка, тикер chat action (FR-B-050)
  const submitAndTrack = async (ctx, user, { source, preset = null, userText = null, photo = null, title = null }) => {
    const photoMeta = photo || user.dialogState.photo;
    if (!photoMeta || !photoMeta.storagePath) {
      await setStep(user._id, DIALOG_STEP.AWAIT_PHOTO, { 'dialogState.photo': EMPTY_PHOTO });
      await ctx.reply(texts.askPhoto);
      return;
    }

    await setStep(user._id, DIALOG_STEP.PROCESSING);
    const statusText = title
      ? texts.generatingFor.replace('{title}', title)
      : texts.generating.replace('{variants}', config.variants);
    const statusMessage = await ctx.reply(statusText);
    const ticker = setInterval(() => {
      ctx.telegram.sendChatAction(ctx.chat.id, 'upload_photo').catch(() => {});
    }, 5000);

    try {
      const result = await generation.submitRequest({
        user, photo: photoMeta, source, preset, userText,
      });

      if (result.limited) {
        await setStep(user._id, DIALOG_STEP.IDLE);
        await ctx.telegram.editMessageText(
          ctx.chat.id, statusMessage.message_id, undefined,
          texts.limitReached
            .replace('{limit}', config.dailyLimit)
            .replace('{resetAt}', nextResetTimeMoscow())
        );
        return;
      }

      if (result.budgetStopped) {
        await setStep(user._id, DIALOG_STEP.IDLE);
        await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, texts.budgetStopped);
        return;
      }

      const outcome = await result.promise;
      await setStep(user._id, DIALOG_STEP.IDLE);

      if (!outcome.ok) {
        await ctx.telegram.editMessageText(
          ctx.chat.id, statusMessage.message_id, undefined,
          texts.generationError, keyboards.buildRetryKeyboard()
        );
        return;
      }

      await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id).catch(() => {});
      const variants = outcome.request.variants;
      const media = [];
      for (let i = 0; i < variants.length; i += 1) {
        const buffer = await storage.read(variants[i].storagePath);
        media.push({
          type: 'photo',
          media: Input.fromBuffer(buffer, `variant-${i + 1}.png`),
        });
      }
      const total = variants.length;
      media[0].caption = preset
        ? texts.resultCaption.replace('{title}', `${preset.emoji} ${preset.titleRu}`).replace('{total}', total)
        : texts.resultCaptionFree.replace('{total}', total);
      await ctx.replyWithMediaGroup(media);
      await ctx.reply(texts.resultReady, keyboards.buildResultActionsKeyboard());
    } catch (error) {
      logger.error({ err: error.message }, 'submitAndTrack failed');
      await setStep(user._id, DIALOG_STEP.IDLE);
      await ctx.reply(texts.generationError, keyboards.buildRetryKeyboard()).catch(() => {});
    } finally {
      clearInterval(ticker);
    }
  };

  bot.catch((error) => {
    logger.error({ err: error && error.message }, 'telegraf handler error');
  });

  // ── команды ────────────────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    const user = await getOrCreateUser(ctx);
    await ctx.reply(texts.welcome);
    if (!user.privacyAcceptedAt) {
      await ctx.reply(texts.privacyRequired, keyboards.buildPrivacyKeyboard());
    } else {
      await ctx.reply(texts.hintIdle, keyboards.buildMainMenuKeyboard());
    }
  });

  bot.help(async (ctx) => ctx.reply(texts.help));
  bot.command('privacy', async (ctx) => ctx.reply(texts.privacy));

  bot.command('cancel', async (ctx) => {
    const user = await getOrCreateUser(ctx);
    await setStep(user._id, DIALOG_STEP.IDLE, { 'dialogState.photo': EMPTY_PHOTO });
    await ctx.reply(texts.cancelled);
  });

  bot.command('delete_my_data', async (ctx) => {
    const user = await getOrCreateUser(ctx);
    await retention.deleteUserData(user);
    await ctx.reply(texts.dataDeleted);
  });

  // ── callback-кнопки ────────────────────────────────────────────────────────
  bot.action('privacy:accept', async (ctx) => {
    const user = await getOrCreateUser(ctx);
    await models.User.updateOne(
      { _id: user._id, privacyAcceptedAt: null },
      { $set: { privacyAcceptedAt: new Date() } }
    );
    await answerCb(ctx, 'Принято!');
    await ctx.editMessageText(texts.privacyAccepted, keyboards.buildMainMenuKeyboard());
  });

  bot.action('menu:start', async (ctx) => {
    const user = await getOrCreateUser(ctx);
    if (!(await requirePrivacy(ctx, user))) return;
    await answerCb(ctx);
    await setStep(user._id, DIALOG_STEP.AWAIT_PHOTO, { 'dialogState.photo': EMPTY_PHOTO });
    await ctx.editMessageText(texts.askPhoto);
  });

  bot.action('menu:free_text', async (ctx) => {
    await answerCb(ctx);
    await setStep((await getOrCreateUser(ctx))._id, DIALOG_STEP.AWAIT_TEXT);
    await ctx.editMessageText(texts.askFreeText);
  });

  bot.action(/^cat:(.+)$/, async (ctx) => {
    await answerCb(ctx);
    const category = ctx.match[1];
    if (!keyboards.presetsByCategory(category).length) {
      await ctx.editMessageText(texts.askChoice, keyboards.buildCategoriesKeyboard());
      return;
    }
    await ctx.editMessageText(texts.choosePreset, keyboards.buildPresetsKeyboard(category));
  });

  bot.action('choice:back', async (ctx) => {
    await answerCb(ctx);
    await ctx.editMessageText(texts.askChoice, keyboards.buildCategoriesKeyboard());
  });

  bot.action(/^preset:(.+)$/, async (ctx) => {
    const user = await getOrCreateUser(ctx);
    const preset = PRESETS_CATALOG.find((p) => p.code === ctx.match[1]);
    if (!preset) {
      await answerCb(ctx, 'Стиль не найден');
      await ctx.editMessageText(texts.askChoice, keyboards.buildCategoriesKeyboard());
      return;
    }
    await answerCb(ctx, preset.titleRu);
    await submitAndTrack(ctx, user, { source: 'preset', preset, title: preset.titleRu });
  });

  bot.action('more:last', async (ctx) => {
    const user = await getOrCreateUser(ctx);
    const last = await generation.lastDoneRequest(user._id);
    if (!last) {
      await answerCb(ctx, 'Нет предыдущей генерации');
      await setStep(user._id, DIALOG_STEP.AWAIT_CHOICE);
      await ctx.editMessageText(texts.askChoice, keyboards.buildCategoriesKeyboard());
      return;
    }
    await answerCb(ctx);
    const preset = last.presetCode
      ? PRESETS_CATALOG.find((p) => p.code === last.presetCode) || null
      : null;
    await submitAndTrack(ctx, user, {
      source: last.source,
      preset,
      userText: last.userText,
      photo: last.sourcePhoto,
      title: preset ? preset.titleRu : null,
    });
  });

  bot.action('act:retry', async (ctx) => {
    const user = await getOrCreateUser(ctx);
    await answerCb(ctx);
    const last = await generation.lastDoneRequest(user._id);
    if (!last) {
      await setStep(user._id, DIALOG_STEP.AWAIT_CHOICE);
      await ctx.editMessageText(texts.askChoice, keyboards.buildCategoriesKeyboard());
      return;
    }
    const preset = last.presetCode ? PRESETS_CATALOG.find((p) => p.code === last.presetCode) || null : null;
    await submitAndTrack(ctx, user, {
      source: last.source,
      preset,
      userText: last.userText,
      photo: last.sourcePhoto,
      title: preset ? preset.titleRu : null,
    });
  });

  bot.action('style:again', async (ctx) => {
    const user = await getOrCreateUser(ctx);
    await answerCb(ctx);
    if (!user.dialogState.photo || !user.dialogState.photo.storagePath) {
      await setStep(user._id, DIALOG_STEP.AWAIT_PHOTO);
      await ctx.editMessageText(texts.askPhoto);
      return;
    }
    await setStep(user._id, DIALOG_STEP.AWAIT_CHOICE);
    await ctx.editMessageText(texts.askChoice, keyboards.buildCategoriesKeyboard());
  });

  bot.action('act:cancel', async (ctx) => {
    const user = await getOrCreateUser(ctx);
    await answerCb(ctx);
    await setStep(user._id, DIALOG_STEP.IDLE, { 'dialogState.photo': EMPTY_PHOTO });
    await ctx.editMessageText(texts.cancelled);
  });

  // ── сообщения ──────────────────────────────────────────────────────────────
  bot.on('message', async (ctx) => {
    const user = await getOrCreateUser(ctx);
    if (!user.privacyAcceptedAt) {
      await ctx.reply(texts.privacyRequired, keyboards.buildPrivacyKeyboard());
      return;
    }
    const step = user.dialogState.step;

    if (step === DIALOG_STEP.PROCESSING) {
      await ctx.reply(texts.processingBusy);
      return;
    }

    if (isPhotoPayload(ctx.message)) {
      if (step !== DIALOG_STEP.AWAIT_PHOTO) {
        await ctx.reply(texts.hintIdle, keyboards.buildMainMenuKeyboard());
        return;
      }
      const validation = validatePhotoMessage(ctx.message);
      if (!validation.ok) {
        await ctx.reply(texts.photoInvalid);
        return;
      }
      try {
        const meta = await downloadPhoto(ctx, validation.meta);
        const storagePath = await storage.saveSource({
          userId: user._id, ext: meta.ext, buffer: meta.buffer,
        });
        await models.User.updateOne(
          { _id: user._id },
          {
            $set: {
              'dialogState.step': DIALOG_STEP.AWAIT_CHOICE,
              'dialogState.photo': {
                storagePath,
                tgFileId: meta.tgFileId,
                mime: meta.mime,
                bytes: meta.buffer.length,
                width: meta.width,
                height: meta.height,
              },
            },
          }
        );
        await ctx.reply(texts.askChoice, keyboards.buildCategoriesKeyboard());
      } catch (error) {
        logger.error({ err: error.message }, 'photo download failed');
        await ctx.reply(texts.photoInvalid);
      }
      return;
    }

    if (ctx.message.text) {
      const text = ctx.message.text.trim();
      if (step === DIALOG_STEP.AWAIT_TEXT) {
        if (text.length < 3 || text.length > 500) {
          await ctx.reply(texts.freeTextInvalid);
          return;
        }
        await submitAndTrack(ctx, user, { source: 'free_text', userText: text });
        return;
      }
      if (step === DIALOG_STEP.AWAIT_PHOTO) {
        await ctx.reply(texts.askPhoto);
        return;
      }
      if (step === DIALOG_STEP.AWAIT_CHOICE) {
        await ctx.reply(texts.hintAwaitChoice);
        return;
      }
      await ctx.reply(texts.hintIdle, keyboards.buildMainMenuKeyboard());
      return;
    }

    await ctx.reply(step === DIALOG_STEP.AWAIT_PHOTO ? texts.askPhoto : texts.hintIdle);
  });

  const downloadPhoto = async (ctx, meta) => {
    const file = await ctx.telegram.getFile(meta.tgFileId);
    const link = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const response = await fetch(link);
    if (!response.ok) throw new Error(`telegram file http ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const recheck = checkDownloadedPhoto(buffer);
    if (!recheck.ok) {
      const error = new Error(`downloaded photo rejected: ${recheck.reason}`);
      error.code = 'validation';
      throw error;
    }
    return { ...meta, buffer, width: recheck.meta.width, height: recheck.meta.height };
  };

  return bot;
};

module.exports = {
  createBot,
};
