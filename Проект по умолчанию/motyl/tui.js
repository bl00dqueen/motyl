#!/usr/bin/env node
'use strict';

/**
 * Motyl TUI — терминальный клиент.
 * Тот же аккаунт и сервер, что и в браузере. Только консоль, ANSI и ностальгия.
 *
 *   node tui.js
 *   node tui.js --server http://192.168.1.10:1863 --login alice
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { connect } = require('./lib/ws');

const CONFIG_FILE = path.join(os.homedir(), '.motyl.json');
const VERSION = '1.0.0';

// ── ANSI ──────────────────────────────────────────────────────────────────

const tty = process.stdout.isTTY;
const ansi = (code) => (tty ? `\x1b[${code}m` : '');
const c = {
  reset: ansi(0), bold: ansi(1), dim: ansi(2), italic: ansi(3),
  red: ansi('38;5;203'), green: ansi('38;5;42'), yellow: ansi('38;5;220'),
  blue: ansi('38;5;39'), cyan: ansi('38;5;45'), magenta: ansi('38;5;177'),
  gray: ansi('38;5;245'), white: ansi('97'),
};

function colorFor(login) {
  const palette = [39, 45, 42, 220, 203, 177, 51, 118, 213, 208];
  let hash = 0;
  for (const char of String(login)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return ansi('38;5;' + palette[hash % palette.length]);
}

// ── Аргументы ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--register') result.register = true;
    else if (arg === '--server') result.server = argv[++i];
    else if (arg === '--login' || arg === '-u') result.login = argv[++i];
    else if (arg === '--password' || arg === '-p') result.password = argv[++i];
    else if (arg === '--token') result.token = argv[++i];
    else result._.push(arg);
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));

function usage() {
  console.log(`
${c.blue}Motyl TUI${c.reset} ${c.gray}v${VERSION}${c.reset} — мессенджер в терминале

${c.bold}Использование${c.reset}
  node tui.js [опции]

${c.bold}Опции${c.reset}
  --server <url>     адрес сервера (по умолчанию http://localhost:1863)
  --login <логин>    логин
  --password <пароль> пароль (если не указан — спросим)
  --register         зарегистрировать новый аккаунт
  --token <токен>    готовый токен сессии
  -h, --help         эта справка

${c.bold}Внутри${c.reset}
  /help              команды
  /chat <логин>      открыть беседу
  /list              список контактов
  /nudge             встряхнуть собеседника
  /quit              выход
`);
}

if (args.help) {
  usage();
  process.exit(0);
}

// ── Конфиг ────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    return {};
  }
}

function saveConfig(patch) {
  const current = loadConfig();
  const next = { ...current, ...patch };
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch (err) { /* ignore */ }
}

const config = loadConfig();
const serverUrl = String(
  args.server || process.env.MOTYL_SERVER || config.server || 'http://localhost:1863',
).replace(/\/+$/, '');

let token = args.token || process.env.MOTYL_TOKEN || config.token || '';

// ── HTTP ──────────────────────────────────────────────────────────────────

async function api(pathname, options = {}) {
  const headers = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;

  const response = await fetch(serverUrl + pathname, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  let data = {};
  try {
    data = await response.json();
  } catch (err) { /* ignore */ }
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

// ── Ввод ──────────────────────────────────────────────────────────────────

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const iface = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    if (hidden) {
      process.stdout.write(question);
      iface._writeToOutput = (text) => {
        if (text.includes('\n') || text.includes('\r')) iface.output.write('\n');
      };
      iface.question('', (answer) => {
        iface.close();
        resolve(String(answer));
      });
    } else {
      iface.question(question, (answer) => {
        iface.close();
        resolve(String(answer));
      });
    }
  });
}

// ── Состояние ─────────────────────────────────────────────────────────────

const state = {
  me: null,
  contacts: [],
  chats: new Map(),
  active: null,
  ws: null,
  ready: false,
  quitting: false,
  reconnectAttempts: 0,
  reconnectTimer: null,
  lateMessages: [],
  lastTypingNotice: 0,
};

