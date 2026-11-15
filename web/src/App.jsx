import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { makeApi, createRunner, createTeam, joinByCode, friendly } from './flows.js';

const API = import.meta.env.DEV ? '/api' : '';
const skillsText = (s) => (s && s.length ? s.join(', ') : 'no skills listed');

export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('t'));
  const [me, setMe] = useState(null);
  const [notice, setNotice] = useState(null); // { kind: 'error' | 'info', text }
  const tokenRef = useRef(token); tokenRef.current = token;
  const runner = useMemo(() => createRunner(), []);
  const call = useMemo(() => makeApi({ base: API, getToken: () => tokenRef.current }), []);
  const focusReq = useRef(null); // { id, hard }: where focus should land once that element exists
  const signOut = useCallback((text) => { sessionStorage.removeItem('t'); setToken(null); setMe(null); setNotice(text ? { kind: 'info', text } : null); }, []);
  const tell = useCallback((kind, text) => setNotice(kind ? { kind, text } : null), []);
  const fail = useCallback((e) => { if (e?.status === 401) return signOut(friendly(e)); tell('error', friendly(e)); }, [signOut, tell]);
  // Focus moves inside the React commit that renders its target (called from layout effects), never from a timer, so there is no
  // moment where the target is visible but unfocused. A soft request only applies if focus was lost (the focused button was removed).
  const wantFocus = useCallback((id, hard = true) => { focusReq.current = id ? { id, hard } : null; }, []);
  const flushFocus = useCallback(() => {
    const r = focusReq.current; const el = r && document.getElementById(r.id); if (!el) return;
    const a = document.activeElement; if (r.hard || !a || a === document.body || !document.contains(a)) { focusReq.current = null; el.focus(); }
  }, []);
  const refreshMe = useCallback(async () => { try { const m = await call('GET', '/me'); setMe(m); return m; } catch (e) { fail(e); return null; } }, [call, fail]);
  useEffect(() => { if (token) refreshMe(); }, [token, refreshMe]);

  if (!token) return <AuthPage notice={notice} onToken={(t) => { sessionStorage.setItem('t', t); setNotice(null); setToken(t); }} />;
  const shared = { call, runner, me, tell, fail, refreshMe, wantFocus, flushFocus };
  return (
    <>
      <a className="skip" href="#content" onClick={(e) => { e.preventDefault(); document.getElementById('content')?.focus(); }}>Skip to content</a>
      <header className="top"><div className="wrap bar">
        <span className="brand">TeamForge</span>
        <span className="who">{me ? me.name : ''}</span>
        <button type="button" className="btn" onClick={() => signOut()}>Sign out</button>
      </div></header>
      <main className="wrap">
        <div role="status" aria-live="polite" className="sr-only">{notice?.kind === 'info' ? notice.text : ''}</div>
        {notice && (
          <div className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : undefined}>
            <span>{notice.text}</span><button type="button" className="btn small" onClick={() => setNotice(null)} aria-label="Dismiss message">Dismiss</button>
          </div>
        )}
        <div id="content" tabIndex={-1}>
          {!me ? <p className="muted" role="status">Loading your account…</p>
            : me.teamId ? <TeamPage key={me.teamId} id={me.teamId} {...shared} />
            : <BoardPage {...shared} />}
        </div>
      </main>
    </>
  );
}

