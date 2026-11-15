import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, teamOf } from './helpers.js';

let ctx; before(async () => { ctx = await boot(); }); after(() => ctx.close());
const MAX = 4, MIN = 2;

test('register, login, /me', async () => {
  const u = await ctx.user(['react']);
  const l = await ctx.call(null, 'POST', '/auth/login', { email: u.email, password: 'password123' });
  assert.equal(l.status, 200);
  const me = await ctx.call(l.body.token, 'GET', '/me'); assert.deepEqual(me.body.skills, ['react']); assert.equal(me.body.teamId, null);
});
test('wrong password -> 401', async () => { const u = await ctx.user(); assert.equal((await ctx.call(null, 'POST', '/auth/login', { email: u.email, password: 'nope-nope' })).status, 401); });
test('input validation rejects junk', async () => {
  for (const b of [{}, { email: 'x', name: 'a', password: 'password123' }, { email: 'a@b.co', name: 'a', password: 'short' }, { email: 'a@b.co', name: 'a', password: 'password123', tz: 99 }, { email: 'a@b.co', name: 'a', password: 'password123', skills: 'js' }])
    assert.equal((await ctx.call(null, 'POST', '/auth/register', b)).status, 400);
  const u = await ctx.user(); assert.equal((await ctx.call(u.token, 'POST', '/teams', { name: 'x' })).status, 400);
  assert.equal((await ctx.call(u.token, 'GET', '/teams/abc')).status, 400);
  assert.equal((await ctx.call(u.token, 'POST', '/join', { code: "'; DROP TABLE teams;--" })).status, 400);
});
test('unauthenticated and forged tokens -> 401', async () => {
  assert.equal((await ctx.call(null, 'GET', '/board')).status, 401);
  assert.equal((await ctx.call('abc.def', 'GET', '/board')).status, 401);
});
test('create team: creator is leader+member, invite code has 10 chars', async () => {
  const u = await ctx.user(); const r = await ctx.call(u.token, 'POST', '/teams', { name: 'Alpha' + Date.now() });
  assert.equal(r.status, 201); assert.equal(r.body.size, 1); assert.equal(r.body.leaderId, u.id); assert.match(r.body.inviteCode, /^[0-9A-Z]{10}$/);
  assert.equal((await ctx.call(u.token, 'POST', '/teams', { name: 'Second' })).status, 409, 'one team per person');
});
test('duplicate team name -> 409', async () => {
  const a = await ctx.user(), b = await ctx.user(); await ctx.call(a.token, 'POST', '/teams', { name: 'Dupe' });
  assert.equal((await ctx.call(b.token, 'POST', '/teams', { name: 'Dupe' })).status, 409);
});
test('join by code; repeat join same team is a no-op; other team is 409', async () => {
  const { team } = await teamOf(ctx, 1); const other = await teamOf(ctx, 1); const u = await ctx.user();
  assert.equal((await ctx.call(u.token, 'POST', '/join', { code: team.inviteCode })).status, 200);
  const again = await ctx.call(u.token, 'POST', '/join', { code: team.inviteCode }); assert.equal(again.status, 200); assert.equal(again.body.size, 2);
  assert.equal((await ctx.call(u.token, 'POST', '/join', { code: other.team.inviteCode })).status, 409);
});
test('unknown code 404, expired code 410', async () => {
  const u = await ctx.user(); assert.equal((await ctx.call(u.token, 'POST', '/join', { code: 'ZZZZZZZZZZ' })).status, 404);
  const { team } = await teamOf(ctx, 1); ctx.db.prepare('UPDATE teams SET invite_expires=1 WHERE id=?').run(team.id);
  assert.equal((await ctx.call(u.token, 'POST', '/join', { code: team.inviteCode })).status, 410);
});
test('leader can rotate an expired code', async () => {
  const { leader, team } = await teamOf(ctx, 1); ctx.db.prepare('UPDATE teams SET invite_expires=1 WHERE id=?').run(team.id);
  const r = await ctx.call(leader.token, 'POST', `/teams/${team.id}/rotate-invite`); assert.equal(r.status, 200);
  const u = await ctx.user(); assert.equal((await ctx.call(u.token, 'POST', '/join', { code: r.body.inviteCode })).status, 200);
  assert.equal((await ctx.call(u.token, 'POST', `/teams/${team.id}/rotate-invite`)).status, 403);
});
test('full team rejects joins and leaves the board', async () => {
  const { team } = await teamOf(ctx, MAX); const u = await ctx.user();
  const r = await ctx.call(u.token, 'POST', '/join', { code: team.inviteCode }); assert.equal(r.status, 409); assert.equal(r.body.error, 'team_full');
  const board = await ctx.call(u.token, 'GET', '/board?limit=100'); assert.ok(!board.body.teams.some((t) => t.id === team.id));
});

