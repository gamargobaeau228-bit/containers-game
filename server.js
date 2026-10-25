const express = require('express');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');

// ---------- Настройки (через переменные окружения) ----------
const BOT_TOKEN = process.env.8775016272:AAH8-m0yRKYtchh5MsiMF1nkG56hc3Ai_8g || '';          // токен от @BotFather
const BOT_USERNAME = process.env.BOT_USERNAME || '';    // username бота без @
const APP_NAME = process.env.APP_NAME || '';            // короткое имя Mini App из /newapp
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || 'game.db';
const DEV = !8775016272:AAH8-m0yRKYtchh5MsiMF1nkG56hc3Ai_8g; // без токена работает тестовый режим (только для компьютера)

const START_COINS = 1000;
const REF_BONUS = 500;
const FREE_COOLDOWN_MS = 4 * 60 * 60 * 1000; // бесплатный контейнер раз в 4 часа
const MAX_OFFLINE_HOURS = 12;                // сколько часов копится доход без захода

// ---------- КОНТЕНТ: меняйте тему здесь ----------
// value = цена предмета. Продажа = 50% цены. Доход в час = value / 50.
const ITEMS = [
  { id: 'wrench',  name: 'Гаечный ключ', emoji: '🔧', rarity: 'common',    value: 20 },
  { id: 'box',     name: 'Коробка',      emoji: '📦', rarity: 'common',    value: 30 },
  { id: 'flash',   name: 'Фонарик',      emoji: '🔦', rarity: 'common',    value: 40 },
  { id: 'phones',  name: 'Наушники',     emoji: '🎧', rarity: 'uncommon',  value: 120 },
  { id: 'watch',   name: 'Часы',         emoji: '⌚', rarity: 'uncommon',  value: 200 },
  { id: 'camera',  name: 'Камера',       emoji: '📷', rarity: 'uncommon',  value: 300 },
  { id: 'laptop',  name: 'Ноутбук',      emoji: '💻', rarity: 'rare',      value: 800 },
  { id: 'console', name: 'Консоль',      emoji: '🎮', rarity: 'rare',      value: 1200 },
  { id: 'drone',   name: 'Дрон',         emoji: '🚁', rarity: 'rare',      value: 1500 },
  { id: 'car',     name: 'Спорткар',     emoji: '🏎️', rarity: 'epic',      value: 5000 },
  { id: 'diamond', name: 'Алмаз',        emoji: '💎', rarity: 'epic',      value: 8000 },
  { id: 'crown',   name: 'Корона',       emoji: '👑', rarity: 'legendary', value: 30000 },
  { id: 'rocket',  name: 'Ракета',       emoji: '🚀', rarity: 'legendary', value: 60000 },
];

// Шансы выпадения редкости (в условных долях, нормализуются автоматически)
const CONTAINERS = {
  basic:     { name: 'Обычный контейнер',     emoji: '📦', price: 100,  weights: { common: 70, uncommon: 24, rare: 5,  epic: 0.5, legendary: 0.02 } },
  rare:      { name: 'Редкий контейнер',      emoji: '🧰', price: 500,  weights: { common: 35, uncommon: 40, rare: 20, epic: 4.5, legendary: 0.1 } },
  legendary: { name: 'Легендарный контейнер', emoji: '🏆', price: 2500, weights: { common: 10, uncommon: 35, rare: 40, epic: 14,  legendary: 1 } },
};
// ---------------------------------------------------

const ITEM_BY_ID = Object.fromEntries(ITEMS.map(i => [i.id, i]));
const incomePerHour = value => Math.max(1, Math.round(value / 50));
const sellPrice = value => Math.floor(value / 2);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  coins INTEGER NOT NULL DEFAULT ${START_COINS},
  streak INTEGER NOT NULL DEFAULT 0,
  last_daily TEXT,
  last_free INTEGER NOT NULL DEFAULT 0,
  last_collect INTEGER NOT NULL,
  referrer INTEGER,
  refs INTEGER NOT NULL DEFAULT 0,
  opened INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  value INTEGER NOT NULL,
  got INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS inv_user ON inventory(user_id);
