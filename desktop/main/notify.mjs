// 앱 알림 판정 (#1842) — **세션 스냅샷 두 장을 견줘 '지금 사람을 불러야 할 사건'만 뽑는 순수 함수 모음**.
//  Electron 이 없다(테스트에서 그대로 돌린다). main.mjs 가 이 판정을 배선하고 desktop-core.test.mjs 가 표로 못박는다
//  — web-shell.mjs 와 같은 규약이다.
//
// 왜 앱이 하나 — 알림이 필요한 순간은 정의상 **라이블리 화면을 안 보고 있을 때**다. 화면(웹 UI)이 판정하면 창을 닫는
//  순간 눈이 먼다. 트레이 상주 앱만이 창 없이도 살아 있다(main.mjs `window-all-closed` = noop).
//
// ★ 판정은 `agentState` 가 아니라 `awaiting`·`working` 을 본다 — 이게 이 파일의 핵심이자 유일한 함정이다.
//   `agentState` 는 **탭이 붙어 있을 때만** busy·waiting 을 준다(catalog.ts SessionInfo: "탭=온라인 규칙,
//   2026-07-23 상민님 확정" — 탭이 없으면 offline 이 덮는다). 그 값으로 알림을 만들면 **화면을 열어 둔 사람에게만**
//   알림이 가고, 자리를 뜬 사람(= 알림이 필요한 바로 그 사람)에겐 아무것도 안 뜬다. `awaiting`·`working` 은
//   같은 파일이 "접속 여부와 무관한 신호"라고 명시한 값이고, 회수(reaper)가 승인 대기 세션을 죽이지 않으려고
//   이미 이 값을 쓴다. 알림도 같은 진실을 봐야 한다.

/** 알림 종류 — 사용자가 켠 것만 뜬다(#1842 결정: 세 갈래). */
export const NOTIFY = {
  WAITING: "session_waiting",   // AI 가 내 결정을 기다린다(승인·선택) — 놓치면 AI 가 그대로 멈춰 선다
  DONE: "session_done",         // AI 가 시킨 일을 마쳤다 — 맡겨두고 딴 일 하던 사람에게
  EXITED: "session_exited",     // 세션이 **예기치 않게** 끝났다(사람이 /exit 한 것은 제외 — 자기가 한 일은 알림이 아니다)
  PERSON: "person",             // 사람이 나를 불렀다(멘션·댓글·담당 지정) — 판정은 서버(v6/notify-store.ts)가 한다
};

/** 기본 설정 — 사람이 끄기 전까지 셋 다 켠다. */
export const NOTIFY_DEFAULTS = { [NOTIFY.WAITING]: true, [NOTIFY.DONE]: true, [NOTIFY.EXITED]: true, [NOTIFY.PERSON]: true };

/** 한 번의 폴에서 개별 배너로 띄울 최대 수. 넘으면 한 장으로 묶는다(대량 전이가 알림 폭탄이 되지 않게). */
export const MAX_BANNERS = 3;

/**
 * API 응답(`/api/ui/terminal/sessions`)에서 **판정에 필요한 값만** 뽑은 스냅샷.
 *  - 내 세션만 본다(`owned`) — 남의 세션 상태로 내 화면을 방해하지 않는다. 서버가 이미 사람 단위로 판정해 준다.
 *  - 셸 세션(harness=shell)은 제외 — AI 가 없으니 기다릴 사람도, 마칠 일도 없다(catalog.ts: exited 와 뜻이 다르다).
 * @returns {Map<string, {id:string,name:string,awaiting:boolean,working:boolean,state:string,byUser:boolean,oom:boolean}>}
 */
export function snapshotSessions(sessions) {
  const out = new Map();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || !s.id || !s.owned) continue;
    if (s.harness === "shell") continue;
    out.set(String(s.id), {
      id: String(s.id),
      name: String(s.title || s.label || "").trim() || "이름 없는 세션",
      awaiting: !!s.awaiting,
      working: !!s.working,
      state: String(s.agentState || ""),
      byUser: !!s.exitedByUser,
      oom: !!s.oomKilled,
    });
  }
  return out;
}

