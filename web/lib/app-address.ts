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