`);

// ---------- Проверка подписи Telegram ----------
function validateInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (Date.now() / 1000 - authDate > 24 * 3600) return null; // подпись старше суток
  try {
    const user = JSON.parse(params.get('user'));
    return { user, startParam: params.get('start_param') || '' };
  } catch {
    return null;
  }
}

function auth(req, res, next) {
  if (DEV) {
    const id = parseInt(req.headers['x-dev-user'] || '1', 10) || 1;
    req.tg = { id, name: 'Dev' + id, startParam: req.body?.ref ? 'ref_' + req.body.ref : '' };
    return next();
  }
  const v = validateInitData(req.headers['x-init-data']);
  if (!v) return res.status(401).json({ error: 'Откройте игру через Telegram' });
  const name = [v.user.first_name, v.user.last_name].filter(Boolean).join(' ') || v.user.username || 'Игрок';
  req.tg = { id: v.user.id, name: name.slice(0, 40), startParam: v.startParam };
  next();
}

// ---------- Логика ----------
const getUser = id => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

function ensureUser(tg) {
  let u = getUser(tg.id);
  if (u) return u;
  const now = Date.now();
  let referrer = null;
  const m = /^ref_(\d+)$/.exec(tg.startParam || '');
  if (m) {
    const rid = Number(m[1]);
    if (rid !== tg.id && getUser(rid)) referrer = rid;
  }
  db.transaction(() => {
    db.prepare('INSERT INTO users (id, name, coins, last_collect, referrer, created) VALUES (?, ?, ?, ?, ?, ?)')
      .run(tg.id, tg.name, START_COINS + (referrer ? REF_BONUS : 0), now, referrer, now);
    if (referrer) {
      db.prepare('UPDATE users SET coins = coins + ?, refs = refs + 1 WHERE id = ?').run(REF_BONUS, referrer);
    }
  })();
  return getUser(tg.id);
}

function hourlyIncome(userId) {
  const rows = db.prepare('SELECT value FROM inventory WHERE user_id = ?').all(userId);
  return rows.reduce((s, r) => s + incomePerHour(r.value), 0);
}

function pendingIncome(u) {
  const hours = Math.min(MAX_OFFLINE_HOURS, (Date.now() - u.last_collect) / 3600000);
  return Math.floor(hourlyIncome(u.id) * hours);
}

// Начислить накопленный доход на баланс (вызывается перед любым изменением коллекции)
function settle(userId) {
  const u = getUser(userId);
  const pending = pendingIncome(u);
  db.prepare('UPDATE users SET coins = coins + ?, last_collect = ? WHERE id = ?').run(pending, Date.now(), userId);
  return pending;
}

function roll(weights) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let r = crypto.randomInt(0, 1_000_000) / 1_000_000 * total;
  let rarity = 'common';
  for (const [k, w] of Object.entries(weights)) {
    if (r < w) { rarity = k; break; }
    r -= w;
  }
  const pool = ITEMS.filter(i => i.rarity === rarity);
  return pool[crypto.randomInt(0, pool.length)];
}

function buildState(userId) {
  const u = getUser(userId);
  const inv = db.prepare('SELECT id, item_id FROM inventory WHERE user_id = ? ORDER BY value DESC, id DESC').all(userId);
  const today = new Date().toISOString().slice(0, 10);
  const refLink = BOT_USERNAME
    ? `https://t.me/${BOT_USERNAME}${APP_NAME ? '/' + APP_NAME : ''}?startapp=ref_${u.id}`
    : '';
  return {
    me: { id: u.id, name: u.name, coins: u.coins, opened: u.opened, refs: u.refs, streak: u.streak },
    inventory: inv.map(r => ({ id: r.id, item: r.item_id })),
    income: { perHour: hourlyIncome(userId), pending: pendingIncome(u), maxHours: MAX_OFFLINE_HOURS },
    freeInMs: Math.max(0, u.last_free + FREE_COOLDOWN_MS - Date.now()),
    dailyReady: u.last_daily !== today,
    refLink,
    refBonus: REF_BONUS,
    catalog: ITEMS.map(i => ({ ...i, sell: sellPrice(i.value), perHour: incomePerHour(i.value) })),
    containers: Object.entries(CONTAINERS).map(([id, c]) => ({ id, name: c.name, emoji: c.emoji, price: c.price })),
  };
}

