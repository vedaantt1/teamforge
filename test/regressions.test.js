// Regression tests for: full teams on the board, and revoking team-event access when membership ends.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, teamOf } from './helpers.js';

let ctx; before(async () => { ctx = await boot(); }); after(() => ctx.close());
const MAX = 4;
const looking = (id) => ctx.db.prepare('SELECT looking FROM teams WHERE id=?').get(id).looking;
const onBoard = async (token, id) => { const r = await ctx.call(token, 'GET', '/board?limit=100'); return r.body.teams.some((t) => t.id === id); };

test('full team: lock then unlock keeps looking=false and it stays off the board', async () => {
  const { leader, team } = await teamOf(ctx, MAX);
  assert.equal(looking(team.id), 0); assert.equal(await onBoard(leader.token, team.id), false);
  assert.equal((await ctx.call(leader.token, 'POST', `/teams/${team.id}/lock`, {})).status, 200);
  const un = await ctx.call(leader.token, 'POST', `/teams/${team.id}/lock`, { locked: false });
  assert.equal(un.status, 200); assert.equal(un.body.locked, false); assert.equal(un.body.looking, false);
  assert.equal(looking(team.id), 0); assert.equal(await onBoard(leader.token, team.id), false);
  const late = await ctx.user(); assert.equal((await ctx.call(late.token, 'POST', '/join', { code: team.inviteCode })).body.error, 'team_full', 'capacity guard unchanged');
});
test('non-full team: lock hides it, unlock makes it discoverable again', async () => {
  const { leader, team } = await teamOf(ctx, MAX - 1);
  assert.equal(await onBoard(leader.token, team.id), true);
  await ctx.call(leader.token, 'POST', `/teams/${team.id}/lock`, {}); assert.equal(looking(team.id), 0); assert.equal(await onBoard(leader.token, team.id), false);
  const un = await ctx.call(leader.token, 'POST', `/teams/${team.id}/lock`, { locked: false }); assert.equal(un.body.looking, true);
  assert.equal(looking(team.id), 1); assert.equal(await onBoard(leader.token, team.id), true);
});
test('the board query itself excludes full teams even if looking=1 is forced in the database', async () => {
  const { leader, team } = await teamOf(ctx, MAX); ctx.db.prepare('UPDATE teams SET looking=1 WHERE id=?').run(team.id);
  assert.equal(await onBoard(leader.token, team.id), false);
});

// ---- real event streams ----
function openStream(topic, token) {
  const events = []; const ac = new AbortController(); const st = { events, ended: false, status: 0, close: () => ac.abort() };
  st.ready = fetch(`${ctx.base}/events?topic=${topic}&token=${token}`, { signal: ac.signal }).then(async (res) => {
    st.status = res.status; if (res.status !== 200) return st;
    const rd = res.body.getReader(), dec = new TextDecoder(); let buf = '';
    (async () => { try { for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) >= 0) { const m = /^data: (.*)$/m.exec(buf.slice(0, i)); buf = buf.slice(i + 2); if (m) events.push(JSON.parse(m[1])); } } } catch { /* aborted */ } st.ended = true; })();
    return st;
  });
  return st;
}
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 15)); } return false; };
const types = (st) => st.events.map((e) => e.type);
const settle = () => new Promise((r) => setTimeout(r, 150));

