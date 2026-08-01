require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Firebase
let db = null;
try {
  const serviceAccount = require('/etc/secrets/serviceAccountKey.json');
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  console.log('🔥 Firebase OK');
} catch(e) {
  console.error('Firebase error:', e.message);
}

// ===== СТАТИЧЕСКИЕ ФАЙЛЫ (если есть) =====
app.use(express.static(__dirname));
app.use('/js', express.static(path.join(__dirname, 'js')));
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/img', express.static(path.join(__dirname, 'img')));

// ===== ГЛАВНАЯ СТРАНИЦА =====
app.get('/', (req, res) => {
  // Пробуем отдать briefings.html, если нет - отдаём planner.html, если и его нет - JSON
  const fs = require('fs');
  const briefingsPath = path.join(__dirname, 'briefings.html');
  const plannerPath = path.join(__dirname, 'planner.html');
  
  if (fs.existsSync(briefingsPath)) {
    res.sendFile(briefingsPath);
  } else if (fs.existsSync(plannerPath)) {
    res.sendFile(plannerPath);
  } else {
    res.json({ 
      status: 'planner-api',
      message: 'No static files found. API is working.',
      endpoints: ['/api/health', '/api/auth/lesta', '/api/auth/guest', '/api/briefings', '/api/slides']
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  const fs = require('fs');
  res.json({ 
    status: 'ok', 
    db: !!db,
    timestamp: new Date().toISOString(),
    files: fs.existsSync(path.join(__dirname, 'briefings.html')) ? 'briefings.html found' : 'no briefings.html',
    uptime: process.uptime()
  });
});

// ===== AUTH ROUTES =====

app.post('/api/auth/lesta', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not available' });
  try {
    console.log('📝 Lesta auth:', { accountId: req.body.accountId, nickname: req.body.nickname });
    const { accessToken, accountId, nickname } = req.body;
    
    if (!accessToken || !accountId) {
      return res.status(400).json({ error: 'Неверные данные' });
    }

    const firebaseUid = `lesta_${accountId}`;
    const userRef = db.collection('users').doc(firebaseUid);
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) {
      await userRef.set({
        uid: firebaseUid,
        lestaId: accountId,
        name: nickname || 'Игрок',
        isGuest: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastLogin: admin.firestore.FieldValue.serverTimestamp()
      });
    } else {
      await userRef.update({
        name: nickname || userDoc.data().name,
        lastLogin: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    console.log('✅ Lesta auth success:', firebaseUid);
    
    res.json({
      token: firebaseUid,
      user: {
        id: firebaseUid,
        name: nickname || 'Игрок',
        lestaId: accountId,
        isGuest: false
      }
    });
  } catch (error) {
    console.error('❌ Lesta auth error:', error);
    res.status(500).json({ error: 'Ошибка авторизации: ' + error.message });
  }
});

app.post('/api/auth/guest', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not available' });
  try {
    const { guestId, name } = req.body;
    
    if (!guestId) {
      return res.status(400).json({ error: 'Требуется ID гостя' });
    }

    const firebaseUid = `guest_${guestId}`;
    const userRef = db.collection('users').doc(firebaseUid);
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) {
      await userRef.set({
        uid: firebaseUid,
        guestId,
        name: name || 'Гость',
        isGuest: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastLogin: admin.firestore.FieldValue.serverTimestamp()
      });
    } else {
      await userRef.update({
        lastLogin: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.json({
      token: firebaseUid,
      user: {
        id: firebaseUid,
        name: name || 'Гость',
        isGuest: true,
        guestId
      }
    });
  } catch (error) {
    console.error('❌ Guest auth error:', error);
    res.status(500).json({ error: 'Ошибка авторизации: ' + error.message });
  }
});

app.get('/api/auth/me', async (req, res) => {
  if (!db) return res.json({ user: { id: 'guest', name: 'Гость', isGuest: true } });
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ user: { id: 'guest', name: 'Гость', isGuest: true } });
    
    const userDoc = await db.collection('users').doc(token).get();
    res.json({ 
      user: userDoc.exists ? userDoc.data() : { id: token, name: 'Гость', isGuest: true }
    });
  } catch (error) {
    res.json({ user: { id: 'guest', name: 'Гость', isGuest: true } });
  }
});

// ===== BRIEFINGS ROUTES =====

app.post('/api/briefings', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not available' });
  try {
    const token = req.headers.authorization?.split(' ')[1] || 'guest';
    const { title } = req.body;
    const briefingId = uuidv4();
    
    const briefingData = {
      id: briefingId,
      title: title || 'Безымянный брифинг',
      ownerId: token,
      editors: [],
      viewers: [],
      notes: '',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    await db.collection('briefings').doc(briefingId).set(briefingData);
    
    const slideId = uuidv4();
    await db.collection('slides').doc(slideId).set({
      id: slideId,
      briefingId: briefingId,
      name: 'Этап 1',
      mapId: 'molen',
      entities: [],
      order: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log('✅ Created briefing:', briefingId);
    
    res.json({
      briefing: briefingData,
      firstSlideId: slideId
    });
  } catch (error) {
    console.error('❌ Create briefing error:', error);
    res.status(500).json({ error: 'Ошибка создания брифинга: ' + error.message });
  }
});

app.get('/api/briefings', async (req, res) => {
  if (!db) return res.json({ briefings: [] });
  try {
    const token = req.headers.authorization?.split(' ')[1] || 'guest';
    console.log('📋 Fetching briefings for:', token);
    
    const briefingsSnapshot = await db.collection('briefings')
      .where('ownerId', '==', token)
      .get();
    
    if (briefingsSnapshot.empty) {
      return res.json({ briefings: [] });
    }
    
    const briefings = briefingsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    const result = [];
    for (const briefing of briefings) {
      const slidesSnapshot = await db.collection('slides')
        .where('briefingId', '==', briefing.id)
        .orderBy('order')
        .limit(1)
        .get();
      
      const firstSlide = slidesSnapshot.docs[0]?.data();
      const slideCount = (await db.collection('slides')
        .where('briefingId', '==', briefing.id)
        .count()
        .get()).data().count;
      
      result.push({
        ...briefing,
        slideCount,
        firstMap: firstSlide?.mapId || 'molen',
        firstSlide: firstSlide || null
      });
    }
    
    result.sort((a, b) => {
      const dateA = a.updatedAt?.toDate?.() || new Date(0);
      const dateB = b.updatedAt?.toDate?.() || new Date(0);
      return dateB - dateA;
    });
    
    res.json({ briefings: result });
  } catch (error) {
    console.error('❌ Get briefings error:', error);
    res.json({ briefings: [] });
  }
});

app.get('/api/briefings/:id', async (req, res) => {
  if (!db) return res.status(404).json({ error: 'Database not available' });
  try {
    const briefingDoc = await db.collection('briefings').doc(req.params.id).get();
    
    if (!briefingDoc.exists) {
      return res.status(404).json({ error: 'Брифинг не найден' });
    }
    
    const briefing = briefingDoc.data();
    
    const slidesSnapshot = await db.collection('slides')
      .where('briefingId', '==', req.params.id)
      .orderBy('order')
      .get();
    
    const slides = [];
    slidesSnapshot.forEach(doc => slides.push(doc.data()));
    
    const token = req.headers.authorization?.split(' ')[1] || 'guest';
    const isOwner = briefing.ownerId === token;
    const isEditor = briefing.editors?.includes(token);
    
    res.json({
      briefing,
      slides,
      myRole: isOwner ? 'owner' : isEditor ? 'editor' : 'viewer'
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка: ' + error.message });
  }
});

app.put('/api/briefings/:id', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not available' });
  try {
    await db.collection('briefings').doc(req.params.id).update({
      ...req.body,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка: ' + error.message });
  }
});

app.delete('/api/briefings/:id', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not available' });
  try {
    const slidesSnapshot = await db.collection('slides')
      .where('briefingId', '==', req.params.id)
      .get();
    
    const batch = db.batch();
    slidesSnapshot.docs.forEach(doc => batch.delete(doc.ref));
    batch.delete(db.collection('briefings').doc(req.params.id));
    await batch.commit();
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка: ' + error.message });
  }
});

// ===== SLIDES ROUTES =====

app.post('/api/slides', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not available' });
  try {
    const { briefingId, name, mapId } = req.body;
    
    const slidesSnapshot = await db.collection('slides')
      .where('briefingId', '==', briefingId)
      .get();
    
    const slideId = uuidv4();
    await db.collection('slides').doc(slideId).set({
      id: slideId,
      briefingId,
      name: name || 'Этап',
      mapId: mapId || 'molen',
      entities: [],
      order: slidesSnapshot.size,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.json({ slide: { id: slideId, briefingId, name, mapId } });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка: ' + error.message });
  }
});

app.put('/api/slides/:id', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not available' });
  try {
    await db.collection('slides').doc(req.params.id).update({
      ...req.body,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка: ' + error.message });
  }
});

app.delete('/api/slides/:id', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not available' });
  try {
    await db.collection('slides').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка: ' + error.message });
  }
});

// ===== ОЧИСТКА СТАРЫХ ГОСТЕЙ =====
setInterval(async () => {
  if (!db) return;
  try {
    const oldDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const snapshot = await db.collection('users')
      .where('isGuest', '==', true)
      .where('lastLogin', '<', oldDate)
      .get();
    
    if (snapshot.size > 0) {
      const batch = db.batch();
      snapshot.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      console.log(`🧹 Cleaned ${snapshot.size} old guest accounts`);
    }
  } catch (e) {
    console.error('Cleanup error:', e);
  }
}, 3600000);

// Keep-alive
setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (url) {
    require('https').get(url + '/api/health', () => {}).on('error', () => {});
  }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ PLANNER:${PORT}`);
  console.log(`📁 Static files from: ${__dirname}`);
});
