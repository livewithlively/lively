// connect-routes-view.ts — [외부 앱 연결] 화면이 앱마다 «어떻게 연결돼 있나 · 내가 할 다음 걸음» 을 말하는 잣대 (#4970).
//
//  판정은 서버가 한다 — org_connect_status 의 routes(길과 상태) · recommended(권하는 길) · blocked_before(그 앞의 막힌 길)
//   (src/org/connect-routes.ts). 이 파일은 그 결과를 **사람 말과 단추 하나**로 옮길 뿐이다. 화면이 길을 다시 판정하면
//   스킬(AI)과 화면이 서로 다른 길을 권하게 된다.
//  비개발자가 혼자 끝까지 가는 것이 기준이다(상민님 2026-10-23) — 줄마다 «지금 할 일» 이 하나만 먼저 보인다.
//
//  ⚠ 이 파일은 DOM 을 모른다 — 말과 단추 종류만 정한다(그래서 scripts/connect-routes-view.test.mjs 가 표를 돈다).

export type RouteKind = 'app' | 'ai' | 'token';
export type RouteState =
  | 'collecting' | 'set_scope' | 'connect' | 'register' | 'ask_admin' | 'preparing'
  | 'connected' | 'reconnect' | 'off';

export interface RouteIn { kind: RouteKind; state: RouteState; ai_app?: string; needs?: 'claude_login'; off_reason?: 'blocked' | 'unknown' }

export interface RegistrationIn {
  who: string; minutes: number; what: string;
  missing: string[];
  steps: Array<{ text: string; link?: { label: string; kind: 'url'; url: string } | { label: string; kind: 'slack_manifest' }; copy?: { what: string; value: string | null } }>;
  fields: Array<{ key: string; label: string; secret: boolean; file?: boolean; optional?: boolean; hint?: string }>;
  notes: string[];
}

export interface ConnectAppIn {
  app: string;
  label: string;
  app_ready: boolean | null;
  routes: RouteIn[] | null;
  recommended: number | null;
  blocked_before: number[] | null;
  registration?: RegistrationIn | null;
  error?: string;
}

/** 단추 종류 — 화면이 무엇을 할지(계정 연결 열기 · 토큰 창 · 상세로 …)를 정하는 이름. */
export type RowAction =
  | 'manage'        // 관리 › — 이미 모으거나 연결됨
  | 'scope'         // 범위 정하기 › — 연결은 됐고 무엇을 모을지만 남음
  | 'oauth'         // [연결] — 라이블리 앱으로 계정 연결(그 자리에서 시작)
  | 'claude'        // [Claude 로 연결] › — 상세의 Claude 길 칸으로
  | 'claude_login'  // [Claude 로그인] › — 서버에 이 사람의 Claude 로그인이 없다
  | 'token'         // [토큰 넣기] — 토큰 창
  | 'register'      // [앱 등록] › — 상세의 앱 등록 칸으로
  | 'reconnect'     // [다시 연결] › — 다시 로그인
  | 'detail'        // 자세히 › — 남이 할 일(관리자) · 못 읽음
  | 'none';         // 할 일이 없다(준비 중 · 꺼짐)

/** 목록 묶음 — 모으는 중·연결됨 · 정할 것이 남음 · 바로 연결할 수 있음 · 준비가 필요함 · 못 읽음. */
export type RowBucket = 'on' | 'half' | 'off' | 'soon' | 'err';

export interface RowView {
  /** 줄 말 — «어떻게 연결돼 있나» 한 마디. */
  word: string;
  action: RowAction;
  /** 단추 글(없으면 null — 줄 끝의 «›» 만). */
  button: string | null;
  bucket: RowBucket;
  /** 권하는 길보다 앞의 막힌 길 — 한 줄(없으면 null). «더 좋은 길이 왜 아닌가» 를 말한다. */
  blockedNote: string | null;
  /** 권하는 길(없으면 null). */
  route: RouteIn | null;
}

export const ROUTE_NAME: Readonly<Record<RouteKind, string>> = { app: '라이블리 앱', ai: 'Claude 커넥터', token: '개인 토큰' };

/** 받침이 있으면 a, 없으면 b — 한글 끝 글자로 고른다. 한글이 아니면 «a(b)». */
export function josa(word: string, a: string, b: string): string {
  const c = String(word || '').trim().slice(-1).charCodeAt(0);
  if (!(c >= 0xac00 && c <= 0xd7a3)) return `${a}(${b})`;
  return (c - 0xac00) % 28 ? a : b;
}

