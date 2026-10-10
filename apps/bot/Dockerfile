# Контейнер beauty-bot (ТЗ 7.4). Контекст сборки — корень монорепо.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/bot/package.json apps/bot/

RUN npm ci --omit=dev --workspace packages/shared --workspace apps/bot

COPY packages/shared packages/shared
COPY apps/bot apps/bot

ENV NODE_ENV=production \
    INTERNAL_API_PORT=8080

EXPOSE 8080

CMD ["node", "apps/bot/index.js"]
