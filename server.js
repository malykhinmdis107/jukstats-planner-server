require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// Инициализация Firebase Admin с service account
let serviceAccount;
try {
  // Пытаемся загрузить из переменной окружения
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('Firebase: используем переменную окружения');
  } else {
    // Загружаем из файла
    serviceAccount = require('./serviceAccountKey.json');
    console.log('Firebase: используем файл serviceAccountKey.json');
  }
} catch (error) {
  console.error('Ошибка загрузки service account:', error);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
});

const db = admin.firestore();
const app = express();

// Middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// Разрешаем запросы с любого источника (для разработки)
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    project: serviceAccount.project_id,
    timestamp: new Date().toISOString()
  });
});

// Проверка подключения к Firebase
app.get('/api/firebase-test', async (req, res) => {
  try {
    const testDoc = await db.collection('_test').doc('connection').get();
    res.json({ 
      connected: true, 
      project: serviceAccount.project_id 
    });
  } catch (error) {
    res.status(500).json({ 
      connected: false, 
      error: error.message 
    });
  }
});

// Middleware для авторизации (упрощенная версия)
const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  // Если нет токена, разрешаем как гостю
  if (!token) {
    req.user = { uid: 'guest_' + uuidv4(), isGuest: true };
    return next();
  }
  
  try {
    // Пытаемся верифицировать как Firebase токен
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    // Если не Firebase токен, ищем в нашей БД
    try {
      const userDoc = await db.collection('users').doc(token).get();
      if (userDoc.exists) {
        req.user = { uid: token, ...userDoc.data() };
        next();
      } else {
        // Создаем гостя
        req.user = { uid: token, isGuest: true };
        next();
      }
    } catch (e) {
      req.user = { uid: 'guest_' + uuidv4(), isGuest: true };
      next();
    }
  }
};

// ============ AUTH ROUTES ============

