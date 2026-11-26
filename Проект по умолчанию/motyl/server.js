#!/usr/bin/env node
'use strict';

/**
 * Motyl — самостоятельный мессенджер в духе MSN / Windows Live Messenger.
 * Сервер: HTTP + REST + собственный WebSocket + админ-консоль в терминале.
 * Никаких внешних зависимостей — только стандартная библиотека Node.js.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const { Store } = require('./lib/store');
const ws = require('./lib/ws');

const NAME = 'Motyl';
const VERSION = require('./package.json').version;
const STARTED_AT = Date.now();
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_FILE = process.env.MOTYL_DATA || path.join(ROOT, 'data', 'db.json');
const PORT = Number(process.env.MOTYL_PORT || process.env.PORT || 1863);
const HOST = process.env.MOTYL_HOST || '0.0.0.0';
const DEMO = process.argv.includes('--demo');
const BOT_LOGIN = 'motyl';

const TTY = process.stdout.isTTY;
const color = (code) => (TTY ? `\x1b[${code}m` : '');
const C = {
  reset: color(0), bold: color(1), dim: color(2),
  blue: color('38;5;39'), cyan: color('38;5;45'), green: color('38;5;42'),
  yellow: color('38;5;220'), red: color('38;5;203'), magenta: color('38;5;177'),
  gray: color('38;5;245'),
};

const store = new Store(DATA_FILE);

// ── Служебный аккаунт ─────────────────────────────────────────────────────

let bot = store.findByLogin(BOT_LOGIN);
if (!bot) {
  bot = store.createUser({
    login: BOT_LOGIN,
    password: crypto.randomBytes(32).toString('hex'),
    displayName: 'Мотылёк',
    avatar: '🦋',
  });
  store.updateUser(bot.id, { statusText: 'Официальный аккаунт Motyl', system: true });
} else if (!bot.system) {
  store.updateUser(bot.id, { system: true });
}
const BOT_ID = bot.id;
store.updateUser(BOT_ID, { status: 'online', statusText: bot.statusText || 'Официальный аккаунт Motyl' });

// ── Логи ──────────────────────────────────────────────────────────────────

function timeString() {
  return new Date().toLocaleTimeString('ru-RU', { hour12: false });
}

function log(message) {
  process.stdout.write(`${C.dim}[${timeString()}]${C.reset} ${message}\n`);
}

function logError(err) {
  const text = err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : String(err);
  process.stdout.write(`${C.dim}[${timeString()}]${C.reset} ${C.red}✖ ${text}${C.reset}\n`);
}

// ── Онлайн-хаб ────────────────────────────────────────────────────────────

/** @type {Map<string, Set<ws.WSConnection>>} */
const sockets = new Map();

function isOnline(userId) {
  const set = sockets.get(userId);
  return !!set && set.size > 0;
}

function isSystem(user) {
  return !!(user && user.system);
}

function presenceOf(user) {
  if (!user) return 'offline';
  if (isSystem(user)) return 'online';
  if (!isOnline(user.id)) return 'offline';
  if (user.status === 'invisible') return 'offline';
  return user.status || 'online';
}

function publicUser(user) {
  return {
    id: user.id,
    login: user.login,
    displayName: user.displayName,
    avatar: user.avatar,
    status: presenceOf(user),
    statusText: user.statusText || '',
    lastSeen: user.lastSeen || 0,
    system: isSystem(user),
  };
}

function selfUser(user) {
  return {
    ...publicUser(user),
    status: user.status || 'online',
    presence: presenceOf(user),
  };
}

function sendTo(userId, payload) {
  const set = sockets.get(userId);
  if (!set || !set.size) return 0;
  const data = JSON.stringify(payload);
  let sent = 0;
  for (const conn of set) {
    if (conn.send(data)) sent++;
  }
  return sent;
}

function broadcastAll(payload) {
  for (const userId of sockets.keys()) sendTo(userId, payload);
}