function AuthPage({ onToken, notice }) {
  const [mode, setMode] = useState('login'); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const submit = async (e) => {
    e.preventDefault(); if (busyRef.current) return; busyRef.current = true; setBusy(true); setErr('');
    const f = Object.fromEntries(new FormData(e.target));
    const body = mode === 'login' ? { email: f.email, password: f.password }
      : { name: f.name, email: f.email, password: f.password, tz: Number(f.tz || 0), skills: (f.skills || '').split(',').map((s) => s.trim()).filter(Boolean) };
    try { const call = makeApi({ base: API }); const j = await call('POST', mode === 'login' ? '/auth/login' : '/auth/register', body); onToken(j.token); }
    catch (er) { setErr(friendly(er)); } finally { busyRef.current = false; setBusy(false); }
  };
  const login = mode === 'login';
  return (
    <main className="wrap narrow">
      <h1 className="hero">TeamForge</h1>
      <p className="muted">Find teammates for the hackathon.</p>
      {notice && <p className="notice info" role="status">{notice.text}</p>}
      <form className="panel" onSubmit={submit} aria-busy={busy}>
        <h2>{login ? 'Sign in' : 'Create your account'}</h2>
        {!login && <>
          <label className="field">Name<input name="name" required maxLength={60} autoComplete="name" readOnly={busy} /></label>
          <label className="field">Time zone (UTC offset, e.g. 5 or -8)<input name="tz" type="number" min={-12} max={14} defaultValue={0} inputMode="numeric" readOnly={busy} /></label>
          <label className="field">Skills, comma separated<input name="skills" placeholder="react, design" readOnly={busy} /></label>
        </>}
        <label className="field">Email<input name="email" type="email" required autoComplete="email" readOnly={busy} /></label>
        <label className="field">Password{!login && <span className="hint"> (at least 8 characters)</span>}
          <input name="password" type="password" required minLength={login ? 1 : 8} autoComplete={login ? 'current-password' : 'new-password'} readOnly={busy} /></label>
        <p className="error-text" role="alert">{err}</p>
        <div className="row">
          <button type="submit" className="btn primary" aria-disabled={busy || undefined}>{busy ? (login ? 'Signing in…' : 'Creating account…') : (login ? 'Sign in' : 'Create account')}</button>
          <button type="button" className="btn" onClick={() => { setErr(''); setMode(login ? 'register' : 'login'); }}>{login ? 'Need an account?' : 'Have an account?'}</button>
        </div>
      </form>
    </main>
  );
}

// Live updates. Reports connection state and re-syncs after a reconnect (events missed while offline are not replayed).
function useLive(topic, onEvent, onResync) {
  const [live, setLive] = useState(false);
  const ev = useRef(onEvent); ev.current = onEvent; const rs = useRef(onResync); rs.current = onResync;
  useEffect(() => {
    const token = sessionStorage.getItem('t'); let opened = false;
    const es = new EventSource(`${API}/events?topic=${encodeURIComponent(topic)}&token=${token}`);
    es.onopen = () => { setLive(true); if (opened) rs.current?.(); opened = true; };
    es.onerror = () => setLive(false);
    es.onmessage = (m) => ev.current(JSON.parse(m.data));
    return () => es.close();
  }, [topic]);
  return live;
}
const LiveBadge = ({ live }) => <span className={`live ${live ? 'on' : ''}`}>{live ? 'Live' : 'Reconnecting…'}</span>;

// Button that stays focusable while busy (aria-disabled, not disabled) so keyboard focus is never dropped.
function Btn({ busy, busyLabel, className = 'btn', onClick, children, ...rest }) {
  return <button type="button" className={className} aria-disabled={busy || undefined} onClick={(e) => { if (busy) return; onClick?.(e); }} {...rest}>{busy ? busyLabel || children : children}</button>;
}
// Two-step button for destructive actions: first press arms it, second press confirms; blur or 5s disarms.
function ConfirmBtn({ busy, busyLabel, label, confirmLabel, onConfirm, ariaLabel, confirmAria }) {
  const [armed, setArmed] = useState(false); const timer = useRef();
  useEffect(() => () => clearTimeout(timer.current), []);
  const click = () => { if (busy) return; if (!armed) { setArmed(true); clearTimeout(timer.current); timer.current = setTimeout(() => setArmed(false), 5000); return; } setArmed(false); onConfirm(); };
  return <button type="button" className={`btn ${armed ? 'danger-solid' : 'danger'}`} aria-disabled={busy || undefined} aria-label={armed ? confirmAria : ariaLabel} onClick={click} onBlur={() => setArmed(false)}>{busy ? busyLabel : armed ? confirmLabel : label}</button>;
}

