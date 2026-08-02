// project-store 사양 테스트(#1313 R7) — 분해 선행 안전망. categoryOf(순수) + rescheduleDependents(#1308,
//  DB 함수 — reconcile.test 와 같은 얇은 Db 페이크: itemsPool.query 라우팅 스텁으로 층 BFS 를 결정론 검증).
//  export 표면·행위만 본다 — 분해 후에도 무수정 통과가 계약. SQL date 산술(to_char(::date + int))은 페이크가
//  UTC 달력으로 등가 에뮬레이트 — 여기서 잠그는 건 BFS 오케스트레이션(방향·전파 조건·visited·감사)이다.
//  사양 출처: rescheduleDependents 헤더 — `from --depends_on--> to` = to 가 선행·from 이 후행 / 델타 시프트
//  (gap 보존, 스냅 아님) / start 없으면 그 가지 스킵+전파 정지 / 자기 due 있어야 다음 층 전파 / 순환은 visited.
//  실행: npm run build && node dist/v6/project-store.test.js
//
// ── 입력 조합 × 기대 (엣지 표 — 행마다 테스트 ≥1) ─────────────────────────────
// #   | 시나리오(입력 조합)                                   | 기대
// P1  | categoryOf: done/in_progress/active/todo/backlog/미지/'' | done/started/started/unstarted/backlog/unstarted/unstarted
// P2  | delta=0(경계)                                         | [] + 쿼리 0건(조기 반환)
// P3  | delta=NaN(비수·부재 행)                               | [] + 쿼리 0건
// P4  | delta=1.9(비정수)                                     | trunc→1일 이동
// P5  | 체인 2←…(2 dep 1, 3 dep 2) 전부 start+due 보유        | 둘 다 Δ 이동(gap 보존)·moved=[2,3]·감사 2건·anchor 불이동
// P6  | 후행 start 없음                                       | 그 가지 스킵 + 그 아래 전파 정지(감사도 없음)
// P7  | 후행 start 有·due 無                                  | 자신은 이동(due null 유지) · 다음 층 전파 안 함
// P8  | 순환(1⇄2)                                             | 종결 · 2 는 1회만 이동
// P9  | 다이아몬드(4 가 2·3 양쪽 의존)                        | 4 는 1회만 이동(visited dedup)
// P10 | 역방향: anchor 가 의존하는 선행(anchor dep 9)         | 9 불이동(방향 규약 — 선행은 안 밀린다)
// P11 | 음수 delta                                            | 날짜 후퇴
import assert from "node:assert/strict";
import { itemsPool } from "../db/client.js";
import { categoryOf, rescheduleDependents } from "./project-store.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };

// ── 얇은 Db 페이크 — rescheduleDependents 가 만지는 세 쿼리만 라우팅(edge 조회·UPDATE 시프트·감사 INSERT). ──
type Proj = { id: number; start_date: string | null; due_date: string | null };
type Edge = { from: number; to: number }; // from depends_on to (to=선행, from=후행)
const state = { projects: [] as Proj[], edges: [] as Edge[], audits: [] as any[], log: [] as string[] };

// SQL `to_char(col::date + $2::int, 'YYYY-MM-DD')` 등가(UTC 달력 — TZ 무관 결정론).
const shift = (s: string, d: number): string => {
  const [y, m, day] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day + d)).toISOString().slice(0, 10);
};

(itemsPool as any).query = async (sqlIn: unknown, params: unknown[] = []) => {
  const sql = String(sqlIn).replace(/\s+/g, " ").trim();
  state.log.push(sql);
  const p = params as any[];
  if (sql.startsWith("SELECT pe.from_project_id AS id FROM project_edge")) {
    const frontier: number[] = p[0];
    return { rows: state.edges.filter((e) => frontier.includes(e.to)).map((e) => ({ id: e.from })) };
  }
  if (sql.startsWith("UPDATE project SET start_date = to_char")) {
    const row = state.projects.find((r) => r.id === p[0]);
    if (!row || row.start_date == null) return { rows: [] }; // WHERE start_date IS NOT NULL
    row.start_date = shift(row.start_date, p[1]);
    if (row.due_date != null) row.due_date = shift(row.due_date, p[1]); // CASE WHEN due IS NULL THEN NULL
    return { rows: [{ ...row }] };
  }
  if (sql.startsWith("INSERT INTO org_content_audit")) {
    state.audits.push({ entity: p[0], entity_key: p[1], op: p[2] });
    return { rows: [] };
  }
  throw new Error("unhandled SQL in fake: " + sql);
};