function buildContacts(userId) {
  const result = [];
  for (const entry of store.contactsOf(userId)) {
    const user = store.getUser(entry.id);
    if (!user) continue;
    result.push({
      ...publicUser(user),
      group: entry.group || 'Друзья',
      since: entry.since || 0,
      unread: store.unreadCount(userId, user.id),
    });
  }
  result.sort((a, b) => {
    const offlineDiff = Number(a.status === 'offline') - Number(b.status === 'offline');
    if (offlineDiff) return offlineDiff;
    return a.displayName.localeCompare(b.displayName, 'ru');
  });
  return result;
}

function broadcastPresence(user) {
  const payload = { t: 'presence', user: publicUser(user) };
  for (const id of store.relatedTo(user.id)) sendTo(id, payload);
}

function serverInfo() {
  return {
    name: NAME,
    version: VERSION,
    online: sockets.size,
    users: store.allUsers().length,
    uptime: Math.floor((Date.now() - STARTED_AT) / 1000),
  };
}

// ── Доставка сообщений ────────────────────────────────────────────────────

function deliverMessage(from, to, text) {
  let addedForSender = false;
  let addedForRecipient = false;

  if (from.id !== BOT_ID && !store.hasContact(from.id, to.id)) {
    addedForSender = store.addContact(from.id, to.id, 'Друзья');
  }
  if (!store.hasContact(to.id, from.id)) {
    addedForRecipient = store.addContact(to.id, from.id, 'Друзья');
  }

  if (addedForSender) {
    sendTo(from.id, { t: 'contacts', contacts: buildContacts(from.id) });
  }
  if (addedForRecipient) {
    sendTo(to.id, { t: 'contacts', contacts: buildContacts(to.id) });
  }

  const message = store.addMessage({ from: from.id, to: to.id, text });
  sendTo(to.id, { t: 'msg', m: message, from: publicUser(from) });
  if (to.id === BOT_ID) scheduleBotReply(from, text);
  return message;
}

const BOT_TIPS = [
  'Совет: дважды щёлкните по контакту в списке слева — откроется окно беседы.',
  'Совет: кнопка ⚡ в шапке беседы отправляет nudge — окно собеседника вздрогнет.',
  'Совет: из терминала можно общаться так: node tui.js — попробуйте!',
  'Совет: статус «Невидимка» скрывает вас из списков, но вы остаётесь на связи.',
  'Совет: наберите в беседе :), (H), <3 или (F) — Motyl превратит это в смайлики.',
  'Совет: историю беседы можно посмотреть в терминале командой /history (в tui.js).',
  'Совет: добавьте второго собеседника по логину — и позовите его в Motyl.',
];

function botAnswer(text) {
  const t = String(text || '').toLowerCase();
  if (/(help|помощ|команд)/.test(t)) {
    return [
      'Что я умею как аккаунт-помощник:',
      '• подсказать, как пользоваться Motyl;',
      '• рассказать о статусах, смайликах и nudge;',
      '• показать время сервера командой /time.',
      'А ещё вы можете подключить терминальный клиент: node tui.js',
    ].join('\n');
  }
  if (/\/time|время/.test(t)) {
    return 'Сейчас на сервере: ' + new Date().toLocaleString('ru-RU');
  }
  if (/(привет|здрав|hi|hello)/.test(t)) {
    return 'Привет-привет! 🦋 Рад видеть. Чем помочь? Напишите /help, чтобы увидеть подсказки.';
  }
  if (/(nudge|подтолк|тряс)/.test(t)) {
    return 'Nudge — это «подтолкнуть» собеседника: окно чата трясётся, звучит сигнал. Не чаще одного раза в 12 секунд, чтобы не хулиганить. 😄';
  }
  if (/(смайл|emoticon|эмодзи)/.test(t)) {
    return 'Классика MSN жива: :) :D ;) :( :P (H) (A) (6) <3 (F) (C) (D) (Y) (N) (L) (U) (K) (T) (S) (Z) (X) (*). Попробуйте отправить их в чат.';
  }
  return BOT_TIPS[Math.floor(Math.random() * BOT_TIPS.length)];
}

function scheduleBotReply(user, text) {
  const answer = botAnswer(text);
  const delay = 700 + Math.floor(Math.random() * 800);
  const timer = setTimeout(() => {
    const botUser = store.getUser(BOT_ID);
    if (!botUser) return;
    const message = store.addMessage({ from: BOT_ID, to: user.id, text: answer });
    sendTo(user.id, { t: 'msg', m: message, from: publicUser(botUser) });
  }, delay);
  if (timer.unref) timer.unref();
}

