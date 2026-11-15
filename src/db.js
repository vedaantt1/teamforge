import Database from 'better-sqlite3';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS hackathons(id INTEGER PRIMARY KEY, name TEXT NOT NULL, min_size INTEGER NOT NULL, max_size INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, pw_hash TEXT NOT NULL,
  tz INTEGER NOT NULL DEFAULT 0, skills TEXT NOT NULL DEFAULT '[]', looking INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS teams(id INTEGER PRIMARY KEY, hackathon_id INTEGER NOT NULL REFERENCES hackathons(id), name TEXT NOT NULL,
  leader_id INTEGER NOT NULL, invite_code TEXT NOT NULL UNIQUE, invite_expires INTEGER NOT NULL,
  looking INTEGER NOT NULL DEFAULT 1, locked INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL,
  UNIQUE(hackathon_id, name));
-- PRIMARY KEY(hackathon_id,user_id) = "one team per person per hackathon", enforced by the DB, not just by app code.
CREATE TABLE IF NOT EXISTS members(hackathon_id INTEGER NOT NULL, user_id INTEGER NOT NULL, team_id INTEGER NOT NULL,
  joined_at INTEGER NOT NULL, PRIMARY KEY(hackathon_id, user_id));
CREATE INDEX IF NOT EXISTS members_team ON members(team_id, joined_at, user_id);
CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending ON requests(team_id, user_id) WHERE status='pending';
CREATE TABLE IF NOT EXISTS idempotency(user_id INTEGER NOT NULL, key TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL,
  created INTEGER NOT NULL, PRIMARY KEY(user_id, key));
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, actor_id INTEGER, team_id INTEGER, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS audit_team ON audit(team_id, id);
CREATE INDEX IF NOT EXISTS board_idx ON teams(hackathon_id, looking, id);
-- Defense in depth: even a buggy code path cannot overfill a team.
CREATE TRIGGER IF NOT EXISTS cap_guard BEFORE INSERT ON members
WHEN (SELECT COUNT(*) FROM members WHERE team_id=NEW.team_id) >= (SELECT max_size FROM hackathons WHERE id=NEW.hackathon_id)
BEGIN SELECT RAISE(ABORT,'team_full'); END;
`;

export function openDb(path = ':memory:') {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  db.prepare('INSERT OR IGNORE INTO hackathons(id,name,min_size,max_size) VALUES(1,?,?,?)')
    .run('Hackathon', Number(process.env.MIN_SIZE || 2), Number(process.env.MAX_SIZE || 4));
  return db;
}
