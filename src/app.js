import express from 'express';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { openDb } from './db.js';

const scrypt = promisify(crypto.scrypt);
const H = 1; // single hackathon id; schema supports many
const INVITE_TTL_MS = Number(process.env.INVITE_TTL_MS || 24 * 3600e3);
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, 5 bits/char

class HttpError extends Error { constructor(status, code, msg) { super(msg || code); this.status = status; this.code = code; } }
const bad = (m) => new HttpError(400, 'invalid_input', m);

const str = (v, f, min, max) => { if (typeof v !== 'string') throw bad(`${f} must be a string`); v = v.trim(); if (v.length < min || v.length > max) throw bad(`${f} must be ${min}-${max} chars`); return v; };
const int = (v, f, min, max) => { if (!Number.isInteger(v) || v < min || v > max) throw bad(`${f} must be an integer ${min}..${max}`); return v; };
const id = (v, f = 'id') => { const n = Number(v); if (!/^\d{1,12}$/.test(String(v))) throw bad(`${f} invalid`); return n; };
const skillList = (v) => { if (!Array.isArray(v) || v.length > 12) throw bad('skills must be an array of <=12'); return [...new Set(v.map((s) => str(s, 'skill', 1, 24).toLowerCase()))]; };
const newCode = () => Array.from(crypto.randomBytes(10), (b) => ALPHABET[b & 31]).join(''); // 50 bits

const hashPw = async (pw, salt = crypto.randomBytes(16)) => `${salt.toString('hex')}:${(await scrypt(pw, salt, 32)).toString('hex')}`;
const checkPw = async (pw, stored) => { const [s, h] = stored.split(':'); const d = await scrypt(pw, Buffer.from(s, 'hex'), 32); return crypto.timingSafeEqual(d, Buffer.from(h, 'hex')); };