let rl = null;
let promptText = 'motyl> ';
let promptVisible = false;

function setPrompt(text) {
  promptText = text;
  if (rl) rl.setPrompt(text);
}

function updatePrompt() {
  if (!state.me) {
    setPrompt('motyl> ');
    return;
  }
  const active = state.active ? state.chats.get(state.active) : null;
  const unread = Array.from(state.chats.values()).reduce((sum, chat) => sum + chat.unread, 0);
  const parts = [state.me.login];
  if (active) parts.push('→ ' + active.login);
  const prefix = parts.join(' ');
  setPrompt(`${prefix}${unread ? ` (${unread})` : ''} > `);
  updateTitle();
}

function updateTitle() {
  if (!tty) return;
  const unread = Array.from(state.chats.values()).reduce((sum, chat) => sum + chat.unread, 0);
  const title = unread ? `(${unread}) Motyl — @${state.me ? state.me.login : '?'}` : `Motyl — @${state.me ? state.me.login : '?'}`;
  process.stdout.write(`\x1b]0;${title}\x07`);
}

/** Убирает строку ввода, чтобы напечатать блок текста над ней. */
function beforeOutput() {
  if (rl && promptVisible) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    promptVisible = false;
  }
}

function afterOutput() {
  if (rl) {
    rl.prompt(true);
    promptVisible = true;
  }
}

/** Печатает строку текста над текущей строкой ввода, не ломая prompt. */
function printAbove(text = '') {
  beforeOutput();
  console.log(text);
  afterOutput();
}

function bell() {
  if (tty) process.stdout.write('\x07');
}

// ── Эмодзи ────────────────────────────────────────────────────────────────

const EMOTICONS = [
  [':)', '😊'], [':D', '😃'], [';)', '😉'], [':(', '☹️'], [':P', '😛'],
  [':$', '😳'], [':O', '😮'], ['(H)', '😎'], ['(A)', '😇'], ['(6)', '😈'],
  ['<3', '❤️'], ['(F)', '🌹'], ['(C)', '☕'], ['(D)', '🍺'], ['(Y)', '👍'],
  ['(N)', '👎'], ['(L)', '💔'], ['(U)', '💔'], ['(K)', '😘'], ['(T)', '😢'],
  ['(S)', '🌙'], ['(Z)', '😴'], ['(X)', '🙅'], ['(*)', '⭐'], ['(8)', '🎵'],
  ['(G)', '🎁'], ['(P)', '📷'], ['(M)', '💬'],
];

const EMOJI_MAP = new Map(EMOTICONS.map(([code, emoji]) => [code.toLowerCase(), emoji]));
const EMOJI_RE = new RegExp(
  EMOTICONS.map(([code]) => code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length)
    .join('|'),
  'gi',
);

function emojify(text) {
  return String(text).replace(EMOJI_RE, (match) => EMOJI_MAP.get(match.toLowerCase()) || match);
}

// ── Утилиты формата ───────────────────────────────────────────────────────

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function presenceDot(status) {
  if (status === 'online') return `${c.green}●${c.reset}`;
  if (status === 'away') return `${c.yellow}◐${c.reset}`;
  if (status === 'busy') return `${c.red}●${c.reset}`;
  return `${c.gray}○${c.reset}`;
}

function statusLabel(status) {
  return {
    online: 'в сети',
    away: 'нет на месте',
    busy: 'не беспокоить',
    invisible: 'невидимка',
    offline: 'не в сети',
  }[status] || status;
}

function contactByLogin(login) {
  const needle = String(login || '').replace(/^@/, '').trim().toLowerCase();
  return state.contacts.find((contact) => contact.login.toLowerCase() === needle)
    || state.contacts.find((contact) => contact.displayName.toLowerCase() === needle)
    || null;
}

