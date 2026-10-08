// web/v2/app-ui-runtime.ts — 앱 UI 안에서 도는 **라이블리 앱 SDK**(호스트가 iframe 에 자동 주입).
//
//  왜 주입인가: 앱 UI 는 CSP 로 외부 스크립트·네트워크가 막혀 있다(script-src 'unsafe-inline' 뿐).
//   그래서 SDK 를 npm 으로 받아 번들하는 길이 막혀 있고, 앱 개발자가 postMessage JSON-RPC 배관을
//   매번 손으로 짜야 했다. 호스트가 srcdoc 머리에 이 스크립트를 끼워 넣으면 **앱은 아무것도 설치·번들하지 않고**
//   `window.lively` 를 바로 쓴다(그게 이 플랫폼의 SDK 다 — 타입 선언은 apps/sdk/lively-app.d.ts).
//
//  계약(앱이 쓰는 표면):
//    await lively.ready                     → { app, page, capabilities }
//    await lively.tools.call(name, args)    → 그 도구의 결과(앱 grant 범위 안에서만 — 서버가 재판정)
//    await lively.store.query('notes', { match:{done:false}, limit:50 })  → rows[]
//    await lively.store.insert/update/delete(...)                          → 앱 전용 테이블(테넌트 격리)
//    await lively.store.sql('select stage, count(*) from contacts group by 1', [])  → { rows, columns, truncated, changed }
//                                                (#4226 자유 SQL 한 문장 — 매니페스트 permissions.tools 에 store_sql 이 있어야 한다)
//    await lively.ui.openExternal(url)      → 호스트가 새 탭으로(샌드박스 안에선 못 여는 것을 대신)
//    lively.store.onChange(function (ev) { … })  → 이 앱의 데이터가 **바깥에서** 바뀌었다(#4225 — 세션에 붙은 AI 가 썼다 등).
//                                                ev = { table, op, source, session }. 돌려주는 함수를 부르면 끊는다.
//    lively.session                          → 이 화면이 붙은 세션 id(세션 오른쪽 앱 칸에서 열렸을 때). 아니면 null.
//    await lively.chat.send(text)            → 붙은 세션에 글을 **바로 보낸다**(#4594 — 채우기가 아니다). 붙은 세션이 없으면 -32602,
//                                                사람이 누른 동작 밖(타이머 등)이면 -32001. { sent, session, transport } ·
//                                                멈춘 세션이면 { sent:false, draft }(draft=true 면 호스트가 그 세션 입력칸에 넣어 두었다).
//    await lively.prefs.get() / .set(patch)  → 이 앱 × 보는 사람의 작은 설정(#4601 — 배치·글자·접기). set 은 얕은 병합, null 키 삭제, 16KB.
//    lively.ui.onPrefsOpen(function () {…})  → 사람이 앱 탭 ⋯ 메뉴에서 「표시 설정」을 눌렀다 — 앱이 설정 패널을 연다. 돌려주는 함수로 끊는다.
//    await lively.files.list({ ext:['html'], limit:200 }) → { project_id, files:[{ path, name, size, mtime }], truncated }
//    await lively.files.read(path)           → { path, content, size, mtime }   (#4592 — 붙은 세션의 **프로젝트 자료**에서 읽기만.
//                                                매니페스트 permissions.project_files 에 선언한 확장자만 · 8MB 까지 · 붙은 세션이 없으면 -32602)
//    await lively.ui.chrome({ head:false })  → 호스트가 이 앱 위에 그리는 머리줄(앱 이름 · 판 · ⋯)을 접어 달라고 한다(#4592 — 제 머리줄이 있는 앱이
//                                                두 줄이 되지 않게). 접으면 그 ⋯ 메뉴는 아래 openMenu 로 앱이 대신 연다. { ok } — 못 접는 자리면 false.
//    await lively.ui.openMenu(items, { x, y }) → 호스트의 앱 메뉴(고치기 · 표시 설정 · 판 이력 · 크게 보기 · 떼기)를 그 자리에 연다. items =
//                                                [{ id, label }] 는 그 메뉴 맨 위에 선다 — 사람이 그걸 고르면 { picked: id }, 호스트 것을 고르거나
//                                                닫으면 { picked: null }. 못 여는 자리(인사의 capabilities.menu 가 false)면 reject(-32601).
//    (자동) 글 상자에 초점이 들고 나면 호스트에 ui/typing { on } 을 보낸다(#4443). 앱이 할 일은 없다. 폰 서랍에선 쓰는 동안 아래 탭 바가 걷힌다.
//    lively.ui.insets / lively.ui.onInsets(cb) → 호스트가 이 화면의 가장자리를 가리는 폭(px) { top, right, bottom, left } (#4592 — 곁칸의 독).
//                                                같은 값이 CSS 변수 --lively-inset-top/right/bottom/left 로도 심긴다(없으면 0px 로 쓰면 된다) —
//                                                바닥에 붙인 단추와 스크롤의 끝을 그만큼 올리면 가려지지 않는다.
//  오류는 Error(message) 로 reject 하고 e.code 에 JSON-RPC 코드를 싣는다(-32001 = 권한 밖).
//  ⚠ onChange 를 안 쓰는 앱은 바깥에서 데이터가 바뀌면 호스트가 화면을 **다시 불러온다**(최신을 보이는 가장 단순한 길).
//   화면 상태(입력 중인 글·스크롤)를 지키고 싶은 앱은 onChange 를 걸고 스스로 다시 읽는다 — 걸면 다시 불러오기는 멈춘다.
//
//  ⚠ 이 파일은 **문자열**이다(주입 대상). 안에서 백틱·${ } 를 쓰지 않는다(템플릿 리터럴 안이라).
export const APP_RUNTIME_JS = `
(function () {
  if (window.lively) return;
  var seq = 1, pend = {};
  function post(method, params) {
    return new Promise(function (resolve, reject) {
      var id = seq++;
      pend[id] = { resolve: resolve, reject: reject };
      parent.postMessage({ jsonrpc: '2.0', id: id, method: method, params: params || {} }, '*');
    });
  }
  var subs = {};
  function subscribe(topic, cb) {
    if (typeof cb !== 'function') return function () {};
    var list = subs[topic] || (subs[topic] = []);
    list.push(cb);
    if (list.length === 1) parent.postMessage({ jsonrpc: '2.0', method: 'ui/subscribe', params: { topic: topic } }, '*');
    return function () { var i = list.indexOf(cb); if (i >= 0) list.splice(i, 1); };
  }
  function fire(topic, payload) {
    var list = (subs[topic] || []).slice();
    for (var i = 0; i < list.length; i++) { try { list[i](payload); } catch (err) { setTimeout(function () { throw err; }); } }
  }
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.id == null) {
      if (m.method === 'ui/notifications/data-changed') fire('data', m.params || {});
      else if (m.method === 'ui/notifications/prefs-open') fire('prefs-open', m.params || {});
      else if (m.method === 'ui/notifications/insets') applyInsets(m.params || {});
      return;
    }
    var p = pend[m.id];
    if (!p) return;
    delete pend[m.id];
    if (m.error) {
      var err = new Error((m.error && m.error.message) || '호출에 실패했습니다.');
      err.code = m.error.code;
      p.reject(err);
    } else p.resolve(m.result);
  });
  // #4530 — 앱 화면 안을 누른 뒤에도 통합검색 키(⌘K · Ctrl+K · Alt+K)가 바깥 셸의 통합검색을 연다. 키는 이 프레임에서 멈추고
  //  셸 문서에 닿지 않기 때문이다. 판정은 web/lib/omni-chord.ts 와 같다(글자가 라틴이면 글자로, 아니면 자판 위치 KeyK 로 —
  //  한글 입력기가 켜져 있으면 K 가 'ㅏ' 로 온다). 받는 쪽은 app-ui.ts 의 ui/omniOpen(이 프레임에서 온 것만).
  window.addEventListener('keydown', function (e) {
    var k = String(e.key || '');
    var isK = /^[a-z]$/i.test(k) ? k.toLowerCase() === 'k' : e.code === 'KeyK';
    if (!isK) return;
    var chord = e.altKey ? (!e.metaKey && !e.ctrlKey && !e.shiftKey) : ((e.metaKey || e.ctrlKey) && !e.shiftKey);
    if (!chord) return;
    e.preventDefault();
    e.stopPropagation();
    parent.postMessage({ jsonrpc: '2.0', method: 'ui/omniOpen', params: {} }, '*');
  }, true);
  // #4443 글 상자에 초점이 들고 나는 것을 호스트에 알린다(ui/typing { on }). 폰에서 쓰는 동안 셸이 아래 탭 바를 걷고 서랍을 자판 위까지 편다.
  //  바뀔 때만 보낸다. 글 상자에서 글 상자로 옮길 때는 focusout 과 focusin 사이에 초점이 body 에 있는 틈이 있어 한 박자 뒤에 판정한다.
  //  체크 상자 · 라디오 · 단추 · 범위 · 파일 · 읽기 전용 · 꺼진 칸 · 고르기 상자는 글 상자가 아니다(눌러도 자판이 안 뜬다. 고르기 상자는
  //  고르기 판이 닫힌 뒤에도 초점이 남아 탭 바가 숨은 채로 남을 수 있다). 셸 CSS(50-mobile.css)의 목록과 같다.
  function isTypingField(t) {
    if (!t || t.nodeType !== 1) return false;
    if (t.isContentEditable) return true;
    var n = t.tagName;
    if (n === 'TEXTAREA') return !t.disabled && !t.readOnly;
    if (n !== 'INPUT') return false;
    var ty = String(t.type || 'text').toLowerCase();
    return !t.disabled && !t.readOnly && !/^(button|submit|reset|checkbox|radio|range|color|file|image|hidden)$/.test(ty);
  }
  var typing = false, typingT = 0;
  function judgeTyping() {
    typingT = 0;
    var on = isTypingField(document.activeElement) && document.hasFocus();
    if (on === typing) return;
    typing = on;
    parent.postMessage({ jsonrpc: '2.0', method: 'ui/typing', params: { on: on } }, '*');
  }
  function laterTyping() { if (!typingT) typingT = setTimeout(judgeTyping, 0); }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('focusin', laterTyping, true);
    document.addEventListener('focusout', laterTyping, true);
    window.addEventListener('blur', laterTyping);
  }
  // #4592 — 호스트가 가리는 가장자리. 값은 api.ui.insets 와 CSS 변수 둘 다로(앱은 CSS 만으로 비킬 수 있다).
  function applyInsets(p) {
    var num = function (v) { v = Number(v); return isFinite(v) && v > 0 ? Math.round(v) : 0; };
    var i = { top: num(p.top), right: num(p.right), bottom: num(p.bottom), left: num(p.left) };
    api.ui.insets = i;
    var de = typeof document !== 'undefined' ? document.documentElement : null, st = de && de.style;
    if (st) { st.setProperty('--lively-inset-top', i.top + 'px'); st.setProperty('--lively-inset-right', i.right + 'px'); st.setProperty('--lively-inset-bottom', i.bottom + 'px'); st.setProperty('--lively-inset-left', i.left + 'px'); }
    fire('insets', i);
  }
  var api = {
    version: 1,
    app: null,
    instance: null,
    page: null,
    session: null,
    tools: {
      call: function (name, args) { return post('tools/call', { name: String(name), arguments: args || {} }); }
    },
    ui: {
      openExternal: function (url) { return post('ui/openExternal', { url: String(url) }); },
      onPrefsOpen: function (cb) { return subscribe('prefs-open', cb); },
      chrome: function (opts) { return post('ui/chrome', { head: !(opts && opts.head === false) }); },
      openMenu: function (items, at) { return post('ui/menu', { items: items || [], x: at && at.x, y: at && at.y }); },
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      onInsets: function (cb) { return subscribe('insets', cb); }
    },
    files: {
      list: function (opts) { var o = opts || {}; return post('files/list', { ext: o.ext, limit: o.limit }); },
      read: function (path) { return post('files/read', { path: String(path) }); }
    },
    chat: {
      send: function (text) { return post('chat/send', { text: String(text) }); }
    },
    prefs: {
      get: function () { return post('prefs/get', {}).then(function (r) { return (r && r.prefs) || {}; }); },
      set: function (patch) { return post('prefs/set', { patch: patch || {} }).then(function (r) { return (r && r.prefs) || {}; }); }
    }
  };
  api.store = {
    tables: function () { return api.tools.call('store_tables', {}).then(function (r) { return (r && r.tables) || []; }); },
    query: function (table, opts) {
      var o = opts || {};
      return api.tools.call('store_query', { table: table, match: o.match || {}, limit: o.limit })
        .then(function (r) { return (r && r.rows) || []; });
    },
    insert: function (table, row) { return api.tools.call('store_insert', { table: table, row: row || {} }); },
    update: function (table, match, set) { return api.tools.call('store_update', { table: table, match: match, set: set }); },
    'delete': function (table, match) { return api.tools.call('store_delete', { table: table, match: match }); },
    sql: function (text, params) { return api.tools.call('store_sql', { sql: String(text), params: params || [] }); },
    onChange: function (cb) { return subscribe('data', cb); }
  };
  api.ready = post('ui/initialize', {}).then(function (r) {
    api.app = (r && r.app) || null;
    api.instance = (r && r.instance) || null;
    api.page = (r && r.page) || null;
    api.session = (r && r.session) || null;
    return r;
  });
  window.lively = api;
})();
`;
