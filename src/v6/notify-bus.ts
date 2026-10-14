// 알림 실시간 버스 (#1842) — **"세션이 끝난 순간"을 기다리지 않고 그 자리에서 앱으로 민다.**
//
// 왜 필요한가: 30초 폴링으로는 "AI 를 여러 개 병렬로 돌리다 끝나는 것마다 바로 받는다"가 성립하지 않는다.
//  그런데 게이트웨이는 이미 그 순간을 정확히 안다 — 하네스 훅이 `POST /api/ui/terminal/sessions/:id/active`
//  로 실행 단계(busy·waiting·idle)를 보고하는 지점(#1221)이 곧 사건이 일어나는 자리다. 폴링은 그 사실을
//  **다시 발견**하려고 30초를 기다린 것이었다.
//
// 범위 — 이 버스는 **한 프로세스 안**이다(인메모리). 훅 보고를 받는 것도 SSE 를 물고 있는 것도 같은 프로세스다.
//  여러 인스턴스로 늘어나면 그때 Redis 등 외부 버스가 필요해진다 — 그 전까지 브로커를 들이지 않는다.
//
// ⚠ 이 파일은 **무엇이 알림인지 판정하지 않는다.** 전이 사실(prev→next)만 실어 나른다. 사건의 해석과 문구는
//  앱(desktop/main/notify.mjs)이 한 곳에서 한다 — 서버가 한 번, 앱이 또 한 번 판정하면 실시간 배너와 폴백
//  폴링 배너가 서로 다른 말을 하게 된다(#1571 이 "판정이 두 벌로 갈라진다"고 경계한 그 자리).
//
// ── ★ 주소는 «사람» 이 아니라 «워크스페이스 + 사람» 이다 (#4054) ─────────────────────────────
//  종전엔 구성원 아이디 하나로 구독·발행했다. 그런데 매니지드는 **게이트웨이 한 프로세스가 모든 워크스페이스를
//  서비스**하고(#1437), 구성원 아이디는 워크스페이스마다 이메일 로컬파트에서 따로 만든다
//  (capabilities/delivery/members.ts uniqueMemberId). 그래서 두 가지가 한꺼번에 일어났다:
//   ① 같은 사람의 **다른 워크스페이스** 사건이 지금 앱이 매인 워크스페이스의 스트림으로 흘렀다 — 사건에
//      워크스페이스 표시가 없어 앱은 그것을 지금 창에서 열려다 실패했다(상민님 신고 2026-09-17).
//   ② **다른 사람**이라도 로컬파트가 같으면(`john@a.com` · `john@b.com`) 서로의 세션 이름·id 를 받았다.
//  그래서 구독은 «어느 워크스페이스에서, 어떤 조건의 사건을 받나»(NotifyRoute) 의 목록이 됐다.
//   · 자기 워크스페이스 — 그 워크스페이스 안의 구성원 아이디로 맞춘다(같은 테넌트 = 같은 사람).
//   · 다른 워크스페이스 — 매니지드는 **계정 서버가 확인한 계정 id** 로, 셀프호스트 다중(registry)은
//     박스 전역 신원(구성원 아이디)으로 맞춘다. 어느 워크스페이스를 받을지는 구독 쪽 목록이 정한다(notify-scope.ts).
//  워크스페이스 표시(label)는 **전달할 때** 그 구독의 목록에서 붙인다 — 같은 사건도 받는 쪽마다 «지금 여기»가 다르다.

/** 사건이 난 워크스페이스 — 앱이 배너 윗줄에 이름을 적고, 눌렀을 때 어디로 갈지 고르는 재료. */
export interface NotifyWorkspace {
  /** 워크스페이스(테넌트) slug. 단일 테넌트 배포는 `primary`. */
  slug: string;
  /** 사람에게 보일 이름. 모르면 빈 문자열 — 앱은 그때 워크스페이스 줄을 그리지 않는다. */
  name: string;
  /** 이 스트림을 연 바로 그 워크스페이스의 사건인가. */
  current: boolean;
  /**
   * 그 사건의 화면으로 가는 길.
   *  - `same`   — 이 스트림의 워크스페이스(= 앱 창이 싣는 곳). 주소는 그대로, 해시만 바꾼다.
   *  - `header` — 셀프호스트 다중 워크스페이스: 주소는 같고 **워크스페이스 선택**만 바꾼다(`?lvly_ws=`).
   *  - `enter`  — 매니지드의 다른 워크스페이스: 주소가 다르다. 계정 서버의 입장 주소(`enter`)로 간다.
   */
  via: "same" | "header" | "enter";
  /** `via=enter` 일 때만 — 계정 서버가 준 입장 주소. 착지 해시(`?to=`)는 앱이 붙인다. */
  enter?: string;
  /**
   * `via=enter` 일 때만 — 그 워크스페이스의 웹 화면 주소(`https://<slug>.<테넌트 도메인>/ui/`). 앱은 이것을 **먼저** 연다:
   *  브라우저에 그 워크스페이스 로그인이 있으면 곧장 열리고, 없으면 그 화면의 게이트가 계정 서버 로그인을 거쳐 같은 해시로
   *  되돌려 보낸다(#1771). 입장 주소(`enter`)는 계정 서버 로그인이 없으면 «오류 (401)» 에서 멈춘다 — 그래서 대비책이다.
   */
  url?: string;
}