const reset = (projects: Proj[], edges: Edge[]) => {
  state.projects = projects.map((r) => ({ ...r }));
  state.edges = edges;
  state.audits = [];
  state.log = [];
};
const proj = (id: number) => state.projects.find((r) => r.id === id)!;

async function main() {
  // P1 — categoryOf 전 어휘 + 미지 폴백.
  assert.equal(categoryOf("done"), "done");
  assert.equal(categoryOf("in_progress"), "started");
  assert.equal(categoryOf("active"), "started");
  assert.equal(categoryOf("todo"), "unstarted");
  assert.equal(categoryOf("backlog"), "backlog");
  assert.equal(categoryOf("weird"), "unstarted");
  assert.equal(categoryOf(""), "unstarted");
  ok("P1 categoryOf — 네이티브 status→정규 카테고리 전 어휘 + 미지/'' 폴백 unstarted");

  // P2/P3 — delta 0/비수 → 조기 반환(쿼리 0건).
  reset([{ id: 1, start_date: "2026-01-10", due_date: "2026-01-12" }], []);
  assert.deepEqual(await rescheduleDependents(1, 0), []);
  assert.deepEqual(await rescheduleDependents(1, NaN), []);
  assert.equal(state.log.length, 0, "조기 반환 — DB 접근 없음");
  ok("P2/P3 delta=0·NaN → []·쿼리 0건");

  // P4 — 비정수 delta 는 trunc(1.9→1).
  reset(
    [{ id: 1, start_date: "2026-01-10", due_date: "2026-01-12" }, { id: 2, start_date: "2026-01-15", due_date: "2026-01-20" }],
    [{ from: 2, to: 1 }],
  );
  await rescheduleDependents(1, 1.9);
  assert.equal(proj(2).start_date, "2026-01-16");
  assert.equal(proj(2).due_date, "2026-01-21");
  ok("P4 delta=1.9 → trunc 1일 이동");

  // P5 — 체인 전파: gap 보존 델타 시프트, moved 순서(층 BFS), 감사, anchor 불이동. 월경계 포함.
  reset(
    [
      { id: 1, start_date: "2026-01-10", due_date: "2026-01-12" },
      { id: 2, start_date: "2026-01-30", due_date: "2026-02-02" },
      { id: 3, start_date: "2026-02-10", due_date: null },
    ],
    [{ from: 2, to: 1 }, { from: 3, to: 2 }],
  );
  {
    const moved = await rescheduleDependents(1, 3);
    assert.deepEqual(moved.map((r) => r.id), [2, 3]);
    assert.equal(proj(1).start_date, "2026-01-10", "anchor 자신은 절대 안 밀림");
    assert.equal(proj(2).start_date, "2026-02-02"); // 01-30 +3 (월경계)
    assert.equal(proj(2).due_date, "2026-02-05");
    assert.equal(proj(3).start_date, "2026-02-13");
    assert.equal(proj(3).due_date, null, "due 없던 행은 null 유지");
    assert.equal(state.audits.length, 2);
    assert.ok(state.audits.every((a) => a.entity === "project" && a.op === "reschedule"));
    assert.deepEqual(state.audits.map((a) => a.entity_key), ["2", "3"]);
  }
  ok("P5 체인 — 델타 시프트(gap 보존)·층 BFS 순서·감사 reschedule·anchor 불이동·월경계");

  // P6 — start 없는 후행: 스킵 + 그 아래 전파 정지(4 는 start 없음, 5 는 4 의존).
  reset(
    [
      { id: 1, start_date: "2026-01-10", due_date: "2026-01-12" },
      { id: 4, start_date: null, due_date: "2026-01-25" },
      { id: 5, start_date: "2026-02-01", due_date: "2026-02-03" },
    ],
    [{ from: 4, to: 1 }, { from: 5, to: 4 }],
  );
  {
    const moved = await rescheduleDependents(1, 2);
    assert.deepEqual(moved, []);
    assert.equal(proj(5).start_date, "2026-02-01", "정지된 가지 아래는 불이동");
    assert.equal(state.audits.length, 0, "못 민 가지는 감사도 없음");
  }
  ok("P6 start 없는 후행 → 스킵 + 전파 정지(하위 불이동·감사 0)");

  // P7 — start 有·due 無: 자신은 이동하되 다음 층 전파 근거(due) 없음 → 6 이동, 7 불이동.
  reset(
    [
      { id: 1, start_date: "2026-01-10", due_date: "2026-01-12" },
      { id: 6, start_date: "2026-01-20", due_date: null },
      { id: 7, start_date: "2026-02-01", due_date: "2026-02-02" },
    ],
    [{ from: 6, to: 1 }, { from: 7, to: 6 }],
  );
  {
    const moved = await rescheduleDependents(1, 5);
    assert.deepEqual(moved.map((r) => r.id), [6]);
    assert.equal(proj(6).start_date, "2026-01-25");
    assert.equal(proj(6).due_date, null);
    assert.equal(proj(7).start_date, "2026-02-01", "due 없는 층에서 전파 정지");
  }
  ok("P7 due 없는 후행 — 자신은 이동·다음 층 전파 안 함");

  // P8 — 순환 1⇄2: 종결 + 2 는 1회만 이동(visited).
  reset(
    [
      { id: 1, start_date: "2026-01-10", due_date: "2026-01-12" },
      { id: 2, start_date: "2026-01-15", due_date: "2026-01-16" },
    ],
    [{ from: 2, to: 1 }, { from: 1, to: 2 }],
  );
  {
    const moved = await rescheduleDependents(1, 1);
    assert.deepEqual(moved.map((r) => r.id), [2]);
    assert.equal(proj(2).start_date, "2026-01-16", "1회만 이동(+1, +2 아님)");
    assert.equal(proj(1).start_date, "2026-01-10", "anchor 는 순환으로도 안 밀림");
  }
  ok("P8 순환(1⇄2) → 종결·1회만 이동");

  // P9 — 다이아몬드: 2·3 이 anchor 의존, 4 는 둘 다 의존 → 4 는 1회만 이동.
  reset(
    [
      { id: 1, start_date: "2026-01-10", due_date: "2026-01-12" },
      { id: 2, start_date: "2026-01-15", due_date: "2026-01-16" },
      { id: 3, start_date: "2026-01-17", due_date: "2026-01-18" },
      { id: 4, start_date: "2026-02-01", due_date: "2026-02-02" },
    ],
    [{ from: 2, to: 1 }, { from: 3, to: 1 }, { from: 4, to: 2 }, { from: 4, to: 3 }],
  );
  {
    const moved = await rescheduleDependents(1, 1);
    assert.deepEqual(moved.map((r) => r.id).sort(), [2, 3, 4]);
    assert.equal(proj(4).start_date, "2026-02-02", "다이아몬드 합류점도 1회만 이동");
  }
  ok("P9 다이아몬드 → 합류점 1회만 이동(visited dedup)");

  // P10 — 방향 규약: anchor 가 의존하는 '선행'(edge from=anchor to=9)은 절대 안 밀린다.
  reset(
    [
      { id: 1, start_date: "2026-01-10", due_date: "2026-01-12" },
      { id: 9, start_date: "2026-01-01", due_date: "2026-01-05" },
    ],
    [{ from: 1, to: 9 }], // anchor(1)가 9 에 의존 — 9 는 선행
  );
  {
    const moved = await rescheduleDependents(1, 4);
    assert.deepEqual(moved, []);
    assert.equal(proj(9).start_date, "2026-01-01", "선행은 후행 이동에 안 끌려간다");
  }
  ok("P10 역방향(선행) 불이동 — from→to 방향 규약");

  // P11 — 음수 delta: 후퇴.
  reset(
    [
      { id: 1, start_date: "2026-01-10", due_date: "2026-01-12" },
      { id: 2, start_date: "2026-02-02", due_date: "2026-02-05" },
    ],
    [{ from: 2, to: 1 }],
  );
  await rescheduleDependents(1, -3);
  assert.equal(proj(2).start_date, "2026-01-30");
  assert.equal(proj(2).due_date, "2026-02-02");
  ok("P11 음수 delta → 날짜 후퇴(월경계 역방향)");
}

main().then(
  () => { console.log(`\n${pass} passed`); },
  (err) => { console.error(err); process.exit(1); },
);
