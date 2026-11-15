import { createApp } from '../src/app.js';
let n = 0;
export async function boot(opts = {}) {
  const { app, db, streamCount } = createApp({ rateLimit: false, ...opts });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  const user = async (skills = [], tz = 0, name = 'U') => {
    const email = `u${++n}_${Math.random().toString(36).slice(2, 7)}@t.io`;
    const r = await call(null, 'POST', '/auth/register', { email, name: `${name}${n}`, password: 'password123', tz, skills });
    if (r.status !== 201) throw new Error('register failed ' + JSON.stringify(r.body));
    return { token: r.body.token, id: r.body.id, email };
  };
  return { base, db, call, user, streamCount, close: () => { server.closeAllConnections?.(); server.close(); db.close(); } };
}
// team with `size` members (leader included)
export async function teamOf(ctx, size, name) {
  const leader = await ctx.user(); const t = await ctx.call(leader.token, 'POST', '/teams', { name: name || 'T' + Math.random().toString(36).slice(2, 8) });
  const members = [leader];
  for (let i = 1; i < size; i++) { const u = await ctx.user(); const r = await ctx.call(u.token, 'POST', '/join', { code: t.body.inviteCode }); if (r.status !== 200) throw new Error('setup join failed'); members.push(u); }
  return { leader, members, team: t.body };
}
