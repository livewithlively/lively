// 프로젝트 저장소 이관의 소유 확인 SQL (#4064) — **실제 Postgres 필요**, 기본 npm test 체인 밖.
//  실행: npm run build && node --env-file-if-exists=.env src/project/project-storage-ownership.pg-test.mjs
//   (LIVELY_PGTEST_DSN 이 있으면 그걸, 없으면 ITEMS_DATABASE_URL 을 쓴다)
//  사양·엣지 표: 단위 시험 project-storage.test.ts 의 M17~M26 과 같은 뜻을 **SQL 쪽에서** 잰다.
//
//  왜 PG 통합인가: 판정이 SQL 에 산다.
//   · «그 AGENTS.md 가 쓰인 시각에 쓰던 이름» — 가장 늦은 행 하나(정렬) · 창 경계 · 창 상한 · 이름 없는 감사 행 ·
//     다른 엔티티/다른 번호. 단위 시험은 가짜 조회로 호출 모양만 재므로 이 조건을 하나 지워도 초록이다.
//     틀리면: 🔴 너무 넓으면 번호가 겹친 남의 워크스페이스가 이름 사전으로 우리 규칙을 끌어간다(리뷰 blocking)
//             🔴 너무 좁으면 이름을 바꾼 프로젝트의 사람 규칙이 멤버 저장소로 안 건너간다.
//   · 자료 좌표 대조(`source`) — 시스템·인스턴스·번호가 다 맞는 파일만 옮긴다.
//  이관은 가짜 중계(멤버 경계 = 이 기계에서 그대로 실행)로 끝까지 돌린다.
//
//  ⚠ 실 테이블을 건드리지 않는다 — 전용 스키마를 만들고 search_path 를 그리로 돌린 뒤, 끝나면 DROP 한다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";

const dsn0 = (process.env.LIVELY_PGTEST_DSN || process.env.ITEMS_DATABASE_URL || "").trim();
if (!dsn0) {
  console.error("LIVELY_PGTEST_DSN(또는 ITEMS_DATABASE_URL)이 없습니다 — 실 DB 가 필요한 테스트입니다");
  process.exit(2);
}
const SCHEMA = "projstore_own_pgtest";
const withSchema = (u) => { const x = new URL(u); x.searchParams.set("options", `-c search_path=${SCHEMA}`); return x.toString(); };

const admin = new pg.Pool({ connectionString: dsn0, max: 1 });
await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
await admin.query(`CREATE SCHEMA ${SCHEMA}`);
// 판정이 실제로 읽는 컬럼만 세운다(정본 스키마의 부분집합 — org/schema/core.ts · source 표).
await admin.query(`CREATE TABLE ${SCHEMA}.org_content_audit(
  id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), entity TEXT NOT NULL, entity_key TEXT,
  op TEXT NOT NULL, before JSONB, after JSONB, actor TEXT, source TEXT)`);
await admin.query(`CREATE INDEX ON ${SCHEMA}.org_content_audit(entity, entity_key)`);
await admin.query(`CREATE TABLE ${SCHEMA}.source(
  id BIGSERIAL PRIMARY KEY, external_system TEXT, external_instance TEXT, external_id TEXT)`);

// ── 두 루트와 가짜 중계 — 모듈이 로드 때 읽으므로 import 전에 정한다 ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "projstore-own-pg-"));
const LOCAL_ROOT = path.join(TMP, "gw");
const MEMBER_ROOT = path.join(TMP, "member");
process.env.TERMINAL_ROOT_SHARED = LOCAL_ROOT;
process.env.LIVELY_SHARED_DIR = MEMBER_ROOT;
for (const k of ["LIVELY_MEMBER_ISOLATION", "LIVELY_TENANT_ROOT_TEMPLATE", "LIVELY_TENANCY_MODE"]) delete process.env[k];
const RELAY = path.join(TMP, "relay.cjs");
fs.writeFileSync(RELAY, [
  "const { spawnSync } = require('child_process');",
  "const i = process.argv.indexOf('--'); const argv = process.argv.slice(i + 1);",
  "const r = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit' }); process.exit(r.status == null ? 1 : r.status);",
].join("\n"));
process.env.LIVELY_MEMBER_EXEC = `${process.execPath} ${RELAY}`;

