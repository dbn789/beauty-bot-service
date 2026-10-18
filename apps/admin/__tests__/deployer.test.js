// Юнит-тесты деплоера без git и сети: фейковый spawn.
const { EventEmitter } = require('events');
const { createDeployer } = require('../helpers/deployer');

// эмулятор child_process.spawn: пишет команды в лог, exit 0 или код по сценарию
const makeSpawn = ({ failOn = null } = {}) => {
  const calls = [];
  const spawnImpl = (cmd, args, options) => {
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
  return { calls, spawnImpl };
};

const baseConfig = {
  deployLogin: 'user',
  deployPassword: 'pass',
  deployGitBase: 'https://git.example.ru/u',
  deployRepos: 'beauty-bot,beauty-admin',
};

describe('createDeployer', () => {
  test('happy path: clone → empty-commit → push для каждого репо', async () => {
    const harness = makeSpawn();
    const logger = { info: () => {}, error: () => {} };
    const deployer = createDeployer({ config: baseConfig, logger, spawnImpl: harness.spawnImpl });

    const result = await deployer.deploy({ by: 'boss' });
    expect(result.ok).toBe(true);
    expect(result.detail).toBe('beauty-bot: ok; beauty-admin: ok');

    const commands = harness.calls.map((c) => c.args[0]);
    // на каждое репо: clone, commit (через -c конфиги), push
    expect(commands).toEqual(['clone', '-c', 'push', 'clone', '-c', 'push']);
    expect(harness.calls[1].args).toContain('commit');

    // URL без пароля, пароль уходит только в env (GIT_ASKPASS)
    expect(harness.calls[0].args[3]).toBe('https://git.example.ru/u/beauty-bot.git');
    const env = harness.calls[0].options.env;
    expect(env.DEPLOY_PASSWORD).toBe('pass');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(String(env.GIT_ASKPASS)).toContain('askpass.sh');

    // commit помечает, кто деплоил
    const commitArgs = harness.calls[1].args.join(' ');
    expect(commitArgs).toContain('deploy: apply settings (by boss)');
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
    const deployer = createDeployer({ config: baseConfig, logger: { info: () => {}, error: () => {} }, spawnImpl });

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