/**
 * 스냅샷 두 장 → 알림 이벤트.
 *
 * | 이전 | 지금 | 이벤트 | 왜 |
 * |---|---|---|---|
 * | (스냅샷 없음) | * | **없음** | 콜드스타트 — 앱을 켠 순간 과거가 전부 알림으로 되살아나면 안 된다(#1571 실측 교훈) |
 * | awaiting=false | awaiting=true | WAITING | 사람의 결정을 기다리기 시작한 순간 |
 * | working=true | working=false | DONE | 돌던 작업이 멎었다. 단 같은 순간 awaiting 이면 WAITING 이 이긴다(그건 완료가 아니라 질문이다) |
 * | state≠exited | state=exited | EXITED | 하네스가 끝났다. 사람이 스스로 끝낸 것(byUser)은 뺀다 |
 * | 목록에 없던 세션 | awaiting=true | WAITING | 새 세션이 곧장 승인부터 물을 수 있다(첫 툴 사용) |
 * | 목록에서 사라짐 | — | 없음 | 회수·정리는 사건이 아니다 |
 *
 * ⚠ 전이(edge)로만 만든다 — 상태(level)로 만들면 같은 대기가 폴링마다 다시 떠서 30초마다 같은 배너가 반복된다.
 * @param {Map|null} prev 직전 스냅샷(없으면 콜드스타트)
 * @param {Map} next 방금 받은 스냅샷
 * @param {object} [prefs] 유형별 on/off
 */
export function diffSessions(prev, next, prefs) {
  if (!prev) return [];                                  // 콜드스타트: 기준선만 잡고 아무것도 알리지 않는다
  const on = { ...NOTIFY_DEFAULTS, ...(prefs || {}) };
  const events = [];
  for (const [id, cur] of next) {
    const was = prev.get(id);
    // ① 대기 진입 — 새 세션이면 '대기 아님' 에서 온 것으로 본다(첫 관측이 이미 대기면 알린다)
    if (cur.awaiting && !(was && was.awaiting)) {
      if (on[NOTIFY.WAITING]) events.push({ kind: NOTIFY.WAITING, id, name: cur.name });
      continue;                                          // 한 세션은 한 번에 한 사건만(대기가 완료를 이긴다)
    }
    if (!was) continue;                                  // 새 세션인데 대기도 아니면 알릴 것이 없다
    // ② 종료 — 사람이 스스로 끝낸 것은 뺀다(자기가 한 일을 되알리지 않는다)
    if (cur.state === "exited" && was.state !== "exited") {
      if (!cur.byUser && on[NOTIFY.EXITED]) events.push({ kind: NOTIFY.EXITED, id, name: cur.name, oom: cur.oom });
      continue;
    }
    // ③ 완료 — 돌던 게 멎었다
    if (was.working && !cur.working && !cur.awaiting) {
      if (on[NOTIFY.DONE]) events.push({ kind: NOTIFY.DONE, id, name: cur.name });
    }
  }
  return events;
}

/**
 * 이벤트 → 배너 문구. 제목은 **무슨 일인지**(어느 세션인지는 본문) — macOS·Windows 모두 제목을 굵게 한 줄로
 *  보여주므로, 세션 이름이 길면 제목에 두면 잘려서 무슨 일인지 자체를 잃는다. 슬랙도 제목은 짧은 식별자다.
 *  본문 문구는 어미까지 끝맺는다(ui-copy-complete-sentence-endings).
 */
export function bannerFor(event) {
  const name = String(event.name || "").slice(0, 120);
  if (event.kind === NOTIFY.WAITING) return { title: "확인을 기다려요", body: name + " — 눌러서 이어가세요." };
  if (event.kind === NOTIFY.DONE) return { title: "작업을 마쳤어요", body: name };
  if (event.kind === NOTIFY.EXITED) {
    return { title: event.oom ? "세션이 강제로 종료됐어요" : "세션이 끝났어요",
      body: name + (event.oom ? " — 메모리가 부족해 시스템이 종료했어요." : " — AI 가 더 돌지 않아요.") };
  }
  return { title: "라이블리", body: name };
}

/** 여러 건을 한 장으로 묶을 때의 문구. 종류가 섞이면 '알림'으로 뭉뚱그린다. */
export function digestFor(events) {
  const n = events.length;
  const kinds = new Set(events.map((e) => e.kind));
  if (kinds.size === 1 && kinds.has(NOTIFY.WAITING)) return { title: "확인을 기다려요", body: `세션 ${n}개가 내 결정을 기다리고 있어요.` };
  if (kinds.size === 1 && kinds.has(NOTIFY.DONE)) return { title: "작업을 마쳤어요", body: `세션 ${n}개가 일을 끝냈어요.` };
  return { title: "라이블리", body: `새 알림이 ${n}개 있어요.` };
}