function BoardPage({ call, runner, tell, fail, refreshMe, wantFocus, flushFocus }) {
  const [teams, setTeams] = useState([]); const [next, setNext] = useState(null);
  const [state, setState] = useState('loading'); // loading | ready | error
  const [more, setMore] = useState(false); const [sent, setSent] = useState({}); const [busy, setBusy] = useState({});
  const [creating, setCreating] = useState(false); const [joining, setJoining] = useState(false);
  const sentRef = useRef(sent); sentRef.current = sent;
  const open = (t) => t.size < t.maxSize;
  const load = useCallback(async () => {
    try { const b = await call('GET', '/board?limit=50'); setTeams(b.teams.filter(open)); setNext(b.next); setState('ready'); }
    catch (e) { if (e.status === 401) return fail(e); setState((s) => (s === 'ready' ? s : 'error')); if (e.uncertain) tell('error', friendly(e)); }
  }, [call, fail, tell]);
  useEffect(() => { load(); }, [load]);
  useLayoutEffect(() => { flushFocus(); });
  const loadMore = async () => {
    if (more || !next) return; setMore(true);
    try { const b = await call('GET', `/board?limit=50&after=${next}`); setTeams((ts) => { const ids = new Set(ts.map((t) => t.id)); return [...ts, ...b.teams.filter((t) => open(t) && !ids.has(t.id))]; }); setNext(b.next); }
    catch (e) { fail(e); } finally { setMore(false); }
  };
  const live = useLive('board', (ev) => {
    if (ev.type === 'team_deleted') { setTeams((ts) => ts.filter((t) => t.id !== ev.teamId)); return; }
    if (ev.type !== 'team') return; const t = ev.team;
    setTeams((ts) => { const ok = t.looking && open(t); const has = ts.some((x) => x.id === t.id);
      if (!ok) return ts.filter((x) => x.id !== t.id);
      return has ? ts.map((x) => (x.id === t.id ? { ...x, ...t } : x)) : [...ts, t].sort((a, b) => a.id - b.id); });
    if (sentRef.current[t.id] === 'sent') refreshMe().then((m) => { if (m?.teamId) { wantFocus('team-heading'); tell('info', 'Your request was accepted. You joined the team.'); } }); // a team I asked to join changed
  }, load);
  useEffect(() => { // requesters get no per-user event; re-check membership while any request is pending
    if (!Object.values(sent).includes('sent')) return undefined; const i = setInterval(() => refreshMe(), 15000); return () => clearInterval(i);
  }, [sent, refreshMe]);

  const onCreate = async (e) => {
    e.preventDefault(); if (creating || runner.isBusy('create-team')) return; const form = e.target; const name = String(new FormData(form).get('name') || '').trim(); if (!name) return;
    setCreating(true); tell(null, null);
    const r = await createTeam({ call, runner, name });
    if (r.outcome === 'busy') return; setCreating(false);
    if (r.outcome === 'created') { wantFocus('team-heading'); if (r.recovered) tell('info', `Your connection dropped, but "${name}" was created. You're its leader.`); else tell(null, null); await refreshMe(); }
    else if (r.outcome === 'already_member') { wantFocus('team-heading'); tell('info', `You're already in "${r.team.name}", so no new team was created.`); await refreshMe(); }
    else if (r.outcome === 'not_created') tell('error', `We couldn't reach the server, and your team was not created. Press "Create team" again; it's safe to retry.`);
    else if (r.outcome === 'unknown') tell('error', `We couldn't confirm whether "${name}" was created. Press "Create team" again; retrying won't create a duplicate.`);
    else fail(r.error);
  };
  const onJoin = async (e) => {
    e.preventDefault(); if (joining || runner.isBusy('join-code')) return; const code = String(new FormData(e.target).get('code') || '').trim(); if (!code) return;
    setJoining(true); tell(null, null); const r = await joinByCode({ call, runner, code });
    if (r.outcome === 'busy') return; setJoining(false);
    if (r.outcome === 'joined' || r.outcome === 'already_member') { wantFocus('team-heading'); tell('info', r.outcome === 'already_member' ? `You're already in "${r.team.name}".` : `You joined "${r.team.name}".`); await refreshMe(); }
    else if (r.outcome === 'not_joined') tell('error', "We couldn't reach the server and you did not join. Press \"Join with code\" again; it's safe to retry.");
    else if (r.outcome === 'unknown') tell('error', "We couldn't confirm whether you joined. Press \"Join with code\" again; retrying won't join twice.");
    else fail(r.error);
  };
  const ask = async (t) => {
    const action = `request:${t.id}`; if (busy[action] || sent[t.id]) return; setBusy((b) => ({ ...b, [action]: true })); tell(null, null);
    const r = await runner.run(action, action, (key) => call('POST', `/teams/${t.id}/requests`, {}, key));
    setBusy((b) => ({ ...b, [action]: false }));
    if (r.ok) setSent((s) => ({ ...s, [t.id]: 'sent' })); else if (!r.skipped) { fail(r.error); if (r.error.code === 'team_full') setTeams((ts) => ts.filter((x) => x.id !== t.id)); }
  };

  return (
    <>
      <section className="panel" aria-labelledby="start-h">
        <h2 id="start-h">Start or join a team</h2>
        <form className="row grow" onSubmit={onCreate} aria-busy={creating}>
          <label className="field inline"><span>New team name</span><input name="name" required minLength={2} maxLength={40} readOnly={creating} autoComplete="off" /></label>
          <Btn type="submit" className="btn primary" busy={creating} busyLabel="Creating…">Create team</Btn>
        </form>
        <form className="row grow" onSubmit={onJoin} aria-busy={joining}>
          <label className="field inline"><span>Invite code</span><input name="code" required minLength={10} maxLength={10} readOnly={joining} autoCapitalize="characters" autoComplete="off" spellCheck={false} className="mono" /></label>
          <Btn type="submit" className="btn" busy={joining} busyLabel="Joining…">Join with code</Btn>
        </form>
      </section>

      <section className="panel" aria-labelledby="board-heading">
        <div className="between"><h2 id="board-heading" tabIndex={-1}>Looking for teammates{state === 'ready' ? ` (${teams.length}${next ? '+' : ''})` : ''}</h2><LiveBadge live={live} /></div>
        {state === 'loading' && <p className="muted" role="status">Loading teams…</p>}
        {state === 'error' && <p className="error-text" role="alert">Couldn't load the board. <button type="button" className="btn small" onClick={() => { setState('loading'); load(); }}>Try again</button></p>}
        {state === 'ready' && teams.length === 0 && <p className="empty">No teams are looking for members right now. Create one above, and it will appear here for everyone.</p>}
        <ul className="list">
          {teams.map((t) => {
            const action = `request:${t.id}`; const open_ = t.maxSize - t.size;
            return (
              <li className="card" key={t.id}>
                <div className="grow-text">
                  <strong className="name">{t.name}</strong>
                  <span className="muted">{t.size} of {t.maxSize} members · {open_} open {open_ === 1 ? 'spot' : 'spots'}</span>
                </div>
                {sent[t.id] === 'sent'
                  ? <span className="chip ok" role="status">Request sent. You'll join automatically if the leader accepts.</span>
                  : <Btn className="btn primary" busy={busy[action]} busyLabel="Sending…" onClick={() => ask(t)} aria-label={`Request to join ${t.name}`}>Request to join</Btn>}
              </li>
            );
          })}
        </ul>
        {next && <Btn className="btn" busy={more} busyLabel="Loading…" onClick={loadMore}>Show more teams</Btn>}
      </section>
    </>
  );
}

function TeamPage({ id, call, runner, me, tell, fail, refreshMe, wantFocus, flushFocus }) {
  const [t, setT] = useState(null); const [loadErr, setLoadErr] = useState(false); const [busy, setBusy] = useState({}); const [sug, setSug] = useState(null);
  const load = useCallback(async () => {
    try { setT(await call('GET', `/teams/${id}`)); setLoadErr(false); }
    catch (e) { if (e.status === 404) { wantFocus('board-heading'); await refreshMe(); } else if (e.status === 401) fail(e); else setLoadErr(true); }
  }, [call, id, fail, refreshMe, wantFocus]);
  useEffect(() => { load(); }, [load]);
  useLayoutEffect(() => { flushFocus(); });
  const live = useLive(`team:${id}`, (ev) => {
    if (ev.type === 'membership_ended') { wantFocus('board-heading'); tell('info', 'You are no longer in that team.'); refreshMe(); return; } // server closes the stream after this
    if (ev.type === 'leader_changed' && ev.leaderId === me.id) tell('info', 'You are now the team leader.');
    load();
  }, load);

  const act = async (action, path, body, { success, focus, after, reload = true } = {}) => {
    if (busy[action]) return; setBusy((b) => ({ ...b, [action]: true })); tell(null, null); if (focus) wantFocus(focus, false);
    const r = await runner.run(action, `${path} ${JSON.stringify(body || {})}`, (key) => call('POST', `/teams/${id}${path}`, body || {}, key));
    setBusy((b) => ({ ...b, [action]: false })); if (r.skipped) return;
    if (!r.ok) { wantFocus(null); if (r.error.uncertain) tell('error', `${friendly(r.error)} We couldn't confirm the change. Check the page, then try again if needed.`); else fail(r.error); load(); return; }
    if (success) tell('info', success(r.value)); if (focus) wantFocus(focus); if (after) await after(r.value); if (reload) await load();
  };
  const copy = async (code) => { try { await navigator.clipboard.writeText(code); tell('info', 'Invite code copied.'); } catch { tell('info', 'Select the code and press Ctrl+C (or ⌘C) to copy it.'); } };

  if (loadErr && !t) return <p className="error-text" role="alert">Couldn't load your team. <button type="button" className="btn small" onClick={load}>Try again</button></p>;
  if (!t) return <p className="muted" role="status">Loading your team…</p>;
  const leader = t.leaderId === me.id; const need = t.minSize - t.size; const status = t.locked ? 'Locked' : need > 0 ? `Needs ${need} more to reach the minimum` : 'Open';
  const leaveLabel = t.size === 1 ? 'Leave and delete team' : 'Leave team';
  return (
    <>
      <section className="panel" aria-labelledby="team-heading">
        <div className="between"><h2 id="team-heading" tabIndex={-1} className="name">{t.name}</h2><LiveBadge live={live} /></div>
        <p className="muted">{t.size} of {t.maxSize} members · <span className={`chip ${t.locked || need > 0 ? 'warn' : 'ok'}`}>{status}</span></p>
        <h3 id="members-heading" tabIndex={-1}>Members</h3>
        <ul className="list">
          {t.members.map((m) => (
            <li className="card" key={m.id}>
              <div className="grow-text"><strong className="name">{m.name}{m.id === me.id ? ' (you)' : ''}</strong>{m.id === t.leaderId && <span className="chip">Leader</span>}<span className="muted">{skillsText(m.skills)}</span></div>
              {leader && m.id !== me.id && <ConfirmBtn label="Remove" confirmLabel="Confirm remove" busyLabel="Removing…" ariaLabel={`Remove ${m.name}`} confirmAria={`Confirm remove ${m.name}`} busy={busy[`rm:${m.id}`]}
                onConfirm={() => act(`rm:${m.id}`, `/members/${m.id}/remove`, {}, { success: () => `${m.name} was removed.`, focus: 'members-heading' })} />}
            </li>
          ))}
        </ul>
      </section>

      {leader && (
        <>
          <section className="panel" aria-labelledby="invite-h">
            <h2 id="invite-h">Invite code</h2>
            <p>Share this code so people can join directly: <code className="code" id="invite-code">{t.inviteCode}</code></p>
            <p className="muted">Expires {new Date(t.inviteExpires).toLocaleString()}</p>
            <div className="row">
              <button type="button" className="btn" onClick={() => copy(t.inviteCode)}>Copy code</button>
              <Btn className="btn" busy={busy.rotate} busyLabel="Creating…" onClick={() => act('rotate', '/rotate-invite', {}, { success: () => 'New invite code created. The old code no longer works.' })}>New code</Btn>
            </div>
          </section>

          <section className="panel" aria-labelledby="req-heading">
            <h2 id="req-heading" tabIndex={-1}>Join requests</h2>
            {t.requests.length === 0 && <p className="empty">No requests right now. People who ask from the board appear here instantly.</p>}
            <ul className="list" aria-live="polite">
              {t.requests.map((r) => (
                <li className="card" key={r.id}>
                  <div className="grow-text"><strong className="name">{r.name}</strong><span className="muted">{skillsText(r.skills)}</span></div>
                  <div className="row tight">
                    <Btn className="btn primary" busy={busy[`acc:${r.id}`]} busyLabel="Accepting…" aria-label={`Accept ${r.name}`} onClick={() => act(`acc:${r.id}`, `/requests/${r.id}/accept`, {}, { success: () => `${r.name} joined the team.`, focus: 'req-heading' })}>Accept</Btn>
                    <Btn className="btn" busy={busy[`dec:${r.id}`]} busyLabel="Declining…" aria-label={`Decline ${r.name}`} onClick={() => act(`dec:${r.id}`, `/requests/${r.id}/decline`, {}, { success: () => `Declined ${r.name}.`, focus: 'req-heading' })}>Decline</Btn>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel" aria-labelledby="manage-h">
            <h2 id="manage-h">Team settings</h2>
            <p className="muted">{t.locked ? 'The team is locked: it is hidden from the board and not accepting members.' : `Lock the team once it has at least ${t.minSize} members to close it.`}</p>
            <div className="row">
              <Btn className="btn" busy={busy.lock} busyLabel={t.locked ? 'Unlocking…' : 'Locking…'} onClick={() => act('lock', '/lock', { locked: !t.locked }, { success: (v) => (v.locked ? 'Team locked.' : 'Team unlocked.') })}>{t.locked ? 'Unlock team' : 'Lock team'}</Btn>
              <Btn className="btn" busy={busy.sug} busyLabel="Finding…" onClick={async () => { setBusy((b) => ({ ...b, sug: true })); try { setSug(await call('GET', `/teams/${id}/suggestions`)); } catch (e) { fail(e); } setBusy((b) => ({ ...b, sug: false })); }}>Suggest teammates</Btn>
            </div>
            {sug && <><p className="muted">{sug.formula}</p>{sug.suggestions.length === 0 && <p className="empty">No unteamed people to suggest.</p>}
              <ul className="list">{sug.suggestions.slice(0, 8).map((s) => (
                <li className="card" key={s.id}><div className="grow-text"><strong className="name">{s.name}</strong><span className="muted">adds {s.why.newSkills.join(', ') || 'nothing new'} · {s.why.tzDistanceHours}h apart</span></div><span className="chip">{s.score}</span></li>))}</ul></>}
          </section>
        </>
      )}

      <section className="panel" aria-labelledby="leave-h">
        <h2 id="leave-h">Leave</h2>
        <p className="muted">{t.size === 1 ? "You're the only member. Leaving deletes the team." : leader ? 'Leadership passes to the member who has been here longest.' : 'You can join or create another team afterwards.'}</p>
        <ConfirmBtn label={leaveLabel} confirmLabel={`Confirm: ${leaveLabel.toLowerCase()}`} busyLabel="Leaving…" busy={busy.leave}
          onConfirm={() => act('leave', '/leave', {}, { success: () => (t.size === 1 ? 'Team deleted.' : 'You left the team.'), reload: false, after: async () => { wantFocus('board-heading'); await refreshMe(); } })} />
      </section>
    </>
  );
}
