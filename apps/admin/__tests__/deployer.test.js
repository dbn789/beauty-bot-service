// Юнит-тесты деплоера без git и сети: фейковый spawn.
const { EventEmitter } = require('events');
const fs = require('fs');
const { createDeployer } = require('../helpers/deployer');

// эмулятор child_process.spawn: пишет команды в лог, exit 0 или код по сценарию
const makeSpawn = ({ failOn = null } = {}) => {
  const calls = [];
  const found = { askpass: '' };
  const spawnImpl = (cmd, args, options) => {
    if (options && options.env && options.env.GIT_ASKPASS && !found.askpass) {
      found.askpass = fs.readFileSync(options.env.GIT_ASKPASS, 'utf8');
    }
    calls.push({ cmd, args, options });
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      if (failOn && args.join(' ').startsWith(failOn)) {
        child.stderr.emit('data', Buffer.from('boom'));
        child.emit('close', 128);
      } else {
        child.emit('close', 0);
      }
    });
    return child;
  };
  return { calls, spawnImpl, found };
};

const baseConfig = {
  deployLogin: 'user',
  deployPassword: 'pass',
  deployGitBase: 'https://git.example.ru/u',
  deployRepos: 'beauty-bot,beauty-admin',
  deploySourceUrl: 'https://github.com/dbn789/beauty-bot-service.git',
};

describe('createDeployer', () => {
  test('happy path: clone master с GitHub, свой amvera.yaml и push в каждый проект', async () => {
    const harness = makeSpawn();
    const prepared = [];
    const logger = { info: () => {}, error: () => {} };
    const deployer = createDeployer({
      config: baseConfig,
      logger,
      spawnImpl: harness.spawnImpl,
      prepareImpl: async (_dir, repo) => { prepared.push(repo); },
    });
    expect(deployer.configured).toBe(true);

    const result = await deployer.deploy({ by: 'boss' });
    expect(result.ok).toBe(true);
    expect(result.detail).toBe('beauty-bot: ok; beauty-admin: ok');
    expect(prepared).toEqual(['beauty-bot', 'beauty-admin']);

    const commands = harness.calls.map((c) => c.args[0]);
    expect(commands).toEqual([
      'clone', 'branch',
      'reset', 'add', '-c', 'push',
      'reset', 'add', '-c', 'push',
    ]);

    // источник — публичный GitHub, без пароля в URL
    expect(harness.calls[0].args).toContain('https://github.com/dbn789/beauty-bot-service.git');
    expect(harness.calls[0].args.join(' ')).not.toContain('pass');

    const pushes = harness.calls.filter((c) => c.args[0] === 'push');
    expect(pushes[0].args).toEqual([
      'push', '--force', 'https://user@git.example.ru/u/beauty-bot', 'HEAD:master',
    ]);
    expect(pushes[1].args[2]).toBe('https://user@git.example.ru/u/beauty-admin');

    const env = harness.calls[0].options.env;
    expect(env.DEPLOY_LOGIN).toBe('user');
    expect(env.DEPLOY_PASSWORD).toBe('pass');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(String(env.GIT_ASKPASS)).toContain('askpass.sh');
    expect(harness.found.askpass).toContain('Username*)');
    expect(harness.found.askpass).toContain('DEPLOY_LOGIN');

    const commitArgs = harness.calls.find((c) => c.args.includes('commit')).args.join(' ');
    expect(commitArgs).toContain('chore: amvera deploy config (bot)');
    expect(commitArgs).toContain('user.name=boss');
  });

  test('ошибка clone → ok:false с деталями, состояние сбрасывается', async () => {
    const harness = makeSpawn({ failOn: 'clone' });
    const logger = { info: () => {}, error: () => {} };
    const deployer = createDeployer({ config: baseConfig, logger, spawnImpl: harness.spawnImpl });

    const result = await deployer.deploy({ by: 'boss' });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('clone');

    // после сбоя можно запускать снова
    const second = await deployer.deploy({ by: 'boss' });
    expect(second.alreadyRunning).toBeUndefined();
  });

  test('без переменных деплоя — понятная ошибка без запуска git', async () => {
    const harness = makeSpawn();
    const deployer = createDeployer({
      config: { deployLogin: '', deployPassword: '', deployGitBase: '', deployRepos: '' },
      logger: { info: () => {}, error: () => {} },
      spawnImpl: harness.spawnImpl,
    });
    expect(deployer.configured).toBe(false); // UI скрывает кнопку по этому флагу
    const result = await deployer.deploy({});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/DEPLOY_LOGIN/);
    expect(harness.calls).toHaveLength(0);
  });

  test('повторный запуск во время выполнения отклоняется', async () => {
    // первый вызов блокируем (клонирование «висит»), остальные — мгновенно ок
    const blocker = new EventEmitter();
    blocker.stderr = new EventEmitter();
    let call = 0;
    const spawnImpl = () => {
      call += 1;
      if (call === 1) return blocker;
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      process.nextTick(() => child.emit('close', 0));
      return child;
    };
    const deployer = createDeployer({
      config: baseConfig,
      logger: { info: () => {}, error: () => {} },
      spawnImpl,
      prepareImpl: async () => {},
    });

    const first = deployer.deploy({ by: 'boss' });
    // даём деплоеру дойти до clone (иначе эмит close потеряется до подписки)
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await deployer.deploy({ by: 'boss' });
    expect(second).toEqual({ ok: false, alreadyRunning: true });

    blocker.emit('close', 0);
    const done = await first;
    expect(done.ok).toBe(true);
  });
});
