// 자동 생성 프로젝트 정리(project_gc) — 실제 Postgres 필요(기본 유닛 체인 밖, CI pg-test 잡 · .github/workflows/test.yml 에 등록).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/scheduler/actions/project-gc.pg-test.mjs
//
// 왜 이 계층인가: 무엇이 «기록»이고 «마지막 손길»인지가 전부 후보 SQL(가족 범위 2단계 · 여러 출처의 최댓값) 안에 있다.
//  판정 표(project-gc-plan.test.ts)는 그 SQL 이 맞게 잰 값을 전제로 하므로, 가족을 한 단계 덜 보거나 손길 출처 하나를 빼도
//  목 풀로는 초록이다. 그래서 실제 테이블에 심고 후보를 되읽는다. 쓰기(mode=on)는 웹과 같은 핸들러를 타는지 결과 행으로 본다.
//  전부를 대상으로 도는 액션이라 다른 테스트의 행을 건드리지 않게 **전용 데이터베이스**를 만든다.
//
//  사양 · 엣지 표:
//   G1 기록 없는 기계 이름 껍데기(손자까지 오래됨) → 후보 · 기록 없음 · 열린 하위 2(태스크+서브태스크)
//   G2 서브태스크가 최근에 고쳐졌다 → 손길이 최근이라 후보 아님(가족 2단계)
//   G3 태스크에 작업 기록 → 기록 있음 · 손길 = 그 기록 시각
//   G4 세션 구간(session_project)이 최근 → 후보 아님
//   G5 오래전에 붙었고(실행 세션 last_seen 20일 전) 지금도 활동하는 세션 → 후보 아님
//      · 박스 세션: 사람이 1시간 전에 시켰다(org_session_state.last_prompt_at)
//      · 외부 실행 세션(`codex-<id>`): 대화 기록 미러가 2시간 전 활동(session.last_seen)
//      · 쓰기 직전 확인(hasLiveSession)도 소유자와 무관하게 «살아 있음» 으로 본다
//   G6 직계 하위 2개 → 기록 있음
//   G7 프로젝트 엣지 → 기록 있음
//   G8 제외 — human 이름 · connector 생성 · 표식 없음 · 완료 · 휴지통
//   G11 태스크에 댓글 1건(project.updated_at 은 안 오른다) → 기록 있음, 손길은 그 댓글 시각
//   G12 기한이 남은 열린 하위 · 사람이 만든 태스크에 담당자 → 보호(손길이 오래돼도 닫지 않는다)
//   G13 세션 태스크만 있는 20일 된 껍데기(실제 경로 ensureSessionTask — 담당자가 세션 주인으로 자동 지정) → 보호 아님 · 후보
//   G9 report 는 아무것도 쓰지 않는다
//   G10 on — G1·G13 은 하위까지 완료 후 휴지통, G3·G6·G7 은 닫기만(G11 은 기록이 있지만 손길 25일이라 idle 기준 전). 사유가 외부 푸시 닫힘 노트에, 실행 신원이 감사에 남는다.
//       커넥터가 만든 하위는 닫지 않는다.
import pg from "pg";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_project_gc";
const u = new URL(BASE); u.pathname = "/" + DB;
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
{ const c = new pg.Client({ connectionString: u.toString() }); await c.connect(); await c.query("CREATE EXTENSION IF NOT EXISTS vector"); await c.end(); }
process.env.ITEMS_DATABASE_URL = u.toString();   // 아래 dist 모듈의 풀이 전용 DB 를 보게 — import 전에 바꾼다

const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
await (await import(`${DIST}/boot/schemas.js`)).initAllSchemas({ quiet: true });
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { candidateRows, runProjectGc, hasLiveSession } = await import(`${DIST}/scheduler/actions/project-gc.js`);
const { AUTO_CREATED_MARK } = await import(`${DIST}/project/first-prompt-project.js`);
const es = await import(`${DIST}/v6/execution-session-store.js`);
const { ensureSessionTask } = await import(`${DIST}/v6/session-task.js`);

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const A = "__gc_pg__";
const SHELL = `## 첫 지시(원문)\n\n점검하자\n\n${AUTO_CREATED_MARK}`;
const ago = (d) => `now() - interval '${d} days'`;

