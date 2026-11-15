// Regression tests for the UI's submission logic, run against the REAL API (no mocks of the server).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';
import { makeApi, createRunner, createTeam, joinByCode, friendly, ApiError } from '../web/src/flows.js';

let ctx; before(async () => { ctx = await boot(); }); after(() => ctx.close());
const teamsOf = (uid) => ctx.db.prepare('SELECT * FROM teams WHERE leader_id=?').all(uid);
// An API client whose network can be sabotaged per request: 'drop' = request never arrives, 'lose' = server applies it but the reply is lost.
function client(user, plan = []) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: url.replace(ctx.base, ''), method: init.method, key: init.headers['Idempotency-Key'] });
    const mode = init.method === 'POST' ? plan.shift() : undefined;
    if (mode === 'drop') throw new TypeError('fetch failed');
    const res = await fetch(url, init);
    if (mode === 'lose') { await res.text(); throw new TypeError('fetch failed'); }
    return res;
  };
  return { seen, call: makeApi({ base: ctx.base, getToken: () => user.token, fetchImpl }), runner: createRunner() };
}

test('UI: double submit while in flight sends exactly one request and one team exists', async () => {
  const u = await ctx.user(); const c = client(u);
  const [a, b] = await Promise.all([createTeam({ ...c, name: 'Dbl' + Date.now() }), createTeam({ ...c, name: 'Dbl' + Date.now() })]);
  assert.deepEqual([a.outcome, b.outcome].sort(), ['busy', 'created']);
  assert.equal(c.seen.filter((s) => s.method === 'POST').length, 1); assert.equal(teamsOf(u.id).length, 1);
});
test('UI: request never reached server -> not_created, retry reuses the SAME key and creates one team', async () => {
  const u = await ctx.user(); const c = client(u, ['drop']); const name = 'Drop' + Date.now();
  const first = await createTeam({ ...c, name }); assert.equal(first.outcome, 'not_created'); assert.equal(teamsOf(u.id).length, 0);
  const second = await createTeam({ ...c, name }); assert.equal(second.outcome, 'created');
  const posts = c.seen.filter((s) => s.method === 'POST'); assert.equal(posts.length, 2); assert.equal(posts[0].key, posts[1].key); assert.equal(teamsOf(u.id).length, 1);
});
test('UI: reply lost after the server committed -> reconciles with real membership, reports created, one team', async () => {
  const u = await ctx.user(); const c = client(u, ['lose']); const name = 'Lost' + Date.now();
  const r = await createTeam({ ...c, name }); assert.equal(r.outcome, 'created'); assert.equal(r.recovered, true); assert.equal(r.team.name, name); assert.equal(teamsOf(u.id).length, 1);
});
test('UI: lost reply AND unreachable reconcile -> unknown; same-payload retry replays the original, no second team', async () => {
  const u = await ctx.user(); const name = 'Both' + Date.now(); let n = 0; const seen = [];
  const fetchImpl = async (url, init) => { seen.push(init.headers['Idempotency-Key']); const res = await fetch(url, init); n++; if (n === 1) { await res.text(); throw new TypeError('x'); } if (n === 2) throw new TypeError('x'); return res; };
  const c = { call: makeApi({ base: ctx.base, getToken: () => u.token, fetchImpl }), runner: createRunner() };
  assert.equal((await createTeam({ ...c, name })).outcome, 'unknown'); assert.equal(teamsOf(u.id).length, 1, 'server did commit');
  const retry = await createTeam({ ...c, name }); assert.equal(retry.outcome, 'created'); assert.equal(teamsOf(u.id).length, 1);
  assert.equal(seen[0], seen[2], 'retry reused the key');
});
test('UI: different payload never reuses the key; true outcome is shown, not the new payload', async () => {
  const u = await ctx.user(); const nameA = 'KeyA' + Date.now(), nameB = 'KeyB' + Date.now(); let n = 0; const keys = [];
  const fetchImpl = async (url, init) => { if (init.method === 'POST') keys.push(init.headers['Idempotency-Key']); const res = await fetch(url, init); if (init.method === 'POST' && ++n === 1) { await res.text(); throw new TypeError('x'); } if (n === 1 && init.method === 'GET') throw new TypeError('x'); return res; };
  const c = { call: makeApi({ base: ctx.base, getToken: () => u.token, fetchImpl }), runner: createRunner() };
  assert.equal((await createTeam({ ...c, name: nameA })).outcome, 'unknown');
  const r = await createTeam({ ...c, name: nameB }); // user edited the name and resubmitted
  assert.notEqual(keys[0], keys[1]); assert.equal(r.outcome, 'already_member'); assert.equal(r.team.name, nameA);
  assert.equal(teamsOf(u.id).length, 1); assert.equal(teamsOf(u.id)[0].name, nameA);
});
test('UI: a definitive already_in_team 409 is NOT success; the actual team is reported', async () => {
  const u = await ctx.user(); const c = client(u); const existing = 'Have' + Date.now();
  await ctx.call(u.token, 'POST', '/teams', { name: existing });
  const r = await createTeam({ ...c, name: 'Other' + Date.now() }); assert.equal(r.outcome, 'already_member'); assert.equal(r.team.name, existing);
  const same = await createTeam({ ...c, name: existing }); assert.equal(same.outcome, 'already_member', 'even the same name is not claimed as created');
});
test('UI: validation / name-taken failures are definitive and drop the key', async () => {
  const a = await ctx.user(), b = await ctx.user(); const name = 'Taken' + Date.now(); await ctx.call(a.token, 'POST', '/teams', { name });
  const c = client(b); const r = await createTeam({ ...c, name }); assert.equal(r.outcome, 'failed'); assert.equal(r.error.code, 'team_name_taken');
  assert.match(friendly(r.error), /different name/);
  await createTeam({ ...c, name }); const posts = c.seen.filter((s) => s.method === 'POST'); assert.notEqual(posts[0].key, posts[1].key);
});
test('UI: join by code - lost reply reconciles to the real team; double submit is single', async () => {
  const lead = await ctx.user(); const t = (await ctx.call(lead.token, 'POST', '/teams', { name: 'JoinMe' + Date.now() })).body;
  const u = await ctx.user(); const c = client(u, ['lose']);
  const r = await joinByCode({ ...c, code: t.inviteCode }); assert.equal(r.outcome, 'joined'); assert.equal(r.team.id, t.id);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM members WHERE team_id=?').get(t.id).c, 2);
  const v = await ctx.user(); const c2 = client(v);
  const rs = await Promise.all([joinByCode({ ...c2, code: t.inviteCode }), joinByCode({ ...c2, code: t.inviteCode })]); assert.deepEqual(rs.map((x) => x.outcome).sort(), ['busy', 'joined']);
});
test('UI: join with a bad code is a clear definitive failure', async () => {
  const u = await ctx.user(); const r = await joinByCode({ ...client(u), code: 'ZZZZZZZZZZ' }); assert.equal(r.outcome, 'failed'); assert.match(friendly(r.error), /doesn't match any team/);
});
test('UI: runner - same action blocked in flight, different actions independent, definitive error clears key', async () => {
  let n = 0; const run = createRunner(() => 'k' + ++n); const slow = () => new Promise((r) => setTimeout(() => r('ok'), 30));
  const [a, b, c] = await Promise.all([run.run('x', 'p1', slow), run.run('x', 'p1', slow), run.run('y', 'p1', slow)]);
  assert.equal(a.ok, true); assert.equal(b.skipped, true); assert.equal(c.ok, true);
  const keys = []; const fail = (u) => (k) => { keys.push(k); throw new ApiError('x', { uncertain: u, status: u ? 503 : 409 }); };
  await run.run('z', 'p', fail(true)); await run.run('z', 'p', fail(true)); await run.run('z', 'other', fail(true)); await run.run('z', 'other', fail(false)); await run.run('z', 'other', fail(false));
  assert.equal(keys[0], keys[1]); assert.notEqual(keys[1], keys[2]); assert.equal(keys[2], keys[3]); assert.notEqual(keys[3], keys[4]);
});
test('UI: error wording is specific, rate-limit shows wait time, network error is flagged uncertain', async () => {
  assert.match(friendly(new ApiError('x', { code: 'rate_limited', status: 429, retryAfter: 42 })), /42 seconds/);
  assert.match(friendly(new ApiError('x', { code: 'code_expired' })), /expired/);
  assert.match(friendly(new ApiError('x', { code: 'team_full' })), /full/);
  const call = makeApi({ base: 'http://127.0.0.1:1', timeoutMs: 500 }); await assert.rejects(call('GET', '/me'), (e) => e.uncertain === true && /reach the server/.test(e.message));
});
