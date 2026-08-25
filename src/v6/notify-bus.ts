// 알림 실시간 버스 (#1842) — **"세션이 끝난 순간"을 기다리지 않고 그 자리에서 앱으로 민다.**
//
// 왜 필요한가: 30초 폴링으로는 "AI 를 여러 개 병렬로 돌리다 끝나는 것마다 바로 받는다"가 성립하지 않는다.
//  그런데 게이트웨이는 이미 그 순간을 정확히 안다 — 하네스 훅이 `POST /api/ui/terminal/sessions/:id/active`
//  로 실행 단계(busy·waiting·idle)를 보고하는 지점(#1221)이 곧 사건이 일어나는 자리다. 폴링은 그 사실을
//  **다시 발견**하려고 30초를 기다린 것이었다.
//
// 범위 — 이 버스는 **한 프로세스 안**이다(인메모리). 게이트웨이는 단일 프로세스로 뜨고(launchd), 훅 보고를
//  받는 것도 SSE 를 물고 있는 것도 같은 프로세스다. 여러 인스턴스로 늘어나면 그때 Redis 등 외부 버스가
//  필요해진다 — 그 전까지 브로커를 들이지 않는다.
//
// ⚠ 이 파일은 **무엇이 알림인지 판정하지 않는다.** 전이 사실(prev→next)만 실어 나른다. 사건의 해석과 문구는
//  앱(desktop/main/notify.mjs)이 한 곳에서 한다 — 서버가 한 번, 앱이 또 한 번 판정하면 실시간 배너와 폴백
//  폴링 배너가 서로 다른 말을 하게 된다(#1571 이 "판정이 두 벌로 갈라진다"고 경계한 그 자리).

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
}

type Subscriber = (ev: NotifySessionEvent) => void;

/** 멤버 → 그 사람이 열어 둔 스트림들. 한 사람이 PC 여러 대에서 앱을 켤 수 있다(슬랙과 같다 — 전부에 뜬다). */
const subs = new Map<string, Set<Subscriber>>();

/** 스트림 하나를 등록한다. 반환된 함수를 부르면 해지된다(연결이 끊길 때 반드시 부를 것 — 안 부르면 샌다). */
export function subscribeNotify(memberId: string, fn: Subscriber): () => void {
  const me = String(memberId || "").trim();
  if (!me) return () => { /* 신원 없는 구독은 만들지 않는다 */ };
  let set = subs.get(me);
  if (!set) { set = new Set(); subs.set(me, set); }
  set.add(fn);
  return () => {
    const s = subs.get(me);
    if (!s) return;
    s.delete(fn);
    if (!s.size) subs.delete(me);        // 빈 Set 을 남기지 않는다(멤버 수만큼 누수)
  };
}

/**
 * 한 사람에게 민다. 구독자가 없으면 **아무 일도 하지 않는다** — 앱을 안 켠 사람 때문에 훅 보고 경로가
 *  느려지면 안 된다(이 함수는 핫패스에서 불린다).
 * @returns 실제로 전달한 스트림 수
 */
export function publishNotify(memberId: string, ev: NotifySessionEvent): number {
  const set = subs.get(String(memberId || "").trim());
  if (!set || !set.size) return 0;
  let n = 0;
  for (const fn of set) {
    // 한 스트림이 죽어도 나머지에 계속 보낸다 — 끊긴 소켓 하나가 다른 기기의 알림을 막으면 안 된다.
    try { fn(ev); n++; } catch { /* 이 스트림은 곧 정리된다 */ }
  }
  return n;
}

/** 지금 이 사람이 앱을 켜 두었나(스트림이 붙어 있나). 진단·테스트용. 인자가 없으면 전체 스트림 수. */
export function notifyStreamCount(memberId?: string): number {
  if (memberId === undefined) { let n = 0; for (const s of subs.values()) n += s.size; return n; }
  return subs.get(String(memberId || "").trim())?.size ?? 0;
}

/** 전이 하나의 안정 키 — 같은 세션·같은 단계·같은 초는 한 사건이다(재시도·중복 보고 흡수). */
export function sessionEventKey(id: string, phase: string, sec: number): string {
  return `s:${id}:${phase}:${sec}`;
}