function sendWelcome(user) {
  const text = [
    `Привет, ${user.displayName}! 🦋`,
    '',
    'Я — Мотылёк, официальный аккаунт Motyl. Добро пожаловать в сеть!',
    '',
    'Что дальше:',
    '1. Нажмите «＋ Добавить контакт» и введите логин друга.',
    '2. Щёлкните по контакту — откроется окно беседы.',
    '3. Меняйте статус слева: «В сети», «Нет на месте», «Не беспокоить», «Невидимка».',
    '',
    'Смайлики: :) :D ;) :( :P (H) <3 (F) (Y) — как в старые добрые времена.',
    'Nudge: кнопка ⚡ в шапке беседы.',
    'Терминальный клиент: node tui.js',
    '',
    'Напишите /help, если нужна подсказка.',
  ].join('\n');
  store.addContact(user.id, BOT_ID, 'Motyl');
  const message = store.addMessage({ from: BOT_ID, to: user.id, text });
  sendTo(user.id, { t: 'msg', m: message, from: publicUser(store.getUser(BOT_ID)) });
}

// ── Ограничитель частоты ──────────────────────────────────────────────────

const buckets = new Map();

function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now > bucket.reset) {
    bucket = { count: 0, reset: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count++;
  return bucket.count <= max;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now > bucket.reset) buckets.delete(key);
  }
}, 60 * 1000).unref();

// ── WebSocket-клиенты ─────────────────────────────────────────────────────

function attachClient(conn, user, req) {
  const set = sockets.get(user.id) || new Set();
  set.add(conn);
  sockets.set(user.id, set);

  store.updateUser(user.id, { lastSeen: Date.now() });

  conn.send(JSON.stringify({
    t: 'ready',
    user: selfUser(user),
    contacts: buildContacts(user.id),
    unread: store.unreadTotal(user.id),
    server: serverInfo(),
  }));

  broadcastPresence(user);
  log(`${C.green}●${C.reset} ${C.bold}${user.login}${C.reset} в сети ${C.gray}(${clientIp(req)})${C.reset}`);

  const heartbeat = setInterval(() => conn.ping(), 30000);
  if (heartbeat.unref) heartbeat.unref();

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    const current = sockets.get(user.id);
    if (current) {
      current.delete(conn);
      if (!current.size) {
        sockets.delete(user.id);
        const fresh = store.getUser(user.id);
        if (fresh) {
          store.updateUser(user.id, { lastSeen: Date.now() });
          broadcastPresence(fresh);
        }
        log(`${C.gray}○ ${user.login} ушёл в оффлайн${C.reset}`);
      }
    }
  };

  conn.on('close', cleanup);
  conn.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      sendError(conn, 'Некорректный формат сообщения');
      return;
    }
    if (!data || typeof data.t !== 'string') return;
    const freshUser = store.getUser(user.id) || user;
    try {
      handleWs(freshUser, data, conn);
    } catch (err) {
      logError(err);
      sendError(conn, 'Ошибка обработки сообщения');
    }
  });
}

function sendError(conn, message) {
  conn.send(JSON.stringify({ t: 'error', message }));
}

