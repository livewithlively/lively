// lib/net.ts — 토큰·API 베이스·fetch 헬퍼(R29a). core.ts 에서 적출.
//  이 모듈은 **우리 모듈 import 0 인 leaf** 다 — 어떤 화면(앱 셸을 안 쓰는 standalone graph.html 포함)도
//  core.js 를 끌어오지 않고 여기만 붙일 수 있다. 그 성질을 지키려면 여기서 DOM 위젯·state·화면 전환을 부르지 마라.
//
// ⚠ 401(세션 만료) 부수효과는 **역전됐다**(R29a — 이 캠페인의 유일한 행동 구조 변경):
//  종전엔 api() 가 core 의 showGate() 를 직접 불러 로그인 화면을 띄웠다(net → UI 하향 의존). 이제 net 은
//  ① 토큰을 지우고 ② 등록된 콜백을 부르고 ③ 401 에러를 throw 할 뿐이다. '무엇을 보여줄지'는 배선하는 쪽(main.ts)이 정한다.
//  ⚠ **콜백 미배선이면 아무 일도 안 일어난다** — 토큰만 지우고 401 을 그대로 throw 한다(예외·크래시 없음).
//   즉 배선이 늦으면 "만료됐는데 로그인 화면이 안 뜬다"가 되므로, 배선은 첫 api() 호출보다 반드시 먼저다.
//   main.ts 는 import 블록 직후(모듈 본문 최상단)에서 배선한다 — 첫 호출은 파일 맨 끝 boot() 의 /api/ui/me 다.
'use strict';

const TOKEN_KEY = 'lively_ui_token';

// ── API 베이스(#1091) — 프리뷰 서브패스(/preview/<id>/, #1036)에서 뜬 화면은 API 도 그 프리뷰로 가야 한다. ──
//  루트 절대경로(fetch('/api/…'))는 오리진 루트 = **라이브 게이트웨이**로 새어, throwaway 프리뷰가
//  '새 프론트 + 구 백엔드'를 보여줬다(프론트 변경만 반영돼 잘못된 초록불이 난다). 그래서 화면이 놓인
//  경로에서 접두사를 유도해 붙인다. 프론트 전용(shared-proxy) 프리뷰에선 서버가 /preview/<id>/api/… 를
//  307 로 게이트웨이 본체에 돌려주므로(src/preview/routes.ts) 같은 코드가 양쪽에서 맞는다.
const API_PREFIX = (() => {
  const m = /^(\/preview\/[A-Za-z0-9][A-Za-z0-9._-]*)\//.exec(location.pathname);
  return m ? m[1] : '';
})();
// 루트 절대경로만 접두사를 받는다(상대·절대URL·blob/data 는 그대로).
//  #1750 후속 — /api/ 경로에는 선택 워크스페이스를 `lvly_ws` 쿼리로도 싣는다. 헤더는 fetch 에만 실을 수
//  있어서 EventSource(SSE)·iframe·`<a href>` 로 만드는 요청이 전부 신호 없이 primary 로 떨어졌다
//  (dev 실측 — '하루' 워크스페이스 화면이라 믿는 탭이 primary 데이터를 그렸다). URL 을 만드는 이 한
//  자리에 붙이면 fetch 든 스트림이든 같은 신호를 갖는다(서버 미들웨어가 헤더와 동등하게 읽는다).
function apiUrl(path: string): string {
  let p = API_PREFIX && String(path).charAt(0) === '/' ? API_PREFIX + path : path;
  const ws = currentWorkspace();
  if (ws && ws !== 'primary' && String(path).indexOf('/api/') === 0 && p.indexOf('lvly_ws=') < 0) {
    p += (p.indexOf('?') < 0 ? '?' : '&') + 'lvly_ws=' + encodeURIComponent(ws);
  }
  return p;
}
// 화면 이동(#1169) — `window.open`·`<a href>` 로 **다른 페이지**를 열 때 쓴다. apiUrl 과 규칙은 같지만
//  대상이 fetch 가 아니라 내비게이션이라 이름을 갈라 둔다(호출부에서 무엇을 하려는지 읽히도록).
//  없을 때의 증상: 프리뷰에서 새 웹터미널을 열면 `/ui/terminal.html?…` 이 **오리진 루트**로 해소돼
//  라이브 게이트웨이 탭이 뜨고 프리뷰가 풀렸다.
//  WS(`/terminal/ws`)도 같은 규칙을 탄다(standalone/terminal.ts) — 프리뷰가 upgrade 를 중계하게 된 뒤로는
//  티켓·WS·노드 레지스트리가 **한 프로세스**에 모여야 하기 때문이다(preview/ws-proxy.ts 머리말 참조).
function appUrl(path: string): string {
  return apiUrl(path);
}

// ── 401 주입점 — 세션이 만료됐을 때 '앱이' 할 일(state 비우기 + 로그인 게이트)을 받아 둔다. ──
//  null(미배선)이면 api() 는 조용히 토큰만 지우고 401 을 throw 한다(종전에도 호출부는 e.status===401 을 보고 있다).
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;
function setUnauthorizedHandler(fn: UnauthorizedHandler | null): void {
  onUnauthorized = fn;
}

