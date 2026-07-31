require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// Инициализация Firebase
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else if (process.env.FIREBASE_PRIVATE_KEY) {
    serviceAccount = {
      project_id: process.env.FIREBASE_PROJECT_ID || 'juk-stats',
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    };
  } else {
    serviceAccount = require('./serviceAccountKey.json');
  }
  
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
  });
  
  console.log('✅ Firebase initialized for project:', serviceAccount.project_id);
} catch (error) {
  console.error('❌ Firebase init error:', error.message);
  process.exit(1);
}

const db = admin.firestore();
const app = express();

// Middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Логирование запросов
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    project: serviceAccount.project_id,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Firebase test
app.get('/api/firebase-test', async (req, res) => {
  try {
    await db.collection('_test').doc('connection').set({
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ connected: true, project: serviceAccount.project_id });
  } catch (error) {
    res.status(500).json({ connected: false, error: error.message });
  }
});

// Auth middleware
const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    req.user = { uid: 'guest_' + uuidv4(), isGuest: true };
    return next();
  }
  
  try {
    // Проверяем Firebase токен
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
  } catch (error) {
    // Ищем в нашей БД
    const userDoc = await db.collection('users').doc(token).get();
    if (userDoc.exists) {
      req.user = { uid: token, ...userDoc.data() };
    } else {
      req.user = { uid: token, isGuest: true };
    }
  }
  
  next();
};

// ============ AUTH ROUTES ============