function ensureChat(contact) {
  let chat = state.chats.get(contact.id);
  if (!chat) {
    chat = {
      id: contact.id,
      login: contact.login,
      displayName: contact.displayName,
      avatar: contact.avatar,
      status: contact.status,
      statusText: contact.statusText || '',
      messages: [],
      unread: contact.unread || 0,
      loaded: false,
    };
    state.chats.set(chat.id, chat);
  } else {
    Object.assign(chat, {
      login: contact.login,
      displayName: contact.displayName,
      avatar: contact.avatar,
      status: contact.status,
      statusText: contact.statusText || '',
    });
  }
  return chat;
}

function ensureChatByLogin(login) {
  const contact = contactByLogin(login);
  if (contact) return ensureChat(contact);
  // возможно, человек ещё не в контактах — создадим «эфемерную» беседу по логину
  return {
    id: null,
    login: String(login).replace(/^@/, '').trim(),
    displayName: String(login).replace(/^@/, '').trim(),
    avatar: '💬',
    status: 'offline',
    messages: [],
    unread: 0,
    loaded: true,
  };
}

// ── Отрисовка ─────────────────────────────────────────────────────────────

function printBanner() {
  console.log('');
  console.log(`${c.blue}${c.bold}  Motyl${c.reset} ${c.gray}v${VERSION}${c.reset} ${c.dim}— крылья для сообщений${c.reset}`);
  console.log(`${c.gray}  сервер: ${serverUrl}${c.reset}`);
  console.log('');
}

function printContacts() {
  if (!state.contacts.length) {
    console.log(`${c.gray}  Контактов пока нет. Добавьте: /add <логин>${c.reset}`);
    return;
  }
  const online = state.contacts.filter((contact) => contact.status !== 'offline').length;
  console.log(`${c.bold}  Контакты${c.reset} ${c.gray}(${state.contacts.length}, в сети ${online})${c.reset}`);
  for (const contact of state.contacts) {
    const unread = contact.unread ? ` ${c.red}[${contact.unread}]${c.reset}` : '';
    const text = contact.statusText ? `${c.gray} — ${contact.statusText}${c.reset}` : '';
    const mark = state.active === contact.id ? `${c.cyan}▶${c.reset} ` : '  ';
    console.log(`  ${mark}${presenceDot(contact.status)} ${colorFor(contact.login)}${contact.login.padEnd(14)}${c.reset} ${contact.displayName}${text}${unread}`);
  }
  console.log('');
}

function printHistory(chat, messages) {
  console.log(`${c.gray}  ── история: @${chat.login} ──${c.reset}`);
  if (!messages.length) {
    console.log(`${c.gray}  пока пусто${c.reset}`);
  }
  for (const message of messages) {
    printMessageLine(message, chat);
  }
}

function messageLine(message, chat) {
  if (message.system) {
    return `${c.gray}  · ${message.text}${c.reset}`;
  }
  const mine = state.me && message.from === state.me.id;
  const time = `${c.gray}${fmtTime(message.ts)}${c.reset}`;
  if (mine) {
    return `${time} ${c.blue}${c.bold}вы${c.reset} ${c.white}${emojify(message.text)}${c.reset}`;
  }
  const color = colorFor(chat.login);
  return `${time} ${color}${c.bold}${chat.login}${c.reset} ${emojify(message.text)}`;
}

function printMessageLine(message, chat) {
  console.log(messageLine(message, chat));
}

function printHelp() {
  console.log(`
${c.bold}  Команды${c.reset}
  ${c.cyan}/chat <логин>${c.reset}         открыть беседу и загрузить историю
  ${c.cyan}/list${c.reset}                  список контактов
  ${c.cyan}/add <логин>${c.reset}           добавить контакт
  ${c.cyan}/remove <логин>${c.reset}        удалить контакт
  ${c.cyan}/msg <логин> <текст>${c.reset}   отправить без открытия беседы
  ${c.cyan}/nudge${c.reset}                 встряхнуть собеседника ⚡
  ${c.cyan}/status <статус> [текст]${c.reset}  online | away | busy | invisible
  ${c.cyan}/me <текст>${c.reset}            статусное сообщение
  ${c.cyan}/history [логин]${c.reset}       история беседы
  ${c.cyan}/who${c.reset}                   кто сейчас онлайн
  ${c.cyan}/clear${c.reset}                 очистить экран
  ${c.cyan}/quit${c.reset}                  выйти

  Просто введите текст — он уйдёт в открытую беседу.
  Смайлики: :) :D ;) :( :P (H) <3 (F) (Y) и другие.
`);
}