function handleWs(user, data, conn) {
  switch (data.t) {
    case 'msg': {
      if (!rateLimit('msg:' + user.id, 120, 10000)) {
        sendError(conn, 'Слишком много сообщений, чуть помедленнее');
        return;
      }
      const target = resolveUser(data.to);
      if (!target) return sendError(conn, 'Пользователь не найден');
      if (target.id === user.id) return sendError(conn, 'Нельзя отправить сообщение самому себе');
      const text = cleanText(data.text);
      if (!text) return;
      const message = deliverMessage(user, target, text);
      conn.send(JSON.stringify({ t: 'sent', m: message, cid: data.cid || null }));
      return;
    }

    case 'typing': {
      const target = resolveUser(data.to);
      if (!target) return;
      if (!rateLimit('typing:' + user.id + ':' + target.id, 1, 1500)) return;
      sendTo(target.id, { t: 'typing', from: user.id });
      return;
    }

    case 'nudge': {
      const target = resolveUser(data.to);
      if (!target) return sendError(conn, 'Пользователь не найден');
      if (!rateLimit('nudge:' + user.id, 1, 12000)) {
        sendError(conn, 'Nudge можно отправлять не чаще раза в 12 секунд');
        return;
      }
      sendTo(target.id, { t: 'nudge', from: publicUser(user) });
      log(`${C.yellow}⚡${C.reset} ${user.login} → ${target.login}: nudge`);
      return;
    }

    case 'read': {
      const partner = resolveUser(data.with);
      if (!partner) return;
      const at = Date.now();
      const count = store.markRead(user.id, partner.id, at);
      if (count) sendTo(partner.id, { t: 'read', by: user.id, at, count });
      return;
    }

    case 'status': {
      const allowed = ['online', 'away', 'busy', 'invisible'];
      const status = allowed.includes(data.status) ? data.status : user.status;
      const statusText = typeof data.statusText === 'string'
        ? data.statusText.replace(/[\u0000-\u001f]/g, '').slice(0, 80)
        : user.statusText;
      const fresh = store.updateUser(user.id, { status, statusText });
      broadcastPresence(fresh);
      conn.send(JSON.stringify({ t: 'me', user: selfUser(fresh) }));
      return;
    }

    default:
      sendError(conn, 'Неизвестная команда: ' + data.t);
  }
}

function resolveUser(value) {
  if (!value) return null;
  const key = String(value);
  return store.getUser(key) || store.findByLogin(key);
}

function cleanText(value) {
  let text = String(value == null ? '' : value).replace(/\u0000/g, '').replace(/\s+$/, '');
  if (!text.trim()) return '';
  if (text.length > 4000) text = text.slice(0, 4000);
  return text;
}

// ── HTTP-утилиты ──────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function json(res, status, payload, extra = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(body);
}

