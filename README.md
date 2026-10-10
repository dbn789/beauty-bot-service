# Beauty Bot Service

Телеграм-бот подбора причёсок для салона красоты: клиент отправляет селфи и пожелания,
сервис через **FLUX.2** (Black Forest Labs) генерирует 1–3 варианта новой причёски
с сохранением лица и возвращает их в чат.

| | |
|---|---|
| **Статус** | Э0–Э1 завершены (каркас + бот MVP на mock) · далее Э2 — интеграция FLUX.2 |
| **ТЗ** | [docs/technical-spec.md](docs/technical-spec.md) |
| **Код** | `apps/bot`, `apps/admin`, `packages/shared`, `scripts/` |
| **Платформа** | Amvera Cloud: 2 docker-проекта (бот, админка) + managed MongoDB |
| **Генерация** | FLUX.2 через API: bfl.ai (приоритет) / fal.ai (альтернатива), адаптер-слой |
| **Стек** | Node.js 22, telegraf 4, mongoose 8, express 4, pino, jest, eslint |

## Локальная разработка

```bash
npm install                 # установка workspaces (единожды)
npm run lint && npm test    # гейты перед каждым коммитом
npm run start:bot           # Internal API :8080 (/health); бот стартует при заданном BOT_TOKEN
npm run start:admin         # админка :3000 (/login)
npm run docker:build:bot    # сборка образа beauty-bot:dev
npm run docker:build:admin  # сборка образа beauty-admin:dev
```

## Состав системы (кратко)

```
Клиент (Telegram) ──▶ beauty-bot (docker, Amvera) ──▶ FLUX.2 API (bfl.ai / fal.ai)
                            │
                            ├──▶ MongoDB (managed, Amvera)     метаданные, пользователи
                            ├──▶ persistent storage            фото и результаты (ретеншн 30 дн.)
                            └──▶ Internal API (внутр. сеть Amvera)
                                      ▲
Администратор салона ──▶ beauty-admin (docker, Amvera, HTTPS-домен)
```

## Референсы (паттерны кода)

- `repos-projects/tgbot/tg-support-bot-instance` — структура инстанса бота (createBot/createApp, models, api-clients, helpers).
- `repos-projects/tgbot/tg_bot_central` — структура админки/центрального сервиса (apps/*, docs/, smoke-гейты).

## Правила репозитория

- Пишем только в этот каталог (`store/beauty_bot_service`), соседние репо не трогаем.
- Секреты — только переменными окружения (Amvera → «Переменные окружения»), в репо лишь `.example`-шаблоны.
- Перед каждым коммитом: `npm run lint-fix && npm run test` (ошибки чиним, не подавляем).
- Решения, меняющие архитектуру, фиксируем в `docs/` отдельным ADR-подобным файлом.
