// Телеграм-слой (ТЗ 7.3): state-machine поверх users.dialogState в MongoDB.
// Состояние переживает рестарт контейнера (S7), сессий в памяти нет.
// Хендлеры не ждут генерацию: трекинг уходит в фон, результат отправляется
// через bot.telegram по chatId — иначе polling блокируется для всех
// пользователей на время генерации (ревью 3e35882, риск 1).
const { Telegraf, Input } = require('telegraf');
const { DIALOG_STEP, PRESETS_CATALOG } = require('@beauty/shared');
const texts = require('./helpers/texts');
const keyboards = require('./helpers/keyboards');
const { checkAccess, resolveAccess } = require('./helpers/access');
const { validatePhotoMessage, checkDownloadedPhoto, isPhotoPayload } = require('./helpers/validation');
const { nextResetTimeMoscow } = require('./helpers/day');

const EMPTY_PHOTO = {
  storagePath: null, tgFileId: null, mime: null, bytes: 0, width: null, height: null, uploadedAt: null,
};

const photoInvalidText = {
  size: texts.photoInvalidSize,
  too_small: texts.photoInvalidTooSmall,
};

const presetTitle = (code) => {
  const preset = PRESETS_CATALOG.find((p) => p.code === code);
  return preset ? preset.titleRu : 'Стиль не найден';
};

