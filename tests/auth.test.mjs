// Auth + first-paint regression suite.
//
// The login form used to reject every address that was typed into it (the email
// regex was over-escaped inside a regex literal), so sign-in could never
// succeed. These tests load the real index.html and drive the real handlers.
import { JSDOM } from 'jsdom';
import fs from 'fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- harness ----
function bootApp({ sessionUser = null, onSignIn, onSignUp, preset = {} } = {}) {
  const state = {
    calls: [],
    alerts: [],
    profileSelects: 0,
    sessionUser,
    authCb: null
  };

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost/',
    beforeParse(window) {
      for (const [k, v] of Object.entries(preset)) window.localStorage.setItem(k, v);

      const auth = {
        getSession: async () => ({ data: { session: state.sessionUser ? { user: state.sessionUser, access_token: 'tok' } : null }, error: null }),
        getUser: async () => ({ data: { user: state.sessionUser } }),
        onAuthStateChange: (cb) => { state.authCb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
        signInWithPassword: async (creds) => {
          state.calls.push(['signInWithPassword', creds]);
          if (onSignIn) return onSignIn(creds, state);
          state.sessionUser = { id: 'u1', email: creds.email };
          return { data: { user: state.sessionUser }, error: null };
        },
        signUp: async (creds) => {
          state.calls.push(['signUp', creds]);
          if (onSignUp) return onSignUp(creds, state);
          return { data: { user: { id: 'u2', email: creds.email }, session: null }, error: null };
        },
        signOut: async () => { state.sessionUser = null; return { error: null }; }
      };

      const chain = () => {
        const c = {
          select: () => c, eq: () => c, order: () => c, limit: () => c, insert: () => c,
          update: () => c, upsert: () => c, delete: () => c,
          maybeSingle: async () => ({ data: { username: 'ayush' }, error: null }),
          single: async () => ({ data: null, error: null }),
          then: (res) => res({ data: [], error: null })
        };
        return c;
      };

      window.supabase = {
        createClient: () => ({
          auth,
          from: (table) => { if (table === 'profiles') state.profileSelects++; return chain(); },
          storage: {
            from: () => ({
              createSignedUrl: async () => ({ data: null, error: null }),
              upload: async () => ({ data: null, error: null }),
              remove: async () => ({ data: null, error: null }),
              list: async () => ({ data: [], error: null }),
              getPublicUrl: () => ({ data: { publicUrl: '' } })
            })
          }
        })
      };
      window.hljs = { highlightElement() {}, highlight: (c) => ({ value: c }), listLanguages: () => [] };
      window.alert = (m) => state.alerts.push(String(m));
      window.confirm = () => true;
      window.prompt = () => null;
      window.Element.prototype.scrollIntoView = function () {};
      window.HTMLCanvasElement.prototype.getContext = () => null;
      window.fetch = async () => { throw new Error('offline'); };
      window.console.error = () => {};
      window.console.warn = () => {};
    }
  });

  return { dom, w: dom.window, doc: dom.window.document, state };
}