export interface NotifySessionEvent {
  type: "session";
  /** 세션 id — 앱이 이걸로 그 세션 화면을 연다. */
  id: string;
  /** 화면에 보일 이름(pane 제목 또는 label). 없으면 앱이 폴백한다. */
  name: string;
  /** 직전 단계(모르면 null) · 지금 단계. 해석은 앱이 한다. */
  prev: string | null;
  phase: string;
  /** 같은 사건을 두 번 띄우지 않기 위한 안정 키. */
  key: string;
  ts: number;
  /** 사건이 난 워크스페이스 — 발행 때가 아니라 **전달 때** 그 구독의 목록에서 붙는다. */
  ws?: NotifyWorkspace;
}

/**
 * 구독 하나가 받는 자리 — «이 워크스페이스에서 난, 이 조건에 맞는 사건».
 *  `member`·`account` 중 **하나 이상**이 있어야 한다(둘 다 없으면 아무것도 맞지 않는다 — 열어 두는 기본값은 없다).
 */
export interface NotifyRoute {
  /** 워크스페이스 slug. */
  ws: string;
  /** 그 워크스페이스 안의 구성원 아이디와 같으면 받는다. */
  member?: string;
  /** 계정 서버가 확인한 계정 id 와 같으면 받는다(매니지드의 다른 워크스페이스). */
  account?: string;
  label: NotifyWorkspace;
}

/** 발행 — 어느 워크스페이스에서 누구의 세션이 전이했나. `account` 는 알 때만(매니지드). */
export interface NotifyOrigin {
  ws: string;
  member: string;
  account?: string | null;
}

type Subscriber = (ev: NotifySessionEvent) => void;

interface Sub {
  fn: Subscriber;
  /** 워크스페이스 slug → 자리. 한 워크스페이스에 자리는 하나다(목록이 겹치면 먼저 온 것). */
  routes: Map<string, NotifyRoute>;
  members: Set<string>;
  accounts: Set<string>;
}

/** 구독 핸들 — 목록을 바꾸거나(계정 서버 확인이 뒤늦게 온다) 끊는다. */
export interface NotifySubscription {
  /** 받는 자리를 통째로 바꾼다. 끊긴 뒤에는 아무 일도 하지 않는다. */
  update(routes: NotifyRoute[]): void;
  /** 끊는다 — 연결이 닫힐 때 반드시 부를 것(안 부르면 죽은 소켓이 쌓인다). 여러 번 불러도 안전하다. */
  close(): void;
}

// 발행 한 번에 모든 구독을 훑지 않도록 **맞출 수 있는 열쇠**로 색인한다.
const byMember = new Map<string, Set<Sub>>();
const byAccount = new Map<string, Set<Sub>>();

const norm = (v: unknown): string => String(v ?? "").trim();

function index(map: Map<string, Set<Sub>>, key: string, s: Sub): void {
  let set = map.get(key);
  if (!set) { set = new Set(); map.set(key, set); }
  set.add(s);
}
function unindex(map: Map<string, Set<Sub>>, key: string, s: Sub): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(s);
  if (!set.size) map.delete(key);          // 빈 Set 을 남기지 않는다(멤버 수만큼 누수)
}

/** 목록을 정리한다 — 워크스페이스·조건이 빈 자리는 버린다(아무것도 안 맞는 자리가 색인에 남지 않게). */
function cleanRoutes(routes: readonly NotifyRoute[]): Map<string, NotifyRoute> {
  const out = new Map<string, NotifyRoute>();
  for (const r of routes || []) {
    const ws = norm(r && r.ws);
    const member = norm(r && r.member);
    const account = norm(r && r.account);
    if (!ws || (!member && !account) || out.has(ws)) continue;
    out.set(ws, { ...r, ws, ...(member ? { member } : { member: undefined }), ...(account ? { account } : { account: undefined }) });
  }
  return out;
}

