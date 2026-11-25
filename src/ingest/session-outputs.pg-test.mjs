// 세션 결과물 자동 자료 등록(#5790) PG 통합 테스트 — **실제 Postgres 필요**(CI services:postgres 스텝).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/ingest/session-outputs.pg-test.mjs
//
//  판정 표(O·P·S)는 단위 시험 session-outputs.test.ts 가 잰다. 여기선 그 판정이 **진짜 폴더 · 진짜 자료 표** 위에서
//  끝까지 성립하는지 잰다 — 같은 파일을 두 번 등록하지 않는다 · 사람이 지운 자료를 되살리지 않는다 · 고친 파일은 다시 간다.
//  저장소는 로컬 모드(격리 끔 — 자체 호스팅 박스와 같은 길). 매니지드 멤버 경계는 같은 ProjectStorage 계약 뒤에 있다.
//  Q1 첫 턴 — 세션 뒤에 생긴 결과물만 «AI가 만든 파일» 로(코드·임시·숨김·안내 파일·세션 전 파일·git 레포 안은 아니다)
//  Q2 다음 턴 — 바뀐 것이 없으면 0건(같은 행을 다시 쓰지 않는다)
//  Q3 결과물을 고쳤다 — 그 한 건만 다시(같은 자료 행)
//  Q4 사람이 자료에서 지웠다 — 파일이 그대로면 되살리지 않는다
//  Q5 그 파일을 다시 고쳤다 — 새 결과물이니 다시 산다(active)
//  Q6 읽기전용 · 인코그니토 세션 — 훑지 않는다
//  Q7 프로젝트 폴더 밖에서 도는 세션 · 프로젝트 없는 세션 — 훑지 않는다
//  Q8 같은 프로젝트를 두 턴이 동시에 끝냈다 — 같은 약속 · 중복 행 없음(경합 순서 자체는 단위 표 C1~C4 가 결정적으로 잰다)
//  Q9 사람이 올린 자료(«올린 자료»)를 AI 가 고쳐도 들어온 길은 그대로(«올린 자료»)
//  Q10 이 폴더 안에 든 다른 프로젝트의 폴더(#4688) — 그 파일은 바깥 프로젝트 자료로 올리지 않는다
//  Q11 시각이 빈 옛 행(매니지드에서 이 변경 전에 등록) — 사람이 내렸으면 되살리지 않고, 살아 있어도 매 턴 다시 읽지 않는다
import pg from "pg";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_session_outputs_5790";
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
process.env.ITEMS_DATABASE_URL = dsnFor(DB);

const ROOT = mkdtempSync(path.join(os.tmpdir(), "lively-session-outputs-pg-"));
process.env.LIVELY_MEMBER_ISOLATION = "off";
for (const k of ["LIVELY_MEMBER_EXEC", "LIVELY_TENANT_ROOT_TEMPLATE", "LIVELY_TENANCY_MODE", "LIVELY_SHARED_DIR"]) delete process.env[k];
process.env.TERMINAL_ROOT_SHARED = path.join(ROOT, "shared");
process.env.TERMINAL_ROOT_PERSONAL = path.join(ROOT, "box");
for (const d of ["shared", "box"]) mkdirSync(path.join(ROOT, d), { recursive: true });

const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const { sweepSessionOutputs, resetSessionOutputSweeps } = await import(`${D}/ingest/session-outputs.js`);
const { ingestLocalUpload } = await import(`${D}/ingest/local-file.js`);
const { createProject, setProjectFolder } = await import(`${D}/v6/project-store.js`);
const { upsertMember } = await import(`${D}/org/store/members.js`);
const { itemsPool } = await import(`${D}/db/client.js`);

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };

const SID = "box-pgt-out-1a2b3c4d";
const START = Math.floor(Date.now() / 1000) - 3600;            // 세션은 한 시간 전에 떴다
let tick = Date.now();
const clock = () => (tick += 10_000);                          // 최소 간격(5초)을 기다리지 않게 — 부를 때마다 10초 흐른 것으로
const sweep = (o = {}) => { resetSessionOutputSweeps(); return sweepSessionOutputs({ ...sess, ...o }, clock); };