// 모듈 전역 풀이 이 스키마만 보게 한 뒤 import 한다(import 시점에 풀이 만들어진다).
process.env.ITEMS_DATABASE_URL = withSchema(dsn0);
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const S = await import(`${DIST}/project/project-storage.js`);
const { agentsMdHeader, GENERATED_BANNER, RULES_MARK } = await import(`${DIST}/v6/agents-md-rules.js`);
const { normalizeExternalInstance } = await import(`${DIST}/org/ingest/external-identity.js`);

let pass = 0, fail = 0;
const chk = (n, got, want) => {
  if (got === want) { pass++; console.log(`ok  ${n}`); }
  else { fail++; console.log(`not ok  ${n}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`); }
};

const T = Date.parse("2026-09-10T03:00:00Z");   // 게이트웨이 쪽 AGENTS.md 가 마지막으로 쓰인 시각(배포 전)
const DAY = 86_400_000;
const K = S.NAME_CLOCK_SKEW_MS;
const md = (id, name, rules = "r") => `${agentsMdHeader({ id, name })}\n\n${GENERATED_BANNER}.\n\n${RULES_MARK}\n## 규칙\n${rules}\n`;
const row = (at, key, op, before, after, entity = "project") => admin.query(
  `INSERT INTO ${SCHEMA}.org_content_audit(at, entity, entity_key, op, before, after) VALUES($1,$2,$3,$4,$5,$6)`,
  [new Date(at).toISOString(), entity, key, op, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after)]);
// project-store 가 감사하는 모양 — 행 전체
const P = (id, name) => ({ id, level: "project", name, folder: `project/${id}`, status: "active" });
const own = (id, name, header, at) => S.ownsAgentsMd(md(id, header), { id, name }, at);

// ── 프로젝트 7 — 생성 → 둘째 이름 → (이름 없는 감사 행) → 파일 +1분에 셋째 이름 → 배포 뒤 이름 사전 30개
await row(T - 5 * DAY, "7", "insert", null, P(7, "처음 이름"));
await row(T - 2 * DAY, "7", "update", P(7, "처음 이름"), P(7, "둘째 이름"));
await row(T - 2 * DAY + 30_000, "7", "reschedule", { anchor: 7, deltaDays: 1 }, { start_date: null, due_date: null });
await row(T - 2 * DAY + 60_000, "7", "set_members", ["a"], ["a", "b"]);
await row(T + 60_000, "7", "update", P(7, "둘째 이름"), P(7, "셋째 이름"));
for (let i = 0; i < 30; i++) await row(T + DAY + i * 1000, "7", "update", P(7, `사전 ${i}`), P(7, `사전 ${i + 1}`));
// ── 남 — 번호 70 · 다른 엔티티(knowledge)의 같은 키
await row(T - DAY, "70", "update", P(70, "x"), P(70, "칠십 이름"));
await row(T - DAY, "7", "update", { name: "k" }, { name: "지식 이름" }, "knowledge");
// ── 프로젝트 9 — 창 안에서 25번 바꿈(창 상한)
await row(T - DAY, "9", "insert", null, P(9, "구 처음"));
for (let i = 0; i < 25; i++) await row(T - K + 1000 + i * 1000, "9", "update", P(9, `창 ${i}`), P(9, `창 ${i + 1}`));

