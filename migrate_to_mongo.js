require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/minimessenger';

async function main(){
  console.log('Connecting to', MONGODB_URI);
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  const userSchema = new mongoose.Schema({ id: String, username: String, password: String, display: String, friends: [String] }, { timestamps: true });
  const messageSchema = new mongoose.Schema({ id: String, from: String, to: String, text: String, ts: Number }, { timestamps: true });

  const User = mongoose.model('User_migrate', userSchema, 'users');
  const Message = mongoose.model('Message_migrate', messageSchema, 'messages');

  const dataPath = path.join(__dirname, 'data.json');
  if(!fs.existsSync(dataPath)){
    console.log('No data.json found at', dataPath);
    process.exit(0);
  }

  const raw = fs.readFileSync(dataPath, 'utf8');
  let data;
  try{ data = JSON.parse(raw); } catch(e){ console.error('Invalid JSON in data.json', e.message); process.exit(1); }

  const users = Array.isArray(data.users) ? data.users : [];
  const messages = Array.isArray(data.messages) ? data.messages : [];

  console.log(`Found ${users.length} users and ${messages.length} messages in data.json`);

  // Upsert users
  let ucount = 0;
  for(const u of users){
    const doc = { id: u.id || undefined, username: u.username, password: u.password, display: u.display || u.username, friends: u.friends || [] };
    try{
      await User.updateOne({ username: doc.username }, { $setOnInsert: doc }, { upsert: true });
      ucount++;
    }catch(e){ console.error('User upsert error for', doc.username, e.message); }
  }

  // Upsert messages by id
  let mcount = 0;
  for(const m of messages){
    const doc = { id: m.id || undefined, from: m.from, to: m.to, text: m.text, ts: m.ts || Date.now() };
    try{
      await Message.updateOne({ id: doc.id }, { $setOnInsert: doc }, { upsert: true });
      mcount++;
    }catch(e){ console.error('Message upsert error for', doc.id, e.message); }
  }

  console.log(`Imported (attempted) users: ${ucount}, messages: ${mcount}`);

  // Print counts in DB
  const totalUsers = await User.countDocuments();
  const totalMessages = await Message.countDocuments();
  console.log(`Total users in DB: ${totalUsers}, messages in DB: ${totalMessages}`);

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
