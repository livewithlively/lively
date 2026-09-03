// 실패 위탁 세션 회수(#1675 ①) — 사양 엣지 표 21~35행(<스크래치패드>/spec.md).
//  이 판정이 틀리면: 너무 적게 걷으면 어니스트 2026-08-12 재발(세션 2,300개 → 스왑 고갈 → 박스 다운),
//  너무 많이 걷으면 검시 대상을 잃는다(실패 원인을 못 본다).
import { strict as assert } from "node:assert";
import { planFailedSessionReap, reapFailedTaskSessions, reapBackoffMs, decideReap, isBackedOff, type FailedTaskRow, type ReapAttempt } from "./failed-session-reaper.js";

const NOW = new Date("2026-08-13T00:00:00.000Z").getTime();
const minsAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();
/** 최신(1분 전) → 오래된(5분 전) 순 5건. */
const FIVE = [
  { id: 1, finished_at: minsAgo(1) },
  { id: 2, finished_at: minsAgo(2) },
  { id: 3, finished_at: minsAgo(3) },
  { id: 4, finished_at: minsAgo(4) },
  { id: 5, finished_at: minsAgo(5) },
];

// ── ㉑ 상한 미만이면 아무것도 안 걷는다 ──
{
  const p = planFailedSessionReap(FIVE.slice(0, 3), { keep: 5, ttlMin: 0, now: NOW });
  assert.deepEqual(p.reap, [], "상한에 여유가 있는데 걷었다 — 검시 대상을 잃는다");
  assert.equal(p.keep.length, 3);
}
// ── ㉒ 최신 keep 건만 남기고 나머지는 걷는다 ──
{
  const p = planFailedSessionReap(FIVE, { keep: 2, ttlMin: 0, now: NOW });
  assert.deepEqual(p.keep, [1, 2], "최신 2건이 안 남았다");
  assert.deepEqual(p.reap.sort((a, b) => a - b), [3, 4, 5], "상한 밖을 안 걷었다 — 무한 누적으로 돌아간다");
}
// ── ㉓㉔ 경계 — keep=0 은 '보존 끔', 음수도 같다 ──
for (const keep of [0, -1]) {
  const p = planFailedSessionReap(FIVE, { keep, ttlMin: 0, now: NOW });
  assert.equal(p.keep.length, 0, `keep=${keep} 인데 남겼다`);
  assert.equal(p.reap.length, 5, `keep=${keep} 인데 전부 안 걷었다`);
}
// ── ㉕ 부재 엣지 ──
{
  const p = planFailedSessionReap([], { keep: 5, ttlMin: 60, now: NOW });
  assert.deepEqual(p.reap, []);
  assert.deepEqual(p.keep, []);
}
// ── ㉖ TTL 이 개수 상한을 이긴다 — 여유가 있어도 오래된 건 걷는다 ──
{
  const rows = [{ id: 1, finished_at: minsAgo(1) }, { id: 2, finished_at: minsAgo(120) }];
  const p = planFailedSessionReap(rows, { keep: 5, ttlMin: 60, now: NOW });
  assert.deepEqual(p.reap, [2], "TTL 초과분을 안 걷었다 — 실패가 드문 박스에서 영원히 남는다");
  assert.deepEqual(p.keep, [1]);
}
// ── ㉗ TTL=0 은 무제한 ──
{
  const rows = [{ id: 9, finished_at: minsAgo(60 * 24 * 30) }];
  const p = planFailedSessionReap(rows, { keep: 5, ttlMin: 0, now: NOW });
  assert.deepEqual(p.reap, [], "TTL 끔(0)인데 시간으로 걷었다");
}
// ── ㉘ ★정렬 비의존 — 호출부가 역순으로 줘도 '최근 N건'의 뜻이 안 변해야 한다 ──
{
  const p = planFailedSessionReap([...FIVE].reverse(), { keep: 2, ttlMin: 0, now: NOW });
  assert.deepEqual(p.keep, [1, 2], "입력 정렬이 뒤집히자 오래된 것을 남겼다 — 쿼리 한 줄에 의미가 매달린다");
}
// ── ㉙㉚㉛ 시각 불명 — TTL 로는 안 죽이고, 개수 상한에서는 가장 오래된 취급 ──
{
  const p = planFailedSessionReap([{ id: 7, finished_at: null }], { keep: 5, ttlMin: 1, now: NOW });
  assert.deepEqual(p.reap, [], "시각을 모르는 건을 TTL 로 죽였다 — 모르면 건드리지 않는다");
}
for (const bad of [null, "not-a-date"]) {
  const rows = [{ id: 7, finished_at: bad as string | null }, { id: 1, finished_at: minsAgo(1) }];
  const p = planFailedSessionReap(rows, { keep: 1, ttlMin: 0, now: NOW });
  assert.deepEqual(p.keep, [1], `시각 불명(${bad})이 최신을 밀어냈다`);
  assert.deepEqual(p.reap, [7]);
}
// ── ㉜ TTL 경계값 — 정확히 cutoff 시각은 아직 살아 있다 ──
{
  const rows = [{ id: 1, finished_at: new Date(NOW - 60 * 60_000).toISOString() }];
  const p = planFailedSessionReap(rows, { keep: 0, ttlMin: 60, now: NOW });
  // keep=0 이므로 개수로는 어차피 걷힌다. TTL 축만 보려면 keep 여유를 줘야 한다.
  assert.equal(p.reap.length, 1, "keep=0 인데 안 걷었다");
  const p2 = planFailedSessionReap(rows, { keep: 5, ttlMin: 60, now: NOW });
  assert.deepEqual(p2.reap, [], "정확히 TTL 경계인 건을 걷었다 — 경계는 아직 유효해야 한다");
}

