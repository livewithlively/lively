// lib/app-address.ts — 앱 주소(#4480 v2-1) 화면 쪽 **순수** 조각. app-ui.ts 가 쓰고 scripts/app-address-web.test.mjs 가 잰다.
//  서버 짝: src/apps/app-address.ts(parseAppPath 가 아래 embedNext 의 쿼리 이름을 같은 뜻으로 읽는다) · 앞단 신호의 짝: lvly-cloud appfront.ts.

/** 앱 주소 안 경로 — 화면 키(?page=) · 앱 만들기 탐침(__lively_probe=1). */
export function embedNext(page?: string, probe?: boolean): string {
  const q = new URLSearchParams();
  if (page) q.set('page', page);
  if (probe) q.set('__lively_probe', '1');
  const s = q.toString();
  return '/' + (s ? '?' + s : '');
}

/** 앱 주소 앞단이 iframe 안에서 부모(라이블리 화면)로 보내는 로그인 신호 `{type:'lively:app-auth', status}` — 이 셋만 뜻이 있다. */
export type AppAuthSignal = 'login-required' | 'code-invalid' | 'cookie-blocked';
export function appAuthSignal(m: unknown): AppAuthSignal | null {
  if (!m || typeof m !== 'object' || (m as { type?: unknown }).type !== 'lively:app-auth') return null;
  const st = (m as { status?: unknown }).status;
  return st === 'login-required' || st === 'code-invalid' || st === 'cookie-blocked' ? st : null;
}

/** «이 브라우저는 앱 주소 쿠키를 막는다» 기록이 아직 유효한가 — 같은 브라우저(UA)·7일 안. 값이 깨져 있으면 아니다. */
export const ADDR_BLOCK_DAYS = 7;
export function addrBlockValid(raw: string | null, ua: string, now: number): boolean {
  try {
    const v = JSON.parse(raw || 'null') as { ua?: unknown; at?: unknown } | null;
    return !!v && v.ua === ua && Number.isFinite(Number(v.at)) && now - Number(v.at) >= 0 && now - Number(v.at) < ADDR_BLOCK_DAYS * 864e5;
  } catch (_) { return false; }
}

/**
 * #4482 동의 경유(#/app-grant/<앱>?back=<앱 주소 출처>&next=<앱 안 경로>)에서 돌아갈 곳 — 그 앱의 앱 주소만(열린 리다이렉트가 되지 않게).
 *  back 은 출처 하나(`https://<앱>-<워크스페이스>[-draft].<앱 도메인>`)여야 하고 첫 칸이 `<앱>-` 로 시작해야 한다. next 는 그 주소 안의 상대 경로
 *  (`/` 로 시작 · `//` 아님 · 공백 · 역슬래시 · 제어문자 없음 · 2,048자 이하). 틀리면 null(돌려보내지 않는다).
 */
export function appGrantReturn(appId: string, back: string | null | undefined, next: string | null | undefined, appDomain: string | null | undefined): string | null {
  const dom = String(appDomain || '').toLowerCase();
  if (!back || !dom || !appId) return null;
  let u: URL;
  try { u = new URL(back); } catch (_) { return null; }
  if (u.protocol !== 'https:' || u.origin !== back.replace(/\/$/, '') || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!host.endsWith('.' + dom)) return null;
  const label = host.slice(0, -dom.length - 1);
  if (label.includes('.') || !label.startsWith(appId.toLowerCase() + '-')) return null;
  const n = next == null || next === '' ? '/' : String(next);
  if (n.length > 2048 || !n.startsWith('/') || n.startsWith('//') || /[\s\\\u0000-\u001f\u007f]/.test(n)) return null;
  return u.origin + n;
}

/**
 * #4482 iframe 의 sandbox 값 — 순수(scripts/app-address-web.test.mjs · builtin-app-ui-sandbox.test.mjs).
 *  · 두 길 공통: 스크립트 · 폼 제출(allow-forms — 종전엔 submit 이벤트도 안 와 «form 금지» 규칙이 있었다) · 대화창(alert · confirm · print) ·
 *    내려받기(<a download> · 만든 파일).
 *  · 앱 주소 길만: 출처(allow-same-origin — 앱 주소 자신이라 라이블리에 못 닿는다)와 팝업(window.open · target=_blank — 열린 창도 같은 sandbox).
 *    srcdoc 은 불투명 출처라 팝업이 쿠키 · 저장소 없는 깨진 창이 된다 — 그 길의 새 창은 종전대로 lively.ui.openExternal(호스트가 연다).
 *  · 어느 길도 최상위 창 이동(allow-top-navigation*)과 팝업의 sandbox 벗기(allow-popups-to-escape-sandbox)는 주지 않는다 — 앱이 라이블리 탭을
 *    다른 주소로 바꾸지 못하게(벗긴 팝업은 opener.top 으로 라이블리 탭을 옮길 수 있다).
 */
export function frameSandbox(kind: 'address' | 'srcdoc'): string {
  return (kind === 'address'
    ? ['allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-modals', 'allow-popups', 'allow-downloads']
    : ['allow-scripts', 'allow-forms', 'allow-modals', 'allow-downloads']).join(' ');
}
/** 앱 주소 iframe 의 권한 정책(allow) — 늘 주는 것(사람이 누를 때만 도는 것) + 앱이 선언한 장치(web.devices). 모르는 값은 버린다. */
const FRAME_DEVICES = ['microphone', 'camera', 'clipboard-read', 'geolocation'];
export function frameAllow(devices?: readonly unknown[] | null): string {
  const declared = FRAME_DEVICES.filter((d) => Array.isArray(devices) && devices.includes(d));
  return ['clipboard-write', 'fullscreen', 'web-share', ...declared].join('; ');
}