// ── Авторизация ───────────────────────────────────────────────────────────

async function ensureAuth() {
  if (token) {
    try {
      const data = await api('/api/me');
      state.me = data.user;
      return;
    } catch (err) {
      if (err.status !== 401) throw err;
      token = '';
    }
  }

  printBanner();
  console.log(`${c.gray}  Нужно войти. Данные хранятся только на этом сервере.${c.reset}\n`);

  let login = args.login;
  let password = args.password;
  if (!login) login = (await ask(`  ${c.bold}Логин:${c.reset} `)).trim();
  if (!password) password = await ask(`  ${c.bold}Пароль:${c.reset} `, { hidden: true });

  if (!login || !password) {
    console.log(`${c.red}  Логин и пароль обязательны.${c.reset}`);
    process.exit(1);
  }

  try {
    const data = args.register
      ? await api('/api/register', { method: 'POST', body: { login, password } })
      : await api('/api/login', { method: 'POST', body: { login, password } });
    token = data.token;
    state.me = data.user;
    saveConfig({ server: serverUrl, token, login: data.user.login });
    console.log(`\n  ${c.green}Добро пожаловать, ${data.user.displayName}!${c.reset}\n`);
  } catch (err) {
    console.log(`  ${c.red}${err.message}${c.reset}`);
    process.exit(1);
  }
}

// ── Подключение ───────────────────────────────────────────────────────────

function wsUrl() {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '?token=' + encodeURIComponent(token);
  return url.toString();
}

async function startClient() {
  printBanner();
  let socket;
  try {
    socket = await connect(wsUrl());
  } catch (err) {
    console.log(`${c.red}  Не удалось подключиться к ${serverUrl}: ${err.message}${c.reset}`);
    process.exit(1);
  }

  state.ws = socket;
  socket.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      return;
    }
    handleEvent(data);
  });
  socket.on('close', () => {
    state.ready = false;
    if (state.quitting) return;
    scheduleReconnect();
  });

  createInterface();
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  state.reconnectAttempts++;
  if (state.reconnectAttempts > 5) {
    printAbove(`${c.red}Соединение потеряно. Сервер недоступен.${c.reset}`);
    setTimeout(() => process.exit(1), 300);
    return;
  }
  const delay = Math.min(1000 * state.reconnectAttempts, 6000);
  printAbove(`${c.yellow}Связь потеряна, переподключаюсь (${state.reconnectAttempts}/5)…${c.reset}`);
  state.reconnectTimer = setTimeout(async () => {
    state.reconnectTimer = null;
    try {
      const socket = await connect(wsUrl());
      state.ws = socket;
      state.reconnectAttempts = 0;
      socket.on('message', (raw) => {
        try { handleEvent(JSON.parse(raw)); } catch (err) { /* ignore */ }
      });
      socket.on('close', () => {
        state.ready = false;
        if (!state.quitting) scheduleReconnect();
      });
      printAbove(`${c.green}На связи снова.${c.reset}`);
      updatePrompt();
      rl.prompt(true);
    } catch (err) {
      scheduleReconnect();
    }
  }, delay);
}

function createInterface() {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: promptText,
    historySize: 200,
  });

  rl.on('line', async (line) => {
    promptVisible = false;
    const text = line.trim();
    if (!text) {
      updatePrompt();
      rl.prompt();
      promptVisible = true;
      return;
    }
    try {
      if (text.startsWith('/')) await handleCommand(text);
      else await handlePlain(text);
    } catch (err) {
      console.log(`  ${c.red}${err.message}${c.reset}`);
    }
    updatePrompt();
    rl.prompt();
    promptVisible = true;
  });

  rl.on('SIGINT', () => {
    if (state.active) {
      state.active = null;
      updatePrompt();
      printAbove(`${c.gray}беседа закрыта (Ctrl+C ещё раз — выход)${c.reset}`);
      rl.prompt();
      return;
    }
    quit();
  });

  rl.on('close', () => {
    if (!state.quitting) quit();
  });

  updatePrompt();
  rl.prompt();
  promptVisible = true;
}

