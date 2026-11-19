// code_drift 후보의 작업 기록 원천 — PG 통합 시험. **실제 Postgres 필요**(run-tests --pg 가 수집).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/org/manage/code-drift-touch.pg-test.mjs
//
// 왜 이 계층인가: 후보 술어는 작업 기록·touch·지식 본문 시각·모듈 상태를 한 SQL 에서 엮는다. 실행 경로(runManager)는 그 후보를
//  레포별 위탁으로 나누므로, 어느 레포에 몇 번 실리는지도 실제 스키마 위에서만 잴 수 있다. 열 이름을 바꿔 SQL 을 일부러 깨뜨리므로
//  전용 DB 를 만들어 쓴다.
//
//  사양:
//   T1  유도 touch — 지식을 낸 작업이 건드린 모듈을 14일 넘게 뒤에 커밋 작업이 다시 건드렸고 본문이 그 전이면 후보(레포=모듈의 레포)
//   T2  모듈이 바뀐 뒤 본문을 고친 지식은 후보가 아니다
//   T3  호출자 touch(derived=false)도 같은 원천이다
//   T4  14일 여유 — 지식을 낸 작업 뒤 14일 안의 변경은 후보가 아니다
//   T5  커밋 없는 작업 기록의 touch 는 변경으로 세지 않는다
//   T6  references 로만 이은 지식은 후보가 아니다(produced·decided 만)
//   T7  같은 모듈에 지식을 다시 낸 작업이 있으면 가장 늦은 것을 기준으로 본다
//   T8  지식 하나는 후보 한 건이다 — 레포가 여럿이면 가장 최근에 바뀐 모듈의 레포, 같은 모듈의 여러 변경은 모듈 한 줄(최근 시각)
//   T9  비활성 모듈은 후보를 만들지 않는다
//   T10 관리기 스코프(match_categories) 밖 지식은 후보가 아니다
//   M1  실행 경로 — 작업 기록 원천 지식은 모듈의 레포 위탁에 실리고, 분류 원천과 겹친 지식은 한 위탁에 한 번만 실린다
//       · 분류 원천 지식은 그대로 분류 레포 위탁에 실린다 · 지시문에 바뀐 모듈이 실린다
//   E1  후보 SQL 오류(없는 열)는 빈 결과로 삼키지 않는다 — 함수는 던지고, 관리기 실행은 error 로 기록되며 위탁하지 않는다
import pg from "pg";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_code_drift_touch";
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
const dbc = new pg.Client({ connectionString: dsnFor(DB) }); await dbc.connect();
await dbc.query("CREATE EXTENSION IF NOT EXISTS vector");
await dbc.end();
process.env.ITEMS_DATABASE_URL = dsnFor(DB);
for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE", "EMBEDDINGS_PROVIDER"]) delete process.env[k];

const D = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const { itemsPool } = await import(`${D}/db/client.js`);
const det = await import(`${D}/org/manage/detectors.js`);
const { runManager } = await import(`${D}/org/manage/run-manager.js`);
const mstore = await import(`${D}/org/store/managers.js`);

let pass = 0, fail = 0;
const chk = (name, cond, detail) => { if (cond) { pass++; console.log(`ok   ${name}`); } else { fail++; console.log(`FAIL ${name}${detail !== undefined ? " — " + detail : ""}`); } };
const show = (v) => JSON.stringify(v);
const Q = async (sql, p = []) => (await itemsPool.query(sql, p)).rows;
const ME = "code-drift-tester";

const DAY = 86400_000;
const T0 = Date.now() - 200 * DAY;
const at = (d) => new Date(T0 + d * DAY).toISOString();

const cat = async (key) => (await Q(`INSERT INTO category(key, name, origin) VALUES($1,$1,'human') RETURNING id`, [key]))[0].id;
const repo = async (name) => (await Q(`INSERT INTO repo(name, created_at) VALUES($1, now()) RETURNING id`, [name]))[0].id;
const unit = async (repoId, path, state = null) =>
  (await Q(`INSERT INTO code_unit(repo_id, kind, path, label, created_at, state) VALUES($1,'module',$2,$2,now(),$3) RETURNING id`, [repoId, path, state]))[0].id;
