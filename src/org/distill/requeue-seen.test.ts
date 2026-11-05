// 증류 배치 단위 판정 되돌리기(requeueDistillerSeen) — 고른 배치의 판정 기록만 지워 자료를 인박스로 되돌린다.
//
// 이 기능의 위험은 «너무 많이 지우는 것» 이다. 조건 없이 부르면 판정 표 전체가 지워지고, 지식이 이미 붙은
//  자료까지 되돌리면 같은 자료가 다시 증류돼 지식이 중복된다. 그래서 아래 단언 대부분은 «지우지 않아야 할 것이
//  남았는가» 를 본다.
//
// ── 페이크 설계 ──
//  SQL 모양을 모르는 채로 쓴 테스트라, 페이크는 SQL 문자열을 맞추지 않고 **표 이름·문장 종류**로 라우팅한다.
//  · org_task 만 보는 질의 = 대상 배치 고르기. 대상은 이 파일의 oracle(사양대로 sel 을 해석)이 정한다.
//  · 판정 표(org_distiller_seen·org_stranded_seen)를 보는 질의 = 셈 또는 삭제. 대상 배치 id 는 바인딩 값의
//    숫자 배열에서 읽고, 없으면(CTE 한 문장으로 고른 경우) oracle 로 대신한다.
//  · DELETE 는 메모리 모델에서 실제로 행을 지운다. knowledge_source 를 참조하지 않는 DELETE 는 지식 연결
//    행까지 지우므로, 규칙 4 를 어기면 모델 상태 단언이 깨진다.
//  · 결과 행은 Proxy 다 — 열 별칭을 모르므로 속성 이름(task·kept·know …)으로 값을 고른다.
//  미처리 SQL 은 던진다 — 조용히 빈 결과를 주면 테스트가 통과하면서 아무것도 안 본다.
//
// 실행: npm run build && node dist/org/distill/requeue-seen.test.js
import assert from "node:assert/strict";
import { itemsPool } from "../../db/client.js";
import { requeueDistillerSeen, buildRequeueTaskWhere, Params, REQUEUE_MAX_TASKS } from "./distiller.js";

let pass = 0;
const ok = (n: string): void => { pass++; console.log(`ok  ${n}`); };

type Sel = Parameters<typeof requeueDistillerSeen>[0];
type Task = { id: number; requester: string; requester_session: string | null; created_at: string };
type Seen = { table: "org_distiller_seen" | "org_stranded_seen"; distiller_id: number | null; source_id: string; task_id: number };

const SEEN_TABLES = ["org_distiller_seen", "org_stranded_seen"] as const;

const model = {
  tasks: [] as Task[],
  seen: [] as Seen[],
  knowledge: new Set<string>(), // knowledge_source 에 행이 있는 source_id
};
let curSel: Sel = {};
const log: Array<{ sql: string; values: unknown[] }> = [];
let connects = 0;

const reset = (tasks: Task[], seen: Seen[], knowledge: string[]): void => {
  model.tasks = tasks;
  model.seen = seen;
  model.knowledge = new Set(knowledge);
  log.length = 0;
  connects = 0;
};

// 사양의 고르기 규칙을 그대로 옮긴 oracle — 구현의 WHERE 가 아니라 이 파일이 읽은 사양이다.
const oracleTargets = (sel: Sel): number[] => {
  const ids = (sel.taskIds ?? []).filter((n) => Number.isInteger(n) && n > 0);
  const requester = (sel.requester ?? "").trim();
  return model.tasks
    .filter((t) => (ids.length === 0 || ids.includes(t.id))
      && (requester === "" || t.requester === requester)
      && (!sel.since || Date.parse(t.created_at) >= Date.parse(sel.since))
      && (!sel.until || Date.parse(t.created_at) < Date.parse(sel.until))
      && (!sel.distillerKey || (t.requester_session ?? "").endsWith(`#${sel.distillerKey}`)))
    .map((t) => t.id)
    .sort((a, b) => a - b);
};

const isNumArray = (v: unknown): v is unknown[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => (typeof x === "number" || typeof x === "string") && x !== "" && Number.isFinite(Number(x)));

const KEPT_NAME = /kept|keep|know|skip|linked|has_/;
const TASK_NAME = /task/;