function fail(res, status, message) {
  json(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        const err = new Error('Слишком большой запрос');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        const e = new Error('Некорректный JSON в теле запроса');
        e.status = 400;
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function tokenFrom(req, url) {
  const header = req.headers.authorization || '';
  if (String(header).toLowerCase().startsWith('bearer ')) return String(header).slice(7).trim();
  return req.headers['x-motyl-token'] || url.searchParams.get('token') || '';
}

function requireUser(req, res, url) {
  const token = tokenFrom(req, url);
  const session = token && store.getSession(token);
  if (!session) {
    fail(res, 401, 'Требуется авторизация');
    return null;
  }
  const user = store.getUser(session.userId);
  if (!user) {
    store.deleteSession(token);
    fail(res, 401, 'Сессия недействительна, войдите снова');
    return null;
  }
  if (isSystem(user)) {
    fail(res, 403, 'Системный аккаунт не может входить');
    return null;
  }
  return { user, token };
}

function sanitizeDisplayName(value, fallback) {
  const name = String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, '').trim();
  return (name || fallback || 'Без имени').slice(0, 32);
}

function sanitizeAvatar(value) {
  const avatar = String(value == null ? '' : value).trim();
  if (!avatar) return '🦋';
  return Array.from(avatar).slice(0, 4).join('');
}

// ── REST API ──────────────────────────────────────────────────────────────

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const method = req.method || 'GET';

  if (pathname === '/api/health' && method === 'GET') {
    return json(res, 200, { ok: true, ...serverInfo() });
  }

  if (pathname === '/api/register' && method === 'POST') {
    if (!rateLimit('register:' + clientIp(req), 20, 60000)) {
      return fail(res, 429, 'Слишком много попыток регистрации. Подождите минуту.');
    }
    const body = await readBody(req);
    const login = String(body.login || '').trim();
    const password = String(body.password || '');
    const displayName = sanitizeDisplayName(body.displayName, login);

    if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(login)) {
      return fail(res, 400, 'Логин: 3–20 символов, латиница, цифры, точка, дефис или подчёркивание');
    }
    if (login.toLowerCase() === BOT_LOGIN) {
      return fail(res, 400, 'Этот логин зарезервирован');
    }
    if (password.length < 4 || password.length > 100) {
      return fail(res, 400, 'Пароль: от 4 до 100 символов');
    }
    if (store.findByLogin(login)) {
      return fail(res, 409, 'Такой логин уже занят');
    }

    const user = store.createUser({ login, password, displayName });
    const token = store.createSession(user.id);
    sendWelcome(user);
    log(`${C.green}✦${C.reset} новый пользователь ${C.bold}${login}${C.reset}`);
    return json(res, 201, { token, user: selfUser(user), unread: store.unreadTotal(user.id) });
  }

  if (pathname === '/api/login' && method === 'POST') {
    if (!rateLimit('login:' + clientIp(req), 40, 60000)) {
      return fail(res, 429, 'Слишком много попыток входа. Подождите минуту.');
    }
    const body = await readBody(req);
    const user = store.findByLogin(body.login);
    if (!user || isSystem(user) || !store.verifyPassword(user, String(body.password || ''))) {
      return fail(res, 401, 'Неверный логин или пароль');
    }
    const token = store.createSession(user.id);
    log(`${C.green}→${C.reset} ${C.bold}${user.login}${C.reset} авторизовался`);
    return json(res, 200, { token, user: selfUser(user), unread: store.unreadTotal(user.id) });
  }

  const auth = requireUser(req, res, url);
  if (!auth) return;
  const { user } = auth;

  if (pathname === '/api/logout' && method === 'POST') {
    store.deleteSession(auth.token);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/me') {
    if (method === 'GET') {
      return json(res, 200, {
        user: selfUser(user),
        unread: store.unreadTotal(user.id),
        server: serverInfo(),
      });
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      const patch = {};
      if (body.displayName !== undefined) patch.displayName = sanitizeDisplayName(body.displayName, user.login);
      if (body.avatar !== undefined) patch.avatar = sanitizeAvatar(body.avatar);
      if (body.statusText !== undefined) {
        patch.statusText = String(body.statusText).replace(/[\u0000-\u001f]/g, '').slice(0, 80);
      }
      if (['online', 'away', 'busy', 'invisible'].includes(body.status)) patch.status = body.status;
      const updated = store.updateUser(user.id, patch);
      broadcastPresence(updated);
      return json(res, 200, { user: selfUser(updated) });
    }
    return fail(res, 405, 'Метод не поддерживается');
  }

  if (pathname === '/api/contacts' && method === 'GET') {
    return json(res, 200, { contacts: buildContacts(user.id) });
  }

  if (pathname === '/api/contacts' && method === 'POST') {
    const body = await readBody(req);
    const target = resolveUser(body.login || body.id);
    if (!target) return fail(res, 404, 'Пользователь с таким логином не найден');
    if (target.id === user.id) return fail(res, 400, 'Себя добавлять не нужно — вы уже здесь 😉');
    const group = String(body.group || 'Друзья').slice(0, 32) || 'Друзья';
    const added = store.addContact(user.id, target.id, group);
    if (added) {
      sendTo(target.id, { t: 'contacts', contacts: buildContacts(target.id) });
    }
    return json(res, added ? 201 : 200, {
      added,
      contact: { ...publicUser(target), group, unread: store.unreadCount(user.id, target.id) },
      contacts: buildContacts(user.id),
    });
  }

  const contactMatch = pathname.match(/^\/api\/contacts\/([^/]+)$/);
  if (contactMatch) {
    const otherId = decodeURIComponent(contactMatch[1]);
    if (method === 'DELETE') {
      const removed = store.removeContact(user.id, otherId);
      return json(res, 200, { removed, contacts: buildContacts(user.id) });
    }
    return fail(res, 405, 'Метод не поддерживается');
  }

  const groupMatch = pathname.match(/^\/api\/contacts\/([^/]+)\/group$/);
  if (groupMatch && method === 'POST') {
    const otherId = decodeURIComponent(groupMatch[1]);
    const body = await readBody(req);
    const ok = store.setContactGroup(user.id, otherId, body.group);
    return json(res, ok ? 200 : 404, { ok, contacts: buildContacts(user.id) });
  }

  if (pathname === '/api/search' && method === 'GET') {
    const query = String(url.searchParams.get('q') || '').trim().toLowerCase();
    if (!query) return json(res, 200, { users: [] });
    const users = store.allUsers()
      .filter((u) => u.id !== user.id && !isSystem(u))
      .filter((u) => u.loginLower.includes(query) || u.displayName.toLowerCase().includes(query))
      .slice(0, 12)
      .map((u) => ({ ...publicUser(u), isContact: store.hasContact(user.id, u.id) }));
    return json(res, 200, { users });
  }

  if (pathname === '/api/history' && method === 'GET') {
    const partner = resolveUser(url.searchParams.get('with'));
    if (!partner) return fail(res, 404, 'Собеседник не найден');
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 80, 1), 200);
    const before = parseInt(url.searchParams.get('before'), 10) || 0;
    const messages = store.history(user.id, partner.id, { limit, before });
    return json(res, 200, {
      messages,
      contact: {
        ...publicUser(partner),
        group: (store.contactsOf(user.id).find((c) => c.id === partner.id) || {}).group || 'Друзья',
        unread: store.unreadCount(user.id, partner.id),
      },
      hasMore: messages.length === limit,
    });
  }

  if (pathname === '/api/messages' && method === 'POST') {
    if (!rateLimit('rest-msg:' + user.id, 60, 10000)) {
      return fail(res, 429, 'Слишком много сообщений, чуть помедленнее');
    }
    const body = await readBody(req);
    const target = resolveUser(body.to);
    if (!target) return fail(res, 404, 'Пользователь не найден');
    if (target.id === user.id) return fail(res, 400, 'Нельзя писать самому себе');
    const text = cleanText(body.text);
    if (!text) return fail(res, 400, 'Пустое сообщение');
    const message = deliverMessage(user, target, text);
    return json(res, 201, { message, cid: body.cid || null });
  }

  if (pathname === '/api/read' && method === 'POST') {
    const body = await readBody(req);
    const partner = resolveUser(body.with);
    if (!partner) return fail(res, 404, 'Собеседник не найден');
    const at = Date.now();
    const count = store.markRead(user.id, partner.id, at);
    if (count) sendTo(partner.id, { t: 'read', by: user.id, at, count });
    return json(res, 200, { count });
  }

  if (pathname === '/api/stats' && method === 'GET') {
    return json(res, 200, {
      ...serverInfo(),
      messages: store.messageCount(),
      onlineUsers: Array.from(sockets.keys())
        .map((id) => store.getUser(id))
        .filter(Boolean)
        .map((u) => publicUser(u)),
    });
  }

  return fail(res, 404, 'Неизвестный метод API');
}