//  본문 시각은 INSERT 트리거가 now() 로 넣으므로 뒤에서 덮는다(본문을 안 바꾸는 UPDATE 는 트리거를 타지 않는다).
const kn = async (name, bodyDay, catId) => {
  await Q(`INSERT INTO knowledge(name, title, body_md) VALUES($1,$1,'본문')`, [name]);
  await Q(`UPDATE knowledge SET body_updated_at=$2, updated_at=$2 WHERE name=$1`, [name, at(bodyDay)]);
  await Q(`INSERT INTO knowledge_category(name, category_id, mapped_by, state) VALUES($1,$2,'manual','confirmed')`, [name, catId]);
};
const act = async ({ day, commit = true, repoId = null, touches = [], refs = [] }) => {
  const id = (await Q(
    `INSERT INTO activity(type, title, repo_id, commit_sha, committed_at, created_at)
     VALUES('feature','t',$1,$2,$3,$3) RETURNING id`,
    [repoId, commit ? `c${Math.random().toString(16).slice(2).padEnd(12, "0")}` : null, at(day)]))[0].id;
  for (const t of touches) {
    await Q(`INSERT INTO activity_touch(activity_id, target_kind, target_id, created_at, derived) VALUES($1,'code_unit',$2,now(),$3)`,
      [id, t.unit, t.derived ?? true]);
  }
  for (const r of refs) {
    await Q(`INSERT INTO activity_knowledge(activity_id, name, relation) VALUES($1,$2,$3)`, [id, r.name, r.relation ?? "produced"]);
  }
  return id;
};

