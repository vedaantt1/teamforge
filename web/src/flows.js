// Pure, framework-free UI logic (no React, no import.meta) so Node's test runner can exercise it against the real API.

export class ApiError extends Error {
  constructor(message, { code, status = 0, uncertain = false, retryAfter = 0 } = {}) {
    super(message); this.code = code; this.status = status; this.uncertain = uncertain; this.retryAfter = retryAfter;
  }
}

// "Uncertain" = we cannot know whether the server applied the change (no response, timeout, 5xx).
// 4xx answers are definitive: the server looked at the request and refused it.
export function makeApi({ base = '', getToken = () => null, fetchImpl = (...a) => fetch(...a), timeoutMs = 15000 } = {}) {
  return async function call(method, path, body, key) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs); let res, text;
    try {
      const token = getToken();
      res = await fetchImpl(base + path, { method, signal: ctl.signal,
        headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }), ...(key && { 'Idempotency-Key': key }) },
        body: body === undefined ? undefined : JSON.stringify(body) });
      text = await res.text();
    } catch {
      throw new ApiError(ctl.signal.aborted ? 'The server took too long to respond.' : "Can't reach the server.", { uncertain: true });
    } finally { clearTimeout(timer); }
    let j = {}; try { j = text ? JSON.parse(text) : {}; } catch { /* non-JSON body */ }
    if (!res.ok) throw new ApiError(j.message || j.error || res.statusText, { code: j.error, status: res.status, uncertain: res.status >= 500 || res.status === 408, retryAfter: Number(res.headers.get('retry-after')) || 0 });
    return j;
  };
}

const MESSAGES = {
  invalid_code: "That invite code doesn't match any team. Check it and try again.",
  code_expired: 'That invite code has expired. Ask the team leader for a new one.',
  team_full: 'That team is already full.',
  team_locked: 'That team is locked and not accepting new members.',
  team_name_taken: 'A team with that name already exists. Try a different name.',
  already_in_team: "You're already in a team.",
  below_min_size: 'A team needs the minimum number of members to lock. Unlock it before removing people below the minimum.',
  request_not_pending: 'That request was already handled.',
  request_not_found: 'That request no longer exists.',
  not_leader: 'Only the team leader can do that.',
  not_a_member: 'That person is no longer in the team.',
  team_not_found: 'That team no longer exists.',
  bad_credentials: 'Email or password is incorrect.',
  email_taken: 'An account with that email already exists. Try signing in.',
  unauthenticated: 'Your session expired. Please sign in again.',
};
export function friendly(e) {
  if (!e) return 'Something went wrong.';
  if (e.code === 'rate_limited') return `Too many attempts. Try again in ${e.retryAfter || 60} seconds.`;
  if (e.code === 'invalid_input') return `Please check your input: ${e.message}.`;
  if (e.code === 'internal') return 'The server hit an error. Please try again.';
  return MESSAGES[e.code] || e.message || 'Something went wrong.';
}

// Runs one logical action at a time and owns its Idempotency-Key:
//  * a second run() of the same action while one is in flight is refused (no duplicate submissions),
//  * after an UNCERTAIN failure the next run() of the same payload reuses the key (server can replay),
//  * a different payload, or any definitive answer, discards the key so unrelated requests never share one.
export function createRunner(newKey = () => globalThis.crypto.randomUUID().replace(/-/g, '')) {
  const keys = new Map(), inflight = new Set();
  return {
    isBusy: (action) => inflight.has(action),
    forget: (action) => keys.delete(action),
    async run(action, fingerprint, fn) {
      if (inflight.has(action)) return { skipped: true };
      let rec = keys.get(action); if (!rec || rec.fp !== fingerprint) { rec = { fp: fingerprint, key: newKey() }; keys.set(action, rec); }
      inflight.add(action);
      try { const value = await fn(rec.key); keys.delete(action); return { ok: true, value }; }
      catch (error) { if (!error.uncertain) keys.delete(action); return { ok: false, error }; }
      finally { inflight.delete(action); }
    },
  };
}

// After an uncertain or ambiguous result, ask the server what is actually true.
async function actualMembership(call) {
  const me = await call('GET', '/me'); if (!me.teamId) return { me, team: null };
  return { me, team: await call('GET', `/teams/${me.teamId}`) };
}

// outcome: created | already_member | not_created | unknown | failed | busy
export async function createTeam({ call, runner, name }) {
  const r = await runner.run('create-team', `POST /teams ${JSON.stringify(name)}`, (key) => call('POST', '/teams', { name }, key));
  if (r.skipped) return { outcome: 'busy' };
  if (r.ok) return { outcome: 'created', team: r.value };
  const error = r.error;
  if (!error.uncertain && error.code !== 'already_in_team') return { outcome: 'failed', error };
  let actual; try { actual = await actualMembership(call); } catch { return { outcome: 'unknown', error }; } // key stays: retrying is safe
  if (!actual.team) return error.uncertain ? { outcome: 'not_created', error } : { outcome: 'failed', error };
  runner.forget('create-team'); // outcome is now known; the key must not outlive it
  const mine = actual.team.leaderId === actual.me.id && actual.team.name === name;
  // Only a recovered *uncertain* attempt may claim "created". A definitive already_in_team 409 never is success.
  if (error.uncertain && mine) return { outcome: 'created', recovered: true, team: actual.team };
  return { outcome: 'already_member', team: actual.team };
}

// outcome: joined | already_member | not_joined | unknown | failed | busy
export async function joinByCode({ call, runner, code }) {
  const r = await runner.run('join-code', `POST /join ${code.toUpperCase()}`, (key) => call('POST', '/join', { code }, key));
  if (r.skipped) return { outcome: 'busy' };
  if (r.ok) return { outcome: 'joined', team: r.value };
  const error = r.error;
  if (!error.uncertain && error.code !== 'already_in_team') return { outcome: 'failed', error };
  let actual; try { actual = await actualMembership(call); } catch { return { outcome: 'unknown', error }; }
  if (!actual.team) return error.uncertain ? { outcome: 'not_joined', error } : { outcome: 'failed', error };
  runner.forget('join-code');
  return { outcome: error.uncertain ? 'joined' : 'already_member', recovered: !!error.uncertain, team: actual.team };
}