// ── Статика ───────────────────────────────────────────────────────────────

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return fail(res, 405, 'Метод не поддерживается');
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (err) {
    return fail(res, 400, 'Некорректный путь');
  }
  if (pathname === '/') pathname = '/index.html';

  const filePath = path.resolve(PUBLIC_DIR, '.' + pathname);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return fail(res, 403, 'Доступ запрещён');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      return fail(res, 404, 'Страница не найдена');
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.end());
    stream.pipe(res);
  });
}

// ── Демо-данные ───────────────────────────────────────────────────────────

function seedDemo() {
  if (store.allUsers().length > 1) return;
  const alice = store.createUser({ login: 'alice', password: 'motyl123', displayName: 'Алиса', avatar: '🦄' });
  const bob = store.createUser({ login: 'bob', password: 'motyl123', displayName: 'Боб', avatar: '🐼' });
  const carol = store.createUser({ login: 'carol', password: 'motyl123', displayName: 'Кэрол', avatar: '🦊' });

  store.updateUser(alice.id, { statusText: 'Пью кофе и жду сообщений' });
  store.updateUser(bob.id, { statusText: 'На связи' });
  store.updateUser(carol.id, { statusText: 'Оффлайн, но отвечу' });
  store.updateUser(carol.id, { status: 'away' });

  store.addContact(alice.id, bob.id, 'Друзья');
  store.addContact(bob.id, alice.id, 'Друзья');
  store.addContact(alice.id, carol.id, 'Работа');
  store.addContact(bob.id, carol.id, 'Семья');
  store.addContact(alice.id, BOT_ID, 'Motyl');
  store.addContact(bob.id, BOT_ID, 'Motyl');

  const chat = [
    [bob.id, alice.id, 'Привет! Ты уже видела Motyl?'],
    [alice.id, bob.id, 'Да, это же почти MSN, только наш :)'],
    [bob.id, alice.id, 'Кнопка nudge уже протестирована? 😈'],
    [alice.id, bob.id, 'Не смей! У меня окно трясётся как в 2007-м (H)'],
  ];
  for (const [from, to, text] of chat) store.addMessage({ from, to, text });

  log(`${C.yellow}Демо-режим:${C.reset} созданы alice / bob / carol, пароль ${C.bold}motyl123${C.reset}`);
}

