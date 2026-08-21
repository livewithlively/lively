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
};

/** 기본 설정 — 사람이 끄기 전까지 셋 다 켠다. */
export const NOTIFY_DEFAULTS = { [NOTIFY.WAITING]: true, [NOTIFY.DONE]: true, [NOTIFY.EXITED]: true };

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