const mk = async (o) => (await itemsPool.query(
  `INSERT INTO project(level, parent_id, name, description, status, created_by, name_source)
   VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
  [o.level ?? "project", o.parent ?? null, o.name ?? "p", o.desc ?? SHELL, o.status ?? "active", o.by ?? A,
    o.ns === undefined ? "rule" : o.ns])).rows[0].id;
const age = (id, d) => itemsPool.query(`UPDATE project SET updated_at=${ago(d)} WHERE id=$1`, [id]);
const proj = async (o, d) => { const id = await mk(o); await age(id, d); return id; };

try {
  const g1 = await proj({ name: "G1" }, 20);
  const g1t = await proj({ level: "task", parent: g1, status: "todo" }, 20);
  const g1s = await proj({ level: "subtask", parent: g1t, status: "todo" }, 20);
  const g1c = await proj({ level: "subtask", parent: g1t, status: "todo", by: "connector:clickup" }, 20);

  const g2 = await proj({ name: "G2" }, 40);
  const g2t = await proj({ level: "task", parent: g2, status: "todo" }, 40);
  await proj({ level: "subtask", parent: g2t, status: "todo" }, 2);

  const g3 = await proj({ name: "G3", ns: "session" }, 40);
  const g3t = await proj({ level: "task", parent: g3, status: "done" }, 40);
  await itemsPool.query(`INSERT INTO activity(type, title, project_id, created_at) VALUES('other','기록',$1,${ago(35)})`, [g3t]);

  const g4 = await proj({ name: "G4" }, 40);
  await itemsPool.query(`INSERT INTO session_project(session_id, project_id, valid_from, created_at) VALUES('pgt-gc-s4',$1,${ago(5)},${ago(5)})`, [g4]);

  const g5 = await proj({ name: "G5 박스" }, 40);
  await itemsPool.query(`INSERT INTO execution_session(id, owner, desired_project_id, last_seen) VALUES('box-pgt-gc-x5-0000aaaa',$1,$2,${ago(20)})`, ["__other__", g5]);
  await itemsPool.query(`INSERT INTO org_session_state(id, owner, project_id, last_seen, last_prompt_at) VALUES('box-pgt-gc-x5-0000aaaa',$1,$2,${ago(20)},now() - interval '1 hour')`, ["__other__", g5]);
  const g5x = await proj({ name: "G5 외부" }, 40);
  await itemsPool.query(`INSERT INTO execution_session(id, owner, desired_project_id, last_seen) VALUES('codex-pgtgc5x',$1,$2,${ago(20)})`, ["__other__", g5x]);
  await itemsPool.query(`INSERT INTO session(node_id, session_id, owner, first_seen, last_seen) VALUES('', 'pgtgc5x', $1, ${ago(20)}, now() - interval '2 hours')`, ["__other__"]);

  const g6 = await proj({ name: "G6" }, 40);
  await proj({ level: "task", parent: g6, status: "done" }, 40);
  await proj({ level: "task", parent: g6, status: "done" }, 40);

  const h = await proj({ name: "사람 프로젝트", desc: "사람이 쓴 본문", ns: null }, 40);
  const g7 = await proj({ name: "G7" }, 40);
  await itemsPool.query(`INSERT INTO project_edge(from_project_id, to_project_id, relation, created_at) VALUES($1,$2,'related',${ago(40)})`, [g7, h]);

  const g11 = await proj({ name: "G11" }, 40);
  const g11t = await proj({ level: "task", parent: g11, status: "done" }, 40);
  await itemsPool.query(`INSERT INTO task_comment(task_id, author, body, created_at) VALUES($1,'__someone__','세션 완료 정리',${ago(25)})`, [g11t]);

  const g12 = await proj({ name: "G12 기한" }, 40);
  const g12t = await proj({ level: "task", parent: g12, status: "todo" }, 40);
  await itemsPool.query(`UPDATE project SET due_date=to_char(current_date + 3, 'YYYY-MM-DD'), updated_at=${ago(40)} WHERE id=$1`, [g12t]);
  const g12b = await proj({ name: "G12 담당" }, 40);
  const g12bt = await proj({ level: "task", parent: g12b, status: "todo", ns: null }, 40);   // 사람이 만든 태스크(name_source NULL)
  await itemsPool.query(`UPDATE project SET assignee='__someone__', updated_at=${ago(40)} WHERE id=$1`, [g12bt]);

  // G13 — 세션 태스크만 있는 껍데기. 실제 경로(ensureSessionTask)로 만든다: 태스크는 세션 주인이 담당자로 자동 지정된다.
  const g13 = await proj({ name: "G13" }, 0);
  const SID13 = "box-pgt-gc13-0000bbbb", OWN13 = "__own13__";
  await es.setExecutionSessionProject({ id: SID13, owner: OWN13, harness: "claude", projectId: g13 });
  const st13 = await ensureSessionTask({ sessionId: SID13, owner: OWN13, name: "세션이 지은 이름" });
  const t13 = (await itemsPool.query(`SELECT id, assignee, name_source, status FROM project WHERE parent_id=$1`, [g13])).rows;
  await itemsPool.query(`UPDATE project SET updated_at=${ago(20)} WHERE id=$1 OR parent_id=$1`, [g13]);
  await itemsPool.query(`UPDATE execution_session SET last_seen=${ago(20)}, updated_at=${ago(20)} WHERE id=$1`, [SID13]);
  await itemsPool.query(`UPDATE session_project SET created_at=${ago(20)}, valid_from=${ago(20)} WHERE session_id=$1`, [SID13]);

  const exHuman = await proj({ name: "human", ns: "human" }, 40);
  const exConn = await proj({ name: "conn", by: "connector:clickup" }, 40);
  const exDone = await proj({ name: "done", status: "done" }, 40);
  await itemsPool.query(`UPDATE project SET status_category='done' WHERE id=$1`, [exDone]);
  const exTrash = await proj({ name: "trash" }, 40);
  await itemsPool.query(`UPDATE project SET trashed_at=now(), updated_at=${ago(40)} WHERE id=$1`, [exTrash]);

  const rows = await candidateRows(14);
  const by = new Map(rows.map((r) => [r.id, r]));
  const touchDays = (id) => (Date.now() - by.get(id).lastTouch.getTime()) / 86_400_000;

  chk("G1 기록 없는 껍데기는 후보 · 기록 없음 · 열린 하위 2(커넥터 하위 제외)",
    by.has(g1) && by.get(g1).hasRecord === false && by.get(g1).openChildren === 2 && by.get(g1).nameSource === "rule", JSON.stringify(by.get(g1)));
  chk("G2 서브태스크(가족 2단계)의 최근 수정이 손길이다 — 후보 아님", !by.has(g2));
  chk("G3 태스크의 작업 기록 → 기록 있음, 손길은 그 기록 시각(35일)",
    by.has(g3) && by.get(g3).hasRecord === true && Math.abs(touchDays(g3) - 35) < 0.1, JSON.stringify(by.get(g3)));
  chk("G4 최근 세션 구간은 손길이다 — 후보 아님", !by.has(g4));
  chk("G5 오래전에 붙은 박스 세션이라도 사람이 최근에 시켰으면 손길이다 — 후보 아님", !by.has(g5));
  chk("G5 외부 실행 세션의 대화 기록 활동도 손길이다 — 후보 아님", !by.has(g5x));
  chk("G5 쓰기 직전 확인은 남의 세션이라도 살아 있음으로 본다 · 세션 없는 G1 은 아니다",
    (await hasLiveSession(g5)) === true && (await hasLiveSession(g5x)) === true && (await hasLiveSession(g1)) === false);
  chk("G11 댓글 1건 → 기록 있음, 손길은 그 댓글 시각(25일)",
    by.get(g11)?.hasRecord === true && Math.abs(touchDays(g11) - 25) < 0.1, JSON.stringify(by.get(g11)));
  chk("G13 (전제) 세션 태스크는 세션 주인이 담당자로 자동 지정되고 name_source=session 이다",
    st13?.created === true && t13.length === 1 && t13[0].assignee === OWN13 && t13[0].name_source === "session", JSON.stringify({ st13, t13 }));
  chk("G13 세션 태스크의 자동 담당자는 보호가 아니다 — 20일 된 껍데기는 후보", by.get(g13)?.protected === false && by.get(g13)?.hasRecord === false,
    JSON.stringify(by.get(g13)));
  chk("G12 기한 남은 열린 하위 · 사람이 만든 태스크에 담당자 → 보호", by.get(g12)?.protected === true && by.get(g12b)?.protected === true,
    JSON.stringify([by.get(g12), by.get(g12b)]));
  chk("G6 직계 하위 둘 → 기록 있음", by.get(g6)?.hasRecord === true, JSON.stringify(by.get(g6)));
  chk("G7 프로젝트 엣지 → 기록 있음", by.get(g7)?.hasRecord === true, JSON.stringify(by.get(g7)));
  chk("G8 human·connector·표식 없음·완료·휴지통은 후보가 아니다",
    ![exHuman, exConn, h, exDone, exTrash].some((id) => by.has(id)), JSON.stringify(rows.map((r) => r.id)));

  const snap = async () => (await itemsPool.query(
    `SELECT id, status, trashed_at FROM project WHERE created_by IN ($1, 'connector:clickup') ORDER BY id`, [A])).rows;
  const before = JSON.stringify(await snap());
  const rep = await runProjectGc({}, { id: "pgt-gc", action: "project_gc", interval_sec: 86400 });
  chk("G9 report 는 후보만 요약하고 아무것도 쓰지 않는다",
    rep.status === "ok" && rep.summary.mode === "report" && rep.summary.empty.trash === 2 && rep.summary.idle.close === 3 && rep.summary.protected_excluded === 2
      && JSON.stringify(await snap()) === before, JSON.stringify(rep.summary));

  const res = await runProjectGc({ mode: "on" }, { id: "pgt-gc", action: "project_gc", interval_sec: 86400 });
  const st = async (id) => (await itemsPool.query(`SELECT status, trashed_at FROM project WHERE id=$1`, [id])).rows[0];
  const s1 = await st(g1);
  chk("G10 G1 은 완료 후 휴지통", s1.status === "done" && s1.trashed_at != null, JSON.stringify({ s1, done: res.summary.done }));
  const s13 = await st(g13);
  chk("G10 G13(세션 태스크만)도 완료 후 휴지통 · 그 세션 태스크도 완료", s13.status === "done" && s13.trashed_at != null
    && (await st(t13[0].id)).status === "done", JSON.stringify(s13));
  chk("G10 G1 의 하위 태스크·서브태스크도 완료, 커넥터가 만든 하위는 그대로",
    (await st(g1t)).status === "done" && (await st(g1s)).status === "done" && (await st(g1c)).status === "todo");
  const closedOnly = await Promise.all([g3, g6, g7].map(st));
  chk("G10 기록 있는 것(G3·G6·G7)은 닫기만", closedOnly.every((r) => r.status === "done" && r.trashed_at == null), JSON.stringify(closedOnly));
  chk("G10 제외·최근 손길 프로젝트는 그대로",
    (await Promise.all([g2, g4, g5, g5x, g11, g12, g12b, exHuman, exConn, h].map(st))).every((r) => r.status === "active" && r.trashed_at == null));
  const note = (await itemsPool.query(`SELECT close_note FROM external_outbox WHERE entity_id=$1 AND done_at IS NULL`, [g1])).rows[0]?.close_note;
  chk("G10 닫는 사유가 외부 푸시 닫힘 노트로 간다(웹 완료와 같은 길)",
    note?.reason?.includes("자동으로 닫았습니다") && note?.actor === "cron:pgt-gc", JSON.stringify(note));
  const audit = (await itemsPool.query(
    `SELECT op FROM org_content_audit WHERE entity='project' AND entity_key=$1 AND actor='cron:pgt-gc' ORDER BY id`, [String(g1)])).rows.map((r) => r.op);
  chk("G10 감사에 실행 신원(cron:<잡>)으로 상태 변경·휴지통이 남는다", audit.includes("set_status") && audit.includes("trash"), JSON.stringify(audit));
  chk("G10 요약 — 휴지통 2(G1·G13) · 닫기 3 · 오류 0", res.status === "ok" && res.summary.done.trashed === 2 && res.summary.done.closed === 3
    && res.summary.done.error_count === 0, JSON.stringify(res.summary.done));
} catch (e) {
  fail++; console.error("FAIL 예외", e);
} finally {
  await itemsPool.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