if (DEMO) seedDemo();

// ── Сервер ────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch (err) {
    return fail(res, 400, 'Некорректный URL');
  }
  res.setHeader('X-Powered-By', `${NAME}/${VERSION}`);

  const route = url.pathname.startsWith('/api/') ? handleApi(req, res, url) : Promise.resolve(serveStatic(req, res, url));
  Promise.resolve(route).catch((err) => {
    if (err && err.status) {
      if (!res.headersSent) fail(res, err.status, err.message);
      return;
    }
    logError(err);
    if (!res.headersSent) fail(res, 500, 'Внутренняя ошибка сервера');
    else res.end();
  });
});

ws.handleUpgrade(server, (conn, req) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (err) {
    conn.close(1008);
    return;
  }
  if (url.pathname !== '/ws') {
    conn.close(1008);
    return;
  }
  const session = store.getSession(url.searchParams.get('token') || '');
  if (!session) {
    conn.close(1008);
    return;
  }
  const user = store.getUser(session.userId);
  if (!user || isSystem(user)) {
    conn.close(1008);
    return;
  }
  attachClient(conn, user, req);
});

function lanAddresses() {
  const result = [];
  const interfaces = os.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) result.push(item.address);
    }
  }
  return result;
}

server.listen(PORT, HOST, () => {
  console.log('');
  console.log(`${C.blue}${C.bold}  ╭─────────────────────────────────────────╮${C.reset}`);
  console.log(`${C.blue}${C.bold}  │${C.reset}  ${C.magenta}${C.bold}Motyl${C.reset} ${C.dim}v${VERSION}${C.reset} — крылья для сообщений   ${C.blue}${C.bold}│${C.reset}`);
  console.log(`${C.blue}${C.bold}  ╰─────────────────────────────────────────╯${C.reset}`);
  console.log('');
  console.log(`  ${C.bold}Локально:${C.reset}  ${C.cyan}http://localhost:${PORT}${C.reset}`);
  for (const ip of lanAddresses()) {
    console.log(`  ${C.bold}В сети:${C.reset}    ${C.cyan}http://${ip}:${PORT}${C.reset}`);
  }
  console.log(`  ${C.bold}Данные:${C.reset}    ${C.gray}${DATA_FILE}${C.reset}`);
  console.log(`  ${C.bold}Клиенты:${C.reset}   браузер ${C.gray}·${C.reset} терминал: ${C.cyan}node tui.js${C.reset}`);
  console.log(`  ${C.dim}Админ-консоль ниже. Введите help для списка команд.${C.reset}`);
  console.log('');
  log(`${C.green}Сервер запущен${C.reset} на ${HOST}:${PORT}`);
  startConsole();
});

// ── Админ-консоль ─────────────────────────────────────────────────────────

function printConsoleHelp() {
  console.log([
    '',
    `  ${C.bold}Команды сервера${C.reset}`,
    `  ${C.cyan}help${C.reset}                 — эта справка`,
    `  ${C.cyan}stats${C.reset}                — статистика сервера`,
    `  ${C.cyan}users${C.reset}                — список пользователей`,
    `  ${C.cyan}online${C.reset}               — кто сейчас в сети`,
    `  ${C.cyan}broadcast <текст>${C.reset}    — системное уведомление всем`,
    `  ${C.cyan}kick <логин>${C.reset}         — отключить пользователя`,
    `  ${C.cyan}say <от> <кому> <текст>${C.reset} — отправить сообщение от имени бота`,
    `  ${C.cyan}save${C.reset}                 — принудительно сохранить базу`,
    `  ${C.cyan}stop${C.reset}                 — остановить сервер`,
    '',
  ].join('\n'));
}

