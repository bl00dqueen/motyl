'use strict';

/**
 * Смоук-тест Motyl: поднимает сервер на свободном порту и проверяет
 * регистрацию, контакты, WebSocket-сообщения, typing, nudge, прочтение,
 * оффлайн-доставку, переподключение и REST API.
 *
 * Запуск: node tests/smoke.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { connect } = require('../lib/ws');

const ROOT = path.resolve(__dirname, '..');
const PORT = 19000 + Math.floor(Math.random() * 1200);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), `motyl-smoke-${process.pid}-${Date.now()}.json`);
const LOG = path.join(os.tmpdir(), `motyl-smoke-${process.pid}.log`);

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, details) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${details ? ' — ' + details : ''}`);
  }
}

function equal(name, actual, expected) {
  check(name, actual === expected, `получено ${JSON.stringify(actual)}, ожидалось ${JSON.stringify(expected)}`);
}

async function http(pathname, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(BASE + pathname, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await response.json(); } catch (err) { /* ignore */ }
  return { status: response.status, data };
}

function collector(conn) {
  const queue = [];
  const waiters = [];
  conn.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch (err) { return; }
    queue.push(data);
    for (const waiter of [...waiters]) waiter(data);
  });
  return {
    wait(predicate, label = 'событие', timeout = 4000) {
      const existing = queue.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          detach();
          reject(new Error(`таймаут ожидания: ${label}`));
        }, timeout);
        const waiter = (data) => {
          if (!predicate(data)) return;
          clearTimeout(timer);
          detach();
          resolve(data);
        };
        const detach = () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
        };
        waiters.push(waiter);
      });
    },
    last(predicate) {
      for (let i = queue.length - 1; i >= 0; i--) if (predicate(queue[i])) return queue[i];
      return null;
    },
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok) return await res.json();
    } catch (err) { /* ещё не поднялся */ }
    await delay(120);
  }
  throw new Error('Сервер не запустился за 8 секунд');
}

