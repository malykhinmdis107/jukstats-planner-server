// ============================================================
// JUKSTATS PLANNER SERVER - Единый файл
// Версия: 1.0.0
// ============================================================

'use strict';

// ============================ ЗАВИСИМОСТИ ============================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const admin = require('firebase-admin');

// ============================ ПРОВЕРКА .ENV ============================
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';
const LESTA_APP_ID = process.env.LESTA_APP_ID || '0d89e594d5374a4eec6f3a671c80ed52';
const LESTA_API_BASE = process.env.LESTA_API_BASE || 'https://papi.tanksblitz.ru/wotb';

if (!JWT_SECRET) {
  console.error('❌ Ошибка: JWT_SECRET не задан в .env');
  process.exit(1);
}

// ============================ FIREBASE INIT ============================
let firebaseCred = null;
if (process.env.FIREBASE_CRED_JSON) {
  try {
    firebaseCred = JSON.parse(process.env.FIREBASE_CRED_JSON);
  } catch (e) {
    console.error('❌ Ошибка парсинга FIREBASE_CRED_JSON:', e.message);
    process.exit(1);
  }
} else if (process.env.FIREBASE_CRED_FILE) {
  try {
    firebaseCred = require(process.env.FIREBASE_CRED_FILE);
  } catch (e) {
    console.error('❌ Ошибка загрузки FIREBASE_CRED_FILE:', e.message);
    process.exit(1);
  }
} else {
  console.error('❌ Ошибка: Нет FIREBASE_CRED_JSON или FIREBASE_CRED_FILE в .env');
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(firebaseCred) });
}

const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

// ============================ КОНСТАНТЫ ============================
const COL = {
  USERS: 'users',
  MEMBERS: 'members',
  BRIEFINGS: 'briefings',
  SLIDES: 'slides',
  ENTITIES: 'entities',
};

const FV = admin.firestore.FieldValue;
const TOKEN_TTL = '14d';

// ============================ AUTH HELPER ============================
function signToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, isGuest: !!user.isGuest },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no_token' });
  try {
    req.user = verifyToken(token);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'bad_token' });
  }
}

async function validateLesta(accessToken, accountId) {
  const url = `${LESTA_API_BASE}/account/info/?application_id=${LESTA_APP_ID}&account_id=${accountId}&access_token=${encodeURIComponent(accessToken)}&fields=nickname`;
  const r = await fetch(url);
  const data = await r.json();
  if (data && data.status === 'ok' && data.data && data.data[String(accountId)]) {
    return data.data[String(accountId)];
  }
  return null;
}

async function upsertUser(id, name, isGuest) {
  const ref = db.collection(COL.USERS).doc(String(id));
  const snap = await ref.get();
  const now = admin.firestore.FieldValue.serverTimestamp();
  if (!snap.exists) {
    await ref.set({ id: String(id), name: name || String(id), isGuest: !!isGuest, createdAt: now, updatedAt: now });
  } else {
    await ref.update({ name: name || snap.get('name'), isGuest: !!isGuest, updatedAt: now });
  }
  const fresh = await ref.get();
  return fresh.data();
}

async function getBriefing(briefingId) {
  const s = await db.collection(COL.BRIEFINGS).doc(briefingId).get();
  return s.exists ? s.data() : null;
}

async function getMember(briefingId, userId) {
  const s = await db.collection(COL.MEMBERS).doc(`${briefingId}__${userId}`).get();
  return s.exists ? s.data() : null;
}

async function getRole(briefingId, userId) {
  const b = await getBriefing(briefingId);
  if (!b) return null;
  if (String(b.ownerId) === String(userId)) return 'owner';
  const m = await getMember(briefingId, userId);
  return m ? m.role : null;
}

function canEditRole(role) { return role === 'owner' || role === 'editor'; }

async function slideBriefing(slideId) {
  const s = await db.collection(COL.SLIDES).doc(slideId).get();
  return s.exists ? s.data() : null;
}