export function createApp({ dbPath = ':memory:', secret = process.env.SECRET || crypto.randomBytes(32).toString('hex'), rateLimit = true, staticMw = null } = {}) {
  const db = openDb(dbPath);
  const sign = (uid) => { const p = Buffer.from(JSON.stringify({ uid, exp: Date.now() + 12 * 3600e3 })).toString('base64url'); return `${p}.${crypto.createHmac('sha256', secret).update(p).digest('base64url')}`; };
  const verify = (t) => {
    const [p, s] = String(t || '').split('.'); if (!p || !s) return null;
    const e = crypto.createHmac('sha256', secret).update(p).digest('base64url');
    if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
    const d = JSON.parse(Buffer.from(p, 'base64url').toString()); return d.exp > Date.now() ? d.uid : null;
  };

  // Fixed-window limiter kept in memory: per process only (see DESIGN.md).
  const buckets = new Map();
  const limit = (name, max, windowMs, keyFn) => (req, res, next) => {
    if (!rateLimit) return next();
    const k = `${name}:${keyFn(req)}`, now = Date.now(); let b = buckets.get(k);
    if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(k, b); }
    if (++b.n > max) { res.set('Retry-After', Math.ceil((b.reset - now) / 1000)); return next(new HttpError(429, 'rate_limited', 'too many requests')); }
    next();
  };
  setInterval(() => { const n = Date.now(); for (const [k, b] of buckets) if (b.reset < n) buckets.delete(k); }, 60e3).unref();

  const subs = new Map(); // topic -> Set<{ res, uid }>
  const isMember = (uid, teamId) => q.membership.get(H, uid)?.team_id === teamId;
  const unsubscribe = (topic, sub) => { const set = subs.get(topic); set?.delete(sub); if (set && !set.size) subs.delete(topic); };
  // Team streams are re-authorised at delivery time, after COMMIT: a subscriber who is no longer a member gets one
  // content-free terminal event and the stream is closed, so nothing private reaches a former member.
  const publish = (topic, event) => {
    const team = /^team:(\d+)$/.exec(topic), msg = `data: ${JSON.stringify(event)}\n\n`;
    for (const sub of [...(subs.get(topic) || [])]) {
      if (team && !isMember(sub.uid, Number(team[1]))) { sub.res.write('data: {"type":"membership_ended"}\n\n'); sub.res.end(); unsubscribe(topic, sub); continue; }
      sub.res.write(msg);
    }
  };
  const pending = []; // events queued during a transaction, flushed after COMMIT
  const emit = (topic, event) => pending.push([topic, event]);

  const q = {
    user: db.prepare('SELECT id,email,name,tz,skills,looking FROM users WHERE id=?'),
    membership: db.prepare('SELECT team_id FROM members WHERE hackathon_id=? AND user_id=?'),
    team: db.prepare('SELECT * FROM teams WHERE id=?'),
    count: db.prepare('SELECT COUNT(*) c FROM members WHERE team_id=?'),
    members: db.prepare('SELECT u.id,u.name,u.tz,u.skills,m.joined_at FROM members m JOIN users u ON u.id=m.user_id WHERE m.team_id=? ORDER BY m.joined_at,u.id'),
    addMember: db.prepare('INSERT INTO members(hackathon_id,user_id,team_id,joined_at) VALUES(?,?,?,?)'),
    audit: db.prepare('INSERT INTO audit(ts,actor_id,team_id,action,detail) VALUES(?,?,?,?,?)'),
    idem: db.prepare('SELECT status,body FROM idempotency WHERE user_id=? AND key=?'),
    idemPut: db.prepare('INSERT INTO idempotency(user_id,key,status,body,created) VALUES(?,?,?,?,?)'),
    hack: db.prepare('SELECT * FROM hackathons WHERE id=?'),
  };
  const audit = (actor, team, action, detail = {}) => q.audit.run(Date.now(), actor, team, action, JSON.stringify(detail));
  const sizeOf = (tid) => q.count.get(tid).c;
  const teamView = (t, withInvite) => ({ id: t.id, name: t.name, leaderId: t.leader_id, looking: !!t.looking, locked: !!t.locked, size: sizeOf(t.id),
    minSize: q.hack.get(H).min_size, maxSize: q.hack.get(H).max_size, ...(withInvite && { inviteCode: t.invite_code, inviteExpires: t.invite_expires }) });
  const boardEvent = (t) => emit('board', { type: 'team', team: teamView(t) });
  const teamEvent = (tid, type, extra = {}) => emit(`team:${tid}`, { type, ...extra });

  // Run `fn` inside one IMMEDIATE (write-locked) transaction, with idempotency-key replay in the SAME transaction,
  // so "did the effect happen" and "was the key recorded" can never disagree (even if the process is killed mid-way).
  const mutate = (req, fn) => {
    const key = req.get('Idempotency-Key');
    if (key !== undefined && !/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw bad('Idempotency-Key must be 8-80 url-safe chars');
    const run = db.transaction(() => {
      if (key) { const hit = q.idem.get(req.uid, key); if (hit) return { status: hit.status, body: JSON.parse(hit.body), replay: true }; }
      const out = fn(); if (key) q.idemPut.run(req.uid, key, out.status, JSON.stringify(out.body), Date.now()); return out;
    });
    pending.length = 0;
    let out; try { out = run.immediate(); } catch (e) { pending.length = 0; throw e; }
    if (!out.replay) for (const [t, ev] of pending.splice(0)) publish(t, ev);
    return out;
  };

  // The single place a seat is taken. Caller holds the write lock.
  function addToTeam(teamId, userId, how, actor) {
    const t = q.team.get(teamId); if (!t) throw new HttpError(404, 'team_not_found');
    if (q.membership.get(H, userId)) {
      if (q.membership.get(H, userId).team_id === teamId) return t; // already here: idempotent no-op
      throw new HttpError(409, 'already_in_team', 'user already belongs to a team');
    }
    if (t.locked) throw new HttpError(409, 'team_locked');
    if (sizeOf(teamId) >= q.hack.get(H).max_size) throw new HttpError(409, 'team_full');
    q.addMember.run(H, userId, teamId, Date.now());
    db.prepare("UPDATE requests SET status='cancelled' WHERE user_id=? AND status='pending' AND team_id IN (SELECT id FROM teams WHERE hackathon_id=?)").run(userId, H);
    audit(actor, teamId, 'member_joined', { userId, how });
    const fresh = q.team.get(teamId);
    if (sizeOf(teamId) >= q.hack.get(H).max_size) db.prepare('UPDATE teams SET looking=0 WHERE id=?').run(teamId);
    boardEvent(q.team.get(teamId)); teamEvent(teamId, 'member_joined', { userId });
    return fresh;
  }
  function removeFromTeam(teamId, userId, action, actor) {
    const t = q.team.get(teamId);
    if (t.locked && sizeOf(teamId) - 1 < q.hack.get(H).min_size && sizeOf(teamId) > 1) throw new HttpError(409, 'below_min_size', 'unlock the team first');
    db.prepare('DELETE FROM members WHERE hackathon_id=? AND user_id=? AND team_id=?').run(H, userId, teamId);
    audit(actor, teamId, action, { userId });
    const rest = q.members.all(teamId);
    if (rest.length === 0) {
      db.prepare('DELETE FROM requests WHERE team_id=?').run(teamId); db.prepare('DELETE FROM teams WHERE id=?').run(teamId);
      audit(actor, teamId, 'team_deleted', {}); emit('board', { type: 'team_deleted', teamId });
      teamEvent(teamId, 'team_deleted'); return; // no member remains, so this publish is what closes the last member's stream
    }
    if (t.leader_id === userId) { // leadership passes to the longest-standing member (deterministic)
      db.prepare('UPDATE teams SET leader_id=? WHERE id=?').run(rest[0].id, teamId);
      audit(actor, teamId, 'leader_changed', { from: userId, to: rest[0].id }); teamEvent(teamId, 'leader_changed', { leaderId: rest[0].id });
    }
    db.prepare('UPDATE teams SET looking=1 WHERE id=? AND locked=0').run(teamId);
    boardEvent(q.team.get(teamId)); teamEvent(teamId, 'member_left', { userId });
  }
  const leaderOnly = (teamId, uid) => { const t = q.team.get(teamId); if (!t) throw new HttpError(404, 'team_not_found'); if (t.leader_id !== uid) throw new HttpError(403, 'not_leader'); return t; };

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));
  app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }); next(); });
  const wrap = (fn) => async (req, res, next) => { try { const out = await fn(req, res); if (out) { if (out.replay) res.set('Idempotent-Replay', 'true'); res.status(out.status).json(out.body); } } catch (e) { next(e); } };
  const ip = (r) => r.ip;
  const auth = (req, res, next) => { const m = /^Bearer (.+)$/.exec(req.get('Authorization') || ''); const uid = verify(m?.[1] ?? req.query.token); if (!uid) return next(new HttpError(401, 'unauthenticated')); req.uid = uid; next(); };

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.post('/auth/register', limit('reg', 20, 60e3, ip), wrap(async (req) => {
    const b = req.body || {}; const email = str(b.email, 'email', 5, 120).toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('email invalid');
    const name = str(b.name, 'name', 1, 60), pw = str(b.password, 'password', 8, 100), tz = int(b.tz ?? 0, 'tz', -12, 14), skills = skillList(b.skills ?? []);
    const pw_hash = await hashPw(pw);
    try { const r = db.prepare('INSERT INTO users(email,name,pw_hash,tz,skills) VALUES(?,?,?,?,?)').run(email, name, pw_hash, tz, JSON.stringify(skills)); return { status: 201, body: { token: sign(Number(r.lastInsertRowid)), id: Number(r.lastInsertRowid) } }; }
    catch (e) { if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'email_taken'); throw e; }
  }));
  app.post('/auth/login', limit('login', 10, 60e3, (r) => `${ip(r)}`), wrap(async (req) => {
    const email = str(req.body?.email, 'email', 5, 120).toLowerCase(), pw = str(req.body?.password, 'password', 1, 100);
    const u = db.prepare('SELECT id,pw_hash FROM users WHERE email=?').get(email);
    if (!u || !(await checkPw(pw, u.pw_hash))) throw new HttpError(401, 'bad_credentials');
    return { status: 200, body: { token: sign(u.id), id: u.id } };
  }));

  if (staticMw) app.use(staticMw);
  app.use(auth);
  app.get('/me', wrap((req) => { const u = q.user.get(req.uid); const m = q.membership.get(H, req.uid); return { status: 200, body: { ...u, skills: JSON.parse(u.skills), teamId: m?.team_id ?? null } }; }));

  app.post('/teams', limit('mk', 10, 60e3, (r) => r.uid), wrap((req) => mutate(req, () => {
    const name = str(req.body?.name, 'name', 2, 40);
    if (q.membership.get(H, req.uid)) throw new HttpError(409, 'already_in_team');
    let tid; try {
      tid = Number(db.prepare('INSERT INTO teams(hackathon_id,name,leader_id,invite_code,invite_expires,created) VALUES(?,?,?,?,?,?)').run(H, name, req.uid, newCode(), Date.now() + INVITE_TTL_MS, Date.now()).lastInsertRowid);
    } catch (e) { if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'team_name_taken'); throw e; }
    q.addMember.run(H, req.uid, tid, Date.now()); audit(req.uid, tid, 'team_created', { name });
    const t = q.team.get(tid); boardEvent(t); return { status: 201, body: teamView(t, true) };
  })));

  app.get('/board', wrap((req) => {
    const after = req.query.after ? id(req.query.after, 'after') : 0, lim = Math.min(Number(req.query.limit) || 50, 100);
    const rows = db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM members m WHERE m.team_id=t.id) size FROM teams t WHERE t.hackathon_id=? AND t.looking=1 AND t.id>? AND (SELECT COUNT(*) FROM members m WHERE m.team_id=t.id) < ? ORDER BY t.id LIMIT ?`).all(H, after, q.hack.get(H).max_size, lim);
    const h = q.hack.get(H);
    return { status: 200, body: { teams: rows.map((t) => ({ id: t.id, name: t.name, size: t.size, maxSize: h.max_size, minSize: h.min_size })), next: rows.length === lim ? rows[rows.length - 1].id : null } };
  }));

  app.get('/teams/:id', wrap((req) => {
    const t = q.team.get(id(req.params.id)); if (!t) throw new HttpError(404, 'team_not_found');
    const mine = q.membership.get(H, req.uid)?.team_id === t.id, leader = t.leader_id === req.uid;
    const body = { ...teamView(t, leader), members: q.members.all(t.id).map((m) => ({ id: m.id, name: m.name, skills: JSON.parse(m.skills) })) };
    if (leader) body.requests = db.prepare("SELECT r.id,r.user_id userId,u.name,u.skills FROM requests r JOIN users u ON u.id=r.user_id WHERE r.team_id=? AND r.status='pending' ORDER BY r.id").all(t.id).map((r) => ({ ...r, skills: JSON.parse(r.skills) }));
    body.isMember = mine; return { status: 200, body };
  }));

  // Join with an invite code: the contended path. Brute-force defence: 50-bit codes plus per-user and per-IP limits.
  app.post('/join', limit('join-u', 10, 60e3, (r) => r.uid), limit('join-ip', 60, 60e3, ip), wrap((req) => mutate(req, () => {
    const code = str(req.body?.code, 'code', 10, 10).toUpperCase();
    const t = db.prepare('SELECT * FROM teams WHERE invite_code=?').get(code);
    if (!t) throw new HttpError(404, 'invalid_code'); if (t.invite_expires < Date.now()) throw new HttpError(410, 'code_expired');
    const r = addToTeam(t.id, req.uid, 'invite_code', req.uid); return { status: 200, body: teamView(r) };
  })));

  app.post('/teams/:id/rotate-invite', wrap((req) => mutate(req, () => {
    const t = leaderOnly(id(req.params.id), req.uid); const code = newCode(), exp = Date.now() + INVITE_TTL_MS;
    db.prepare('UPDATE teams SET invite_code=?, invite_expires=? WHERE id=?').run(code, exp, t.id); audit(req.uid, t.id, 'invite_rotated'); return { status: 200, body: { inviteCode: code, inviteExpires: exp } };
  })));

  app.post('/teams/:id/requests', limit('req', 20, 60e3, (r) => r.uid), wrap((req) => mutate(req, () => {
    const t = q.team.get(id(req.params.id)); if (!t) throw new HttpError(404, 'team_not_found');
    const m = q.membership.get(H, req.uid); if (m) throw new HttpError(409, 'already_in_team');
    if (t.locked || sizeOf(t.id) >= q.hack.get(H).max_size) throw new HttpError(409, 'team_full');
    const ex = db.prepare("SELECT id FROM requests WHERE team_id=? AND user_id=? AND status='pending'").get(t.id, req.uid);
    if (ex) return { status: 200, body: { requestId: ex.id } };
    const rid = Number(db.prepare('INSERT INTO requests(team_id,user_id,created) VALUES(?,?,?)').run(t.id, req.uid, Date.now()).lastInsertRowid);
    audit(req.uid, t.id, 'join_requested', { requestId: rid }); teamEvent(t.id, 'request_created', { requestId: rid }); return { status: 201, body: { requestId: rid } };
  })));

  const decide = (accept) => wrap((req) => mutate(req, () => {
    const t = leaderOnly(id(req.params.id), req.uid); const r = db.prepare("SELECT * FROM requests WHERE id=? AND team_id=?").get(id(req.params.rid, 'rid'), t.id);
    if (!r) throw new HttpError(404, 'request_not_found'); if (r.status !== 'pending') throw new HttpError(409, 'request_not_pending');
    if (accept) { addToTeam(t.id, r.user_id, 'request_accepted', req.uid); db.prepare("UPDATE requests SET status='accepted' WHERE id=?").run(r.id); }
    else { db.prepare("UPDATE requests SET status='declined' WHERE id=?").run(r.id); audit(req.uid, t.id, 'request_declined', { userId: r.user_id }); }
    teamEvent(t.id, 'request_resolved', { requestId: r.id }); return { status: 200, body: teamView(q.team.get(t.id)) };
  }));
  app.post('/teams/:id/requests/:rid/accept', decide(true));
  app.post('/teams/:id/requests/:rid/decline', decide(false));

  app.post('/teams/:id/members/:uid/remove', wrap((req) => mutate(req, () => {
    const t = leaderOnly(id(req.params.id), req.uid), target = id(req.params.uid, 'uid');
    if (target === req.uid) throw bad('use /leave to remove yourself');
    if (q.membership.get(H, target)?.team_id !== t.id) throw new HttpError(404, 'not_a_member');
    removeFromTeam(t.id, target, 'member_removed', req.uid); return { status: 200, body: teamView(q.team.get(t.id)) };
  })));
  app.post('/teams/:id/leave', wrap((req) => mutate(req, () => {
    const tid = id(req.params.id); const m = q.membership.get(H, req.uid);
    if (!m || m.team_id !== tid) return { status: 200, body: { left: true } }; // retry after success: still success
    removeFromTeam(tid, req.uid, 'member_left', req.uid); return { status: 200, body: { left: true } };
  })));
  app.post('/teams/:id/lock', wrap((req) => mutate(req, () => {
    const t = leaderOnly(id(req.params.id), req.uid); const lock = req.body?.locked !== false;
    if (lock && sizeOf(t.id) < q.hack.get(H).min_size) throw new HttpError(409, 'below_min_size');
    db.prepare('UPDATE teams SET locked=?, looking=? WHERE id=?').run(lock ? 1 : 0, !lock && sizeOf(t.id) < q.hack.get(H).max_size ? 1 : 0, t.id); audit(req.uid, t.id, lock ? 'team_locked' : 'team_unlocked');
    boardEvent(q.team.get(t.id)); teamEvent(t.id, 'team_updated'); return { status: 200, body: teamView(q.team.get(t.id)) };
  })));

  app.get('/teams/:id/audit', wrap((req) => {
    const tid = id(req.params.id); if (q.membership.get(H, req.uid)?.team_id !== tid) throw new HttpError(403, 'not_member');
    return { status: 200, body: { entries: db.prepare('SELECT id,ts,actor_id actorId,action,detail FROM audit WHERE team_id=? ORDER BY id DESC LIMIT 200').all(tid).map((e) => ({ ...e, detail: JSON.parse(e.detail) })) } };
  }));

  // Suggestions: score = 0.65*skillComplement + 0.35*timezoneFit (explained in DESIGN.md)
  app.get('/teams/:id/suggestions', wrap((req) => {
    const t = leaderOnly(id(req.params.id), req.uid); const mem = q.members.all(t.id);
    const have = new Set(mem.flatMap((m) => JSON.parse(m.skills))); const tzs = mem.map((m) => m.tz);
    const cx = Math.atan2(...tzs.reduce((a, z) => [a[0] + Math.sin((z / 24) * 2 * Math.PI), a[1] + Math.cos((z / 24) * 2 * Math.PI)], [0, 0]));
    const centre = (cx / (2 * Math.PI)) * 24; // circular mean of team time zones
    const cands = db.prepare('SELECT u.id,u.name,u.tz,u.skills FROM users u WHERE u.looking=1 AND NOT EXISTS (SELECT 1 FROM members m WHERE m.user_id=u.id AND m.hackathon_id=?) LIMIT 2000').all(H);
    const out = cands.map((u) => {
      const sk = JSON.parse(u.skills); const fresh = sk.filter((s) => !have.has(s));
      const comp = sk.length ? fresh.length / sk.length : 0; // share of the candidate's skills that the team lacks
      let d = Math.abs(u.tz - centre) % 24; d = Math.min(d, 24 - d); const tzFit = 1 - Math.min(d, 12) / 12;
      return { id: u.id, name: u.name, score: +(0.65 * comp + 0.35 * tzFit).toFixed(3), why: { newSkills: fresh, skillComplement: +comp.toFixed(2), tzDistanceHours: +d.toFixed(1), tzFit: +tzFit.toFixed(2) } };
    }).sort((a, b) => b.score - a.score || a.id - b.id).slice(0, 20);
    return { status: 200, body: { formula: 'score = 0.65*skillComplement + 0.35*timezoneFit', suggestions: out } };
  }));

  app.get('/events', (req, res, next) => {
    const topic = String(req.query.topic || 'board');
    if (topic !== 'board') { const m = /^team:(\d+)$/.exec(topic); if (!m) return next(bad('topic invalid')); if (q.membership.get(H, req.uid)?.team_id !== Number(m[1])) return next(new HttpError(403, 'not_member')); }
    res.set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders(); res.write(': ok\n\n');
    const sub = { res, uid: req.uid }; if (!subs.has(topic)) subs.set(topic, new Set()); subs.get(topic).add(sub);
    const ka = setInterval(() => res.write(': ka\n\n'), 25e3);
    res.on('close', () => { clearInterval(ka); unsubscribe(topic, sub); });
  });

  app.use((req, res, next) => next(new HttpError(404, 'not_found')));
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'invalid_input', message: 'bad JSON' });
    if (String(err.message).includes('team_full')) return res.status(409).json({ error: 'team_full' });
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'conflict', message: 'constraint violated' });
    console.error(err); res.status(500).json({ error: 'internal' });
  });
  return { app, db, sign, streamCount: (topic) => subs.get(topic)?.size ?? 0 };
}
