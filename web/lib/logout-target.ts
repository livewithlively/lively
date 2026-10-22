// 로그아웃 뒤 갈 곳(#2536) — 순수(DOM 없음). 매니지드 배포의 «로그아웃이 안 된다» 를 막는 한 함수.
//
// 매니지드에서 계정은 CP(app.lvly.io)에 있고 테넌트 웹 세션은 CP 가 SSO 로 찍어 준다. 테넌트 코어의 로그아웃은
//  **자기 세션만** 끝낼 수 있다 — CP 세션(lvly_sid, 30일)은 다른 오리진의 쿠키라 fetch 로는 못 지운다. 종전엔 로그아웃
//  뒤 게이트를 띄웠고, 게이트는 CP 로 튕기고, CP 는 살아 있는 자기 세션으로 묻지도 않고 재입장시켰다 →
//  «로그인 창 1~2초 뒤 자동 재로그인»(실측 2026-09-02, 원준님). 그래서 로그아웃은 CP 의 로그아웃 문(/auth/logout)으로
//  **최상위 이동**해 CP 세션까지 끝내고, 돌아올 자리(to)를 들려 보낸다 — 재로그인하면 같은 자리로 돌아온다.
//
// 셀프호스팅(CP 주소 없음)·CP 가 같은 호스트(showGate 의 루프 방지 규칙과 동일)·깨진 주소 → null = 종전 게이트.
// ⚠ 서브패스 CP(프리뷰 등)의 접두사를 보존한다 — pathname 을 덮어쓰면 다른 게이트웨이의 문을 두드린다(#1541 계열).
export function logoutRedirectTarget(loginRedirectUrl: string | null | undefined, here: string): string | null {
  if (!loginRedirectUrl) return null;
  let cp: URL; let me: URL;
  try { cp = new URL(loginRedirectUrl, here); me = new URL(here); } catch { return null; }
  if (cp.host === me.host) return null;
  const base = cp.pathname.replace(/\/+$/, '');
  const door = new URL(`${cp.origin}${base}/auth/logout`);
  door.searchParams.set('to', here);
  return door.toString();
}

// IdP(SSO) 로그아웃 문 — 서버의 로그아웃 응답 {ok:true, redirect?} 에서 갈 곳을 꺼낸다.
//  IdP 로 로그인한 세션이면 서버가 IdP 의 end_session 주소를 주고, 브라우저가 그리로 가야 IdP 세션까지 끝난다
//  (안 가면 «SSO 로 로그인» 한 번에 묻지도 않고 같은 계정으로 돌아온다). 없거나 https 절대주소가 아니면 null — 종전 흐름.
//  https 만 받는 이유: 이 주소의 쿼리에 id_token(개인정보)이 실린다 — 서버도 https 인 로그아웃 문만 쓴다(ee/auth/oidc.ts).
export function ssoLogoutTarget(body: unknown): string | null {
  const raw = body && typeof body === 'object' ? (body as { redirect?: unknown }).redirect : null;
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch { return null; }
}