function quit() {
  if (state.quitting) return;
  state.quitting = true;
  console.log(`\n${c.gray}  Пока! 🦋${c.reset}\n`);
  if (state.ws) {
    try { state.ws.close(1000); } catch (err) { /* ignore */ }
  }
  process.exit(0);
}

// ── События сервера ───────────────────────────────────────────────────────

function handleEvent(data) {
  switch (data.t) {
    case 'ready': {
      state.me = data.user;
      state.ready = true;
      state.reconnectAttempts = 0;
      const previous = new Map(state.contacts.map((contact) => [contact.id, contact]));
      state.contacts = data.contacts || [];
      for (const contact of state.contacts) {
        const chat = state.chats.get(contact.id);
        if (chat) {
          chat.status = contact.status;
          chat.statusText = contact.statusText || '';
          chat.unread = Math.max(chat.unread || 0, contact.unread || 0);
        }
        const old = previous.get(contact.id);
        if (old && old.status !== contact.status && chat && state.active === chat.id) {
          addSystem(chat, `${contact.displayName} теперь ${statusLabel(contact.status)}`);
        }
      }
      beforeOutput();
      console.log(`${c.green}●${c.reset} Вы в сети как ${c.bold}@${state.me.login}${c.reset} (${state.me.displayName})`);
      console.log('');
      printContacts();
      console.log(`${c.gray}  /help — команды, /chat <логин> — беседа.${c.reset}\n`);
      updatePrompt();
      afterOutput();
      break;
    }

    case 'contacts': {
      state.contacts = data.contacts || [];
      printAbove(`${c.gray}список контактов обновлён (${state.contacts.length})${c.reset}`);
      break;
    }

    case 'presence': {
      const user = data.user;
      if (!user) break;
      const contact = state.contacts.find((item) => item.id === user.id);
      if (contact) {
        const was = contact.status;
        const unread = contact.unread;
        Object.assign(contact, user);
        contact.unread = unread;
        const chat = state.chats.get(user.id);
        if (chat) applyContact(chat, contact);
        if (was !== user.status) {
          const line = `${presenceDot(user.status)} ${colorFor(user.login)}${user.login}${c.reset} ${c.gray}${statusLabel(user.status)}${c.reset}`;
          printAbove(line);
        }
      }
      updatePrompt();
      break;
    }

    case 'msg': {
      onIncoming(data);
      break;
    }

    case 'sent': {
      const chat = state.chats.get(data.m.to);
      if (chat) {
        const pending = chat.messages.find((message) => message.cid && message.cid === data.cid);
        if (pending) pending.ts = data.m.ts;
      }
      break;
    }

    case 'typing': {
      const contact = state.contacts.find((item) => item.id === data.from);
      const chat = contact ? state.chats.get(contact.id) : null;
      if (chat && state.active === chat.id && Date.now() - state.lastTypingNotice > 2500) {
        state.lastTypingNotice = Date.now();
        printAbove(`${c.gray}  ${chat.login} печатает…${c.reset}`);
      }
      break;
    }

    case 'nudge': {
      const from = data.from;
      if (!from) break;
      bell();
      const contact = state.contacts.find((item) => item.id === from.id) || from;
      const chat = contact.id ? ensureChat(contact) : null;
      const line = `${c.yellow}${c.bold}  ⚡ ${from.displayName} прислал(а) nudge!${c.reset}`;
      if (chat && state.active === chat.id) {
        printAbove(line);
      } else {
        printAbove(line);
        if (chat) {
          chat.unread = (chat.unread || 0) + 1;
          const entry = state.contacts.find((item) => item.id === from.id);
          if (entry) entry.unread = chat.unread;
          updatePrompt();
        }
      }
      break;
    }

    case 'read': {
      const chat = state.chats.get(data.by);
      if (chat) {
        for (const message of chat.messages) {
          if (message.from === (state.me && state.me.id) && message.ts <= (data.at || Date.now())) message.read = true;
        }
      }
      break;
    }

    case 'system': {
      bell();
      printAbove(`\n${c.yellow}  📢 ${data.text}${c.reset}\n`);
      break;
    }

    case 'me': {
      state.me = data.user;
      updatePrompt();
      break;
    }

    case 'error': {
      printAbove(`${c.red}  ⚠ ${data.message}${c.reset}`);
      break;
    }

    default:
      break;
  }
}