// ═══ N — 그 시각의 이름 ═══
chk("N1 파일 시각에 유효하던 이름(둘째)", await own(7, "지금", "둘째 이름", T), true);
chk("N2 창 안(+1분 — DB 시각이 늦게 찍힘)에 붙인 이름(셋째)", await own(7, "지금", "셋째 이름", T), true);
chk("N3 그 전에 버린 이름(처음)", await own(7, "지금", "처음 이름", T), false);
chk("N4 ★ 배포 뒤 쌓은 사전 이름", await own(7, "지금", "사전 7", T), false);
chk("N5 번호 70 의 이름", await own(7, "지금", "칠십 이름", T), false);
chk("N6 다른 엔티티(knowledge)의 같은 키", await own(7, "지금", "지식 이름", T), false);
chk("N7 이름 없는 감사 행(reschedule·set_members)이 유효 이름을 가리지 않는다", await own(7, "지금", "둘째 이름", T - 2 * DAY + 90_000), true);
chk("N8 창보다 이른 파일이면 셋째는 창 밖", await own(7, "지금", "셋째 이름", T - K - 1), false);
chk("N9 감사 기록이 없는 프로젝트", await own(8, "지금", "옛 이름", T), false);
chk("N10 창 상한 — 앞의 것은 받는다(창 20)", await own(9, "지금", "창 20", T), true);
chk("N11 창 상한 — 넘친 것은 안 받는다(창 21)", await own(9, "지금", "창 21", T), false);
chk("N12 창 시작에 유효하던 이름(구 처음)", await own(9, "지금", "구 처음", T), true);
chk("N13 생성 전 시각(행 없음)", await own(7, "지금", "처음 이름", T - 6 * DAY - K - 1), false);

// ═══ O — 자료 좌표 대조 + 이관 끝까지 ═══
const inst = normalizeExternalInstance("default");
await admin.query(`INSERT INTO ${SCHEMA}.source(external_system, external_instance, external_id) VALUES
  ('local', $1, 'project:7/mine.txt'), ('local', $1, 'project:7/sub/deep.txt'), ('local', $1, 'project:70/other.txt'),
  ('slack', $1, 'project:7/slack.txt'), ('local', 'elsewhere', 'project:7/inst.txt')`, [inst]);
const L = path.join(LOCAL_ROOT, "project", "7");
for (const f of ["mine.txt", "sub/deep.txt", "other.txt", "slack.txt", "inst.txt", "nobody.txt"]) {
  fs.mkdirSync(path.dirname(path.join(L, f)), { recursive: true });
  fs.writeFileSync(path.join(L, f), f);
}
fs.writeFileSync(path.join(L, "AGENTS.md"), md(7, "둘째 이름", "사람 규칙"));
fs.utimesSync(path.join(L, "AGENTS.md"), T / 1000, T / 1000);
S.resetMigrationMemo();
//  지금 이름은 배포 뒤 사전의 마지막 — 그 이름으로 열어도 옮겨지는 AGENTS.md 는 «쓰인 시각의 이름» 덕이다
const st = await S.projectStorage("project/7", { memberId: "tester" }, { id: 7, name: "사전 30" });
const moved = fs.existsSync(st.base) ? fs.readdirSync(st.base, { recursive: true }).map(String).sort() : [];
chk("O1 옮긴 것 = 좌표가 맞는 이 워크스페이스 자료 + 그 시각 이름의 AGENTS.md", JSON.stringify(moved),
  JSON.stringify(["AGENTS.md", "mine.txt", "sub", "sub/deep.txt"]));
chk("O2 증명 못 한 것(남의 번호·다른 시스템·다른 인스턴스·자료 없음)은 제자리",
  ["other.txt", "slack.txt", "inst.txt", "nobody.txt"].filter((f) => !fs.existsSync(path.join(L, f))).join(","), "");
chk("O3 옮긴 AGENTS.md 의 사람 규칙이 그대로", fs.readFileSync(path.join(st.base, "AGENTS.md"), "utf8").includes("사람 규칙"), true);

fs.rmSync(TMP, { recursive: true, force: true });
await admin.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
await admin.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