/** 막힌 길 한 마디 — 그 길이 왜 지금 안 되는가. */
export function blockedWord(r: RouteIn, appReady: boolean | null): string | null {
  if (r.kind === 'app' && r.state === 'preparing') return '라이블리 앱은 라이블리가 준비하고 있어요';
  if (r.kind === 'app' && r.state === 'ask_admin') return appReady === false ? '라이블리 앱은 관리자가 먼저 등록해야 해요' : '라이블리 앱은 관리자가 수집을 켜야 해요';
  if (r.kind === 'ai' && r.state === 'off') return r.off_reason === 'unknown' ? 'Claude 커넥터는 지금 확인하지 못했어요' : 'Claude 커넥터는 이 워크스페이스에서 쓰지 않아요';
  if (r.state === 'ask_admin') { const n = ROUTE_NAME[r.kind]; return `${n}${josa(n, '은', '는')} 관리자가 수집을 켜야 해요`; }
  return null;
}

/** 목록 한 줄 — 권하는 길 하나로 말과 단추를 정한다(서버가 고른 길을 바꾸지 않는다). */
export function rowView(a: ConnectAppIn): RowView {
  const routes = Array.isArray(a.routes) ? a.routes : null;
  if (a.error || !routes) return { word: '상태를 불러오지 못했어요', action: 'detail', button: null, bucket: 'err', blockedNote: null, route: null };
  const i = typeof a.recommended === 'number' ? a.recommended : -1;
  const r = i >= 0 && i < routes.length ? routes[i]! : null;
  if (!r) return { word: '연결할 길이 없어요', action: 'none', button: null, bucket: 'soon', blockedNote: null, route: null };
  const blockedNote = (a.blocked_before || [])
    .map((j) => routes[j]).filter((x): x is RouteIn => !!x)
    .map((x) => blockedWord(x, a.app_ready)).filter((x): x is string => !!x)
    .join(' · ') || null;
  const base = { blockedNote, route: r };
  const name = ROUTE_NAME[r.kind];
  switch (r.state) {
    case 'collecting':
      return { ...base, word: `${name}${r.kind === 'ai' ? '로' : '으로'} 모으는 중`, action: 'manage', button: null, bucket: 'on' };
    case 'connected':
      return { ...base, word: `${name}로 연결됨`, action: 'manage', button: null, bucket: 'on' };
    case 'set_scope':
      return { ...base, word: '연결됨 — 무엇을 모을지만 정하면 돼요', action: 'scope', button: '범위 정하기', bucket: 'half' };
    case 'reconnect':
      return { ...base, word: `${name} — 다시 로그인이 필요해요`, action: 'reconnect', button: '다시 연결', bucket: 'half' };
    case 'register': {
      const min = a.registration?.minutes;
      return { ...base, word: `라이블리 앱 등록부터 해요${min ? `(약 ${min}분)` : ''}`, action: 'register', button: '앱 등록', bucket: 'off' };
    }
    case 'connect':
      if (r.kind === 'app') return { ...base, word: '아직 연결 전 — 계정으로 한 번 허용하면 돼요', action: 'oauth', button: '연결', bucket: 'off' };
      if (r.kind === 'token') return { ...base, word: '아직 연결 전 — 개인 토큰으로 연결해요', action: 'token', button: '토큰 넣기', bucket: 'off' };
      if (r.needs === 'claude_login') return { ...base, word: 'Claude 커넥터로 모을 수 있어요 — 라이블리에 Claude 로그인부터', action: 'claude_login', button: 'Claude 로그인', bucket: 'off' };
      return { ...base, word: 'Claude 에 연결해 둔 앱으로 모을 수 있어요', action: 'claude', button: 'Claude 로 연결', bucket: 'off' };
    case 'ask_admin':
      return { ...base, word: r.kind === 'app' && a.app_ready === false ? '관리자가 라이블리 앱을 먼저 등록해야 해요' : '연결됨 — 수집은 관리자가 켜요', action: 'detail', button: null, bucket: 'soon' };
    case 'preparing':
      return { ...base, word: '라이블리가 준비하고 있어요', action: 'none', button: null, bucket: 'soon' };
    case 'off':
      return { ...base, word: r.off_reason === 'unknown' ? '지금 확인하지 못했어요 — 잠시 뒤 다시 열어 주세요' : '이 워크스페이스는 이 길을 쓰지 않아요', action: 'none', button: null, bucket: 'soon' };
  }
}

