# Контейнер beauty-admin (ТЗ 7.4). Контекст сборки — корень монорепо.
FROM node:22-slim

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
