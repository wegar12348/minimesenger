const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { users: [], messages: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);


app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
  secret: 'dev-secret-minimessenger',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);

// Share express-session with socket.io (make session available as socket.request.session)
io.use((socket, next) => {
  sessionMiddleware(socket.request, socket.request.res || {}, next);
});

app.use(express.static(path.join(__dirname, '')));

// Helper: find user by username
function findUser(data, username) {
  return data.users.find(u => u.username === username);
}

app.post('/api/register', (req, res) => {
  const { username, password, display } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username/password required' });

  const data = loadData();
  if (data.users.some(u => u.username === username)) return res.status(400).json({ error: 'user exists' });

  const hashed = bcrypt.hashSync(password, 8);
  const user = { id: uuidv4(), username, password: hashed, display: display || username, friends: [] };
  data.users.push(user);
  saveData(data);
  req.session.user = { id: user.id, username: user.username, display: user.display };
  res.json({ ok: true, user: req.session.user });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const data = loadData();
  const user = findUser(data, username);
  if (!user) return res.status(400).json({ error: 'invalid' });
  if (!bcrypt.compareSync(password, user.password)) return res.status(400).json({ error: 'invalid' });
  req.session.user = { id: user.id, username: user.username, display: user.display };
  res.json({ ok: true, user: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

// Search users by substring
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const data = loadData();
  const list = data.users
    .filter(u => u.username.toLowerCase().includes(q) || (u.display || '').toLowerCase().includes(q))
    .map(u => ({ id: u.id, username: u.username, display: u.display }));
  res.json({ results: list });
});

// Add friend
app.post('/api/friends/add', (req, res) => {
  const me = req.session.user; if (!me) return res.status(401).json({ error: 'auth' });
  const { username } = req.body;
  const data = loadData();
  const user = findUser(data, username);
  if (!user) return res.status(404).json({ error: 'not found' });
  const meRec = data.users.find(u => u.id === me.id);
  if (!meRec) return res.status(404).json({ error: 'user not found' });
  // Add friend to me
  if (!meRec.friends.includes(user.username)) meRec.friends.push(user.username);
  // Add me to friend (bilateral friendship)
  if (!user.friends.includes(meRec.username)) user.friends.push(meRec.username);
  saveData(data);
  res.json({ ok: true, friends: meRec.friends });
});

app.get('/api/friends', (req, res) => {
  const me = req.session.user; if (!me) return res.status(401).json({ error: 'auth' });
  const data = loadData();
  const meRec = data.users.find(u => u.id === me.id);
  if (!meRec) return res.status(404).json({ error: 'user not found' });
  const friends = (meRec.friends || []).map(name => ({ username: name }));
  res.json({ friends });
});

app.get('/api/messages/:peer', (req, res) => {
  const me = req.session.user; if (!me) return res.status(401).json({ error: 'auth' });
  const peer = req.params.peer;
  const data = loadData();
  const msgs = data.messages.filter(m => (m.from === me.username && m.to === peer) || (m.from === peer && m.to === me.username));
  res.json({ messages: msgs });
});

// Socket.io for real-time messages
io.on('connection', (socket) => {
  // Ensure session exists on socket
  const sess = socket.request && socket.request.session;
  if (!sess || !sess.user) {
    console.log('socket connection without session - disconnect');
    socket.disconnect(true);
    return;
  }
  const username = sess.user.username;
  socket.username = username;
  console.log('socket connected', username);

  socket.on('message', (payload) => {
    // payload: { to, text }
    const data = loadData();
    const senderRec = data.users.find(u => u.username === username);
    const recipientRec = data.users.find(u => u.username === payload.to);

    // Check if both users exist and are friends
    if (!senderRec || !recipientRec) {
      socket.emit('error', 'User not found');
      return;
    }
    if (!senderRec.friends.includes(payload.to) || !recipientRec.friends.includes(username)) {
      socket.emit('error', 'Not friends');
      return;
    }

    const msg = { id: uuidv4(), from: username, to: payload.to, text: payload.text, ts: Date.now() };
    data.messages.push(msg);
    saveData(data);

    // emit to recipient if connected
    for (const [id, s] of Object.entries(io.sockets.sockets)) {
      if (s.username === payload.to) s.emit('message', msg);
    }
    // ack to sender
    socket.emit('message', msg);
  });

  socket.on('disconnect', () => {
    // noop
  });
});

// Initialize data.json if it doesn't exist
if (!fs.existsSync(DATA_FILE)) {
  saveData({ users: [], messages: [] });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server started on', PORT));
