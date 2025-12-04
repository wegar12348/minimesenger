const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { MongoClient, ObjectId } = require('mongodb');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Замените на вашу строку подключения. Рекомендуется хранить в переменных окружения.
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://RUD01f:<123489>@cluster0.pdd4apt.mongodb.net/?appName=Cluster0";
const DB_NAME = 'miniMessenger';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let db;
let usersCollection;
let messagesCollection;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dev-secret-minimessenger', // Лучше использовать переменную окружения
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);

io.use((socket, next) => {
  sessionMiddleware(socket.request, socket.request.res || {}, next);
});

app.use(express.static(path.join(__dirname, '')));

app.post('/api/register', async (req, res) => {
  const { username, password, display } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username/password required' });

  const existingUser = await usersCollection.findOne({ username });
  if (existingUser) return res.status(400).json({ error: 'user exists' });

  const hashed = bcrypt.hashSync(password, 8);
  const user = { username, password: hashed, display: display || username, friends: [] };
  const result = await usersCollection.insertOne(user);
  
  req.session.user = { id: result.insertedId, username: user.username, display: user.display };
  res.json({ ok: true, user: req.session.user });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await usersCollection.findOne({ username });
  if (!user) return res.status(400).json({ error: 'invalid' });
  if (!bcrypt.compareSync(password, user.password)) return res.status(400).json({ error: 'invalid' });
  req.session.user = { id: user._id, username: user.username, display: user.display };
  res.json({ ok: true, user: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

// Search users by substring
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  if (!q) return res.json({ results: [] });
  const query = { $or: [
    { username: { $regex: q, $options: 'i' } },
    { display: { $regex: q, $options: 'i' } }
  ]};
  const list = await usersCollection.find(query, { projection: { password: 0 } }).toArray();
  res.json({ results: list });
});

// Add friend
app.post('/api/friends/add', async (req, res) => {
  const me = req.session.user; if (!me) return res.status(401).json({ error: 'auth' });
  const { username } = req.body;
  if (username === me.username) return res.status(400).json({ error: 'cannot add yourself' });

  const friend = await usersCollection.findOne({ username });
  if (!friend) return res.status(404).json({ error: 'not found' });

  // Add friend to me and me to friend (bilateral)
  await usersCollection.updateOne({ _id: new ObjectId(me.id) }, { $addToSet: { friends: friend.username } });
  await usersCollection.updateOne({ _id: friend._id }, { $addToSet: { friends: me.username } });

  res.json({ ok: true });
});

app.get('/api/friends', async (req, res) => {
  const me = req.session.user; if (!me) return res.status(401).json({ error: 'auth' });
  const meRec = await usersCollection.findOne({ _id: new ObjectId(me.id) });
  const friends = (meRec.friends || []).map(name => ({ username: name }));
  res.json({ friends });
});

app.get('/api/messages/:peer', async (req, res) => {
  const me = req.session.user; if (!me) return res.status(401).json({ error: 'auth' });
  const peer = req.params.peer;
  const query = {
    $or: [
      { from: me.username, to: peer },
      { from: peer, to: me.username }
    ]
  };
  const msgs = await messagesCollection.find(query).sort({ ts: 1 }).toArray();
  res.json({ messages: msgs });
});

// Socket.io for real-time messages
io.on('connection', (socket) => {
  const sess = socket.request && socket.request.session;
  if (!sess || !sess.user) return socket.disconnect(true);

  const username = sess.user.username;
  socket.join(username); // Join a room with own username
  console.log('socket connected', username);

  socket.on('message', async (payload) => {
    const senderRec = await usersCollection.findOne({ username });
    const recipientRec = await usersCollection.findOne({ username: payload.to });

    if (!recipientRec) {
      socket.emit('error', 'User not found');
      return;
    }
    if (!senderRec || !senderRec.friends.includes(payload.to) || !recipientRec.friends.includes(username)) {
      socket.emit('error', 'Not friends');
      return;
    }

    const msg = { from: username, to: payload.to, text: payload.text, ts: Date.now() };
    await messagesCollection.insertOne(msg);

    // Emit to recipient's room and to sender
    io.to(payload.to).to(username).emit('message', msg);
  });

  socket.on('disconnect', () => {
    console.log('socket disconnected', username);
  });
});

async function startServer() {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db(DB_NAME);
    usersCollection = db.collection('users');
    messagesCollection = db.collection('messages');
    await usersCollection.createIndex({ username: 1 }, { unique: true });
    console.log('Connected to MongoDB');

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => console.log('Server started on', PORT));
  } catch (err) {
    console.error('Failed to connect to MongoDB', err);
    process.exit(1);
  }
}

startServer();
