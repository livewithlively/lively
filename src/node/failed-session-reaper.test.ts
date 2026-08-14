// 실패 위탁 세션 회수(#1675 ①) — 사양 엣지 표 21~35행(<스크래치패드>/spec.md).
//  이 판정이 틀리면: 너무 적게 걷으면 어니스트 2026-08-12 재발(세션 2,300개 → 스왑 고갈 → 박스 다운),
//  너무 많이 걷으면 검시 대상을 잃는다(실패 원인을 못 본다).
import { strict as assert } from "node:assert";
import { planFailedSessionReap, reapFailedTaskSessions, type FailedTaskRow } from "./failed-session-reaper.js";

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
    async (t) => { if (t.id === 4) throw new Error("노드 이탈"); killed.push(t.id); },
    { keep: 1, ttlMin: 0 },
    { list: async () => [row(1, 1), row(3, 3), row(4, 4)], mark: async (ids) => { marked.push(ids); }, now: () => NOW },
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
    async () => { killCount++; },
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
    async () => { /* noop */ },
    { keep: 10, ttlMin: 0 },
    { list: async () => [row(1, 1)], mark: async () => { markCalls++; }, now: () => NOW },
  );
  assert.equal(markCalls, 0, "걷을 게 없는데 mark 를 불렀다");
}

console.log("failed-session-reaper.test: ok");