/** 상세의 길 칸 — 그 길이 무엇인가(고를 때 알아야 할 차이 한 줄). */
export function routeBlurb(kind: RouteKind, label: string): string {
  if (kind === 'app') return `${label}의 공식 연결이에요. 한 사람이 연결하면 워크스페이스가 함께 모아요.`;
  if (kind === 'ai') return `내가 Claude 에 연결해 둔 ${label}${josa(label, '으로', '로')} 모아요. 내가 볼 수 있는 것만 모아요.`;
  return `${label}에서 만든 토큰으로 연결해요. 그 토큰이 볼 수 있는 것을 모아요.`;
}

/** 상세의 길 칸 — 지금 상태 한 마디. */
export function routeStateText(r: RouteIn, a: Pick<ConnectAppIn, 'label' | 'app_ready' | 'registration'>): string {
  const L = a.label;
  switch (r.state) {
    case 'collecting': return '모으고 있어요.';
    case 'connected': return `Claude 에 ${L}${josa(L, '이', '가')} 연결돼 있어요.`;
    case 'set_scope': return '연결됐어요. 무엇을 모을지 정하면 시작해요.';
    case 'reconnect': return r.kind === 'ai' ? `Claude 에서 ${L}에 다시 로그인해야 해요.` : '다시 로그인해야 해요.';
    case 'register': {
      const g = a.registration;
      return g ? `회사 앱을 라이블리에 한 번 등록하면 연결할 수 있어요 — 약 ${g.minutes}분 걸려요.` : '회사 앱을 라이블리에 한 번 등록하면 연결할 수 있어요.';
    }
    case 'connect':
      if (r.kind === 'app') return `${L} 화면에서 [허용]을 한 번 누르면 연결돼요.`;
      if (r.kind === 'token') return `${L}에서 토큰을 만들어 넣으면 돼요.`;
      return r.needs === 'claude_login'
        ? '먼저 라이블리에 Claude 로그인이 필요해요 — 라이블리가 그 로그인으로 Claude 에 연결된 앱을 읽어요.'
        : `Claude 에서 ${L}${josa(L, '을', '를')} 연결하면 여기서 보여요.`;
    case 'ask_admin':
      return r.kind === 'app' && a.app_ready === false ? '관리자가 먼저 앱을 등록해야 해요.' : '연결은 됐어요. 수집을 켜는 건 관리자가 해요.';
    case 'preparing': return '라이블리가 준비하고 있어요. 준비를 마치면 여기서 바로 연결할 수 있어요.';
    case 'off': return r.off_reason === 'unknown' ? '이 길의 설정을 지금 확인하지 못했어요. 잠시 뒤 다시 열어 주세요.' : '이 워크스페이스는 관리자 설정으로 이 길을 쓰지 않아요.';
  }
}

/** 상세의 길 순서 — 권하는 길이 맨 위(펼침), 나머지는 우선순위 순서 그대로(«다른 길»). */
export function routeOrder(a: Pick<ConnectAppIn, 'routes' | 'recommended'>): { first: RouteIn | null; rest: RouteIn[] } {
  const routes = Array.isArray(a.routes) ? a.routes : [];
  const i = typeof a.recommended === 'number' && a.recommended >= 0 && a.recommended < routes.length ? a.recommended : -1;
  if (i < 0) return { first: null, rest: routes.slice() };
  return { first: routes[i]!, rest: routes.filter((_, j) => j !== i) };
}

/** 목록 요약 — 묶음별 개수(0 은 빼지 않는다 — 화면이 고른다). */
export function rowSummary(apps: ConnectAppIn[]): Record<RowBucket, number> {
  const n: Record<RowBucket, number> = { on: 0, half: 0, off: 0, soon: 0, err: 0 };
  for (const a of apps) n[rowView(a).bucket]++;
  return n;
}

/** 앱 등록 칸의 값 — 칸마다 앞뒤 공백을 떼고, 빠진 칸이 있으면 그 이름(서버 400 전에 화면이 먼저 말한다). */
export function regValues(fields: RegistrationIn['fields'], input: Record<string, string | null | undefined>):
  { ok: true; values: Record<string, string> } | { ok: false; missing: string } {
  const values: Record<string, string> = {};
  for (const f of fields) {
    const v = String(input[f.key] ?? '').trim();
    if (!v && !f.optional) return { ok: false, missing: f.label };
    if (v) values[f.key] = v;
  }
  return { ok: true, values };
}

/** 깃허브 키 파일(.pem)인가 — 다른 파일(인증서·공개 키·빈 파일)을 고르면 저장 전에 말한다. */
export function looksLikePrivateKey(text: string): boolean {
  const t = String(text || '');
  return /-----BEGIN (RSA |EC |)PRIVATE KEY-----/.test(t) && /-----END (RSA |EC |)PRIVATE KEY-----/.test(t);
}
