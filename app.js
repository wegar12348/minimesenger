// Minimal frontend logic for MiniMessenger
const api = (path, opts = {}) => fetch(path, opts).then(r => r.json());

let currentUser = null;
let currentChat = null;
let socket = null;

function renderAuth() {
  const el = document.getElementById('auth');
  if (!currentUser) {
    el.innerHTML = `
      <div class="auth-forms">
        <input id="regUser" placeholder="Логин" />
        <input id="regPass" placeholder="Пароль" type="password" />
        <button id="regBtn">Зарегистрироваться</button>
        <hr />
        <input id="logUser" placeholder="Логин" />
        <input id="logPass" placeholder="Пароль" type="password" />
        <button id="logBtn">Войти</button>
      </div>
    `;
    document.getElementById('regBtn').onclick = async () => {
      const username = document.getElementById('regUser').value;
      const password = document.getElementById('regPass').value;
      const res = await api('/api/register', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ username, password }) });
      if (res.ok) { currentUser = res.user; afterLogin(); }
      else alert(res.error || 'Ошибка');
    };
    document.getElementById('logBtn').onclick = async () => {
      const username = document.getElementById('logUser').value;
      const password = document.getElementById('logPass').value;
      const res = await api('/api/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ username, password }) });
      if (res.ok) { currentUser = res.user; afterLogin(); }
      else alert(res.error || 'Ошибка');
    };
  } else {
    el.innerHTML = `<div class="me">${currentUser.display} (<i>${currentUser.username}</i>) <button id="logoutBtn">Выйти</button></div>`;
    document.getElementById('logoutBtn').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };
  }
}

async function afterLogin() {
  renderAuth();
  connectSocket();
  await loadFriends();
}

function connectSocket() {
  if (!currentUser) return;
  socket = io({ query: { username: currentUser.username } });
  socket.on('message', (m) => {
    if (currentChat === m.from || currentChat === m.to) appendMessage(m);
  });
}

async function loadFriends() {
  const res = await api('/api/friends');
  const list = document.getElementById('friendsList');
  list.innerHTML = '';
  for (const f of res.friends) {
    const li = document.createElement('li');
    li.textContent = f.username;
    li.onclick = () => openChat(f.username);
    list.appendChild(li);
  }
}

async function openChat(username) {
  currentChat = username;
  document.getElementById('chatHeader').textContent = 'Чат с ' + username;
  const res = await api('/api/messages/' + encodeURIComponent(username));
  const msgs = res.messages || [];
  const container = document.getElementById('messages');
  container.innerHTML = '';
  msgs.forEach(appendMessage);
}

function appendMessage(m) {
  const container = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg ' + (m.from === currentUser.username ? 'out' : 'in');
  div.textContent = `${m.from}: ${m.text}`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

document.getElementById('sendBtn').onclick = async () => {
  const text = document.getElementById('msgInput').value;
  if (!currentChat) return alert('Выберите чат');
  if (!text) return;
  socket.emit('message', { to: currentChat, text });
  document.getElementById('msgInput').value = '';
};

document.getElementById('searchBtn').onclick = async () => {
  const q = document.getElementById('searchInput').value;
  const res = await api('/api/search?q=' + encodeURIComponent(q));
  const ul = document.createElement('ul');
  const tpl = document.getElementById('userItemTpl');
  const container = document.getElementById('friendsList');
  // show search results in friends area temporarily
  container.innerHTML = '';
  for (const u of res.results) {
    const li = document.createElement('li');
    li.textContent = u.username + (u.display ? ' ('+u.display+')' : '');
    const btn = document.createElement('button'); btn.textContent = 'Добавить';
    btn.onclick = async (e) => { e.stopPropagation(); const r = await api('/api/friends/add', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ username: u.username }) }); if (r.ok) { alert('Добавлено'); loadFriends(); } else alert(r.error); };
    li.appendChild(btn);
    li.onclick = () => openChat(u.username);
    container.appendChild(li);
  }
};

// Init: check session
(async function init(){
  const res = await api('/api/me');
  if (res.user) { currentUser = res.user; afterLogin(); }
  else renderAuth();
})();