async function guardEdit(slideId, userId) {
  const sl = await slideBriefing(slideId);
  if (!sl) return { code: 404 };
  const role = await getRole(sl.briefingId, userId);
  if (!canEditRole(role)) return { code: 403 };
  return { code: 200, sl };
}

// ============================ EXPRESS APP ============================
const app = express();
app.use(cors({
  origin: CLIENT_ORIGIN,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '4mb' }));

// ============================ HEALTH ============================
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ============================ ROUTES ============================

// ---------- AUTH ----------
app.post('/api/auth/lesta', async (req, res) => {
  try {
    const { accessToken, accountId, nickname } = req.body || {};
    if (!accessToken || !accountId) return res.status(400).json({ error: 'missing_fields' });
    const info = await validateLesta(accessToken, accountId);
    if (!info) return res.status(401).json({ error: 'lesta_rejected' });
    const name = nickname || (info && info.nickname) || ('Игрок_' + accountId);
    const user = await upsertUser(accountId, name, false);
    const token = signToken(user);
    res.json({ token, user });
  } catch (e) {
    console.error('auth/lesta', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/auth/guest', async (req, res) => {
  try {
    const { localId, name } = req.body || {};
    if (!localId) return res.status(400).json({ error: 'missing_localId' });
    const user = await upsertUser(localId, name || 'Гость', true);
    const token = signToken(user);
    res.json({ token, user });
  } catch (e) {
    console.error('auth/guest', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const s = await db.collection(COL.USERS).doc(String(req.user.id)).get();
  res.json({ user: s.exists ? s.data() : { id: req.user.id, name: req.user.name, isGuest: req.user.isGuest } });
});

// ---------- USERS ----------
app.get('/api/users/:id', requireAuth, async (req, res) => {
  const s = await db.collection(COL.USERS).doc(String(req.params.id)).get();
  if (!s.exists) return res.status(404).json({ error: 'not_found' });
  res.json({ user: s.data() });
});

// ---------- BRIEFINGS ----------
app.post('/api/briefings', requireAuth, async (req, res) => {
  try {
    const title = (req.body && req.body.title) || 'Безымянный брифинг';
    const bRef = db.collection(COL.BRIEFINGS).doc();
    const sRef = db.collection(COL.SLIDES).doc();
    const mRef = db.collection(COL.MEMBERS).doc(`${bRef.id}__${req.user.id}`);
    const now = FV.serverTimestamp();

    await db.runTransaction(async tx => {
      tx.set(bRef, { id: bRef.id, ownerId: String(req.user.id), title, notes: '', createdAt: now, updatedAt: now });
      tx.set(mRef, { id: mRef.id, briefingId: bRef.id, userId: String(req.user.id), role: 'owner', joinedAt: now });
      tx.set(sRef, { id: sRef.id, briefingId: bRef.id, name: 'Этап', mapId: 'molen', order: 0, createdAt: now });
    });

    res.json({ briefing: { id: bRef.id, ownerId: String(req.user.id), title, notes: '' }, slide: { id: sRef.id, name: 'Этап', mapId: 'molen', order: 0 } });
  } catch (e) {
    console.error('POST /briefings', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/briefings/mine', requireAuth, async (req, res) => {
  const snap = await db.collection(COL.BRIEFINGS).where('ownerId', '==', String(req.user.id)).get();
  const list = [];
  for (const d of snap.docs) {
    const b = d.data();
    const slides = await db.collection(COL.SLIDES).where('briefingId', '==', b.id).get();
    const slideArr = slides.docs.map(x => x.data()).sort((a, c) => (a.order || 0) - (c.order || 0));
    list.push({
      id: b.id, title: b.title, notes: b.notes, updatedAt: b.updatedAt, createdAt: b.createdAt,
      slideCount: slideArr.length,
      firstMap: slideArr[0] ? slideArr[0].mapId : null,
    });
  }
  res.json({ briefings: list });
});

app.get('/api/briefings/:id', requireAuth, async (req, res) => {
  const role = await getRole(req.params.id, req.user.id);
  if (!role) return res.status(403).json({ error: 'forbidden' });
  const b = await getBriefing(req.params.id);

  const mSnap = await db.collection(COL.MEMBERS).where('briefingId', '==', req.params.id).get();
  const members = mSnap.docs.map(x => x.data());

  const sSnap = await db.collection(COL.SLIDES).where('briefingId', '==', req.params.id).get();
  const slides = sSnap.docs.map(x => x.data()).sort((a, c) => (a.order || 0) - (c.order || 0));

  res.json({ briefing: b, members, slides, myRole: role });
});

app.patch('/api/briefings/:id', requireAuth, async (req, res) => {
  const role = await getRole(req.params.id, req.user.id);
  if (!canEditRole(role)) return res.status(403).json({ error: 'forbidden' });
  const upd = { updatedAt: FV.serverTimestamp() };
  if (typeof req.body.title === 'string') upd.title = req.body.title;
  if (typeof req.body.notes === 'string') upd.notes = req.body.notes;
  await db.collection(COL.BRIEFINGS).doc(req.params.id).update(upd);
  res.json({ ok: true });
});

app.delete('/api/briefings/:id', requireAuth, async (req, res) => {
  const role = await getRole(req.params.id, req.user.id);
  if (role !== 'owner') return res.status(403).json({ error: 'forbidden' });
  const bid = req.params.id;

  const sSnap = await db.collection(COL.SLIDES).where('briefingId', '==', bid).get();
  const slideIds = sSnap.docs.map(x => x.id);

  await db.runTransaction(async tx => {
    for (const sid of slideIds) {
      const eSnap = await db.collection(COL.ENTITIES).where('slideId', '==', sid).get();
      eSnap.docs.forEach(e => tx.delete(e.ref));
      tx.delete(db.collection(COL.SLIDES).doc(sid));
    }
    const mSnap = await db.collection(COL.MEMBERS).where('briefingId', '==', bid).get();
    mSnap.docs.forEach(m => tx.delete(m.ref));
    tx.delete(db.collection(COL.BRIEFINGS).doc(bid));
  });
  res.json({ ok: true });
});

app.post('/api/briefings/:id/join', requireAuth, async (req, res) => {
  const b = await getBriefing(req.params.id);
  if (!b) return res.status(404).json({ error: 'not_found' });
  const mid = `${req.params.id}__${req.user.id}`;
  const mRef = db.collection(COL.MEMBERS).doc(mid);
  const existing = await mRef.get();
  if (!existing.exists) {
    await mRef.set({ id: mid, briefingId: req.params.id, userId: String(req.user.id), role: 'viewer', joinedAt: FV.serverTimestamp() });
  }
  const role = await getRole(req.params.id, req.user.id);
  res.json({ ok: true, role });
});

app.post('/api/briefings/:id/members', requireAuth, async (req, res) => {
  if ((await getRole(req.params.id, req.user.id)) !== 'owner') return res.status(403).json({ error: 'forbidden' });
  const { userId, role } = req.body || {};
  if (!userId || !['editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'bad_params' });
  if (String(userId) === String(req.user.id)) return res.status(400).json({ error: 'cant_change_self' });
  const mid = `${req.params.id}__${userId}`;
  await db.collection(COL.MEMBERS).doc(mid).set(
    { id: mid, briefingId: req.params.id, userId: String(userId), role, joinedAt: FV.serverTimestamp() },
    { merge: true }
  );
  res.json({ ok: true });
});

app.patch('/api/briefings/:id/members/:userId', requireAuth, async (req, res) => {
  if ((await getRole(req.params.id, req.user.id)) !== 'owner') return res.status(403).json({ error: 'forbidden' });
  const { role } = req.body || {};
  if (!['editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'bad_role' });
  await db.collection(COL.MEMBERS).doc(`${req.params.id}__${req.params.userId}`).update({ role });
  res.json({ ok: true });
});

app.delete('/api/briefings/:id/members/:userId', requireAuth, async (req, res) => {
  if ((await getRole(req.params.id, req.user.id)) !== 'owner') return res.status(403).json({ error: 'forbidden' });
  await db.collection(COL.MEMBERS).doc(`${req.params.id}__${req.params.userId}`).delete();
  res.json({ ok: true });
});

// ---------- SLIDES ----------
app.post('/api/briefings/:bid/slides', requireAuth, async (req, res) => {
  const role = await getRole(req.params.bid, req.user.id);
  if (!canEditRole(role)) return res.status(403).json({ error: 'forbidden' });

  const { name, mapId } = req.body || {};
  const orderSnap = await db.collection(COL.SLIDES).where('briefingId', '==', req.params.bid).get();
  const order = orderSnap.docs.reduce((m, d) => Math.max(m, (d.data().order || 0) + 1), 0);

  const ref = db.collection(COL.SLIDES).doc();
  const slide = { id: ref.id, briefingId: req.params.bid, name: name || 'Этап', mapId: mapId || 'molen', order, createdAt: FV.serverTimestamp() };
  await ref.set(slide);
  res.json({ slide });
});

app.get('/api/slides/:sid/entities', requireAuth, async (req, res) => {
  const sl = await slideBriefing(req.params.sid);
  if (!sl) return res.status(404).json({ error: 'not_found' });
  const role = await getRole(sl.briefingId, req.user.id);
  if (!role) return res.status(403).json({ error: 'forbidden' });
  const snap = await db.collection(COL.ENTITIES).where('slideId', '==', req.params.sid).get();
  res.json({ entities: snap.docs.map(d => d.data()) });
});

app.patch('/api/slides/:sid', requireAuth, async (req, res) => {
  const sl = await slideBriefing(req.params.sid);
  if (!sl) return res.status(404).json({ error: 'not_found' });
  if (!canEditRole(await getRole(sl.briefingId, req.user.id))) return res.status(403).json({ error: 'forbidden' });
  const upd = {};
  if (typeof req.body.name === 'string') upd.name = req.body.name;
  if (typeof req.body.mapId === 'string') upd.mapId = req.body.mapId;
  if (typeof req.body.order === 'number') upd.order = req.body.order;
  if (Object.keys(upd).length) await db.collection(COL.SLIDES).doc(req.params.sid).update(upd);
  res.json({ ok: true });
});

app.delete('/api/slides/:sid', requireAuth, async (req, res) => {
  const sl = await slideBriefing(req.params.sid);
  if (!sl) return res.status(404).json({ error: 'not_found' });
  if (!canEditRole(await getRole(sl.briefingId, req.user.id))) return res.status(403).json({ error: 'forbidden' });
  await db.runTransaction(async tx => {
    const eSnap = await db.collection(COL.ENTITIES).where('slideId', '==', req.params.sid).get();
    eSnap.docs.forEach(e => tx.delete(e.ref));
    tx.delete(db.collection(COL.SLIDES).doc(req.params.sid));
  });
  res.json({ ok: true });
});

// ---------- ENTITIES ----------
app.post('/api/slides/:sid/entities', requireAuth, async (req, res) => {
  const g = await guardEdit(req.params.sid, req.user.id);
  if (g.code !== 200) return res.status(g.code).json({ error: g.code === 404 ? 'not_found' : 'forbidden' });
  const { type, data, id } = req.body || {};
  if (!type) return res.status(400).json({ error: 'no_type' });
  const ref = id ? db.collection(COL.ENTITIES).doc(String(id)) : db.collection(COL.ENTITIES).doc();
  const entity = { id: ref.id, slideId: req.params.sid, type, data: data || {}, updatedAt: FV.serverTimestamp() };
  await ref.set(entity, { merge: true });
  res.json({ entity });
});

app.patch('/api/entities/:eid', requireAuth, async (req, res) => {
  const eSnap = await db.collection(COL.ENTITIES).doc(req.params.eid).get();
  if (!eSnap.exists) return res.status(404).json({ error: 'not_found' });
  const g = await guardEdit(eSnap.get('slideId'), req.user.id);
  if (g.code !== 200) return res.status(g.code).json({ error: 'forbidden' });
  const upd = { updatedAt: FV.serverTimestamp() };
  if (req.body.type) upd.type = req.body.type;
  if (req.body.data) upd.data = req.body.data;
  await eSnap.ref.update(upd);
  res.json({ ok: true });
});

app.delete('/api/entities/:eid', requireAuth, async (req, res) => {
  const eSnap = await db.collection(COL.ENTITIES).doc(req.params.eid).get();
  if (!eSnap.exists) return res.status(404).json({ error: 'not_found' });
  const g = await guardEdit(eSnap.get('slideId'), req.user.id);
  if (g.code !== 200) return res.status(g.code).json({ error: 'forbidden' });
  await eSnap.ref.delete();
  res.json({ ok: true });
});

app.put('/api/slides/:sid/entities', requireAuth, async (req, res) => {
  const g = await guardEdit(req.params.sid, req.user.id);
  if (g.code !== 200) return res.status(g.code).json({ error: g.code === 404 ? 'not_found' : 'forbidden' });
  const incoming = Array.isArray(req.body && req.body.entities) ? req.body.entities : [];
  const sid = req.params.sid;

  const existing = await db.collection(COL.ENTITIES).where('slideId', '==', sid).get();
  const existingIds = new Set(existing.docs.map(d => d.id));
  const incomingIds = new Set(incoming.map(e => e && e.id).filter(Boolean));

  const batch = db.batch();
  for (const e of incoming) {
    if (!e || !e.id || !e.type) continue;
    const ref = db.collection(COL.ENTITIES).doc(String(e.id));
    const { id, type, slideId, updatedAt, createdAt, ...rest } = e;
    batch.set(ref, { id: String(e.id), slideId: sid, type, data: rest, updatedAt: FV.serverTimestamp() }, { merge: true });
  }
  for (const d of existing.docs) {
    if (!incomingIds.has(d.id)) batch.delete(d.ref);
  }
  await batch.commit();
  res.json({ ok: true, count: incoming.length });
});

// ============================ WEBSOCKET ============================
const rooms = new Map();

function broadcast(room, msg, except) {
  const set = rooms.get(room);
  if (!set) return;
  const data = JSON.stringify(msg);
  for (const s of set) {
    if (s === except) continue;
    if (s.readyState === 1) s.send(data);
  }
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const token = q.get('token');
  const room = q.get('room');
  let user;
  try { user = verifyToken(token); } catch (e) { return ws.close(4001, 'bad_token'); }
  if (!room) return ws.close(4002, 'no_room');

  getRole(room, user.id).then(role => {
    if (!role) return ws.close(4003, 'forbidden');
    ws.user = user;
    ws.room = room;
    ws.role = role;
    if (!rooms.has(room)) rooms.set(room, new Set());
    rooms.get(room).add(ws);

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (!msg || typeof msg.type !== 'string') return;
      const mutating = ['state', 'setrole', 'rename', 'present', 'preslide'];
      if (mutating.includes(msg.type) && !canEditRole(ws.role)) return;
      msg.from = user.id;
      broadcast(room, msg, ws);
    });

    ws.on('close', () => {
      const set = rooms.get(room);
      if (set) { set.delete(ws); if (!set.size) rooms.delete(room); }
    });
  }).catch(() => ws.close(4500, 'err'));
});

// ============================ ЗАПУСК ============================
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ JUKSTATS Planner Server запущен на :${PORT}`);
  console.log(`📡 REST API: http://localhost:${PORT}/api`);
  console.log(`🔌 WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`❤️ Health: http://localhost:${PORT}/health`);
});
