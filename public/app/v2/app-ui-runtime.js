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
//  오류는 Error(message) 로 reject 하고 e.code 에 JSON-RPC 코드를 싣는다(-32001 = 권한 밖).
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
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || typeof m !== 'object' || m.id == null) return;
    var p = pend[m.id];
    if (!p) return;
    delete pend[m.id];
    if (m.error) {
      var err = new Error((m.error && m.error.message) || '호출에 실패했습니다.');
      err.code = m.error.code;
      p.reject(err);
    } else p.resolve(m.result);
  });
  var api = {
    version: 1,
    app: null,
    instance: null,
    page: null,
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
    'delete': function (table, match) { return api.tools.call('store_delete', { table: table, match: match }); }
  };
  api.ready = post('ui/initialize', {}).then(function (r) {
    api.app = (r && r.app) || null;
    api.instance = (r && r.instance) || null;
    api.page = (r && r.page) || null;
    return r;
  });
  window.lively = api;
})();
`;
