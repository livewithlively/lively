// 복원된 옛 세션 id → **지금 그 대화가 도는 세션** 되찾기 (#2231) — **실제 Postgres 필요**, 기본 npm test 체인 밖.
//  실행: npm run build && node --env-file-if-exists=.env src/sessions/session-successor.pg-test.mjs
//   (LIVELY_PGTEST_DSN 이 있으면 그걸, 없으면 ITEMS_DATABASE_URL 을 쓴다)
//  사양·엣지 표: <스크래치패드>/spec.md 의 A·B 표 + 아래 C 표.
//
//  왜 PG 통합인가: 이 판정은 **전부 SQL 에 산다**(이정표 사슬 · 대화로 되찾기 · 소유자 스코프).
//   순수 함수로 뽑을 수 있는 부분이 없다 — 조인과 정렬이 곧 판정이다. 그래서 실 DB 에 표를 세우고 잰다.
//   틀리면 티가 크다: 🔴 못 찾으면 옛 화면이 종전처럼 404 막다른 길 · 🔴 잘못 찾으면 **남의 세션**으로 보낸다.
//
//  ⚠ 실 테이블을 건드리지 않는다 — 전용 스키마를 만들고 search_path 를 그리로 돌린 뒤, 끝나면 DROP 한다.
//   session-state.js 는 모듈 전역 풀(itemsPool)을 쓰므로 **접속 문자열의 options** 로 search_path 를 심는다.
import pg from "pg";

const dsn0 = (process.env.LIVELY_PGTEST_DSN || process.env.ITEMS_DATABASE_URL || "").trim();
if (!dsn0) {
  console.error("LIVELY_PGTEST_DSN(또는 ITEMS_DATABASE_URL)이 없습니다 — 실 DB 가 필요한 테스트입니다");
  process.exit(2);
}
const SCHEMA = "succ_pgtest";
const withSchema = (u) => { const x = new URL(u); x.searchParams.set("options", `-c search_path=${SCHEMA}`); return x.toString(); };