// ── ㉝㉞㉟ 부작용 계약 ──
const row = (id: number, mins: number): FailedTaskRow =>
  ({ id, finished_at: minsAgo(mins), node_id: "central", session_id: `box-s${id}`, requester: "yoon" });

// ㉝㉞ kill 이 실패한 건은 **걷었다고 표시하지 않는다** — 표시하면 그 세션은 영원히 남는다.
{
  const marked: number[][] = [];
  const killed: number[] = [];
  const r = await reapFailedTaskSessions(
    async (t) => { if (t.id === 4) throw new Error("노드 이탈"); killed.push(t.id); return { done: true }; },
    { keep: 1, ttlMin: 0 },
    {
      list: async () => [row(1, 1), row(3, 3), row(4, 4)], mark: async (ids) => { marked.push(ids); },
      markAttempt: async () => { /* noop */ }, markGaveUp: async () => { /* noop */ }, alert: async () => ({ sent: false }),
      now: () => NOW,
    },
  );
  assert.deepEqual(killed.sort(), [3], "kill 대상이 틀렸다");
  assert.equal(r.failed, 1, "kill 실패를 세지 않았다");
  assert.deepEqual(marked, [[3]], "kill 실패분까지 걷었다고 표시했다 — 그 세션은 다시는 회수되지 않는다");
  assert.equal(r.reaped, 1);
  assert.equal(r.kept, 1);
}
// ㉟ 조회 실패는 삼킨다(스케줄러 tick 을 깨면 위탁 감시가 멈춘다).
{
  let killCount = 0;
  const r = await reapFailedTaskSessions(
    async () => { killCount++; return { done: true }; },
    { keep: 0, ttlMin: 0 },
    { list: async () => { throw new Error("DB 순단"); }, mark: async () => { /* noop */ }, now: () => NOW },
  );
  assert.equal(r.scanned, 0);
  assert.equal(r.reaped, 0);
  assert.equal(killCount, 0, "조회가 실패했는데 kill 을 쐈다");
}
// 배선 확인 — 걷을 게 없으면 mark 를 부르지 않는다(빈 UPDATE 낭비 방지).
{
  let markCalls = 0;
  await reapFailedTaskSessions(
    async () => ({ done: true }),
    { keep: 10, ttlMin: 0 },
    { list: async () => [row(1, 1)], mark: async () => { markCalls++; }, now: () => NOW },
  );
  assert.equal(markCalls, 0, "걷을 게 없는데 mark 를 불렀다");
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// #2622 — 영구 실패의 종료 조건. 사양 엣지 표 ①~⑭(<스크래치패드>/spec.md).
//  이 판정이 틀리면: 너무 쉽게 포기하면 살아 있는 세션이 영구 누수되고(#1675 가 없애려던 그것),
//  끝을 안 만들면 게이트웨이가 이틀째 초당 수십 회 헛돈다(#2622 실측 — 로그의 88%).
// ══════════════════════════════════════════════════════════════════════════════════════════

/** 부작용 관측대 — 진짜 DB·경보를 절대 안 건드리고, 무엇이 실제로 불렸는지만 남긴다. */
interface Spy {
  killed: number[];
  marked: number[][];
  attempts: Array<{ id: number; fails: number; nextAt: string }>;
  gaveUp: Array<{ id: number; fails: number; why: string }>;
  alerts: Array<{ title: string; detail: Record<string, unknown> }>;
}
function spy(): Spy { return { killed: [], marked: [], attempts: [], gaveUp: [], alerts: [] }; }
function deps(sp: Spy, rows: FailedTaskRow[]) {
  return {
    list: async (): Promise<FailedTaskRow[]> => rows,
    mark: async (ids: number[]): Promise<void> => { sp.marked.push(ids); },
    markAttempt: async (id: number, fails: number, nextAt: string): Promise<void> => { sp.attempts.push({ id, fails, nextAt }); },
    markGaveUp: async (id: number, fails: number, why: string): Promise<void> => { sp.gaveUp.push({ id, fails, why }); },
    alert: async (a: { title: string; detail: Record<string, unknown> }): Promise<{ sent: boolean }> => { sp.alerts.push({ title: a.title, detail: a.detail }); return { sent: true }; },
    now: (): number => NOW,
  };
}
/** 회수 대상 1건 — keep=0 이라 항상 plan.reap 에 들어간다. */
const stuck = (id: number, extra: Partial<FailedTaskRow> = {}): FailedTaskRow =>
  ({ id, finished_at: minsAgo(60 * 48), node_id: "hammurabi", session_id: `box-yoon-${id}`, requester: "yoon", ...extra });

const kill = (r: ReapAttempt) => async (): Promise<ReapAttempt> => r;

// ── ① 확실히 없어졌다 → 걷음 기록. 미룸·포기 없음 ──
{
  const sp = spy();
  const r = await reapFailedTaskSessions(async (t) => { sp.killed.push(t.id); return { done: true }; },
    { keep: 0, ttlMin: 0 }, deps(sp, [stuck(1)]));
  assert.deepEqual(sp.killed, [1], "배선 확인 — kill 스텁이 아예 안 불렸다(이 테스트는 아무것도 안 보고 있다)");
  assert.deepEqual(sp.marked, [[1]], "걷었는데 표시하지 않았다 — 다음 tick 이 같은 세션을 또 친다");
  assert.equal(sp.attempts.length, 0, "성공했는데 재시도를 예약했다");
  assert.equal(r.reaped, 1);
}
// ── ② ★멱등 회수 — kill 이 실패해도 「그 세션은 이미 없다」 확답이면 회수 성공 ──
//  #2622 의 실제 모양이다: 세션이 이미 없어 노드가 403 을 냈고, 종전 코드는 그걸 「닿지 못함」으로 읽어
//  이틀을 재시도했다. 반대로 「모르겠다(null)」를 성공으로 접으면 #1675 리뷰가 잡은 거짓 성공이 된다.
{
  //  kill 성공 · 확답 무관 → 회수
  assert.equal(decideReap(true, null).done, true, "kill 이 성공했는데 회수로 안 봤다");
  assert.equal(decideReap(true, false).done, true, "kill 성공은 확답과 무관하게 회수다");
  //  kill 실패 + 「없다」 확답 → 회수(멱등)
  assert.equal(decideReap(false, true).done, true, "「그 세션은 이미 없다」 확답을 받고도 안 걷었다 — 이게 이틀 핫루프의 원인이다");
  //  ⚠ kill 실패 + 「모르겠다」 → 회수 아님
  assert.equal(decideReap(false, null, "node-offline").done, false,
    "판정 불가를 회수로 접었다 — 노드가 돌아오면 멀쩡히 살아 있는 세션을 영구 누수시킨다(#1675 리뷰 ②)");
  //  kill 실패 + 「살아있다」 확답 → 회수 아님
  assert.equal(decideReap(false, false, "x").done, false, "살아 있다는 확답을 받고도 걷었다고 기록했다");
  //  실패 사유는 원문 그대로 흘러야 한다
  assert.equal(decideReap(false, null, "본인 세션이 아닙니다").why, "본인 세션이 아닙니다", "실패 사유 원문을 잃었다");

  //  회수기까지의 배선 — done:true 면 마킹하고 재시도를 예약하지 않는다.
  const sp = spy();
  const r = await reapFailedTaskSessions(kill(decideReap(false, true)),
    { keep: 0, ttlMin: 0 }, deps(sp, [stuck(1)]));
  assert.deepEqual(sp.marked, [[1]], "멱등 회수를 마킹하지 않았다");
  assert.equal(sp.attempts.length, 0, "이미 없는 세션에 재시도를 예약했다");
  assert.equal(r.reaped, 1);
}
// ── ③ 시도 실패 + 확답 없음 → 마킹 안 함 + 다음 시도 예약 ──
{
  const sp = spy();
  const r = await reapFailedTaskSessions(kill({ done: false, why: "node-offline" }),
    { keep: 0, ttlMin: 0 }, deps(sp, [stuck(1)]));
  assert.deepEqual(sp.marked, [[]], "못 걷었는데 걷었다고 표시했다 — 그 세션은 영원히 남는다(#1675 리뷰 ②)");
  assert.equal(sp.attempts.length, 1, "실패했는데 다음 시도를 안 미뤘다 — 종료 조건 없는 핫루프로 돌아간다");
  assert.equal(sp.attempts[0].fails, 1);
  assert.ok(Date.parse(sp.attempts[0].nextAt) > NOW, "다음 시도 시각이 과거다 — 미룬 게 아니다");
  assert.equal(r.failed, 1);
}
// ── ④ ★핵심 — 미룬 시각 전에는 시도 자체를 안 한다(영구 실패가 늘어도 tick 이 안 늘어난다) ──
{
  const sp = spy();
  const future = new Date(NOW + 10 * 60_000).toISOString();
  const rows = Array.from({ length: 31 }, (_, i) => stuck(i + 1, { reap_fails: 3, reap_next_at: future }));
  const r = await reapFailedTaskSessions(async (t) => { sp.killed.push(t.id); return { done: false, why: "x" }; },
    { keep: 0, ttlMin: 0 }, deps(sp, rows));
  assert.equal(sp.killed.length, 0, "백오프 중인데 kill 을 쐈다 — 31건이면 tick 마다 31번, 이게 로그의 88% 였다");
  assert.equal(sp.attempts.length, 0, "시도도 안 했는데 재시도를 다시 예약했다(쓸데없는 DB 쓰기)");
  assert.equal(r.backedOff, 31, "백오프로 건너뛴 건수를 안 셌다 — 제동이 걸렸는지 볼 수가 없다");
  assert.equal(r.failed, 0);
}
// ── ⑤ 미룬 시각이 지났으면 다시 시도한다 ──
{
  const sp = spy();
  const past = new Date(NOW - 1_000).toISOString();
  const r = await reapFailedTaskSessions(async (t) => { sp.killed.push(t.id); return { done: true }; },
    { keep: 0, ttlMin: 0 }, deps(sp, [stuck(1, { reap_fails: 3, reap_next_at: past })]));
  assert.deepEqual(sp.killed, [1], "백오프가 끝났는데 시도하지 않았다 — 영원히 안 걷힌다");
  assert.equal(r.backedOff, 0);
}
// ── ⑥ 경계 — 연속 실패가 상한에 정확히 도달하면 포기(걷었다고는 하지 않는다) + 알림 ──
{
  const sp = spy();
  // GIVE_UP_AFTER=10 → 이미 9회 실패한 건이 한 번 더 실패하면 10회 = 상한 도달.
  const r = await reapFailedTaskSessions(kill({ done: false, reached: true, why: "본인 세션이 아닙니다" }),
    { keep: 0, ttlMin: 0 }, deps(sp, [stuck(1, { reap_fails: 9 })]));
  assert.equal(sp.gaveUp.length, 1, "상한에 닿았는데 포기하지 않았다 — 끝이 없다");
  assert.equal(sp.gaveUp[0].fails, 10);
  assert.deepEqual(sp.marked, [[]], "포기를 '걷었다'로 표시했다 — 못 걷은 세션을 걷었다고 거짓말한 것이다");
  assert.equal(sp.alerts.length, 1, "포기했는데 아무도 모른다 — #1675 가 없애려던 '아무도 몰랐다' 모드다");
  assert.equal(r.gaveUp, 1);
  assert.equal(r.failed, 0, "포기한 건을 '재시도할 실패'로도 셌다(이중 계상)");
}
// ── ⑦ 경계 — 상한 직전이면 아직 포기하지 않는다 ──
{
  const sp = spy();
  const r = await reapFailedTaskSessions(kill({ done: false, reached: true, why: "본인 세션이 아닙니다" }),
    { keep: 0, ttlMin: 0 }, deps(sp, [stuck(1, { reap_fails: 8 })]));
  assert.equal(sp.gaveUp.length, 0, "상한 직전(9회)에서 포기했다 — 오프바이원, 한 번 일찍 누수를 만든다");
  assert.equal(sp.attempts.length, 1);
  assert.equal(sp.attempts[0].fails, 9);
  assert.equal(r.gaveUp, 0);
}
// ── ⑧ 한 tick 에 여러 건이 포기해도 알림은 1건 ──
{
  const sp = spy();
  const rows = [1, 2, 3].map((i) => stuck(i, { reap_fails: 9 }));
  await reapFailedTaskSessions(kill({ done: false, reached: true, why: "본인 세션이 아닙니다" }),
    { keep: 0, ttlMin: 0 }, deps(sp, rows));
  assert.equal(sp.gaveUp.length, 3, "3건 다 포기해야 한다");
  assert.equal(sp.alerts.length, 1, "포기 건수만큼 경보를 보냈다 — 31건이면 알림 31개다(#1675 쿨다운 교훈)");
  assert.deepEqual(sp.alerts[0].detail.tasks, [1, 2, 3], "경보가 어떤 태스크인지 안 싣는다 — 받아도 손쓸 데가 없다");
}
// ── ⑨ 실패 횟수·다음시도 칸이 부재(구 행) → 첫 실패로 취급 ──
//  이번에 새로 도입한 칸이라, 이미 DB 에 있던 행에는 아예 없다.
{
  const sp = spy();
  const bare: FailedTaskRow = { id: 1, finished_at: minsAgo(60), node_id: "hammurabi", session_id: "box-yoon-1", requester: "yoon" };
  await reapFailedTaskSessions(kill({ done: false, why: "x" }), { keep: 0, ttlMin: 0 }, deps(sp, [bare]));
  assert.equal(sp.attempts.length, 1, "칸이 없는 구 행을 아예 처리하지 못했다");
  assert.equal(sp.attempts[0].fails, 1, "칸 부재를 첫 실패로 세지 않았다");
}
// ── ⑩ 다음시도 값이 깨져 있으면 미룸 없는 것으로 보고 시도한다 ──
//  파싱 실패가 회수를 영영 멈추게 하면, 그건 우리가 만든 새 영구 실패다.
{
  for (const bad of ["", "언젠가", "2026-13-45T99:99:99Z"]) {
    const sp = spy();
    await reapFailedTaskSessions(async (t) => { sp.killed.push(t.id); return { done: true }; },
      { keep: 0, ttlMin: 0 }, deps(sp, [stuck(1, { reap_fails: 2, reap_next_at: bad })]));
    assert.deepEqual(sp.killed, [1], `다음시도 값이 '${bad}' 라고 시도를 건너뛰었다 — 오염 한 번에 회수가 영구 정지한다`);
  }
}
// ── ⑯ ★못 닿는 노드는 포기하지 않는다 — 잠든 노트북은 돌아온다 ──
//  실측(2026-09-04 셀프호스트 게이트웨이): 이 로그를 채운 상위 넷이 전부 사람 노트북이었다
//  (haruui-macbookair 21,414 · hammurabi 549 · honest-ai-pilot 366 · win-e2e-1541 183).
//  2시간 만에 포기하면 노트북이 돌아와도 그 세션은 **아무도 다시 안 걷는다** = #1675 ★② 의 영구 누수.
{
  //  상한을 훌쩍 넘겨도(99회) 못 닿았으면 포기하지 않고 백오프만 계속한다.
  const sp = spy();
  const r = await reapFailedTaskSessions(kill({ done: false, reached: false, why: "node-offline" }),
    { keep: 0, ttlMin: 0 }, deps(sp, [stuck(1, { reap_fails: 99 })]));
  assert.equal(sp.gaveUp.length, 0,
    "못 닿는 노드를 포기했다 — 잠든 노트북이 돌아와도 그 세션은 아무도 다시 안 걷는다(#1675 ★② 재발)");
  assert.equal(sp.alerts.length, 0, "못 닿았을 뿐인데 사람을 불렀다");
  assert.equal(sp.attempts.length, 1, "포기도 안 하고 재시도 예약도 안 했다 — 그 세션은 미아가 된다");
  assert.equal(r.gaveUp, 0);
  assert.equal(r.failed, 1);

  //  대비 — 같은 횟수여도 **노드가 답을 했으면** 포기한다(회복될 길이 없다).
  const sp2 = spy();
  await reapFailedTaskSessions(kill({ done: false, reached: true, why: "본인 세션이 아닙니다" }),
    { keep: 0, ttlMin: 0 }, deps(sp2, [stuck(1, { reap_fails: 99 })]));
  assert.equal(sp2.gaveUp.length, 1, "노드가 답을 하고도 안 되는데 영원히 재시도한다 — 끝이 없다");

  //  decideReap 이 reached 를 옳게 정한다 — 「살아있다」 확답도 닿은 것이다.
  assert.equal(decideReap(false, null, "node-offline", false).reached, false, "못 닿았는데 닿았다고 했다");
  assert.equal(decideReap(false, null, "본인 세션이 아닙니다", true).reached, true, "노드가 답했는데 못 닿았다고 했다");
  assert.equal(decideReap(false, false, "x", false).reached, true, "「살아있다」 확답을 받았으면 닿은 것이다");
}
// ── ⑮ ★수정이 스스로 만든 새 영구 실패 — 상한 밖 미래는 백오프로 인정하지 않는다 ──
//  사다리 끝(30분)보다 먼 미래가 그 칸에 들어가면 그 태스크는 영원히 건너뛰어져 **포기에도 안 닿는다**.
//  이 프로젝트가 없애려는 「종료 조건 없는 상태」를 수정이 다시 만드는 자리다.
{
  const min = 60_000;
  assert.equal(isBackedOff(null, NOW), false, "칸이 없는데 건너뛰었다");
  assert.equal(isBackedOff(undefined, NOW), false, "칸이 없는데 건너뛰었다");
  assert.equal(isBackedOff("언젠가", NOW), false, "읽을 수 없는 값에 건너뛰었다");
  assert.equal(isBackedOff(new Date(NOW - min).toISOString(), NOW), false, "이미 지난 시각인데 건너뛰었다");
  assert.equal(isBackedOff(new Date(NOW + 10 * min).toISOString(), NOW), true, "정상 백오프 중인데 시도했다");
  assert.equal(isBackedOff(new Date(NOW + 29 * min).toISOString(), NOW), true, "사다리 안(29분)인데 시도했다");
  assert.equal(isBackedOff("3000-01-01T00:00:00.000Z", NOW), false,
    "상한 밖 먼 미래를 백오프로 인정했다 — 그 태스크는 영원히 건너뛰어져 포기에도 안 닿는다");

  //  회수기 배선 — 먼 미래 값이 박혀 있어도 회수는 계속된다.
  const sp = spy();
  await reapFailedTaskSessions(async (t) => { sp.killed.push(t.id); return { done: true }; },
    { keep: 0, ttlMin: 0 }, deps(sp, [stuck(1, { reap_fails: 2, reap_next_at: "3000-01-01T00:00:00.000Z" })]));
  assert.deepEqual(sp.killed, [1], "먼 미래 값 하나로 그 세션의 회수가 영구 정지했다");
}
// ── ⑪⑫ 백오프 사다리 경계 — 0회는 즉시, 사다리를 넘으면 포화 ──
{
  assert.equal(reapBackoffMs(0), 0, "실패 0회인데 기다린다");
  assert.equal(reapBackoffMs(-1), 0, "음수 실패 횟수에서 대기가 생겼다");
  assert.ok(reapBackoffMs(1) > 0, "첫 실패에 대기가 없다 — 5초 tick 이 그대로 핫루프다");
  const ladder = [1, 2, 3, 4, 5, 6, 7, 8, 9, 50, 5000].map(reapBackoffMs);
  for (let i = 1; i < ladder.length; i++) assert.ok(ladder[i] >= ladder[i - 1], "백오프가 줄었다");
  assert.equal(reapBackoffMs(5000), reapBackoffMs(7), "사다리 끝에서 포화하지 않는다 — 대기가 무한히 길어진다");
  assert.ok(reapBackoffMs(5000) <= 60 * 60_000, "포화값이 1시간을 넘는다 — 노드가 돌아와도 한참 안 걷는다");
}
// ── ⑬ 포기 기록이 있는 행은 회수 대상 조회에서 제외된다(구조 단언) ──
//  조회는 SQL 이라 순수 함수로 못 부른다. 대신 **그 조건이 쿼리에 실제로 있는지**를 잠근다 —
//  빠지면 포기한 행을 다시 집어 들어 #2622 의 핫루프가 그대로 되살아난다.
{
  const src = await (await import("node:fs/promises")).readFile(new URL("./failed-session-reaper.ts", import.meta.url), "utf8")
    .catch(async () => (await import("node:fs/promises")).readFile("src/node/failed-session-reaper.ts", "utf8"));
  assert.match(src, /session_reap_gave_up'\)\s*IS NULL/, "회수 대상 조회가 '포기한 행'을 제외하지 않는다 — 포기가 포기가 아니게 된다");
  assert.match(src, /session_reaped'\)\s*IS NULL/, "회수 대상 조회가 '이미 걷은 행'을 제외하지 않는다");
}
// ── ⑭ 실패 사유는 시도자가 준 원문 그대로 기록된다 ──
//  종전엔 호출부가 노드 원문을 버리고 「닿지 못함」이라는 합성 문구만 남겨, 이틀치 로그로도 원인을 못 봤다.
{
  const sp = spy();
  await reapFailedTaskSessions(kill({ done: false, reached: true, why: "본인 세션이 아닙니다" }),
    { keep: 0, ttlMin: 0 }, deps(sp, [stuck(1, { reap_fails: 9 })]));
  assert.equal(sp.gaveUp[0].why, "본인 세션이 아닙니다", "포기 기록이 원문을 잃었다 — 사후에 원인을 알 길이 없다");
  assert.equal(sp.alerts[0].detail.why, "본인 세션이 아닙니다", "경보가 원문을 잃었다");
}

console.log("failed-session-reaper.test(#2622): ok");