/** 배너를 몇 장 띄울지 — 적으면 개별로, 많으면 묶음 한 장으로. 순수 판정이라 표로 못박는다. */
export function planBanners(events, max = MAX_BANNERS) {
  if (!events.length) return [];
  if (events.length <= max) return events.map((e) => ({ ...bannerFor(e), event: e }));
  return [{ ...digestFor(events), event: null }];
}

/**
 * 세션 화면으로 가는 해시. **id 를 검증한다** — 이 문자열은 웹 창의 주소로 들어가므로, 서버 응답을 그대로
 *  믿고 붙이면 게이트웨이가 깨졌을 때 임의 주소로 튄다. 세션 id 는 `box-<사람>-<hex>` 꼴이다.
 * @returns {string|null} 형식이 아니면 null(그 경우 호출부는 그냥 앱 창만 띄운다)
 */
export function sessionHash(id) {
  const s = String(id || "");
  return /^[A-Za-z0-9_.-]{1,120}$/.test(s) ? "#/s/" + s : null;
}

// ── 사람 알림 (#1842 2차) ────────────────────────────────────────────────────
// 세션 알림과 **판정 위치가 다르다**: 세션은 스냅샷 두 장을 앱이 견주지만(서버엔 '전이'라는 개념이 없다),
//  사람 알림은 서버가 "since 이후 나에게 온 것"을 이미 골라 준다(/api/ui/notify/feed). 앱이 할 일은
//  ① 처음 켰을 땐 기준선만 잡고 ② 이미 띄운 것을 다시 안 띄우는 것, 둘뿐이다.
//
// ⚠ 커서(since)만으로는 중복을 못 막는다. 폴 경계에 걸친 사건은 두 번 잡힐 수 있고(같은 초에 들어온 것),
//  시계가 뒤로 갈 수도 있다. 그래서 **본 것의 key 를 따로 기억한다** — #1571 이 같은 이유로 커서를
//  신뢰의 근거로 쓰지 말라고 못박았다("중복 방지는 항상 유니크 인덱스가 책임진다").

/** 이미 띄운 사람 알림 key 를 기억하는 상한 — 넘으면 오래된 것부터 잊는다(메모리 상한). */
export const SEEN_MAX = 300;

/**
 * 서버 피드 → 배너로 띄울 것.
 * @param {Array} items /api/ui/notify/feed 의 items
 * @param {Set<string>|null} seen 이미 띄운 key(호출자가 들고 있다). **null 이면 콜드스타트** — 기준선만 잡는다
 * @param {object} [prefs] 유형별 on/off
 * @returns {Array} 배너로 만들 이벤트(호출자가 seen 에 넣는다)
 */
export function pickPersonEvents(items, seen, prefs) {
  const on = { ...NOTIFY_DEFAULTS, ...(prefs || {}) };
  const rows = Array.isArray(items) ? items : [];
  if (!seen) return [];                              // 콜드스타트: 앱을 켠 순간 지난 24시간이 배너로 쏟아지면 안 된다
  if (!on[NOTIFY.PERSON]) return [];
  const out = [];
  for (const it of rows) {
    const key = String(it && it.key || "");
    if (!key || seen.has(key)) continue;
    out.push({ kind: NOTIFY.PERSON, id: null, key, link: personLink(it && it.link),
      title: String(it.text && it.text.title || "라이블리"), body: String(it.text && it.text.body || "") });
  }
  return out;
}

/** 본 key 를 기록하고 상한을 넘으면 오래된 것부터 버린다(Set 은 삽입 순서를 지킨다). */
export function rememberSeen(seen, events, max = SEEN_MAX) {
  for (const e of events) if (e.key) seen.add(e.key);
  while (seen.size > max) seen.delete(seen.values().next().value);
  return seen;
}

/**
 * 사람 알림이 가리키는 화면 해시. 서버가 준 값이라도 **형식을 다시 본다** — 그 문자열이 웹 창의 주소가 되므로,
 *  게이트웨이가 깨졌거나 중간에 바뀌었을 때 임의 주소로 튀는 길을 두지 않는다(sessionHash 와 같은 이유).
 * @returns {string|null} `#/…` 형태가 아니면 null → 호출부는 앱 창만 띄운다
 */
export function personLink(link) {
  const s = String(link || "");
  return /^#\/[A-Za-z0-9/_.:%-]{1,200}$/.test(s) ? s : null;
}

/** 여러 건이면 개별 배너 대신 한 장으로 — 세션 쪽 planBanners 와 같은 규칙을 사람 알림에도 적용한다. */
export function planPersonBanners(events, max = MAX_BANNERS) {
  if (!events.length) return [];
  if (events.length <= max) return events.map((e) => ({ title: e.title, body: e.body, event: e }));
  return [{ title: "라이블리", body: `새 알림이 ${events.length}개 있어요.`, event: null }];
}