const admin = new pg.Pool({ connectionString: dsn0, max: 1 });
await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
await admin.query(`CREATE SCHEMA ${SCHEMA}`);
// 판정이 실제로 읽는 컬럼만 세운다(정본 스키마의 부분집합 — org/schema/sessions-infra.ts).
await admin.query(`CREATE TABLE ${SCHEMA}.org_session_state(
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, claude_session_id TEXT, superseded_by TEXT,
  last_busy BIGINT, created BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
await admin.query(`CREATE TABLE ${SCHEMA}.org_node_session_map(
  box_id TEXT PRIMARY KEY, node_id TEXT, conv_uuid TEXT, transcript_path TEXT, owner TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);

// 모듈 전역 풀이 이 스키마만 보게 한 뒤 import 한다(import 시점에 풀이 만들어진다).
process.env.ITEMS_DATABASE_URL = withSchema(dsn0);
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { resolveSessionSuccessor, markSessionSuperseded } = await import(`${DIST}/sessions/session-state.js`);

let pass = 0, fail = 0;
const chk = (n, got, want) => {
  if (got === want) { pass++; console.log(`ok  ${n}`); }
  else { fail++; console.error(`not ok  ${n} — '${want}' 여야 하는데 '${got}'`); }
};
const state = (id, owner, conv, extra = {}) => admin.query(
  `INSERT INTO ${SCHEMA}.org_session_state(id, owner, claude_session_id, superseded_by, last_busy, created_at)
   VALUES($1,$2,$3,$4,$5, now() - ($6::int || ' minutes')::interval)`,
  [id, owner, conv, extra.superseded_by ?? null, extra.last_busy ?? null, extra.agoMin ?? 0]);
const map = (boxId, owner, conv, agoMin = 0) => admin.query(
  `INSERT INTO ${SCHEMA}.org_node_session_map(box_id, node_id, conv_uuid, owner, updated_at)
   VALUES($1,'n1',$2,$3, now() - ($4::int || ' minutes')::interval)`, [boxId, conv, owner, agoMin]);

const CONV = "f008b732-56bc-42b9-84d8-77cf3ed18b9d";

// ── C1 이정표 한 칸 — 복원이 남긴 표식을 그대로 따라간다.
await state("box-a-1", "jang", CONV, { superseded_by: "box-a-2" });
await state("box-a-2", "jang", CONV);
chk("C1 이정표 한 칸", await resolveSessionSuccessor("box-a-1"), "box-a-2");

// ── C2 이정표 여러 칸 — 여러 번 복원한 세션. **사슬 끝**을 준다(중간에 내려놓으면 또 죽은 자리다).
await admin.query(`UPDATE ${SCHEMA}.org_session_state SET superseded_by='box-a-3' WHERE id='box-a-2'`);
await state("box-a-3", "jang", CONV);
chk("C2 이정표 사슬 끝", await resolveSessionSuccessor("box-a-1"), "box-a-3");

// ── C3 고리 — A→B→A. 멈춰야 한다(영원히 돌면 요청이 안 끝난다).
await state("box-c-1", "jang", "conv-c", { superseded_by: "box-c-2" });
await state("box-c-2", "jang", "conv-c", { superseded_by: "box-c-1" });
const c3 = await resolveSessionSuccessor("box-c-1");
chk("C3 고리에서 멈춘다(자기 자신으로 안 돌아온다)", c3 === "box-c-1", false);

// ── C4 ★ 이정표가 **없는** 옛 id — 행 자체가 사라진 세션(이 변경 이전 복원·완전 삭제·워크스페이스 회수).
//  2026-08-27 실측이 정확히 이 모양이었다: box-jang-b830d01a 는 행이 없고, 매핑 표에만 대화가 남아 있었다.
await map("box-dead", "jang", "conv-d", 60);          // 행 없음 — 매핑만 남았다
await state("box-live", "jang", "conv-d", { agoMin: 5 });
chk("C4 행이 없어도 대화로 되찾는다", await resolveSessionSuccessor("box-dead"), "box-live");

// ── C5 ★ 소유자 스코프 — 같은 대화 id 라도 **남의 세션**으로는 보내지 않는다.
await map("box-mine", "jang", "conv-e", 60);
await state("box-someone-else", "yoon", "conv-e", { agoMin: 5 });
chk("C5 남의 세션으로 안 보낸다", await resolveSessionSuccessor("box-mine"), null);

// ── C6 후보가 여럿 — 가장 최근에 쓰던 자리를 준다(사람이 마지막으로 있던 곳).
await map("box-old", "jang", "conv-f", 90);
await state("box-f-old", "jang", "conv-f", { last_busy: 1000 });
await state("box-f-new", "jang", "conv-f", { last_busy: 2000 });
chk("C6 후보 여럿이면 최신", await resolveSessionSuccessor("box-old"), "box-f-new");

// ── C7 이어진 행은 후보가 아니다 — 이미 은퇴한 자리로 보내면 한 칸 더 걸어야 한다.
await state("box-g-dead", "jang", "conv-g", { superseded_by: "box-g-live", last_busy: 3000 });
await state("box-g-live", "jang", "conv-g", { last_busy: 1 });
await map("box-g-gone", "jang", "conv-g", 90);
chk("C7 이어진 행은 후보에서 뺀다", await resolveSessionSuccessor("box-g-gone"), "box-g-live");

// ── C8 아무 근거도 없는 id — null(호출자는 정직하게 404 를 낸다). 추측해서 아무 데나 보내지 않는다.
chk("C8 근거 없으면 null", await resolveSessionSuccessor("box-nothing-at-all"), null);

// ── C9 자기 자신을 가리키는 이정표는 이정표가 아니다(무한고리 방지 — 쓰기 쪽 걸쇠).
chk("C9 자기 자신 이정표는 기록하지 않는다", await markSessionSuperseded("box-a-3", "box-a-3"), false);

await admin.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
await admin.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
