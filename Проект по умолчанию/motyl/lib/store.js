'use strict';

/**
 * Простое хранилище на JSON-файле: пользователи, сессии, контакты, сообщения.
 * Запись атомарная (tmp + rename), с дебаунсом, чтобы не бить диск на каждое сообщение.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 дней
const MAX_MESSAGES = 100000;

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function convKey(a, b) {
  return [a, b].sort().join('|');
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = this._empty();
    this._saveTimer = null;
    this._dirty = false;
    this.load();
  }

  _empty() {
    return {
      version: 1,
      createdAt: Date.now(),
      users: {},
      sessions: {},
      contacts: {},
      messages: [],
      meta: {},
    };
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { ...this._empty(), ...parsed };
      for (const key of ['users', 'sessions', 'contacts']) {
        if (!this.data[key] || typeof this.data[key] !== 'object') this.data[key] = {};
      }
      if (!Array.isArray(this.data.messages)) this.data.messages = [];
    } catch (err) {
      if (err.code !== 'ENOENT') {
        const stamp = Date.now();
        const backup = `${this.file}.corrupt-${stamp}`;
        try {
          fs.mkdirSync(path.dirname(this.file), { recursive: true });
          fs.copyFileSync(this.file, backup);
          console.warn(`[store] Повреждённый файл данных сохранён как ${backup}`);
        } catch (copyErr) { /* ignore */ }
      }
      this.data = this._empty();
    }
    this._pruneSessions();
  }

  _pruneSessions() {
    const now = Date.now();
    let changed = false;
    for (const [token, session] of Object.entries(this.data.sessions)) {
      if (!session || now - (session.createdAt || 0) > SESSION_TTL) {
        delete this.data.sessions[token];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  save(immediate = false) {
    this._dirty = true;
    if (immediate) {
      this.flush();
      return;
    }
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flush();
    }, 150);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  flush() {
    if (!this._dirty) return;
    this._dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] Не удалось сохранить данные:', err.message);
    }
  }

  // ── Пользователи ────────────────────────────────────────────────────────

  allUsers() {
    return Object.values(this.data.users);
  }

  getUser(id) {
    return this.data.users[id] || null;
  }

  findByLogin(login) {
    const needle = String(login || '').trim().toLowerCase();
    if (!needle) return null;
    return this.allUsers().find((u) => u.loginLower === needle) || null;
  }

  createUser({ login, password, displayName, avatar }) {
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: crypto.randomUUID(),
      login,
      loginLower: String(login).toLowerCase(),
      displayName: displayName || login,
      avatar: avatar || '🦋',
      salt,
      passHash: hashPassword(password, salt),
      status: 'online',
      statusText: '',
      system: false,
      createdAt: Date.now(),
      lastSeen: Date.now(),
    };
    this.data.users[user.id] = user;
    this.save();
    return user;
  }

  updateUser(id, patch) {
    const user = this.getUser(id);
    if (!user) return null;
    const allowed = ['displayName', 'avatar', 'status', 'statusText', 'lastSeen', 'system'];
    for (const key of allowed) {
      if (patch[key] !== undefined) user[key] = patch[key];
    }
    this.save();
    return user;
  }

  verifyPassword(user, password) {
    if (!user) return false;
    return safeEqual(hashPassword(password, user.salt), user.passHash);
  }

  // ── Сессии ──────────────────────────────────────────────────────────────

  createSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.data.sessions[token] = { userId, createdAt: Date.now() };
    this.save();
    return token;
  }

  getSession(token) {
    const session = this.data.sessions[token];
    if (!session) return null;
    if (Date.now() - session.createdAt > SESSION_TTL) {
      delete this.data.sessions[token];
      this.save();
      return null;
    }
    return session;
  }

  deleteSession(token) {
    if (this.data.sessions[token]) {
      delete this.data.sessions[token];
      this.save();
      return true;
    }
    return false;
  }

  // ── Контакты ────────────────────────────────────────────────────────────

  contactsOf(userId) {
    return (this.data.contacts[userId] || []).map((c) => ({ ...c }));
  }

  hasContact(ownerId, otherId) {
    return (this.data.contacts[ownerId] || []).some((c) => c.id === otherId);
  }

  addContact(ownerId, otherId, group = 'Друзья') {
    if (!ownerId || !otherId || ownerId === otherId) return false;
    if (!this.getUser(otherId)) return false;
    const list = this.data.contacts[ownerId] || (this.data.contacts[ownerId] = []);
    if (list.some((c) => c.id === otherId)) return false;
    list.push({ id: otherId, group: group || 'Друзья', since: Date.now() });
    this.save();
    return true;
  }

  removeContact(ownerId, otherId) {
    const list = this.data.contacts[ownerId];
    if (!list) return false;
    const before = list.length;
    this.data.contacts[ownerId] = list.filter((c) => c.id !== otherId);
    if (this.data.contacts[ownerId].length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  setContactGroup(ownerId, otherId, group) {
    const list = this.data.contacts[ownerId];
    if (!list) return false;
    const contact = list.find((c) => c.id === otherId);
    if (!contact) return false;
    contact.group = String(group || 'Друзья').slice(0, 32) || 'Друзья';
    this.save();
    return true;
  }

  /** Кто должен видеть присутствие пользователя: его контакты + те, у кого он в контактах. */
  relatedTo(userId) {
    const ids = new Set(this.contactsOf(userId).map((c) => c.id));
    for (const [ownerId, list] of Object.entries(this.data.contacts)) {
      if (ownerId !== userId && list.some((c) => c.id === userId)) ids.add(ownerId);
    }
    return ids;
  }

  // ── Сообщения ───────────────────────────────────────────────────────────

  addMessage({ from, to, text }) {
    const message = {
      id: crypto.randomUUID(),
      conv: convKey(from, to),
      from,
      to,
      text: String(text),
      ts: Date.now(),
      readAt: null,
    };
    this.data.messages.push(message);
    if (this.data.messages.length > MAX_MESSAGES) {
      this.data.messages.splice(0, this.data.messages.length - MAX_MESSAGES);
    }
    this.save();
    return message;
  }

  history(a, b, { limit = 80, before = 0 } = {}) {
    const conv = convKey(a, b);
    const result = [];
    for (let i = this.data.messages.length - 1; i >= 0; i--) {
      const m = this.data.messages[i];
      if (m.conv !== conv) continue;
      if (before && m.ts >= before) continue;
      result.push(m);
      if (result.length >= limit) break;
    }
    return result.reverse();
  }

  markRead(toId, fromId, at = Date.now()) {
    const conv = convKey(toId, fromId);
    let count = 0;
    for (const m of this.data.messages) {
      if (m.conv === conv && m.to === toId && m.from === fromId && !m.readAt) {
        m.readAt = at;
        count++;
      }
    }
    if (count) this.save();
    return count;
  }

  unreadCount(userId, fromId) {
    const conv = convKey(userId, fromId);
    let count = 0;
    for (const m of this.data.messages) {
      if (m.conv === conv && m.to === userId && m.from === fromId && !m.readAt) count++;
    }
    return count;
  }

  unreadTotal(userId) {
    let count = 0;
    for (const m of this.data.messages) {
      if (m.to === userId && !m.readAt) count++;
    }
    return count;
  }

  messageCount() {
    return this.data.messages.length;
  }
}

module.exports = { Store, convKey, hashPassword };
