// Кнопка «Задеплоить на Amvera» из админки (раздел настроек «Деплой»).
// Внутри контейнера нет исходников и веток машины разработки, поэтому деплой
// эквивалентен amvera-sync.sh по эффекту: shallow-clone каждого репозитория
// Amvera + empty-commit + push → платформа пересобирает и перезапускает сервисы.
// Пароль передаётся через GIT_ASKPASS-скрипт (не виден в process list и логах).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const createDeployer = ({ config, logger, spawnImpl } = {}) => {
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

  const state = { running: false, lastResult: null };

  const deploy = async ({ by } = {}) => {
    if (state.running) return { ok: false, alreadyRunning: true };
    if (!config.deployLogin || !config.deployPassword || !base() || repos().length === 0) {
      return {
        ok: false,
        error: 'deploy not configured: required DEPLOY_LOGIN, DEPLOY_PASSWORD, DEPLOY_GIT_BASE, DEPLOY_REPOS',
      };
    }

    state.running = true;
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'beauty-deploy-'));
    // askpass отдаёт пароль только своему git; в ps и логах его нет
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
      for (const repo of repos()) {
        const dir = path.join(tmp, repo);
        await runGit(['clone', '--depth', '1', `${base()}/${repo}.git`, dir], { env: gitEnv });
        await runGit(
          ['-c', 'user.email=admin@beauty.local', '-c', `user.name=${by || 'beauty-admin'}`,
            'commit', '--allow-empty', '-m', `deploy: apply settings (by ${by || 'admin'})`],
          { cwd: dir, env: gitEnv }
        );
        await runGit(['push', 'origin', 'HEAD:master'], { cwd: dir, env: gitEnv });
        done.push(`${repo}: ok`);
      }
      state.lastResult = { at: new Date().toISOString(), ok: true, detail: done.join('; '), by: by || '' };
      logger.info({ by, repos: repos() }, 'deploy from admin: pushed');
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
    get running() { return state.running; },
    get lastResult() { return state.lastResult; },
  };
};

module.exports = {
  createDeployer,
};