let sess = null;
try {
  await upsertMember({ id: "pgt-user", display_name: "사용자", email: "user@pgt.test", state: "active", scopes: ["items"] }, "pgt");
  const p = await createProject({ name: "결과물 시험 프로젝트", dedupe: false });
  const folder = `project/${p.id}`;
  await setProjectFolder(p.id, folder);
  const dir = path.join(ROOT, "shared", folder);
  sess = { id: SID, owner: "pgt-user", project_id: p.id, root_key: "shared", subpath: folder, read_only: false, incognito: false, created: START };

  const put = (rel, body, atSec) => {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
    if (atSec) utimesSync(abs, atSec, atSec);
    return abs;
  };
  const nowSec = Math.floor(Date.now() / 1000);
  // 결과물 — 세션 뒤에 생겼다
  put("보고서.pdf", "%PDF-1.4 report", nowSec - 600);
  put("크리스마스 홍보물.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), nowSec - 500);
  put("notes/요약.md", "# 요약\n본문", nowSec - 400);
  put("data/표.csv", "a,b\n1,2\n", nowSec - 300);
  // 결과물 아님 / 대상 아님
  put("make_chart.py", "print(1)", nowSec - 200);                  // 코드
  put("AGENTS.md", "# 안내", nowSec - 200);                         // 라이블리 안내 파일
  put("tmp/scratch.txt", "임시", nowSec - 200);                     // 임시 폴더
  put(".hidden.md", "숨김", nowSec - 200);                          // 숨김
  put("old.pdf", "%PDF-1.4 old", START - 7200);                     // 세션 전 파일
  put("repo/README.md", "# 레포", nowSec - 200);                    // git 레포 안
  mkdirSync(path.join(dir, "repo", ".git"), { recursive: true });

  const rows = async () => {
    const r = await itemsPool.query(
      `SELECT external_id, lifecycle, fields->>'entry' AS entry, fields->>'entry_session' AS entry_session, occurred_at, id
         FROM source WHERE external_system='local' AND starts_with(external_id, $1) ORDER BY external_id`, [`project:${p.id}/`]);
    return new Map(r.rows.map((x) => [x.external_id.slice(`project:${p.id}/`.length), x]));
  };

  // Q1
  const r1 = await sweep();
  const m1 = await rows();
  const want = ["data/표.csv", "notes/요약.md", "보고서.pdf", "크리스마스 홍보물.png"].sort();
  chk("Q1 결과물 4건만 자료가 된다", JSON.stringify([...m1.keys()].sort()) === JSON.stringify(want), JSON.stringify([...m1.keys()]));
  chk("Q1 보고 — ingested 4", r1 && r1.ingested === 4 && r1.picked === 4, JSON.stringify(r1));
  chk("Q1 들어온 길 = AI가 만든 파일 · 이 세션", [...m1.values()].every((x) => x.entry === "generated" && x.entry_session === SID), JSON.stringify([...m1.values()].map((x) => [x.entry, x.entry_session])));
  chk("Q1 파일 시각이 실린다(occurred_at)", [...m1.values()].every((x) => x.occurred_at != null));

  // Q2
  const r2 = await sweep();
  chk("Q2 바뀐 것이 없으면 0건", r2 && r2.picked === 0 && r2.ingested === 0, JSON.stringify(r2));
  chk("Q2 행 수 그대로", (await rows()).size === 4);

  // Q3
  const pngId = m1.get("크리스마스 홍보물.png").id;
  put("크리스마스 홍보물.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]), nowSec - 60);
  const r3 = await sweep();
  const m3 = await rows();
  chk("Q3 고친 한 건만 다시", r3 && r3.picked === 1 && r3.ingested === 1, JSON.stringify(r3));
  chk("Q3 같은 자료 행", m3.get("크리스마스 홍보물.png").id === pngId);

  // Q4
  await itemsPool.query(`UPDATE source SET lifecycle='superseded' WHERE id=$1`, [m3.get("보고서.pdf").id]);
  const r4 = await sweep();
  chk("Q4 지운 자료를 되살리지 않는다", r4 && r4.picked === 0 && (await rows()).get("보고서.pdf").lifecycle === "superseded", JSON.stringify(r4));

  // Q5
  put("보고서.pdf", "%PDF-1.4 report v2 — 고쳤다", nowSec - 30);
  const r5 = await sweep();
  chk("Q5 고친 파일은 새 결과물 — 다시 산다", r5 && r5.ingested === 1 && (await rows()).get("보고서.pdf").lifecycle === "active", JSON.stringify(r5));

  // Q6
  put("읽기전용에서.md", "x", nowSec - 20);
  chk("Q6 읽기전용 세션은 훑지 않는다", (await sweep({ read_only: true })) === null);
  chk("Q6 인코그니토 세션은 훑지 않는다", (await sweep({ incognito: true })) === null);
  chk("Q6 등록되지 않았다", !(await rows()).has("읽기전용에서.md"));

  // Q7
  chk("Q7 프로젝트 폴더 밖 세션", (await sweep({ subpath: "project/999999" })) === null);
  chk("Q7 개인 루트 세션", (await sweep({ root_key: "personal", subpath: "" })) === null);
  chk("Q7 프로젝트 없는 세션", (await sweep({ project_id: null })) === null);
  chk("Q7 여전히 등록 안 됨", !(await rows()).has("읽기전용에서.md"));

  // Q8 — 같은 프로젝트를 두 턴이 동시에. 앞 것이 도는 동안 뒤 것은 «한 번 더» 만 표시하고 같은 약속을 받는다.
  resetSessionOutputSweeps();
  put("동시에.md", "y", nowSec - 10);
  const a = sweepSessionOutputs(sess, clock);
  const b = sweepSessionOutputs({ ...sess, id: "box-pgt-out-2b3c4d5e" }, clock);   // 같은 폴더의 다른 세션
  const [ra, rb] = await Promise.all([a, b]);
  const m8 = await rows();
  chk("Q8 두 호출이 같은 약속", ra === rb || JSON.stringify(ra) === JSON.stringify(rb), JSON.stringify([ra, rb]));
  chk("Q8 두 파일 다 자료가 된다", m8.has("동시에.md") && m8.has("읽기전용에서.md"), JSON.stringify([...m8.keys()]));
  chk("Q8 중복 행 없음", (await itemsPool.query(`SELECT count(*)::int AS n FROM source WHERE external_system='local' AND starts_with(external_id,$1)`, [`project:${p.id}/`])).rows[0].n === m8.size);

  // Q9 — 사람이 올린 파일을 AI 가 고쳤다
  const upAbs = put("사람이올림.docx", "PK docx v1", nowSec - 5);
  await ingestLocalUpload({ root: { kind: "project", id: p.id }, folder, base: dir, abs: upAbs, osUser: null,
    uploader: { id: "pgt-user", name: "user@pgt.test" }, channelFallback: "x", entry: { kind: "upload" } });
  put("사람이올림.docx", "PK docx v2 — AI 가 고침", nowSec - 1);
  const r9 = await sweep();
  const m9 = await rows();
  chk("Q9 고친 파일을 다시 등록한다", r9 && r9.ingested >= 1, JSON.stringify(r9));
  chk("Q9 들어온 길은 «올린 자료» 그대로", m9.get("사람이올림.docx").entry === "upload", m9.get("사람이올림.docx").entry);

  // Q10
  const inner = await createProject({ name: "안쪽 프로젝트", dedupe: false });
  await setProjectFolder(inner.id, `${folder}/inner`);
  put("inner/안쪽결과.pdf", "%PDF-1.4 inner", nowSec);
  put("바깥결과.md", "# 바깥", nowSec);
  await sweep();
  const m10 = await rows();
  chk("Q10 안쪽 프로젝트 파일은 바깥 자료가 아니다", !m10.has("inner/안쪽결과.pdf"), JSON.stringify([...m10.keys()]));
  chk("Q10 바깥 결과물은 그대로 간다", m10.has("바깥결과.md"));

  // Q11
  const m11 = await rows();
  await itemsPool.query(`UPDATE source SET occurred_at=NULL, lifecycle='superseded' WHERE id=$1`, [m11.get("notes/요약.md").id]);
  await itemsPool.query(`UPDATE source SET occurred_at=NULL WHERE id=$1`, [m11.get("data/표.csv").id]);
  const r11 = await sweep();
  const after11 = await rows();
  chk("Q11 내린 옛 행을 되살리지 않는다", after11.get("notes/요약.md").lifecycle === "superseded");
  chk("Q11 살아 있는 옛 행도 다시 읽지 않는다", r11 && r11.picked === 0, JSON.stringify(r11));
} catch (e) {
  fail++; console.error("FAIL 예외", e);
} finally {
  await itemsPool.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.end().catch(() => {});
  rmSync(ROOT, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
