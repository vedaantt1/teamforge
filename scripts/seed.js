// node scripts/seed.js [db]  -> 10,000 users, 2,000 teams (sizes 1..max), rest unteamed. Password for all: password123
import crypto from 'node:crypto';
import { openDb } from '../src/db.js';
const db = openDb(process.argv[2] || process.env.DB_PATH || './data.db');
const SK = ['react', 'node', 'python', 'ml', 'design', 'devops', 'rust', 'mobile', 'data', 'security', 'product', 'embedded'];
const salt = crypto.randomBytes(16), hash = `${salt.toString('hex')}:${crypto.scryptSync('password123', salt, 32).toString('hex')}`;
const r = (n) => Math.floor(Math.random() * n), pick = () => JSON.stringify([...new Set([SK[r(12)], SK[r(12)], SK[r(12)]])]);
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ', code = () => Array.from(crypto.randomBytes(10), (b) => alphabet[b & 31]).join('');
const max = db.prepare('SELECT max_size FROM hackathons WHERE id=1').get().max_size, now = Date.now();
db.transaction(() => {
  const iu = db.prepare('INSERT OR IGNORE INTO users(id,email,name,pw_hash,tz,skills) VALUES(?,?,?,?,?,?)');
  for (let i = 1; i <= 10000; i++) iu.run(i, `u${i}@seed.io`, `User ${i}`, hash, r(27) - 12, pick());
  const it = db.prepare('INSERT OR IGNORE INTO teams(id,hackathon_id,name,leader_id,invite_code,invite_expires,looking,created) VALUES(?,?,?,?,?,?,?,?)');
  const im = db.prepare('INSERT OR IGNORE INTO members(hackathon_id,user_id,team_id,joined_at) VALUES(1,?,?,?)');
  let next = 2001;
  for (let t = 1; t <= 2000; t++) {
    const size = 1 + r(max); it.run(t, 1, `Team ${t}`, t, code(), now + 86400e3, size < max ? 1 : 0, now); im.run(t, t, now);
    for (let k = 1; k < size; k++) im.run(next++, t, now + k);
  }
})();
console.log(db.prepare('SELECT (SELECT COUNT(*) FROM users) users,(SELECT COUNT(*) FROM teams) teams,(SELECT COUNT(*) FROM members) members,(SELECT COUNT(*) FROM teams WHERE looking=1) on_board').get());
