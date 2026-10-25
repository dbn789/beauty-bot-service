#!/usr/bin/env bash
# Синхронизация деплоя на Amvera: пересобирает ветки deploy/bot и deploy/admin
# из master (каждая со своей amvera.yaml) и пушит их в master соответствующих
# проектов Amvera. Запуск: scripts/amvera-sync.sh
#
# Remotes (добавить один раз):
#   git remote add amvera-bot   ssh://git@git.amvera.ru/<логин>/beauty-bot.git
#   git remote add amvera-admin ssh://git@git.amvera.ru/<логин>/beauty-admin.git
set -euo pipefail
cd "$(dirname "$0")/.."

# Прошлый оборванный пуш оставляет ветку deploy/* привязанной к удалённому
# каталогу. Без prune следующий запуск молча падает ещё до запроса пароля.
git worktree prune

TMP=$(mktemp -d)
cleanup() {
  local app
  for app in bot admin; do
    if [[ -d "$TMP/$app" ]]; then
      git worktree remove --force "$TMP/$app" >/dev/null 2>&1 || true
    fi
  done
  rm -rf "$TMP"
  git worktree prune >/dev/null 2>&1 || true
}
trap cleanup EXIT

for app in bot admin; do
  branch="deploy/$app"
  remote="amvera-$app"

  if ! git remote get-url "$remote" >/dev/null 2>&1; then
    echo "нет remote $remote — добавьте: git remote add $remote https://git.waw0.amvera.ru/<логин>/beauty-$app" >&2
    exit 1
  fi

  git worktree add "$TMP/$app" -B "$branch" master
  cp "deploy/amvera-$app.yaml" "$TMP/$app/amvera.yaml"
  (
    cd "$TMP/$app"
    git add amvera.yaml
    git diff --cached --quiet || git commit -q -m "chore: amvera deploy config ($app)"
    git push "$remote" "$branch:master" --force
  )
  git worktree remove --force "$TMP/$app"
  echo "✓ $app → $remote (ветка $branch)"
done

echo "Готово. Сборка запустится в ЛК Amvera автоматически."
