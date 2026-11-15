"""Optional real-browser check (NOT part of CI; needs `pip install playwright` + a Chromium). Not a project dependency.
Usage: from repo root, after `cd web && npm run build`:  python e2e/browser-check.py
Starts its own throw-away server + temp database. Never touches ./data.db."""
import os, re, subprocess, sys, tempfile, time, json
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT, PORT_RL = 3077, 3078
SHOTS = os.environ.get('SHOTS', os.path.join(tempfile.gettempdir(), 'tf-shots')); os.makedirs(SHOTS, exist_ok=True)
tmp = tempfile.mkdtemp(); results = []; misses = []; page_errors = []

def start(port, rate):
    env = {**os.environ, 'PORT': str(port), 'DB_PATH': os.path.join(tmp, f'{port}.db'), 'SECRET': 'e' * 40, 'RATE_LIMIT': 'on' if rate else 'off'}
    p = subprocess.Popen(['node', 'src/server.js'], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    import urllib.request
    for _ in range(50):
        try: urllib.request.urlopen(f'http://127.0.0.1:{port}/healthz'); return p
        except Exception: time.sleep(0.2)
    raise RuntimeError('server did not start')

def check(name, ok, detail=''):
    results.append((name, bool(ok), detail)); print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail and not ok else ''), flush=True)

# Records what is focused in the very same task as each DOM change (MutationObserver callbacks run right after React's commit),
# so a focus move scheduled by a timer or after a fetch cannot pass: there is no frame in which the target exists but is unfocused.
FOCUS_LOG_JS = """window.__focusLog = []; new MutationObserver((muts) => { const a = () => (document.activeElement && document.activeElement.id) || '';
  for (const m of muts) { for (const n of m.addedNodes) if (n.nodeType === 1) { const h = /-heading$/.test(n.id) ? n : n.querySelector && n.querySelector('[id$="-heading"]'); if (h) window.__focusLog.push({ ev: 'added', id: h.id, active: a() }); }
    for (const n of m.removedNodes) if (n.nodeType === 1 && n.matches && n.matches('li.card')) window.__focusLog.push({ ev: 'removed', text: n.textContent.slice(0, 40), active: a() }); } }).observe(document, { childList: true, subtree: true });"""
def flog(s): return s.page.evaluate('window.__focusLog')

class S:  # one browser session = one context = one account
    def __init__(self, browser, label, w=390, h=844, dark=False, mobile=True):
        self.label = label
        self.ctx = browser.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if mobile else 1, is_mobile=mobile, has_touch=mobile, color_scheme='dark' if dark else 'light')
        self.ctx.add_init_script(FOCUS_LOG_JS)
        self.page = self.ctx.new_page(); self.page.set_default_timeout(8000)
        self.page.on('pageerror', lambda e: page_errors.append(f'{label}: {e}'))
        self.page.on('console', lambda m: page_errors.append(f'{label}: console.error {m.text}') if m.type == 'error' and 'Failed to load resource' not in m.text else None)
    def goto(self, port=PORT): self.page.goto(f'http://127.0.0.1:{port}/')

def tab_to(page, locator, max_tabs=150):
    h = locator.element_handle()
    for _ in range(max_tabs):
        info = page.evaluate("""e => { const a = document.activeElement; if (a !== e) return null;
          const cs = getComputedStyle(a); return {outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2, name: a.getAttribute('aria-label') || a.textContent.slice(0, 30)}; }""", h)
        if info:
            if not info['outline']: misses.append(info['name'])
            return
        page.keyboard.press('Tab')
    raise AssertionError('could not reach by keyboard: ' + str(locator))
def kb_click(page, locator): tab_to(page, locator); page.keyboard.press('Enter')
def kb_type(page, locator, text): tab_to(page, locator); page.keyboard.type(text)
def btn(page, name, exact=True): return page.get_by_role('button', name=name, exact=exact)
def heading(page, name): return page.get_by_role('heading', name=name)
def active_id(page): return page.evaluate('document.activeElement && document.activeElement.id')

def overflow_ok(page):
    return page.evaluate("""() => { const w = innerWidth; if (document.documentElement.scrollWidth > w + 1) return 'doc scrollWidth ' + document.documentElement.scrollWidth;
      for (const e of document.querySelectorAll('main *, header *')) { const r = e.getBoundingClientRect(); if (r.width && r.right > w + 1 && !e.closest('.sr-only')) return e.tagName + '.' + e.className + ' right=' + Math.round(r.right); } return ''; }""") == ''
