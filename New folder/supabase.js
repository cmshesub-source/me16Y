/* =====================================================================
   supabase.js  ·  TradeJournal data layer
   ---------------------------------------------------------------------
   - Loads @supabase/supabase-js from a CDN (no build step, works on GitHub Pages)
   - Creates the Supabase client
   - Authentication : signUp / signIn / signOut / getCurrentUser
   - Trades CRUD    : fetchTrades / addTrade / addTrades / updateTrade / deleteTrade / deleteAllTrades
   - Settings       : fetchSettings / saveSettings   (profiles table, one row per user)

   Usage (index.html):
     <script src="supabase.js"></script>      <!-- exposes window.TJ -->
     await TJ.ready;                           // library loaded + client created
     const user = await TJ.signIn(email, pw);
     const trades = await TJ.fetchTrades();

   Security: the anon key is public by design. Every table has Row Level
   Security (auth.uid() = user_id), so a user can only read/write their own rows.
   ===================================================================== */
(function (global) {
  'use strict';

  /* ── 1) Configuration ─────────────────────────────────────────────── */
  const SUPABASE_URL = 'https://bdjrufmpxqgqvtdnczpb.supabase.co';
  const SUPABASE_ANON_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkanJ1Zm1weHFncXZ0ZG5jenBiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIyODY5MzQsImV4cCI6MjEwNzg2MjkzNH0.Ed5Iz7QItp_zXJZANatltrio-nHBS4Byf4zau9iJZP8';
  const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.1';

  const TRADES = 'trades';
  const PROFILES = 'profiles';
  const PAGE = 1000;   // rows per page when reading
  const CHUNK = 200;   // rows per request when writing many

  /* ── 2) Load the library from the CDN, then create the client ─────── */
  function loadLibrary() {
    if (global.supabase && global.supabase.createClient) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = SUPABASE_CDN;
      s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Cannot load the Supabase library (check your connection)')); };
      document.head.appendChild(s);
    });
  }

  let client = null;

  /** Create a Supabase client (called once after the library has loaded). */
  function createSupabaseClient() {
    return global.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
  }

  /** Resolves with the client when ready; rejects if the CDN could not be reached. */
  const ready = loadLibrary().then(function () {
    client = createSupabaseClient();
    return client;
  });
  ready.catch(function () { /* handled by the caller that awaits TJ.ready */ });

  function db() {
    if (!client) throw new Error('Supabase is not ready yet — await TJ.ready first');
    return client;
  }
  function must(res) {            // unwrap { data, error }
    if (res.error) throw res.error;
    return res.data;
  }

  /* ── 3) Authentication ────────────────────────────────────────────── */

  /** Register with email + password + display name. */
  async function signUp(email, password, displayName) {
    await ready;
    const data = must(await db().auth.signUp({
      email: email,
      password: password,
      options: {
        data: { display_name: displayName },
        emailRedirectTo: location.origin + location.pathname
      }
    }));
    // Supabase returns a user with no identities when the email already exists.
    if (data.user && data.user.identities && !data.user.identities.length) {
      throw new Error('Email already registered');
    }
    // session is null when "Confirm email" is enabled → user must click the email link first.
    return { user: data.user, session: data.session, needsConfirmation: !data.session };
  }

  /** Log in with email + password. Returns the user. */
  async function signIn(email, password) {
    await ready;
    const data = must(await db().auth.signInWithPassword({ email: email, password: password }));
    return data.user;
  }

  /** Log out on this device. */
  async function signOut() {
    await ready;
    must(await db().auth.signOut());
  }

  /** Current logged-in user (restored from the saved session), or null. */
  async function getCurrentUser() {
    await ready;
    const data = must(await db().auth.getSession());
    return data.session ? data.session.user : null;
  }

  /** Subscribe to auth events (SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED …). */
  function onAuthChange(cb) {
    return db().auth.onAuthStateChange(function (event, session) { cb(event, session); });
  }

  /** Display name stored in the user's metadata (falls back to the email prefix). */
  function displayNameOf(user) {
    if (!user) return '';
    const md = user.user_metadata || {};
    return md.display_name || (user.email || '').split('@')[0] || 'User';
  }

  async function uid() {
    const u = await getCurrentUser();
    if (!u) throw new Error('Not logged in');
    return u.id;
  }

  /* ── 4) Row <-> app mapping ───────────────────────────────────────── */
  const num = function (x) { return Number.isFinite(x) ? x : null; };

  /** App trade object -> database row. */
  function toRow(t) {
    return {
      id: t.id,
      acct: t.acct,
      pair: t.pair,
      dir: t.dir,                         // 'B' = BUY, 'S' = SELL
      lot: num(t.lot),
      entry: num(t.entry),
      sl: num(t.sl),
      tp: num(t.tp),
      exit_price: num(t.exit),
      pnl: num(t.pnl) == null ? 0 : t.pnl,
      r: num(t.r) == null ? 0 : t.r,
      rr: num(t.rr) == null ? 0 : t.rr,
      open_at: t.open,
      close_at: t.close,
      trig: t.trig || [],
      tf: t.tf || '',
      ses: t.ses || '',
      tags: t.tags || [],
      url: t.url || '',
      note: t.note || ''
    };
  }

  /** Database row -> app trade object. */
  function fromRow(r) {
    const f = function (x) { return x == null ? NaN : +x; };
    const z = function (x) { return x == null ? 0 : +x; };
    return {
      id: +r.id, acct: r.acct, pair: r.pair, dir: r.dir,
      lot: f(r.lot), entry: f(r.entry), sl: f(r.sl), tp: f(r.tp), exit: f(r.exit_price),
      pnl: z(r.pnl), r: z(r.r), rr: z(r.rr),
      open: r.open_at || '', close: r.close_at || '',
      trig: r.trig || [], tf: r.tf || '', ses: r.ses || '', tags: r.tags || [],
      url: r.url || '', note: r.note || ''
    };
  }

  /* ── 5) Trades CRUD (RLS limits everything to the logged-in user) ─── */

  /** READ: all trades of the current user (newest first). */
  async function fetchTrades() {
    const id = await uid();
    let rows = [];
    for (let from = 0; ; from += PAGE) {
      const page = must(await db().from(TRADES).select('*').eq('user_id', id)
        .order('close_at', { ascending: false }).range(from, from + PAGE - 1)) || [];
      rows = rows.concat(page);
      if (page.length < PAGE) break;
    }
    return rows.map(fromRow);
  }

  /** CREATE: insert one trade. */
  async function addTrade(trade) {
    return addTrades([trade]);
  }

  /** CREATE: insert many trades (e.g. CSV import). */
  async function addTrades(list) {
    if (!list || !list.length) return;
    const id = await uid();
    for (let i = 0; i < list.length; i += CHUNK) {
      const rows = list.slice(i, i + CHUNK).map(function (t) {
        return Object.assign({ user_id: id }, toRow(t));
      });
      must(await db().from(TRADES).insert(rows));
    }
  }

  /** UPDATE: change one existing trade (matched by id). */
  async function updateTrade(trade) {
    const id = await uid();
    const row = toRow(trade);
    delete row.id;
    const data = must(await db().from(TRADES).update(row)
      .eq('user_id', id).eq('id', trade.id).select('id'));
    if (!data || !data.length) throw new Error('Trade not found in the database');
  }

  /** DELETE: remove one trade. */
  async function deleteTrade(tradeId) {
    const id = await uid();
    must(await db().from(TRADES).delete().eq('user_id', id).eq('id', tradeId));
  }

  /** DELETE: remove every trade of the current user. */
  async function deleteAllTrades() {
    const id = await uid();
    must(await db().from(TRADES).delete().eq('user_id', id));
  }

  /* ── 6) Settings (accounts, assets, tags, preferences) ────────────── */

  /** READ: the user's settings object, or null for a brand-new user. */
  async function fetchSettings() {
    const id = await uid();
    const data = must(await db().from(PROFILES).select('settings').eq('id', id).maybeSingle());
    return data && data.settings && Object.keys(data.settings).length ? data.settings : null;
  }

  /** CREATE/UPDATE: save settings (creates the profile row on first save). */
  async function saveSettings(settings, displayName) {
    const id = await uid();
    must(await db().from(PROFILES).upsert({
      id: id,
      display_name: displayName || null,
      settings: settings,
      updated_at: new Date().toISOString()
    }));
  }

  /* ── 7) Public API ────────────────────────────────────────────────── */
  global.TJ = {
    ready: ready,
    SUPABASE_URL: SUPABASE_URL,
    createSupabaseClient: createSupabaseClient,
    // auth
    signUp: signUp, signIn: signIn, signOut: signOut,
    getCurrentUser: getCurrentUser, onAuthChange: onAuthChange, displayNameOf: displayNameOf,
    // trades
    fetchTrades: fetchTrades, addTrade: addTrade, addTrades: addTrades,
    updateTrade: updateTrade, deleteTrade: deleteTrade, deleteAllTrades: deleteAllTrades,
    // settings
    fetchSettings: fetchSettings, saveSettings: saveSettings,
    // exposed for testing
    _toRow: toRow, _fromRow: fromRow
  };
})(typeof window !== 'undefined' ? window : globalThis);
