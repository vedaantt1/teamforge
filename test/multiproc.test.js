// Three separate OS processes share one SQLite file. Cross-process safety comes from BEGIN IMMEDIATE + the DB trigger/PK, not from Node's event loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test('RACE (multi-process): 60 joins across 3 server processes for 1 seat -> exactly one winner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-')), db = join(dir, 't.db'), ports = [4101, 4102, 4103];
  const procs = ports.map((p) => spawn('node', ['src/server.js'], { env: { ...process.env, PORT: p, DB_PATH: db, SECRET: 's'.repeat(32), MAX_SIZE: '4', RATE_LIMIT: 'off' }, stdio: 'ignore' }));
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${ports[2]}/healthz`)).ok) break; } catch { await sleep(100); } }
    const call = async (port, token, path, body) => { const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
    const reg = async (i) => (await call(ports[i % 3], null, '/auth/register', { email: `m${i}_${Date.now()}@t.io`, name: 'U', password: 'password123' })).body.token;
    const lead = await reg(0); const team = (await call(ports[0], lead, '/teams', { name: 'MP' })).body;
    for (let i = 0; i < 2; i++) assert.equal((await call(ports[1], await reg(i + 1), '/join', { code: team.inviteCode })).status, 200);
    const tokens = []; for (let i = 0; i < 60; i++) tokens.push(await reg(i));
    const rs = await Promise.all(tokens.map((t, i) => call(ports[i % 3], t, '/join', { code: team.inviteCode })));
    assert.equal(rs.filter((r) => r.status === 200).length, 1, JSON.stringify(rs.map((r) => r.status).reduce((a, s) => ({ ...a, [s]: (a[s] || 0) + 1 }), {})));
    assert.ok(rs.every((r) => [200, 409].includes(r.status)));
    const check = new Database(db, { readonly: true }); assert.equal(check.prepare('SELECT COUNT(*) c FROM members WHERE team_id=?').get(team.id).c, 4); check.close();
  } finally { procs.forEach((p) => p.kill('SIGKILL')); await sleep(200); rmSync(dir, { recursive: true, force: true }); }
});

test('CHAOS: SIGKILL the server mid-storm; after restart no team is over capacity and no user is in two teams', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-')), db = join(dir, 'c.db'), port = 4111;
  const start = () => spawn('node', ['src/server.js'], { env: { ...process.env, PORT: port, DB_PATH: db, SECRET: 's'.repeat(32), MAX_SIZE: '4', RATE_LIMIT: 'off' }, stdio: 'ignore' });
  let p = start(); const up = async () => { for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return; } catch { await sleep(100); } } };
  const call = async (token, path, body) => { try { const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) }); return r.status; } catch { return 0; } };
  try {
    await up(); const tokens = [];
    for (let i = 0; i < 40; i++) { const r = await fetch(`http://127.0.0.1:${port}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `c${i}@t.io`, name: 'U', password: 'password123' }) }); tokens.push((await r.json()).token); }
    const codes = []; for (let i = 0; i < 5; i++) { const r = await fetch(`http://127.0.0.1:${port}/teams`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[i]}` }, body: JSON.stringify({ name: 'Ch' + i }) }); codes.push((await r.json()).inviteCode); }
    const storm = Promise.all(tokens.slice(5).map((t, i) => call(t, '/join', { code: codes[i % 5] })));
    await sleep(15); p.kill('SIGKILL'); await storm; await sleep(200); p = start(); await up();
    const retry = await Promise.all(tokens.slice(5).map((t, i) => call(t, '/join', { code: codes[i % 5] }))); // clients simply retry
    assert.ok(retry.every((s) => [200, 409].includes(s)), 'retries resolve cleanly: ' + retry);
    const c = new Database(db, { readonly: true });
    assert.equal(c.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(c.prepare('SELECT COUNT(*) c FROM (SELECT team_id FROM members GROUP BY team_id HAVING COUNT(*)>4)').get().c, 0);
    assert.equal(c.prepare('SELECT COUNT(*) c FROM (SELECT user_id FROM members GROUP BY user_id HAVING COUNT(*)>1)').get().c, 0);
    assert.equal(c.prepare('SELECT COUNT(*) c FROM members m LEFT JOIN teams t ON t.id=m.team_id WHERE t.id IS NULL').get().c, 0);
    c.close();
  } finally { p.kill('SIGKILL'); await sleep(200); rmSync(dir, { recursive: true, force: true }); }
});
