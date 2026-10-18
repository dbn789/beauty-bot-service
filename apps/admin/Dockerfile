# Контейнер beauty-admin (ТЗ 7.4). Контекст сборки — корень монорепо.
# node:22-slim в harbor.waw0 отдаёт битый слой (unexpected EOF). Alpine — другой образ.
FROM node:22-alpine

# git нужен кнопке «Задеплоить на Amvera» (раздел настроек «Деплой»)
RUN apk add --no-cache git

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/admin/package.json apps/admin/

RUN npm ci --omit=dev --workspace packages/shared --workspace apps/admin

COPY packages/shared packages/shared
COPY apps/admin apps/admin

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

CMD ["node", "apps/admin/index.js"]