test('STREAM: removed member gets only a content-free terminal event and the stream closes; others keep receiving', async () => {
  const { leader, team, members } = await teamOf(ctx, 3); const topic = `team:${team.id}`;
  const L = openStream(topic, leader.token), B = openStream(topic, members[1].token), C = openStream(topic, members[2].token), W = openStream('board', (await ctx.user()).token);
  await Promise.all([L.ready, B.ready, C.ready, W.ready]); assert.equal(ctx.streamCount(topic), 3);
  await ctx.call(leader.token, 'POST', `/teams/${team.id}/members/${members[2].id}/remove`);
  assert.ok(await until(() => C.ended), 'removed member stream was closed by the server');
  assert.deepEqual(types(C), ['membership_ended']); assert.deepEqual(C.events[0], { type: 'membership_ended' });
  assert.ok(await until(() => types(B).includes('member_left'))); assert.equal(ctx.streamCount(topic), 2);
  await ctx.call(leader.token, 'POST', `/teams/${team.id}/lock`, {});
  assert.ok(await until(() => types(B).includes('team_updated') && types(L).includes('team_updated')), 'remaining members still get updates');
  await settle(); assert.deepEqual(types(C), ['membership_ended'], 'nothing further reached the former member');
  assert.ok(types(W).includes('team'), 'public board updates unaffected');
  assert.equal(await openStream(topic, members[2].token).ready.then((s) => s.status), 403, 'cannot reopen');
  L.close(); B.close(); W.close();
  assert.ok(await until(() => ctx.streamCount(topic) === 0), 'closed streams are cleaned up and the empty topic is dropped');
});
test('STREAM: voluntary leave ends that member\'s stream only', async () => {
  const { leader, team, members } = await teamOf(ctx, 3); const topic = `team:${team.id}`;
  const L = openStream(topic, leader.token), B = openStream(topic, members[1].token), C = openStream(topic, members[2].token); await Promise.all([L.ready, B.ready, C.ready]);
  await ctx.call(members[1].token, 'POST', `/teams/${team.id}/leave`);
  assert.ok(await until(() => B.ended)); assert.deepEqual(types(B), ['membership_ended']);
  assert.ok(await until(() => types(C).includes('member_left') && types(L).includes('member_left')));
  const joiner = await ctx.user(); await ctx.call(joiner.token, 'POST', '/join', { code: team.inviteCode });
  assert.ok(await until(() => types(L).filter((t) => t === 'member_joined').length === 1 && types(C).includes('member_joined')));
  await settle(); assert.deepEqual(types(B), ['membership_ended']); L.close(); C.close();
});
test('STREAM: leader leaving ends their stream; successor and the rest are told', async () => {
  const { leader, team, members } = await teamOf(ctx, 3); const topic = `team:${team.id}`;
  const L = openStream(topic, leader.token), B = openStream(topic, members[1].token); await Promise.all([L.ready, B.ready]);
  await ctx.call(leader.token, 'POST', `/teams/${team.id}/leave`);
  assert.ok(await until(() => L.ended)); assert.deepEqual(types(L), ['membership_ended']);
  assert.ok(await until(() => B.events.some((e) => e.type === 'leader_changed' && e.leaderId === members[1].id))); B.close();
});
test('STREAM: team deletion (last member leaves) ends the stream and clears the topic', async () => {
  const { leader, team } = await teamOf(ctx, 1); const topic = `team:${team.id}`; const L = openStream(topic, leader.token), W = openStream('board', leader.token); await Promise.all([L.ready, W.ready]);
  await ctx.call(leader.token, 'POST', `/teams/${team.id}/leave`);
  assert.ok(await until(() => L.ended)); assert.deepEqual(types(L), ['membership_ended']); assert.equal(ctx.streamCount(topic), 0);
  assert.ok(await until(() => W.events.some((e) => e.type === 'team_deleted' && e.teamId === team.id))); W.close();
});
test('STREAM: membership is checked per delivery, not only at connect (removal also during a burst of events)', async () => {
  const { leader, team, members } = await teamOf(ctx, 3); const topic = `team:${team.id}`; const C = openStream(topic, members[2].token); await C.ready;
  await Promise.all([ctx.call(leader.token, 'POST', `/teams/${team.id}/members/${members[2].id}/remove`), ctx.call(leader.token, 'POST', `/teams/${team.id}/lock`, {}), ctx.call(leader.token, 'POST', `/teams/${team.id}/rotate-invite`)]);
  assert.ok(await until(() => C.ended)); await settle();
  const t = types(C); assert.equal(t[t.length - 1], 'membership_ended'); assert.equal(t.filter((x) => x === 'membership_ended').length, 1);
  assert.ok(!t.includes('member_left'), 'the removal event itself is not delivered to the former member');
});