function attach(s: Sub, routes: readonly NotifyRoute[]): void {
  s.routes = cleanRoutes(routes);
  s.members = new Set([...s.routes.values()].map((r) => r.member || "").filter(Boolean));
  s.accounts = new Set([...s.routes.values()].map((r) => r.account || "").filter(Boolean));
  for (const m of s.members) index(byMember, m, s);
  for (const a of s.accounts) index(byAccount, a, s);
}
function detach(s: Sub): void {
  for (const m of s.members) unindex(byMember, m, s);
  for (const a of s.accounts) unindex(byAccount, a, s);
  s.members = new Set();
  s.accounts = new Set();
}

/** 이 자리가 이 발행에 맞나(순수). 구성원 조건과 계정 조건은 **또는**이다 — 자리마다 하나만 쓴다. */
export function routeMatches(route: NotifyRoute, origin: NotifyOrigin): boolean {
  if (!route || !origin || norm(route.ws) !== norm(origin.ws)) return false;
  const member = norm(origin.member);
  const account = norm(origin.account);
  if (route.member && member && norm(route.member) === member) return true;
  if (route.account && account && norm(route.account) === account) return true;
  return false;
}

/** 스트림 하나를 등록한다. 목록이 비어 있어도 핸들은 돌려준다(뒤에 update 로 채울 수 있다). */
export function subscribeNotify(routes: readonly NotifyRoute[], fn: Subscriber): NotifySubscription {
  const s: Sub = { fn, routes: new Map(), members: new Set(), accounts: new Set() };
  let closed = false;
  attach(s, routes);
  return {
    update(next) {
      if (closed) return;
      detach(s);
      attach(s, next);
    },
    close() {
      if (closed) return;
      closed = true;
      detach(s);
      s.routes = new Map();
    },
  };
}

/**
 * 한 사건을 받을 스트림들에 민다. 구독자가 없으면 **아무 일도 하지 않는다** — 앱을 안 켠 사람 때문에 훅 보고
 *  경로가 느려지면 안 된다(이 함수는 핫패스에서 불린다).
 * @returns 실제로 전달한 스트림 수
 */
export function publishNotify(origin: NotifyOrigin, ev: NotifySessionEvent): number {
  const ws = norm(origin && origin.ws);
  const member = norm(origin && origin.member);
  if (!ws || !member) return 0;
  const account = norm(origin.account);
  const candidates = new Set<Sub>(byMember.get(member) ?? []);
  if (account) for (const s of byAccount.get(account) ?? []) candidates.add(s);
  const at: NotifyOrigin = { ws, member, account };
  let n = 0;
  for (const s of candidates) {
    const route = s.routes.get(ws);
    if (!route || !routeMatches(route, at)) continue;
    // 한 스트림이 죽어도 나머지에 계속 보낸다 — 끊긴 소켓 하나가 다른 기기의 알림을 막으면 안 된다.
    try { s.fn({ ...ev, ws: route.label }); n++; } catch { /* 이 스트림은 곧 정리된다 */ }
  }
  return n;
}

/**
 * 계정 조건으로 받는 스트림이 하나라도 있나 — 발행 쪽이 **계정 id 를 찾으러 DB 에 갈지** 이걸로 정한다
 *  (다른 워크스페이스를 받는 앱이 없으면 핫패스에 조회를 더하지 않는다).
 */
export function accountRoutesActive(account?: string): boolean {
  if (account === undefined) return byAccount.size > 0;
  return (byAccount.get(norm(account))?.size ?? 0) > 0;
}

/** 지금 이 사람(구성원 아이디)으로 받는 스트림 수. 진단·테스트용. 인자가 없으면 전체 스트림 수. */
export function notifyStreamCount(memberId?: string): number {
  if (memberId === undefined) {
    const all = new Set<Sub>();
    for (const set of byMember.values()) for (const s of set) all.add(s);
    for (const set of byAccount.values()) for (const s of set) all.add(s);
    return all.size;
  }
  return byMember.get(norm(memberId))?.size ?? 0;
}

/** 전이 하나의 안정 키 — 같은 세션·같은 단계·같은 초는 한 사건이다(재시도·중복 보고 흡수). */
export function sessionEventKey(id: string, phase: string, sec: number): string {
  return `s:${id}:${phase}:${sec}`;
}
