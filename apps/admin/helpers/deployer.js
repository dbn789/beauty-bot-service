// Кнопка «Задеплоить на Amvera» повторяет scripts/amvera-sync.sh:
// клонирует master из DEPLOY_SOURCE_URL (GitHub), для каждого проекта
// кладёт свой deploy/amvera-<app>.yaml в корень как amvera.yaml и пушит
// эту ветку в master репозитория Amvera. Пароль Amvera уходит только в
// GIT_ASKPASS, в URL и логи его нет.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const createDeployer = ({ config, logger, spawnImpl, prepareImpl } = {}) => {
  const runGit = (args, { cwd, env }) => new Promise((resolve, reject) => {
    const child = (spawnImpl || spawn)('git', args, { cwd, env });
    let stderr = '';
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      return reject(new Error(`git ${args[0]} → exit ${code}: ${stderr.slice(0, 300)}`));
    });
  });

  const repos = () => String(config.deployRepos || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const base = () => String(config.deployGitBase || '').replace(/\/+$/, '');
  const sourceUrl = () => String(config.deploySourceUrl || '').trim();
  // beauty-bot → файл deploy/amvera-bot.yaml
  const appKey = (repo) => repo.replace(/^beauty-/, '');

  // логин вшиваем в URL (basic auth), askpass отвечает только паролем.
  // Суффикс .git Amvera не принимает: после верного пароля отвечает «repository not found».
  const authUrl = (repo) =>
    base().replace(/^(https?:\/\/)/, `$1${encodeURIComponent(config.deployLogin)}@`) + `/${repo}`;

  const prepare = prepareImpl || (async (dir, repo) => {
    const app = appKey(repo);
    const from = path.join(dir, 'deploy', `amvera-${app}.yaml`);
    try {
      await fs.promises.copyFile(from, path.join(dir, 'amvera.yaml'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`в источнике нет deploy/amvera-${app}.yaml`);
      }
      throw error;
    }
  });

  const configured = Boolean(
    config.deployLogin && config.deployPassword && base() && repos().length && sourceUrl()
  );

  const state = { running: false, lastResult: null };

  const deploy = async ({ by } = {}) => {
    if (state.running) return { ok: false, alreadyRunning: true };
    if (!configured) {
      return {
        ok: false,
        error: 'deploy not configured: required DEPLOY_LOGIN, DEPLOY_PASSWORD, DEPLOY_GIT_BASE, DEPLOY_REPOS, DEPLOY_SOURCE_URL',
      };
    }

    state.running = true;
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'beauty-deploy-'));
    const askpass = path.join(tmp, 'askpass.sh');
    await fs.promises.writeFile(askpass, '#!/bin/sh\necho "$DEPLOY_PASSWORD"\n', { mode: 0o700 });
    const gitEnv = {
      ...process.env,
      GIT_ASKPASS: askpass,
      GIT_TERMINAL_PROMPT: '0',
      DEPLOY_PASSWORD: config.deployPassword,
    };

    const done = [];
    try {
      const dir = path.join(tmp, 'source');
      await runGit(['clone', '--branch', 'master', sourceUrl(), dir], { env: gitEnv });
      // метка исходного master: перед каждым проектом возвращаемся сюда,
      // чтобы amvera.yaml одного приложения не уехал во второе
      await runGit(['branch', '-f', 'source', 'HEAD'], { cwd: dir, env: gitEnv });
      for (const repo of repos()) {
        const app = appKey(repo);
        await runGit(['reset', '--hard', 'source'], { cwd: dir, env: gitEnv });
        await prepare(dir, repo);
        await runGit(['add', '-f', 'amvera.yaml'], { cwd: dir, env: gitEnv });
        await runGit(
          ['-c', 'user.email=admin@beauty.local', '-c', `user.name=${by || 'beauty-admin'}`,
            'commit', '-m', `chore: amvera deploy config (${app})`],
          { cwd: dir, env: gitEnv }
        );
        await runGit(['push', '--force', authUrl(repo), 'HEAD:master'], { cwd: dir, env: gitEnv });
        done.push(`${repo}: ok`);
      }
      state.lastResult = { at: new Date().toISOString(), ok: true, detail: done.join('; '), by: by || '' };
      logger.info({ by, repos: repos() }, 'deploy from admin: pushed source master');
      return state.lastResult;
    } catch (error) {
      state.lastResult = { at: new Date().toISOString(), ok: false, detail: error.message.slice(0, 300), by: by || '' };
      logger.error({ err: error.message, by }, 'deploy from admin failed');
      return state.lastResult;
    } finally {
      state.running = false;
      fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  };

  return {
    deploy,
    configured,
    get running() { return state.running; },
    get lastResult() { return state.lastResult; },
  };
};

module.exports = {
  createDeployer,
};
