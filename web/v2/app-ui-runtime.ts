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
//    await lively.ui.openExternal(url)      → 호스트가 새 탭으로(샌드박스 안에선 못 여는 것을 대신)
//    lively.store.onChange(function (ev) { … })  → 이 앱의 데이터가 **바깥에서** 바뀌었다(#4225 — 세션에 붙은 AI 가 썼다 등).
//                                                ev = { table, op, source, session }. 돌려주는 함수를 부르면 끊는다.
//    lively.session                          → 이 화면이 붙은 세션 id(세션 오른쪽 앱 칸에서 열렸을 때). 아니면 null.
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
  //  창에 키 듣기가 없는 환경(시험의 흉내 창 · 오래된 웹뷰)이면 건너뛴다 — 런타임 전체가 여기서 멈추면 앱이 통째로 안 뜬다.
  if (typeof window.addEventListener === 'function') window.addEventListener('keydown', function (e) {
    var k = String(e.key || '');
    var isK = /^[a-z]$/i.test(k) ? k.toLowerCase() === 'k' : e.code === 'KeyK';
    if (!isK) return;
    var chord = e.altKey ? (!e.metaKey && !e.ctrlKey && !e.shiftKey) : ((e.metaKey || e.ctrlKey) && !e.shiftKey);
    if (!chord) return;
    e.preventDefault();
    e.stopPropagation();
    parent.postMessage({ jsonrpc: '2.0', method: 'ui/omniOpen', params: {} }, '*');
  }, true);
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
      openExternal: function (url) { return post('ui/openExternal', { url: String(url) }); }
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