// ── 실시간 스트림 (#1842 3차) ────────────────────────────────────────────────
// 30초 폴링으로는 "AI 를 여러 개 병렬로 돌리다 끝나는 것마다 바로 받는다"가 성립하지 않는다. 게이트웨이는
//  하네스 훅 보고를 받는 순간 이미 그 사실을 아니까(#1221), 그 순간을 SSE 로 밀어 준다(/api/ui/notify/stream).
//
// ⚠ 신호원이 둘이 됐다 — **같은 사건을 다른 축으로 표현한다.** 헷갈리면 중복 배너가 된다:
//   · 스트림: 하네스가 보고한 **실행 단계 전이**(busy·waiting·idle). 사건이 일어난 그 순간.
//   · 폴링:  세션 목록의 **awaiting·working 플래그**. 30초마다 스냅샷 두 장을 견준 결과.
//  그래서 **스트림이 붙어 있는 동안 폴링은 배너를 만들지 않는다**(스냅샷 갱신만 계속한다 — 연결이 끊기면
//  폴링이 그 자리에서 이어받아야 하므로 기준선은 늘 최신이어야 한다). main.mjs 가 그 게이팅을 한다.

/**
 * 실행 단계 전이 → 알림 종류. **판정은 여기 한 곳**이다(서버는 사실만 싣고 해석하지 않는다).
 *
 * | prev | phase | 결과 | 왜 |
 * |---|---|---|---|
 * | ≠waiting | waiting | WAITING | 사람의 결정을 기다리기 시작했다 |
 * | busy | idle | DONE | 돌던 작업이 끝났다 — **이게 병렬 세션에서 가장 자주 기다리는 신호다** |
 * | (없음) | idle | 없음 | 첫 보고가 idle 이면 '끝난 것'이 아니라 그냥 쉬고 있는 것이다 |
 * | idle | busy | 없음 | 일을 시작한 건 알릴 일이 아니다 |
 * | 같은 값 | 같은 값 | 없음 | 하트비트(서버가 애초에 전이로 안 친다) |
 */
export function phaseEventKind(prev, phase) {
  if (phase === "waiting" && prev !== "waiting") return NOTIFY.WAITING;
  if (phase === "idle" && prev === "busy") return NOTIFY.DONE;
  return null;
}

/** 스트림 이벤트 → 배너로 만들 사건(끈 종류·이미 본 key 는 거른다). 없으면 null. */
export function streamEvent(ev, seen, prefs) {
  if (!ev || ev.type !== "session" || !ev.id) return null;
  const kind = phaseEventKind(ev.prev ?? null, ev.phase);
  if (!kind) return null;
  const on = { ...NOTIFY_DEFAULTS, ...(prefs || {}) };
  if (!on[kind]) return null;
  const key = String(ev.key || `s:${ev.id}:${ev.phase}`);
  if (seen && seen.has(key)) return null;              // 재연결 직후 같은 사건이 다시 올 수 있다
  return { kind, id: String(ev.id), key, name: String(ev.name || "").trim() || "이름 없는 세션" };
}

/**
 * SSE 바이트 조각 → 이벤트. 프레임은 빈 줄로 끝나므로 **마지막 미완성 프레임은 버퍼에 남긴다**
 *  (그걸 그냥 파싱하면 반쪽 JSON 을 만나 조용히 사건을 잃는다).
 * @returns {{events: object[], rest: string}}
 */
export function parseSse(buffer) {
  const parts = String(buffer || "").split("\n\n");
  const rest = parts.pop() ?? "";                       // 마지막 조각은 아직 안 끝났다
  const events = [];
  for (const frame of parts) {
    const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
    if (!data) continue;                                // 주석(`: ping`)·이벤트명만 있는 프레임
    try { events.push(JSON.parse(data)); } catch { /* 깨진 프레임 하나가 스트림을 끊지 않는다 */ }
  }
  return { events, rest };
}

/** 재연결 대기(ms) — 지수 백오프에 상한. 게이트웨이가 재시작 중일 때 초당 재접속으로 때리지 않는다. */
export function reconnectDelay(attempt) {
  const n = Math.max(0, Number(attempt) || 0);
  return Math.min(30_000, 1_000 * Math.pow(2, Math.min(n, 5)));   // 1s 2 4 8 16 32→30s 상한
}