// ---------------- RACES ----------------
test('RACE: 50 people grab the last seat at once -> exactly one wins', async () => {
  const { team, leader } = await teamOf(ctx, MAX - 1);
  const contenders = []; for (let i = 0; i < 50; i++) contenders.push(await ctx.user());
  const results = await Promise.all(contenders.map((u) => ctx.call(u.token, 'POST', '/join', { code: team.inviteCode })));
  const wins = results.filter((r) => r.status === 200), losses = results.filter((r) => r.status === 409);
  assert.equal(wins.length, 1, 'exactly one winner'); assert.equal(losses.length, 49); assert.ok(losses.every((r) => r.body.error === 'team_full'));
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM members WHERE team_id=?').get(team.id).c, MAX);
  const view = await ctx.call(leader.token, 'GET', `/teams/${team.id}`); assert.equal(view.body.members.length, MAX);
});
test('RACE: repeated across 10 rounds never overfills', async () => {
  for (let round = 0; round < 10; round++) {
    const { team } = await teamOf(ctx, MAX - 2); const us = []; for (let i = 0; i < 20; i++) us.push(await ctx.user());
    const rs = await Promise.all(us.map((u) => ctx.call(u.token, 'POST', '/join', { code: team.inviteCode })));
    assert.equal(rs.filter((r) => r.status === 200).length, 2);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM members WHERE team_id=?').get(team.id).c, MAX);
  }
});
test('RACE: one user joining two different teams at once ends up in exactly one', async () => {
  const a = await teamOf(ctx, 1), b = await teamOf(ctx, 1), u = await ctx.user();
  const rs = await Promise.all([a, b].flatMap((t) => [1, 2, 3].map(() => ctx.call(u.token, 'POST', '/join', { code: t.team.inviteCode }))));
  assert.equal(rs.filter((r) => r.status === 200).map((r) => r.body.id).filter((v, i, arr) => arr.indexOf(v) === i).length, 1);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM members WHERE user_id=?').get(u.id).c, 1);
});
test('RACE: leader accepting many requests for one seat -> exactly one accepted', async () => {
  const { leader, team } = await teamOf(ctx, MAX - 1); const us = []; for (let i = 0; i < 6; i++) us.push(await ctx.user());
  const reqs = []; for (const u of us) reqs.push((await ctx.call(u.token, 'POST', `/teams/${team.id}/requests`)).body.requestId);
  const rs = await Promise.all(reqs.map((rid) => ctx.call(leader.token, 'POST', `/teams/${team.id}/requests/${rid}/accept`)));
  assert.equal(rs.filter((r) => r.status === 200).length, 1); assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM members WHERE team_id=?').get(team.id).c, MAX);
});
test('RACE: concurrent leave + join keeps team consistent', async () => {
  const { team, members } = await teamOf(ctx, MAX); const u = await ctx.user();
  await Promise.all([ctx.call(members[1].token, 'POST', `/teams/${team.id}/leave`), ctx.call(u.token, 'POST', '/join', { code: team.inviteCode })]);
  const c = ctx.db.prepare('SELECT COUNT(*) c FROM members WHERE team_id=?').get(team.id).c; assert.ok(c >= MAX - 1 && c <= MAX);
});

// ---------------- IDEMPOTENCY ----------------
test('IDEMPOTENT: same Idempotency-Key replayed 20x concurrently joins once, returns identical answer', async () => {
  const { team } = await teamOf(ctx, 1); const u = await ctx.user(); const h = { 'Idempotency-Key': 'key-' + Math.random().toString(36).slice(2) };
  const rs = await Promise.all(Array.from({ length: 20 }, () => ctx.call(u.token, 'POST', '/join', { code: team.inviteCode }, h)));
  assert.ok(rs.every((r) => r.status === 200)); assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM members WHERE team_id=?').get(team.id).c, 2);
  assert.equal(rs.filter((r) => r.headers.get('idempotent-replay')).length, 19);
});
test('IDEMPOTENT: double-clicked create-team makes one team', async () => {
  const u = await ctx.user(); const h = { 'Idempotency-Key': 'create-' + Math.random().toString(36).slice(2) };
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => ctx.call(u.token, 'POST', '/teams', { name: 'Once' + Date.now() }, h)));
  assert.ok(rs.every((r) => r.status === 201 && r.body.id === rs[0].body.id)); assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM teams WHERE leader_id=?').get(u.id).c, 1);
});
test('IDEMPOTENT: failed request is not cached (retry can succeed later)', async () => {
  const { team, leader } = await teamOf(ctx, MAX); const u = await ctx.user(); const h = { 'Idempotency-Key': 'retry-' + Math.random().toString(36).slice(2) };
  assert.equal((await ctx.call(u.token, 'POST', '/join', { code: team.inviteCode }, h)).status, 409);
  await ctx.call(leader.token, 'POST', `/teams/${team.id}/members/${(await ctx.call(leader.token, 'GET', `/teams/${team.id}`)).body.members[1].id}/remove`);
  assert.equal((await ctx.call(u.token, 'POST', '/join', { code: team.inviteCode }, h)).status, 200);
});
test('malformed Idempotency-Key -> 400', async () => { const u = await ctx.user(); assert.equal((await ctx.call(u.token, 'POST', '/teams', { name: 'Zed' }, { 'Idempotency-Key': 'a b' })).status, 400); });

