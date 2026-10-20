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
//    await lively.ai.run({prompt, schema?, job?, files?, wait?, target?}) → AI 실행 하나(#4488 — {id,status,result}; wait 초를 주면 끝날 때까지). get(id) · list() · cancel(id) · targets()
//                                                target:{fork: lively.session} 은 붙은 세션 대화를 이어받는 분기(#4489 — 결과는 앱에 · session_note 는 그 세션의 다음 턴에).
//    await lively.chat.send(text)            → 붙은 세션에 글을 **바로 보낸다**(#4594 — 채우기가 아니다). 붙은 세션이 없으면 -32602,
//                                                사람이 누른 동작 밖(타이머 등)이면 -32001. { sent, session, transport } ·
//                                                멈춘 세션이면 { sent:false, draft }(draft=true 면 호스트가 그 세션 입력칸에 넣어 두었다).
//    await lively.prefs.get() / .set(patch)  → 이 앱 × 보는 사람의 작은 설정(#4601 — 배치·글자·접기). set 은 얕은 병합, null 키 삭제, 16KB.
//    lively.ui.onPrefsOpen(function () {…})  → 사람이 앱 탭 ⋯ 메뉴에서 「표시 설정」을 눌렀다 — 앱이 설정 패널을 연다. 돌려주는 함수로 끊는다.
//    await lively.files.list({ ext:['html'], limit:200 }) → { project_id, files:[{ path, name, size, mtime }], truncated }
//    await lively.files.read(path)           → { path, content, size, mtime }   (#4592 — 붙은 세션의 **프로젝트 자료**에서 읽기만.
//                                                매니페스트 permissions.project_files 에 선언한 확장자만 · 8MB 까지 · 붙은 세션이 없으면 -32602)
//    await lively.files.list({ scope:'all', q:'덱' }) → { scope:'all', files:[{ …, project_id, project_name }] } — 볼 수 있는 **모든 프로젝트의 자료**(#4629 ·
//                                                permissions.workspace_files 선언 + 따로 동의). 읽을 때는 lively.files.read(path, { project: project_id }).
//                                                답에 scope:'all' 이 없으면 옛 호스트다(붙은 프로젝트의 목록이 왔다) — 그 목록을 전체로 쓰지 않는다.
//    await lively.files.url('apps/<이 앱>/out/a.png', { method:'PUT' }) → { url, method, headers, expires_at, address } — 이 앱의 **앱 폴더**
//                                                (apps/<앱>/…)에 올리고(PUT) 받는(GET) 짧은 수명 서명 주소(#4673). 매니페스트 permissions.app_folder 선언 +
//                                                그 사람의 동의가 있어야 한다. 받은 url 에 쿠키 없이 fetch(url, { method, body }) 하면 된다(앱 화면 CSP 가 그 자리를 연다).
//    await lively.ui.chrome({ head:false })  → 호스트가 이 앱 위에 그리는 머리줄(앱 이름 · 판 · ⋯)을 접어 달라고 한다(#4592 — 제 머리줄이 있는 앱이
//                                                두 줄이 되지 않게). 접으면 그 ⋯ 메뉴는 아래 openMenu 로 앱이 대신 연다. { ok } — 못 접는 자리면 false.
//    await lively.ui.openMenu(items, { x, y }) → 호스트의 앱 메뉴(고치기 · 표시 설정 · 판 이력 · 크게 보기 · 떼기)를 그 자리에 연다. items =
//                                                [{ id, label }] 는 그 메뉴 맨 위에 선다 — 사람이 그걸 고르면 { picked: id }, 호스트 것을 고르거나
//                                                닫으면 { picked: null }. 못 여는 자리(인사의 capabilities.menu 가 false)면 reject(-32601).
//    await lively.ui.expand()                → 이 앱을 화면 가득(사이드바 없이) 띄운다(#4629). 인사의 capabilities.expand 가 true 인 자리(세션의 앱 칸)에서만 —
//                                                이미 크게 뜬 화면에서는 false 다(닫기 · Esc 로 돌아간다). 못 하는 자리면 reject(-32601).
//    (자동) 글 상자에 초점이 들고 나면 호스트에 ui/typing { on } 을 보낸다(#4443). 앱이 할 일은 없다. 폰 서랍에선 쓰는 동안 아래 탭 바가 걷힌다.
//    lively.ui.insets / lively.ui.onInsets(cb) → 호스트가 이 화면의 가장자리를 가리는 폭(px) { top, right, bottom, left } (#4592 — 곁칸의 독).
//                                                같은 값이 CSS 변수 --lively-inset-top/right/bottom/left 로도 심긴다(없으면 0px 로 쓰면 된다) —
//                                                바닥에 붙인 단추와 스크롤의 끝을 그만큼 올리면 가려지지 않는다.
//    await lively.me()                       → { member:{ id, name, email }, workspace:{ slug }, app:{ id, variant }, session } — 보는 사람(#4482).
//                                                도구 선언 없이 쓴다. session 은 세션에 붙은 앱 칸에서 연 화면만(새 탭 · 폰은 늘 null).
//    await lively.requestConsent()           → 이 앱 사용 동의를 청한다(#4482 — 앱이 /_lively/* 를 fetch 로 직접 부르다 403 consent_required 를
//                                                받았을 때). 라이블리 안이면 그 자리 동의 창(사람이 누른 동작 안에서만) → { granted }, 새 탭이면 라이블리의
//                                                동의 화면으로 갔다가 이 화면으로 돌아온다.
//    lively.standalone                       → 라이블리 화면 밖(앱 주소를 새 탭 · 폰 홈 화면으로 연 맨몸)이면 true(#4482). 그때 SDK 는 같은 주소의
//                                                /_lively/* 로 돈다 — 표(store) · 도구 · 개인 설정 · 앱 폴더(files.url) · me 는 그대로 되고,
//                                                세션에 붙는 기능(chat.send · files.list/read · ui.chrome/openMenu/expand)은 «붙은 세션 없음» 으로 실패한다.
//                                                바깥 변경 알림(store.onChange)은 화면이 다시 보일 때 { source:'visibility' } 로 한 번 온다.
//                                                동의가 없으면 처음 한 번 라이블리의 동의 화면으로 갔다 오고, 앱 주소 로그인이 끝났으면 화면을 다시 연다.
//  오류는 Error(message) 로 reject 하고 e.code 에 JSON-RPC 코드를 싣는다(-32001 = 권한 밖).
//   #4848 서버가 거절한 것이면 e.status 에 HTTP 상태, e.reason 에 짧은 코드(busy · body_timeout · body_too_large · bad_body · consent_required ·
//   login_required …, 없으면 null)를 싣는다 — 라이블리 안 · 맨몸 어디서든 같다. 앱은 글이 아니라 e.reason 으로 가른다.
//   본문 거절(busy · body_timeout · body_too_large · bad_body)의 글은 사람이 읽을 말이다. 맨몸에서 앞단이 «붐빔»(503 busy)으로 거절한 요청은
//   SDK 가 retry-after 만큼 쉬고 한 번 다시 보낸다(본문을 다 받기 전의 거절이라 쓰기가 겹치지 않는다) — 또 붐비면 그때 e.reason 'busy' 로 실패한다.
//  ⚠ onChange 를 안 쓰는 앱은 바깥(세션의 AI · 다른 사람)에서 데이터가 바뀌면 호스트가 화면을 **다시 불러온다**(최신을 보이는 가장 단순한 길).
//   앱 화면이 쓴 것(source app-ui · app-front — 다른 창 · 새 탭 · 폰에서 쓴 것도)으로는 다시 불러오지 않는다.
//   그것까지 따라오게 하려면, 또 화면 상태(입력 중인 글·스크롤)를 지키려면 onChange 를 걸고 스스로 다시 읽는다 — 걸면 다시 불러오기는 멈춘다.
//
//  ⚠ 이 파일은 **문자열**이다(주입 대상). 안에서 백틱·${ } 를 쓰지 않는다(템플릿 리터럴 안이라).
export const APP_RUNTIME_JS = `
(function () {
  if (window.lively) return;
  var seq = 1, pend = {};
  // #4480 — 앱 주소(<앱>-<워크스페이스>.lvly.app)를 새 탭에 맨몸으로 열면 감싸는 라이블리 화면이 없다(parent === window).
  //  그때 부르면 제 창에 보낸 요청을 제가 받아 «빈 답» 으로 풀어 버린다 — 조용히 틀린 값을 주느니 분명히 실패한다.
  var alone = (function () { try { return window.parent === window; } catch (_) { return false; } })();
  // #4482 — 앱 주소 문서가 맨몸이면 같은 주소의 /_lively/* 로 돈다(standalone). srcdoc(about:) · 파일로 연 문서는 쓸 API 가 없다.
  var standalone = alone && typeof location !== 'undefined' && /^https?:$/.test(String(location.protocol || ''));
  // #4848 실패는 늘 같은 모양 — code(JSON-RPC) · status · reason. 서버까지 안 간 거절은 status · reason 이 null(서버의 답이면 failure 가 채운다).
  function mkErr(message, code, extra) { var e = new Error(message); e.code = code; e.status = null; e.reason = null; if (extra) { for (var k in extra) e[k] = extra[k]; } return e; }
  function post(method, params) {
    if (standalone) return local(method, params || {});
    return new Promise(function (resolve, reject) {
      if (alone) {
        reject(mkErr('이 기능은 라이블리 화면 안에서 연 앱에서만 쓸 수 있습니다 — 라이블리에서 이 앱을 열어 주세요.', -32601));
        return;
      }
      var id = seq++;
      pend[id] = { resolve: resolve, reject: reject };
      parent.postMessage({ jsonrpc: '2.0', id: id, method: method, params: params || {} }, '*');
    });
  }
  // ── #4482 맨몸(standalone) — 다리 대신 같은 주소의 /_lively/* ─────────────────────────────────────────
  //  한 번만 하는 일(동의 화면 · 로그인 다시 하기)은 이 탭에서 잠깐 기억한다(sessionStorage) — 거절했거나 막힌 브라우저에서 같은 왕복이 끝없이 돌지 않게.
  function onceIn(key, ms) {
    try {
      var now = Date.now(), last = Number(sessionStorage.getItem(key) || 0);
      if (last && now - last < ms) return false;
      sessionStorage.setItem(key, String(now));
      return true;
    } catch (_) { return false; }
  }
  // #4848 서버가 거절한 까닭 — 짧은 코드(e.reason)로 앱에 보인다. 본문 거절 넷은 글(e.message)도 사람이 읽을 말로 바꾼다(앱이 그대로 보여도 되게 —
  //  읽는 사람은 앱을 쓰는 사람이라 개발 용어를 쓰지 않는다).
  //  짧은 코드: 서버 JSON 의 code(코어 — consent_required · body_too_large …), 없으면 짧은 코드 꼴의 error(앞단 — busy · login_required …),
  //  둘 다 없고 서버 글도 없는 413(코어 전역 파서의 HTML 413)이면 body_too_large. 그 밖은 null — 지어내지 않는다(서버가 제 글을 준 413 —
  //  개인 설정 16KB · 파일 읽기 8MB · 결과 상한 — 은 그 글이 맞는 안내다). 맨몸(fetch 의 답)과 라이블리 안(다리의 error.data)이 같이 쓴다.
  var REASON_TEXT = {
    busy: '지금 보내는 요청이 많아 받지 못했습니다 — 잠시 뒤에 다시 보내 주세요.',
    body_timeout: '보내는 데 너무 오래 걸려 끊겼습니다 — 연결을 확인하고 다시 보내 주세요.',
    body_too_large: '보낸 내용이 너무 큽니다(한 번에 1MB 까지) — 나눠서 보내 주세요.',
    bad_body: '보낸 내용을 읽지 못했습니다 — 다시 보내 주세요.'
  };
  var SHORT_CODE = /^[a-z][a-z0-9_]{0,63}$/;
  function reasonOf(status, j) {
    if (j && typeof j.code === 'string' && SHORT_CODE.test(j.code)) return j.code;
    if (j && typeof j.error === 'string' && SHORT_CODE.test(j.error)) return j.error;
    return status === 413 && !(j && typeof j.error === 'string' && j.error) ? 'body_too_large' : null;
  }
  function failure(message, code, status, j, extra) {
    var reason = status ? reasonOf(status, j) : null;
    var e = mkErr(reason && Object.prototype.hasOwnProperty.call(REASON_TEXT, reason) ? REASON_TEXT[reason] : message, code, extra);
    e.status = status || null;
    e.reason = reason;
    return e;
  }
  function here() { return String(location.pathname || '/') + String(location.search || '') + String(location.hash || ''); }
  // 돌아올 자리(next)는 CP 로그인 왕복을 지나도 살아남게 — 그 왕복은 해시를 글자 집합(영숫자 · /_-.?=&%+~:@,)과 512자로 거른다.
  //  encodeURIComponent 가 남기는 !'()* 까지 인코딩하고, 길면 첫 화면(/)으로(앞단 appOpenUrl 과 같은 규칙).
  function strictEnc(v) { return encodeURIComponent(v).replace(/[!'()*]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); }); }
  function consentOk(url) { return !!url && /^https:[/][/]/.test(url); }
  function goConsent(url) {
    if (!consentOk(url)) return false;
    var n = strictEnc(here());
    if (n.length > 300) n = strictEnc('/');
    location.assign(url + (url.indexOf('?') >= 0 ? '&' : '?') + 'next=' + n);
    return true;
  }
  // #4848 앞단이 «붐빔»(503 busy)으로 거절한 요청은 retry-after(초)만큼 쉬고 한 번만 다시 보낸다 — 앞단은 본문을 다 받기 전에 거절해
  //  코어에 닿지 않았다(다시 보내도 쓰기가 겹치지 않는다). 쉬는 시간은 30초까지(없거나 이상하면 5초), 그 위에 ¼(1초까지)을 흩뿌린다 —
  //  한꺼번에 거절된 화면들이 한꺼번에 돌아오지 않게. 다시 보낸 답이 결과다(또 붐비면 그 실패로).
  //  ★ 앞단의 모양 그대로({error:"busy"} — code 없음)일 때만 다시 보낸다(code 를 실은 busy 는 다시 보내지 않는다). 코어는 그 모양을 내지 않는다는
  //   약속에 기댄다 — 코어 src/apps/app-front-api.ts apiErrorReply 주석(지금 코어엔 busy 를 쓰는 자리가 없다).
  function frontBusy(status, j) { return status === 503 && !!j && j.error === 'busy' && j.code === undefined; }
  function retryWait(r) {
    var raw = null;
    try { raw = r.headers && typeof r.headers.get === 'function' ? r.headers.get('retry-after') : null; } catch (_) { raw = null; }
    var s = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
    var base = isFinite(s) && s >= 0 ? Math.min(s, 30) * 1000 : 5000;
    return base + Math.floor(Math.random() * Math.min(1000, base / 4));
  }
  function http(method, path, body) {
    var init = { method: method, credentials: 'same-origin', headers: { accept: 'application/json' } };
    if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    return send(path, init, false);
  }
  // #4848 서버의 답을 받지 못했다(연결 끊김 · 오프라인 — fetch · 본문 읽기의 TypeError) — 같은 모양으로(status · reason null · 원래 오류는 cause).
  //  서버가 쓰기를 마친 뒤 답만 잃었을 수도 있어 «안 갔다» 고 단정하지 않는다.
  function lost(err) { return mkErr('서버의 답을 받지 못했습니다 — 연결을 확인하고 다시 시도해 주세요.', -32000, { cause: err }); }
  function send(path, init, again) {
    return fetch('/_lively' + path, init).then(function (r) {
      return r.text().then(null, function (err) { throw lost(err); }).then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (_) { j = null; }
        if (r.ok) return j;
        //  같은 init(같은 메서드 · 경로 · 본문 글자)으로 한 번만 — 앱이 그 사이 넘긴 객체를 고쳐도 다시 보내는 본문은 첫 번째와 같다.
        if (!again && frontBusy(r.status, j)) {
          return new Promise(function (res) { setTimeout(res, retryWait(r)); }).then(function () { return send(path, init, true); });
        }
        var code = r.status === 403 ? -32001 : (r.status === 400 || r.status === 413) ? -32602 : r.status === 404 ? -32601 : -32000;
        var e = failure((j && j.error) || ('요청이 실패했습니다(' + r.status + ')'), code, r.status, j, { body: j });
        // 앱 주소 로그인(12시간)이 끝났다 — 화면을 다시 열면 앞단이 라이블리 로그인을 거쳐 돌려보낸다(1분에 한 번만).
        if (r.status === 401 && j && j.error === 'login_required' && onceIn('lively.relogin', 60000)) { location.reload(); return new Promise(function () {}); }
        // 이 앱 사용 동의가 없다 — 라이블리의 동의 화면으로 한 번 갔다 온다(10분에 한 번만 — 거절하면 앱이 실패를 받는다).
        if (r.status === 403 && j && j.code === 'consent_required') {
          e.consentUrl = j.consent_url || null;
          //  주소가 쓸 만할 때만 «한 번» 몫을 쓴다 — 못 가는 주소로 10분 몫을 날리지 않게.
          if (consentOk(j.consent_url) && onceIn('lively.consent', 600000) && goConsent(j.consent_url)) return new Promise(function () {});
        }
        throw e;
      });
    }, function (err) { throw lost(err); });
  }
  var NO_SESSION = '붙은 세션이 없습니다 — 라이블리 화면 안에서 세션에 붙은 앱으로 열었을 때만 쓸 수 있습니다';
  var NO_HOST = '라이블리 화면 밖(새 탭 · 폰 홈 화면)에서는 쓸 수 없습니다';
  function local(method, p) {
    if (method === 'ui/initialize') {
      return http('GET', '/me').then(function (me) {
        var page = null;
        try { page = new URLSearchParams(location.search).get('page'); } catch (_) { page = null; }
        return { host: null, app: (me && me.app && me.app.id) || null, instance: null, state: null, page: page, session: null, standalone: true,
          capabilities: { tools: true, menu: false, chrome: false, expand: false, files_all: false, chat: false, me: true, grant: true, standalone: true } };
      });
    }
    if (method === 'ui/me') return http('GET', '/me').then(function (me) { if (me) me.session = null; return me; });
    if (method === 'tools/call') return http('POST', '/tools/' + encodeURIComponent(String(p.name || '')), p.arguments || {});
    if (method === 'prefs/get') return http('GET', '/prefs');
    if (method === 'prefs/set') return http('POST', '/prefs', { patch: p.patch || {} });
    if (method === 'ui/grant') {
      return http('GET', '/me').then(function (me) {
        if (goConsent(me && me.consent_url)) return new Promise(function () {});
        throw mkErr('동의 화면 주소를 받지 못했습니다', -32000);
      });
    }
    if (method === 'ui/openExternal') {
      var u = String(p.url || '');
      if (!/^https?:[/][/]/i.test(u)) return Promise.reject(mkErr('http(s) 주소가 아닙니다', -32602));
      var w = null;
      try { w = window.open(u, '_blank', 'noopener'); } catch (_) { w = null; }
      return Promise.resolve({ opened: !!w });
    }
    if (method === 'chat/send' || method === 'files/list' || method === 'files/read') return Promise.reject(mkErr(NO_SESSION, -32602));
    return Promise.reject(mkErr(NO_HOST, -32601));
  }
  var subs = {};
  function subscribe(topic, cb) {
    if (typeof cb !== 'function') return function () {};
    var list = subs[topic] || (subs[topic] = []);
    list.push(cb);
    if (list.length === 1 && !alone) parent.postMessage({ jsonrpc: '2.0', method: 'ui/subscribe', params: { topic: topic } }, '*');
    return function () { var i = list.indexOf(cb); if (i >= 0) list.splice(i, 1); };
  }
  function fire(topic, payload) {
    var list = (subs[topic] || []).slice();
    for (var i = 0; i < list.length; i++) { try { list[i](payload); } catch (err) { setTimeout(function () { throw err; }); } }
  }
  window.addEventListener('message', function (e) {
    // 답과 알림은 감싸는 라이블리 화면(부모 창)에서만 온다 — 앱이 제 주소에서 돌면(#4480) 다른 창이 가짜 답을 보낼 수 있다.
    if (e.source !== parent || alone) return;
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
      // #4848 호스트가 서버의 실패를 넘기면 error.data 에 {status, error, code} 가 온다 — 맨몸과 같은 규칙으로 e.status · e.reason 을 만든다.
      var d = m.error.data && typeof m.error.data === 'object' ? m.error.data : null;
      p.reject(failure(m.error.message || '호출에 실패했습니다.', m.error.code, d && typeof d.status === 'number' ? d.status : 0, d));
    } else p.resolve(m.result);
  });
  // #4530 — 앱 화면 안을 누른 뒤에도 통합검색 키(⌘K · Ctrl+K · Alt+K)가 바깥 셸의 통합검색을 연다. 키는 이 프레임에서 멈추고
  //  셸 문서에 닿지 않기 때문이다. 판정은 web/lib/omni-chord.ts 와 같다(글자가 라틴이면 글자로, 아니면 자판 위치 KeyK 로 —
  //  한글 입력기가 켜져 있으면 K 가 'ㅏ' 로 온다). 받는 쪽은 app-ui.ts 의 ui/omniOpen(이 프레임에서 온 것만).
  if (!alone) window.addEventListener('keydown', function (e) {
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
  if (!alone && typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('focusin', laterTyping, true);
    document.addEventListener('focusout', laterTyping, true);
    window.addEventListener('blur', laterTyping);
  }
  // #4482 맨몸에는 호스트가 «바깥에서 바뀌었다» 를 밀어 주지 않는다 — 화면이 숨었다가 다시 보이면 한 번 알린다(다른 자리에서 고친 것을 그때 읽게).
  if (standalone && typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    var wasHidden = false;
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { wasHidden = true; return; }
      if (wasHidden && document.visibilityState === 'visible') { wasHidden = false; fire('data', { source: 'visibility' }); }
    });
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
    state: null,   // #4769 인스턴스 state(#/open/<앱>?… 의 값) — 인사 뒤에 채워진다. 없으면 null
    page: null,
    session: null,
    standalone: standalone,
    me: function () {
      return post('ui/me', {}).then(function (m) { if (m && !standalone && api.session && !m.session) m.session = api.session; return m; });
    },
    requestConsent: function () { return post('ui/grant', {}); },
    tools: {
      call: function (name, args) { return post('tools/call', { name: String(name), arguments: args || {} }); }
    },
    ui: {
      openExternal: function (url) { return post('ui/openExternal', { url: String(url) }); },
      onPrefsOpen: function (cb) { return subscribe('prefs-open', cb); },
      chrome: function (opts) { return post('ui/chrome', { head: !(opts && opts.head === false) }); },
      openMenu: function (items, at) { return post('ui/menu', { items: items || [], x: at && at.x, y: at && at.y }); },
      expand: function () { return post('ui/expand', {}); },
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      onInsets: function (cb) { return subscribe('insets', cb); }
    },
    files: {
      list: function (opts) { var o = opts || {}; return post('files/list', { ext: o.ext, limit: o.limit, scope: o.scope, q: o.q }); },
      read: function (path, opts) { var o = opts || {}; return post('files/read', { path: String(path), project: o.project }); },
      url: function (address, opts) { var o = opts || {}; return api.tools.call('file_url', { address: String(address), method: o.method === 'PUT' ? 'PUT' : 'GET', expires_in: o.expires_in }); }
    },
    chat: {
      send: function (text) { return post('chat/send', { text: String(text) }); }
    },
    // AI 실행(#4488 앱 v2-9) — 입구 하나. 앱은 실행 계정을 고르지 않는다(워크스페이스 설정). 어디서 떠도(라이블리 안 · 새 탭 · 폰) 같은 도구다.
    ai: {
      run: function (opts) { return api.tools.call('app_ai_run', opts || {}); },
      get: function (id) { return api.tools.call('app_ai_run_get', { id: Number(id) }); },
      list: function (opts) { return api.tools.call('app_ai_runs', opts || {}).then(function (r) { return (r && r.runs) || []; }); },
      cancel: function (id) { return api.tools.call('app_ai_run_cancel', { id: Number(id) }); },
      targets: function () { return api.tools.call('app_ai_targets', {}); }
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
    api.state = (r && r.state && typeof r.state === 'object') ? r.state : null;
    api.page = (r && r.page) || null;
    api.session = (r && r.session) || null;
    return r;
  });
  api.ready['catch'](function () {});   // 맨몸(#4480)이면 실패한다 — 기다리지 않는 앱의 콘솔에 «처리 안 된 실패» 가 찍히지 않게(기다리는 앱은 그대로 실패를 받는다)
  window.lively = api;
})();
`;