const N = (i) => `cdt-n${String(i).padStart(2, "0")}`;
let renamed = false;
try {
  const CK = await cat("cdt-k");
  const CR = await cat("cdt-r");
  const COUT = await cat("cdt-out");
  await Q(`INSERT INTO category_repo(category_id, repo) VALUES($1,'cdt-catrepo')`, [CR]);
  const R1 = await repo("cdt-r1");
  const R2 = await repo("cdt-r2");

  // T1 유도 touch
  const U1 = await unit(R1, "src/a");
  await kn(N(1), 0, CK);
  await act({ day: 0, repoId: R1, touches: [{ unit: U1 }], refs: [{ name: N(1) }] });
  await act({ day: 30, repoId: R1, touches: [{ unit: U1 }] });
  // T2 본문이 변경 뒤에 고쳐짐
  const U2 = await unit(R1, "src/b");
  await kn(N(2), 40, CK);
  await act({ day: 0, repoId: R1, touches: [{ unit: U2 }], refs: [{ name: N(2) }] });
  await act({ day: 30, repoId: R1, touches: [{ unit: U2 }] });
  // T3 호출자 touch
  const U3 = await unit(R2, "lib/c");
  await kn(N(3), 0, CK);
  await act({ day: 0, repoId: R2, touches: [{ unit: U3, derived: false }], refs: [{ name: N(3), relation: "decided" }] });
  await act({ day: 30, repoId: R2, touches: [{ unit: U3, derived: false }] });
  // T4 14일 여유
  const U4 = await unit(R1, "src/d");
  await kn(N(4), 0, CK);
  await act({ day: 0, repoId: R1, touches: [{ unit: U4 }], refs: [{ name: N(4) }] });
  await act({ day: 10, repoId: R1, touches: [{ unit: U4 }] });
  // T5 커밋 없는 작업
  const U5 = await unit(R1, "src/e");
  await kn(N(5), 0, CK);
  await act({ day: 0, repoId: R1, touches: [{ unit: U5 }], refs: [{ name: N(5) }] });
  await act({ day: 30, commit: false, touches: [{ unit: U5, derived: false }] });
  // T6 references 만
  const U6 = await unit(R1, "src/f");
  await kn(N(6), 0, CK);
  await act({ day: 0, repoId: R1, touches: [{ unit: U6 }], refs: [{ name: N(6), relation: "references" }] });
  await act({ day: 30, repoId: R1, touches: [{ unit: U6 }] });
  // T7 다시 낸 작업
  const U7 = await unit(R1, "src/g");
  await kn(N(7), 0, CK);
  await act({ day: 0, repoId: R1, touches: [{ unit: U7 }], refs: [{ name: N(7) }] });
  await act({ day: 25, repoId: R1, touches: [{ unit: U7 }], refs: [{ name: N(7) }] });
  await act({ day: 30, repoId: R1, touches: [{ unit: U7 }] });
  // T8 레포 여럿 · 같은 모듈 여러 변경
  const U8a = await unit(R1, "src/h"), U8c = await unit(R1, "src/i"), U8b = await unit(R2, "lib/j");
  await kn(N(8), 0, CK);
  await act({ day: 0, repoId: R1, touches: [{ unit: U8a }, { unit: U8b }, { unit: U8c }], refs: [{ name: N(8) }] });
  await act({ day: 30, repoId: R1, touches: [{ unit: U8a }] });
  await act({ day: 35, repoId: R1, touches: [{ unit: U8c }] });
  await act({ day: 45, repoId: R2, touches: [{ unit: U8b }] });
  await act({ day: 50, repoId: R2, touches: [{ unit: U8b }] });
  // T9 비활성 모듈
  const U9 = await unit(R1, "src/k", "deleted");
  await kn(N(9), 0, CK);
  await act({ day: 0, repoId: R1, touches: [{ unit: U9 }], refs: [{ name: N(9) }] });
  await act({ day: 30, repoId: R1, touches: [{ unit: U9 }] });
  // T10 스코프 밖
  const U10 = await unit(R1, "src/l");
  await kn(N(10), 0, COUT);
  await act({ day: 0, repoId: R1, touches: [{ unit: U10 }], refs: [{ name: N(10) }] });
  await act({ day: 30, repoId: R1, touches: [{ unit: U10 }] });
  // M1 분류 원천과 겹치는 지식 · 분류 원천만인 지식
  const U11 = await unit(R1, "src/m");
  await kn(N(11), 0, CR);
  await act({ day: 0, repoId: R1, touches: [{ unit: U11 }], refs: [{ name: N(11) }] });
  await act({ day: 30, repoId: R1, touches: [{ unit: U11 }] });
  await kn(N(12), 0, CR);

  const scope = { match_categories: ["cdt-k", "cdt-r"], match_types: null, match_provenance: null, exclude_names: null, lookback_days: null };
  const hasFn = typeof det.findCodeDriftTouchCandidates === "function";
  chk("T 작업 기록 원천 후보 함수가 있다", hasFn);
  const cands = hasFn ? await det.findCodeDriftTouchCandidates(scope, 50) : [];
  const by = new Map(cands.map((c) => [c.name, c]));
  const names = cands.map((c) => c.name);

  chk("T1 유도 touch 의 변경은 후보 · 레포=모듈의 레포 · 바뀐 모듈", by.get(N(1))?.repos?.[0] === "cdt-r1"
    && show(by.get(N(1))?.changed_units?.map((u) => u.path)) === show(["src/a"]), show(by.get(N(1))));
  chk("T2 변경 뒤 본문을 고친 지식은 후보가 아니다", !by.has(N(2)), show(names));
  chk("T3 호출자 touch 도 원천이다(decided 참조)", by.get(N(3))?.repos?.[0] === "cdt-r2", show(by.get(N(3))));
  chk("T4 14일 안의 변경은 후보가 아니다", !by.has(N(4)), show(names));
  chk("T5 커밋 없는 작업의 touch 는 변경이 아니다", !by.has(N(5)), show(names));
  chk("T6 references 로만 이은 지식은 후보가 아니다", !by.has(N(6)), show(names));
  chk("T7 다시 낸 작업을 기준으로 본다", !by.has(N(7)), show(names));
  const c8 = by.get(N(8));
  chk("T8 지식 하나는 후보 한 건", names.filter((n) => n === N(8)).length === 1, show(names));
  chk("T8 가장 최근에 바뀐 모듈의 레포 · 그 레포의 모듈만 · 모듈 한 줄은 최근 시각",
    c8?.repos?.[0] === "cdt-r2" && c8?.changed_units?.length === 1 && c8.changed_units[0].path === "lib/j"
      && c8.changed_units[0].changed_at === at(50), show(c8));
  chk("T9 비활성 모듈은 후보를 만들지 않는다", !by.has(N(9)), show(names));
  chk("T10 스코프 밖 지식은 후보가 아니다", !by.has(N(10)), show(names));
  chk("T 후보 전체가 기대와 같다", show([...names].sort()) === show([N(1), N(3), N(8), N(11)].sort()), show(names));

  // ── M1 실행 경로 ──
  const MD = await mstore.upsertManager({ key: "cdt-md", kind: "code_drift", enabled: true, match_categories: ["cdt-k", "cdt-r"] }, ME, "web");
  const calls = [];
  const enqueue = async (prompt, opts) => { calls.push({ prompt, repo: opts.repo }); return { status: "ok", summary: { task_id: 9000 + calls.length } }; };
  const res = await runManager(MD, enqueue);
  const inRepo = (name) => calls.filter((c) => c.prompt.includes(name)).map((c) => c.repo);
  chk("M1 실행이 오류 없이 위탁한다", !res.error && res.enqueued === true, show(res));
  chk("M1 작업 기록 원천 지식은 모듈의 레포 위탁에 실린다",
    show(inRepo(N(1))) === show(["cdt-r1"]) && show(inRepo(N(3))) === show(["cdt-r2"]) && show(inRepo(N(8))) === show(["cdt-r2"]),
    show(calls.map((c) => c.repo)));
  chk("M1 분류 원천과 겹친 지식은 한 위탁에 한 번만(모듈의 레포)", show(inRepo(N(11))) === show(["cdt-r1"])
    && (calls.find((c) => c.repo === "cdt-r1").prompt.match(new RegExp(`\\d+\\) ${N(11)} `, "g")) ?? []).length === 1, show(inRepo(N(11))));
  chk("M1 분류 원천 지식은 분류 레포 위탁에 실린다", show(inRepo(N(12))) === show(["cdt-catrepo"]), show(inRepo(N(12))));
  chk("M1 지시문에 바뀐 모듈이 실린다", /본문 뒤에 바뀐 모듈: src\/a\(/.test(calls.find((c) => c.repo === "cdt-r1")?.prompt ?? ""),
    calls.find((c) => c.repo === "cdt-r1")?.prompt?.slice(0, 400));

  // ── E1 SQL 오류 ──
  await Q(`ALTER TABLE activity_knowledge RENAME COLUMN relation TO relation_cdt`);
  renamed = true;
  let thrown = null;
  try { if (hasFn) await det.findCodeDriftTouchCandidates(scope, 50); } catch (e) { thrown = e; }
  chk("E1 후보 함수가 없는 열 오류를 던진다(빈 결과로 삼키지 않는다)", thrown?.code === "42703", show({ code: thrown?.code, msg: thrown?.message }));
  const before = calls.length;
  const res2 = await runManager(MD, enqueue);
  const st = (await Q(`SELECT last_status FROM org_manager WHERE id=$1`, [MD.id]))[0]?.last_status;
  chk("E1 관리기 실행은 error 로 기록되고 위탁하지 않는다", !!res2.error && st === "error" && calls.length === before, show({ res2, st }));
} catch (e) {
  fail++; console.log(`FAIL 예외 — ${e?.stack ?? e}`);
} finally {
  if (renamed) await Q(`ALTER TABLE activity_knowledge RENAME COLUMN relation_cdt TO relation`).catch(() => {});
  await itemsPool.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