function applyContact(chat, contact) {
  chat.login = contact.login;
  chat.displayName = contact.displayName;
  chat.avatar = contact.avatar;
  chat.status = contact.status;
  chat.statusText = contact.statusText || '';
  chat.lastSeen = contact.lastSeen;
}

function addSystem(chat, text) {
  chat.messages.push({ system: true, ts: Date.now(), text });
}

function onIncoming(data) {
  const from = data.from;
  const message = data.m;
  if (!from || !message) return;

  let contact = state.contacts.find((item) => item.id === from.id);
  if (!contact) {
    contact = { ...from, unread: 0, group: 'Друзья' };
    state.contacts.push(contact);
  } else {
    Object.assign(contact, {
      login: from.login,
      displayName: from.displayName,
      avatar: from.avatar,
      status: from.status,
      statusText: from.statusText,
    });
  }

  const chat = ensureChat(contact);
  if (!chat.messages.some((item) => item.id === message.id)) {
    chat.messages.push(message);
    chat.messages.sort((a, b) => a.ts - b.ts);
  }
  chat.typing = false;

  const active = state.active === chat.id;
  beforeOutput();
  if (active) {
    markRead(chat);
    console.log(messageLine(message, chat));
    sendRead(chat.id);
  } else {
    chat.unread = (chat.unread || 0) + 1;
    contact.unread = chat.unread;
    bell();
    const line = `${c.gray}[${fmtTime(message.ts)}]${c.reset} ${colorFor(chat.login)}${c.bold}${chat.login}${c.reset}: ${emojify(message.text)}`;
    console.log(line);
    console.log(`${c.gray}   ↳ /chat ${chat.login}, чтобы ответить${c.reset}`);
  }
  updatePrompt();
  afterOutput();
}

function sendRead(chatId) {
  if (state.ready && state.ws) {
    try { state.ws.send(JSON.stringify({ t: 'read', with: chatId })); } catch (err) { /* ignore */ }
  }
}

function markRead(chat) {
  chat.unread = 0;
  const contact = state.contacts.find((item) => item.id === chat.id);
  if (contact) contact.unread = 0;
  updatePrompt();
}

// ── Команды ───────────────────────────────────────────────────────────────

async function openChatByLogin(login) {
  let contact = contactByLogin(login);
  if (!contact) {
    // поищем на сервере
    const search = await api('/api/search?q=' + encodeURIComponent(String(login).replace(/^@/, '')));
    if (!search.users || !search.users.length) {
      throw new Error(`Пользователь @${String(login).replace(/^@/, '')} не найден`);
    }
    const match = search.users.find((user) => user.login.toLowerCase() === String(login).replace(/^@/, '').toLowerCase()) || search.users[0];
    const add = await api('/api/contacts', { method: 'POST', body: { login: match.login } });
    state.contacts = add.contacts || state.contacts;
    contact = state.contacts.find((item) => item.id === match.id) || { ...match, unread: 0 };
  }
  const chat = ensureChat(contact);
  state.active = chat.id;
  markRead(chat);
  updatePrompt();

  if (!chat.loaded) {
    const data = await api('/api/history?with=' + encodeURIComponent(chat.id) + '&limit=40');
    if (data.contact) applyContact(chat, data.contact);
    const map = new Map(chat.messages.map((message) => [message.id, message]));
    for (const message of data.messages) map.set(message.id, message);
    chat.messages = Array.from(map.values()).sort((a, b) => a.ts - b.ts);
    chat.loaded = true;
    console.log('');
    printHistory(chat, chat.messages);
  } else {
    console.log('');
    printHistory(chat, chat.messages.slice(-20));
  }
  const status = `${presenceDot(chat.status)} ${statusLabel(chat.status)}${chat.statusText ? ' — ' + chat.statusText : ''}`;
  console.log(`${c.gray}  беседа с ${colorFor(chat.login)}@${chat.login}${c.reset} ${c.gray}(${status}${c.gray})${c.reset}`);
  console.log('');
  sendRead(chat.id);
}