function startConsole() {
  if (!process.stdin.isTTY) return;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.blue}motyl>${C.reset} `,
  });

  rl.prompt();
  rl.on('line', (line) => {
    const trimmed = line.trim();
    const [command, ...rest] = trimmed.split(/\s+/);
    const args = rest.join(' ');
    try {
      switch ((command || '').toLowerCase()) {
        case '':
          break;
        case 'help':
          printConsoleHelp();
          break;
        case 'stats': {
          const info = serverInfo();
          console.log(`  пользователей: ${C.bold}${store.allUsers().length}${C.reset}, онлайн: ${C.bold}${sockets.size}${C.reset}, сообщений: ${C.bold}${store.messageCount()}${C.reset}`);
          console.log(`  аптайм: ${info.uptime} c, версия: ${VERSION}, данные: ${DATA_FILE}`);
          break;
        }
        case 'users': {
          const users = store.allUsers().sort((a, b) => a.login.localeCompare(b.login));
          console.log(`  ${users.length} аккаунтов:`);
          for (const u of users) {
            const mark = presenceOf(u) === 'offline' ? C.gray + '○' : C.green + '●';
            console.log(`   ${mark}${C.reset} ${u.login.padEnd(16)} ${C.gray}${u.displayName}${C.reset} ${C.dim}${presenceOf(u)}${C.reset}`);
          }
          break;
        }
        case 'online': {
          if (!sockets.size) {
            console.log(`  ${C.gray}никого нет в сети${C.reset}`);
            break;
          }
          for (const [id, set] of sockets) {
            const u = store.getUser(id);
            if (u) console.log(`   ${C.green}●${C.reset} ${u.login} ${C.gray}(${set.size} соед.)${C.reset}`);
          }
          break;
        }
        case 'broadcast': {
          if (!args) {
            console.log(`  ${C.yellow}Укажите текст: broadcast <текст>${C.reset}`);
            break;
          }
          broadcastAll({ t: 'system', text: args.slice(0, 500), ts: Date.now() });
          log(`📢 broadcast: ${args}`);
          break;
        }
        case 'kick': {
          const user = store.findByLogin(args);
          if (!user) {
            console.log(`  ${C.red}Пользователь не найден${C.reset}`);
            break;
          }
          const set = sockets.get(user.id);
          if (set) for (const conn of set) conn.close(4001);
          log(`⏏ kick: ${user.login}`);
          break;
        }
        case 'say': {
          const parts = args.split(/\s+/);
          const fromLogin = parts.shift();
          const toLogin = parts.shift();
          const text = parts.join(' ');
          const from = store.findByLogin(fromLogin);
          const to = store.findByLogin(toLogin);
          if (!from || !to || !text) {
            console.log(`  ${C.yellow}Формат: say <от> <кому> <текст>${C.reset}`);
            break;
          }
          const message = store.addMessage({ from: from.id, to: to.id, text });
          sendTo(to.id, { t: 'msg', m: message, from: publicUser(from) });
          log(`✉ say: ${from.login} → ${to.login}`);
          break;
        }
        case 'save':
          store.flush();
          console.log(`  ${C.green}Сохранено${C.reset}`);
          break;
        case 'stop':
        case 'quit':
        case 'exit':
          shutdown(0);
          return;
        default:
          console.log(`  ${C.gray}Неизвестная команда. help — список команд.${C.reset}`);
      }
    } catch (err) {
      logError(err);
    }
    rl.prompt();
  });

  rl.on('close', () => shutdown(0));
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${C.gray}Motyl останавливается…${C.reset}`);
  for (const set of sockets.values()) {
    for (const conn of set) {
      try { conn.close(1001); } catch (err) { /* ignore */ }
    }
  }
  store.flush();
  server.close(() => process.exit(code));
  const timer = setTimeout(() => process.exit(code), 1500);
  if (timer.unref) timer.unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('unhandledRejection', (err) => logError(err));
process.on('uncaughtException', (err) => logError(err));