app.post('/api/auth/lesta', async (req, res) => {
  try {
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

    // Генерируем токен
    let customToken;
    try {
      customToken = await admin.auth().createCustomToken(firebaseUid);
    } catch (e) {
      customToken = firebaseUid; // fallback
    }
    
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
    
    const userData = {
      uid: firebaseUid,
      guestId: guestId,
      name: name || 'Гость',
      isGuest: true,
      lastLogin: admin.firestore.FieldValue.serverTimestamp()
    };
    
    if (!userDoc.exists) {
      userData.createdAt = admin.firestore.FieldValue.serverTimestamp();
      await userRef.set(userData);
    } else {
      await userRef.update({
        lastLogin: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // Токен - просто ID пользователя
    const token = firebaseUid;
    
    res.json({
      token,
      user: {
        id: firebaseUid,
        name: name || 'Гость',
        isGuest: true,
        guestId: guestId
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
    
    if (!userDoc.exists) {
      return res.json({ 
        user: { 
          id: req.user.uid, 
          name: 'Гость', 
          isGuest: true 
        } 
      });
    }
    
    res.json({ user: userDoc.data() });
  } catch (error) {
    res.json({ 
      user: { 
        id: req.user.uid, 
        name: 'Гость', 
        isGuest: true 
      } 
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
    
    console.log(`Создан брифинг: ${briefingId} пользователем ${req.user.uid}`);
    
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
    console.log(`Запрос брифингов от пользователя: ${req.user.uid}`);
    
    const briefingsSnapshot = await db.collection('briefings')
      .where('ownerId', '==', req.user.uid)
      .orderBy('updatedAt', 'desc')
      .get();
    
    const briefings = [];
    for (const doc of briefingsSnapshot.docs) {
      const briefing = doc.data();
      
      const slidesSnapshot = await db.collection('slides')
        .where('briefingId', '==', briefing.id)
        .get();
      
      const firstSlide = slidesSnapshot.docs[0]?.data();
      
      briefings.push({
        ...briefing,
        slideCount: slidesSnapshot.size,
        firstMap: getMapName(firstSlide?.mapId)
      });
    }
    
    console.log(`Найдено брифингов: ${briefings.length}`);
    
    res.json({ briefings });
  } catch (error) {
    console.error('Get briefings error:', error);
    res.status(500).json({ error: 'Ошибка получения брифингов: ' + error.message });
  }
});

app.get('/api/briefings/:id', authMiddleware, async (req, res) => {
  try {
    console.log(`Запрос брифинга: ${req.params.id}`);
    
    const briefingDoc = await db.collection('briefings').doc(req.params.id).get();
    
    if (!briefingDoc.exists) {
      return res.status(404).json({ error: 'Брифинг не найден' });
    }
    
    const briefing = briefingDoc.data();
    
    const slidesSnapshot = await db.collection('slides')
      .where('briefingId', '==', req.params.id)
      .orderBy('order')
      .get();
    
    const slides = slidesSnapshot.docs.map(doc => doc.data());
    
    const isOwner = briefing.ownerId === req.user.uid;
    const isEditor = briefing.editors?.includes(req.user.uid);
    const myRole = isOwner ? 'owner' : isEditor ? 'editor' : 'viewer';
    
    console.log(`Брифинг загружен, слайдов: ${slides.length}, роль: ${myRole}`);
    
    res.json({
      briefing,
      slides,
      myRole
    });
  } catch (error) {
    console.error('Get briefing error:', error);
    res.status(500).json({ error: 'Ошибка получения брифинга: ' + error.message });
  }
});

app.put('/api/briefings/:id', authMiddleware, async (req, res) => {
  try {
    const briefingRef = db.collection('briefings').doc(req.params.id);
    const briefingDoc = await briefingRef.get();
    
    if (!briefingDoc.exists) {
      return res.status(404).json({ error: 'Брифинг не найден' });
    }
    
    const briefing = briefingDoc.data();
    
    if (briefing.ownerId !== req.user.uid && !briefing.editors?.includes(req.user.uid)) {
      return res.status(403).json({ error: 'Нет прав на редактирование' });
    }
    
    await briefingRef.update({
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
    
    const briefing = briefingDoc.data();
    
    if (briefing.ownerId !== req.user.uid) {
      return res.status(403).json({ error: 'Только владелец может удалить брифинг' });
    }
    
    const slidesSnapshot = await db.collection('slides')
      .where('briefingId', '==', req.params.id)
      .get();
    
    const batch = db.batch();
    slidesSnapshot.docs.forEach(doc => batch.delete(doc.ref));
    batch.delete(briefingRef);
    await batch.commit();
    
    console.log(`Брифинг удален: ${req.params.id}`);
    
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
    
    const briefingDoc = await db.collection('briefings').doc(briefingId).get();
    if (!briefingDoc.exists) {
      return res.status(404).json({ error: 'Брифинг не найден' });
    }
    
    const slidesSnapshot = await db.collection('slides')
      .where('briefingId', '==', briefingId)
      .orderBy('order', 'desc')
      .limit(1)
      .get();
    
    const maxOrder = slidesSnapshot.docs[0]?.data().order ?? -1;
    
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
    
    console.log(`Создан слайд: ${slideId} для брифинга: ${briefingId}`);
    
    res.json({ slide: slideData });
  } catch (error) {
    console.error('Create slide error:', error);
    res.status(500).json({ error: 'Ошибка создания слайда: ' + error.message });
  }
});

app.put('/api/slides/:id', authMiddleware, async (req, res) => {
  try {
    const slideRef = db.collection('slides').doc(req.params.id);
    const slideDoc = await slideRef.get();
    
    if (!slideDoc.exists) {
      return res.status(404).json({ error: 'Слайд не найден' });
    }
    
    await slideRef.update({
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
    const slideRef = db.collection('slides').doc(req.params.id);
    const slideDoc = await slideRef.get();
    
    if (!slideDoc.exists) {
      return res.status(404).json({ error: 'Слайд не найден' });
    }
    
    await slideRef.delete();
    
    console.log(`Слайд удален: ${req.params.id}`);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Delete slide error:', error);
    res.status(500).json({ error: 'Ошибка удаления: ' + error.message });
  }
});

function getMapName(mapId) {
  const maps = {
    'molen': 'Молендейк',
    'himmelsdorf': 'Химмельсдорф',
    'malinovka': 'Малиновка',
    'prohorovka': 'Прохоровка',
    'mines': 'Рудники',
    'castilla': 'Кастилья',
    'canal': 'Канал',
    'port': 'Порт',
    'alpenstadt': 'Альпенштадт',
    'baltic': 'Балтийский щит',
    'vino': 'Виноградники',
    'burningsands': 'Горящие пески',
    'pyramids': 'Древние пирамиды',
    'pearlcity': 'Жемчужный город',
    'pept': 'ПЭПТ',
    'stadion': 'Стадион',
    'ice': 'Ледники',
    'goldvalley': 'Золотая долина',
    'canyon': 'Каньон',
    'quarries': 'Карьеры',
    'lagoon': 'Лагуна',
    'middleburg': 'Миддлбург',
    'seaborder': 'Морской рубеж',
    'normandy': 'Нормандия',
    'newbay': 'Нью-Бэй',
    'industrial': 'Промзона',
    'strait': 'Протока',
    'faust': 'Фауст',
    'fort': 'Форт',
    'hellas': 'Эллада',
    'elalamein': 'Эль-Аламейн',
    'echelon': 'Эшелон',
    'yukon': 'Юкон'
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
  console.log(`Firebase проект: ${serviceAccount.project_id}`);
  console.log(`URL: https://jukstats-planner-server.onrender.com`);
  console.log(`Health check: https://jukstats-planner-server.onrender.com/api/health`);
});
