require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

// В начало server.js добавьте:
const http = require('http');
const { Server } = require('socket.io');

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// Замените app.listen на:
server.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📦 Firebase проект: ${serviceAccount.project_id}`);
    console.log(`🔌 WebSocket готов`);
});

// ===== WEB SOCKET ДЛЯ REAL-TIME =====
const rooms = {}; // Хранилище комнат

io.on('connection', (socket) => {
    console.log('🔌 Новое подключение:', socket.id);
    
    // Присоединение к комнате брифинга
    socket.on('join-room', ({ briefingId, user }) => {
        socket.join(briefingId);
        socket.briefingId = briefingId;
        socket.user = user;
        
        // Инициализируем комнату если нужно
        if (!rooms[briefingId]) {
            rooms[briefingId] = {
                users: {},
                state: null,
                presenter: null
            };
        }
        
        // Добавляем пользователя
        rooms[briefingId].users[socket.id] = {
            ...user,
            cursor: { x: 0, y: 0 },
            lastSeen: Date.now()
        };
        
        // Отправляем текущее состояние комнаты новому пользователю
        socket.emit('room-state', {
            users: rooms[briefingId].users,
            presenter: rooms[briefingId].presenter,
            state: rooms[briefingId].state
        });
        
        // Уведомляем всех о новом участнике
        io.to(briefingId).emit('user-joined', {
            userId: user.id,
            userName: user.name,
            users: rooms[briefingId].users
        });
        
        console.log(`👤 ${user.name} присоединился к брифингу ${briefingId}`);
    });
    
    // Обновление позиции курсора
    socket.on('cursor-move', ({ x, y }) => {
        if (!socket.briefingId || !rooms[socket.briefingId]) return;
        
        const room = rooms[socket.briefingId];
        if (room.users[socket.id]) {
            room.users[socket.id].cursor = { x, y };
            room.users[socket.id].lastSeen = Date.now();
        }
        
        // Отправляем позицию всем кроме отправителя
        socket.to(socket.briefingId).emit('cursor-update', {
            userId: socket.user?.id || socket.id,
            x, y
        });
    });
    
    // Пинг (жест)
    socket.on('ping', ({ x, y, color }) => {
        if (!socket.briefingId) return;
        socket.to(socket.briefingId).emit('ping-received', {
            userId: socket.user?.id || socket.id,
            userName: socket.user?.name || 'Участник',
            x, y, color
        });
    });
    
    // Обновление состояния слайда
    socket.on('slide-update', ({ slide, entities, mapId }) => {
        if (!socket.briefingId) return;
        
        const room = rooms[socket.briefingId];
        room.state = { slide, entities, mapId };
        
        socket.to(socket.briefingId).emit('slide-changed', {
            slide, entities, mapId,
            updatedBy: socket.user?.name || 'Участник'
        });
    });
    
    // Презентация
    socket.on('present-start', ({ slide }) => {
        if (!socket.briefingId) return;
        rooms[socket.briefingId].presenter = socket.user?.id || socket.id;
        io.to(socket.briefingId).emit('presentation-started', {
            presenter: socket.user?.name || 'Ведущий',
            slide
        });
    });
    
    socket.on('present-stop', () => {
        if (!socket.briefingId) return;
        rooms[socket.briefingId].presenter = null;
        io.to(socket.briefingId).emit('presentation-stopped');
    });
    
    socket.on('present-slide', ({ slide }) => {
        if (!socket.briefingId) return;
        socket.to(socket.briefingId).emit('presentation-slide-changed', { slide });
    });
    
    // Отключение
    socket.on('disconnect', () => {
        console.log('🔌 Отключение:', socket.id);
        
        if (socket.briefingId && rooms[socket.briefingId]) {
            const room = rooms[socket.briefingId];
            const userName = room.users[socket.id]?.name || 'Участник';
            
            delete room.users[socket.id];
            
            // Уведомляем об уходе
            io.to(socket.briefingId).emit('user-left', {
                userId: socket.user?.id || socket.id,
                userName,
                users: room.users
            });
            
            // Очищаем пустые комнаты
            if (Object.keys(room.users).length === 0) {
                setTimeout(() => {
                    if (Object.keys(room.users).length === 0) {
                        delete rooms[socket.briefingId];
                    }
                }, 60000); // Удаляем через минуту
            }
        }
    });
    
    // Очистка неактивных пользователей
    setInterval(() => {
        for (const briefingId in rooms) {
            const room = rooms[briefingId];
            const now = Date.now();
            for (const socketId in room.users) {
                if (now - room.users[socketId].lastSeen > 30000) {
                    delete room.users[socketId];
                }
            }
            if (Object.keys(room.users).length === 0) {
                delete rooms[briefingId];
            }
        }
    }, 30000);
});

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
    try {
      serviceAccount = require('./serviceAccountKey.json');
    } catch (e) {
      console.error('❌ No Firebase credentials found');
      process.exit(1);
    }
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

// Статические файлы из корня проекта
app.use(express.static(__dirname));
app.use('/js', express.static(path.join(__dirname, 'js')));
app.use('/img', express.static(path.join(__dirname, 'img')));
app.use('/css', express.static(path.join(__dirname, 'css')));

// Логирование API запросов
app.use('/api', (req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Главная страница
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'briefings.html'));
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
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
  } catch (error) {
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
    console.error('❌ Create briefing error:', error);
    res.status(500).json({ error: 'Ошибка создания брифинга: ' + error.message });
  }
});

// Получение списка брифингов
app.get('/api/briefings', authMiddleware, async (req, res) => {
  try {
    console.log('📋 Fetching briefings for:', req.user.uid);
    
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
    
    const result = [];
    for (const briefing of briefings) {
      // Получаем первый слайд
      const slidesSnapshot = await db.collection('slides')
        .where('briefingId', '==', briefing.id)
        .orderBy('order')
        .limit(1)
        .get();
      
      const firstSlide = slidesSnapshot.docs[0]?.data();
      
      // Считаем общее количество слайдов
      const countSnapshot = await db.collection('slides')
        .where('briefingId', '==', briefing.id)
        .count()
        .get();
      
      result.push({
        ...briefing,
        slideCount: countSnapshot.data().count,
        firstMap: firstSlide?.mapId || 'molen',
        firstSlide: firstSlide || null
      });
    }
    
    // Сортируем по дате (новые сначала)
    result.sort((a, b) => {
      const dateA = a.updatedAt?.toDate?.() || new Date(0);
      const dateB = b.updatedAt?.toDate?.() || new Date(0);
      return dateB - dateA;
    });
    
    console.log('✅ Found briefings:', result.length);
    
    res.json({ briefings: result });
  } catch (error) {
    console.error('❌ Get briefings error:', error);
    res.status(500).json({ error: 'Ошибка получения брифингов: ' + error.message });
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
    
    // Получаем все слайды
    const slidesSnapshot = await db.collection('slides')
      .where('briefingId', '==', req.params.id)
      .orderBy('order')
      .get();
    
    const slides = [];
    slidesSnapshot.forEach(doc => slides.push(doc.data()));
    
    const isOwner = briefing.ownerId === req.user.uid;
    const isEditor = briefing.editors?.includes(req.user.uid);
    
    res.json({
      briefing,
      slides,
      myRole: isOwner ? 'owner' : isEditor ? 'editor' : 'viewer'
    });
  } catch (error) {
    console.error('❌ Get briefing error:', error);
    res.status(500).json({ error: 'Ошибка получения брифинга: ' + error.message });
  }
});

// Обновление брифинга
app.put('/api/briefings/:id', authMiddleware, async (req, res) => {
  try {
    await db.collection('briefings').doc(req.params.id).update({
      ...req.body,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Update briefing error:', error);
    res.status(500).json({ error: 'Ошибка обновления: ' + error.message });
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
    
    // Удаляем все слайды
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
    console.error('❌ Delete briefing error:', error);
    res.status(500).json({ error: 'Ошибка удаления: ' + error.message });
  }
});

// ============ SLIDES ROUTES ============

// Создание слайда
app.post('/api/slides', authMiddleware, async (req, res) => {
  try {
    const { briefingId, name, mapId } = req.body;
    
    // Получаем текущее количество слайдов для order
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
    console.error('❌ Create slide error:', error);
    res.status(500).json({ error: 'Ошибка создания слайда: ' + error.message });
  }
});

// Обновление слайда
app.put('/api/slides/:id', authMiddleware, async (req, res) => {
  try {
    await db.collection('slides').doc(req.params.id).update({
      ...req.body,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Update slide error:', error);
    res.status(500).json({ error: 'Ошибка обновления слайда: ' + error.message });
  }
});

// Удаление слайда
app.delete('/api/slides/:id', authMiddleware, async (req, res) => {
  try {
    await db.collection('slides').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Delete slide error:', error);
    res.status(500).json({ error: 'Ошибка удаления слайда: ' + error.message });
  }
});

// Все остальные запросы
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  
  const filePath = path.join(__dirname, req.path);
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }
  
  res.sendFile(path.join(__dirname, 'briefings.html'));
});

// Обработка ошибок
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`📦 Firebase проект: ${serviceAccount.project_id}`);
  console.log(`🌐 http://localhost:${PORT}/briefings.html`);
});
