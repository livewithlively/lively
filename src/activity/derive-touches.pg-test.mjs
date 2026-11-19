// 커밋 작업 기록 → activity_touch 유도 PG 통합 테스트 — **실제 Postgres 와 git 필요**(run-tests --pg 가 수집).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/activity/derive-touches.pg-test.mjs
//
// 왜 이 계층인가: 규칙의 대부분이 트랜잭션 경계(선점 리스, 작업 기록 행 잠금, CASCADE)와 git 출력(머지 커밋 first-parent)이다.
//  원격은 임시 bare 레포로 대신한다 — 워커는 도메인맵 클론(DOMAINMAP_REPOS_DIR)으로 fetch 한 뒤 git show 만 한다.
//
//  사양:
//   K1  스위치가 꺼져 있으면 크론 액션이 아무것도 안 한다(크론 행 저장 자체가 액션 허용목록 등록을 확인한다)
//   F1  스위치 저장은 l3_derive 만 바꾸고 l2_autoresolve 는 그대로 둔다
//   S1  커밋·레포가 있는 기록은 pending, 레포가 없으면 no_repo · 호출자 code_unit touch 가 있거나 커밋이 없는 기록은 상태 행이 없다
//       · data_entity touch 만 넘긴 기록은 유도한다(호출자 touch 는 그대로)
//   A2a 변경 파일을 최장 접두 규칙으로 매핑해 derived=true touch 를 넣고 ok(changed_files·unmatched_files)
//   A2b 머지 커밋은 first-parent 로 읽는다(0줄 거짓 empty 가 아니다) · 빈 커밋은 empty · 매칭 0건은 ok(unmatched=changed)
//   A2c 클론에 없는 커밋은 failed(error 기록) · 모듈이 없는 레포는 no_units(fetch 하지 않는다)
//   A2d blob·tree sha 는 커밋이 아니라 failed(거짓 ok·거짓 empty 가 아니다) · 지워진 레포의 행은 no_repo 이고 fetch 실패로 세지 않는다
//   I1  다시 돌리면 아무것도 바뀌지 않는다(종착 상태 · touch 수 그대로) · failed 는 다음 실행이 다시 잡고, 한 실행 안에서는 맴돌지 않는다
//   L1  선점을 잃은 시도(attempted_at 이 다름)는 상태도 touch 도 쓰지 못한다
//   L2  리스가 끝난 running 은 다시 선점되고, 옛 시도의 종료는 lost 다
//   R1  시도 중 sha 가 바뀌면 종료가 S2 쓰기로 맞춘다 — pending · 새 sha · 유도 touch 만 지우고 호출자 touch 는 남는다
//   R2  S2 — 끝난 행도 sha 가 바뀌면 다시 열리고 유도 touch 만 지워진다 · 호출자가 유도 행과 같은 touch 를 넘기면 derived=false 로 바뀌어 남는다
//   R3  레포가 나중에 붙은 no_repo 기록은 S2 로 pending 이 된다
//   U1  no_units 행은 그 레포에 첫 모듈이 생기면 S3 로 pending 이 되고 처리된다
//   E1  30일이 지난 failed·pending·리스 끝난 running 은 expired 이고 다시 선점되지 않는다
//   B1  클론 잠금을 못 얻으면 failed 가 아니라 pending 으로 남고 크론 상태는 ok 다
//   D1  작업 기록이 지워지면 상태 행·touch 가 함께 사라지고, 시도 중 삭제와 겹쳐도 교착 없이 gone 으로 끝난다
//   W1  크론 상태 — fetch 실패는 레포 일부든 전부든 warn(error 로 올려 브레이커가 잡을 끄지 않는다)
//   W2  워커 SQL 이 실패하면 크론 상태가 error 다(빈 결과 ok 로 삼키지 않는다)
//   P1  스위치가 켜져 있으면 작업 기록 직후 그 한 건을 유도한다 · 커밋이 클론에 이미 있으면 fetch 하지 않는다
//   M1  지표 — 고정 픽스처에서 완료율 (ok+empty)/(ok+empty+failed+expired), 매칭 0건 ok 수, pending 수
import pg from "pg";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_derive_touches";
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
const dbc = new pg.Client({ connectionString: dsnFor(DB) }); await dbc.connect();
await dbc.query("CREATE EXTENSION IF NOT EXISTS vector");
await dbc.end();
process.env.ITEMS_DATABASE_URL = dsnFor(DB);
for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE", "EMBEDDINGS_PROVIDER"]) delete process.env[k];
const TMP = mkdtempSync(join(tmpdir(), "derive-touches-"));
process.env.DOMAINMAP_REPOS_DIR = join(TMP, "clones");