async function handleCommand(line) {
  const [commandRaw, ...restParts] = line.slice(1).split(/\s+/);
  const command = (commandRaw || '').toLowerCase();
  const rest = line.slice(1 + commandRaw.length).trim();

  switch (command) {
    case 'help':
    case '?':
      printHelp();
      return;

    case 'list':
    case 'contacts':
      printContacts();
      return;

    case 'chat':
    case 'open': {
      if (!rest) {
        if (!state.active) throw new Error('Укажите логин: /chat bob');
        console.log(`${c.gray}  вы уже в беседе с @${state.chats.get(state.active).login}${c.reset}`);
        return;
      }
      await openChatByLogin(rest);
      return;
    }

    case 'close':
      if (!state.active) {
        console.log(`${c.gray}  нет открытой беседы${c.reset}`);
        return;
      }
      console.log(`${c.gray}  беседа закрыта${c.reset}`);
      state.active = null;
      return;

    case 'add': {
      if (!rest) throw new Error('Укажите логин: /add bob');
      const data = await api('/api/contacts', { method: 'POST', body: { login: rest.split(/\s+/)[0] } });
      state.contacts = data.contacts || state.contacts;
      console.log(`${data.added ? c.green + '  контакт добавлен' : c.gray + '  уже в контактах'}${c.reset}`);
      return;
    }

    case 'remove':
    case 'del': {
      const contact = contactByLogin(rest);
      if (!contact) throw new Error('Контакт не найден');
      const data = await api('/api/contacts/' + encodeURIComponent(contact.id), { method: 'DELETE' });
      state.contacts = data.contacts || state.contacts;
      state.chats.delete(contact.id);
      if (state.active === contact.id) state.active = null;
      console.log(`${c.gray}  @${contact.login} удалён${c.reset}`);
      return;
    }

    case 'msg':
    case 'say': {
      const parts = rest.split(/\s+/);
      const target = parts.shift();
      const text = rest.slice(target.length).trim();
      if (!target || !text) throw new Error('Формат: /msg <логин> <текст>');
      await sendTo(target, text);
      return;
    }

    case 'nudge': {
      if (!state.active) throw new Error('Сначала откройте беседу: /chat <логин>');
      if (!state.ready) throw new Error('Нет соединения с сервером');
      state.ws.send(JSON.stringify({ t: 'nudge', to: state.active }));
      const chat = state.chats.get(state.active);
      bell();
      console.log(`${c.yellow}  ⚡ nudge отправлен @${chat.login}${c.reset}`);
      return;
    }

    case 'status': {
      const parts = rest.split(/\s+/);
      const status = (parts.shift() || '').toLowerCase();
      const allowed = ['online', 'away', 'busy', 'invisible'];
      if (!allowed.includes(status)) throw new Error('Статус: online | away | busy | invisible');
      const statusText = parts.join(' ');
      sendStatus(status, statusText || (state.me.statusText || ''));
      return;
    }

    case 'me': {
      if (!rest) throw new Error('Формат: /me <статусное сообщение>');
      sendStatus(state.me.status || 'online', rest);
      return;
    }

    case 'history': {
      let chat;
      if (rest) {
        const contact = contactByLogin(rest);
        if (!contact) throw new Error('Контакт не найден');
        chat = ensureChat(contact);
      } else if (state.active) {
        chat = state.chats.get(state.active);
      } else {
        throw new Error('Откройте беседу или укажите логин: /history bob');
      }
      chat.loaded = false;
      const data = await api('/api/history?with=' + encodeURIComponent(chat.id) + '&limit=60');
      const map = new Map(chat.messages.map((message) => [message.id, message]));
      for (const message of data.messages) map.set(message.id, message);
      chat.messages = Array.from(map.values()).sort((a, b) => a.ts - b.ts);
      chat.loaded = true;
      console.log('');
      printHistory(chat, chat.messages);
      console.log('');
      return;
    }

    case 'who':
    case 'online': {
      const data = await api('/api/stats');
      console.log(`${c.bold}  Онлайн: ${data.online}${c.reset}`);
      for (const user of data.onlineUsers || []) {
        console.log(`   ${presenceDot(user.status)} ${colorFor(user.login)}${user.login}${c.reset} ${c.gray}${user.statusText || statusLabel(user.status)}${c.reset}`);
      }
      return;
    }

    case 'clear':
      process.stdout.write('\x1b[2J\x1b[H');
      printBanner();
      return;

    case 'quit':
    case 'exit':
    case 'q':
      quit();
      return;

    default:
      throw new Error(`Неизвестная команда /${command}. Наберите /help`);
  }
}