const createBot = ({ token, logger, config, models, storage, generation, retention, settings = null }) => {
  const bot = new Telegraf(token);
  // активные фоновые трекинги — shutdown ждёт их вместе с очередью (ревью 308372d, риск 2)
  bot.activeTracking = new Set();

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

  // Сброс processing → idle только если шаг всё ещё processing (не топчем новое состояние)
  const finishStep = (userId) =>
    models.User.updateOne(
      { _id: userId, 'dialogState.step': DIALOG_STEP.PROCESSING },
      { $set: { 'dialogState.step': DIALOG_STEP.IDLE } }
    );

  // Атомарный захват: двойной тап или старая кнопка не создадут вторую генерацию
  // (ревью 3e35882, риск 2)
  const claimProcessing = (userId) =>
    models.User.findOneAndUpdate(
      { _id: userId, 'dialogState.step': { $ne: DIALOG_STEP.PROCESSING } },
      { $set: { 'dialogState.step': DIALOG_STEP.PROCESSING } },
      { new: true }
    );

  const answerCb = (ctx, text) =>
    ctx.answerCbQuery(text).catch((error) => logger.warn({ err: error.message }, 'answerCbQuery failed'));

  const requirePrivacy = async (ctx, user) => {
    if (user.privacyAcceptedAt) return true;
    await ctx.reply(texts.privacy + '\n\n' + texts.privacyRequired, keyboards.buildPrivacyKeyboard());
    return false;
  };

  const editStatus = (chatId, messageId, text, keyboard) =>
    bot.telegram.editMessageText(chatId, messageId, undefined, text, keyboard).catch(() => {});

  const sendAlbum = async (chatId, request, preset) => {
    const media = [];
    for (let i = 0; i < request.variants.length; i += 1) {
      const buffer = await storage.read(request.variants[i].storagePath);
      media.push({
        type: 'photo',
        media: Input.fromBuffer(buffer, `variant-${i + 1}.png`),
      });
    }
    const total = request.variants.length;
    media[0].caption = preset
      ? texts.resultCaption.replace('{title}', `${preset.emoji} ${preset.titleRu}`).replace('{total}', total)
      : texts.resultCaptionFree.replace('{total}', total);
    await bot.telegram.sendMediaGroup(chatId, media);
  };

  // Фоновый трекинг: результат/ошибка уходят клиенту по завершении очереди
  const runTracking = async (chatId, statusMessageId, user, { source, preset, userText, photo }) => {
    try {
      const result = await generation.submitRequest({ user, photo, source, preset, userText });

      if (result.limited) {
        await finishStep(user._id);
        await editStatus(chatId, statusMessageId, texts.limitReached
          .replace('{limit}', config.dailyLimit)
          .replace('{resetAt}', nextResetTimeMoscow()));
        return;
      }
      if (result.busy) {
        await finishStep(user._id);
        await editStatus(chatId, statusMessageId, texts.serviceBusy, keyboards.buildRetryKeyboard());
        return;
      }
      if (result.budgetStopped) {
        await finishStep(user._id);
        await editStatus(chatId, statusMessageId, texts.budgetStopped);
        return;
      }
      if (result.invalidPhoto) {
        await setStep(user._id, DIALOG_STEP.AWAIT_PHOTO, { 'dialogState.photo': EMPTY_PHOTO });
        await editStatus(chatId, statusMessageId, texts.askPhoto);
        return;
      }

      const outcome = await result.promise;
      await finishStep(user._id);

      if (!outcome.ok) {
        await editStatus(chatId, statusMessageId, texts.generationError, keyboards.buildRetryKeyboard());
        return;
      }

      // клиент мог удалить данные во время генерации — тогда ничего не отправляем
      const request = await models.GenerationRequest.findById(outcome.request._id);
      if (!request || request.deletedAt) return;

      await sendAlbum(chatId, request, preset);
      await bot.telegram.deleteMessage(chatId, statusMessageId).catch(() => {});
      await bot.telegram.sendMessage(chatId, texts.resultReady, keyboards.buildResultActionsKeyboard());
    } catch (error) {
      logger.error({ err: error.message }, 'generation tracking failed');
      await finishStep(user._id);
      await editStatus(chatId, statusMessageId, texts.generationError, keyboards.buildRetryKeyboard());
    }
  };

  const launchGeneration = async (ctx, user, { source, preset = null, userText = null, photo = null, title = null }) => {
    const photoMeta = photo || user.dialogState.photo;
    if (!photoMeta || !photoMeta.storagePath || !(await storage.exists(photoMeta.storagePath))) {
      await setStep(user._id, DIALOG_STEP.AWAIT_PHOTO, { 'dialogState.photo': EMPTY_PHOTO });
      await ctx.reply(texts.askPhoto);
      return;
    }
    const claimed = await claimProcessing(user._id);
    if (!claimed) {
      await ctx.reply(texts.processingBusy);
      return;
    }

    const chatId = ctx.chat.id;
    const statusText = title
      ? texts.generatingFor.replace('{title}', title)
      : texts.generating.replace('{variants}', config.variants);
    let statusMessageId;
    try {
      const statusMessage = await ctx.reply(statusText);
      statusMessageId = statusMessage.message_id;
    } catch (error) {
      // пользователь заблокировал бота / сетевой сбой: без статусного сообщения
      // трекингу некуда писать — снимаем шаг, иначе зависнем в processing
      // (ревью 308372d, риск 8)
      logger.warn({ err: error.message, userId: String(user._id) }, 'status reply failed');
      await finishStep(user._id);
      return;
    }
    const ticker = setInterval(() => {
      bot.telegram.sendChatAction(chatId, 'upload_photo').catch(() => {});
    }, 5000);

    const tracking = runTracking(chatId, statusMessageId, claimed, { source, preset, userText, photo: photoMeta })
      .catch((error) => logger.error({ err: error.message }, 'runTracking crashed'))
      .finally(() => {
        clearInterval(ticker);
        bot.activeTracking.delete(tracking);
      });
    bot.activeTracking.add(tracking);
  };

  const downloadPhoto = async (ctx, meta) => {
    const file = await ctx.telegram.getFile(meta.tgFileId);
    const link = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const response = await fetch(link, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`telegram file http ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const recheck = checkDownloadedPhoto(buffer);
    if (!recheck.ok) {
      const error = new Error(`downloaded photo rejected: ${recheck.reason}`);
      error.code = 'validation';
      error.reason = recheck.reason;
      throw error;
    }
    return { ...meta, buffer, width: recheck.meta.width, height: recheck.meta.height };
  };

  const clearDialogPhoto = async (user) => {
    const current = user.dialogState.photo;
    if (current && current.storagePath) {
      await storage.deleteFiles([current.storagePath]);
    }
    return { 'dialogState.photo': EMPTY_PHOTO };
  };

  bot.catch((error) => {
    logger.error({ err: error && error.message }, 'telegraf handler error');
  });

  // Доступ по списку из настроек админки. Проверяем каждое сообщение, не только
  // /start: иначе фото и кнопки обходят фильтр. /delete_my_data остаётся всегда.
  const isDeleteData = (ctx) => {
    const text = ctx.message && ctx.message.text;
    if (!text) return false;
    const command = text.trim().split(/\s+/)[0].split('@')[0];
    return command === '/delete_my_data';
  };

  bot.use(async (ctx, next) => {
    if (ctx.from) await getOrCreateUser(ctx);
    if (!settings || isDeleteData(ctx)) return next();
    const { mode, entries } = resolveAccess(await settings.get('users'));
    if (checkAccess(mode, entries, ctx.from && ctx.from.id)) return next();
    const text = mode === 'blacklist' ? texts.accessDeniedBlacklist : texts.accessDeniedWhitelist;
    if (ctx.callbackQuery) {
      await answerCb(ctx, text);
      return undefined;
    }
    await ctx.reply(text);
    return undefined;
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
    const extra = await clearDialogPhoto(user);
    await setStep(user._id, DIALOG_STEP.IDLE, extra);
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
    await answerCb(ctx, 'Принято!');
    await models.User.updateOne(
      { _id: user._id, privacyAcceptedAt: null },
      { $set: { privacyAcceptedAt: new Date() } }
    );
    await ctx.editMessageText(texts.privacyAccepted, keyboards.buildMainMenuKeyboard());
  });

  bot.action('menu:start', async (ctx) => {
    await answerCb(ctx);
    const user = await getOrCreateUser(ctx);
    if (!(await requirePrivacy(ctx, user))) return;
    const extra = await clearDialogPhoto(user);
    await setStep(user._id, DIALOG_STEP.AWAIT_PHOTO, extra);
    await ctx.editMessageText(texts.askPhoto);
  });

  bot.action('menu:free_text', async (ctx) => {
    await answerCb(ctx);
    const user = await getOrCreateUser(ctx);
    if (!(await requirePrivacy(ctx, user))) return;
    // без фото свободный текст бессмыслен — просим фото (ревью 3e35882, риск 10)
    if (!user.dialogState.photo || !user.dialogState.photo.storagePath
        || !(await storage.exists(user.dialogState.photo.storagePath))) {
      await setStep(user._id, DIALOG_STEP.AWAIT_PHOTO);
      await ctx.editMessageText(texts.askPhoto);
      return;
    }
    await setStep(user._id, DIALOG_STEP.AWAIT_TEXT);
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
    await answerCb(ctx, presetTitle(ctx.match[1]));
    const user = await getOrCreateUser(ctx);
    if (!(await requirePrivacy(ctx, user))) return;
    const preset = PRESETS_CATALOG.find((p) => p.code === ctx.match[1]);
    if (!preset) {
      await ctx.editMessageText(texts.askChoice, keyboards.buildCategoriesKeyboard());
      return;
    }
    await launchGeneration(ctx, user, { source: 'preset', preset, title: preset.titleRu });
  });

  // Повтор последней генерации по готовому запросу (собственная копия фото у запроса)
  const launchGenerationFromRequest = async (ctx, user, last) => {
    const preset = last.presetCode
      ? PRESETS_CATALOG.find((p) => p.code === last.presetCode) || null
      : null;
    await launchGeneration(ctx, user, {
      source: last.source,
      preset,
      userText: last.userText,
      photo: last.sourcePhoto,
      title: preset ? preset.titleRu : null,
    });
  };

  bot.action('more:last', async (ctx) => {
    await answerCb(ctx);
    const user = await getOrCreateUser(ctx);
    const last = await generation.lastDoneRequest(user._id);
    if (!last) {
      await setStep(user._id, DIALOG_STEP.AWAIT_CHOICE);
      await ctx.editMessageText(texts.askChoice, keyboards.buildCategoriesKeyboard());
      return;
    }
    await launchGenerationFromRequest(ctx, user, last);
  });

  bot.action('act:retry', async (ctx) => {
    await answerCb(ctx);
    const user = await getOrCreateUser(ctx);
    // повторяем последний актуальный запрос (в т.ч. упавший), а не последний успешный
    const last = await generation.lastRetryableRequest(user._id);
    if (!last) {
      await setStep(user._id, DIALOG_STEP.AWAIT_CHOICE);
      await ctx.editMessageText(texts.askChoice, keyboards.buildCategoriesKeyboard());
      return;
    }
    await launchGenerationFromRequest(ctx, user, last);
  });

  bot.action('style:again', async (ctx) => {
    await answerCb(ctx);
    const user = await getOrCreateUser(ctx);
    if (!user.dialogState.photo || !user.dialogState.photo.storagePath
        || !(await storage.exists(user.dialogState.photo.storagePath))) {
      await setStep(user._id, DIALOG_STEP.AWAIT_PHOTO, { 'dialogState.photo': EMPTY_PHOTO });
      await ctx.editMessageText(texts.askPhoto);
      return;
    }
    await setStep(user._id, DIALOG_STEP.AWAIT_CHOICE);
    await ctx.editMessageText(texts.askChoice, keyboards.buildCategoriesKeyboard());
  });

  bot.action('act:cancel', async (ctx) => {
    await answerCb(ctx);
    const user = await getOrCreateUser(ctx);
    const extra = await clearDialogPhoto(user);
    await setStep(user._id, DIALOG_STEP.IDLE, extra);
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
        await ctx.reply(photoInvalidText[validation.reason] || texts.photoInvalid);
        return;
      }
      try {
        const meta = await downloadPhoto(ctx, validation.meta);
        // подменяем предыдущее фото: старый файл больше не нужен
        const previous = user.dialogState.photo;
        if (previous && previous.storagePath) {
          await storage.deleteFiles([previous.storagePath]);
        }
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
                uploadedAt: new Date(),
              },
            },
          }
        );
        await ctx.reply(texts.askChoice, keyboards.buildCategoriesKeyboard());
      } catch (error) {
        if (error.code === 'validation') {
          await ctx.reply(photoInvalidText[error.reason] || texts.photoInvalid);
          return;
        }
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
        await launchGeneration(ctx, user, { source: 'free_text', userText: text });
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

  return bot;
};

module.exports = {
  createBot,
};
