// Minimal in-memory stand-in for the @supabase/supabase-js CDN bundle.
// ONLY the third-party client is replaced — the app's own code in index.html
// runs untouched against it. `window.__db` is injected by the test runner so
// state can be shared across "page reloads".
(function () {
  const db = window.__db;
  let idSeq = db.idSeq || 1;

  class Query {
    constructor(name) {
      this.name = name;
      this._op = 'select';
      this._filters = [];
      this._order = null;
      this._payload = null;
      this._single = null;
    }
    select() { return this; }
    insert(p) { this._op = 'insert'; this._payload = Array.isArray(p) ? p : [p]; return this; }
    update(p) { this._op = 'update'; this._payload = p; return this; }
    upsert(p) { this._op = 'upsert'; this._payload = Array.isArray(p) ? p : [p]; return this; }
    delete() { this._op = 'delete'; return this; }
    eq(k, v) { this._filters.push([k, v]); return this; }
    order(k, opts) { this._order = { k, ascending: !(opts && opts.ascending === false) }; return this; }
    limit() { return this; }
    range() { return this; }
    maybeSingle() { this._single = 'maybe'; return this; }
    single() { this._single = 'one'; return this; }
    _rows() { return db.tables[this.name] || (db.tables[this.name] = []); }
    _matches(row) { return this._filters.every(([k, v]) => row[k] === v); }
    _run() {
      const rows = this._rows();
      if (this._op === 'insert' || this._op === 'upsert') {
        const out = this._payload.map((p) => { const row = Object.assign({ id: idSeq++ }, p); rows.push(row); return row; });
        db.idSeq = idSeq;
        this._result = out;
        return;
      }
      if (this._op === 'update') {
        const out = [];
        for (const r of rows) if (this._matches(r)) { Object.assign(r, this._payload); out.push(r); }
        this._result = out;
        return;
      }
      if (this._op === 'delete') {
        db.tables[this.name] = rows.filter((r) => !this._matches(r));
        this._result = db.tables[this.name];
        return;
      }
      let out = rows.filter((r) => this._matches(r));
      if (this._order) {
        const { k, ascending } = this._order;
        out = out.slice().sort((a, b) => (String(a[k]) > String(b[k]) ? 1 : -1) * (ascending ? 1 : -1));
      }
      this._result = out;
    }
    then(res, rej) {
      try {
        this._run();
        let data = this._result;
        if (this._single) data = Array.isArray(data) ? (data[0] || null) : data;
        return Promise.resolve({ data, error: null }).then(res, rej);
      } catch (e) {
        return Promise.reject(e).then(res, rej);
      }
    }
    catch(rej) { return this.then(undefined, rej); }
    finally(fn) { return this.then((v) => { fn(); return v; }, (e) => { fn(); throw e; }); }
  }

  const storageBucket = () => ({
    createSignedUrl: async (p) => ({ data: { signedUrl: 'https://signed.invalid/' + p }, error: null }),
    upload: async (p) => ({ data: { path: p }, error: null }),
    remove: async () => ({ data: null, error: null }),
    list: async () => ({ data: [], error: null }),
    getPublicUrl: (p) => ({ data: { publicUrl: 'https://public.invalid/' + p } })
  });

  window.supabase = {
    createClient: () => ({
      from: (name) => new Query(name),
      storage: { from: storageBucket },
      auth: {
        getSession: async () => ({ data: { session: db.session }, error: null }),
        getUser: async () => ({ data: { user: db.session ? db.session.user : null }, error: null }),
        refreshSession: async () => ({ data: { session: db.session }, error: null }),
        signInWithPassword: async ({ email, password }) => {
          if (password !== db.password) return { data: null, error: { message: 'Invalid login credentials' } };
          db.session = { user: { id: db.userId, email }, access_token: 'test-token' };
          db.listeners.forEach((fn) => { try { fn('SIGNED_IN', db.session); } catch {} });
          return { data: { user: db.session.user }, error: null };
        },
        signUp: async ({ email }) => {
          db.session = { user: { id: db.userId, email }, access_token: 'test-token' };
          return { data: { user: db.session.user }, error: null };
        },
        signOut: async () => {
          db.session = null;
          db.listeners.forEach((fn) => { try { fn('SIGNED_OUT', null); } catch {} });
          return { error: null };
        },
        onAuthStateChange: (cb) => { db.listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; }
      }
    })
  };
})();
