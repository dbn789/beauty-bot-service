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

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

for app in bot admin; do
  branch="deploy/$app"
  remote="amvera-$app"

  if ! git remote get-url "$remote" >/dev/null 2>&1; then
    echo "нет remote $remote — добавьте: git remote add $remote ssh://git@git.amvera.ru/<логин>/beauty-$app.git" >&2
    exit 1
  fi

  git worktree add "$TMP/$app" -B "$branch" master >/dev/null 2>&1
  cp "deploy/amvera-$app.yaml" "$TMP/$app/amvera.yaml"
  (
    cd "$TMP/$app"
    git add amvera.yaml
    git diff --cached --quiet || git commit -q -m "chore: amvera deploy config ($app)"
    git push "$remote" "$branch:master" --force
  )
  git worktree remove --force "$TMP/$app" >/dev/null 2>&1
  echo "✓ $app → $remote (ветка $branch)"
done

echo "Готово. Сборка запустится в ЛК Amvera автоматически."