async function main() {
  console.log(`\n\x1b[36mMotyl smoke test\x1b[0m · порт ${PORT}\n`);

  const logStream = fs.createWriteStream(LOG);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      MOTYL_PORT: String(PORT),
      MOTYL_HOST: '127.0.0.1',
      MOTYL_DATA: DATA,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  let aliceWs = null;
  let bobWs = null;

  try {
    const health = await waitForHealth();
    check('health отвечает', health.ok === true);
    equal('пользователь только бот', health.users, 1);

    const aliceReg = await http('/api/register', {
      method: 'POST',
      body: { login: 'alice', password: 'motyl123', displayName: 'Алиса' },
    });
    equal('регистрация alice', aliceReg.status, 201);
    check('alice получила токен', typeof aliceReg.data.token === 'string' && aliceReg.data.token.length > 20);

    const bobReg = await http('/api/register', {
      method: 'POST',
      body: { login: 'bob', password: 'motyl123', displayName: 'Боб' },
    });
    equal('регистрация bob', bobReg.status, 201);

    const aliceToken = aliceReg.data.token;
    const bobToken = bobReg.data.token;
    const aliceId = aliceReg.data.user.id;
    const bobId = bobReg.data.user.id;

    const authFail = await http('/api/me');
    equal('без токена — 401', authFail.status, 401);

    const dup = await http('/api/register', {
      method: 'POST',
      body: { login: 'alice', password: 'motyl123' },
    });
    equal('повторный логин — 409', dup.status, 409);

    const badLogin = await http('/api/login', {
      method: 'POST',
      body: { login: 'alice', password: 'wrong' },
    });
    equal('неверный пароль — 401', badLogin.status, 401);

    const botLogin = await http('/api/login', {
      method: 'POST',
      body: { login: 'motyl', password: 'x' },
    });
    equal('системный аккаунт не входит', botLogin.status, 401);

    const aliceContacts = await http('/api/contacts', { token: aliceToken });
    check('бот в контактах alice', aliceContacts.data.contacts.some((contact) => contact.login === 'motyl'));
    check('приветствие бота не прочитано', aliceContacts.data.contacts.find((contact) => contact.login === 'motyl').unread >= 1);

    const added = await http('/api/contacts', {
      method: 'POST',
      token: aliceToken,
      body: { login: 'bob', group: 'Друзья' },
    });
    equal('добавление bob в контакты', added.status, 201);
    check('контакт добавлен', added.data.added === true);

    const selfAdd = await http('/api/contacts', {
      method: 'POST',
      token: aliceToken,
      body: { login: 'alice' },
    });
    equal('нельзя добавить себя', selfAdd.status, 400);

    aliceWs = await connect(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(aliceToken)}`);
    const aliceEvents = collector(aliceWs);
    const aliceReady = await aliceEvents.wait((event) => event.t === 'ready', 'ready alice');
    equal('ready alice', aliceReady.user.login, 'alice');
    check('alice видит bob в контактах', aliceReady.contacts.some((contact) => contact.login === 'bob'));

    bobWs = await connect(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(bobToken)}`);
    const bobEvents = collector(bobWs);
    const bobReady = await bobEvents.wait((event) => event.t === 'ready', 'ready bob');
    equal('ready bob', bobReady.user.login, 'bob');

    await aliceEvents.wait((event) => event.t === 'presence' && event.user.id === bobId && event.user.status === 'online', 'presence bob online');

    const text1 = 'Привет, Боб! Как дела?';
    aliceWs.send(JSON.stringify({ t: 'msg', to: bobId, text: text1, cid: 'c-1' }));
    const sent1 = await aliceEvents.wait((event) => event.t === 'sent' && event.cid === 'c-1', 'sent c-1');
    equal('sent вернул cid', sent1.cid, 'c-1');
    equal('текст сохранён', sent1.m.text, text1);

    const incoming1 = await bobEvents.wait((event) => event.t === 'msg' && event.m.text === text1, 'msg bob');
    equal('сообщение пришло от alice', incoming1.from.login, 'alice');
    check('в сообщении есть id', typeof incoming1.m.id === 'string');

    bobWs.send(JSON.stringify({ t: 'typing', to: aliceId }));
    const typing = await aliceEvents.wait((event) => event.t === 'typing' && event.from === bobId, 'typing');
    equal('typing от bob', typing.from, bobId);

    bobWs.send(JSON.stringify({ t: 'nudge', to: aliceId }));
    const nudge = await aliceEvents.wait((event) => event.t === 'nudge' && event.from.id === bobId, 'nudge');
    equal('nudge от bob', nudge.from.login, 'bob');

    aliceWs.send(JSON.stringify({ t: 'nudge', to: bobId }));
    const nudge2 = await bobEvents.wait((event) => event.t === 'nudge' && event.from.id === aliceId, 'nudge 2');
    check('nudge доставлен bob', nudge2.from.login === 'alice');

    bobWs.send(JSON.stringify({ t: 'read', with: aliceId }));
    const readByBob = await aliceEvents.wait((event) => event.t === 'read' && event.by === bobId, 'read by bob');
    check('отметка о прочтении доставлена', readByBob.count >= 1);

    const text2 = 'У меня отлично! Проверяю Motyl :)';
    aliceWs.send(JSON.stringify({ t: 'msg', to: bobId, text: text2 }));
    await bobEvents.wait((event) => event.t === 'msg' && event.m.text === text2, 'msg 2');

    const text3 = 'У меня тоже всё хорошо. Терминал на связи!';
    bobWs.send(JSON.stringify({ t: 'msg', to: aliceId, text: text3 }));
    await aliceEvents.wait((event) => event.t === 'msg' && event.m.text === text3, 'msg 3');

    aliceWs.send(JSON.stringify({ t: 'read', with: bobId }));
    await bobEvents.wait((event) => event.t === 'read' && event.by === aliceId, 'read by alice');

    const profile = await http('/api/me', {
      method: 'PATCH',
      token: bobToken,
      body: { displayName: 'Боб Великий', statusText: 'Тестирую API' },
    });
    equal('профиль обновлён', profile.data.user.displayName, 'Боб Великий');
    equal('статусное сообщение обновлено', profile.data.user.statusText, 'Тестирую API');

    bobWs.send(JSON.stringify({ t: 'status', status: 'busy', statusText: 'Занят тестами' }));
    const busy = await aliceEvents.wait((event) => event.t === 'presence' && event.user.id === bobId && event.user.status === 'busy', 'presence busy');
    equal('presence busy', busy.user.status, 'busy');

    const search = await http('/api/search?q=bo', { token: aliceToken });
    check('поиск находит bob', search.data.users.some((user) => user.login === 'bob'));

    const stats = await http('/api/stats', { token: aliceToken });
    equal('stats: двое онлайн', stats.data.online, 2);
    equal('stats: три аккаунта', stats.data.users, 3);

    // оффлайн-доставка
    bobWs.close(1000);
    bobWs = null;
    const offlinePresence = await aliceEvents.wait(
      (event) => event.t === 'presence' && event.user.id === bobId && event.user.status === 'offline',
      'presence bob offline',
    );
    equal('bob ушёл в оффлайн', offlinePresence.user.status, 'offline');

    const offlineText = 'Ты где? Это оффлайн-сообщение.';
    aliceWs.send(JSON.stringify({ t: 'msg', to: bobId, text: offlineText }));
    await aliceEvents.wait((event) => event.t === 'sent' && event.m.text === offlineText, 'sent offline');

    await delay(150);

    const history = await http(`/api/history?with=${aliceId}&limit=50`, { token: bobToken });
    equal('история: 200', history.status, 200);
    check('оффлайн-сообщение в истории', history.data.messages.some((message) => message.text === offlineText));
    check('история отсортирована', history.data.messages.every((message, index, list) => index === 0 || list[index - 1].ts <= message.ts));

    const unreadContacts = await http('/api/contacts', { token: bobToken });
    const aliceContact = unreadContacts.data.contacts.find((contact) => contact.id === aliceId);
    check('bob видит alice в контактах после авто-добавления', !!aliceContact);
    check('у bob есть непрочитанное', aliceContact.unread >= 1);

    const me = await http('/api/me', { token: bobToken });
    check('me: непрочитанные > 0', me.data.unread >= 1);

    bobWs = await connect(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(bobToken)}`);
    const bobEvents2 = collector(bobWs);
    const bobReady2 = await bobEvents2.wait((event) => event.t === 'ready', 'ready bob 2');
    check('после переподключения unread > 0', bobReady2.unread >= 1);

    // сообщение боту и автоответ
    const botContact = aliceReady.contacts.find((contact) => contact.login === 'motyl');
    aliceWs.send(JSON.stringify({ t: 'msg', to: botContact.id, text: '/help' }));
    const botReply = await aliceEvents.wait((event) => event.t === 'msg' && event.from.id === botContact.id && event.m.text.includes('Что я умею'), 'ответ бота', 6000);
    check('бот отвечает на /help', botReply.m.text.includes('Motyl') || botReply.m.text.includes('tui'));

    const html = await fetch(BASE + '/');
    const htmlText = await html.text();
    equal('index.html отдаётся', html.status, 200);
    check('в HTML есть Motyl', htmlText.includes('Motyl'));
    check('в HTML подключён app.js', htmlText.includes('/app.js'));

    const css = await fetch(BASE + '/style.css');
    equal('style.css отдаётся', css.status, 200);

    const traversal = await fetch(BASE + '/../package.json');
    check('path traversal закрыт', traversal.status === 404 || traversal.status === 403);

    const logout = await http('/api/logout', { method: 'POST', token: aliceToken });
    equal('logout', logout.status, 200);
    const afterLogout = await http('/api/me', { token: aliceToken });
    equal('токен после logout недействителен', afterLogout.status, 401);
  } finally {
    if (aliceWs) { try { aliceWs.close(1000); } catch (err) { /* ignore */ } }
    if (bobWs) { try { bobWs.close(1000); } catch (err) { /* ignore */ } }
    child.kill('SIGTERM');
    await delay(300);
    try { child.kill('SIGKILL'); } catch (err) { /* ignore */ }
    logStream.end();
    try { fs.unlinkSync(DATA); } catch (err) { /* ignore */ }
  }

  console.log('');
  if (failed) {
    console.log(`\x1b[31m${failed} проверок провалено\x1b[0m, ${passed} прошло.`);
    console.log(`\x1b[2mЛог сервера: ${LOG}\x1b[0m`);
    const log = fs.readFileSync(LOG, 'utf8').split('\n').slice(-25).join('\n');
    console.log(`\x1b[2m${log}\x1b[0m`);
    process.exit(1);
  }
  console.log(`\x1b[32mВсе ${passed} проверок прошли. Мотиль доволен 🦋\x1b[0m`);
  try { fs.unlinkSync(LOG); } catch (err) { /* ignore */ }
  process.exit(0);
}

main().catch((err) => {
  console.error('\x1b[31mТест упал:\x1b[0m', err);
  try { fs.unlinkSync(DATA); } catch (e) { /* ignore */ }
  process.exit(1);
});