type CountMode = "free" | "kept" | "named";
const countRow = (vals: { task?: number; free: number; kept: number }, mode: CountMode): Record<string, unknown> =>
  new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== "string" || prop === "then" || prop === "toJSON") return undefined;
      const p = prop.toLowerCase();
      if (TASK_NAME.test(p)) return vals.task;
      if (/total|^all/.test(p)) return vals.free + vals.kept;
      if (mode === "free") return vals.free;
      if (mode === "kept") return vals.kept;
      return KEPT_NAME.test(p) ? vals.kept : vals.free;
    },
  });
const rawSeenRow = (s: Seen, kept: boolean): Record<string, unknown> =>
  new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== "string" || prop === "then" || prop === "toJSON") return undefined;
      const p = prop.toLowerCase();
      if (TASK_NAME.test(p)) return s.task_id;
      if (p.includes("source")) return s.source_id;
      if (p.includes("distiller")) return s.distiller_id;
      if (KEPT_NAME.test(p)) return kept;
      if (p.includes("table")) return s.table;
      return undefined;
    },
  });
const taskRow = (id: number): Record<string, unknown> =>
  new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== "string" || prop === "then" || prop === "toJSON") return undefined;
      return id;
    },
  });

// 셈 질의가 어느 몫을 세는지 — WHERE 에서 지식 연결을 거르면 그 몫만, FILTER/CASE 면 열 이름으로 가른다.
const countMode = (sql: string): CountMode => {
  if (!sql.includes("knowledge_source")) return "named";
  if (/\bFILTER\s*\(|\bCASE\b/i.test(sql)) return "named";
  //  NOT 의 개수로 가른다 — 「NOT NOT EXISTS」 처럼 부정을 겹쳐 쓴 질의도 있다(짝수 = 지식 연결 몫).
  const m = sql.match(/((?:\bNOT\s+)*)\b(?:EXISTS|IN)\s*\(\s*SELECT[^()]*knowledge_source/i);
  if (!m) return "named";
  return (m[1].match(/NOT/gi) ?? []).length % 2 === 1 ? "free" : "kept";
};

const fake = async (sqlIn: unknown, valuesIn?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => {
  const cfg = (typeof sqlIn === "object" && sqlIn !== null ? sqlIn : null) as { text?: string; values?: unknown[] } | null;
  const sql = String(cfg ? cfg.text : sqlIn).replace(/\s+/g, " ").trim();
  const values = (cfg?.values ?? valuesIn ?? []) as unknown[];
  log.push({ sql, values });

  if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET\b|SELECT set_config)/i.test(sql)) return { rows: [], rowCount: 0 };

  const tables = SEEN_TABLES.filter((t) => sql.includes(t));
  if (tables.length === 0) {
    if (!sql.includes("org_task")) throw new Error("unhandled SQL in fake: " + sql);
    let ids = oracleTargets(curSel);
    const lim = sql.match(/\bLIMIT \$(\d+)|\bLIMIT (\d+)/i);
    if (lim) ids = ids.slice(0, Number(lim[1] ? values[Number(lim[1]) - 1] : lim[2]));
    if (/count\s*\(/i.test(sql) && !/GROUP BY/i.test(sql)) return { rows: [taskRow(ids.length)], rowCount: 1 };
    return { rows: ids.map(taskRow), rowCount: ids.length };
  }

  const arr = values.find(isNumArray);
  const targets = new Set(arr ? arr.map(Number) : oracleTargets(curSel));
  const inScope = (s: Seen): boolean => tables.includes(s.table) && targets.has(s.task_id);
  const kept = (s: Seen): boolean => model.knowledge.has(s.source_id);

  if (/\bDELETE FROM\b/i.test(sql)) {
    const delTables = SEEN_TABLES.filter((t) => new RegExp(`DELETE FROM ${t}\\b`, "i").test(sql));
    const guarded = sql.includes("knowledge_source");
    const gone = model.seen.filter((s) => delTables.includes(s.table) && targets.has(s.task_id) && (!guarded || !kept(s)));
    model.seen = model.seen.filter((s) => !gone.includes(s));
    if (/count\s*\(/i.test(sql)) {
      const per = new Map<number, number>();
      for (const s of gone) per.set(s.task_id, (per.get(s.task_id) ?? 0) + 1);
      const keptPer = (id: number): number => model.seen.filter((s) => inScope(s) && s.task_id === id && kept(s)).length;
      const ids = [...per.keys()].sort((a, b) => b - a); // 일부러 내림차순 — 정렬은 구현 몫이다
      const rows = /GROUP BY/i.test(sql)
        ? ids.map((id) => countRow({ task: id, free: per.get(id) ?? 0, kept: keptPer(id) }, "named"))
        : [countRow({ free: gone.length, kept: model.seen.filter((s) => inScope(s) && kept(s)).length }, "named")];
      return { rows, rowCount: rows.length };
    }
    const rows = /RETURNING/i.test(sql) ? [...gone].sort((a, b) => b.task_id - a.task_id).map((s) => rawSeenRow(s, false)) : [];
    return { rows, rowCount: gone.length };
  }

  const mode = countMode(sql);
  const scoped = model.seen.filter(inScope);
  if (/count\s*\(/i.test(sql)) {
    const tally = (xs: Seen[]): { free: number; kept: number } => ({ free: xs.filter((s) => !kept(s)).length, kept: xs.filter(kept).length });
    if (/GROUP BY/i.test(sql)) {
      const ids = [...new Set(scoped.map((s) => s.task_id))].sort((a, b) => b - a);
      const rows = ids
        .map((id) => ({ task: id, ...tally(scoped.filter((s) => s.task_id === id)) }))
        .filter((v) => (mode === "free" ? v.free > 0 : mode === "kept" ? v.kept > 0 : true))
        .map((v) => countRow(v, mode));
      return { rows, rowCount: rows.length };
    }
    return { rows: [countRow(tally(scoped), mode)], rowCount: 1 };
  }
  const picked = scoped.filter((s) => (mode === "free" ? !kept(s) : mode === "kept" ? kept(s) : true));
  const rows = picked.sort((a, b) => b.task_id - a.task_id).map((s) => rawSeenRow(s, kept(s)));
  return { rows, rowCount: rows.length };
};

(itemsPool as unknown as { query: unknown }).query = fake;
(itemsPool as unknown as { connect: unknown }).connect = async () => {
  connects++;
  return { query: fake, release: () => undefined };
};

const deletes = (): string[] => log.map((l) => l.sql).filter((s) => /\bDELETE FROM\b/i.test(s));
const allValues = (): unknown[] => log.flatMap((l) => l.values.flatMap((v) => (Array.isArray(v) ? v : [v])));
const flat = (p: Params): unknown[] => p.values.flatMap((v) => (Array.isArray(v) ? v : [v]));
const sameInstant = (v: unknown, iso: string): boolean =>
  String(v) === iso || (v instanceof Date && v.getTime() === Date.parse(iso));

const task = (id: number, requester = "alice", created_at = "2026-05-01T00:00:00Z", requester_session: string | null = null): Task =>
  ({ id, requester, requester_session, created_at });
const dseen = (task_id: number, source_id: string): Seen => ({ table: "org_distiller_seen", distiller_id: 1, source_id, task_id });
const sseen = (task_id: number, source_id: string): Seen => ({ table: "org_stranded_seen", distiller_id: null, source_id, task_id });

// 공통 장면: 대상 배치 10·20, 비대상 30.
//  10: 레인 기록 3(그중 s-k1 은 지식 연결) + 방치 기록 1 → 되돌림 3, 남김 1
//  20: 방치 기록 2(그중 s-k2 지식 연결)                → 되돌림 1, 남김 1
//  30: 레인 1 + 방치 1 — 고르지 않았으니 손대지 않는다
const scene = (): void => reset(
  [task(10), task(20), task(30)],
  [
    dseen(10, "s-a"), dseen(10, "s-b"), dseen(10, "s-k1"), sseen(10, "s-c"),
    sseen(20, "s-d"), sseen(20, "s-k2"),
    dseen(30, "s-e"), sseen(30, "s-f"),
  ],
  ["s-k1", "s-k2"],
);
const seenKeys = (): string[] => model.seen.map((s) => `${s.table}:${s.task_id}:${s.source_id}`).sort();

// ── buildRequeueTaskWhere ─────────────────────────────────────────────────────

{
  const p = new Params();
  assert.equal(buildRequeueTaskWhere({}, p), null);
  assert.equal(buildRequeueTaskWhere({ taskIds: [0, -3, 1.5, Number.NaN] }, p), null, "양의 정수가 아닌 id 만 있으면 고르기 조건이 아니다");
  assert.equal(buildRequeueTaskWhere({ taskIds: null, requester: null, since: null }, p), null);
  ok("buildRequeueTaskWhere — 조건 없음·무효 id 만 있음 → null");
}

{
  const p = new Params();
  assert.equal(buildRequeueTaskWhere({ requester: "alice" }, p), null, "requester 만으로는 부족하다");
  assert.equal(buildRequeueTaskWhere({ since: "2026-01-01T00:00:00Z" }, p), null, "since 만으로는 부족하다");
  assert.equal(buildRequeueTaskWhere({ requester: "   ", since: "2026-01-01T00:00:00Z" }, p), null, "공백뿐인 requester 는 없는 것이다");
  assert.equal(buildRequeueTaskWhere({ requester: "alice", until: "2026-12-01T00:00:00Z" }, p), null, "until 은 since 를 대신하지 않는다");
  ok("buildRequeueTaskWhere — requester 와 since 가 둘 다 있어야 한다");
}

{
  const p = new Params();
  const w = buildRequeueTaskWhere({ taskIds: [3, 0, -1, 2.5, 7] }, p);
  assert.ok(w !== null, "유효 id 가 하나라도 있으면 술어가 나와야 한다");
  const vals = flat(p).map(String);
  assert.ok(vals.includes("3") && vals.includes("7"), `유효 id 3·7 이 바인딩돼야 한다: ${JSON.stringify(p.values)}`);
  for (const bad of ["0", "-1", "2.5"]) assert.ok(!vals.includes(bad), `무효 id ${bad} 가 바인딩됐다: ${JSON.stringify(p.values)}`);
  assert.match(w, /\$\d+/, "id 는 자리표시로 넘어가야 한다");
  ok("buildRequeueTaskWhere — 0·음수·비정수 id 는 버리고 나머지만 바인딩");
}

{
  const p = new Params();
  const since = "2026-02-01T00:00:00Z";
  const until = "2026-03-01T00:00:00Z";
  const w = buildRequeueTaskWhere({ requester: "  alice  ", since, until, distillerKey: "lane-a" }, p);
  assert.ok(w !== null);
  const vals = flat(p);
  assert.ok(vals.includes("alice"), `requester 는 앞뒤 공백을 걷고 바인딩: ${JSON.stringify(p.values)}`);
  assert.ok(!vals.includes("  alice  "), "공백 그대로 바인딩하면 일치하는 배치가 없다");
  assert.ok(vals.some((v) => sameInstant(v, since)), "since 가 바인딩돼야 한다");
  assert.ok(vals.some((v) => sameInstant(v, until)), "until 이 바인딩돼야 한다");
  assert.ok(vals.some((v) => typeof v === "string" && v.includes("lane-a")), "레인 key 가 바인딩돼야 한다");
  for (const lit of ["alice", "lane-a", "2026-02-01", "2026-03-01"]) assert.ok(!w.includes(lit), `술어에 입력값 ${lit} 이 끼워졌다: ${w}`);
  ok("buildRequeueTaskWhere — requester 공백 제거 · since/until/레인 key 모두 바인딩 값으로");
}

{
  const p = new Params();
  p.add("앞선 값");
  const w = buildRequeueTaskWhere({ taskIds: [5], requester: "bob", since: "2026-01-01T00:00:00Z" }, p);
  assert.ok(w !== null);
  assert.equal(p.values[0], "앞선 값", "이미 쌓인 값을 건드리면 호출자의 자리표시가 어긋난다");
  const refs = [...w.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(refs.length > 0);
  for (const n of refs) assert.ok(n >= 2 && n <= p.values.length, `자리표시 $${n} 이 쌓인 값 범위(2..${p.values.length}) 밖이다: ${w}`);
  ok("buildRequeueTaskWhere — 넘겨받은 Params 에 이어 쌓고 자리표시가 그 값을 가리킨다");
}

// ── requeueDistillerSeen ─────────────────────────────────────────────────────

// 규칙 1 — 고르기 조건이 없으면 질의 0건.
{
  scene();
  const bad: Sel[] = [
    {},
    { taskIds: [] },
    { taskIds: [0, -2, 3.3] },
    { requester: "alice" },
    { since: "2026-01-01T00:00:00Z" },
    { requester: "  ", since: "2026-01-01T00:00:00Z" },
    { requester: "alice", until: "2026-12-01T00:00:00Z", distillerKey: "lane-a" },
  ];
  for (const sel of bad) {
    curSel = sel;
    for (const dry of [true, false]) {
      await assert.rejects(requeueDistillerSeen(sel, dry), RangeError, `고르기 조건 없는 ${JSON.stringify(sel)} dry=${dry} 가 통과했다`);
    }
  }
  assert.equal(log.length, 0, `조건 없는 호출이 DB 에 질의했다: ${log.map((l) => l.sql).join(" | ")}`);
  assert.equal(connects, 0, "조건 없는 호출이 커넥션을 열었다");
  assert.equal(model.seen.length, 8);
  ok("규칙 1 — 고르기 조건 없음 → RangeError, DB 질의·커넥션 0");
}

// 규칙 2 — 1000 개 초과면 아무것도 지우지 않는다.
{
  assert.equal(REQUEUE_MAX_TASKS, 1000);
  const many = Array.from({ length: 1001 }, (_, i) => task(i + 1, "bulk"));
  reset(many, [dseen(1, "s-1"), sseen(1001, "s-1001")], []);
  curSel = { requester: "bulk", since: "2026-01-01T00:00:00Z" };
  await assert.rejects(requeueDistillerSeen(curSel, false), RangeError);
  assert.deepEqual(deletes(), [], "상한을 넘었는데 DELETE 를 보냈다");
  assert.equal(model.seen.length, 2, "상한을 넘었는데 기록이 지워졌다");
  ok("규칙 2 — 대상 1001 개 → RangeError, DELETE 0");
}

{
  const many = Array.from({ length: 1000 }, (_, i) => task(i + 1, "bulk"));
  reset(many, [dseen(1, "s-1"), sseen(1000, "s-1000")], []);
  curSel = { requester: "bulk", since: "2026-01-01T00:00:00Z" };
  const r = await requeueDistillerSeen(curSel, true);
  assert.equal(r.tasks, 1000, "정확히 상한이면 허용된다");
  assert.equal(r.requeued, 2);
  ok("규칙 2 경계 — 대상 정확히 1000 개는 허용");
}

// 규칙 3 — 대상 0 개.
{
  scene();
  curSel = { taskIds: [999] };
  const r = await requeueDistillerSeen(curSel, false);
  assert.deepEqual(
    { dry_run: r.dry_run, tasks: r.tasks, requeued: r.requeued, kept: r.kept_with_knowledge, by_task: r.by_task },
    { dry_run: false, tasks: 0, requeued: 0, kept: 0, by_task: [] },
  );
  assert.deepEqual(deletes(), [], "대상이 없는데 DELETE 를 보냈다");
  const touched = log.filter((l) => SEEN_TABLES.some((t) => l.sql.includes(t)));
  assert.deepEqual(touched.map((l) => l.sql), [], "대상이 없는데 판정 표에 질의했다");
  assert.equal(model.seen.length, 8);
  ok("규칙 3 — 대상 0 개 → tasks 0·requeued 0, 판정 표 질의 0");
}

// 규칙 5·6 — dry-run 은 셈만 한다. by_task 는 오름차순이고 합이 requeued.
{
  scene();
  const before = seenKeys();
  curSel = { taskIds: [20, 10] };
  const r = await requeueDistillerSeen(curSel, true);
  assert.equal(r.dry_run, true);
  assert.equal(r.tasks, 2);
  assert.equal(r.requeued, 4);
  assert.equal(r.kept_with_knowledge, 2);
  assert.deepEqual(r.by_task.map((b) => ({ task_id: Number(b.task_id), requeued: Number(b.requeued) })),
    [{ task_id: 10, requeued: 3 }, { task_id: 20, requeued: 1 }], "by_task 는 task_id 오름차순·배치별 되돌릴 수");
  assert.equal(r.by_task.reduce((s, b) => s + Number(b.requeued), 0), r.requeued, "requeued 는 by_task 합과 같아야 한다");
  assert.deepEqual(deletes(), [], "dry-run 이 DELETE 를 보냈다");
  assert.deepEqual(seenKeys(), before, "dry-run 이 기록을 바꿨다");
  ok("규칙 5·6 — dry-run: 셈만, 결과 모양·by_task 오름차순·합 일치, DELETE 0");
}

// 규칙 5 — 실행: 두 표 모두에서 대상 배치의 지식 없는 기록만 지운다.
{
  scene();
  curSel = { taskIds: [10, 20] };
  const r = await requeueDistillerSeen(curSel, false);
  assert.equal(r.dry_run, false);
  assert.equal(r.tasks, 2);
  assert.equal(r.requeued, 4);
  assert.equal(r.kept_with_knowledge, 2);
  assert.deepEqual(r.by_task.map((b) => ({ task_id: Number(b.task_id), requeued: Number(b.requeued) })),
    [{ task_id: 10, requeued: 3 }, { task_id: 20, requeued: 1 }]);
  const del = deletes();
  for (const t of SEEN_TABLES) assert.ok(del.some((s) => s.includes(`DELETE FROM ${t}`)), `${t} 를 지우지 않았다: ${del.join(" | ")}`);
  assert.deepEqual(seenKeys(), [
    "org_distiller_seen:10:s-k1",
    "org_distiller_seen:30:s-e",
    "org_stranded_seen:20:s-k2",
    "org_stranded_seen:30:s-f",
  ], "남아야 할 것: 지식 연결 기록과 고르지 않은 배치의 기록");
  ok("규칙 5 — 실행: 두 표에서 대상 배치의 지식 없는 기록만 삭제, 비대상·지식 연결 기록은 남김");
}

// 규칙 4 — 모든 기록에 지식이 붙어 있으면 아무것도 되돌리지 않는다.
{
  reset([task(40)], [dseen(40, "s-x"), sseen(40, "s-y")], ["s-x", "s-y"]);
  curSel = { taskIds: [40] };
  const r = await requeueDistillerSeen(curSel, false);
  assert.equal(r.requeued, 0);
  assert.equal(r.kept_with_knowledge, 2);
  for (const s of deletes()) assert.ok(s.includes("knowledge_source"), `지식 연결을 거르지 않는 DELETE: ${s}`);
  assert.equal(model.seen.length, 2, "지식이 붙은 기록이 지워졌다");
  ok("규칙 4 — 지식 연결 자료의 기록은 남기고, 모든 DELETE 가 knowledge_source 로 거른다");
}

// 규칙 7 — 사용자 입력은 SQL 문자열이 아니라 바인딩 값으로.
{
  const evil = "x'; DROP TABLE org_task; --";
  const evilKey = "lane'--k";
  reset([task(50, evil, "2026-05-01T00:00:00Z", `cron:distill#${evilKey}`)], [dseen(50, "s-z")], []);
  curSel = { requester: `  ${evil}  `, since: "2026-01-01T00:00:00Z", until: "2026-12-31T00:00:00Z", distillerKey: evilKey };
  const r = await requeueDistillerSeen(curSel, true);
  assert.equal(r.tasks, 1);
  for (const l of log) {
    assert.ok(!l.sql.includes("DROP TABLE"), `requester 가 SQL 에 끼워졌다: ${l.sql}`);
    assert.ok(!l.sql.includes(evilKey), `레인 key 가 SQL 에 끼워졌다: ${l.sql}`);
    assert.ok(!l.sql.includes("2026-01-01") && !l.sql.includes("2026-12-31"), `날짜가 SQL 에 끼워졌다: ${l.sql}`);
  }
  const vals = allValues();
  assert.ok(vals.includes(evil), "requester 는 (공백을 걷고) 바인딩 값으로 넘어가야 한다");
  assert.ok(vals.some((v) => typeof v === "string" && v.includes(evilKey)), "레인 key 는 바인딩 값으로 넘어가야 한다");
  ok("규칙 7 — requester·레인 key·날짜가 SQL 문자열에 없고 바인딩 값에 있다");
}

// 리뷰 반영 — 술어의 모양이 곧 안전장치인 세 곳(순수 함수라 직접 단언한다).
{
  const p = new Params();
  const w = buildRequeueTaskWhere({ requester: "a", since: "2026-10-18T00:00:00Z", distillerKey: "slack_ops" }, p)!;
  // 레인 key 의 `_` 가 LIKE 와일드카드로 다른 레인을 고르면 안 된다.
  assert.ok(!/\bLIKE\b/i.test(w), "레인 key 를 LIKE 로 비교한다 — `_` 가 다른 레인까지 고른다: " + w);
  assert.ok(w.includes("split_part(t.requester_session, '#', 2) = $"), "레인 key 를 정확 일치로 비교하지 않는다: " + w);
  // 실패·취소로 끝난 배치는 서버가 이미 되돌렸고, 끝나지 않은 배치는 지금 읽고 있다.
  assert.ok(w.includes("t.status = 'done'"), "성공으로 끝난 배치로 좁히지 않는다: " + w);
  // 날짜 형식 오류는 DB 캐스트 실패(500)가 아니라 입력 오류다.
  assert.throws(() => buildRequeueTaskWhere({ requester: "a", since: "어제" }, new Params()), RangeError);
  assert.throws(() => buildRequeueTaskWhere({ taskIds: [1], until: "not-a-date" }, new Params()), RangeError);
  ok("리뷰 반영 — 레인 key 정확 일치·done 배치만·날짜 형식 오류는 RangeError");
}

console.log(`\nrequeue-seen tests: ${pass} passed`);
process.exit(0);
