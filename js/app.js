    const tg = window.Telegram?.WebApp;
    // Реальная Telegram-сессия: initData заполнен только внутри Telegram WebApp.
    // В обычном браузере WebApp-объект есть, но его методы (showConfirm и т.п.)
    // падают внутри кросс-доменного telegram.org скрипта с маскированной "Script error."
    const IS_TG = !!(tg && (tg.initData || window.TelegramWebviewProxy));
    if (tg) { try { tg.ready() } catch (e) { } try { tg.expand() } catch (e) { } try { tg.disableVerticalSwipes?.() } catch (e) { } }
    const $ = id => document.getElementById(id);
    function parseNum(val) {
      if (val === null || val === undefined) return 0;
      const s = String(val).replace(/\s/g, '').replace(',', '.').trim();
      const n = parseFloat(s);
      return isNaN(n) ? 0 : n;
    }
    // Безопасный калькулятор выражений: «150 + 80 * 2» → итог.
    // Разрешены только цифры, точка и + - * / ( ). Без Function/eval.
    function calcExpr(str) {
      const s = String(str).replace(/,/g, '.').replace(/[^0-9.+\-*/().]/g, '');
      if (!s) return NaN;
      try {
        let pos = 0;
        function peek() { while (pos < s.length && s[pos] === ' ') pos++; return s[pos] }
        function num() {
          const m = /^\d*\.?\d+/.exec(s.slice(pos));
          if (!m) throw 0;
          pos += m[0].length;
          return parseFloat(m[0]);
        }
        function factor() {
          if (peek() === '-') { pos++; return -factor() }
          if (peek() === '+') { pos++; return factor() }
          if (peek() === '(') { pos++; const v = expr(); if (peek() !== ')') throw 0; pos++; return v }
          return num();
        }
        function term() {
          let v = factor();
          while (peek() === '*' || peek() === '/') {
            const op = peek(); pos++;
            const r = factor();
            v = op === '*' ? v * r : v / r;
          }
          return v;
        }
        function expr() {
          let v = term();
          while (peek() === '+' || peek() === '-') {
            const op = peek(); pos++;
            const r = term();
            v = op === '+' ? v + r : v - r;
          }
          return v;
        }
        const r = expr();
        if (pos < s.length || !isFinite(r)) return NaN;
        return r;
      } catch (e) { return NaN }
    }
    function evalAmtInput(el) {
      if (!el) return;
      const v = String(el.value || '').trim();
      if (!v || !/[+\-*/()]/.test(v)) { el.value = parseNum(v); return }
      const r = calcExpr(v);
      if (!isNaN(r) && r > 0) {
        el.value = Math.round(r * 100) / 100;
        if (el.id === 'e-amt' && splitMode === 'custom') renderShareInputs();
      }
    }

    let pMode = 'plain', splitMode = 'equal', curCat = '';
    let payerId = '';        // выбранный плательщик (чип в шторке)
    let editExpId = null;    // id траты в режиме редактирования
    let filterPart = null;   // фильтр ленты по участнику (id) — null = все
    let S = null;
    const CURS = ['₴', '$', '€', '₽', '₸', 'zł'];

    /* ─── TELEGRAM USER & INITDATA VALIDATION ─── */
    function parseTelegramInitData(raw) {
      if (!raw || typeof raw !== 'string') return { valid: false, status: 'guest', reason: 'empty_init_data', user: null };
      try {
        const p = new URLSearchParams(raw);
        const hash = p.get('hash');
        const authDateStr = p.get('auth_date');
        const userStr = p.get('user');
        if (!hash || !authDateStr) return { valid: false, status: 'invalid', reason: 'missing_fields', user: null };
        if (!/^[a-f0-9]{64}$/i.test(hash)) return { valid: false, status: 'invalid', reason: 'invalid_hash', user: null };
        const authDate = parseInt(authDateStr, 10);
        const now = Math.floor(Date.now() / 1000);
        if (isNaN(authDate) || authDate > now + 120) return { valid: false, status: 'invalid', reason: 'future_date', user: null };
        const isExpired = (now - authDate) > 86400; // 24 часа
        let parsedUser = null;
        if (userStr) { try { parsedUser = JSON.parse(userStr) } catch (e) { } }
        if (isExpired) return { valid: false, status: 'expired', reason: 'expired_auth_date', authDate, user: parsedUser };
        return { valid: true, status: 'verified', reason: 'ok', authDate, user: parsedUser };
      } catch (e) {
        return { valid: false, status: 'invalid', reason: 'parse_error', user: null };
      }
    }

    const tgInitData = tg?.initData || '';
    const tgAuth = parseTelegramInitData(tgInitData);
    const tgUser = tgAuth.user || tg?.initDataUnsafe?.user || null;
    const myId = tgUser ? 'u' + tgUser.id : 'guest_' + Math.random().toString(36).slice(2, 7);
    const myName = tgUser?.first_name || (tgUser?.username ? '@' + tgUser.username : 'Гость');

    /* ─── ЗАГРУЗКА / СОХРАНЕНИЕ ─── */
    function genRoomId() { return 'rm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5) }
    function getRoomId() {
      const sp = tg?.initDataUnsafe?.start_param;
      if (sp) return sp;
      const u = new URL(window.location.href);
      const rp = u.searchParams.get('room');
      if (rp) return rp;
      return null;
    }

    const ROOMS_KEY = 'delimschet_all';
    let ROOMS = null;
    try { ROOMS = JSON.parse(localStorage.getItem(ROOMS_KEY)) } catch (e) { }
    if (!ROOMS || typeof ROOMS !== 'object') ROOMS = { current: null, rooms: {}, meta: {} };
    const sharedUrlRoom = getRoomId();

    function newState(roomId, roomName) {
      const st = {
        roomId,
        roomName: roomName || 'Общая касса',
        cur: '₴', parts: [], expenses: [], polls: [], colls: [],
        del: { exp: [], poll: [], coll: [], part: [] }
      };
      if (tgUser) st.parts.push({ id: myId, name: myName, photo: tgUser.photo_url || '', tg: tgUser.id, me: true });
      return st;
    }
    function loadRoom(id) {
      if (!id) return;
      S = ROOMS.rooms[id];
      if (!S) S = newState(id, 'Общая касса');
      if (!S.roomName) S.roomName = 'Общая касса';
      if (!S.del) S.del = { exp: [], poll: [], coll: [], part: [] };
    }
    if (sharedUrlRoom) {
      if (ROOMS.rooms[sharedUrlRoom]) { ROOMS.current = sharedUrlRoom; loadRoom(sharedUrlRoom); }
      else { S = newState(sharedUrlRoom, (ROOMS.meta[sharedUrlRoom] && ROOMS.meta[sharedUrlRoom].name) || 'Общая касса'); ROOMS.current = sharedUrlRoom; ROOMS.rooms[sharedUrlRoom] = S; ROOMS.meta[sharedUrlRoom] = { name: S.roomName, date: Date.now() }; }
    } else if (ROOMS.current && ROOMS.rooms[ROOMS.current]) {
      loadRoom(ROOMS.current);
    } else {
      const ids = Object.keys(ROOMS.rooms || {});
      if (ids.length) { ROOMS.current = ids[0]; loadRoom(ids[0]); }
      else {
        let migrated = false;
        try {
          const old = JSON.parse(localStorage.getItem('delimschet_v3'));
          if (old && old.parts) {
            if (!old.roomId) old.roomId = genRoomId();
            if (!old.roomName) old.roomName = 'Касса';
            if (!old.del) old.del = { exp: [], poll: [], coll: [], part: [] };
            ROOMS.current = old.roomId;
            ROOMS.rooms[old.roomId] = old;
            ROOMS.meta[old.roomId] = { name: old.roomName, date: Date.now() };
            S = old;
            migrated = true;
          }
        } catch (e) { }
        if (!migrated) {
          const id = genRoomId();
          S = newState(id, 'Общая касса');
          ROOMS.current = id;
          ROOMS.rooms[id] = S;
          ROOMS.meta[id] = { name: 'Общая касса', date: Date.now() };
        }
      }
    }

    // Гарантированная защита от null
    if (!S || typeof S !== 'object') {
      const fallbackId = genRoomId();
      S = newState(fallbackId, 'Общая касса');
      ROOMS.current = fallbackId;
      ROOMS.rooms[fallbackId] = S;
      ROOMS.meta[fallbackId] = { name: 'Общая касса', date: Date.now() };
    }

    const firstRun = !S.parts || !S.parts.length;

    /* ─── НОРМАЛИЗАЦИЯ ─── */
    function normalize() {
      if (!S || typeof S !== 'object') return;
      if (!Array.isArray(S.parts)) S.parts = [];
      if (!Array.isArray(S.expenses)) S.expenses = [];
      if (!Array.isArray(S.polls)) S.polls = [];
      if (!Array.isArray(S.colls)) S.colls = [];
      if (!S.del || typeof S.del !== 'object') S.del = { exp: [], poll: [], coll: [], part: [] };

      if (S.parts.length && typeof S.parts[0] === 'string')
        S.parts = S.parts.map((n, i) => ({ id: 'legacy_' + (i + 1), name: n }));
      const byName = {}; S.parts.forEach(p => byName[p.name] = p.id);
      S.expenses.forEach(e => {
        if (typeof e.payer === 'string' && byName[e.payer]) e.payer = byName[e.payer];
        if (e.for && e.for.length && typeof e.for[0] === 'string') e.for = e.for.map(n => byName[n] || n).filter(id => S.parts.some(p => p.id === id));
        if (e.shares) { const ns = {}; Object.keys(e.shares).forEach(k => { const id = byName[k] || k; if (id) ns[id] = e.shares[k] }); e.shares = ns }
        if (!e.cat) e.cat = '';
      });
      S.colls.forEach(c => {
        if (c.paid) { const np = {}; Object.keys(c.paid).forEach(k => { const id = byName[k] || k; if (S.parts.some(p => p.id === id)) np[id] = true }); c.paid = np }
      });
      S.polls.forEach(p => {
        if (p.votes && Array.isArray(p.votes)) p.votes = {};
        if (!p.votes) p.votes = {};
      });
      if (tgUser && !S.parts.some(p => p.tg === tgUser.id)) {
        S.parts.unshift({ id: myId, name: myName, photo: tgUser.photo_url || '', tg: tgUser.id, me: true });
      }
      S.parts.forEach(p => {
        if (tgUser && tgUser.id && p.tg) {
          p.me = (p.tg === tgUser.id);
        } else {
          p.me = (p.id === myId);
        }
      });
      if (!S.del) S.del = { exp: [], poll: [], coll: [], part: [] };
      S.parts.forEach(p => p.id = String(p.id));
      S.expenses.forEach(e => e.id = String(e.id));
      S.polls.forEach(p => p.id = String(p.id));
      S.colls.forEach(c => c.id = String(c.id));
    }
    function nid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }
    normalize();
    if (firstRun && !tgUser && !S.parts.length) {
      S.parts = [{ id: 'a', name: 'Олег' }, { id: 'b', name: 'Ирина' }, { id: 'c', name: 'Андрей' }];
    }

    /* ─── SUPABASE ─── */
    function save() {
      ROOMS.rooms[S.roomId] = S;
      ROOMS.current = S.roomId;
      try { localStorage.setItem(ROOMS_KEY, JSON.stringify(ROOMS)) } catch (e) { }
      try { localStorage.removeItem('delimschet_v3') } catch (e) { }
      rememberPeople();
      const tag = $('room-tag'); if (tag) tag.textContent = '🚪 ' + (S.roomName || 'Общая касса');
      const rn = $('room-name'); if (rn) rn.textContent = S.roomName || 'Общая касса';
      const br = $('bind-room-id'); if (br) br.textContent = S.roomId;
    }
    const PEOPLE_KEY = 'delimschet_people';
    function rememberPeople() {
      try {
        let pool = JSON.parse(localStorage.getItem(PEOPLE_KEY) || '[]');
        S.parts.forEach(p => {
          if (p.tg || p.me) return;
          const nm = (p.name || '').trim();
          if (!nm) return;
          if (!pool.some(x => x.name === nm)) pool.push({ name: nm, photo: p.photo || '' });
        });
        pool = pool.slice(-30);
        localStorage.setItem(PEOPLE_KEY, JSON.stringify(pool));
      } catch (e) { }
    }
    function renderQuickAdd() {
      const box = $('quick-add'); if (!box) return;
      let pool = []; try { pool = JSON.parse(localStorage.getItem(PEOPLE_KEY) || '[]') } catch (e) { }
      const existing = new Set(S.parts.map(p => (p.name || '').trim().toLowerCase()));
      pool = pool.filter(x => !existing.has((x.name || '').trim().toLowerCase())).slice(0, 6);
      if (!pool.length) { box.style.display = 'none'; return; }
      box.style.display = 'block';
      box.innerHTML = '<div class="qa-label">Частые участники:</div>' +
        '<div class="qa-row">' + pool.map(p => `<span class="qa-chip" onclick="quickAddPart(${JSON.stringify(p.name)})">+ ${esc(p.name)}</span>`).join('') + '</div>';
    }
    function quickAddPart(name) {
      haptic(); name = (name || '').trim(); if (!name) return;
      if (S.parts.some(p => p.name === name)) { toast('Уже есть'); return; }
      S.parts.push({ id: nid(), name }); save(); renderAll(); ok(); toast('Участник добавлен');
      setTimeout(() => { renderQuickAdd(); $('new-part').focus() }, 50);
    }
    const SUPABASE_URL = "https://cfopzdkyljfdkjksatss.supabase.co";
    const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNmb3B6ZGt5bGpmZGtqa3NhdHNzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ5MjQ2MzcsImV4cCI6MjA4MDUwMDYzN30.yArvoJKKTC0RSTLUyxIZqLhV4nu1lW6I31vAfeWJJ38";
    let _supabase = null, _realtime = null, _pushTimer = null, _localStamp = 0;
    // Гейт первого push: до завершения первого syncPull не пушим ничего в облако,
    // иначе пустая локальная касса нового участника затрёт существующую комнату.
    let _syncReady = false, _dirtyWhileWaiting = false;
    try { if (window.supabase?.createClient) _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON) } catch (e) { console.warn('Supabase warn:', e) }
    function localStamp() { return _localStamp }
    async function syncPush() {
      if (!_supabase || !S.roomId) return;
      try {
        const st = { id: S.roomId, state: JSON.parse(JSON.stringify(S)), updated_at: new Date().toISOString() };
        await _supabase.from('rooms').upsert(st, { onConflict: 'id' });
      } catch (e) { }
    }
    async function syncPull() {
      if (!_supabase || !S.roomId) { _syncReady = true; return; }
      try {
        const { data } = await _supabase.from('rooms').select('state,updated_at').eq('id', S.roomId).single();
        if (data && data.state) {
          const ts = data.updated_at ? new Date(data.updated_at).getTime() : 0;
          if (ts > localStamp()) { applyRemote(data.state, ts); toast('🔄 Данные из облака') }
        } else { await syncPush() }
      } catch (e) { }
      // Первый pull завершён: разблокируем авто-push. Если за время ожидания
      // были локальные изменения — отправляем их сейчас.
      _syncReady = true;
      if (_dirtyWhileWaiting) { _dirtyWhileWaiting = false; if (_pushTimer) clearTimeout(_pushTimer); _pushTimer = setTimeout(syncPush, 300) }
    }
    function applyRemote(st, ts) {
      const a = document.activeElement;
      if (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT')) {
        setTimeout(() => applyRemote(st, ts), 3000);
        return;
      }
      const prev = JSON.stringify(S);
      S = mergeState(S, st);
      normalize();
      // Серверное время события (commit_timestamp) — источник истины. Локальные часы
      // для сравнений не используем: при рассинхроне чужие апдейты терялись.
      if (ts && ts > _localStamp) _localStamp = ts;
      const changed = JSON.stringify(S) !== prev;
      _saveOrig();
      if (changed) { renderAll(); toast('🔄 Данные из облака') }
      else { renderAll(); }
    }
    /* ─── УПРАВЛЕНИЕ КОМНАТАМИ ─── */
    function switchRoom(id) {
      if (!ROOMS.rooms[id]) return;
      if (_realtime) { try { _realtime.unsubscribe() } catch (e) { } _realtime = null; }
      ROOMS.current = id; loadRoom(id); filterPart = null; save(); syncPush(); subscribeRoom(); renderAll();
    }
    function selectRoom(id) {
      if (!ROOMS.rooms[id]) return;
      const ov = $('rooms-overlay');
      const wasOpen = ov && ov.style.display !== 'none';
      if (id === S.roomId) { if (wasOpen) ov.style.display = 'none'; return; }
      switchRoom(id);
      // Обновить подсветку активной кассы прямо в открытом списке
      document.querySelectorAll('#rooms-list .room-item').forEach(el => {
        const on = el.dataset.id === id;
        el.classList.toggle('on', on);
        const dot = el.querySelector('.room-dot');
        if (dot) dot.classList.toggle('live', on);
      });
      // Небольшая пауза, чтобы глаз увидел переход подсветки, затем закрываем
      if (wasOpen) setTimeout(() => { ov.style.display = 'none' }, 300);
    }
    function createNewRoom() {
      const v = $('newroom-name').value.trim();
      if (!v) { toast('Введите название'); return; }
      const id = genRoomId();
      const st = newState(id, v);
      ROOMS.current = id; ROOMS.rooms[id] = st; ROOMS.meta[id] = { name: v, date: Date.now() };
      if (_realtime) { try { _realtime.unsubscribe() } catch (e) { } _realtime = null; }
      S = st; save(); syncPush(); subscribeRoom(); renderAll();
      $('newroom-overlay').style.display = 'none'; $('newroom-name').value = '';
      toast('Новая касса создана');
    }
    function openRooms() {
      const list = $('rooms-list');
      const all = Object.keys(ROOMS.rooms);
      const active = all.filter(id => !ROOMS.rooms[id].archived).sort((a, b) => (ROOMS.meta[b]?.date || 0) - (ROOMS.meta[a]?.date || 0));
      const arch = all.filter(id => ROOMS.rooms[id].archived).sort((a, b) => (ROOMS.meta[b]?.date || 0) - (ROOMS.meta[a]?.date || 0));
      let html = active.map(id => roomRow(id, false)).join('') || '<div class="empty">Нет активных касс</div>';
      if (arch.length) html += '<div class="qa-label" style="margin-top:14px">В архиве</div>' + arch.map(id => roomRow(id, true)).join('');
      list.innerHTML = html;
      $('rooms-overlay').style.display = 'flex';
    }
    function roomRow(id, isArch) {
      const m = ROOMS.meta[id] || {}; const cur = id === S.roomId;
      const act = isArch
        ? `<span class="room-act" onclick="event.stopPropagation();restoreRoom('${id}')">♻︎</span>`
        : `<span class="room-act" onclick="event.stopPropagation();archiveRoom('${id}')">🗄</span>`;
      return `<div class="room-item ${cur ? 'on' : ''} ${isArch ? 'arch' : ''}" data-id="${id}" onclick="selectRoom('${id}')">
    <span class="room-dot ${cur ? 'live' : ''}"></span>
    <span class="room-title">${esc(m.name || 'Общая касса')}</span>
    <span class="room-id">${esc(id.slice(0, 8))}…</span>
    ${act}</div>`;
    }
    function archiveRoom(id) {
      if (!ROOMS.rooms[id]) return;
      confirmBox('Закрыть кассу в архив? Изменения будут заморожены.', () => {
        ROOMS.rooms[id].archived = true;
        localStorage.setItem(ROOMS_KEY, JSON.stringify(ROOMS));
        toast('Касса в архиве');
        if (id === S.roomId) { const nxt = Object.keys(ROOMS.rooms).find(x => !ROOMS.rooms[x].archived); if (nxt) { switchRoom(nxt) } else { const nid2 = genRoomId(); const st = newState(nid2, 'Общая касса'); ROOMS.current = nid2; ROOMS.rooms[nid2] = st; ROOMS.meta[nid2] = { name: 'Общая касса', date: Date.now() }; S = st; save(); renderAll() } }
        $('rooms-overlay').style.display = 'none';
      });
    }
    function restoreRoom(id) {
      if (!ROOMS.rooms[id]) return;
      ROOMS.rooms[id].archived = false;
      localStorage.setItem(ROOMS_KEY, JSON.stringify(ROOMS));
      toast('Касса восстановлена');
      openRooms();
    }
    function renameRoomNow() {
      const v = $('rename-room-input').value.trim();
      if (!v) { toast('Введите название'); return; }
      S.roomName = v; ROOMS.meta[S.roomId] = { name: v, date: ROOMS.meta[S.roomId]?.date || Date.now() };
      save(); renderAll(); $('room-name').textContent = v; $('rename-room-overlay').style.display = 'none';
      toast('Название изменено');
    }
    function openNewRoom() { $('rooms-overlay').style.display = 'none'; $('newroom-name').value = ''; $('newroom-overlay').style.display = 'flex'; setTimeout(() => $('newroom-name').focus(), 100) }
    function openRenameRoom() { haptic(); const el = $('rename-room-input'); if (el) el.value = S.roomName || ''; $('rename-room-overlay').style.display = 'flex'; setTimeout(() => el && el.focus(), 100) }
    function mergeState(a, b) {
      const r = JSON.parse(JSON.stringify(a));
      if (!r.del) r.del = { exp: [], poll: [], coll: [], part: [] };
      const bd = b.del || {};
      ['exp', 'poll', 'coll', 'part'].forEach(k => {
        (bd[k] || []).forEach(id => { if (!r.del[k].includes(id)) r.del[k].push(id) });
        if (r.del[k].length > 500) r.del[k] = r.del[k].slice(-500);
      });
      function union(aa, bb, delArr) {
        const map = {};
        // 1. Сначала загружаем данные с сервера (remote)
        (bb || []).forEach(x => { map[x.id] = JSON.parse(JSON.stringify(x)) });
        // 2. Накатываем локальные данные поверх (local wins, чтобы не затереть то, что мы вводим прямо сейчас)
        aa.forEach(x => { map[x.id] = Object.assign(map[x.id] || {}, x) });
        // 3. Возвращаем как массив без удаленных
        return Object.values(map).filter(x => !delArr.includes(x.id));
      }
      r.parts = union(a.parts, b.parts || [], r.del.part);
      r.expenses = union(a.expenses, b.expenses || [], r.del.exp);
      r.polls = (function () {
        const map = {}; a.polls.forEach(p => map[p.id] = JSON.parse(JSON.stringify(p)));
        (b.polls || []).forEach(bp => {
          if (map[bp.id]) {
            const p = map[bp.id];
            if (bp.votes && typeof bp.votes === 'object' && !Array.isArray(bp.votes)) {
              if (!p.votes || Array.isArray(p.votes)) p.votes = {};
              Object.keys(bp.votes).forEach(k => {
                if (k === myId) { if (p.votes[k] === undefined) p.votes[k] = bp.votes[k] }
                else p.votes[k] = bp.votes[k];
              });
            }
          } else {
            map[bp.id] = JSON.parse(JSON.stringify(bp));
          }
        });
        return Object.values(map).filter(p => !r.del.poll.includes(p.id));
      })();
      r.colls = (function () {
        const map = {}; a.colls.forEach(c => map[c.id] = JSON.parse(JSON.stringify(c)));
        (b.colls || []).forEach(bc => {
          if (map[bc.id]) {
            const c = map[bc.id];
            if (bc.paid) Object.keys(bc.paid).forEach(k => { c.paid[k] = true });
          } else {
            map[bc.id] = JSON.parse(JSON.stringify(bc));
          }
        });
        return Object.values(map).filter(c => !r.del.coll.includes(c.id));
      })();
      r.cur = a.cur;
      r.roomId = a.roomId;
      return r;
    }
    function subscribeRoom() {
      if (!_supabase || !S.roomId || _realtime) return;
      _realtime = _supabase.channel('room:' + S.roomId)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: 'id=eq.' + S.roomId }, p => {
          if (p.new && p.new.state) {
            // commit_timestamp — серверное время транзакции (источник истины, не локальные часы)
            const ts = (p.commit_timestamp ? new Date(p.commit_timestamp).getTime() : 0) ||
              (p.new.updated_at ? new Date(p.new.updated_at).getTime() : 0);
            if (ts > localStamp()) applyRemote(p.new.state, ts)
          }
        }).subscribe();
    }
    const _saveOrig = save;
    save = function () {
      _saveOrig();
      if (!_syncReady) { _dirtyWhileWaiting = true; return; }
      if (_pushTimer) clearTimeout(_pushTimer); _pushTimer = setTimeout(syncPush, 700)
    };

    /* ─── СОБЫТИЯ ДЛЯ БОТА ─── */
    async function logEvent(text) {
      if (!_supabase) return;
      try { await _supabase.from('events').insert({ room_id: S.roomId, text }) } catch (e) { }
    }

    /* ─── ВАЛЮТА ─── */
    function showCurPicker() {
      const grid = $('cur-grid'); grid.innerHTML = CURS.map(c => `<span class="chip ${c === S.cur ? 'gold' : 'on'}" onclick="pickCur('${c}')">${c}</span>`).join('');
      $('cur-overlay').style.display = 'flex';
    }
    function pickCur(c) { haptic(); S.cur = c; $('cur-chip').textContent = c; save(); closeCurPicker(); renderAll() }
    function closeCurPicker() { $('cur-overlay').style.display = 'none' }

    function fmt(n) { return (Math.round(n * 100) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ' + S.cur }
    function haptic() { try { tg?.HapticFeedback?.impactOccurred?.('light') } catch (e) { } }
    function ok() { try { tg?.HapticFeedback?.notificationOccurred?.('success') } catch (e) { } }
    function toast(t) { $('tt').textContent = t; const el = $('toast'); el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 2200) }
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet() });
    document.addEventListener('DOMContentLoaded', () => {
      safeDrawIcons();
      if (firstRun) showCurPicker();
      if (tgAuth.status === 'expired') setTimeout(() => toast('⚠️ Сессия Telegram устарела'), 1200);
      // Резервные слушатели для режима опросов
      const bp = $('mode-plain'), bf = $('mode-fund');
      if (bp) bp.addEventListener('click', () => setPMode('plain'));
      if (bf) bf.addEventListener('click', () => setPMode('fund'));
    });
    function go(t, el) {
      haptic(); window.scrollTo(0, 0); document.querySelectorAll('.tab').forEach(x => x.classList.remove('active')); $('tab-' + t).classList.add('active'); document.querySelectorAll('.nav').forEach(x => x.classList.remove('on')); el.classList.add('on');
      const fab = document.querySelector('.fab'); if (fab) fab.style.display = (t === 'spend') ? 'flex' : 'none'
    }

    /* ─── КОМНАТА / ПРИГЛАШЕНИЕ ─── */
    const BOT_USERNAME = "delimschet_bot"
    const APP_SHORT_NAME = "app"
    function getDeepLink() { return `https://t.me/${BOT_USERNAME}/${APP_SHORT_NAME}?startapp=${encodeURIComponent(S.roomId)}` }
    function inviteRoom() {
      haptic(); const url = getDeepLink(); const msg = '💰 Присоединяйся к «Делим Счёт»! Комната: ' + S.roomId;
      if (IS_TG && tg && typeof tg.openTelegramLink === 'function') { try { tg.openTelegramLink('https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(msg)); ok() } catch (e) { navigator.clipboard?.writeText(url + '\n' + msg); toast('Ссылка скопирована') } }
      else { navigator.clipboard?.writeText(url + '\n' + msg); toast('Ссылка скопирована') }
    }
    function copyRoomId() { haptic(); navigator.clipboard?.writeText(getDeepLink()); toast('Ссылка скопирована') }
    function getRoomUrl() { return getDeepLink() }

    /* ─── УЧАСТНИКИ ─── */
    function pName(id) { const p = S.parts.find(x => x.id === id); return p ? p.name : id }
    function pMe(id) { return id === myId }
    function renderParts() {
      const cnt = $('parts-count'); if (cnt) cnt.textContent = '(' + S.parts.length + ')';
      // Компактная полоска участников (сторис): кольцо = фильтр ленты, имя = профиль
      $('parts').innerHTML = S.parts.length
        ? S.parts.map(p => `<div class="ps-item ${p.me ? 'me' : ''} ${filterPart === p.id ? 'fil' : ''}" title="Тап по кружку — фильтр чеков; по имени — профиль">
    <span class="ring" onclick="togglePartFilter('${p.id}')"><span class="inner">${p.photo ? `<img src="${esc(p.photo)}" referrerpolicy="no-referrer" onerror="this.style.display='none'">` : `<span class="av-init">${esc((p.name || '?').trim()[0] || '?')}</span>`}</span>${filterPart === p.id ? '<span class="fil-badge">✓</span>' : ''}</span>
    <span class="nm" onclick="openPartProfile('${p.id}')">${esc(p.name)}</span>${p.me ? '<span class="you-tag">вы</span>' : ''}</div>`).join('')
        : '';
      const partsBox = $('parts');
      if (partsBox) partsBox.insertAdjacentHTML('beforeend', `<button type="button" class="ps-add" onclick="openAddPart()" title="Добавить участника"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg></button>`);
      // Чипы плательщика вместо <select>
      const pc = $('e-payer-chips');
      if (pc) {
        pc.innerHTML = S.parts.map(p => `<span class="person ${p.id === payerId ? 'on' : ''}" data-i="${p.id}" onclick="pickPayer('${p.id}',this)">${p.photo ? `<img class="av" src="${esc(p.photo)}" referrerpolicy="no-referrer" onerror="this.style.display='none'">` : `<span class="av-init">${esc((p.name || '?').trim()[0] || '?')}</span>`} ${esc(p.name)}${p.me ? ' (вы)' : ''}</span>`).join('');
        if (!S.parts.some(p => p.id === payerId)) pickPayer(S.parts[0] ? S.parts[0].id : '', null);
      }
      $('e-for').innerHTML = S.parts.map(p => `<span class="person on" data-i="${p.id}" onclick="toggleFor(this,'${p.id}')">${esc(p.name)}</span>`).join('');
      renderShareInputs();
    }
    function togglePartFilter(id) {
      haptic();
      filterPart = (filterPart === id) ? null : id;
      renderParts();
      renderExp();
    }
    function pickPayer(id, el) {
      haptic(); payerId = id;
      if (el) { [...$('e-payer-chips').children].forEach(c => c.classList.remove('on')); el.classList.add('on') }
    }
    function openAddPart() {
      $('new-part').value = ''; renderQuickAdd(); $('addpart-overlay').style.display = 'flex';
      setTimeout(() => $('new-part').focus(), 100);
    }
    function addPart() { const v = $('new-part').value.trim(); if (!v) return; if (S.parts.some(p => p.name === v)) { toast('Уже есть'); return } S.parts.push({ id: nid(), name: v }); $('new-part').value = ''; save(); renderAll(); ok(); toast('Участник добавлен'); $('new-part').focus(); }
    function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
    function delPart(id) {
      haptic();
      if (pMe(id)) { toast('Это вы — себя нельзя удалить'); return }

      // 1. ПРОВЕРКА НА ЗАВИСИМОСТИ (Участвует ли человек в деньгах?)
      const involvedInExp = S.expenses.some(e => {
        if (e.settled) return false; // складчина: не завязана на конкретных людей и не влияет на долги
        if (e.payer === id) return true;
        const f = e.for || [];
        if (f.includes(id)) return true;
        // Трата «на всех поровну» (for пуст) завязана на КАЖДОГО участника:
        // удаление любого пересчитает прошлые долги на оставшихся.
        if (!f.length) return true;
        if (e.shares && e.shares[id] !== undefined) return true;
        return false;
      });
      const involvedInColl = S.colls.some(c => c.paid && c.paid[id]);

      if (involvedInExp || involvedInColl) {
        const msg = "Нельзя удалить участника, который задействован в тратах или сборах. Сначала удалите связанные с ним чеки.";
        if (IS_TG && tg && typeof tg.showAlert === 'function') { try { tg.showAlert(msg) } catch (e) { alert(msg) } }
        else alert(msg);
        return;
      }

      // 2. БЕЗОПАСНОЕ УДАЛЕНИЕ
      confirmBox('Удалить участника из комнаты?', () => {
        S.del.part.push(id); S.parts = S.parts.filter(p => p.id !== id); save(); renderAll(); toast('Участник удалён')
      });
    }
    function toggleFor(el, i) { el.classList.toggle('on'); haptic(); if (splitMode === 'custom') renderShareInputs() }
    function forPick(mode) {
      haptic();
      const chips = [...$('e-for').querySelectorAll('.person')];
      if (mode === 'all') chips.forEach(c => c.classList.add('on'));
      else if (mode === 'none') chips.forEach(c => c.classList.remove('on'));
      else if (mode === 'me') {
        const mePart = S.parts.find(p => p.me) || S.parts.find(p => p.id === myId);
        const mid = mePart ? mePart.id : '';
        chips.forEach(c => c.classList.toggle('on', c.dataset.i === mid));
      }
      if (splitMode === 'custom') renderShareInputs();
    }
    function forSel() { const sel = [...$('e-for').querySelectorAll('.person.on')].map(x => x.dataset.i); return sel.length === S.parts.length ? [] : sel }

    /* ─── КАТЕГОРИИ ─── */
    function pickCat(el, c) { haptic(); document.querySelectorAll('#cat-grid .cat-chip').forEach(x => x.classList.remove('on')); el.classList.add('on'); curCat = c }

    /* ─── НЕРАВНЫЙ ДЕЛЁЖ ─── */
    function setSplitMode(m) { haptic(); splitMode = m; $('mode-eq').classList.toggle('on', m === 'equal'); $('mode-cs').classList.toggle('on', m === 'custom'); $('split-custom').style.display = m === 'custom' ? 'block' : 'none'; if (m === 'custom') renderShareInputs() }
    function onAmtChange() { if (splitMode === 'custom') renderShareInputs() }
    function renderShareInputs() {
      const box = $('share-inputs'), amt = parseNum($('e-amt').value);
      const ids = forSel(); const parts = ids.length ? ids.filter(id => S.parts.some(p => p.id === id)) : S.parts.map(p => p.id);
      if (!parts.length || splitMode !== 'custom') { box.innerHTML = ''; return }
      const n = parts.length; const def = Math.round(amt / n * 100) / 100; const rem = Math.round((amt - def * (n - 1)) * 100) / 100;
      box.innerHTML = parts.map((id, i) => {
        const v = i < n - 1 ? def : rem;
        return `<div class="split-row"><span class="slbl">${esc(pName(id))}</span><input type="number" inputmode="decimal" class="sinput" value="${v.toFixed(2)}" min="0" step="0.01" oninput="onShareChange()" data-idx="${i}"></div>`
      }).join(''); updateShareSum()
    }
    function onShareChange() { haptic(); updateShareSum() }
    function updateShareSum() {
      const ins = [...$('share-inputs').querySelectorAll('.sinput')]; const sum = ins.reduce((a, i) => a + parseFloat(i.value || 0), 0);
      const t = parseFloat($('e-amt').value) || 0; const r = Math.round((t - sum) * 100) / 100;
      $('share-sum').innerHTML = 'Остаток: <span style="color:' + (Math.abs(r) < 0.01 ? 'var(--green)' : 'var(--gold)') + '">' + Math.abs(r).toFixed(2) + '</span>'
    }
    function getShares() {
      if (splitMode === 'equal') return null;
      const ins = [...$('share-inputs').querySelectorAll('.sinput')]; const ids = forSel(); const parts = ids.length ? ids.filter(id => S.parts.some(p => p.id === id)) : S.parts.map(p => p.id);
      const sh = {}; ins.forEach((inp, i) => { if (i < parts.length) sh[parts[i]] = parseFloat(inp.value) || 0 }); return sh
    }

    /* ─── ТРАТЫ ─── */
    function addExpense() {
      evalAmtInput($('e-amt'));
      const desc = $('e-desc').value.trim(), amt = parseNum($('e-amt').value);
      let payer = payerId;
      if (!desc) { toast('⚠️ Введите описание траты'); $('e-desc').focus(); return false }
      if (!amt || amt <= 0) { toast('⚠️ Введите сумму больше 0'); $('e-amt').focus(); return false }
      if (!S.parts.length) { toast('⚠️ Добавьте хотя бы одного участника'); return false }
      if (!payer || !S.parts.some(p => p.id === payer)) {
        payer = S.parts[0].id; payerId = payer;
        const pc = $('e-payer-chips');
        if (pc) { [...pc.children].forEach(c => c.classList.toggle('on', c.dataset.i === payer)) }
      }
      const shares = getShares();
      if (splitMode === 'custom') { const s = Object.values(shares).reduce((a, b) => a + b, 0); if (Math.abs(s - amt) > 0.01) { toast('Сумма долей ≠ общей сумме'); return false } }
      const forIds = forSel();
      if (editExpId) {
        const ex = S.expenses.find(x => x.id === editExpId);
        if (ex) {
          ex.desc = desc; ex.amt = amt; ex.payer = payer; ex.for = forIds; ex.split = splitMode; ex.shares = shares; ex.cat = curCat;
        }
        editExpId = null;
        save(); renderAll(); ok();
        logEvent('✏️ Трата обновлена: «' + desc + '» — ' + fmt(amt));
        toast('Трата обновлена');
        return true;
      }
      S.expenses.push({ id: nid(), desc, amt, payer, for: forIds, split: splitMode, shares, cat: curCat, ts: Date.now() });
      $('e-desc').value = ''; $('e-amt').value = ''; curCat = '';
      save(); renderAll(); ok();
      logEvent('💸 ' + pName(payer) + ' добавил(а): «' + desc + '» — ' + fmt(amt));
      toast('Трата добавлена');
      return true;
    }
    function delExp(id) {
      haptic();
      confirmBox('Удалить эту трату? Это изменит долги всех участников.', () => {
        S.del.exp.push(id); S.expenses = S.expenses.filter(e => e.id !== id); save(); renderAll(); toast('Трата удалена')
      });
    }
    /* ─── ГРУППИРОВКА ПО ДАТАМ ─── */
    const _MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    function dayKey(ts) {
      const d = new Date(ts || 0), n = new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    function dayLabel(key) {
      const d = new Date(key + 'T12:00:00');
      const today = dayKey(Date.now()), yest = dayKey(Date.now() - 86400000);
      if (key === today) return 'Сегодня';
      if (key === yest) return 'Вчера';
      const sameYear = d.getFullYear() === new Date().getFullYear();
      return d.getDate() + ' ' + _MONTHS[d.getMonth()] + (sameYear ? '' : ' ' + d.getFullYear());
    }
    function expInFilter(e) {
      if (!filterPart) return true;
      if (e.settled) return false; // складчины не привязаны к конкретному участнику
      if (e.payer === filterPart) return true;
      const f = e.for || [];
      if (f.length && f.includes(filterPart)) return true;
      if (!f.length) return true; // «на всех» — участник в их числе
      return false;
    }
    function renderExp() {
      const box = $('exp-list');
      const visible = S.expenses.filter(expInFilter);
      const tot = visible.reduce((a, e) => a + (e.settled ? 0 : e.amt), 0);
      $('spent-total').textContent = fmt(tot);
      const fName = filterPart ? pName(filterPart) : '';
      if (!S.expenses.length) { box.innerHTML = `<div class="empty-state"><i data-lucide="receipt"></i><div class="msg">Вы ещё ничего не потратили.<br>Добавьте первый чек!</div><button class="btn ghost" onclick="openSheet()">+ Добавить трату</button></div>`; return }
      if (filterPart && !visible.length) {
        box.innerHTML = `<div class="empty-state" style="padding:22px 14px"><i data-lucide="search-x"></i><div class="msg">У ${esc(fName)} пока нет чеков</div><button class="btn ghost" onclick="togglePartFilter('${filterPart}')">✕ Показать все</button></div>`;
        safeDrawIcons();
        return;
      }
      let head = '';
      if (filterPart) head = `<div class="filter-chip" onclick="togglePartFilter('${filterPart}')">🔍 ${esc(fName)} <span style="opacity:.6">✕</span></div>`;
      // Сортируем: свежие сверху; без даты (старые данные) — в конец
      const sorted = [...visible].sort((a, b) => ((b.ts || 0) - (a.ts || 0)));
      const groups = [];
      sorted.forEach(e => {
        const k = e.ts ? dayKey(e.ts) : '____';
        let g = groups.find(x => x.k === k);
        if (!g) { g = { k, label: e.ts ? dayLabel(k) : 'Ранее', items: [] }; groups.push(g); }
        g.items.push(e);
      });
      box.innerHTML = head + groups.map(g => {
        const rows = g.items.map(e => {
          if (e.settled) {
            return `<div class="exp-item">${e.cat ? `<span class="cat">${e.cat}</span>` : ''}<div class="txt" onclick="viewExp('${e.id}')"><div class="t">${esc(e.desc)}</div><div class="m">🤝 складчина · все внесли</div></div><div class="amt">${fmt(e.amt)}</div>
      <button class="icobtn" onclick="delExp('${e.id}')"><i data-lucide="trash-2" style="width:16px;height:16px"></i></button></div>`;
          }
          const scope = e.for.length ? e.for.map(id => pName(id)).join(', ') : 'все';
          const ml = e.split === 'custom' ? '🎯 доли' : '⚖️ поровну';
          return `<div class="exp-item">${e.cat ? `<span class="cat">${e.cat}</span>` : ''}<div class="txt" onclick="viewExp('${e.id}')"><div class="t">${esc(e.desc)}</div><div class="m">${esc(pName(e.payer))} · ${scope} · ${ml}</div></div><div class="amt">${fmt(e.amt)}</div>
      <button class="icobtn" onclick="delExp('${e.id}')"><i data-lucide="trash-2" style="width:16px;height:16px"></i></button></div>`;
        }).join('');
        return `<div class="day-hdr">${esc(g.label)}</div>` + rows;
      }).join('');
      safeDrawIcons();
    }
    /* ─── ПРОСМОТР / РЕДАКТИРОВАНИЕ ЧЕКА ─── */
    let _viewExpId = null;
    function shareOf(e, id) {
      // доля конкретного участника в трате (копеечная арифметика как в calcBalances)
      if (e.split === 'custom' && e.shares) return +e.shares[id] || 0;
      const ids = (e.for && e.for.length) ? e.for.filter(x => S.parts.some(p => p.id === x)) : S.parts.map(p => p.id);
      const n = ids.length; if (!n) return 0;
      const totalCents = Math.round((+e.amt || 0) * 100);
      const base = Math.floor(totalCents / n), rem = totalCents - base * n;
      const idx = ids.indexOf(id);
      return (base + (idx >= 0 && idx < rem ? 1 : 0)) / 100;
    }
    function involvedIds(e) {
      if (e.settled) return [];
      if (e.for && e.for.length) return e.for.filter(id => S.parts.some(p => p.id === id));
      return S.parts.map(p => p.id);
    }
    function viewExp(id) {
      haptic(); const e = S.expenses.find(x => x.id === id); if (!e) return;
      _viewExpId = id;
      $('view-cat').textContent = e.cat || '🧾';
      $('view-title').textContent = e.desc;
      $('view-amt').textContent = fmt(e.amt);
      const dateTxt = e.ts ? dayLabel(dayKey(e.ts)) + ', ' + new Date(e.ts).getHours().toString().padStart(2, '0') + ':' + new Date(e.ts).getMinutes().toString().padStart(2, '0') : 'Дата неизвестна';
      $('view-date').textContent = dateTxt;
      const body = $('view-body');
      let html = '';
      if (e.settled) {
        html = `<div class="det-row"><div class="l">🤝 Складчина</div><div class="r">все внесли поровну</div></div>`;
      } else {
        html += `<div class="det-row"><div class="l">👤 Оплатил</div><div class="r" style="color:var(--txt)">${esc(pName(e.payer))}</div></div>`;
        const ids = involvedIds(e);
        html += `<div style="margin-top:10px;font-size:.72rem;font-weight:700;color:var(--hint);text-transform:uppercase;letter-spacing:.4px">${e.for && e.for.length ? 'Для кого (' + ids.length + ')' : 'Для всех поровну (' + ids.length + ')'}</div>`;
        html += ids.map(id => `<div class="det-row"><div class="l"><span class="av-init" style="width:22px;height:22px;font-size:.62rem;display:inline-flex;align-items:center;justify-content:center">${esc((pName(id) || '?')[0])}</span> ${esc(pName(id))}${id === myId ? ' <span style="color:var(--btn);font-size:.7rem">(вы)</span>' : ''}</div><div class="r">${fmt(shareOf(e, id))}</div></div>`).join('');
      }
      body.innerHTML = html;
      const vs = $('exp-view-sheet'); if (vs) vs.classList.add('on');
      const bd = $('sheet-backdrop'); if (bd) bd.classList.add('on');
      safeDrawIcons();
    }
    function closeViewSheet() {
      const vs = $('exp-view-sheet'); if (vs) vs.classList.remove('on');
      const bd = $('sheet-backdrop'); if (bd) bd.classList.remove('on');
    }
    function editFromView() {
      const e = S.expenses.find(x => x.id === _viewExpId); if (!e) return;
      closeViewSheet();
      if (e.settled) { toast('Складчину нельзя изменить — удалите и создайте заново'); return }
      openSheet('expense', e);
    }
    function delFromView() {
      const id = _viewExpId; if (!id) return;
      closeViewSheet();
      delExp(id);
    }

    /* ─── ДОЛГИ ─── */
    function calcBalances() {
      const balCents = {};
      S.parts.forEach(p => balCents[p.id] = 0);
      S.expenses.forEach(e => {
        if (e.settled) return; // складчина: все уже внесли свои доли — балансы не трогаем
        if (!(e.payer in balCents)) return;
        const ids = e.for.length ? e.for.filter(id => id in balCents) : S.parts.map(p => p.id);
        if (!ids.length) return;
        const totalCents = Math.round((+e.amt || 0) * 100);
        balCents[e.payer] += totalCents;

        if (e.split === 'custom' && e.shares) {
          let customSum = 0;
          ids.forEach(id => {
            const s = Math.round((+e.shares[id] || 0) * 100);
            balCents[id] -= s;
            customSum += s;
          });
          // Балансировка округления ручных долей
          const rem = totalCents - customSum;
          if (rem !== 0 && e.payer in balCents) {
            balCents[e.payer] -= rem;
          }
        } else {
          const n = ids.length;
          const baseShare = Math.floor(totalCents / n);
          const rem = totalCents - (baseShare * n); // Неделимый остаток копеек (0 <= rem < n)
          ids.forEach((id, idx) => {
            // Первые rem участников берут по +1 копейке, чтобы сумма долей строго сходилась
            const share = baseShare + (idx < rem ? 1 : 0);
            balCents[id] -= share;
          });
        }
      });

      const bal = {};
      for (const id in balCents) {
        bal[id] = balCents[id] / 100;
      }
      return bal;
    }
    function renderMySummary() {
      const box = $('my-summary'); if (!box) return;
      if (!S.expenses.length) { box.innerHTML = '<div class="empty" style="padding:4px 0">Пока нет трат</div>'; return; }
      const b = calcBalances();
      const paid = S.expenses.filter(e => e.payer === myId).reduce((s, e) => s + (+e.amt || 0), 0);
      const mine = (b[myId] || 0);
      const sign = mine >= 0 ? '+' : '';
      box.innerHTML = `
    <div class="ms-item"><div class="ms-v">${fmt(paid)}</div><div class="ms-l">Оплатил за всех</div></div>
    <div class="ms-item"><div class="ms-v">${fmt(Math.max(0, mine))}</div><div class="ms-l">Моя доля</div></div>
    <div class="ms-item"><div class="ms-v" style="color:${mine >= 0 ? 'var(--green)' : 'var(--red)'}">${sign}${fmt(mine)}</div><div class="ms-l">${mine >= 0 ? 'вам должны' : 'вы должны'}</div></div>`;
    }
    function renderBalances() {
      const b = calcBalances();
      $('balances').innerHTML = S.parts.map(p => {
        const v = b[p.id] || 0; const cls = v >= 0 ? 'pos' : 'neg';
        return `<div class="bal"><span style="width:74px;font-weight:600;font-size:.82rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}${p.me ? ' · вы' : ''}</span>
      <div class="bar2 ${cls}"><div style="width:${Math.max(3, Math.abs(v) / 50 * 100)}%"></div></div>
      <span style="width:104px;text-align:right;font-weight:800;color:${v >= 0 ? 'var(--green)' : 'var(--red)'}">${v >= 0 ? '+' : ''}${fmt(v)}</span></div>`
      }).join('')
    }
    function settle() {
      const bal = calcBalances();
      const neg = S.parts
        .map(p => ({ p: p.id, cents: Math.round(-(bal[p.id] || 0) * 100) }))
        .filter(x => x.cents > 0)
        .sort((a, b) => b.cents - a.cents);
      const pos = S.parts
        .map(p => ({ p: p.id, cents: Math.round((bal[p.id] || 0) * 100) }))
        .filter(x => x.cents > 0)
        .sort((a, b) => b.cents - a.cents);

      const out = [];
      while (neg.length && pos.length) {
        const dCents = Math.min(neg[0].cents, pos[0].cents);
        if (dCents > 0) {
          out.push({ from: neg[0].p, to: pos[0].p, amt: dCents / 100 });
        }
        neg[0].cents -= dCents;
        pos[0].cents -= dCents;
        if (neg[0].cents <= 0) neg.shift();
        if (pos[0].cents <= 0) pos.shift();
      }
      return out;
    }
    function renderTransfers() {
      const t = settle(); const box = $('transfers');
      if (!S.expenses.length) { box.innerHTML = '<div class="empty">Добавьте траты.</div>'; return }
      if (!t.length) { box.innerHTML = '<div class="empty" style="color:var(--green)">✅ Все в расчёте</div>'; return }
      box.innerHTML = t.map(x => {
        const isMe = x.from === myId || x.to === myId;
        const payBtn = S.parts.find(p => p.id === x.to)?.pay ? `<button class="icobtn" style="color:var(--btn)" title="Скопировать реквизиты ${esc(pName(x.to))}" onclick="copyPay('${x.to}')"><i data-lucide="credit-card" style="width:18px;height:18px"></i></button>` : '';
        return `<div class="debt-row ${isMe ? 'me' : ''}"><span style="font-weight:600">${esc(pName(x.from))}</span><span class="arrow">→</span><span style="font-weight:600">${esc(pName(x.to))}</span><span class="sum">${fmt(x.amt)}</span>
      ${payBtn}
      <button class="icobtn" style="color:var(--green)" title="Отдал(а) долг" onclick="payDebt('${x.from}','${x.to}',${x.amt})"><i data-lucide="check-circle-2" style="width:18px;height:18px"></i></button></div>`;
      }).join('')
    }
    function payDebt(fromId, toId, amt) {
      haptic();
      const cleanAmt = Math.round(parseFloat(amt) * 100) / 100;
      confirmBox(`Подтвердить: ${pName(fromId)} вернул(а) долг ${fmt(cleanAmt)} пользователю ${pName(toId)}?`, () => {
        S.expenses.push({
          id: nid(), desc: '💳 Возврат долга', amt: cleanAmt, payer: fromId, for: [toId], split: 'equal', shares: null, cat: '💳', ts: Date.now()
        });
        logEvent('💳 ' + pName(fromId) + ' вернул(а) долг ' + fmt(cleanAmt) + ' пользователю ' + pName(toId));
        save(); renderAll(); ok(); toast('Долг возвращён ✅')
      });
    }
    function copyDebts() {
      haptic(); const t = settle();
      let txt = '🧾 *«Делим Счёт» — долги*\n*Комната:* ' + S.roomId + '\n\n';
      S.expenses.forEach(e => { txt += e.settled ? `• ${e.desc}: ${fmt(e.amt)} (складчина, все внесли)\n` : `• ${e.desc}: ${fmt(e.amt)} (${pName(e.payer)})\n` });
      txt += '\n*Переводы:*\n'; if (!t.length) txt += 'Все в расчёте ✅\n'; else t.forEach(x => { txt += `• ${pName(x.from)} → ${pName(x.to)}: ${fmt(x.amt)}\n` });
      txt += '\nОткрыть: ' + getDeepLink();
      if (navigator.clipboard) navigator.clipboard.writeText(txt); ok(); toast('Долги скопированы')
    }

    /* ─── ОПРОСЫ ─── */
    function setPMode(m) {
      try { haptic() } catch (e) { }
      pMode = m;
      const mp = $('mode-plain'), mf = $('mode-fund'), fh = $('p-fundhint');
      if (mp) mp.classList.toggle('on', m === 'plain');
      if (mf) mf.classList.toggle('on', m === 'fund');
      if (fh) fh.style.display = m === 'fund' ? 'block' : 'none';
      pollOptsPriceVis();
      toast(m === 'fund' ? '💰 Режим «Сбор» включён' : '🗳️ Обычный режим включён');
    }
    function addPOpt(v = '', price = '') {
      const d = document.createElement('div'); d.style.display = 'flex'; d.style.gap = '7px'; d.style.marginBottom = '7px';
      d.innerHTML = `<input type="text" placeholder="Вариант" value="${esc(v)}" style="flex:2">
    <input type="number" inputmode="decimal" placeholder="${pMode === 'fund' ? 'Цена' : '0'}" value="${price}" min="0" step="0.01" style="flex:1;width:80px;${pMode === 'fund' ? '' : 'display:none'}">
    <button class="icobtn" style="flex:0" onclick="this.parentElement.remove()"><i data-lucide="x" style="width:15px;height:15px"></i></button>`;
      $('p-opts').appendChild(d); safeDrawIcons();
    }
    function pollOptsPriceVis() { document.querySelectorAll('#p-opts > div').forEach(d => { const t = d.querySelector('input[type=text]'); const n = d.querySelector('input[type=number]'); if (n) { n.style.display = pMode === 'fund' ? '' : 'none'; n.placeholder = pMode === 'fund' ? 'Цена' : '0' } }) }

    // Сброс режима опроса при входе на вкладку
    const _goOrig = go;
    go = function (t, el) { _goOrig(t, el); if (t === 'poll') { pMode = 'plain'; $('mode-plain').classList.add('on'); $('mode-fund').classList.remove('on'); const fh = $('p-fundhint'); if (fh) fh.style.display = 'none'; pollOptsPriceVis(); initPollOpts() } };
    function initPollOpts() { const box = $('p-opts'); if (box && !box.children.length) { addPOpt(); addPOpt() } }
    function createPoll() {
      const q = $('p-q').value.trim();
      const rows = [...$('p-opts').children].map(r => { const t = r.querySelector('input[type=text]').value.trim(); const pr = parseFloat(r.querySelector('input[type=number]').value) || 0; return { t, pr } }).filter(x => x.t);
      if (!q || rows.length < 2) { toast('Введите вопрос и минимум 2 варианта'); return }
      if (pMode === 'fund' && rows.some(r => !r.pr)) { toast('Укажите цену для каждого варианта'); return }
      S.polls.unshift({ id: nid(), q, mode: pMode, votes: {}, opts: rows });
      $('p-q').value = ''; $('p-opts').innerHTML = ''; addPOpt(); addPOpt(); save(); renderAll(); ok(); toast('Опрос создан')
    }
    function pollVoteCounts(p) {
      const counts = (p.opts || []).map(() => 0);
      if (p.votes && !Array.isArray(p.votes)) Object.values(p.votes).forEach(i => { if (counts[i] !== undefined) counts[i]++ });
      return counts
    }
    function votePoll(id, oi) {
      haptic(); const p = S.polls.find(x => x.id === id); if (!p) return;
      if (!p.votes || Array.isArray(p.votes)) p.votes = {};
      if (p.votes[myId] === oi) delete p.votes[myId];
      else p.votes[myId] = oi;
      save(); renderPolls();
    }
    function delPoll(id) {
      haptic();
      confirmBox('Удалить этот опрос?', () => {
        S.del.poll.push(id); S.polls = S.polls.filter(p => p.id !== id); save(); renderPolls(); toast('Опрос удалён')
      });
    }
    function pollToCollect(id) {
      haptic(); const p = S.polls.find(x => x.id === id); if (!p) return;
      const counts = pollVoteCounts(p);
      let wi = -1, max = -1; counts.forEach((c, i) => { if (c > max) { max = c; wi = i } });
      if (wi < 0 || max <= 0) { toast('Нет голосов'); return }
      const opt = p.opts[wi]; if (!opt.pr) { toast('У варианта нет цены'); return }
      confirmBox(`Собрать на победителя «${opt.t}» — ${fmt(opt.pr)}?`, () => {
        S.colls.unshift({ id: nid(), title: `${p.q} — ${opt.t}`, target: opt.pr, paid: {}, n: S.parts.length });
        save(); renderAll(); ok();
        // 🎊 Конфетти
        try { window.confetti?.({ particleCount: 120, spread: 70, origin: { y: 0.6 } }) } catch (e) { }
        logEvent('💰 Сбор на «' + p.q + ' — ' + opt.t + '» — ' + fmt(opt.pr)); toast('Сбор создан на ' + fmt(opt.pr))
      });
    }
    function renderPolls() {
      const box = $('poll-list');
      if (!S.polls.length) { box.innerHTML = `<div class="empty-state"><i data-lucide="vote"></i><div class="msg">Опросов нет.<br>Создайте первый!</div><button class="btn ghost" onclick="$('p-q').focus();$('p-q').scrollIntoView({behavior:'smooth'})">+ Создать опрос</button></div>`; return }
      box.innerHTML = S.polls.map(p => {
        const counts = pollVoteCounts(p);
        const total = counts.reduce((a, b) => a + b, 0);
        const max = Math.max(...counts, 1);
        let wi = -1, wc = 0; counts.forEach((c, i) => { if (c > wc) { wc = c; wi = i } });
        const myVote = p.votes && !Array.isArray(p.votes) ? p.votes[myId] : undefined;
        return `<div class="card"><h3 style="justify-content:space-between"><span style="display:flex;gap:8px;align-items:center">${p.mode === 'fund' ? '💰' : '🗳️'} ${esc(p.q)}</span>
      <button class="icobtn" onclick="delPoll('${p.id}')"><i data-lucide="trash-2" style="width:15px;height:15px"></i></button></h3>
      ${p.opts.map((o, i) => {
          const v = counts[i] || 0, pc = total ? Math.round(v / total * 100) : 0;
          const mine = myVote === i;
          return `<div class="poll-opt ${i === wi && v > 0 ? 'win' : ''}" onclick="votePoll('${p.id}',${i})"><div class="fill" style="width:${pc}%"></div>
          <div class="lbl"><span>${i === wi && v > 0 ? '👑' : ''} ${esc(o.t)}</span>${mine ? ' <b style="color:var(--green)">✓ вы</b>' : ''}${o.pr ? `<span style="font-weight:700;color:var(--gold)">${fmt(o.pr)}</span>` : ''}</div>
          <div class="pct">${v > 0 ? v + ' · ' + pc + '%' : '—'}</div></div>`
        }).join('')}
      <div style="display:flex;gap:7px;margin-top:9px;align-items:center"><span class="pill open">Голосов: ${total}</span>
        ${p.mode === 'fund' && total > 0 ? `<button class="btn ghost" style="flex:1" onclick="pollToCollect('${p.id}')">💰 Собрать на победителя</button>` : ''}
        <span style="font-size:.68rem;color:var(--hint);margin-left:auto">ваш голос: ${myVote !== undefined ? '✓ учтён' : 'клик по варианту'}</span></div></div>`
      }).join('')
    }

    /* ─── СБОРЫ ─── */
    function collShare(c) { return c.target / Math.max(1, c.n || S.parts.length || 1) }
    function collPaidCount(c) { return Object.keys(c.paid || {}).length }
    function collDone(c) { return collPaidCount(c) >= (c.n || S.parts.length || 1) }
    function createColl() {
      evalAmtInput($('c-amt'));
      const t = $('c-title').value.trim(), a = parseNum($('c-amt').value);
      if (!t) { toast('⚠️ Введите название сбора'); $('c-title').focus(); return }
      if (!a || a <= 0) { toast('⚠️ Введите сумму сбора больше 0'); $('c-amt').focus(); return }
      S.colls.unshift({ id: nid(), title: t, target: a, paid: {}, n: S.parts.length });
      $('c-title').value = ''; $('c-amt').value = ''; save(); renderAll(); ok(); logEvent('🐷 Сбор «' + t + '» — ' + fmt(a)); toast('✅ Сбор начат!')
    }
    function togglePaid(cid, pid) {
      haptic(); const c = S.colls.find(x => x.id === cid); if (!c) return;
      if (c.paid[pid]) { delete c.paid[pid] } else { c.paid[pid] = true }
      save(); renderAll();
      if (collDone(c)) logEvent('✅ Сбор «' + c.title + '» — ' + fmt(c.target) + ' — закрит!')
    }
    function delColl(id) {
      haptic();
      confirmBox('Удалить этот сбор?', () => {
        S.del.coll.push(id); S.colls = S.colls.filter(c => c.id !== id); save(); renderAll(); toast('Сбор удалён')
      });
    }
    function collToExpense(cid) {
      haptic(); const c = S.colls.find(x => x.id === cid); if (!c) return;
      const payers = Object.keys(c.paid);
      if (!payers.length) { toast('Отметьте, кто внёс'); return }
      // Складчина: каждый отметившийся уже внёс свою долю — долгов не возникает.
      // «→ В траты» лишь фиксирует покупку в общем списке, не трогая балансы.
      S.expenses.unshift({ id: nid(), desc: c.title, amt: c.target, payer: '', for: [], split: 'equal', shares: null, cat: '💰', settled: true, ts: Date.now() });
      c.converted = true;
      save(); renderAll(); ok(); logEvent('🤝 Складчина «' + c.title + '» — ' + fmt(c.target) + ' — все внесли, долгов нет'); toast('Покупка добавлена в траты')
    }
    function renderColls() {
      const box = $('coll-list');
      if (!S.colls.length) { box.innerHTML = `<div class="empty-state"><i data-lucide="piggy-bank"></i><div class="msg">Сборов нет.<br>Клик «💰 Собрать на победителя» в опросе создаст его сам.</div><button class="btn ghost" onclick="$('c-title').focus();$('c-title').scrollIntoView({behavior:'smooth'})">+ Новый сбор</button></div>`; return }
      box.innerHTML = S.colls.map(c => {
        const share = collShare(c);
        const paidAmt = Math.min(c.target, collPaidCount(c) * share);
        const pct = c.target ? Math.min(100, Math.round(paidAmt / c.target * 100)) : 0;
        const done = collDone(c);
        return `<div class="card"><h3 style="justify-content:space-between"><span style="display:flex;gap:8px;align-items:center"><i data-lucide="piggy-bank" style="color:var(--gold)"></i> ${esc(c.title)}</span>
      <span class="pill ${done ? 'done' : 'open'}">${done ? '✅ закрыт' : pct + '%'}</span></h3>
      <div style="display:flex;justify-content:space-between;font-size:.8rem;color:var(--hint);margin-top:6px"><span>Собрано: <b style="color:var(--gold)">${fmt(paidAmt)}</b></span><span>Цель: ${fmt(c.target)}</span></div>
      <div class="bar-bg"><div class="bar" style="width:${pct}%"></div></div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">${S.parts.map(p => {
          const isPaid = !!c.paid[p.id];
          return `<span class="person ${isPaid ? 'paid' : ''}" onclick="togglePaid('${c.id}','${p.id}')">${isPaid ? '✓' : '○'} ${esc(p.name)}${isPaid ? ' · ' + fmt(share) : ''}</span>`
        }).join('')}</div>
      <div class="dl" style="margin-top:10px">
        ${!c.converted && done ? `<button class="btn ghost green" style="color:var(--green)" onclick="collToExpense('${c.id}')">→ В траты</button>` : (c.converted ? '<span class="pill done" style="margin:auto 0">✅ в тратах</span>' : '')}
        <button class="icobtn" style="margin-left:auto" onclick="delColl('${c.id}')"><i data-lucide="trash-2" style="width:16px;height:16px"></i></button></div></div>`
      }).join('')
    }

    /* ─── SHEET / FAB ─── */
    let sheetType = '';
    function openSheet(type = 'expense', editExp) {
      try { haptic() } catch (e) { }
      sheetType = type;
      const sh = $('exp-sheet');
      if (sh) sh.classList.add('on');
      const bd = $('sheet-backdrop');
      if (bd) bd.classList.add('on');
      const ed = $('e-desc'), ea = $('e-amt');
      if (ed) ed.value = ''; if (ea) ea.value = '';
      curCat = '';
      document.querySelectorAll('#cat-grid .cat-chip').forEach(x => x.classList.remove('on'));
      const firstCat = document.querySelectorAll('#cat-grid .cat-chip')[0];
      if (firstCat) firstCat.classList.add('on');
      // плательщик по умолчанию: я, иначе первый участник
      const mePart = S.parts.find(p => p.me) || S.parts.find(p => p.id === myId);
      payerId = mePart ? mePart.id : (S.parts[0] ? S.parts[0].id : '');
      if (editExp) {
        editExpId = editExp.id;
        const t = $('exp-sheet-title'); if (t) t.innerHTML = '<i data-lucide="wallet" style="color:#4ade80"></i> Изменить трату';
        const s = $('exp-sheet-sub'); if (s) s.textContent = 'Обновите детали — долги пересчитаются автоматически.';
        const b = $('exp-submit-btn'); if (b) b.innerHTML = '<i data-lucide="check" style="width:16px;height:16px"></i> Сохранить';
        if (ed) ed.value = editExp.desc || '';
        if (ea) ea.value = editExp.amt || '';
        curCat = editExp.cat || '';
        document.querySelectorAll('#cat-grid .cat-chip').forEach(x => x.classList.toggle('on', x.dataset.c === curCat));
        // участники-плательщики и «для кого»
        renderParts();
        payerId = editExp.payer || (S.parts[0] ? S.parts[0].id : '');
        const pc = $('e-payer-chips');
        if (pc) [...pc.children].forEach(c => c.classList.toggle('on', c.dataset.i === payerId));
        // отметки «для кого»: e.for пуст = все
        const f = $('e-for');
        if (f) [...f.children].forEach(c => {
          const inFor = (editExp.for || []).includes(c.dataset.i);
          const allSel = !(editExp.for && editExp.for.length);
          c.classList.toggle('on', allSel || inFor);
        });
        if (editExp.split === 'custom') setSplitMode('custom'); else setSplitMode('equal');
        // заполнить доли, если были
        if (editExp.split === 'custom' && editExp.shares) {
          const ins = [...$('share-inputs').querySelectorAll('.sinput')];
          ins.forEach(inp => {
            const idx = parseInt(inp.dataset.idx, 10);
            const ids = forSel(); const parts = ids.length ? ids.filter(i => S.parts.some(p => p.id === i)) : S.parts.map(p => p.id);
            const pid = parts[idx];
            if (pid !== undefined && editExp.shares[pid] !== undefined) inp.value = editExp.shares[pid];
          });
          updateShareSum();
        }
      } else {
        editExpId = null;
        const t = $('exp-sheet-title'); if (t) t.innerHTML = '<i data-lucide="wallet" style="color:#4ade80"></i> Новая трата';
        const s = $('exp-sheet-sub'); if (s) s.textContent = 'Кто заплатил → остальные делят. Можно поровну или по долям.';
        const b = $('exp-submit-btn'); if (b) b.innerHTML = '<i data-lucide="plus" style="width:16px;height:16px"></i> Добавить трату';
        setSplitMode('equal');
        renderParts();
      }
      safeDrawIcons();
    }
    function closeSheet() {
      try { haptic() } catch (e) { }
      document.querySelectorAll('.sheet').forEach(s => s.classList.remove('on'));
      const bd = $('sheet-backdrop');
      if (bd) bd.classList.remove('on');
    }
    function submitExpense() {
      const success = addExpense();
      if (success) closeSheet();
    }

    /* ─── ОБЩЕЕ ─── */
    function confirmBox(msg, cb) {
      if (IS_TG && tg && typeof tg.showConfirm === 'function') {
        try { tg.showConfirm(msg, ok => { if (ok) cb() }); return } catch (e) { }
      }
      if (window.confirm) { try { cb(window.confirm(msg)) } catch (e) { cb(true) } }
      else cb(true);
    }
    function renderAll() {
      renderParts(); renderExp(); renderBalances(); renderTransfers(); renderPolls(); renderColls();
      renderQuickAdd();
      renderMySummary();
      safeDrawIcons();
    }
    /* ─── ПЕРЕИМЕНОВАНИЕ ─── */
    function renamePart(id) {
      haptic();
      const p = S.parts.find(x => x.id === id);
      if (!p) return;
      $('rename-input').value = p.name;
      $('rename-overlay').style.display = 'flex';
      $('rename-save-btn').onclick = () => {
        const newName = $('rename-input').value.trim();
        if (newName) { p.name = newName; save(); renderAll(); toast('Имя изменено') }
        $('rename-overlay').style.display = 'none';
      };
    }
    let _partEditId = null;
    function openPartProfile(id) {
      haptic();
      const p = S.parts.find(x => x.id === id);
      if (!p) return;
      _partEditId = id;
      $('part-name-input').value = p.name || '';
      $('part-pay-input').value = p.pay || '';
      $('part-overlay').style.display = 'flex';
      setTimeout(() => { $('part-name-input').focus() }, 100);
    }
    function savePartProfile() {
      const p = S.parts.find(x => x.id === _partEditId);
      if (!p) return;
      const nm = $('part-name-input').value.trim();
      if (nm) p.name = nm;
      p.pay = $('part-pay-input').value.trim();
      $('part-overlay').style.display = 'none';
      save(); renderAll(); toast('Профиль сохранён');
    }
    function delPartFromProfile() {
      const id = _partEditId; if (!id) return;
      $('part-overlay').style.display = 'none';
      delPart(id);
    }
    function copyPay(id) {
      haptic();
      const p = S.parts.find(x => x.id === id);
      if (!p || !p.pay) { toast('Нет реквизитов'); return; }
      navigator.clipboard?.writeText(p.pay);
      ok();
      toast('Реквизиты ' + (p.name || 'получателя') + ' скопированы — откройте банк для перевода');
    }

    /* init */
    save(); renderAll();
    setTimeout(() => { syncPull(); subscribeRoom() }, 900);

  // Гарантируем отрисовку иконок даже если lucide загрузился после DOMContentLoaded
  function _drawIcons() { safeDrawIcons(); }
  window.addEventListener('load', _drawIcons);
  if (document.readyState === 'complete') _drawIcons();
  // повтор через тик, чтобы перехватить позднюю загрузку CDN
  setTimeout(_drawIcons, 500);
  setTimeout(_drawIcons, 1500);