// ---------- API ----------
const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/state', auth, (req, res) => {
  ensureUser(req.tg);
  res.json(buildState(req.tg.id));
});

app.post('/api/open', auth, (req, res) => {
  ensureUser(req.tg);
  const { container } = req.body || {};
  const isFree = container === 'free';
  const c = isFree ? CONTAINERS.basic : CONTAINERS[container];
  if (!c) return res.status(400).json({ error: 'Неизвестный контейнер' });
  try {
    const result = db.transaction(() => {
      settle(req.tg.id);
      const u = getUser(req.tg.id);
      if (isFree) {
        if (Date.now() - u.last_free < FREE_COOLDOWN_MS) throw new Error('Бесплатный контейнер ещё не готов');
        db.prepare('UPDATE users SET last_free = ? WHERE id = ?').run(Date.now(), u.id);
      } else {
        if (u.coins < c.price) throw new Error('Не хватает монет');
        db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(c.price, u.id);
      }
      const item = roll(c.weights);
      const info = db.prepare('INSERT INTO inventory (user_id, item_id, value, got) VALUES (?, ?, ?, ?)')
        .run(u.id, item.id, item.value, Date.now());
      db.prepare('UPDATE users SET opened = opened + 1 WHERE id = ?').run(u.id);
      return { invId: Number(info.lastInsertRowid), itemId: item.id };
    })();
    res.json({ won: result, state: buildState(req.tg.id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/sell', auth, (req, res) => {
  ensureUser(req.tg);
  const invId = Number(req.body?.id);
  try {
    db.transaction(() => {
      settle(req.tg.id);
      const row = db.prepare('SELECT * FROM inventory WHERE id = ? AND user_id = ?').get(invId, req.tg.id);
      if (!row) throw new Error('Предмет не найден');
      db.prepare('DELETE FROM inventory WHERE id = ?').run(invId);
      db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(sellPrice(row.value), req.tg.id);
    })();
    res.json({ state: buildState(req.tg.id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/collect', auth, (req, res) => {
  ensureUser(req.tg);
  const got = db.transaction(() => settle(req.tg.id))();
  res.json({ got, state: buildState(req.tg.id) });
});

app.post('/api/daily', auth, (req, res) => {
  ensureUser(req.tg);
  try {
    const reward = db.transaction(() => {
      const u = getUser(req.tg.id);
      const today = new Date().toISOString().slice(0, 10);
      if (u.last_daily === today) throw new Error('Бонус уже получен сегодня');
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const streak = u.last_daily === yesterday ? u.streak + 1 : 1;
      const reward = 100 * Math.min(streak, 7);
      db.prepare('UPDATE users SET coins = coins + ?, streak = ?, last_daily = ? WHERE id = ?')
        .run(reward, streak, today, u.id);
      return reward;
    })();
    res.json({ reward, state: buildState(req.tg.id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/top', auth, (req, res) => {
  ensureUser(req.tg);
  const rows = db.prepare(`
    SELECT u.id, u.name, u.coins + COALESCE(SUM(i.value), 0) AS wealth
    FROM users u LEFT JOIN inventory i ON i.user_id = u.id
    GROUP BY u.id ORDER BY wealth DESC LIMIT 20
  `).all();
  res.json({ top: rows.map(r => ({ name: r.name, wealth: r.wealth, me: r.id === req.tg.id })) });
});

app.listen(PORT, () => {
  console.log(`Игра запущена: http://localhost:${PORT}` + (DEV ? '  (тестовый режим, BOT_TOKEN не задан)' : ''));
});
