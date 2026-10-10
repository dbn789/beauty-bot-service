// Точка входа контейнера beauty-admin (ТЗ 5.3). Каркас Э0: health + страницы-заглушки.
// Авторизация, статистика и журнал — этап Э4.
const path = require('path');
const express = require('express');
const { version } = require('./package.json');

const app = express();

app.set('view engine', 'pug');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', app: 'beauty-admin', version, ts: new Date().toISOString() });
});

app.get('/', (_req, res) => res.redirect('/login'));

app.get('/login', (_req, res) => {
  res.render('login', { title: 'Вход', error: null });
});

// Заглушка Э0: реальная проверка пароля и сессия — Э4 (FR-A-020).
app.post('/login', (_req, res) => res.redirect('/dashboard'));

app.get('/dashboard', (_req, res) => {
  res.render('dashboard', { title: 'Дашборд' });
});

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, () => {
  console.log(`beauty-admin listening on :${port} (v${version})`);
});

const shutdown = (signal) => () => {
  console.log('shutdown', signal);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
};
process.once('SIGINT', shutdown('SIGINT'));
process.once('SIGTERM', shutdown('SIGTERM'));
