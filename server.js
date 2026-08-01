const express = require('express');
const cors = require('cors');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);

// WebSocket сервер
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Firebase
let db = null;
try {
  const admin = require('firebase-admin');
  const serviceAccount = require('/etc/secrets/serviceAccountKey.json');
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  console.log('🔥 Firebase OK');
} catch(e) {
  console.error('Firebase error:', e.message);
}

// Статические файлы
app.use(express.static(__dirname));
app.use('/js', express.static(path.join(__dirname, 'js')));
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/img', express.static(path.join(__dirname, 'img')));

// Главная
app.get('/', (req, res) => {
  const p = path.join(__dirname, 'briefings.html');
  if (fs.existsSync(p)) res.sendFile(p);
  else res.json({ status: 'ok' });
});

// Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', db: !!db, uptime: process.uptime() });
});

// ===== WEBSOCKET =====
const rooms = new Map(); // roomId -> Set of WebSocket

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const briefingId = url.searchParams.get('room') || 'default';
  
  if (!rooms.has(briefingId)) rooms.set(briefingId, new Set());
  rooms.get(briefingId).add(ws);
  
  console.log(`🔌 Connected to room ${briefingId}. Total: ${rooms.get(briefingId).size}`);
  
  // Отправляем текущее количество участников
  broadcast(briefingId, { type: 'users_count', count: rooms.get(briefingId).size });
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      // Пересылаем всем в комнате кроме отправителя
      rooms.get(briefingId)?.forEach(client => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(msg));
        }
      });
    } catch(e) {}
  });
  
  ws.on('close', () => {
    rooms.get(briefingId)?.delete(ws);
    if (rooms.get(briefingId)?.size === 0) rooms.delete(briefingId);
    broadcast(briefingId, { type: 'users_count', count: rooms.get(briefingId)?.size || 0 });
    console.log(`🔌 Disconnected from room ${briefingId}`);
  });
});

function broadcast(roomId, data) {
  const room = rooms.get(roomId);
  if (room) {
    const msg = JSON.stringify(data);
    room.forEach(client => {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
  }
}

// ===== AUTH =====
app.post('/api/auth/lesta', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'No database' });
  try {
    const { accessToken, accountId, nickname } = req.body;
    if (!accountId) return res.status(400).json({ error: 'No accountId' });
    
    const uid = `lesta_${accountId}`;
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    
    if (!doc.exists) {
      await ref.set({
        uid, lestaId: accountId, name: nickname || 'Игрок',
        isGuest: false, createdAt: new Date().toISOString(), lastLogin: new Date().toISOString()
      });
    } else {
      await ref.update({ name: nickname || doc.data().name, lastLogin: new Date().toISOString() });
    }
    
    res.json({ token: uid, user: { id: uid, name: nickname || 'Игрок', lestaId: accountId, isGuest: false } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/guest', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'No database' });
  try {
    const { guestId, name } = req.body;
    if (!guestId) return res.status(400).json({ error: 'No guestId' });
    
    const uid = `guest_${guestId}`;
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    
    if (!doc.exists) {
      await ref.set({
        uid, guestId, name: name || 'Гость',
        isGuest: true, createdAt: new Date().toISOString(), lastLogin: new Date().toISOString()
      });
    } else {
      await ref.update({ lastLogin: new Date().toISOString() });
    }
    
    res.json({ token: uid, user: { id: uid, name: name || 'Гость', isGuest: true } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', async (req, res) => {
  if (!db) return res.json({ user: { id: 'guest', name: 'Гость', isGuest: true } });
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ user: { id: 'guest', name: 'Гость', isGuest: true } });
    const doc = await db.collection('users').doc(token).get();
    res.json({ user: doc.exists ? doc.data() : { id: token, name: 'Гость', isGuest: true } });
  } catch(e) { res.json({ user: { id: 'guest', name: 'Гость', isGuest: true } }); }
});

// ===== BRIEFINGS =====
app.post('/api/briefings', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'No database' });
  try {
    const token = req.headers.authorization?.split(' ')[1] || 'guest';
    const id = uuidv4();
    
    await db.collection('briefings').doc(id).set({
      id, title: req.body.title || 'Безымянный', ownerId: token,
      editors: [], viewers: [], notes: '',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
    
    const slideId = uuidv4();
    await db.collection('slides').doc(slideId).set({
      id: slideId, briefingId: id, name: 'Этап 1', mapId: 'molen',
      entities: [], order: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
    
    res.json({ briefing: { id, title: req.body.title }, firstSlideId: slideId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/briefings', async (req, res) => {
  if (!db) return res.json({ briefings: [] });
  try {
    const token = req.headers.authorization?.split(' ')[1] || 'guest';
    const snap = await db.collection('briefings').where('ownerId', '==', token).get();
    const briefings = [];
    snap.forEach(d => briefings.push(d.data()));
    briefings.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    res.json({ briefings });
  } catch(e) { res.json({ briefings: [] }); }
});

app.get('/api/briefings/:id', async (req, res) => {
  if (!db) return res.status(404).json({ error: 'No database' });
  try {
    const doc = await db.collection('briefings').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    
    const briefing = doc.data();
    const slidesSnap = await db.collection('slides').where('briefingId', '==', req.params.id).orderBy('order').get();
    const slides = [];
    slidesSnap.forEach(d => slides.push(d.data()));
    
    const token = req.headers.authorization?.split(' ')[1] || 'guest';
    res.json({
      briefing,
      slides,
      myRole: briefing.ownerId === token ? 'owner' : briefing.editors?.includes(token) ? 'editor' : 'viewer'
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/briefings/:id', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'No database' });
  try {
    await db.collection('briefings').doc(req.params.id).update({
      ...req.body, updatedAt: new Date().toISOString()
    });
    
    // Оповещаем всех в комнате об изменении
    broadcast(req.params.id, { type: 'briefing_updated', id: req.params.id, data: req.body });
    
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/briefings/:id', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'No database' });
  try {
    const slidesSnap = await db.collection('slides').where('briefingId', '==', req.params.id).get();
    const batch = db.batch();
    slidesSnap.forEach(d => batch.delete(d.ref));
    batch.delete(db.collection('briefings').doc(req.params.id));
    await batch.commit();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== SLIDES =====
app.post('/api/slides', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'No database' });
  try {
    const { briefingId, name, mapId } = req.body;
    const id = uuidv4();
    await db.collection('slides').doc(id).set({
      id, briefingId, name: name || 'Этап', mapId: mapId || 'molen',
      entities: [], order: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
    res.json({ slide: { id } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/slides/:id', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'No database' });
  try {
    await db.collection('slides').doc(req.params.id).update({
      ...req.body, updatedAt: new Date().toISOString()
    });
    
    // Получаем briefingId и оповещаем комнату
    const slide = await db.collection('slides').doc(req.params.id).get();
    if (slide.exists) {
      broadcast(slide.data().briefingId, { type: 'slide_updated', slideId: req.params.id, data: req.body });
    }
    
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Keep-alive
setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (url) require('https').get(url + '/api/health', () => {}).on('error', () => {});
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ PLANNER:${PORT}`));
