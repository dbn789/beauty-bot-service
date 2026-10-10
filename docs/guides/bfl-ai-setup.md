# Как завести API-ключ bfl.ai (этап Э2)

> Источник: docs.bfl.ai (quick_start). Актуально на 2026-10 — сверить при подключении.

## 1. Регистрация

1. Открыть **https://dashboard.bfl.ai** → зарегистрироваться по e-mail → подтвердить почту.
2. BFL автоматически создаст **Default Organization** (биллинг) и **Default Project** (ключи и статистика) — ничего настраивать не надо.

## 2. Пополнение баланса

1. В сайдбаре организации: **API → Credits → Add Credits**.
2. Курс: **1 credit = $0.01**; оплата через **Stripe** (Visa/Mastercard — только не-РФ карты; крипта не заявлена).
3. Рекомендация самой BFL для старта: **$10–20**.

Ориентир расхода (docs.bfl.ai, цены «from» за мегапиксель): одна генерация = 3 варианта ≈
`flux-2-pro` $0.135 (редактирование $0.045/вариант) → **$10 хватит на ~74 генерации**;
бюджетный `flux-2-klein-9b` — втрое дешевле. `flux-2-flex` для нашей задачи дороже pro ($0.06).
Сигнал «creditы кончились» — HTTP **402** от API (пополняется там же).

## 3. Создание API-ключа

1. **API → Keys → Add Key** (ключ привязан к проекту).
2. Ключ показывается **один раз** — сразу скопировать.
3. Ротация: удалить ключ и завести новый там же.

## 4. Проверка ключа (разовая, ~$0.03)

```bash
export BFL_API_KEY="ваш_ключ"

# создаём задачу (text-to-image для проверки)
curl -s https://api.bfl.ai/v1/flux-2-flex \
  -H "x-key: $BFL_API_KEY" -H "Content-Type: application/json" \
  -d '{"prompt":"a red apple on a wooden table","width":512,"height":512}'
# → {"id":"...","polling_url":"https://api.bfl.ai/v1/get_result?id=..."}

# опрашиваем polling_url, пока status не станет "Ready" (результат в result.sample)
curl -s "$POLLING_URL" -H "x-key: $BFL_API_KEY"
```

## 5. Куда положить ключ

**Ключ — секрет: не вставлять в чат, коммиты и скриншоты.**

- **Локально (Э2)**: файл `.env` в корне репо (уже в `.gitignore`):

  ```
  BFL_API_KEY=...
  GENERATION_PROVIDER=bfl
  MONGO_URI=...
  ```

  Запуск с подгрузкой env: `node --env-file=.env apps/bot/index.js`
  (локальный Node 18 не умеет `--env-file` — тогда `export BFL_API_KEY=...` в шелле).

- **Amvera (Э3)**: ЛК → проект `beauty-bot` → «Переменные окружения» →
  `BFL_API_KEY` = значение. Вводит владелец аккаунта руками; в git значение не попадает.

## Технические детали для BflProvider (Э2)

| Параметр | Значение |
|---|---|
| Base URL | `https://api.bfl.ai/v1` (global; есть `api.eu.bfl.ai`, `api.us.bfl.ai`) |
| Auth | заголовок `x-key: <BFL_API_KEY>` |
| Модель-дефолт | `flux-2-pro` ($0.045/вариант, рекомендован BFL); для сравнения — `flux-2-klein-9b` ($0.015) |
| Флоу | POST `{prompt, input_image: data-URI}` → `{id, polling_url}` → GET polling_url до `status:"Ready"` → `result.sample` — URL результата живёт **10 минут** (мы сразу скачиваем) |
| Лимиты | до 24 активных задач одновременно (429 при превышении); 402 = нет creditов |