const display = (w, id) => w.getComputedStyle(w.document.getElementById(id)).display;
const submit = (w) => w.document.getElementById('authForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));

// ------------------------------------------------- 1. structure / markup -----
{
  const { w, doc } = bootApp();
  await wait(400);

  console.log('\n== Sign-in form is a real form (Enter submits) ==');
  const form = doc.getElementById('authForm');
  ok('#authForm exists inside #auth-modal', !!form && doc.getElementById('auth-modal').contains(form));
  ok('#authForm has an onsubmit handler', typeof form.getAttribute('onsubmit') === 'string' && /handleAuth/.test(form.getAttribute('onsubmit')));
  ok('#authActionBtn is type=submit (so Enter works in browsers)', doc.getElementById('authActionBtn').type === 'submit', doc.getElementById('authActionBtn').type);
  ok('#email has an email type + autocomplete', doc.getElementById('email').type === 'email' && doc.getElementById('email').getAttribute('autocomplete') === 'email');
  ok('#password starts on current-password', doc.getElementById('password').getAttribute('autocomplete') === 'current-password');

  console.log('\n== Feedback, close and password visibility exist ==');
  const msg = doc.getElementById('authMsg');
  ok('#authMsg is an aria-live status region', !!msg && msg.getAttribute('role') === 'status' && msg.getAttribute('aria-live') === 'polite');
  ok('#authMsg starts hidden', !!msg && msg.hidden);
  ok('modal has a working close button', !!doc.getElementById('authCloseBtn'));
  ok('modal has a password reveal button', !!doc.getElementById('authPassToggle'));

  console.log('\n== Dialog layers ==');
  const styleSrc = doc.querySelector('style').textContent;
  const allZ = (sel) => [...styleSrc.matchAll(new RegExp(sel.replace(/[#.]/g, '\\$&') + '\\{[^}]*z-index:(\\d+)', 'g'))].map((m) => Number(m[1]));
  const z = (sel) => { const list = allZ(sel); return list.length ? Math.max(...list) : NaN; };
  ok('auth modal sits above the landing page', z('#auth-modal') > z('#welcome-screen'), `auth=${z('#auth-modal')} welcome=${z('#welcome-screen')}`);
  ok('memory modal sits above the landing page', z('#memory-modal') > z('#welcome-screen'));
  ok('lightbox stays on top of everything', z('#lightbox-overlay') > z('#memory-modal'));
  ok('inline error styling exists', /\.auth-msg\.error\{/.test(styleSrc.replace(/\s+/g, '')));
  ok('button busy spinner styling exists', /#authActionBtn \.btn-spinner\{/.test(styleSrc));

  w.close();
}

// ------------------------- 2. email validation + the original regression -----
{
  const { w, state } = bootApp({
    onSignIn: async () => ({ data: null, error: { message: 'Invalid login credentials', status: 400 } })
  });
  const q = (id) => w.document.getElementById(id);
  await wait(400);

  console.log('\n== Email validation accepts real addresses (the login regression) ==');
  const cases = [
    ['user@example.com', true], ['a.b+tag@sub.domain.co', true], ['ayush@test.io', true],
    ['b@b.co', true], ['someone@mail.example.co.uk', true],
    ['', false], ['plainaddress', false], ['a@b', false], ['a b@c.com', false],
    ['a@@b.com', false], ['a@b..com', false], ['@example.com', false]
  ];
  for (const [email, expected] of cases) {
    const got = w.eval(`isValidEmail(${JSON.stringify(email)})`);
    ok(`isValidEmail(${JSON.stringify(email)}) === ${expected}`, got === expected, String(got));
  }

  console.log('\n== The form now reaches Supabase ==');
  w.eval("openAuthFromWelcome('login')");
  q('email').value = 'user@example.com';
  q('password').value = 'hunter2';
  state.calls.length = 0;
  submit(w);
  await wait(250);
  const signIn = state.calls.find((c) => c[0] === 'signInWithPassword');
  ok('a valid email actually calls signInWithPassword', !!signIn, JSON.stringify(state.calls));
  ok('the address is passed through unchanged', !!signIn && signIn[1].email === 'user@example.com', JSON.stringify(signIn && signIn[1]));
  ok('no alert() is used in the auth path', state.alerts.length === 0, JSON.stringify(state.alerts));
  ok('wrong password renders an inline message', /incorrect/i.test(q('authMsg').textContent), q('authMsg').textContent);
  ok('that message is styled as an error', q('authMsg').className.includes('error'));
  ok('the dialog stays open after a failure', display(w, 'auth-modal') === 'flex');

  console.log('\n== Validation messages are inline, never alerts ==');
  state.calls.length = 0;
  q('email').value = 'not-an-email';
  q('password').value = 'hunter2';
  submit(w);
  await wait(150);
  ok('bad email: inline error, no network call', state.calls.length === 0 && /does not look right/i.test(q('authMsg').textContent), q('authMsg').textContent);
  ok('bad email: still no alert()', state.alerts.length === 0);

  q('email').value = 'user@example.com';
  q('password').value = '';
  submit(w);
  await wait(100);
  ok('empty password is caught', /Enter your password/i.test(q('authMsg').textContent), q('authMsg').textContent);

  q('password').value = '123';
  submit(w);
  await wait(100);
  ok('short password is caught', /at least 6/i.test(q('authMsg').textContent), q('authMsg').textContent);
  ok('no call was made for any invalid submission', state.calls.length === 0, JSON.stringify(state.calls));

  console.log('\n== Passwords are not silently trimmed ==');
  state.calls.length = 0;
  q('email').value = 'user@example.com';
  q('password').value = '  spaced pass  ';
  submit(w);
  await wait(200);
  const call = state.calls.find((c) => c[0] === 'signInWithPassword');
  ok('the password is sent exactly as typed', !!call && call[1].password === '  spaced pass  ', JSON.stringify(call && call[1]));

  w.close();
}

// --------------------------------- 3. busy lock, double submit, escape -------
{
  let resolveSignIn;
  const { w, state } = bootApp({
    onSignIn: () => new Promise((res) => { resolveSignIn = res; })
  });
  const q = (id) => w.document.getElementById(id);
  await wait(400);

  console.log('\n== A slow sign-in cannot be submitted twice ==');
  q('email').value = 'user@example.com';
  q('password').value = 'hunter2';
  state.calls.length = 0;
  submit(w);
  submit(w);
  submit(w);
  await wait(60);
  ok('three clicks produce one request', state.calls.length === 1, JSON.stringify(state.calls.length));
  ok('the button is disabled while working', q('authActionBtn').disabled === true);
  ok('the button shows progress text', /Signing in/i.test(q('authActionBtn').textContent), q('authActionBtn').textContent);
  resolveSignIn({ data: { user: { id: 'u1', email: 'user@example.com' } }, error: null });
  await wait(300);
  ok('the button recovers after the request', q('authActionBtn').disabled === false);

  console.log('\n== Signed-out Escape returns to the landing page (was a blank shell) ==');
  w.eval('logout()');
  await wait(200);
  q('email').value = '';
  q('password').value = '';
  w.eval("openAuthFromWelcome('login')");
  await wait(50);
  ok('modal open, landing page hidden', display(w, 'auth-modal') === 'flex' && q('welcome-screen').hidden === true);
  const esc = new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
  w.document.dispatchEvent(esc);
  await wait(80);
  ok('Escape closes the dialog', display(w, 'auth-modal') === 'none');
  ok('Escape brings the landing page back', q('welcome-screen').hidden === false, 'welcome hidden=' + q('welcome-screen').hidden);
  ok('the password field is cleared on close', q('password').value === '');

  console.log('\n== The ✕ button does the same ==');
  w.eval("openAuthFromWelcome('login')");
  w.closeAuthModal();
  await wait(50);
  ok('closeAuthModal() restores the landing page when signed out', q('welcome-screen').hidden === false && display(w, 'auth-modal') === 'none');

  console.log('\n== Escape closes one layer at a time ==');
  w.eval("currentUserId = 'u1'; openSettings(); openMemoryEditor();");
  await wait(120);
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(80);
  ok('first Escape closes the memory dialog only', display(w, 'memory-modal') === 'none' && display(w, 'settings-modal') === 'flex',
    `memory=${display(w, 'memory-modal')} settings=${display(w, 'settings-modal')}`);
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(80);
  ok('second Escape closes settings', display(w, 'settings-modal') === 'none');

  let threw = null;
  try {
    w.openImageLightbox('data:image/gif;base64,R0lGODlhAQABAAAAACw=', 'proof');
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  } catch (e) { threw = e.message; }
  const lightbox = w.document.getElementById('lightbox-overlay');
  ok('Escape closes the image lightbox without throwing', threw === null && !!lightbox && !lightbox.classList.contains('open'),
    threw || 'still open');

  w.close();
}

// ------------------------------ 4. signup + confirmation guidance ------------
{
  const { w, state } = bootApp();
  const q = (id) => w.document.getElementById(id);
  await wait(400);

  console.log('\n== Signup ==');
  w.setAuthMode('signup');
  ok('signup switches the password field to new-password', q('password').getAttribute('autocomplete') === 'new-password');
  ok('the username field appears', q('username').style.display !== 'none');
  ok('button label becomes Create account', /Create account/i.test(q('authActionBtn').textContent), q('authActionBtn').textContent);

  q('email').value = 'new@example.com';
  q('password').value = 'hunter2';
  q('username').value = 'ay';
  state.calls.length = 0;
  submit(w);
  await wait(150);
  ok('a too-short username is rejected before any call', state.calls.length === 0 && /3 characters/i.test(q('authMsg').textContent), q('authMsg').textContent);

  q('username').value = 'ayush';
  submit(w);
  await wait(300);
  const signUp = state.calls.find((c) => c[0] === 'signUp');
  ok('signUp is called with the username attached', !!signUp && signUp[1].options?.data?.username === 'ayush', JSON.stringify(signUp && signUp[1]));
  ok('when confirmation is required the user is told to check their inbox',
    /confirmation link/i.test(q('authMsg').textContent), q('authMsg').textContent);
  ok('that message is success-styled, not an error', q('authMsg').className.includes('success'));
  ok('the dialog stays open for the confirmation step', display(w, 'auth-modal') === 'flex');

  console.log('\n== Common Supabase errors get human text ==');
  const setError = (msg) => bootApp({ onSignIn: async () => ({ data: null, error: { message: msg } }) });
  const cases = [
    ['Email not confirmed', /not confirmed/i],
    ['Invalid login credentials', /incorrect/i],
    ['Email rate limit exceeded', /Too many attempts/i],
    ['Failed to fetch', /connection/i],
    ['User already registered', /already has an account/i]
  ];
  for (const [raw, expected] of cases) {
    const env = setError(raw);
    const qe = (id) => env.w.document.getElementById(id);
    await wait(350);
    qe('email').value = 'user@example.com';
    qe('password').value = 'hunter2';
    submit(env.w);
    await wait(150);
    const text = qe('authMsg').textContent;
    ok(`"${raw}" -> ${expected}`, expected.test(text), text);
    env.w.close();
  }

  w.close();
}

// ------------------------------ 5. session restore / no double hydration ----
{
  const { w, state } = bootApp({ sessionUser: { id: 'u1', email: 'ayush@example.com' } });
  const q = (id) => w.document.getElementById(id);
  await wait(500);

  console.log('\n== Boot with an existing session ==');
  ok('landing page is hidden', q('welcome-screen').hidden === true);
  ok('auth dialog is hidden', display(w, 'auth-modal') === 'none');
  ok('the signed-in username is shown', q('userDisplay').textContent === 'ayush', q('userDisplay').textContent);
  ok('a chat session exists', w.eval('currentSessionId') !== null);
  const bootQueries = state.profileSelects;

  console.log('\n== Token refresh must not rebuild the shell (flicker) ==');
  state.authCb('TOKEN_REFRESHED', { user: { id: 'u1', email: 'ayush@example.com' } });
  await wait(200);
  ok('TOKEN_REFRESHED does not re-hydrate', state.profileSelects === bootQueries, `profile selects ${bootQueries} -> ${state.profileSelects}`);
  state.authCb('USER_UPDATED', { user: { id: 'u1', email: 'ayush@example.com' } });
  await wait(200);
  ok('USER_UPDATED does not re-hydrate', state.profileSelects === bootQueries);

  console.log('\n== A duplicate SIGNED_IN is shared, not repeated ==');
  state.authCb('SIGNED_IN', { user: { id: 'u1', email: 'ayush@example.com' } });
  await wait(200);
  ok('repeat hydration for the same user is skipped', state.profileSelects === bootQueries, `profile selects ${state.profileSelects}`);
  await w.eval("hydrateUserAndLoadChats({ id: 'u1' }, { force: true })");
  ok('force:true still reloads when asked', state.profileSelects === bootQueries + 1, String(state.profileSelects));

  console.log('\n== SIGNED_OUT cleans up ==');
  state.sessionUser = null;
  state.authCb('SIGNED_OUT', null);
  await wait(300);
  ok('landing page returns', q('welcome-screen').hidden === false);
  ok('user state is cleared', w.eval('currentUserId') === null && w.eval('Object.keys(userSessions).length') === 0);
  ok('the sidebar name resets to User', q('userDisplay').textContent === 'User', q('userDisplay').textContent);
  ok('the chat list is emptied', q('historyList').children.length === 0);

  w.close();
}

// ------------------------------------------------- 6. first paint / theme ----
{
  console.log('\n== Theme is applied before first paint (no dark-to-light flash) ==');
  const headScripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => ({ index: m.index, code: m[1] }));
  const styleIndex = html.indexOf('<style>');
  const prePaint = headScripts.find((s) => s.index < styleIndex && /data-theme/.test(s.code));
  ok('an inline script before the stylesheet applies the theme', !!prePaint);

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost/',
    beforeParse(window) {
      window.localStorage.setItem('theme', 'light');
      window.localStorage.setItem('compactMode', 'true');
      window.supabase = { createClient: () => ({ auth: { getSession: async () => ({ data: { session: null } }), getUser: async () => ({ data: { user: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signInWithPassword: async () => ({ data: null, error: null }), signUp: async () => ({ data: null, error: null }), signOut: async () => ({ error: null }) }, from: () => { const c = { select: () => c, eq: () => c, order: () => c, maybeSingle: async () => ({ data: null, error: null }), then: (r) => r({ data: [], error: null }) }; return c; } }) };
      window.hljs = { highlightElement() {}, highlight: (c) => ({ value: c }), listLanguages: () => [] };
      window.Element.prototype.scrollIntoView = function () {};
      window.HTMLCanvasElement.prototype.getContext = () => null;
      window.console.error = () => {};
    }
  });
  ok('data-theme is set during parsing (before load)', dom.window.document.documentElement.getAttribute('data-theme') === 'light',
    String(dom.window.document.documentElement.getAttribute('data-theme')));
  ok('compact spacing is pre-applied', dom.window.document.documentElement.style.getPropertyValue('--chat-gap') === '6px',
    dom.window.document.documentElement.style.getPropertyValue('--chat-gap'));
  dom.window.close();
}

// --------------------------------- 7. supabase-js blocked / offline ----------
{
  console.log('\n== If the Supabase CDN never loads, the app still runs ==');
  const alerts = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost/',
    beforeParse(window) {
      // no window.supabase at all — simulates a blocked CDN / offline mobile
      window.hljs = { highlightElement() {}, highlight: (c) => ({ value: c }), listLanguages: () => [] };
      window.alert = (m) => alerts.push(String(m));
      window.confirm = () => true;
      window.Element.prototype.scrollIntoView = function () {};
      window.HTMLCanvasElement.prototype.getContext = () => null;
      window.console.error = () => {};
      window.console.warn = () => {};
    }
  });
  const w = dom.window;
  await wait(400);
  const q = (id) => w.document.getElementById(id);
  ok('the app still boots (no crash without the CDN)', typeof w.handleAuth === 'function');
  ok('the offline boot banner is shown', !!q('boot-warning'));
  w.eval("openAuthFromWelcome('login')");
  q('email').value = 'user@example.com';
  q('password').value = 'hunter2';
  submit(w);
  await wait(200);
  ok('sign-in explains the connection problem inline', /connection|offline/i.test(q('authMsg').textContent), q('authMsg').textContent);
  ok('it does not throw an alert at the user', alerts.length === 0, JSON.stringify(alerts));
  ok('the dialog is still usable', w.getComputedStyle(q('auth-modal')).display !== 'none');
  dom.window.close();
}

console.log(`\n${fail === 0 ? 'AUTH ALL GREEN' : 'AUTH FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