// ---------------- AUTHORIZATION & LIFECYCLE ----------------
test('request flow: accept and decline, only leader may decide', async () => {
  const { leader, team } = await teamOf(ctx, 1); const a = await ctx.user(), b = await ctx.user(), c = await ctx.user();
  const ra = (await ctx.call(a.token, 'POST', `/teams/${team.id}/requests`)).body.requestId, rb = (await ctx.call(b.token, 'POST', `/teams/${team.id}/requests`)).body.requestId;
  assert.equal((await ctx.call(a.token, 'POST', `/teams/${team.id}/requests/${rb}/accept`)).status, 403);
  assert.equal((await ctx.call(c.token, 'POST', `/teams/${team.id}/requests/${rb}/decline`)).status, 403);
  assert.equal((await ctx.call(leader.token, 'POST', `/teams/${team.id}/requests/${ra}/accept`)).status, 200);
  assert.equal((await ctx.call(leader.token, 'POST', `/teams/${team.id}/requests/${rb}/decline`)).status, 200);
  assert.equal((await ctx.call(leader.token, 'POST', `/teams/${team.id}/requests/${rb}/accept`)).status, 409, 'cannot revive a declined request');
  assert.equal((await ctx.call(b.token, 'GET', '/me')).body.teamId, null);
});
test('joining a team cancels the user\'s other pending requests', async () => {
  const a = await teamOf(ctx, 1), b = await teamOf(ctx, 1), u = await ctx.user();
  const ra = (await ctx.call(u.token, 'POST', `/teams/${a.team.id}/requests`)).body.requestId; await ctx.call(u.token, 'POST', `/teams/${b.team.id}/requests`);
  await ctx.call(u.token, 'POST', '/join', { code: b.team.inviteCode });
  assert.equal((await ctx.call(a.leader.token, 'POST', `/teams/${a.team.id}/requests/${ra}/accept`)).status, 409);
});
test('only leader can remove; leader cannot be removed via remove', async () => {
  const { leader, team, members } = await teamOf(ctx, 3);
  assert.equal((await ctx.call(members[1].token, 'POST', `/teams/${team.id}/members/${members[2].id}/remove`)).status, 403);
  assert.equal((await ctx.call(leader.token, 'POST', `/teams/${team.id}/members/${leader.id}/remove`)).status, 400);
  assert.equal((await ctx.call(leader.token, 'POST', `/teams/${team.id}/members/${members[2].id}/remove`)).status, 200);
  assert.equal((await ctx.call(members[2].token, 'GET', '/me')).body.teamId, null);
});
test('leader leaves -> longest-standing member becomes leader', async () => {
  const { leader, team, members } = await teamOf(ctx, 3);
  assert.equal((await ctx.call(leader.token, 'POST', `/teams/${team.id}/leave`)).status, 200);
  assert.equal((await ctx.call(members[1].token, 'GET', `/teams/${team.id}`)).body.leaderId, members[1].id);
});
test('last member leaving deletes the team; leave retry is harmless', async () => {
  const { leader, team } = await teamOf(ctx, 1);
  assert.equal((await ctx.call(leader.token, 'POST', `/teams/${team.id}/leave`)).status, 200);
  assert.equal((await ctx.call(leader.token, 'POST', `/teams/${team.id}/leave`)).status, 200);
  assert.equal((await ctx.call(leader.token, 'GET', `/teams/${team.id}`)).status, 404);
});
test('lock requires min size; locked team refuses joins', async () => {
  const { leader, team } = await teamOf(ctx, 1);
  assert.equal((await ctx.call(leader.token, 'POST', `/teams/${team.id}/lock`, {})).status, 409);
  const u = await ctx.user(); await ctx.call(u.token, 'POST', '/join', { code: team.inviteCode });
  assert.equal((await ctx.call(leader.token, 'POST', `/teams/${team.id}/lock`, {})).status, 200);
  assert.equal((await ctx.call((await ctx.user()).token, 'POST', '/join', { code: team.inviteCode })).body.error, 'team_locked');
  assert.equal((await ctx.call(u.token, 'POST', `/teams/${team.id}/leave`)).status, 409, 'cannot drop a locked team below min');
});
test('DB trigger is a backstop even if app code is bypassed', async () => {
  const { team } = await teamOf(ctx, MAX); const u = await ctx.user();
  assert.throws(() => ctx.db.prepare('INSERT INTO members(hackathon_id,user_id,team_id,joined_at) VALUES(1,?,?,0)').run(u.id, team.id), /team_full/);
});
test('DB primary key blocks a second team for the same person even if app code is bypassed', async () => {
  const { leader } = await teamOf(ctx, 1); const other = await teamOf(ctx, 1);
  assert.throws(() => ctx.db.prepare('INSERT INTO members(hackathon_id,user_id,team_id,joined_at) VALUES(1,?,?,0)').run(leader.id, other.team.id), /UNIQUE/);
});
test('audit log: who/what/when for every change, members only', async () => {
  const { leader, team, members } = await teamOf(ctx, 2); await ctx.call(leader.token, 'POST', `/teams/${team.id}/members/${members[1].id}/remove`);
  const r = await ctx.call(leader.token, 'GET', `/teams/${team.id}/audit`); const acts = r.body.entries.map((e) => e.action);
  assert.deepEqual(acts.reverse(), ['team_created', 'member_joined', 'member_removed']);
  assert.ok(r.body.entries.every((e) => e.actorId && e.ts)); assert.equal((await ctx.call((await ctx.user()).token, 'GET', `/teams/${team.id}/audit`)).status, 403);
});
test('suggestions: complementary skills and near time zones rank first, leader only, explained', async () => {
  const leader = await ctx.user(['react', 'css'], 5); const t = await ctx.call(leader.token, 'POST', '/teams', { name: 'Sug' + Date.now() });
  const dup = await ctx.user(['react', 'css'], 5, 'Dup'), comp = await ctx.user(['python', 'ml'], 5, 'Comp'), far = await ctx.user(['python', 'ml'], -8, 'Far');
  const r = await ctx.call(leader.token, 'GET', `/teams/${t.body.id}/suggestions`); const ids = r.body.suggestions.map((s) => s.id);
  assert.ok(ids.indexOf(comp.id) < ids.indexOf(far.id)); assert.ok(ids.indexOf(far.id) < ids.indexOf(dup.id));
  assert.deepEqual(r.body.suggestions.find((s) => s.id === comp.id).why.newSkills, ['python', 'ml']); assert.match(r.body.formula, /0\.65/);
  assert.equal((await ctx.call(dup.token, 'GET', `/teams/${t.body.id}/suggestions`)).status, 403);
});
test('SSE: board subscribers see a new team without refreshing; team topic is members-only', async () => {
  const watcher = await ctx.user(); const res = await fetch(`${ctx.base}/events?topic=board&token=${watcher.token}`); const rd = res.body.getReader();
  const leader = await ctx.user(); await ctx.call(leader.token, 'POST', '/teams', { name: 'Live' + Date.now() });
  let text = ''; const dec = new TextDecoder(); for (let i = 0; i < 5 && !text.includes('"type":"team"'); i++) text += dec.decode((await rd.read()).value);
  assert.match(text, /"type":"team"/); await rd.cancel();
  assert.equal((await fetch(`${ctx.base}/events?topic=team:1&token=${watcher.token}`)).status, 403);
});
test('brute force: join attempts are rate limited per user (429)', async () => {
  const c = await boot({ rateLimit: true }); try {
    const u = await c.user(); const rs = []; for (let i = 0; i < 14; i++) rs.push((await c.call(u.token, 'POST', '/join', { code: 'ABCDEFGHJK' })).status);
    assert.equal(rs.filter((s) => s === 404).length, 10); assert.equal(rs.filter((s) => s === 429).length, 4);
  } finally { c.close(); }
});
test('board is paginated', async () => {
  const u = await ctx.user(); const p1 = await ctx.call(u.token, 'GET', '/board?limit=2'); assert.equal(p1.body.teams.length, 2); assert.ok(p1.body.next);
  const p2 = await ctx.call(u.token, 'GET', `/board?limit=2&after=${p1.body.next}`); assert.ok(p2.body.teams[0].id > p1.body.next);
});