def targets_ok(page):
    small = page.evaluate("""() => [...document.querySelectorAll('button, input, a[href]')].filter(e => { const r = e.getBoundingClientRect(); return r.width && getComputedStyle(e).visibility !== 'hidden' && !e.closest('.skip') && !e.classList.contains('skip') && r.height < 43.5; }).map(e => (e.getAttribute('aria-label') || e.textContent || e.name).slice(0, 25))""")
    return small
def shot(s, name): s.page.screenshot(path=os.path.join(SHOTS, f'{name}.png'), full_page=True)

def register(s, name, email, skills='react', tz='5'):
    s.goto(); kb_click(s.page, btn(s.page, 'Need an account?'))
    kb_type(s.page, s.page.get_by_label('Name', exact=True), name); kb_type(s.page, s.page.get_by_label('Time zone', exact=False), tz)
    kb_type(s.page, s.page.get_by_label('Skills', exact=False), skills); kb_type(s.page, s.page.get_by_label('Email', exact=True), email)
    kb_type(s.page, s.page.get_by_label('Password', exact=False), 'password123'); s.page.keyboard.press('Enter')
    heading(s.page, 'Start or join a team').wait_for()
def login(s, email, port=PORT, pw='password123'):
    s.goto(port); kb_type(s.page, s.page.get_by_label('Email', exact=True), email); kb_type(s.page, s.page.get_by_label('Password', exact=False), pw); s.page.keyboard.press('Enter')
def create_team(s, name):
    kb_type(s.page, s.page.get_by_label('New team name'), name); s.page.keyboard.press('Enter'); heading(s.page, name).wait_for()
def invite_code(s): return s.page.locator('#invite-code').inner_text()
def card(s, name): return s.page.locator('li.card', has_text=name)
def wait_text(page, text, timeout=6000): page.get_by_text(text).first.wait_for(timeout=timeout)
def gone(page, text, timeout=6000): page.get_by_text(text, exact=False).first.wait_for(state='detached', timeout=timeout)

def main():
    srv = start(PORT, False); srv_rl = start(PORT_RL, True)
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(); run(br); br.close()
    finally:
        srv.kill(); srv_rl.kill()
    bad = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(bad)}/{len(results)} checks passed; keyboard focus without visible outline: {sorted(set(misses)) or "none"}; page errors: {page_errors or "none"}; screenshots: {SHOTS}')
    sys.exit(1 if bad else 0)