// ── 워크스페이스 선택(#1750 S2) — 셀프호스트 다중 워크스페이스의 클라이언트 축. ──
//  선택은 localStorage 에 산다(탭·새로고침 유지). 'primary'/미선택이면 헤더를 아예 안 붙인다 —
//  구 게이트웨이(registry 모드 아님)에 미지 헤더를 보내지 않는 무회귀이자, primary = 무컨텍스트 규약과 일치.
const WORKSPACE_KEY = 'lively.workspace';
function currentWorkspace(): string {
  try { return (localStorage.getItem(WORKSPACE_KEY) || '').trim().toLowerCase(); } catch (_) { return ''; }
}
function setCurrentWorkspace(slug: string): void {
  const s = (slug || '').trim().toLowerCase();
  try { if (!s || s === 'primary') localStorage.removeItem(WORKSPACE_KEY); else localStorage.setItem(WORKSPACE_KEY, s); } catch (_) { /* 프라이빗 모드 등 — 선택이 세션 한정이 될 뿐 */ }
}

// ── fetch 헬퍼 — 401 은 토큰 폐기 + 주입된 처리기, 그 외 비정상은 {error} 메시지로 throw ──
async function api(path: string, opts: any = {}): Promise<any> {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers: any = Object.assign({}, opts.headers);
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const ws = currentWorkspace();
  if (ws && ws !== 'primary') headers['x-lively-workspace'] = ws;
  // 화면 테마(#1683) — 이 브라우저가 지금 **실제로 보고 있는** 테마. 세션을 만들 때 서버가 이 값을
  //  pane env(COLORFGBG·LIVELY_THEME)로 내려, 터미널 안에서 도는 하네스가 배경에 맞는 색을 고르게 한다
  //  (src/terminal/sessions.ts). 여기 한 자리가 모든 세션 생성 경로를 덮는다 — 호출부가 여럿이라
  //  (홈 입력창·새 세션 폼·프로젝트·me-ai…) payload 마다 넣으면 하나씩 빠진다.
  //  ⚠ 해석 로직을 web/theme.ts 에서 import 하지 않고 여기 3줄로 되풀이한다 — 이 모듈은 **우리 모듈 import 0 인
  //   leaf** 가 계약이기 때문이다(파일 머리 주석). 키 이름('lv:theme')과 규칙(없음=시스템 따름)이 계약면이다.
  try {
    const pref = localStorage.getItem('lv:theme');
    const dark = pref === 'dark' || (pref !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    headers['x-lively-theme'] = dark ? 'dark' : 'light';
  } catch (_) { /* 스토리지·matchMedia 없는 문맥 — 헤더 생략(서버는 미지정으로 본다) */ }
  // 호출처가 'content-type'(소문자)을 넘겨 온 자리가 있었다 — 키가 둘이면 fetch 가 값을 쉼표로 합쳐 서버가 JSON 으로 못 읽는다.
  //  대소문자 변형을 전부 걷어내고 하나만 둔다(실측 2026-08-24, 세션 완전 삭제 선택이 서버에 안 닿던 원인).
  for (const k of Object.keys(headers)) if (k.toLowerCase() === 'content-type' && k !== 'Content-Type') { if (!('Content-Type' in headers)) headers['Content-Type'] = headers[k]; delete headers[k]; }
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(apiUrl(path), Object.assign({}, opts, { headers }));
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);   // 토큰은 이 모듈 소관 — 죽은 토큰을 다음 요청에 다시 싣지 않는다
    if (onUnauthorized) onUnauthorized(); // 배선돼 있으면 앱이 state 를 비우고 로그인 게이트를 띄운다
    const e: any = new Error('인증이 필요합니다'); e.status = 401; throw e;
  }
  let data: any = null;
  try { data = await res.json(); } catch (_) { /* 빈 바디 허용 */ }
  // 선택한 워크스페이스가 사라졌다(보관·오타) — 갇히지 않게 선택을 지우고 primary 로 복귀한다(1회 리로드).
  //  루프 안전: 지운 뒤에는 헤더가 안 붙으므로 재발하지 않는다. 일반 404(자원 없음)와는 메시지로 가른다.
  if (res.status === 404 && ws && data && typeof data.message === 'string' && data.message.indexOf('워크스페이스') === 0) {
    setCurrentWorkspace('');
    location.reload();
    const eGone: any = new Error(data.message); eGone.status = 404; throw eGone;
  }
  if (!res.ok) {
    const e: any = new Error((data && data.error) || ('요청 실패 (' + res.status + ')'));
    e.status = res.status;
    // 서버가 준 구조화 정보를 그대로 넘긴다 — 호출부가 message 문자열을 파싱하지 않고 분기할 수 있게.
    //  (#1601 enterprise_required: '고장'이 아니라 '이 배포엔 없는 기능'을 화면이 구분해 안내한다.)
    e.body = data;
    throw e;
  }
  return data;
}

export {
  TOKEN_KEY,
  api,
  apiUrl,
  appUrl,
  setUnauthorizedHandler,
  currentWorkspace,
  setCurrentWorkspace,
};
