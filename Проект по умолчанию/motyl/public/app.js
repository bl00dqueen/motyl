'use strict';

/**
 * Motyl — веб-клиент.
 * Классическое настроение MSN: список контактов, окна бесед, статусы,
 * смайлики, nudge, панель задач. Без фреймворков.
 */

(() => {
  // ── Константы ───────────────────────────────────────────────────────────

  const STATUS_META = {
    online: { label: 'В сети', dot: 'online' },
    away: { label: 'Нет на месте', dot: 'away' },
    busy: { label: 'Не беспокоить', dot: 'busy' },
    invisible: { label: 'Невидимка', dot: 'invisible' },
    offline: { label: 'Не в сети', dot: 'offline' },
  };

  const AVATARS = [
    '🦋', '🐱', '🐼', '🦊', '🐸', '🐧', '🦄', '🐙', '🌻', '🍀', '🎧', '🚀',
    '👾', '🌙', '🍕', '⚡', '🐯', '🐨', '🐹', '🦉', '🍩', '🎮', '🛸', '🌊',
  ];

  const EMOTICONS = [
    [':)', '😊'], [':D', '😃'], [';)', '😉'], [':(', '☹️'], [':P', '😛'],
    [':$', '😳'], [':O', '😮'], [':*', '😘'], ['(H)', '😎'], ['(A)', '😇'],
    ['(6)', '😈'], ['<3', '❤️'], ['(F)', '🌹'], ['(C)', '☕'], ['(D)', '🍺'],
    ['(Y)', '👍'], ['(N)', '👎'], ['(L)', '💔'], ['(U)', '💔'], ['(K)', '😘'],
    ['(T)', '😢'], ['(S)', '🌙'], ['(Z)', '😴'], ['(X)', '🙅'], ['(*)', '⭐'],
    ['(8)', '🎵'], ['(G)', '🎁'], ['(W)', '🌹'], ['(P)', '📷'], ['(M)', '💬'],
    ['(SN)', '🐌'], ['(CO)', '☕'], ['(PI)', '🍕'],
  ];

  const EMOJI_LOOKUP = new Map(EMOTICONS.map(([code, emoji]) => [code.toLowerCase(), emoji]));
  const EMOJI_REGEX = new RegExp(
    EMOTICONS.map(([code]) => code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .sort((a, b) => b.length - a.length)
      .join('|'),
    'gi',
  );

  const GROUPS = ['Друзья', 'Motyl', 'Работа', 'Семья', 'Другое'];

  // ── Состояние ───────────────────────────────────────────────────────────

  const S = {
    token: localStorage.getItem('motyl.token') || '',
    me: null,
    contacts: [],
    chats: new Map(),
    active: null,
    ws: null,
    ready: false,
    reconnectTimer: null,
    reconnectAttempts: 0,
    filter: '',
    collapsed: new Set(),
    z: 20,
    cid: 0,
    lastTyping: new Map(),
    server: null,
    flashTimer: null,
    modal: null,
    menu: null,
    baseTitle: 'Motyl — мессенджер',
  };

  // ── DOM ─────────────────────────────────────────────────────────────────

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const authEl = $('#auth');
  const mainEl = $('#main');
  const desktopEl = $('#desktop');
  const contactListEl = $('#contact-list');
  const taskbarEl = $('#taskbar');
  const emptyEl = $('#empty-state');

  // ── Утилиты ─────────────────────────────────────────────────────────────

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function truncate(text, limit) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length > limit ? value.slice(0, limit - 1) + '…' : value;
  }

  function statusMeta(status) {
    return STATUS_META[status] || STATUS_META.offline;
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function fmtDate(ts) {
    const date = new Date(ts);
    const now = new Date();
    if (sameDay(date, now)) return 'Сегодня';
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(date, yesterday)) return 'Вчера';
    return date.toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    });
  }

  function fmtLastSeen(ts) {
    if (!ts) return 'не в сети';
    const diff = Date.now() - ts;
    if (diff < 60 * 1000) return 'был(а) только что';
    if (diff < 60 * 60 * 1000) return `был(а) ${Math.floor(diff / 60000)} мин назад`;
    const date = new Date(ts);
    if (sameDay(date, new Date())) return 'был(а) сегодня в ' + fmtTime(ts);
    return 'был(а) ' + date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (S.token) headers.Authorization = 'Bearer ' + S.token;
    const res = await fetch(path, {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (err) { /* ignore */ }
    if (!res.ok) {
      const message = (data && data.error) || `Ошибка ${res.status}`;
      const error = new Error(message);
      error.status = res.status;
      throw error;
    }
    return data;
  }

  function emojify(text) {
    return String(text).replace(EMOJI_REGEX, (match) => EMOJI_LOOKUP.get(match.toLowerCase()) || match);
  }

  function appendRichText(container, text) {
    const urlRe = /https?:\/\/[^\s<>()]+/g;
    let lastIndex = 0;
    let match;
    while ((match = urlRe.exec(text))) {
      if (match.index > lastIndex) {
        container.append(document.createTextNode(emojify(text.slice(lastIndex, match.index))));
      }
      const link = el('a', null, match[0]);
      link.href = match[0];
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      container.append(link);
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      container.append(document.createTextNode(emojify(text.slice(lastIndex))));
    }
  }

  // ── Звуки (WebAudio, без файлов) ────────────────────────────────────────

  const Sound = {
    ctx: null,
    enabled: true,
    ensure() {
      if (!this.enabled) return false;
      try {
        if (!this.ctx) {
          const Ctx = window.AudioContext || window.webkitAudioContext;
          if (!Ctx) return false;
          this.ctx = new Ctx();
        }
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return true;
      } catch (err) {
        return false;
      }
    },
    tone({ freq = 880, to = freq, dur = 0.12, type = 'sine', gain = 0.05, delay = 0 }) {
      if (!this.ensure()) return;
      const ctx = this.ctx;
      const t0 = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const node = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
      node.gain.setValueAtTime(0.0001, t0);
      node.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
      node.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(node).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    },
    message() {
      this.tone({ freq: 880, dur: 0.1, gain: 0.055 });
      this.tone({ freq: 1318, dur: 0.14, gain: 0.04, delay: 0.09 });
    },
    send() { this.tone({ freq: 660, dur: 0.05, gain: 0.02 }); },
    online() {
      this.tone({ freq: 988, dur: 0.06, gain: 0.025 });
      this.tone({ freq: 1480, dur: 0.09, gain: 0.02, delay: 0.05 });
    },
    nudge() {
      this.tone({ freq: 130, to: 55, dur: 0.32, type: 'sawtooth', gain: 0.07 });
      this.tone({ freq: 95, to: 40, dur: 0.3, type: 'square', gain: 0.045, delay: 0.04 });
    },
    error() { this.tone({ freq: 320, to: 180, dur: 0.18, type: 'triangle', gain: 0.045 }); },
  };

  document.addEventListener('pointerdown', () => Sound.ensure(), { once: true });

  // ── Авторизация ─────────────────────────────────────────────────────────

  let authTab = 'login';

  function showAuthError(message) {
    const box = $('#auth-error');
    box.textContent = message || '';
    box.classList.toggle('show', !!message);
  }

  function setAuthTab(tab) {
    authTab = tab === 'register' ? 'register' : 'login';
    $$('.auth-tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === authTab));
    $('#login-form').classList.toggle('hidden', authTab !== 'login');
    $('#register-form').classList.toggle('hidden', authTab !== 'register');
    showAuthError('');
    const form = authTab === 'login' ? $('#login-form') : $('#register-form');
    const input = form.querySelector('input[name="login"]');
    if (input) setTimeout(() => input.focus(), 30);
  }

  function showAuth() {
    authEl.classList.remove('hidden');
    mainEl.classList.add('hidden');
    document.title = S.baseTitle;
    checkHealth();
  }

  async function checkHealth() {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      $('#auth-health').textContent = 'сервер онлайн';
      $('#auth-server').textContent = `Сервер: ${location.host} · v${data.version}`;
      $('#auth-meta').textContent = `${data.users} участник(ов) · ${data.online} онлайн`;
    } catch (err) {
      $('#auth-health').textContent = 'сервер недоступен';
      $('#auth-server').textContent = 'Сервер: ' + location.host;
      $('#auth-meta').textContent = 'проверьте, запущен ли node server.js';
    }
  }

  async function submitAuth(kind, form) {
    const data = new FormData(form);
    const body = {
      login: String(data.get('login') || '').trim(),
      password: String(data.get('password') || ''),
    };
    if (kind === 'register') body.displayName = String(data.get('displayName') || '').trim();

    const button = form.querySelector('button[type="submit"]');
    const label = button.textContent;
    button.disabled = true;
    button.textContent = kind === 'login' ? 'Входим…' : 'Создаём…';
    showAuthError('');

    try {
      const result = await api(kind === 'login' ? '/api/login' : '/api/register', { method: 'POST', body });
      S.token = result.token;
      localStorage.setItem('motyl.token', S.token);
      await enterApp();
    } catch (err) {
      showAuthError(err.message);
      Sound.error();
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  function forceLogout() {
    localStorage.removeItem('motyl.token');
    S.token = '';
    S.me = null;
    S.ready = false;
    if (S.ws) {
      try { S.ws.onclose = null; S.ws.close(); } catch (err) { /* ignore */ }
      S.ws = null;
    }
    for (const chat of S.chats.values()) {
      if (chat.el) chat.el.remove();
    }
    S.chats.clear();
    S.contacts = [];
    S.active = null;
    S.filter = '';
    $('#contact-filter').value = '';
    closeModal();
    closeMenus();
    mainEl.classList.remove('hidden');
    mainEl.classList.add('hidden');
    mainEl.classList.remove('chat-open');
    taskbarEl.innerHTML = '';
    contactListEl.innerHTML = '';
    showAuth();
  }

  // ── Вход в приложение ───────────────────────────────────────────────────

  async function enterApp() {
    let data;
    try {
      data = await api('/api/me');
    } catch (err) {
      if (err.status === 401) {
        localStorage.removeItem('motyl.token');
        S.token = '';
      }
      throw err;
    }
    S.me = data.user;
    S.server = data.server;
    authEl.classList.add('hidden');
    mainEl.classList.remove('hidden');
    document.title = S.baseTitle;

    // если до этого были окна (перелогин без перезагрузки) — почистим
    for (const chat of S.chats.values()) if (chat.el) chat.el.remove();
    S.chats.clear();
    S.contacts = [];
    S.active = null;

    renderMe();
    renderContacts();
    renderTaskbar();
    renderServerMeta();
    updateClock();
    connectWs();
    startStatsPolling();
  }

  // ── WebSocket ───────────────────────────────────────────────────────────

  function setConn(state) {
    const conn = $('#conn');
    conn.className = 'conn ' + state;
    const label = conn.querySelector('.conn-label');
    if (label) {
      label.textContent = state === 'online' ? 'Вы в сети' : state === 'connecting' ? 'Подключение…' : 'Нет соединения';
    }
    if (state === 'offline' && S.me) {
      $('#server-meta').textContent = 'Motyl · оффлайн, переподключение…';
    }
  }

  function connectWs() {
    clearTimeout(S.reconnectTimer);
    if (S.ws) {
      try { S.ws.onclose = null; S.ws.close(); } catch (err) { /* ignore */ }
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket;
    try {
      socket = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(S.token)}`);
    } catch (err) {
      setConn('offline');
      return;
    }
    S.ws = socket;
    S.ready = false;
    setConn('connecting');

    socket.onopen = () => {
      S.reconnectAttempts = 0;
    };

    socket.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch (err) { return; }
      handleEvent(data);
    };

    socket.onclose = () => {
      if (S.ws !== socket) return;
      S.ready = false;
      setConn('offline');
      if (!S.token) return;
      S.reconnectAttempts++;
      const delay = Math.min(900 * Math.pow(1.6, S.reconnectAttempts), 12000);
      S.reconnectTimer = setTimeout(() => {
        if (S.token) connectWs();
      }, delay);
    };

    socket.onerror = () => { /* onclose придёт следом */ };
  }

  function handleEvent(data) {
    switch (data.t) {
      case 'ready': {
        S.me = data.user;
        S.server = data.server;
        S.ready = true;
        setContacts(data.contacts || []);
        renderMe();
        renderServerMeta();
        setConn('online');
        for (const chat of S.chats.values()) {
          const contact = S.contacts.find((c) => c.id === chat.id);
          if (contact) applyContact(chat, contact);
          renderChat(chat);
        }
        renderContacts();
        renderTaskbar();
        updateTitle();
        Sound.online();
        break;
      }
      case 'contacts':
        setContacts(data.contacts || []);
        break;
      case 'presence':
        onPresence(data.user);
        break;
      case 'me':
        S.me = data.user;
        renderMe();
        break;
      case 'msg':
        onIncoming(data);
        break;
      case 'sent':
        onSent(data);
        break;
      case 'typing':
        onTyping(data.from);
        break;
      case 'nudge':
        onNudge(data.from);
        break;
      case 'read':
        onRead(data);
        break;
      case 'system':
        toast('Объявление', data.text, { icon: '📢', system: true, timeout: 9000 });
        Sound.online();
        break;
      case 'error':
        toast('Ошибка', data.message, { icon: '⚠️' });
        Sound.error();
        break;
      default:
        break;
    }
  }

  // ── Контакты ────────────────────────────────────────────────────────────

  function setContacts(list) {
    S.contacts = list.map((item) => ({ ...item }));
    for (const chat of S.chats.values()) {
      const contact = S.contacts.find((c) => c.id === chat.id);
      if (contact) {
        applyContact(chat, contact);
        chat.unread = Math.max(chat.unread || 0, contact.unread || 0);
      } else if (chat.status !== 'offline') {
        chat.status = 'offline';
      }
      renderChat(chat);
    }
    renderContacts();
    renderTaskbar();
    updateTitle();
  }

  function applyContact(target, source) {
    target.login = source.login;
    target.displayName = source.displayName;
    target.avatar = source.avatar;
    target.status = source.status;
    target.statusText = source.statusText;
    target.lastSeen = source.lastSeen;
    if (source.group) target.group = source.group;
    if (source.unread != null) target.unread = source.unread;
  }

  function onPresence(user) {
    if (!user) return;
    const contact = S.contacts.find((c) => c.id === user.id);
    let wasOffline = false;
    if (contact) {
      wasOffline = contact.status === 'offline';
      const keepUnread = contact.unread;
      const keepGroup = contact.group;
      Object.assign(contact, user);
      contact.unread = keepUnread;
      contact.group = keepGroup;
    }
    const chat = S.chats.get(user.id);
    if (chat) {
      const prev = chat.status;
      applyContact(chat, { ...user, group: chat.group });
      if (chat.open && prev && prev !== user.status) {
        addSystem(chat, `${user.displayName} теперь ${statusMeta(user.status).label.toLowerCase()}`);
      }
      renderChat(chat);
    }
    renderContacts();
    if (contact && wasOffline && user.status !== 'offline') Sound.online();
  }

  function sortContacts(a, b) {
    const offlineDiff = Number(a.status === 'offline') - Number(b.status === 'offline');
    if (offlineDiff) return offlineDiff;
    return (a.displayName || a.login).localeCompare(b.displayName || b.login, 'ru');
  }

  function avatarNode(contact, size = 'md', withDot = true) {
    const node = el('div', 'avatar ' + size);
    node.append(el('span', 'avatar-emoji', contact.avatar || '🦋'));
    if (withDot) node.append(el('i', 'dot ' + (contact.status || 'offline')));
    return node;
  }

  function updateAvatarNode(node, contact) {
    if (!node) return;
    const emoji = node.querySelector('.avatar-emoji');
    if (emoji) emoji.textContent = contact.avatar || '🦋';
    const dot = node.querySelector('.dot');
    if (dot) dot.className = 'dot ' + (contact.status || 'offline');
  }

  function renderContacts() {
    contactListEl.innerHTML = '';
    const query = S.filter.trim().toLowerCase();
    let items = S.contacts.slice();
    if (query) {
      items = items.filter((c) => (c.displayName || '').toLowerCase().includes(query)
        || (c.login || '').toLowerCase().includes(query)
        || (c.statusText || '').toLowerCase().includes(query));
    }

    if (!items.length) {
      const empty = el('div', 'contact-empty');
      if (!S.contacts.length) {
        empty.append(el('b', null, 'Пока никого нет'));
        empty.append(document.createTextNode('Нажмите «＋» и добавьте друга по логину — начните с motyl.'));
      } else {
        empty.append(el('b', null, 'Ничего не найдено'));
        empty.append(document.createTextNode('Попробуйте изменить запрос.'));
      }
      contactListEl.append(empty);
      return;
    }

    const groups = new Map();
    for (const contact of items) {
      const group = contact.group || 'Друзья';
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(contact);
    }

    const order = GROUPS;
    const names = Array.from(groups.keys()).sort((a, b) => {
      const ia = order.includes(a) ? order.indexOf(a) : 99;
      const ib = order.includes(b) ? order.indexOf(b) : 99;
      return ia - ib || a.localeCompare(b, 'ru');
    });

    for (const name of names) {
      const members = groups.get(name).sort(sortContacts);
      const collapsed = S.collapsed.has(name);
      const group = el('div', 'group' + (collapsed ? ' collapsed' : ''));
      const head = el('div', 'group-head');
      head.append(el('span', 'group-caret', '▾'));
      head.append(el('span', null, name));
      head.append(el('span', 'group-count', String(members.length)));
      head.addEventListener('click', () => {
        if (S.collapsed.has(name)) S.collapsed.delete(name);
        else S.collapsed.add(name);
        renderContacts();
      });
      group.append(head);

      const wrap = el('div', 'group-contacts');
      for (const contact of members) wrap.append(contactRow(contact));
      group.append(wrap);
      contactListEl.append(group);
    }
  }

  function contactRow(contact) {
    const row = el('div', 'contact'
      + (contact.status === 'offline' ? ' offline' : '')
      + (S.active === contact.id ? ' active' : ''));
    row.dataset.id = contact.id;
    row.append(avatarNode(contact, 'sm'));

    const main = el('div', 'contact-main');
    const name = el('div', 'contact-name');
    name.append(document.createTextNode(contact.displayName || contact.login));
    if (contact.system) name.append(el('span', 'bot-tag', 'BOT'));
    main.append(name);

    const sub = el('div', 'contact-sub');
    if (contact.typingUntil && contact.typingUntil > Date.now()) {
      sub.textContent = 'печатает…';
      sub.classList.add('typing');
    } else if (contact.statusText) {
      sub.textContent = contact.statusText;
    } else {
      sub.textContent = statusMeta(contact.status).label;
    }
    main.append(sub);
    row.append(main);

    if (contact.unread) row.append(el('span', 'badge', contact.unread > 99 ? '99+' : String(contact.unread)));

    row.addEventListener('click', () => openChat(contact.id));
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showContactMenu(contact, event.clientX, event.clientY);
    });
    return row;
  }

  // ── Беседы ──────────────────────────────────────────────────────────────

  function ensureChat(contact) {
    let chat = S.chats.get(contact.id);
    if (!chat) {
      chat = {
        id: contact.id,
        login: contact.login,
        displayName: contact.displayName,
        avatar: contact.avatar,
        status: contact.status,
        statusText: contact.statusText,
        lastSeen: contact.lastSeen,
        group: contact.group || 'Друзья',
        system: !!contact.system,
        messages: [],
        loaded: false,
        open: false,
        minimized: false,
        unread: contact.unread || 0,
        typingUntil: 0,
        lastNudge: 0,
        el: null,
        logEl: null,
        inputEl: null,
        subEl: null,
        titleEl: null,
        emojiEl: null,
        pos: null,
      };
      S.chats.set(chat.id, chat);
    } else {
      applyContact(chat, contact);
    }
    return chat;
  }

  function totalUnread() {
    let total = 0;
    for (const chat of S.chats.values()) total += chat.unread || 0;
    return total;
  }

  function updateTitle() {
    const total = totalUnread();
    if (!total || document.hasFocus()) {
      if (S.flashTimer) {
        clearInterval(S.flashTimer);
        S.flashTimer = null;
      }
      document.title = S.baseTitle;
      return;
    }
    if (S.flashTimer) return;
    let on = false;
    S.flashTimer = setInterval(() => {
      if (!totalUnread() || document.hasFocus()) {
        clearInterval(S.flashTimer);
        S.flashTimer = null;
        document.title = S.baseTitle;
        return;
      }
      document.title = on ? S.baseTitle : `(${totalUnread()}) Новые сообщения — Motyl`;
      on = !on;
    }, 1400);
  }

  function openChat(contactId) {
    const contact = S.contacts.find((c) => c.id === contactId);
    if (!contact) return;
    const chat = ensureChat(contact);
    if (!chat.open) {
      chat.open = true;
      createChatWindow(chat);
    }
    if (chat.minimized) {
      chat.minimized = false;
      chat.el.classList.remove('minimized');
    }
    mainEl.classList.add('chat-open');
    emptyEl.classList.add('hidden');
    renderChat(chat);
    focusChat(chat);
    renderTaskbar();
    if (!chat.loaded) loadHistory(chat);
    markChatRead(chat);
    renderContacts();
  }

  function createChatWindow(chat) {
    const win = el('div', 'chat-window');
    win.dataset.id = chat.id;

    const head = el('div', 'chat-head');
    head.append(avatarNode(chat, 'md'));

    const title = el('div', 'chat-title');
    title.append(el('b', null, chat.displayName || chat.login));
    const sub = el('small');
    sub.textContent = statusMeta(chat.status).label;
    title.append(sub);
    head.append(title);

    const actions = el('div', 'chat-actions');
    const nudgeBtn = el('button', 'nudge', '⚡');
    nudgeBtn.type = 'button';
    nudgeBtn.title = 'Nudge — встряхнуть окно';
    const minBtn = el('button', null, '–');
    minBtn.type = 'button';
    minBtn.title = 'Свернуть';
    const closeBtn = el('button', 'close', '✕');
    closeBtn.type = 'button';
    closeBtn.title = 'Закрыть';
    actions.append(nudgeBtn, minBtn, closeBtn);
    head.append(actions);

    const log = el('div', 'chat-log');
    const compose = el('div', 'compose');
    const emojiBtn = el('button', 'emoji-btn', '😊');
    emojiBtn.type = 'button';
    emojiBtn.title = 'Смайлики';
    const input = el('textarea');
    input.rows = 1;
    input.maxLength = 4000;
    input.placeholder = 'Введите сообщение…';
    const sendBtn = el('button', 'send-btn', 'Отправить');
    sendBtn.type = 'button';
    compose.append(emojiBtn, input, sendBtn);

    win.append(head, log, compose);
    $('#desktop').append(win);

    chat.el = win;
    chat.logEl = log;
    chat.inputEl = input;
    chat.subEl = sub;
    chat.titleEl = title.querySelector('b');
    chat.emojiEl = null;

    positionWindow(chat, win);
    makeDraggable(chat);

    win.addEventListener('pointerdown', () => {
      if (S.active !== chat.id) focusChat(chat, { focusInput: false });
    }, true);

    nudgeBtn.addEventListener('click', (event) => { event.stopPropagation(); sendNudge(chat); });
    minBtn.addEventListener('click', (event) => { event.stopPropagation(); minimizeChat(chat); });
    closeBtn.addEventListener('click', (event) => { event.stopPropagation(); closeChat(chat); });
    sendBtn.addEventListener('click', () => sendCurrent(chat));

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendCurrent(chat);
      }
    });
    input.addEventListener('input', () => {
      autoGrow(input);
      sendTyping(chat);
    });

    emojiBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleEmojiPicker(chat);
    });
  }

  function positionWindow(chat, win) {
    if (chat.pos) {
      win.style.left = chat.pos.left + 'px';
      win.style.top = chat.pos.top + 'px';
      return;
    }
    const openCount = Array.from(S.chats.values()).filter((c) => c.open).length;
    const width = Math.min(600, Math.max(380, desktopEl.clientWidth - 40));
    const height = Math.min(470, Math.max(320, desktopEl.clientHeight - 96));
    win.style.width = width + 'px';
    win.style.height = height + 'px';
    const maxX = Math.max(8, desktopEl.clientWidth - width - 14);
    const maxY = Math.max(8, desktopEl.clientHeight - height - 64);
    const left = Math.min(20 + (openCount % 6) * 34, maxX);
    const top = Math.min(20 + (openCount % 6) * 26, maxY);
    win.style.left = left + 'px';
    win.style.top = top + 'px';
    chat.pos = { left, top };
  }

  function makeDraggable(chat) {
    const handle = chat.el.querySelector('.chat-head');
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) return;
      const win = chat.el;
      const parent = win.offsetParent;
      const startX = event.clientX;
      const startY = event.clientY;
      const startLeft = win.offsetLeft;
      const startTop = win.offsetTop;

      try { handle.setPointerCapture(event.pointerId); } catch (err) { /* ignore */ }

      const onMove = (moveEvent) => {
        const nextLeft = clamp(startLeft + moveEvent.clientX - startX, 4, Math.max(4, parent.clientWidth - 120));
        const nextTop = clamp(startTop + moveEvent.clientY - startY, 4, Math.max(4, parent.clientHeight - 58));
        win.style.left = nextLeft + 'px';
        win.style.top = nextTop + 'px';
      };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        chat.pos = { left: win.offsetLeft, top: win.offsetTop };
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  }

  async function loadHistory(chat) {
    chat.loaded = true;
    try {
      const data = await api(`/api/history?with=${encodeURIComponent(chat.id)}&limit=120`);
      if (data.contact) {
        const { unread, ...contactData } = data.contact;
        applyContact(chat, contactData);
        const contact = S.contacts.find((c) => c.id === chat.id);
        if (contact) Object.assign(contact, contactData);
      }
      const map = new Map(chat.messages.map((message) => [message.id, message]));
      for (const message of data.messages) map.set(message.id, message);
      chat.messages = Array.from(map.values()).sort((a, b) => a.ts - b.ts);
      renderChat(chat);
      scrollChat(chat);
      renderContacts();
    } catch (err) {
      chat.loaded = false;
      toast('История недоступна', err.message, { icon: '⚠️' });
    }
  }

  function focusChat(chat, options = {}) {
    if (!chat.el) return;
    const focusInput = options.focusInput !== false;
    chat.el.style.zIndex = String(++S.z);
    for (const other of S.chats.values()) {
      if (other.el) other.el.classList.toggle('focused', other === chat);
    }
    S.active = chat.id;
    mainEl.classList.add('chat-open');
    emptyEl.classList.add('hidden');
    if (focusInput) {
      setTimeout(() => {
        if (chat.inputEl && S.active === chat.id) chat.inputEl.focus();
      }, 20);
    }
    markChatRead(chat);
    renderContacts();
    renderTaskbar();
  }

  function minimizeChat(chat) {
    chat.minimized = true;
    if (chat.el) chat.el.classList.add('minimized');
    if (S.active === chat.id) S.active = null;
    closeEmojiPicker(chat);
    renderTaskbar();
    renderContacts();
  }

  function closeChat(chat) {
    if (chat.el) chat.el.remove();
    closeEmojiPicker(chat);
    chat.open = false;
    chat.minimized = false;
    chat.el = null;
    chat.logEl = null;
    chat.inputEl = null;
    chat.unread = 0;
    const contact = S.contacts.find((c) => c.id === chat.id);
    if (contact) contact.unread = 0;
    if (S.active === chat.id) S.active = null;
    if (!Array.from(S.chats.values()).some((c) => c.open)) {
      emptyEl.classList.remove('hidden');
      mainEl.classList.remove('chat-open');
    }
    renderTaskbar();
    renderContacts();
    updateTitle();
    markChatRead(chat, { silent: true });
  }

  function renderChat(chat) {
    if (!chat.el) return;
    const meta = statusMeta(chat.status);
    if (chat.titleEl) chat.titleEl.textContent = chat.displayName || chat.login;
    updateAvatarNode(chat.el.querySelector('.chat-head .avatar'), chat);

    if (chat.subEl) {
      if (chat.typingUntil > Date.now()) {
        chat.subEl.textContent = 'печатает…';
        chat.subEl.classList.add('typing');
      } else {
        chat.subEl.classList.remove('typing');
        if (chat.status === 'offline') {
          chat.subEl.textContent = chat.lastSeen ? fmtLastSeen(chat.lastSeen) : meta.label;
        } else {
          chat.subEl.textContent = chat.statusText || meta.label;
        }
      }
    }

    const log = chat.logEl;
    if (!log) return;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 70;
    log.innerHTML = '';

    let lastDay = '';
    for (const message of chat.messages) {
      if (message.system) {
        log.append(el('div', 'system-msg', message.text));
        continue;
      }
      const day = fmtDate(message.ts);
      if (day !== lastDay) {
        log.append(el('div', 'day-sep', day));
        lastDay = day;
      }
      log.append(messageNode(chat, message));
    }

    if (chat.typingUntil > Date.now()) {
      const typing = el('div', 'typing-row');
      typing.append(el('span', null, 'печатает'));
      const dots = el('span', 'dots');
      dots.append(el('i'), el('i'), el('i'));
      typing.append(dots);
      log.append(typing);
    }

    if (nearBottom || (chat.messages.length && chat.messages[chat.messages.length - 1].from === (S.me && S.me.id))) {
      log.scrollTop = log.scrollHeight;
    }
  }

  function messageNode(chat, message) {
    const mine = S.me && message.from === S.me.id;
    const row = el('div', 'msg ' + (mine ? 'mine' : 'theirs'));
    if (mine && message.failed) row.classList.add('failed');

    const bubble = el('div', 'bubble');
    appendRichText(bubble, message.text);
    row.append(bubble);

    const meta = el('div', 'meta');
    meta.append(el('span', null, fmtTime(message.ts)));
    if (mine) {
      if (message.pending) meta.append(el('span', null, '· отправляется…'));
      else if (message.failed) meta.append(el('span', null, '· не отправлено'));
      else if (message.readAt) meta.append(el('span', 'ticks', '✓✓'), el('span', null, 'прочитано'));
    }
    row.append(meta);
    return row;
  }

  function addSystem(chat, text) {
    chat.messages.push({
      id: 'sys-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      system: true,
      ts: Date.now(),
      text,
    });
  }

  function scrollChat(chat) {
    if (chat.logEl) chat.logEl.scrollTop = chat.logEl.scrollHeight;
  }

  function shakeWindow(chat) {
    if (!chat.el) return;
    chat.el.classList.remove('shake');
    void chat.el.offsetWidth;
    chat.el.classList.add('shake');
    setTimeout(() => { if (chat.el) chat.el.classList.remove('shake'); }, 620);
  }

  function autoGrow(input) {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 118) + 'px';
  }

  function insertAtCursor(input, text) {
    const start = input.selectionStart == null ? input.value.length : input.selectionStart;
    const end = input.selectionEnd == null ? input.value.length : input.selectionEnd;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    const caret = start + text.length;
    input.setSelectionRange(caret, caret);
    autoGrow(input);
  }

  function toggleEmojiPicker(chat) {
    if (chat.emojiEl) {
      closeEmojiPicker(chat);
      return;
    }
    const pop = el('div', 'emoji-pop');
    for (const [code, emoji] of EMOTICONS) {
      const button = el('button', null, emoji);
      button.type = 'button';
      button.title = code;
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        insertAtCursor(chat.inputEl, emoji);
        chat.inputEl.focus();
        closeEmojiPicker(chat);
      });
      pop.append(button);
    }
    chat.el.append(pop);
    chat.emojiEl = pop;
  }

  function closeEmojiPicker(chat) {
    if (chat.emojiEl) {
      chat.emojiEl.remove();
      chat.emojiEl = null;
    }
  }

  // ── Отправка и приём ────────────────────────────────────────────────────

  function sendCurrent(chat) {
    if (!chat.inputEl) return;
    const text = chat.inputEl.value.replace(/\s+$/, '');
    if (!text.trim()) return;
    if (text.length > 4000) {
      toast('Слишком длинное сообщение', 'Максимум 4000 символов', { icon: '⚠️' });
      return;
    }

    const cid = 'c' + (++S.cid) + '-' + Date.now();
    const local = {
      id: cid,
      from: S.me.id,
      to: chat.id,
      text,
      ts: Date.now(),
      pending: true,
      readAt: null,
    };
    chat.messages.push(local);
    chat.inputEl.value = '';
    autoGrow(chat.inputEl);
    renderChat(chat);
    scrollChat(chat);
    Sound.send();

    if (S.ready && S.ws && S.ws.readyState === 1) {
      S.ws.send(JSON.stringify({ t: 'msg', to: chat.id, text, cid }));
    } else {
      api('/api/messages', { method: 'POST', body: { to: chat.id, text, cid } })
        .then((data) => replaceMessage(chat, cid, data.message))
        .catch((err) => {
          const pending = chat.messages.find((m) => m.id === cid);
          if (pending) {
            pending.pending = false;
            pending.failed = true;
          }
          renderChat(chat);
          toast('Сообщение не отправлено', err.message, { icon: '⚠️' });
          Sound.error();
        });
    }
  }

  function replaceMessage(chat, cid, message) {
    let index = chat.messages.findIndex((m) => m.id === cid || m.id === message.id);
    if (index === -1) chat.messages.push(message);
    else chat.messages[index] = message;
    chat.messages.sort((a, b) => a.ts - b.ts);
    renderChat(chat);
    scrollChat(chat);
  }

  function sendTyping(chat) {
    if (!S.ready || !S.ws || S.ws.readyState !== 1) return;
    const now = Date.now();
    const last = S.lastTyping.get(chat.id) || 0;
    if (now - last < 2500) return;
    S.lastTyping.set(chat.id, now);
    S.ws.send(JSON.stringify({ t: 'typing', to: chat.id }));
  }

  function sendNudge(chat) {
    if (!S.ready || !S.ws || S.ws.readyState !== 1) {
      toast('Нет соединения', 'Nudge доступен только онлайн', { icon: '⚠️' });
      return;
    }
    if (Date.now() - (chat.lastNudge || 0) < 10000) {
      toast('Рано!', 'Nudge можно отправлять не чаще раза в 10 секунд 😄', { icon: '⚡' });
      return;
    }
    chat.lastNudge = Date.now();
    S.ws.send(JSON.stringify({ t: 'nudge', to: chat.id }));
    addSystem(chat, '⚡ Вы отправили nudge');
    renderChat(chat);
    shakeWindow(chat);
    Sound.nudge();
  }

  function markChatRead(chat, options = {}) {
    const contact = S.contacts.find((c) => c.id === chat.id);
    const wasUnread = (chat.unread || 0) > 0 || (contact && contact.unread > 0);
    chat.unread = 0;
    if (contact) contact.unread = 0;
    if (!options.silent && wasUnread && S.ready && S.ws && S.ws.readyState === 1) {
      S.ws.send(JSON.stringify({ t: 'read', with: chat.id }));
    }
    if (wasUnread) {
      renderContacts();
      renderTaskbar();
      updateTitle();
    }
  }

  function onIncoming(data) {
    if (!data || !data.from || !data.m) return;
    const from = data.from;
    const message = data.m;

    let contact = S.contacts.find((c) => c.id === from.id);
    if (!contact) {
      contact = { ...from, group: 'Друзья', unread: 0 };
      S.contacts.push(contact);
      renderContacts();
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
    if (!chat.messages.some((m) => m.id === message.id)) chat.messages.push(message);
    chat.messages.sort((a, b) => a.ts - b.ts);
    chat.typingUntil = 0;
    contact.typingUntil = 0;

    const visible = document.hasFocus() && S.active === chat.id && chat.open && !chat.minimized;
    if (visible) {
      markChatRead(chat);
    } else {
      chat.unread = (chat.unread || 0) + 1;
      contact.unread = chat.unread;
      startTitleFlash();
      if (navigator.vibrate) {
        try { navigator.vibrate(60); } catch (err) { /* ignore */ }
      }
    }

    Sound.message();
    renderChat(chat);
    renderContacts();
    renderTaskbar();
    updateTitle();

    if (!visible) {
      toast(chat.displayName || chat.login, truncate(message.text, 90), {
        icon: chat.avatar || '💬',
        onClick: () => openChat(chat.id),
      });
    }
  }

  function onSent(data) {
    if (!data || !data.m) return;
    const message = data.m;
    const chat = S.chats.get(message.to) || S.chats.get(message.from);
    if (!chat) return;
    if (data.cid) replaceMessage(chat, data.cid, message);
    else if (!chat.messages.some((m) => m.id === message.id)) {
      chat.messages.push(message);
      chat.messages.sort((a, b) => a.ts - b.ts);
      renderChat(chat);
      scrollChat(chat);
    }
  }

  function onTyping(fromId) {
    if (!fromId) return;
    const contact = S.contacts.find((c) => c.id === fromId);
    if (!contact) return;
    const chat = ensureChat(contact);
    const until = Date.now() + 3500;
    chat.typingUntil = until;
    contact.typingUntil = until;
    clearTimeout(chat.typingTimer);
    chat.typingTimer = setTimeout(() => {
      chat.typingUntil = 0;
      contact.typingUntil = 0;
      renderChat(chat);
      renderContacts();
    }, 3600);
    renderChat(chat);
    renderContacts();
  }

  function onNudge(from) {
    if (!from) return;
    let contact = S.contacts.find((c) => c.id === from.id);
    if (!contact) {
      contact = { ...from, group: 'Друзья', unread: 0 };
      S.contacts.push(contact);
    }
    const chat = ensureChat(contact);
    addSystem(chat, `⚡ ${from.displayName} отправил(а) вам nudge!`);
    if (!chat.open || chat.minimized) {
      chat.unread = (chat.unread || 0) + 1;
      contact.unread = chat.unread;
      startTitleFlash();
    }
    Sound.nudge();
    if (chat.open && !chat.minimized) shakeWindow(chat);
    if (navigator.vibrate) {
      try { navigator.vibrate([90, 60, 90]); } catch (err) { /* ignore */ }
    }
    renderChat(chat);
    renderContacts();
    renderTaskbar();
    updateTitle();
    if (!document.hasFocus() || S.active !== chat.id) {
      toast(`${chat.displayName}: nudge! ⚡`, 'Окно собеседника сейчас трясётся', {
        icon: '⚡',
        onClick: () => openChat(chat.id),
      });
    }
  }

  function onRead(data) {
    if (!data || !data.by) return;
    const chat = S.chats.get(data.by);
    if (!chat) return;
    const at = data.at || Date.now();
    let changed = false;
    for (const message of chat.messages) {
      if (message.from === (S.me && S.me.id) && message.ts <= at && !message.readAt) {
        message.readAt = at;
        changed = true;
      }
    }
    if (changed) renderChat(chat);
  }

  function startTitleFlash() {
    updateTitle();
  }

  // ── Панель задач ────────────────────────────────────────────────────────

  function renderTaskbar() {
    taskbarEl.innerHTML = '';
    const chats = Array.from(S.chats.values()).filter((chat) => chat.open);
    for (const chat of chats) {
      const button = el('button', 'task-btn' + (S.active === chat.id && !chat.minimized ? ' active' : ''));
      button.type = 'button';
      button.append(avatarNode(chat, 'sm'));
      button.append(el('span', 'label', chat.displayName || chat.login));
      if (chat.unread) {
        button.append(el('span', 'mini-badge', chat.unread > 99 ? '99+' : String(chat.unread)));
      }
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        if (chat.minimized) {
          chat.minimized = false;
          if (chat.el) chat.el.classList.remove('minimized');
          focusChat(chat);
        } else if (S.active === chat.id) {
          minimizeChat(chat);
        } else {
          focusChat(chat);
        }
      });
      taskbarEl.append(button);
    }
  }

  // ── Профиль ─────────────────────────────────────────────────────────────

  function renderMe() {
    if (!S.me) return;
    const avatar = $('#me-avatar');
    avatar.innerHTML = '';
    avatar.append(el('span', 'avatar-emoji', S.me.avatar || '🦋'));
    $('#me-name').textContent = S.me.displayName || S.me.login;
    $('#me-login').textContent = '@' + S.me.login;
    $('#status-select').value = S.me.status || 'online';
    $('#me-dot').className = 'status-dot ' + (S.me.status || 'online');
    if (document.activeElement !== $('#status-text')) {
      $('#status-text').value = S.me.statusText || '';
    }
  }

  function renderServerMeta() {
    const info = S.server || {};
    const online = info.online != null ? info.online : '—';
    $('#server-meta').textContent = `Motyl v${info.version || '1.0'} · в сети: ${online}`;
  }

  function sendStatus(patch) {
    if (!S.me) return;
    if (patch.status) S.me.status = patch.status;
    if (patch.statusText !== undefined) S.me.statusText = patch.statusText;
    renderMe();
    const payload = { status: S.me.status, statusText: S.me.statusText };
    if (S.ready && S.ws && S.ws.readyState === 1) {
      S.ws.send(JSON.stringify({ t: 'status', ...payload }));
    } else {
      api('/api/me', { method: 'PATCH', body: payload }).catch((err) => toast('Статус не сохранён', err.message, { icon: '⚠️' }));
    }
  }

  function startStatsPolling() {
    clearInterval(S.statsTimer);
    S.statsTimer = setInterval(async () => {
      if (!S.token || !S.me) return;
      try {
        const info = await api('/api/stats');
        S.server = info;
        renderServerMeta();
      } catch (err) { /* тихо */ }
    }, 30000);
  }

  // ── Модальные окна ──────────────────────────────────────────────────────

  function closeModal() {
    if (S.modal) {
      S.modal.backdrop.remove();
      S.modal = null;
    }
  }

  function openModal({ title, body, actions = [], width }) {
    closeModal();
    closeMenus();
    const backdrop = el('div', 'modal-backdrop');
    const modal = el('div', 'modal');
    if (width) modal.style.width = width + 'px';

    const head = el('div', 'modal-head');
    head.append(el('h3', null, title));
    const closeBtn = el('button', 'icon-btn', '✕');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', closeModal);
    head.append(closeBtn);

    const bodyEl = el('div', 'modal-body');
    if (body instanceof Node) bodyEl.append(body);
    else if (body != null) bodyEl.append(document.createTextNode(String(body)));

    const foot = el('div', 'modal-foot');
    for (const action of actions) {
      const button = el('button', 'btn' + (action.primary ? ' primary' : ''), action.label);
      button.type = 'button';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const result = action.onClick ? await action.onClick() : true;
          if (result !== false) closeModal();
        } catch (err) {
          toast('Не получилось', err.message, { icon: '⚠️' });
          Sound.error();
        } finally {
          button.disabled = false;
        }
      });
      foot.append(button);
    }

    modal.append(head, bodyEl);
    if (actions.length) modal.append(foot);
    backdrop.append(modal);
    backdrop.addEventListener('pointerdown', (event) => {
      if (event.target === backdrop) closeModal();
    });
    $('#modals').append(backdrop);
    S.modal = { backdrop, modal };

    const focusable = modal.querySelector('input, textarea, button.primary');
    if (focusable) setTimeout(() => focusable.focus(), 40);
    return { close: closeModal, modal };
  }

  function field(labelText, props = {}) {
    const wrap = el('label', 'field');
    wrap.append(el('span', null, labelText));
    const input = el(props.tag === 'textarea' ? 'textarea' : 'input');
    if (props.type) input.type = props.type;
    if (props.value != null) input.value = props.value;
    if (props.placeholder) input.placeholder = props.placeholder;
    if (props.maxlength) input.maxLength = props.maxlength;
    if (props.required) input.required = true;
    if (props.autocomplete) input.autocomplete = props.autocomplete;
    wrap.append(input);
    return { wrap, input };
  }

  function openAddContact(prefill = '') {
    const body = document.createDocumentFragment();
    const login = field('Логин друга', {
      value: prefill,
      placeholder: 'например, bob',
      maxlength: 20,
      autocomplete: 'off',
    });
    const groupWrap = el('label', 'field');
    groupWrap.append(el('span', null, 'Группа'));
    const select = el('select');
    select.className = 'select-input';
    for (const name of GROUPS) {
      const option = el('option', null, name);
      option.value = name;
      select.append(option);
    }
    groupWrap.append(select);

    const results = el('div', 'search-results hidden');
    body.append(login.wrap, groupWrap, results);
    const hint = el('p', 'form-note');
    hint.style.textAlign = 'left';
    hint.textContent = 'Подсказка: логин виден в профиле друга, например @bob.';
    body.append(hint);

    let searchTimer = null;
    login.input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const query = login.input.value.trim();
      if (query.length < 2) {
        results.classList.add('hidden');
        results.innerHTML = '';
        return;
      }
      searchTimer = setTimeout(async () => {
        try {
          const data = await api('/api/search?q=' + encodeURIComponent(query));
          results.innerHTML = '';
          if (!data.users.length) {
            results.append(el('div', 'contact-empty', 'Никого не нашли — проверьте логин.'));
          }
          for (const user of data.users) {
            const button = el('button', 'search-result');
            button.type = 'button';
            button.append(avatarNode(user, 'sm'));
            const box = el('div');
            box.append(el('b', null, user.displayName));
            box.append(el('small', null, '@' + user.login + (user.isContact ? ' · уже в контактах' : '')));
            button.append(box);
            button.addEventListener('click', () => {
              login.input.value = user.login;
              results.classList.add('hidden');
              login.input.focus();
            });
            results.append(button);
          }
          results.classList.remove('hidden');
        } catch (err) { /* тихо */ }
      }, 300);
    });

    openModal({
      title: 'Добавить контакт',
      body,
      actions: [
        { label: 'Отмена' },
        {
          label: 'Добавить',
          primary: true,
          onClick: async () => {
            const value = login.input.value.trim();
            if (!value) {
              toast('Введите логин', 'Например: bob', { icon: '✍️' });
              return false;
            }
            const data = await api('/api/contacts', {
              method: 'POST',
              body: { login: value, group: select.value },
            });
            setContacts(data.contacts || []);
            if (data.added) toast('Контакт добавлен', `@${data.contact.login} теперь в списке`, { icon: '✅' });
            else toast('Уже в контактах', `@${data.contact.login} уже есть в вашем списке`, { icon: 'ℹ️' });
            Sound.online();
            openChat(data.contact.id);
            return true;
          },
        },
      ],
    });
  }

  function openSettings() {
    if (!S.me) return;
    let avatar = S.me.avatar;
    const body = document.createDocumentFragment();
    const name = field('Отображаемое имя', { value: S.me.displayName, maxlength: 32 });

    const avatarBlock = el('div', 'field');
    avatarBlock.append(el('span', null, 'Аватар'));
    const grid = el('div', 'avatar-grid');
    for (const emoji of AVATARS) {
      const button = el('button', emoji, emoji);
      button.type = 'button';
      button.classList.toggle('selected', emoji === avatar);
      button.addEventListener('click', () => {
        avatar = emoji;
        for (const item of grid.querySelectorAll('button')) item.classList.toggle('selected', item.textContent === emoji);
      });
      grid.append(button);
    }
    avatarBlock.append(grid);

    const statusText = field('Статусное сообщение', {
      value: S.me.statusText || '',
      maxlength: 80,
      placeholder: 'Что нового?',
    });

    body.append(name.wrap, avatarBlock, statusText.wrap);

    openModal({
      title: 'Настройки профиля',
      body,
      actions: [
        { label: 'Отмена' },
        {
          label: 'Сохранить',
          primary: true,
          onClick: async () => {
            const data = await api('/api/me', {
              method: 'PATCH',
              body: {
                displayName: name.input.value.trim() || S.me.login,
                avatar,
                statusText: statusText.input.value,
              },
            });
            S.me = { ...S.me, ...data.user };
            renderMe();
            toast('Профиль обновлён', null, { icon: '✅' });
            return true;
          },
        },
      ],
    });
  }

  function openHelp() {
    const body = el('div');
    const lines = [
      ['💬', 'Беседа', 'Щёлкните по контакту — откроется окно. Enter — отправить, Shift+Enter — новая строка.'],
      ['⚡', 'Nudge', 'Кнопка в шапке беседы: окно собеседника вздрогнет и проиграет звук. Не чаще раза в 12 секунд.'],
      ['😊', 'Смайлики', 'Классика MSN: :) :D ;) :( :P (H) (A) (6) <3 (F) (C) (D) (Y) (N) (L) (U) (K) (T) (S) (Z) (X) (*).'],
      ['🟢', 'Статусы', 'В сети, Нет на месте, Не беспокоить, Невидимка. Виден контактам в реальном времени.'],
      ['⌨️', 'Терминал', 'Тот же сервер и аккаунт доступны из консоли: node tui.js'],
    ];
    for (const [icon, title, text] of lines) {
      const row = el('div');
      row.style.display = 'grid';
      row.style.gridTemplateColumns = '26px 1fr';
      row.style.gap = '8px';
      row.style.marginBottom = '12px';
      row.append(el('div', null, icon));
      const box = el('div');
      box.append(el('b', null, title));
      const p = el('div', null, text);
      p.style.fontSize = '12px';
      p.style.color = 'var(--ink-soft)';
      p.style.marginTop = '2px';
      box.append(p);
      row.append(box);
      body.append(row);
    }
    openModal({ title: 'Как пользоваться Motyl', body, actions: [{ label: 'Понятно', primary: true }] });
  }

  function openLogout() {
    openModal({
      title: 'Выход',
      body: 'Выйти из Motyl на этом устройстве? Можно вернуться в любой момент.',
      actions: [
        { label: 'Остаться' },
        {
          label: 'Выйти',
          primary: true,
          onClick: async () => {
            try { await api('/api/logout', { method: 'POST' }); } catch (err) { /* ignore */ }
            forceLogout();
            return true;
          },
        },
      ],
    });
  }

  // ── Контекстное меню ────────────────────────────────────────────────────

  function closeMenus() {
    if (S.menu) {
      S.menu.remove();
      S.menu = null;
    }
  }

  function showContactMenu(contact, x, y) {
    closeMenus();
    const menu = el('div', 'ctx-menu');

    const chatBtn = el('button', null, '💬  Написать');
    chatBtn.type = 'button';
    chatBtn.addEventListener('click', () => { closeMenus(); openChat(contact.id); });
    menu.append(chatBtn);

    const copyBtn = el('button', null, '📋  Скопировать логин');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', async () => {
      closeMenus();
      try {
        await navigator.clipboard.writeText(contact.login);
        toast('Логин скопирован', '@' + contact.login, { icon: '📋' });
      } catch (err) {
        window.prompt('Логин', contact.login);
      }
    });
    menu.append(copyBtn);

    if (!contact.system) {
      menu.append(el('div', 'ctx-sep'));
      const removeBtn = el('button', 'danger', '🗑  Удалить контакт');
      removeBtn.type = 'button';
      removeBtn.addEventListener('click', () => {
        closeMenus();
        openModal({
          title: 'Удалить контакт?',
          body: `@${contact.login} исчезнет из списка. История беседы сохранится.`,
          actions: [
            { label: 'Отмена' },
            {
              label: 'Удалить',
              primary: true,
              onClick: async () => {
                const data = await api('/api/contacts/' + encodeURIComponent(contact.id), { method: 'DELETE' });
                setContacts(data.contacts || []);
                const chat = S.chats.get(contact.id);
                if (chat) closeChat(chat);
                toast('Контакт удалён', '@' + contact.login, { icon: '🗑' });
                return true;
              },
            },
          ],
        });
      });
      menu.append(removeBtn);
    }

    document.body.append(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
    S.menu = menu;
  }

  // ── Тосты ───────────────────────────────────────────────────────────────

  function toast(title, text, options = {}) {
    const node = el('div', 'toast' + (options.system ? ' system' : ''));
    node.append(el('div', 'toast-icon', options.icon || '💬'));
    const body = el('div');
    if (text) {
      body.append(el('b', 'toast-title', title));
      body.append(el('div', 'toast-text', String(text)));
    } else {
      body.append(el('div', 'toast-text', String(title)));
    }
    node.append(body);
    $('#toasts').append(node);

    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      node.classList.add('out');
      setTimeout(() => node.remove(), 220);
    };
    node.addEventListener('click', () => {
      if (options.onClick) options.onClick();
      remove();
    });
    setTimeout(remove, options.timeout || 5200);
  }

  // ── Глобальные обработчики ──────────────────────────────────────────────

  function updateClock() {
    const now = new Date();
    $('#clock').textContent = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  function bindGlobal() {
    $$('.auth-tab').forEach((button) => {
      button.addEventListener('click', () => setAuthTab(button.dataset.tab));
    });
    $$('[data-tab-link]').forEach((button) => {
      button.addEventListener('click', () => setAuthTab(button.dataset.tabLink));
    });

    $('#login-form').addEventListener('submit', (event) => {
      event.preventDefault();
      submitAuth('login', event.currentTarget);
    });
    $('#register-form').addEventListener('submit', (event) => {
      event.preventDefault();
      submitAuth('register', event.currentTarget);
    });

    $('#status-select').addEventListener('change', (event) => sendStatus({ status: event.target.value }));

    const statusInput = $('#status-text');
    statusInput.addEventListener('change', () => sendStatus({ statusText: statusInput.value.trim() }));
    statusInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        statusInput.blur();
      }
    });

    $('#me-avatar').addEventListener('click', openSettings);
    $('#btn-settings').addEventListener('click', openSettings);
    $('#btn-settings-top').addEventListener('click', openSettings);
    $('#btn-add').addEventListener('click', () => openAddContact());
    $('#btn-help').addEventListener('click', openHelp);
    $('#btn-logout').addEventListener('click', openLogout);

    $('#contact-filter').addEventListener('input', (event) => {
      S.filter = event.target.value;
      renderContacts();
    });

    document.addEventListener('pointerdown', (event) => {
      if (S.menu && !event.target.closest('.ctx-menu')) closeMenus();
      for (const chat of S.chats.values()) {
        if (chat.emojiEl && !event.target.closest('.emoji-pop') && !event.target.closest('.emoji-btn')) {
          closeEmojiPicker(chat);
        }
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeMenus();
        closeModal();
        for (const chat of S.chats.values()) closeEmojiPicker(chat);
      }
    });

    window.addEventListener('focus', () => {
      stopTitleFlash();
      const chat = S.chats.get(S.active);
      if (chat && chat.open && !chat.minimized) markChatRead(chat);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hasFocus()) {
        stopTitleFlash();
        const chat = S.chats.get(S.active);
        if (chat && chat.open && !chat.minimized) markChatRead(chat);
      }
    });

    window.addEventListener('resize', () => {
      for (const chat of S.chats.values()) {
        if (!chat.el) continue;
        const maxLeft = Math.max(0, desktopEl.clientWidth - chat.el.offsetWidth);
        const maxTop = Math.max(0, desktopEl.clientHeight - chat.el.offsetHeight - 6);
        chat.el.style.left = Math.min(chat.el.offsetLeft, maxLeft) + 'px';
        chat.el.style.top = Math.min(chat.el.offsetTop, maxTop) + 'px';
        chat.pos = { left: chat.el.offsetLeft, top: chat.el.offsetTop };
      }
    });

    updateClock();
    setInterval(updateClock, 15000);
  }

  function stopTitleFlash() {
    if (S.flashTimer) {
      clearInterval(S.flashTimer);
      S.flashTimer = null;
    }
    document.title = S.baseTitle;
  }

  // ── Старт ───────────────────────────────────────────────────────────────

  async function init() {
    bindGlobal();
    setAuthTab('login');
    checkHealth();

    if (S.token) {
      try {
        await enterApp();
      } catch (err) {
        localStorage.removeItem('motyl.token');
        S.token = '';
        showAuth();
      }
    } else {
      showAuth();
    }
  }

  init();
})();