def run(br):
    stamp = str(int(time.time()))[-6:]; em = lambda n: f'{n}{stamp}@e2e.io'
    L = S(br, 'L'); O = S(br, 'O')
    # ---- 1. register by keyboard, skip link, layout
    register(L, 'Lena Leader', em('l')); shot(L, 'm-light-board-empty')
    check('register via keyboard lands on board', heading(L.page, 'Looking for teammates').is_visible())
    check('empty board state is explained', L.page.get_by_text('No teams are looking for members right now').first.is_visible())
    L.page.reload(); heading(L.page, 'Start or join a team').wait_for()
    L.page.evaluate('document.activeElement.blur()'); L.page.keyboard.press('Tab'); first = L.page.evaluate('document.activeElement.textContent')
    L.page.keyboard.press('Enter'); check('skip link is first tab stop and moves focus to content', 'Skip' in first and active_id(L.page) == 'content', first)
    register(O, 'Olive Observer', em('o'))
    # ---- 2. create-team submission UX: double submit, dropped request, lost reply
    A = S(br, 'A')  # slow network: delay POST /teams by 1.5s inside the page so the pending state is observable
    A.ctx.add_init_script("(() => { const o = window.fetch.bind(window); window.fetch = (u, i) => (i && i.method === 'POST' && String(u).endsWith('/teams')) ? new Promise((r) => setTimeout(r, 1500)).then(() => o(u, i)) : o(u, i); })()")
    register(A, 'Ann Double', em('a'))
    posts = []; A.page.on('request', lambda r: posts.append(r.headers.get('idempotency-key')) if r.method == 'POST' and r.url.endswith('/teams') else None)
    kb_type(A.page, A.page.get_by_label('New team name'), 'Double Click Co'); A.page.keyboard.press('Enter'); A.page.keyboard.press('Enter')
    A.page.evaluate("document.querySelector('form').requestSubmit(); document.querySelector('form').requestSubmit()")
    A.page.wait_for_timeout(300)
    check('pending state: button shows Creating… and stays focusable', btn(A.page, 'Creating…').is_visible() and A.page.evaluate("document.querySelector('form').getAttribute('aria-busy')") == 'true')
    check('pending state: field is read-only, not removed', A.page.get_by_label('New team name').get_attribute('readonly') is not None)
    heading(A.page, 'Double Click Co').wait_for()
    check('4 rapid submits produced exactly 1 POST', len(posts) == 1, str(posts))
    check('focus moved to team heading after create', active_id(A.page) == 'team-heading')

    B = S(br, 'B'); register(B, 'Bo Dropped', em('b')); keys = []; state = {'n': 0}
    def drop_once(route):
        if route.request.method != 'POST': return route.continue_()
        keys.append(route.request.headers.get('idempotency-key')); state['n'] += 1
        route.abort('failed') if state['n'] == 1 else route.continue_()
    B.page.route('**/teams', drop_once)
    kb_type(B.page, B.page.get_by_label('New team name'), 'Dropped Request'); B.page.keyboard.press('Enter')
    B.page.get_by_text('your team was not created').first.wait_for(); shot(B, 'm-light-error-notice')
    check('dropped request: clear error, controls restored', btn(B.page, 'Create team').is_visible() and B.page.get_by_label('New team name').get_attribute('readonly') is None)
    check('dropped request: typed name preserved', B.page.get_by_label('New team name').input_value() == 'Dropped Request')
    kb_click(B.page, btn(B.page, 'Create team')); heading(B.page, 'Dropped Request').wait_for()
    check('retry after uncertain failure reused the SAME Idempotency-Key', len(keys) == 2 and keys[0] == keys[1], str(keys))

    C = S(br, 'C'); register(C, 'Cy Lostreply', em('c')); st = {'n': 0}
    def lose_reply(route):
        if route.request.method != 'POST': return route.continue_()
        st['n'] += 1
        if st['n'] == 1: route.fetch(); route.abort('failed')   # server commits; the page never sees the answer
        else: route.continue_()
    C.page.route('**/teams', lose_reply)
    kb_type(C.page, C.page.get_by_label('New team name'), 'Lost Reply Labs'); C.page.keyboard.press('Enter'); heading(C.page, 'Lost Reply Labs').wait_for()
    check('lost reply: UI reconciled with real membership and shows the team', C.page.get_by_text('was created. You\'re its leader').first.is_visible())
    api = lambda s, path: s.page.evaluate("p => fetch(p, {headers:{authorization:'Bearer '+sessionStorage.getItem('t')}}).then(r => r.json())", path)
    check('lost reply: exactly one team exists on the server', sum(1 for t in api(O, '/board?limit=100')['teams'] if t['name'] == 'Lost Reply Labs') == 1)
    D = S(br, 'D'); register(D, 'Di Duplicate', em('d')); D.page.route('**/teams', lambda r: r.continue_())
    kb_type(D.page, D.page.get_by_label('New team name'), 'Dropped Request'); D.page.keyboard.press('Enter')
    D.page.get_by_text('already exists').first.wait_for(); check('duplicate team name: specific error, no success claimed', D.page.get_by_role('alert').filter(has_text='different name').is_visible())

    # ---- 3. leader flow at 390px, keyboard only
    create_team(L, 'Rocket Squad')
    check('leader lands on team page with heading focused', active_id(L.page) == 'team-heading')
    first = next(e for e in flog(L) if e['ev'] == 'added' and e['id'] == 'team-heading'); check('team heading was already focused when it first appeared (create)', first['active'] == 'team-heading', str(first))
    wait_text(O.page, 'Rocket Squad'); check('observer board shows new team live (no refresh)', card(O, 'Rocket Squad').is_visible())
    code1 = invite_code(L); rocket_id = next(t['id'] for t in api(O, '/board?limit=100')['teams'] if t['name'] == 'Rocket Squad')
    J = S(br, 'J'); register(J, 'Jo Joiner', em('j'), 'python,ml')
    kb_type(J.page, J.page.get_by_label('Invite code'), code1); J.page.keyboard.press('Enter'); heading(J.page, 'Rocket Squad').wait_for()
    check('join via invite code lands on team page, focus on heading', active_id(J.page) == 'team-heading')
    L.page.get_by_text('Jo Joiner').first.wait_for(); check('leader sees invite-joiner live', L.page.get_by_text('Jo Joiner').first.is_visible())
    check('observer board count updated live to 2 of 4', card(O, 'Rocket Squad').get_by_text('2 of 4 members').first.is_visible())
    shot(L, 'm-light-team-leader')

    # ---- 4. board request flow (separate from invite flow)
    R1 = S(br, 'R1'); register(R1, 'Rae Requester', em('r1'), 'design'); R2 = S(br, 'R2'); register(R2, 'Ray Declined', em('r2'))
    kb_click(R1.page, btn(R1.page, 'Request to join Rocket Squad')); R1.page.get_by_text("You'll join automatically").first.wait_for()
    check('requester sees pending confirmation', R1.page.get_by_text("You'll join automatically").first.is_visible()); shot(R1, 'm-light-requested')
    L.page.get_by_text('Rae Requester').first.wait_for(); check('leader sees board request live', L.page.get_by_role('button', name='Accept Rae Requester').is_visible())
    kb_click(R2.page, btn(R2.page, 'Request to join Rocket Squad')); L.page.get_by_text('Ray Declined').first.wait_for()
    kb_click(L.page, btn(L.page, 'Accept Rae Requester'))
    heading(R1.page, 'Rocket Squad').wait_for(timeout=8000); check('accepted requester moved to the team page without refreshing', R1.page.get_by_text('Your request was accepted').first.is_visible())
    check('after Accept focus stays in the requests region (not lost to <body>)', active_id(L.page) == 'req-heading', active_id(L.page))
    kb_click(L.page, btn(L.page, 'Decline Ray Declined')); L.page.get_by_text('Declined Ray Declined').first.wait_for()
    check('declined request leaves the list', L.page.get_by_text('No requests right now').first.is_visible())
    check('after the LAST request disappears focus is on the requests heading', active_id(L.page) == 'req-heading', active_id(L.page))
    gone_cards = {e['text'][:12]: e['active'] for e in flog(L) if e['ev'] == 'removed'}
    check('focus never dropped when the accepted request card was removed', gone_cards.get('Rae Requeste') == 'req-heading', str(gone_cards))
    check('focus never dropped when the last (declined) request card was removed', gone_cards.get('Ray Declined') == 'req-heading', str(gone_cards))
    check('declined requester is NOT in the team (still on board)', R2.page.get_by_role('heading', name='Looking for teammates').is_visible())
    check('request flow did not add the requester via the invite path (team has L,J,R1 = 3)', card(O, 'Rocket Squad').get_by_text('3 of 4 members').first.is_visible())

    # ---- 5. rotate invite, old code rejected, new code works, full team leaves the board
    X = S(br, 'X'); register(X, 'Xi Extra', em('x'))
    kb_click(L.page, btn(L.page, 'New code')); L.page.get_by_text('The old code no longer works').first.wait_for(); code2 = invite_code(L)
    check('rotate changes the invite code', code1 != code2)
    kb_type(X.page, X.page.get_by_label('Invite code'), code1); X.page.keyboard.press('Enter')
    X.page.get_by_role('alert').filter(has_text="doesn't match any team").wait_for(); check('old code gives a clear error', X.page.get_by_role('alert').filter(has_text="doesn't match any team").first.is_visible())
    check('inputs/button restored after failed join', btn(X.page, 'Join with code').is_visible() and X.page.get_by_label('Invite code').get_attribute('readonly') is None)
    X.page.get_by_label('Invite code').fill(code2); X.page.keyboard.press('Enter'); heading(X.page, 'Rocket Squad').wait_for()
    gone(O.page, 'Rocket Squad'); check('full team disappears from the observer board live', card(O, 'Rocket Squad').count() == 0)
    check('request button gone for R2 live when team filled', R2.page.get_by_role('button', name='Request to join Rocket Squad').count() == 0)

    # ---- 6. remove member (two-step), removed member bounced live, team returns to the board
    kb_click(L.page, btn(L.page, 'Remove Xi Extra')); check('first press arms the destructive action (no removal yet)', btn(L.page, 'Confirm remove Xi Extra').is_visible() and X.page.get_by_role('heading', name='Rocket Squad').is_visible())
    L.page.keyboard.press('Enter'); heading(X.page, 'Looking for teammates').wait_for(); check('removed member returned to the board live, with an explanation', X.page.get_by_text('You are no longer in that team').first.is_visible())
    L.page.get_by_text('Xi Extra was removed.').first.wait_for()
    check('focus after remove goes to members heading', active_id(L.page) == 'members-heading', active_id(L.page))
    wait_text(O.page, 'Rocket Squad'); check('team reappears on observer board live', card(O, 'Rocket Squad').get_by_text('3 of 4 members').first.is_visible())

    # ---- 7. lock / unlock
    kb_click(L.page, btn(L.page, 'Lock team')); L.page.get_by_text('Team locked.').first.wait_for(); gone(O.page, 'Rocket Squad')
    check('lock hides the team from the board live; button keeps focus', btn(L.page, 'Unlock team').is_visible() and L.page.evaluate("document.activeElement.textContent") == 'Unlock team')
    kb_click(L.page, btn(L.page, 'Unlock team')); wait_text(O.page, 'Rocket Squad'); check('unlock restores it live', card(O, 'Rocket Squad').is_visible())

    # ---- 8. desktop + dark screenshots of real states
    for dark, w, h, tag in [(False, 1280, 800, 'd-light'), (True, 1280, 800, 'd-dark'), (True, 390, 844, 'm-dark')]:
        s = S(br, 'shot-' + tag, w, h, dark, mobile=(w < 500)); login(s, em('l')); heading(s.page, 'Rocket Squad').wait_for(); shot(s, f'{tag}-team-leader')
        check(f'no horizontal overflow ({tag} team)', overflow_ok(s.page)); s.ctx.close()
    s = S(br, 'shot-board-d', 1280, 800, True, mobile=False); login(s, em('o')); heading(s.page, 'Looking for teammates').wait_for(); shot(s, 'd-dark-board'); s.ctx.close()
    s = S(br, 'shot-board-l', 1280, 800, False, mobile=False); login(s, em('o')); heading(s.page, 'Looking for teammates').wait_for(); shot(s, 'd-light-board'); s.ctx.close()
    s = S(br, 'shot-auth-d', 390, 844, True); s.goto(); shot(s, 'm-dark-auth'); s.ctx.close()
    sb = S(br, 'shot-board-md', 390, 844, True); login(sb, em('o')); heading(sb.page, 'Looking for teammates').wait_for(); shot(sb, 'm-dark-board'); sb.ctx.close()

    # ---- 9. long unbroken names at 390px
    LN = S(br, 'LN'); register(LN, 'W' * 55, em('ln'), 'a'*24+','+'b'*24)
    kb_type(LN.page, LN.page.get_by_label('New team name'), 'M' * 40); LN.page.keyboard.press('Enter'); heading(LN.page, 'M' * 40).wait_for()
    check('long team/user names do not overflow the 390px layout (team page)', overflow_ok(LN.page)); shot(LN, 'm-light-long-names')
    for s in (L, O, J, R1):
        check(f'no horizontal overflow at 390px ({s.label})', overflow_ok(s.page)); small = targets_ok(s.page); check(f'all controls >= 44px tall ({s.label})', not small, str(small))

    # ---- 10. leader leaves -> leadership passes; members leave; last member deletes team
    kb_click(L.page, btn(L.page, 'Leave team')); L.page.keyboard.press('Enter')
    heading(L.page, 'Looking for teammates').wait_for(); check('leader left; focus on board heading', active_id(L.page) == 'board-heading', active_id(L.page))
    last = [e for e in flog(L) if e['ev'] == 'added' and e['id'] == 'board-heading'][-1]; check('board heading was already focused when it was rendered (leader left)', last['active'] == 'board-heading', str(last))
    heading(J.page, 'Invite code').wait_for(); check('leadership passed to longest-standing member (Jo) live', J.page.get_by_text('You are now the team leader').first.is_visible())
    kb_click(R1.page, btn(R1.page, 'Leave team')); R1.page.keyboard.press('Enter'); heading(R1.page, 'Looking for teammates').wait_for(); check('member leaves cleanly', heading(R1.page, 'Looking for teammates').is_visible())
    J.page.get_by_text('1 of 4 members').first.wait_for(); kb_click(J.page, btn(J.page, 'Leave and delete team'))
    check('last member sees deletion warning before confirming', J.page.get_by_text('Leaving deletes the team').first.is_visible())
    J.page.keyboard.press('Enter'); heading(J.page, 'Looking for teammates').wait_for()
    check('last member leaving deleted the team (gone from observer board)', card(O, 'Rocket Squad').count() == 0)
    check('team really gone on the server (GET /teams/id is 404)', O.page.evaluate("p => fetch(p, {headers:{authorization:'Bearer '+sessionStorage.getItem('t')}}).then(r => r.status)", f'/teams/{rocket_id}') == 404)

    # ---- 11. rate limit message (separate server with limits on)
    T = S(br, 'T'); T.goto(PORT_RL)
    kb_type(T.page, T.page.get_by_label('Email', exact=True), 'nobody@e2e.io'); kb_type(T.page, T.page.get_by_label('Password', exact=False), 'wrongpass1')
    for _ in range(12):  # the login limit is 10 per minute per IP
        tab_to(T.page, btn(T.page, 'Sign in')); T.page.keyboard.press('Enter'); T.page.wait_for_timeout(150)
    T.page.get_by_text('Too many attempts').first.wait_for(); check('rate limit shows a readable wait time', 'seconds' in T.page.get_by_role('alert').first.inner_text() or 'seconds' in T.page.inner_text('body'))
    shot(T, 'm-light-rate-limit')

if __name__ == '__main__': main()