const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const { itemsPool } = await import(`${D}/db/client.js`);
const dt = await import(`${D}/activity/derive-touches.js`);
const { logActivity } = await import(`${D}/activity/store.js`);
const rc = await import(`${D}/org/store/runtime-config.js`);
const { runCronById } = await import(`${D}/scheduler/engine.js`);

let pass = 0, fail = 0;
const chk = (name, cond, detail) => { if (cond) { pass++; console.log(`ok   ${name}`); } else { fail++; console.log(`FAIL ${name}${detail !== undefined ? " — " + detail : ""}`); } };
const show = (v) => JSON.stringify(v);
const Q = async (sql, p = []) => (await itemsPool.query(sql, p)).rows;
const ME = "derive-tester";

// ── 원격(bare) 과 작업 사본 ──
const g = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args],
  { cwd, encoding: "utf8" }).trim();
const BARE = join(TMP, "remote.git");
const WORK = join(TMP, "work");
g(TMP, "init", "--bare", BARE);
g(TMP, "clone", BARE, WORK);
const put = (rel, body) => { mkdirSync(join(WORK, rel, ".."), { recursive: true }); writeFileSync(join(WORK, rel), body); };
const commit = (msg) => { g(WORK, "add", "-A"); g(WORK, "commit", "-q", "--allow-empty", "-m", msg); return g(WORK, "rev-parse", "HEAD"); };
put("README.md", "0"); put("src/a/x.ts", "0"); put("src/a/sub/y.ts", "0"); put("src/b/z.ts", "0"); put("src/ab/q.ts", "0");
commit("base");
put("src/a/x.ts", "1"); put("src/a/sub/y.ts", "1"); put("README.md", "1");
const C1 = commit("c1");                                   // a, a/sub + 매칭 안 되는 README
put("README.md", "2");
const C2 = commit("c2");                                   // 매칭 0건
put("src/ab/q.ts", "1");
const C3 = commit("c3");                                   // src/ab — src/a 의 접두지만 세그먼트가 다르다
g(WORK, "checkout", "-q", "-b", "feature");
put("src/b/z.ts", "1");
commit("feature work");
g(WORK, "checkout", "-q", "main");
g(WORK, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");
const CM = g(WORK, "rev-parse", "HEAD");                    // 머지 커밋 — first-parent 로 src/b
const CE = commit("empty");                                 // 빈 커밋
put("src/b/z.ts", "2");
const C4 = commit("c4");
g(WORK, "push", "-q", "origin", "main", "feature");
const GHOST = "0123456789abcdef0123456789abcdef01234567";    // 클론에 없는 커밋
const BLOB = g(WORK, "rev-parse", "HEAD:README.md");          // 클론에 있지만 커밋이 아닌 객체
const TREE = g(WORK, "rev-parse", "HEAD^{tree}");

// ── 레포·모듈 ──
const repo = async (name, gitUrl) => (await Q(`INSERT INTO repo(name, git_url, default_branch, created_at) VALUES($1,$2,'main',now()) RETURNING id`, [name, gitUrl]))[0].id;
const unit = async (repoId, path) => (await Q(`INSERT INTO code_unit(repo_id, kind, path, label, created_at) VALUES($1,'module',$2,$2,now()) RETURNING id`, [repoId, path]))[0].id;
const R = await repo("r-main", "file://" + BARE);
const U_A = await unit(R, "src/a"), U_ASUB = await unit(R, "src/a/sub"), U_B = await unit(R, "src/b"), U_AB = await unit(R, "src/ab");
const R_NOU = await repo("r-nounits", "file://" + BARE);
const R_BAD = await repo("r-bad", "file://" + join(TMP, "missing.git"));
const R_DEL = await repo("r-del", "file://" + BARE);
await unit(R_DEL, "src/a");
await unit(R_BAD, "src/a");

const log = async (o) => (await logActivity({ type: "feature", title: o.title ?? "t", ...o }, ME)).id;
const row = async (id) => (await Q(`SELECT status, commit_sha, repo_id, changed_files, unmatched_files, error, enqueued_at, attempted_at::text AS attempted_at FROM activity_touch_derive WHERE activity_id=$1`, [id]))[0];
const touches = async (id) => (await Q(`SELECT target_id, derived FROM activity_touch WHERE activity_id=$1 ORDER BY target_id`, [id]));
const ids = (ts) => ts.map((t) => t.target_id);
const setFlag = (v) => rc.updateRuntimeConfig({ ontology_loops: { l3_derive: v } }, ME, "web");

try {
  // ── K1 · F1 ──
  await Q(`INSERT INTO org_cron(id, label, action, interval_sec, enabled) VALUES('derive-touches','t','derive_activity_touches',86400,false)`);
  const off = await runCronById("derive-touches");
  chk("K1 스위치가 꺼져 있으면 아무것도 안 한다", off.status === "ok" && /l3_derive/.test(show(off.summary)), show(off));
  await rc.updateRuntimeConfig({ ontology_loops: { l2_autoresolve: true } }, ME, "web");
  await setFlag(false);
  const loops = (await rc.getRuntimeConfig()).ontology_loops;
  chk("F1 l3_derive 저장은 l2_autoresolve 를 건드리지 않는다", loops.l2_autoresolve === true && loops.l3_derive === false, show(loops));

  // ── S1 ──
  const A1 = await log({ commit_sha: C1, repo: "r-main" });
  const A2 = await log({ commit_sha: C2, repo: "r-main" });
  const A3 = await log({ commit_sha: C3, repo: "r-main" });
  const AM = await log({ commit_sha: CM, repo: "r-main" });
  const AE = await log({ commit_sha: CE, repo: "r-main" });
  const AG = await log({ commit_sha: GHOST, repo: "r-main" });
  const AN = await log({ commit_sha: C1, repo: "r-nounits" });
  const ANR = await log({ commit_sha: C4 });                                   // 레포 없음
  const AC = await log({ commit_sha: C4, repo: "r-main", touches: [{ target_kind: "code_unit", target_id: U_B }] });
  const AX = await log({});                                                    // 커밋 없음
  const ADE = await log({ commit_sha: C1, repo: "r-main", touches: [{ target_kind: "data_entity", target_id: 999 }] });
  const rec = await dt.reconcileDeriveRows();
  chk("S1 커밋·레포가 있으면 pending", (await row(A1))?.status === "pending" && (await row(A1)).commit_sha === C1, show(await row(A1)));
  chk("S1 레포가 없으면 no_repo", (await row(ANR))?.status === "no_repo", show(await row(ANR)));
  chk("S1 호출자 touch 가 있거나 커밋이 없으면 상태 행이 없다", !(await row(AC)) && !(await row(AX)));
  chk("S1 data_entity touch 만 넘긴 기록은 유도 대상이다", (await row(ADE))?.status === "pending", show(await row(ADE)));
  chk("S1 넣은 수", rec.inserted === 9, show(rec));

  // ── A2a·A2b·A2c ──
  const run1 = await dt.deriveActivityTouches();
  const r1 = await row(A1);
  chk("A2a 최장 접두 매핑 — src/a·src/a/sub, README 는 미매칭", show(ids(await touches(A1))) === show([U_A, U_ASUB].sort((x, y) => x - y)) && r1.status === "ok"
    && r1.changed_files === 3 && r1.unmatched_files === 1, show({ r1, t: await touches(A1) }));
  chk("A2a 유도 touch 는 derived=true", (await touches(A1)).every((t) => t.derived === true));
  chk("A2a 세그먼트 경계 — src/ab 는 src/a 가 아니다", show(ids(await touches(A3))) === show([U_AB]), show(await touches(A3)));
  chk("A2b 머지 커밋은 first-parent 로 읽는다", (await row(AM)).status === "ok" && show(ids(await touches(AM))) === show([U_B]), show({ r: await row(AM), t: await touches(AM) }));
  chk("A2b 빈 커밋은 empty", (await row(AE)).status === "empty" && (await touches(AE)).length === 0, show(await row(AE)));
  const r2 = await row(A2);
  chk("A2b 매칭 0건은 ok 이고 unmatched=changed", r2.status === "ok" && r2.changed_files === 1 && r2.unmatched_files === 1 && (await touches(A2)).length === 0, show(r2));
  const rg = await row(AG);
  chk("A2c 클론에 없는 커밋은 failed 와 오류", rg.status === "failed" && /git show/.test(rg.error ?? ""), show(rg));
  chk("A2c 모듈 없는 레포는 no_units · fetch 목록에 없다", (await row(AN)).status === "no_units" && !run1.repos.some((r) => r.repo === "r-nounits"), show({ r: await row(AN), repos: run1.repos }));
  chk("A2c 한 실행에서 레포 fetch 는 한 번", run1.repos.filter((r) => r.repo === "r-main").length === 1, show(run1.repos));
  const tde = await Q(`SELECT target_kind, target_id, derived FROM activity_touch WHERE activity_id=$1 ORDER BY target_kind, target_id`, [ADE]);
  chk("S1 data_entity 기록에 code_unit 이 유도되고 호출자 touch 는 그대로", show(tde) === show([
    { target_kind: "code_unit", target_id: Math.min(U_A, U_ASUB), derived: true }, { target_kind: "code_unit", target_id: Math.max(U_A, U_ASUB), derived: true },
    { target_kind: "data_entity", target_id: 999, derived: false }]), show(tde));

  // ── I1 ──
  const before = (await Q(`SELECT count(*)::int AS n FROM activity_touch`))[0].n;
  const run2 = await dt.deriveActivityTouches();
  const after = (await Q(`SELECT count(*)::int AS n FROM activity_touch`))[0].n;
  chk("I1 다시 돌리면 failed 만 다시 잡고 touch 는 그대로", run2.claimed === 1 && run2.results.failed === 1 && before === after && run2.reconcile.inserted === 0, show({ run2, before, after }));
  chk("I1 한 실행 안에서 failed 를 맴돌지 않는다", run1.claimed === 9 - 1 /* no_repo */, show(run1));

  // ── A2d ──
  const ABL = await log({ commit_sha: BLOB, repo: "r-main" });
  const ATR = await log({ commit_sha: TREE, repo: "r-main" });
  const ADL = await log({ commit_sha: C1, repo: "r-del" });
  await Q(`DELETE FROM repo WHERE id=$1`, [R_DEL]);
  const runD = await dt.deriveActivityTouches();
  chk("A2d blob sha 는 failed — 거짓 ok·유도 touch 가 아니다", (await row(ABL)).status === "failed" && (await touches(ABL)).length === 0, show(await row(ABL)));
  chk("A2d tree sha 는 failed — 거짓 empty 가 아니다", (await row(ATR)).status === "failed", show(await row(ATR)));
  chk("A2d 지워진 레포의 행은 no_repo 이고 fetch 실패로 세지 않는다", (await row(ADL)).status === "no_repo"
    && !runD.repos.some((r) => r.error) && dt.statusForDerive(runD.repos) === "ok", show({ r: await row(ADL), repos: runD.repos }));
  await Q(`UPDATE activity_touch_derive SET status='ok' WHERE activity_id = ANY($1)`, [[ABL, ATR]]);   // 뒤 단계의 재시도 수에 섞이지 않게

  // ── L1 · L2 ──
  const AL = await log({ commit_sha: C1, repo: "r-main" });
  await dt.reconcileDeriveRows(AL);
  const t1 = (await Q(`UPDATE activity_touch_derive SET status='running', attempted_at=now() - interval '20 minutes' WHERE activity_id=$1 RETURNING attempted_at::text AS a`, [AL]))[0].a;
  const claimL = { activity_id: AL, commit_sha: C1, repo_id: R };
  const lost = await dt.finishDerive({ ...claimL, attempted_at: "2000-01-01 00:00:00+00" }, { kind: "files", files: [["src/a/x.ts"]] });
  chk("L1 선점을 잃은 시도는 아무것도 쓰지 못한다", lost === "lost" && (await row(AL)).status === "running" && (await touches(AL)).length === 0, show({ lost, r: await row(AL) }));
  const run3 = await dt.deriveActivityTouches({ activityId: AL });            // 리스가 끝난 running 을 다시 선점
  chk("L2 리스가 끝난 running 은 다시 선점돼 처리된다", run3.claimed === 1 && (await row(AL)).status === "ok", show({ run3, r: await row(AL) }));
  const late = await dt.finishDerive({ ...claimL, attempted_at: t1 }, { kind: "files", files: [["src/b/z.ts"]] });
  chk("L2 옛 시도의 종료는 lost — 새 결과를 덮지 않는다", late === "lost" && !ids(await touches(AL)).includes(U_B), show({ late, t: await touches(AL) }));

  // ── R1 ──
  const AR = await log({ commit_sha: C1, repo: "r-main", external_system: "t", external_id: "r1" });
  await dt.deriveActivityTouches({ activityId: AR });
  await log({ commit_sha: C1, repo: "r-main", external_system: "t", external_id: "r1", touches: [{ target_kind: "code_unit", target_id: U_B }] });
  const ta = (await Q(`UPDATE activity_touch_derive SET status='running', attempted_at=now() WHERE activity_id=$1 RETURNING attempted_at::text AS a`, [AR]))[0].a;
  await Q(`UPDATE activity SET commit_sha=$2 WHERE id=$1`, [AR, C4]);
  const rs = await dt.finishDerive({ activity_id: AR, commit_sha: C1, repo_id: R, attempted_at: ta }, { kind: "files", files: [["src/a/x.ts"]] });
  const rr = await row(AR);
  const tr = await touches(AR);
  chk("R1 시도 중 sha 가 바뀌면 pending·새 sha 로 맞춘다", rs === "resynced" && rr.status === "pending" && rr.commit_sha === C4, show({ rs, rr }));
  chk("R1 유도 touch 만 지우고 호출자 touch 는 남는다", show(tr) === show([{ target_id: U_B, derived: false }]), show(tr));

  // ── R2 ──
  const AS = await log({ commit_sha: C1, repo: "r-main", external_system: "t", external_id: "s2" });
  await dt.deriveActivityTouches({ activityId: AS });
  await log({ commit_sha: C1, repo: "r-main", external_system: "t", external_id: "s2", touches: [{ target_kind: "code_unit", target_id: U_A }] });
  chk("R2 호출자가 유도 행과 같은 touch 를 넘기면 derived=false", (await touches(AS)).find((t) => t.target_id === U_A)?.derived === false, show(await touches(AS)));
  const enq0 = (await row(AS)).enqueued_at;
  await Q(`UPDATE activity SET commit_sha=$2 WHERE id=$1`, [AS, C2]);
  const rec2 = await dt.reconcileDeriveRows();
  const rs2 = await row(AS);
  chk("R2 끝난 행도 sha 가 바뀌면 다시 열린다", rec2.resynced >= 1 && rs2.status === "pending" && rs2.commit_sha === C2 && rs2.enqueued_at > enq0, show(rs2));
  chk("R2 유도 touch(src/a/sub)만 지워지고 호출자로 바뀐 src/a 는 남는다", show(await touches(AS)) === show([{ target_id: U_A, derived: false }]), show(await touches(AS)));

  // ── R3 ──
  await Q(`UPDATE activity SET repo_id=$2 WHERE id=$1`, [ANR, R]);
  await dt.deriveActivityTouches();
  chk("R3 레포가 붙은 no_repo 기록은 처리된다", (await row(ANR)).status === "ok" && ids(await touches(ANR)).includes(U_B), show(await row(ANR)));

  // ── U1 ──
  await unit(R_NOU, "src/a");
  const rec3 = await dt.reconcileDeriveRows();
  chk("U1 첫 모듈이 생기면 no_units → pending", rec3.reopened === 1 && (await row(AN)).status === "pending", show({ rec3, r: await row(AN) }));
  await dt.deriveActivityTouches();
  chk("U1 다시 처리된다", (await row(AN)).status === "ok" && (await touches(AN)).length === 1, show(await row(AN)));

  // ── E1 ──
  const AEX = await log({ commit_sha: C1, repo: "r-main" });
  const AEX2 = await log({ commit_sha: C1, repo: "r-main" });
  await dt.reconcileDeriveRows();
  await Q(`UPDATE activity_touch_derive SET enqueued_at = now() - interval '31 days' WHERE activity_id = ANY($1)`, [[AG, AEX]]);
  await Q(`UPDATE activity_touch_derive SET status='running', attempted_at = now() - interval '1 hour', enqueued_at = now() - interval '31 days' WHERE activity_id=$1`, [AEX2]);
  const rec4 = await dt.reconcileDeriveRows();
  chk("E1 30일 지난 failed·pending·리스 끝난 running 은 expired", rec4.expired === 3 && (await row(AG)).status === "expired" && (await row(AEX)).status === "expired" && (await row(AEX2)).status === "expired",
    show({ rec4, g: (await row(AG)).status, p: (await row(AEX)).status, r: (await row(AEX2)).status }));
  const run4 = await dt.deriveActivityTouches();
  chk("E1 expired 는 다시 선점되지 않는다", run4.claimed === 0 && (await row(AEX)).status === "expired", show(run4));

  // ── B1 ──
  const AB = await log({ commit_sha: C4, repo: "r-main" });
  const lockFile = join(process.env.DOMAINMAP_REPOS_DIR, ".r-main.fetch.lock");
  writeFileSync(lockFile, JSON.stringify({ pid: 1, at: Date.now(), token: "other" }));
  const runB = await dt.deriveActivityTouches({ lockWaitMs: 300 });   // 일일 실행은 늘 fetch 한다
  rmSync(lockFile, { force: true });
  chk("B1 클론 잠금을 못 얻으면 pending 이고 오류가 아니다", (await row(AB)).status === "pending" && !(await row(AB)).error && runB.repos[0]?.busy === true && dt.statusForDerive(runB.repos) === "ok",
    show({ r: await row(AB), runB }));
  const runB2 = await dt.deriveActivityTouches({ activityId: AB });
  chk("B1 잠금이 풀리면 처리된다", (await row(AB)).status === "ok", show(runB2));

  // ── D1 ──
  const AD = await log({ commit_sha: C1, repo: "r-main" });
  await dt.deriveActivityTouches({ activityId: AD });
  await Q(`DELETE FROM activity WHERE id=$1`, [AD]);
  chk("D1 작업 기록을 지우면 상태 행·touch 가 함께 사라진다", !(await row(AD)) && (await touches(AD)).length === 0);
  const AD2 = await log({ commit_sha: C1, repo: "r-main" });
  await dt.reconcileDeriveRows(AD2);
  const td = (await Q(`UPDATE activity_touch_derive SET status='running', attempted_at=now() WHERE activity_id=$1 RETURNING attempted_at::text AS a`, [AD2]))[0].a;
  const deleter = await itemsPool.connect();
  await deleter.query("BEGIN");
  await deleter.query(`SELECT id FROM activity WHERE id=$1 FOR UPDATE`, [AD2]);
  const fin = dt.finishDerive({ activity_id: AD2, commit_sha: C1, repo_id: R, attempted_at: td }, { kind: "files", files: [["src/a/x.ts"]] });
  await new Promise((r) => setTimeout(r, 300));
  await deleter.query(`DELETE FROM activity WHERE id=$1`, [AD2]);
  await deleter.query("COMMIT");
  deleter.release();
  const finR = await fin;
  chk("D1 시도 중 삭제와 겹쳐도 교착 없이 gone", finR === "gone" && !(await row(AD2)) && (await touches(AD2)).length === 0, show(finR));

  // ── W1 ──
  const AW1 = await log({ commit_sha: C4, repo: "r-bad" });
  const AW2 = await log({ commit_sha: C4, repo: "r-main" });
  await setFlag(true);
  await Q(`UPDATE activity_touch_derive SET status='ok' WHERE status IN ('pending','failed')`);   // 앞 단계 잔여 정리
  await dt.reconcileDeriveRows();
  const w1 = await runCronById("derive-touches");
  chk("W1 레포 일부의 fetch 실패는 warn", w1.status === "warn" && (await row(AW1)).status === "failed" && (await row(AW2)).status === "ok"
    && /git clone\/fetch 실패/.test((await row(AW1)).error ?? ""), show({ w1, b: await row(AW1) }));
  chk("W1 오류에 클론 주소를 싣지 않는다", !(await row(AW1)).error.includes("missing.git"), (await row(AW1)).error);
  await Q(`UPDATE activity_touch_derive SET attempted_at = now() - interval '1 day' WHERE activity_id=$1`, [AW1]);
  const w2 = await runCronById("derive-touches");
  const cron2 = (await Q(`SELECT last_status, fail_streak FROM org_cron WHERE id='derive-touches'`))[0];
  chk("W1 시도한 레포가 전부 실패해도 warn — 브레이커 연속 실패에 세지 않는다", w2.status === "warn" && cron2.last_status === "warn" && cron2.fail_streak === 0, show({ w2: w2.status, cron2 }));

  // ── W2 ──
  await Q(`ALTER TABLE activity_touch_derive RENAME TO activity_touch_derive_x`);
  const w3 = await runCronById("derive-touches");
  await Q(`ALTER TABLE activity_touch_derive_x RENAME TO activity_touch_derive`);
  chk("W2 워커 SQL 실패는 크론 error", w3.status === "error" && /activity_touch_derive/.test(show(w3.summary)), show(w3));

  // ── P1 ──
  const AP = await log({ commit_sha: C1, repo: "r-main" });
  let rp;
  for (let i = 0; i < 50; i++) { rp = await row(AP); if (rp && rp.status !== "pending" && rp.status !== "running") break; await new Promise((r) => setTimeout(r, 100)); }
  chk("P1 스위치가 켜져 있으면 기록 직후 유도한다", rp?.status === "ok" && (await touches(AP)).length === 2, show(rp));
  await setFlag(false);
  //  클론 잠금을 남이 쥔 상태로 둔다 — fetch 를 시도하면 busy 로 드러난다.
  const lockP = join(process.env.DOMAINMAP_REPOS_DIR, ".r-main.fetch.lock");
  writeFileSync(lockP, JSON.stringify({ pid: 1, at: Date.now(), token: "other" }));
  const AQ = await log({ commit_sha: C4, repo: "r-main" });
  const runQ = await dt.deriveActivityTouches({ activityId: AQ, lockWaitMs: 300 });
  const AQ2 = await log({ commit_sha: GHOST, repo: "r-main" });
  await setFlag(true);
  const t0 = Date.now();
  await dt.deriveAfterLog(AQ2);                                              // 기록 직후 시도 그대로(짧은 잠금 대기)
  const waited = Date.now() - t0;
  await setFlag(false);
  rmSync(lockP, { force: true });
  chk("P1 커밋이 클론에 있으면 기록 직후 시도는 fetch 하지 않는다", (await row(AQ)).status === "ok" && !runQ.repos.some((r) => r.busy), show({ r: await row(AQ), repos: runQ.repos }));
  chk("P1 클론에 없으면 fetch 를 시도하고, 잠금을 짧게만 기다린 뒤 pending 으로 크론에 맡긴다(웹훅에 양보)",
    (await row(AQ2)).status === "pending" && dt.AFTER_LOG_LOCK_WAIT_MS < 2_500 && waited < 2_000, show({ r: await row(AQ2), waited }));

  // ── M1 ──
  await Q(`DELETE FROM activity_touch_derive`);
  const fx = [["ok", 2, 0, 0], ["ok", 1, 1, 0], ["empty", 0, 0, 0], ["failed", null, null, 0], ["expired", null, null, 0], ["no_repo", null, null, 0], ["no_units", null, null, 0], ["pending", null, null, 2]];
  for (const [status, changed, unmatched, ageDays] of fx) {
    const id = await log({});
    await Q(`INSERT INTO activity_touch_derive(activity_id, commit_sha, repo_id, status, changed_files, unmatched_files, enqueued_at)
             VALUES($1,'abc1234',$2,$3,$4,$5, now() - ($6 || ' days')::interval)`, [id, R, status, changed, unmatched, String(ageDays)]);
  }
  const st = await dt.deriveStats();
  chk("M1 완료율 3/5 — no_repo·no_units·pending 은 분모에서 뺀다", st.completion_rate === 0.6, show(st));
  chk("M1 매칭 0건 ok 1 · pending 1 · 가장 오래된 pending 2일", st.ok_zero_match === 1 && st.pending === 1 && st.oldest_pending_days === 2, show(st));
} catch (e) {
  fail++; console.log("FAIL 예외", e?.stack ?? e);
} finally {
  await itemsPool.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.end();
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
