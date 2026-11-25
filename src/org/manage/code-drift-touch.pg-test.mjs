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
//   T11 지식을 낸 작업과 같은 sha 를 늦게 다시 기록한 것은 변경이 아니다 · 가장 늦은 기록이 그 재기록이면 그 아래 다른 커밋을 쓴다
//   T12 관리기에 lookback_days 가 있어도 이 원천은 오래 안 고친 지식을 낸다
//   T13 deprecated 레포의 모듈은 후보를 만들지 않는다
//   M1  실행 경로 — 작업 기록 원천 지식은 모듈의 레포 위탁에 실리고, 분류 원천과 겹친 지식은 한 위탁에 한 번만 실린다
//       · 분류 원천 지식은 그대로 분류 레포 위탁에 실린다 · 지시문에 바뀐 모듈이 실린다
//   T14 지식을 낸 커밋의 재기록은 그 커밋이 건드리지 않은 모듈에 붙어도 변경이 아니다(제외 sha 는 지식 단위)
//   M2  두 원천을 합친 지식 후보도 batch_size 까지다 · 작업 기록 원천은 ceil(batch/2) 까지라 분류 원천 몫이 남는다
//       · 분류 원천이 모자라면 작업 기록 원천이 남은 자리를 채운다
//   E1  후보 SQL 오류(없는 열)는 빈 결과로 삼키지 않는다 — 함수는 던지고, 관리기 실행은 그 원천만 빼고 나머지를 위탁하며
//       실패를 partial_error 로 싣는다
//   T15 제외 순번 표(excl_rank)는 그 지식이 낸 모듈 쌍만 담는다 — 지식을 낸 커밋이 다른 지식의 원천 모듈에 붙어 있어도 그 쌍으로
//       번지지 않는다(결과는 같고 중간 표만 준다 — 실행 계획의 실제 행 수로 본다)
//   T16 이 원천 조회에는 문장 시간 상한이 있다 — 넘으면(잠금에 막히는 등) 57014 로 던진다. 던진 오류는 E1 처럼 관리기 실행이
//       그 원천만 빼고 partial_error 로 싣는다
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
const act = async ({ day, commit = true, sha, committed = true, repoId = null, touches = [], refs = [] }) => {
  const id = (await Q(
    `INSERT INTO activity(type, title, repo_id, commit_sha, committed_at, created_at)
     VALUES('feature','t',$1,$2,$3,$4) RETURNING id`,
    [repoId, commit ? (sha ?? `c${Math.random().toString(16).slice(2).padEnd(12, "0")}`) : null, committed ? at(day) : null, at(day)]))[0].id;
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
  // T11 같은 커밋을 늦게 다시 기록(committed_at 없음)
  const U13 = await unit(R1, "src/n");
  await kn(N(13), 0, CK);
  await act({ day: 0, sha: "same13", committed: false, repoId: R1, touches: [{ unit: U13 }], refs: [{ name: N(13) }] });
  await act({ day: 30, sha: "same13", committed: false, repoId: R1, touches: [{ unit: U13 }] });
  // T11 가장 늦은 기록이 재기록이어도 그 아래의 다른 커밋은 변경이다
  const U14 = await unit(R1, "src/o");
  await kn(N(14), 0, CK);
  await act({ day: 0, sha: "same14", committed: false, repoId: R1, touches: [{ unit: U14 }], refs: [{ name: N(14) }] });
  await act({ day: 30, repoId: R1, touches: [{ unit: U14 }] });
  await act({ day: 60, sha: "same14", committed: false, repoId: R1, touches: [{ unit: U14 }] });
  // T13 deprecated 레포
  const R3 = await repo("cdt-r3");
  await Q(`UPDATE repo SET state='deprecated' WHERE id=$1`, [R3]);
  const U15 = await unit(R3, "src/p");
  await kn(N(15), 0, CK);
  await act({ day: 0, repoId: R3, touches: [{ unit: U15 }], refs: [{ name: N(15) }] });
  await act({ day: 30, repoId: R3, touches: [{ unit: U15 }] });
  // T14 제외 sha 는 지식 단위 — 지식을 낸 커밋을 다른 모듈(같은 지식의 다른 산출 작업이 건드린)에 붙여 다시 기록
  const U16a = await unit(R1, "src/q"), U16b = await unit(R1, "src/r");
  await kn(N(16), 0, CK);
  await act({ day: 0, sha: "same16", committed: false, repoId: R1, touches: [{ unit: U16a }], refs: [{ name: N(16) }] });
  await act({ day: 0, repoId: R1, touches: [{ unit: U16b }], refs: [{ name: N(16) }] });
  await act({ day: 30, sha: "same16", committed: false, repoId: R1, touches: [{ unit: U16b }] });
  //  분류 원천 순서를 고정한다(최근 갱신순) — M2 가 «분류 원천 몫» 으로 N12 를 기대한다.
  await Q(`UPDATE knowledge SET updated_at=$2 WHERE name=$1`, [N(12), at(5)]);

  const scope = { match_categories: ["cdt-k", "cdt-r"], match_types: null, match_provenance: null, exclude_names: null, lookback_days: null };
  const cands = await det.findCodeDriftTouchCandidates(scope, 50);
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
  chk("T11 지식을 낸 작업과 같은 커밋의 재기록은 변경이 아니다", !by.has(N(13)), show(names));
  chk("T11 가장 늦은 기록이 재기록이면 그 아래 다른 커밋의 시각을 쓴다",
    by.get(N(14))?.changed_units?.[0]?.changed_at === at(30), show(by.get(N(14))));
  chk("T13 deprecated 레포의 모듈은 후보를 만들지 않는다", !by.has(N(15)), show(names));
  chk("T14 지식을 낸 커밋의 재기록은 다른 모듈에 붙어도 변경이 아니다(제외는 지식 단위)", !by.has(N(16)), show(names));
  chk("T 후보 전체가 기대와 같다", show([...names].sort()) === show([N(1), N(3), N(8), N(11), N(14)].sort()), show(names));
  const lb = await det.findCodeDriftTouchCandidates({ ...scope, lookback_days: 30 }, 50);
  chk("T12 lookback_days 가 있어도 이 원천은 오래 안 고친 지식을 낸다",
    show(lb.map((c) => c.name).sort()) === show([...names].sort()), show(lb.map((c) => c.name)));

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

  // ── M2 두 원천의 합도 batch_size 까지 · 원천별 몫 ──
  const docsFor = async (key, batch) => {
    const mgr = await mstore.upsertManager({ key, kind: "code_drift", enabled: true, match_categories: ["cdt-k", "cdt-r"], batch_size: batch }, ME, "web");
    const got = [];
    await runManager(mgr, async (prompt) => { got.push(prompt); return { status: "ok", summary: { task_id: 1 } }; });
    return [N(1), N(3), N(8), N(11), N(12), N(14)].filter((n) => got.some((p) => p.includes(`) ${n} `)));
  };
  const b2 = await docsFor("cdt-mb2", 2);
  chk("M2 합친 지식 후보는 batch_size 까지이고 작업 기록 원천 몫이 먼저다", b2.length === 2 && b2.includes(N(8)), show(b2));
  chk("M2 작업 기록 원천 후보가 자리를 넘쳐도 분류 원천 몫이 남는다", b2.includes(N(12)), show(b2));
  const b6 = await docsFor("cdt-mb6", 6);
  chk("M2 분류 원천이 모자라면 작업 기록 원천이 남은 자리를 채운다", b6.length === 6 && b6.includes(N(14)), show(b6));

  // ── T15 제외 순번 표는 그 지식의 원천 모듈 쌍만 ──
  //  N17 을 낸 커밋(same17)이 늦게 다시 기록되며 N18 의 원천 모듈(U17b)에 붙었다. U17b 의 커밋 순번: Y(40일) 1 · same17(30일) 2 · P18(0일) 3.
  //   그 지식의 쌍만 담으면 excl_rank = (N17, U17a, 1) · (N18, U17b, 3) 두 행이고, 번지면 (N17, U17b, 2) 가 더해져 세 행이다.
  const CX = await cat("cdt-x");
  const U17a = await unit(R1, "src/s"), U17b = await unit(R1, "src/t");
  await kn(N(17), 0, CX); await kn(N(18), 0, CX);
  await act({ day: 0, sha: "same17", repoId: R1, touches: [{ unit: U17a }], refs: [{ name: N(17) }] });
  await act({ day: 0, repoId: R1, touches: [{ unit: U17b }], refs: [{ name: N(18) }] });
  await act({ day: 30, sha: "same17", committed: false, repoId: R1, touches: [{ unit: U17b }] });
  await act({ day: 40, repoId: R1, touches: [{ unit: U17b }] });
  const scopeX = { ...scope, match_categories: ["cdt-x"] };
  const seen = [];
  const origQuery = pg.Client.prototype.query;
  pg.Client.prototype.query = function (text, ...rest) {
    if (typeof text === "string" && text.includes("excl_rank")) seen.push({ text, values: Array.isArray(rest[0]) ? rest[0] : undefined });
    return origQuery.call(this, text, ...rest);
  };
  let candX;
  try { candX = await det.findCodeDriftTouchCandidates(scopeX, 50); } finally { pg.Client.prototype.query = origQuery; }
  chk("T15 전제: 후보는 N18 하나(N17 을 낸 커밋은 변경이 아니다)", show(candX.map((c) => c.name)) === show([N(18)]), show(candX));
  const sql15 = seen.at(-1);
  const planOf = async () => (await Q(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql15.text}`, sql15.values))[0]["QUERY PLAN"][0].Plan;
  const cteRows = (node, name) => {
    if (!node) return undefined;
    if (node["Subplan Name"] === `CTE ${name}`) return node["Actual Rows"];
    for (const ch of node.Plans ?? []) { const v = cteRows(ch, name); if (v !== undefined) return v; }
    return undefined;
  };
  const excl = sql15 ? cteRows(await planOf(), "excl_rank") : undefined;
  chk("T15 excl_rank 는 그 지식이 낸 모듈 쌍만(두 행) — 다른 지식의 모듈로 번지지 않는다", excl === 2, show({ excl, captured: !!sql15 }));

  // ── T16 문장 시간 상한 ──  다른 연결이 activity_touch 를 배타 잠금으로 쥔 동안 부른다 — 상한이 없으면 놓을 때까지 붙잡힌다.
  const locker = new pg.Client({ connectionString: dsnFor(DB) }); await locker.connect();
  await locker.query("BEGIN");
  await locker.query("LOCK TABLE activity_touch IN ACCESS EXCLUSIVE MODE");
  const released = new Promise((r) => setTimeout(() => { locker.query("ROLLBACK").then(() => locker.end()).then(r, r); }, 3000));
  const t16 = Date.now();
  const r16 = await det.findCodeDriftTouchCandidates(scope, 50, { timeoutMs: 300 }).then(() => "ok", (e) => e?.code ?? String(e));
  const took16 = Date.now() - t16;
  await released;
  chk("T16 상한 시간을 넘으면 57014 로 던진다(잠금이 풀리기를 기다리지 않는다)", r16 === "57014" && took16 < 2500, show({ r16, took16 }));

  // ── E1 SQL 오류 ──  (DB 는 끝에 통째로 지우므로 열 이름을 되돌리지 않는다)
  await Q(`ALTER TABLE activity_knowledge RENAME COLUMN relation TO relation_cdt`);
  let thrown = null;
  try { await det.findCodeDriftTouchCandidates(scope, 50); } catch (e) { thrown = e; }
  chk("E1 후보 함수가 없는 열 오류를 던진다(빈 결과로 삼키지 않는다)", thrown?.code === "42703", show({ code: thrown?.code, msg: thrown?.message }));
  const before = calls.length;
  const res2 = await runManager(MD, enqueue);
  const after = calls.slice(before);
  const row = (await Q(`SELECT last_status, last_summary FROM org_manager WHERE id=$1`, [MD.id]))[0];
  chk("E1 작업 기록 원천만 빠지고 분류 원천은 위탁된다",
    !res2.error && show(after.map((c) => c.repo)) === show(["cdt-catrepo"]), show({ res2, repos: after.map((c) => c.repo) }));
  chk("E1 실패는 partial_error 로 결과와 실행 기록에 실린다(감시가 센다)",
    /작업 기록 원천 후보 조회 실패/.test(res2.partial_error ?? "") && /작업 기록 원천/.test(row?.last_summary?.partial_error ?? ""),
    show({ partial: res2.partial_error, row }));
} catch (e) {
  fail++; console.log(`FAIL 예외 — ${e?.stack ?? e}`);
} finally {
  await itemsPool.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