app.post('/api/auth/lesta', async (req, res) => {
  try {
    console.log('Lesta auth request:', req.body);
    const { accessToken, accountId, nickname } = req.body;
    
    if (!accessToken || !accountId) {
      return res.status(400).json({ error: 'Неверные данные' });
    }

    const firebaseUid = `lesta_${accountId}`;
    const userRef = db.collection('users').doc(firebaseUid);
    const userDoc = await userRef.get();
    
    const userData = {
      uid: firebaseUid,
      lestaId: accountId,
      name: nickname || 'Игрок',
      isGuest: false,
      lastLogin: admin.firestore.FieldValue.serverTimestamp()
    };
    
    if (!userDoc.exists) {
      userData.createdAt = admin.firestore.FieldValue.serverTimestamp();
      await userRef.set(userData);
    } else {
      await userRef.update({
        name: nickname || userDoc.data().name,
        lastLogin: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // Генерируем простой токен
    const token = firebaseUid;
    
    console.log('✅ Lesta auth success:', firebaseUid);
    
    res.json({
      token,
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
    console.error('Guest auth error:', error);
    res.status(500).json({ error: 'Ошибка авторизации: ' + error.message });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    res.json({ 
      user: userDoc.exists ? userDoc.data() : {
        id: req.user.uid,
        name: 'Гость',
        isGuest: true
      }
    });
  } catch (error) {
    res.json({ 
      user: { id: req.user.uid, name: 'Гость', isGuest: true } 
    });
  }
});

// ============ BRIEFINGS ROUTES ============

app.post('/api/briefings', authMiddleware, async (req, res) => {
  try {
    const { title } = req.body;
    const briefingId = uuidv4();
    
    const briefingData = {
      id: briefingId,
      title: title || 'Безымянный брифинг',
      ownerId: req.user.uid,
      editors: [],
      viewers: [],
      notes: '',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    await db.collection('briefings').doc(briefingId).set(briefingData);
    
    // Создаем первый слайд
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
    console.error('Create briefing error:', error);
    res.status(500).json({ error: 'Ошибка создания брифинга: ' + error.message });
  }
});

app.get('/api/briefings', authMiddleware, async (req, res) => {
  try {
    console.log('Fetching briefings for:', req.user.uid);
    
    const briefingsSnapshot = await db.collection('briefings')
      .where('ownerId', '==', req.user.uid)
      .get();
    
    if (briefingsSnapshot.empty) {
      return res.json({ briefings: [] });
    }
    
    const briefings = briefingsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    // Получаем слайды для каждого брифинга
    const slidesPromises = briefings.map(b => 
      db.collection('slides')
        .where('briefingId', '==', b.id)
        .get()
    );
    
    const slidesSnapshots = await Promise.all(slidesPromises);
    
    const result = briefings.map((briefing, i) => {
      const slides = slidesSnapshots[i].docs.map(doc => doc.data());
      return {
        ...briefing,
        slideCount: slides.length,
        firstMap: getMapName(slides[0]?.mapId)
      };
    });
    
    // Сортируем вручную
    result.sort((a, b) => {
      const dateA = a.updatedAt?.toDate?.() || new Date(0);
      const dateB = b.updatedAt?.toDate?.() || new Date(0);
      return dateB - dateA;
    });
    
    console.log('✅ Found briefings:', result.length);
    
    res.json({ briefings: result });
  } catch (error) {
    console.error('Get briefings error:', error);
    res.status(500).json({ error: 'Ошибка получения брифингов: ' + error.message });
  }
});

app.get('/api/briefings/:id', authMiddleware, async (req, res) => {
  try {
    const briefingDoc = await db.collection('briefings').doc(req.params.id).get();
    
    if (!briefingDoc.exists) {
      return res.status(404).json({ error: 'Брифинг не найден' });
    }
    
    const briefing = briefingDoc.data();
    
    const slidesSnapshot = await db.collection('slides')
      .where('briefingId', '==', req.params.id)
      .get();
    
    const slides = [];
    slidesSnapshot.forEach(doc => slides.push(doc.data()));
    slides.sort((a, b) => (a.order || 0) - (b.order || 0));
    
    const isOwner = briefing.ownerId === req.user.uid;
    const isEditor = briefing.editors?.includes(req.user.uid);
    
    res.json({
      briefing,
      slides,
      myRole: isOwner ? 'owner' : isEditor ? 'editor' : 'viewer'
    });
  } catch (error) {
    console.error('Get briefing error:', error);
    res.status(500).json({ error: 'Ошибка получения брифинга: ' + error.message });
  }
});

app.put('/api/briefings/:id', authMiddleware, async (req, res) => {
  try {
    await db.collection('briefings').doc(req.params.id).update({
      ...req.body,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Update briefing error:', error);
    res.status(500).json({ error: 'Ошибка обновления: ' + error.message });
  }
});

app.delete('/api/briefings/:id', authMiddleware, async (req, res) => {
  try {
    const briefingRef = db.collection('briefings').doc(req.params.id);
    const briefingDoc = await briefingRef.get();
    
    if (!briefingDoc.exists) {
      return res.status(404).json({ error: 'Брифинг не найден' });
    }
    
    // Удаляем слайды
    const slidesSnapshot = await db.collection('slides')
      .where('briefingId', '==', req.params.id)
      .get();
    
    const batch = db.batch();
    slidesSnapshot.docs.forEach(doc => batch.delete(doc.ref));
    batch.delete(briefingRef);
    await batch.commit();
    
    console.log('✅ Deleted briefing:', req.params.id);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Delete briefing error:', error);
    res.status(500).json({ error: 'Ошибка удаления: ' + error.message });
  }
});

// ============ SLIDES ROUTES ============

app.post('/api/slides', authMiddleware, async (req, res) => {
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
    console.error('Create slide error:', error);
    res.status(500).json({ error: 'Ошибка создания слайда: ' + error.message });
  }
});

app.put('/api/slides/:id', authMiddleware, async (req, res) => {
  try {
    await db.collection('slides').doc(req.params.id).update({
      ...req.body,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Update slide error:', error);
    res.status(500).json({ error: 'Ошибка обновления слайда: ' + error.message });
  }
});

app.delete('/api/slides/:id', authMiddleware, async (req, res) => {
  try {
    await db.collection('slides').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (error) {
    console.error('Delete slide error:', error);
    res.status(500).json({ error: 'Ошибка удаления слайда: ' + error.message });
  }
});

function getMapName(mapId) {
  const maps = {
    'molen': 'Молендейк', 'himmelsdorf': 'Химмельсдорф', 'malinovka': 'Малиновка',
    'prohorovka': 'Прохоровка', 'mines': 'Рудники', 'castilla': 'Кастилья',
    'canal': 'Канал', 'port': 'Порт'
  };
  return maps[mapId] || mapId || '—';
}

// Статические файлы
app.use(express.static(path.join(__dirname, 'public')));

// Основной роут
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Обработка ошибок
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`📦 Firebase проект: ${serviceAccount.project_id}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/api/health`);
});
