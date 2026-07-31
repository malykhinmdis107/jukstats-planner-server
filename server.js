require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// Инициализация Firebase Admin
const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.firestore();
const app = express();

// Middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors({
  origin: process.env.CLIENT_URL || '*',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Middleware для проверки авторизации
const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    // Для гостевых пользователей
    try {
      const userDoc = await db.collection('users').doc(token).get();
      if (userDoc.exists) {
        req.user = { uid: token, ...userDoc.data() };
        next();
      } else {
        res.status(401).json({ error: 'Пользователь не найден' });
      }
    } catch (e) {
      res.status(401).json({ error: 'Неверный токен' });
    }
  }
};

// ============ AUTH ROUTES ============

// Lesta авторизация
app.post('/api/auth/lesta', async (req, res) => {
  try {
    const { accessToken, accountId, nickname } = req.body;
    
    if (!accessToken || !accountId) {
      return res.status(400).json({ error: 'Неверные данные' });
    }

    // Создаем Firebase пользователя или получаем существующего
    const firebaseUid = `lesta_${accountId}`;
    
    let userDoc = await db.collection('users').doc(firebaseUid).get();
    
    if (!userDoc.exists) {
      await db.collection('users').doc(firebaseUid).set({
        uid: firebaseUid,
        lestaId: accountId,
        name: nickname || 'Игрок',
        avatar: null,
        isGuest: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastLogin: admin.firestore.FieldValue.serverTimestamp()
      });
    } else {
      await db.collection('users').doc(firebaseUid).update({
        name: nickname || userDoc.data().name,
        lastLogin: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // Генерируем кастомный токен
    const customToken = await admin.auth().createCustomToken(firebaseUid);
    
    res.json({
      token: customToken,
      user: {
        id: firebaseUid,
        name: nickname || 'Игрок',
        lestaId: accountId,
        isGuest: false
      }
    });
  } catch (error) {
    console.error('Lesta auth error:', error);
    res.status(500).json({ error: 'Ошибка авторизации' });
  }
});

// Гостевая авторизация
app.post('/api/auth/guest', async (req, res) => {
  try {
    const { guestId, name } = req.body;
    
    if (!guestId) {
      return res.status(400).json({ error: 'Требуется ID гостя' });
    }

    const firebaseUid = `guest_${guestId}`;
    
    const userDoc = await db.collection('users').doc(firebaseUid).get();
    
    if (!userDoc.exists) {
      await db.collection('users').doc(firebaseUid).set({
        uid: firebaseUid,
        guestId: guestId,
        name: name || 'Гость',
        isGuest: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastLogin: admin.firestore.FieldValue.serverTimestamp()
      });
    } else {
      await db.collection('users').doc(firebaseUid).update({
        lastLogin: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    const customToken = await admin.auth().createCustomToken(firebaseUid);
    
    res.json({
      token: customToken,
      user: {
        id: firebaseUid,
        name: name || 'Гость',
        isGuest: true,
        guestId: guestId
      }
    });
  } catch (error) {
    console.error('Guest auth error:', error);
    res.status(500).json({ error: 'Ошибка авторизации' });
  }
});

// Проверка текущего пользователя
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    res.json({ user: userDoc.data() });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============ BRIEFINGS ROUTES ============

// Создание брифинга
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
    
    // Создаем брифинг
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
    
    res.json({
      briefing: briefingData,
      firstSlideId: slideId
    });
  } catch (error) {
    console.error('Create briefing error:', error);
    res.status(500).json({ error: 'Ошибка создания брифинга' });
  }
});

// Получение брифингов пользователя
app.get('/api/briefings', authMiddleware, async (req, res) => {
  try {
    const briefingsSnapshot = await db.collection('briefings')
      .where('ownerId', '==', req.user.uid)
      .orderBy('updatedAt', 'desc')
      .get();
    
    const briefings = [];
    for (const doc of briefingsSnapshot.docs) {
      const briefing = doc.data();
      
      // Получаем количество слайдов
      const slidesSnapshot = await db.collection('slides')
        .where('briefingId', '==', briefing.id)
        .get();
      
      // Получаем информацию о первой карте
      const firstSlide = slidesSnapshot.docs[0]?.data();
      
      briefings.push({
        ...briefing,
        slideCount: slidesSnapshot.size,
        firstMap: firstSlide ? getMapName(firstSlide.mapId) : '—'
      });
    }
    
    res.json({ briefings });
  } catch (error) {
    console.error('Get briefings error:', error);
    res.status(500).json({ error: 'Ошибка получения брифингов' });
  }
});

// Получение конкретного брифинга
app.get('/api/briefings/:id', authMiddleware, async (req, res) => {
  try {
    const briefingDoc = await db.collection('briefings').doc(req.params.id).get();
    
    if (!briefingDoc.exists) {
      return res.status(404).json({ error: 'Брифинг не найден' });
    }
    
    const briefing = briefingDoc.data();
    
    // Проверяем права доступа
    const isOwner = briefing.ownerId === req.user.uid;
    const isEditor = briefing.editors.includes(req.user.uid);
    const isViewer = briefing.viewers.includes(req.user.uid);
    
    if (!isOwner && !isEditor && !isViewer) {
      return res.status(403).json({ error: 'Нет доступа к этому брифингу' });
    }
    
    // Получаем слайды
    const slidesSnapshot = await db.collection('slides')
      .where('briefingId', '==', req.params.id)
      .orderBy('order')
      .get();
    
    const slides = slidesSnapshot.docs.map(doc => doc.data());
    
    res.json({
      briefing,
      slides,
      myRole: isOwner ? 'owner' : isEditor ? 'editor' : 'viewer'
    });
  } catch (error) {
    console.error('Get briefing error:', error);
    res.status(500).json({ error: 'Ошибка получения брифинга' });
  }
});

// Обновление брифинга
app.put('/api/briefings/:id', authMiddleware, async (req, res) => {
  try {
    const briefingRef = db.collection('briefings').doc(req.params.id);
    const briefingDoc = await briefingRef.get();
    
    if (!briefingDoc.exists) {
      return res.status(404).json({ error: 'Брифинг не найден' });
    }
    
    const briefing = briefingDoc.data();
    
    // Проверяем права на редактирование
    if (briefing.ownerId !== req.user.uid && !briefing.editors.includes(req.user.uid)) {
      return res.status(403).json({ error: 'Нет прав на редактирование' });
    }
    
    await briefingRef.update({
      ...req.body,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Update briefing error:', error);
    res.status(500).json({ error: 'Ошибка обновления брифинга' });
  }
});

// Удаление брифинга
app.delete('/api/briefings/:id', authMiddleware, async (req, res) => {
  try {
    const briefingRef = db.collection('briefings').doc(req.params.id);
    const briefingDoc = await briefingRef.get();
    
    if (!briefingDoc.exists) {
      return res.status(404).json({ error: 'Брифинг не найден' });
    }
    
    const briefing = briefingDoc.data();
    
    if (briefing.ownerId !== req.user.uid) {
      return res.status(403).json({ error: 'Только владелец может удалить брифинг' });
    }
    
    // Удаляем все связанные слайды
    const slidesSnapshot = await db.collection('slides')
      .where('briefingId', '==', req.params.id)
      .get();
    
    const batch = db.batch();
    slidesSnapshot.docs.forEach(doc => batch.delete(doc.ref));
    batch.delete(briefingRef);
    await batch.commit();
    
    res.json({ success: true });
  } catch (error) {
    console.error('Delete briefing error:', error);
    res.status(500).json({ error: 'Ошибка удаления брифинга' });
  }
});

// ============ SLIDES ROUTES ============

// Создание слайда
app.post('/api/slides', authMiddleware, async (req, res) => {
  try {
    const { briefingId, name, mapId } = req.body;
    
    // Проверяем права на брифинг
    const briefingDoc = await db.collection('briefings').doc(briefingId).get();
    if (!briefingDoc.exists) {
      return res.status(404).json({ error: 'Брифинг не найден' });
    }
    
    const briefing = briefingDoc.data();
    if (briefing.ownerId !== req.user.uid && !briefing.editors.includes(req.user.uid)) {
      return res.status(403).json({ error: 'Нет прав на создание слайдов' });
    }
    
    // Получаем максимальный order
    const slidesSnapshot = await db.collection('slides')
      .where('briefingId', '==', briefingId)
      .orderBy('order', 'desc')
      .limit(1)
      .get();
    
    const maxOrder = slidesSnapshot.docs[0]?.data().order || -1;
    
    const slideId = uuidv4();
    const slideData = {
      id: slideId,
      briefingId,
      name: name || 'Этап',
      mapId: mapId || 'molen',
      entities: [],
      order: maxOrder + 1,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    await db.collection('slides').doc(slideId).set(slideData);
    
    res.json({ slide: slideData });
  } catch (error) {
    console.error('Create slide error:', error);
    res.status(500).json({ error: 'Ошибка создания слайда' });
  }
});

// Обновление слайда
app.put('/api/slides/:id', authMiddleware, async (req, res) => {
  try {
    const slideRef = db.collection('slides').doc(req.params.id);
    const slideDoc = await slideRef.get();
    
    if (!slideDoc.exists) {
      return res.status(404).json({ error: 'Слайд не найден' });
    }
    
    // Проверяем права на брифинг
    const slide = slideDoc.data();
    const briefingDoc = await db.collection('briefings').doc(slide.briefingId).get();
    const briefing = briefingDoc.data();
    
    if (briefing.ownerId !== req.user.uid && !briefing.editors.includes(req.user.uid)) {
      return res.status(403).json({ error: 'Нет прав на редактирование' });
    }
    
    await slideRef.update({
      ...req.body,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Update slide error:', error);
    res.status(500).json({ error: 'Ошибка обновления слайда' });
  }
});

// Удаление слайда
app.delete('/api/slides/:id', authMiddleware, async (req, res) => {
  try {
    const slideRef = db.collection('slides').doc(req.params.id);
    const slideDoc = await slideRef.get();
    
    if (!slideDoc.exists) {
      return res.status(404).json({ error: 'Слайд не найден' });
    }
    
    const slide = slideDoc.data();
    const briefingDoc = await db.collection('briefings').doc(slide.briefingId).get();
    const briefing = briefingDoc.data();
    
    if (briefing.ownerId !== req.user.uid && !briefing.editors.includes(req.user.uid)) {
      return res.status(403).json({ error: 'Нет прав на удаление' });
    }
    
    await slideRef.delete();
    
    res.json({ success: true });
  } catch (error) {
    console.error('Delete slide error:', error);
    res.status(500).json({ error: 'Ошибка удаления слайда' });
  }
});

// Вспомогательная функция для названий карт
function getMapName(mapId) {
  const maps = {
    'molen': 'Молендейк',
    'himmelsdorf': 'Химмельсдорф',
    'malinovka': 'Малиновка',
    'prohorovka': 'Прохоровка',
    'mines': 'Рудники',
    'castilla': 'Кастилья',
    'canal': 'Канал',
    'port': 'Порт'
    // Добавьте остальные карты
  };
  return maps[mapId] || mapId;
}

// Основной роут
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log(`Firebase проект: ${process.env.FIREBASE_PROJECT_ID}`);
});