async function handlePlain(text) {
  if (!state.active) {
    throw new Error('Сначала откройте беседу: /chat <логин> (или /msg <логин> <текст>)');
  }
  await sendTo(state.chats.get(state.active).login, text, true);
}

async function sendTo(login, text) {
  if (!state.ready || !state.ws) throw new Error('Нет соединения с сервером');
  const contact = contactByLogin(login);
  let chatId;
  if (contact) {
    chatId = contact.id;
  } else {
    chatId = await resolveUserId(login);
  }
  const chat = state.chats.get(chatId) || ensureChat(contact || {
    id: chatId,
    login: String(login).replace(/^@/, ''),
    displayName: String(login).replace(/^@/, ''),
    avatar: '💬',
    status: 'offline',
  });
  chat.id = chatId;
  const cid = 't' + Date.now() + Math.random().toString(36).slice(2, 6);
  const message = { from: state.me.id, to: chatId, text, ts: Date.now(), cid, pending: true };
  chat.messages.push(message);
  state.ws.send(JSON.stringify({ t: 'msg', to: chatId, text, cid }));
  if (state.active === chatId) {
    printMessageLine(message, chat);
  } else {
    console.log(`${c.gray}  → @${chat.login}: ${emojify(text)}${c.reset}`);
  }
}

async function resolveUserId(login) {
  const search = await api('/api/search?q=' + encodeURIComponent(String(login).replace(/^@/, '')));
  const match = (search.users || []).find((user) => user.login.toLowerCase() === String(login).replace(/^@/, '').toLowerCase());
  if (!match) throw new Error(`Пользователь @${String(login).replace(/^@/, '')} не найден`);
  const data = await api('/api/contacts', { method: 'POST', body: { login: match.login } });
  state.contacts = data.contacts || state.contacts;
  return match.id;
}

function sendStatus(status, statusText) {
  state.me.status = status;
  state.me.statusText = statusText;
  if (state.ready && state.ws) {
    state.ws.send(JSON.stringify({ t: 'status', status, statusText }));
    console.log(`${c.gray}  статус: ${statusLabel(status)}${statusText ? ' — ' + statusText : ''}${c.reset}`);
  } else {
    api('/api/me', { method: 'PATCH', body: { status, statusText } })
      .then(() => console.log(`${c.gray}  статус сохранён${c.reset}`))
      .catch((err) => console.log(`${c.red}  ${err.message}${c.reset}`));
  }
}

// ── Старт ─────────────────────────────────────────────────────────────────

(async () => {
  try {
    if (!tty && !args.login) {
      console.error('Motyl TUI требует интерактивный терминал (TTY).');
      process.exit(1);
    }
    await ensureAuth();
    await startClient();
  } catch (err) {
    console.error(`${c.red}Ошибка: ${err.message}${c.reset}`);
    process.exit(1);
  }
})();
