const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/minimessenger';
mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✓ MongoDB connected'))
  .catch(err => console.error('✗ MongoDB connection error:', err.message));

// Define schemas
const userSchema = new mongoose.Schema({
  id: { type: String, unique: true, default: () => uuidv4() },
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  display: { type: String, default: '' },
  isAdmin: { type: Boolean, default: false },
  friends: [String]
}, { timestamps: true });

const messageSchema = new mongoose.Schema({
  id: { type: String, unique: true, default: () => uuidv4() },
  from: String,
  to: String,
  text: String,
  ts: { type: Number, default: Date.now }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

// Ensure a default admin user exists (username: min, password: 1248) - only creates if missing
(async function ensureAdmin(){
  try{
    const existing = await User.findOne({ username: 'min' });
    if (!existing) {
      const hashed = bcrypt.hashSync('1248', 8);
      const u = new User({ username: 'min', password: hashed, display: 'admin', friends: [], isAdmin: true });
      await u.save();
      console.log('Default admin user created: min');
    }
  }catch(e){ console.error('ensureAdmin error', e.message); }
})();

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

// Ensure admin page is always reachable even if static serving behaves differently on host
app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Friendly redirect
app.get('/admin', (req, res) => {
  res.redirect('/admin.html');
});

// Helper: find user by username
async function findUser(username) {
  return await User.findOne({ username });
}

app.post('/api/register', async (req, res) => {
  try {
    const { username, password, display } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username/password required' });

    const existing = await User.findOne({ username });
    if (existing) return res.status(400).json({ error: 'user exists' });

    const hashed = bcrypt.hashSync(password, 8);
    const user = new User({ username, password: hashed, display: display || username, friends: [] });
    await user.save();

    req.session.user = { id: user.id, username: user.username, display: user.display };
    res.json({ ok: true, user: req.session.user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await findUser(username);
    if (!user) return res.status(400).json({ error: 'invalid' });
    if (!bcrypt.compareSync(password, user.password)) return res.status(400).json({ error: 'invalid' });

    req.session.user = { id: user.id, username: user.username, display: user.display };
    res.json({ ok: true, user: req.session.user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

// Search users by substring
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase();
    const list = await User.find({
      $or: [
        { username: { $regex: q, $options: 'i' } },
        { display: { $regex: q, $options: 'i' } }
      ]
    }).select('id username display');
    res.json({ results: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add friend
app.post('/api/friends/add', async (req, res) => {
  try {
    const me = req.session.user;
    if (!me) return res.status(401).json({ error: 'auth' });

    const { username } = req.body;
    const friend = await findUser(username);
    if (!friend) return res.status(404).json({ error: 'not found' });

    const meRec = await User.findOne({ id: me.id });
    if (!meRec) return res.status(404).json({ error: 'user not found' });

    // Add friend to me
    if (!meRec.friends.includes(friend.username)) meRec.friends.push(friend.username);
    // Add me to friend (bilateral)
    if (!friend.friends.includes(meRec.username)) friend.friends.push(meRec.username);

    await meRec.save();
    await friend.save();

    res.json({ ok: true, friends: meRec.friends });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/friends', async (req, res) => {
  try {
    const me = req.session.user;
    if (!me) return res.status(401).json({ error: 'auth' });

    const meRec = await User.findOne({ id: me.id });
    if (!meRec) return res.status(404).json({ error: 'user not found' });

    const friends = (meRec.friends || []).map(name => ({ username: name }));
    res.json({ friends });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/messages/:peer', async (req, res) => {
  try {
    const me = req.session.user;
    if (!me) return res.status(401).json({ error: 'auth' });

    const peer = req.params.peer;
    const msgs = await Message.find({
      $or: [
        { from: me.username, to: peer },
        { from: peer, to: me.username }
      ]
    }).sort({ ts: 1 });

    res.json({ messages: msgs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin helpers
function requireAdmin(req, res) {
  const me = req.session.user;
  if (!me) return res.status(401).json({ error: 'auth' });
  return User.findOne({ id: me.id }).then(u => {
    if (!u || !u.isAdmin) return null;
    return u;
  });
}

// List all users (admin only)
app.get('/api/admin/users', async (req, res) => {
  try{
    const admin = await requireAdmin(req, res);
    if (!admin) return res.status(403).json({ error: 'forbidden' });
    const users = await User.find().select('id username display isAdmin');
    res.json({ users });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

// Delete user (admin only)
app.post('/api/admin/users/:username/delete', async (req, res) => {
  try{
    const admin = await requireAdmin(req, res);
    if (!admin) return res.status(403).json({ error: 'forbidden' });
    const username = req.params.username;
    const removed = await User.findOneAndDelete({ username });
    if (!removed) return res.status(404).json({ error: 'not found' });
    // remove from friends lists
    await User.updateMany({}, { $pull: { friends: username } });
    // Optionally remove messages involving that user
    await Message.deleteMany({ $or: [ { from: username }, { to: username } ] });
    res.json({ ok: true });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

// Update user (admin only) - change display or username
app.post('/api/admin/users/:username/update', async (req, res) => {
  try{
    const admin = await requireAdmin(req, res);
    if (!admin) return res.status(403).json({ error: 'forbidden' });
    const username = req.params.username;
    const { newUsername, display } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: 'not found' });
    const oldUsername = user.username;
    if (display) user.display = display;
    if (newUsername && newUsername !== oldUsername) {
      // ensure unique
      const exists = await User.findOne({ username: newUsername });
      if (exists) return res.status(400).json({ error: 'username exists' });
      user.username = newUsername;
      // update friends lists
      await User.updateMany({ friends: oldUsername }, { $set: { 'friends.$': newUsername } });
      // update messages
      await Message.updateMany({ from: oldUsername }, { $set: { from: newUsername } });
      await Message.updateMany({ to: oldUsername }, { $set: { to: newUsername } });
    }
    await user.save();
    res.json({ ok: true, user: { id: user.id, username: user.username, display: user.display } });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

// Reset password (admin only)
app.post('/api/admin/users/:username/reset-password', async (req, res) => {
  try{
    const admin = await requireAdmin(req, res);
    if (!admin) return res.status(403).json({ error: 'forbidden' });
    const username = req.params.username;
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'password required' });
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: 'not found' });
    user.password = bcrypt.hashSync(password, 8);
    await user.save();
    res.json({ ok: true });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

// Impersonate: set current session to target user (admin only)
app.post('/api/admin/impersonate/:username', async (req, res) => {
  try{
    const admin = await requireAdmin(req, res);
    if (!admin) return res.status(403).json({ error: 'forbidden' });
    const username = req.params.username;
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: 'not found' });
    req.session.user = { id: user.id, username: user.username, display: user.display };
    res.json({ ok: true, user: req.session.user });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

// Send message as another user (admin only)
app.post('/api/admin/send-as/:username', async (req, res) => {
  try{
    const admin = await requireAdmin(req, res);
    if (!admin) return res.status(403).json({ error: 'forbidden' });
    const username = req.params.username; // from
    const { to, text } = req.body;
    if (!to || !text) return res.status(400).json({ error: 'to/text required' });
    const sender = await User.findOne({ username });
    const recipient = await User.findOne({ username: to });
    if (!sender || !recipient) return res.status(404).json({ error: 'user not found' });
    // create message
    const msg = new Message({ from: sender.username, to: recipient.username, text });
    await msg.save();
    // emit to recipient socket if connected
    for (const [id, s] of Object.entries(io.sockets.sockets)) {
      if (s.username === recipient.username) s.emit('message', msg);
    }
    res.json({ ok: true, message: msg });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

// Socket.io for real-time messages
io.on('connection', (socket) => {
  const sess = socket.request && socket.request.session;
  if (!sess || !sess.user) {
    console.log('socket connection without session - disconnect');
    socket.disconnect(true);
    return;
  }

  const username = sess.user.username;
  socket.username = username;
  console.log('socket connected', username);

  socket.on('message', async (payload) => {
    try {
      const senderRec = await findUser(username);
      const recipientRec = await findUser(payload.to);

      if (!senderRec || !recipientRec) {
        socket.emit('error', 'User not found');
        return;
      }

      if (!senderRec.friends.includes(payload.to) || !recipientRec.friends.includes(username)) {
        socket.emit('error', 'Not friends');
        return;
      }

      const msg = new Message({ from: username, to: payload.to, text: payload.text });
      await msg.save();

      // emit to recipient if connected
      for (const [id, s] of Object.entries(io.sockets.sockets)) {
        if (s.username === payload.to) s.emit('message', msg);
      }
      // ack to sender
      socket.emit('message', msg);
    } catch (e) {
      socket.emit('error', e.message);
    }
  });

  socket.on('disconnect', () => {
    console.log('socket disconnected', username);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Server started on http://localhost:${PORT}`);
  console.log(`📱 Access from phone: http://<your-ip>:${PORT}\n`);
});
