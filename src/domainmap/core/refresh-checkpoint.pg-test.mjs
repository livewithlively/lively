// 도메인맵 refresh 체크포인트·잠금·모듈 내용 변경 시각 PG 통합 테스트 — **실제 Postgres 와 git 필요**.
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/domainmap/core/refresh-checkpoint.pg-test.mjs
//
// 왜 이 계층인가: 지키려는 것이 행 잠금 아래의 순서(두 refresh 가 같은 체크포인트를 읽는가)와 실제 git 범위라 목으로는 못 본다.
//  실패 방향이 조용하다 — 건너뛴 범위가 반영되지 않아도 오류 없이 200 이고 모듈 표에서 행 하나가 빠질 뿐이다.
//   C1 base 가 체크포인트면 적용·전진 · 안에서 파일만 바뀐 모듈만 content_changed_at·sha 가 오르고 updated_at 은 그대로
//   C2 base 가 체크포인트와 다르면 아무것도 적용하지 않고 전진하지 않는다(skipped.checkpoint 로 현재 값을 돌려준다)
//   C3 더 이른 커밋 시각으로 다시 와도 content_changed_at·sha 는 뒤로 가지 않고 전진한 행으로 세지 않는다(체크포인트는 전진)
//   C3b 커밋 시각이 미래여도 now() 로 막혀, 뒤따르는 정상 커밋이 sha 를 옮긴다
//   C3c head 없는 페이로드는 내용 시각을 쓰지 않고(sha 를 NULL 로 덮지 않음), base 만 있고 head 가 없으면 거절한다
//   C4 base 없는 페이로드(재기준)는 조건 없이 체크포인트를 세운다 · C5 체크포인트가 비어 있으면 첫 base 를 받아들인다
//   C7 같은 base 의 refresh 두 개(웹훅·refresh_all)를 동시에 돌리면 하나만 적용된다
//   C8 레포 삭제는 refresh 와 같은 순서(repo 행 먼저)로 잠가, refresh 중에 와도 교착 없이 뒤에 끝난다
//   G1 웹훅이 놓친 범위가 있어도 다음 웹훅이 체크포인트부터 diff 해 메운다(모듈 내용 시각 = 커밋 시각)
//   G2 이미 반영한 push 의 재전송·역순 도착은 체크포인트를 되돌리지 않는다
//   G3 refresh_all(git-pull)이 체크포인트부터 diff 한다
//   G4 겹친 push — 웹훅이 읽은 뒤 다른 refresh 가 체크포인트를 옮기면, 옮겨진 체크포인트부터 한 번 다시 diff 한다
//   G5 force-push(이력 재작성) 뒤의 push 도 체크포인트..after 트리 diff 로 반영한다
//   G6 체크포인트가 클론에 없는 커밋이거나 sha 가 아니면, 브랜치 끝을 가리키는 push 의 before..after 로 재기준한다
//      (웹훅이 멈추지 않는다) · 응답 문구로 원인을 가른다
//   G7 브랜치를 되감은 push 는 「이미 적용」이 아니다 — 체크포인트..after 를 거꾸로 적용해 모듈 이름 변경도 되돌린다
//   G8 체크포인트를 쓸 수 없을 때 브랜치 끝이 아닌 옛 push 의 재전송은 재기준하지 않는다(뒤로 가지 않는다)
//   G9 되감기로 체크포인트가 브랜치 밖인데 push 가 브랜치 끝이 아니면 적용하지 않는다(브랜치에 없는 상태로 옮기지 않는다)
//   G10 판정용 git 조회가 실패하면(브랜치 ref 없음) 503 으로 끊고 체크포인트를 쓰지 않는다 — 에러를 「아님」으로 읽지 않는다
import pg from "pg";
import http from "node:http";
import express from "express";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_refresh_checkpoint";
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
const dbc = new pg.Client({ connectionString: dsnFor(DB) }); await dbc.connect();
await dbc.query("CREATE EXTENSION IF NOT EXISTS vector");
await dbc.end();
process.env.ITEMS_DATABASE_URL = dsnFor(DB);
for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE", "EMBEDDINGS_PROVIDER"]) delete process.env[k];

const ROOT = mkdtempSync(path.join(os.tmpdir(), "lively-refresh-ckpt-pg-"));
process.env.DOMAINMAP_REPOS_DIR = path.join(ROOT, "clones");
process.env.WEBHOOK_SECRET = "pgt-refresh-checkpoint-secret";

const D = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const { itemsPool } = await import(`${D}/db/client.js`);
const { refresh } = await import(`${D}/domainmap/core/refresh.js`);
const { refreshRepoFromGit } = await import(`${D}/domainmap/git-pull.js`);
const { domainmapWebhookRouter } = await import(`${D}/domainmap/webhook.js`);
const { hardDeleteRepo } = await import(`${D}/domainmap/core/repos.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));
const section = async (name, fn) => { try { await fn(); } catch (e) { bad(name, `예외 ${e?.message ?? e}`); } };

const q = async (sql, args = []) => (await itemsPool.query(sql, args)).rows;
const sha = (c) => c.repeat(40);
const AGENT = { type: "agent", id: "pgt" };
const UPDATED = "2026-01-01T00:00:00.000Z";

const makeRepo = async (name, checkpoint, units, extra = {}) => {
  const [r] = await q(`INSERT INTO repo(name, detected_stack, state, created_at, last_refreshed_sha, git_url, default_branch)
                       VALUES($1,'{}','active',now(),$2,$3,'main') RETURNING id`, [name, checkpoint, extra.git_url ?? null]);
  for (const p of units) {
    await q(`INSERT INTO code_unit(repo_id,kind,path,label,state,created_at,updated_at) VALUES($1,'module',$2,$2,'active',now(),$3)`, [r.id, p, UPDATED]);
  }
  return r.id;
};
const checkpointOf = async (name) => (await q(`SELECT last_refreshed_sha FROM repo WHERE name=$1`, [name]))[0]?.last_refreshed_sha ?? null;
const unit = async (repoId, p) => (await q(
  `SELECT path, state, updated_at, content_changed_at, content_changed_sha FROM code_unit WHERE repo_id=$1 AND path=$2`, [repoId, p]))[0] ?? null;
const iso = (v) => (v == null ? null : new Date(v).toISOString());

let server;
try {
  // ── C1~C5: 체크포인트 조건부 전진과 모듈 내용 시각 ──
  const A = "pgt-ckpt-a";
  const aId = await makeRepo(A, sha("a"), ["src/u", "src/v"]);
  const T1 = "2026-03-01T10:00:00.000Z", T0 = "2026-02-01T10:00:00.000Z";

  await section("C1", async () => {
    const r = await refresh(A, { base: sha("a"), head: sha("b"), head_committed_at: T1, granularity: "file",
      changes: [{ status: "M", path: "src/u/a.ts" }, { status: "M", path: "README.md" }] }, AGENT);
    chk("C1 적용 — skipped 없음", !r.skipped, JSON.stringify(r));
    chk("C1 체크포인트 전진", (await checkpointOf(A)) === sha("b"));
    const u = await unit(aId, "src/u"), v = await unit(aId, "src/v");
    chk("C1 바뀐 모듈의 content_changed_at = head 커밋 시각", iso(u.content_changed_at) === T1, JSON.stringify(u));
    chk("C1 바뀐 모듈의 content_changed_sha = head", u.content_changed_sha === sha("b"));
    chk("C1 updated_at(구조 변경 시각)은 그대로", iso(u.updated_at) === UPDATED, JSON.stringify(u));
    chk("C1 안 바뀐 모듈은 비어 있다", v.content_changed_at === null && v.content_changed_sha === null, JSON.stringify(v));
    chk("C1 tally.content_changed = 1", r.tally?.content_changed === 1, JSON.stringify(r.tally));
  });

  await section("C2", async () => {
    const r = await refresh(A, { base: sha("a"), head: sha("c"), granularity: "file",
      changes: [{ status: "A", path: "src/stale/x.ts" }, { status: "M", path: "src/v/b.ts" }] }, AGENT);
    chk("C2 skipped = checkpoint_moved · 현재 체크포인트를 돌려준다",
      r.skipped?.reason === "checkpoint_moved" && r.skipped?.checkpoint === sha("b"), JSON.stringify(r));
    chk("C2 체크포인트 그대로", (await checkpointOf(A)) === sha("b"));
    chk("C2 추가가 적용되지 않았다", (await unit(aId, "src/stale")) === null);
    chk("C2 내용 시각도 쓰지 않았다", (await unit(aId, "src/v")).content_changed_at === null);
  });

  await section("C3", async () => {
    const r = await refresh(A, { base: sha("b"), head: sha("c"), head_committed_at: T0, granularity: "file",
      changes: [{ status: "M", path: "src/u/z.ts" }] }, AGENT);
    chk("C3 적용", !r.skipped, JSON.stringify(r));
    const u = await unit(aId, "src/u");
    chk("C3 더 이른 커밋 시각은 content_changed_at 을 되돌리지 않는다", iso(u.content_changed_at) === T1, JSON.stringify(u));
    chk("C3 sha 도 그대로", u.content_changed_sha === sha("b"));
    chk("C3 체크포인트는 전진", (await checkpointOf(A)) === sha("c"));
    chk("C3 전진하지 않은 행은 content_changed 로 세지 않는다", r.tally?.content_changed === 0, JSON.stringify(r.tally));
  });

  await section("C3b", async () => {
    const r1 = await refresh(A, { base: sha("c"), head: sha("5"), head_committed_at: "2099-01-01T00:00:00Z", granularity: "file",
      changes: [{ status: "M", path: "src/u/a.ts" }] }, AGENT);
    const [u1] = await q(`SELECT content_changed_at, content_changed_at <= now() AS capped FROM code_unit WHERE repo_id=$1 AND path='src/u'`, [aId]);
    chk("C3b 미래 커밋 시각은 now() 로 막힌다", !r1.skipped && u1.capped === true, JSON.stringify(u1));
    const r2 = await refresh(A, { base: sha("5"), head: sha("6"), head_committed_at: new Date().toISOString(), granularity: "file",
      changes: [{ status: "M", path: "src/u/a.ts" }] }, AGENT);
    const u2 = await unit(aId, "src/u");
    chk("C3b 뒤따르는 정상 커밋이 sha 를 옮긴다", u2.content_changed_sha === sha("6") && r2.tally?.content_changed === 1, JSON.stringify({ u2, t: r2.tally }));
  });

  await section("C3c", async () => {
    const before = await unit(aId, "src/u");
    const r = await refresh(A, { changes: [{ status: "M", path: "src/u" }] }, AGENT);
    const after = await unit(aId, "src/u");
    chk("C3c head 없으면 내용 시각·sha 를 쓰지 않는다",
      after.content_changed_sha === before.content_changed_sha && iso(after.content_changed_at) === iso(before.content_changed_at) && !r.tally?.content_changed,
      JSON.stringify({ before, after }));
    let err = null;
    try { await refresh(A, { base: sha("6"), changes: [{ status: "A", path: "src/nohead/x.ts" }] }, AGENT); } catch (e) { err = e; }
    chk("C3c base 만 있고 head 가 없으면 400 으로 거절", err?.status === 400 && (await unit(aId, "src/nohead")) === null, String(err?.message));
    chk("C3c 체크포인트 그대로", (await checkpointOf(A)) === sha("6"));
  });

  await section("C4", async () => {
    const r = await refresh(A, { head: sha("d"), changes: [] }, AGENT);
    chk("C4 base 없는 재기준은 조건 없이 체크포인트를 세운다", !r.skipped && (await checkpointOf(A)) === sha("d"), JSON.stringify(r));
  });

  await section("C5", async () => {
    const N = "pgt-ckpt-null";
    const nId = await makeRepo(N, null, ["src/u"]);
    const r = await refresh(N, { base: sha("1"), head: sha("2"), granularity: "file", changes: [{ status: "A", path: "src/n/x.ts" }] }, AGENT);
    chk("C5 체크포인트가 비어 있으면 첫 base 를 받아 적용·전진", !r.skipped && (await checkpointOf(N)) === sha("2") && (await unit(nId, "src/n")) !== null, JSON.stringify(r));
  });

  // ── C7: 동시 refresh 두 개 ──
  await section("C7", async () => {
    const [r1, r2] = await Promise.all([
      refresh(A, { base: sha("d"), head: sha("7"), granularity: "file", changes: [{ status: "A", path: "src/p1/x.ts" }] }, { type: "agent", id: "webhook:gitlab" }),
      refresh(A, { base: sha("d"), head: sha("8"), granularity: "file", changes: [{ status: "A", path: "src/p2/x.ts" }] }, { type: "agent", id: "refresh_all" }),
    ]);
    const applied = [r1, r2].filter((r) => !r.skipped);
    chk("C7 하나만 적용되고 하나는 건너뛴다", applied.length === 1, JSON.stringify([r1, r2]));
    const p1 = await unit(aId, "src/p1"), p2 = await unit(aId, "src/p2");
    chk("C7 적용된 쪽의 변경만 남는다", (p1 !== null) !== (p2 !== null), JSON.stringify({ p1, p2 }));
    chk("C7 체크포인트 = 적용된 쪽의 head", applied.length === 1 && (await checkpointOf(A)) === applied[0].head);
  });

  // ── C8: 레포 삭제의 잠금 순서 ──
  await section("C8", async () => {
    const X = "pgt-ckpt-del";
    const xId = await makeRepo(X, sha("a"), ["src/u"]);
    const holder = await itemsPool.connect();
    try {
      // refresh 와 같은 순서: repo 행을 잡은 뒤 code_unit 을 쓴다.
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM repo WHERE id=$1 FOR UPDATE", [xId]);
      const del = hardDeleteRepo(X, true, AGENT).then(() => null, (e) => e);
      let waiting = false;
      for (let i = 0; i < 200 && !waiting; i++) {
        const [w] = await q(`SELECT count(*)::int n FROM pg_stat_activity
                              WHERE wait_event_type='Lock' AND query ILIKE '%FROM repo WHERE id=%FOR UPDATE%' AND pid <> pg_backend_pid()`);
        waiting = w.n > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 50));
      }
      chk("C8 삭제가 잠금에서 기다린다(전제)", waiting);
      let holderErr = null;
      try {
        await holder.query("UPDATE code_unit SET updated_at=now() WHERE repo_id=$1", [xId]);
        await holder.query("COMMIT");
      } catch (e) { holderErr = e; await holder.query("ROLLBACK").catch(() => {}); }
      const delErr = await del;
      chk("C8 교착 없이 refresh 쪽이 먼저 끝난다", holderErr === null, String(holderErr?.message));
      chk("C8 삭제도 끝난다", delErr === null && (await checkpointOf(X)) === null, String(delErr?.message));
    } finally { holder.release(); }
  });

  // ── G1~G3: 실제 git 범위(웹훅·refresh_all) ──
  const ORIGIN = path.join(ROOT, "origin");
  mkdirSync(ORIGIN, { recursive: true });
  const g = (args, date) => execFileSync("git", ["-C", ORIGIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
  }).trim();
  const put = (rel, text) => { mkdirSync(path.dirname(path.join(ORIGIN, rel)), { recursive: true }); writeFileSync(path.join(ORIGIN, rel), text); };
  const commit = (msg, date) => { g(["add", "-A"]); g(["commit", "-q", "-m", msg], date); return g(["rev-parse", "HEAD"]); };
  g(["init", "-q", "-b", "main"]);
  put("src/u/a.ts", "1\n"); put("src/v/b.ts", "1\n");
  const c1 = commit("c1", "2026-04-01T00:00:00Z");
  put("src/w/x.ts", "new\n");
  const c2 = commit("c2", "2026-04-02T00:00:00Z");
  put("src/u/a.ts", "2\n");
  const c3 = commit("c3", "2026-04-03T00:00:00Z");

  const GR = "pgt-ckpt-git";
  const gId = await makeRepo(GR, c1, ["src/u", "src/v"], { git_url: ORIGIN });

  const app = express();
  app.use("/api/webhook", domainmapWebhookRouter());
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const push = async (before, after, branch = "main") => {
    const res = await fetch(`http://127.0.0.1:${port}/api/webhook/gitlab`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gitlab-token": process.env.WEBHOOK_SECRET },
      body: JSON.stringify({ object_kind: "push", ref: `refs/heads/${branch}`, before, after, project: { path_with_namespace: `grp/${GR}`, name: GR } }),
    });
    return { status: res.status, body: await res.json() };
  };

  await section("G1", async () => {
    // c1..c2 의 웹훅은 오지 않았다(클론 잠금·미수신으로 건너뜀). 다음 push 는 before=c2.
    const r = await push(c2, c3);
    chk("G1 200", r.status === 200, JSON.stringify(r));
    chk("G1 체크포인트(c1)부터 diff 했다", r.body.base === c1, JSON.stringify(r.body));
    chk("G1 놓친 범위의 새 모듈이 들어왔다", (await unit(gId, "src/w")) !== null);
    chk("G1 체크포인트 = c3", (await checkpointOf(GR)) === c3);
    const u = await unit(gId, "src/u");
    chk("G1 모듈 내용 시각 = c3 의 커밋 시각 · sha = c3",
      iso(u?.content_changed_at) === "2026-04-03T00:00:00.000Z" && u?.content_changed_sha === c3, JSON.stringify(u));
  });

  await section("G2", async () => {
    const r = await push(c1, c2);
    chk("G2 이미 반영한 push 는 무시", r.status === 200 && typeof r.body.ignored === "string" && r.body.ignored.startsWith("already applied"), JSON.stringify(r));
    chk("G2 체크포인트를 되돌리지 않는다", (await checkpointOf(GR)) === c3);
    const r2 = await push(c2, c3);
    chk("G2 같은 push 재전송도 무시", r2.status === 200 && typeof r2.body.ignored === "string", JSON.stringify(r2));
  });

  await section("G3", async () => {
    put("src/v/b.ts", "2\n");
    const c4 = commit("c4", "2026-04-04T00:00:00Z");
    const r = await refreshRepoFromGit(GR, { type: "agent", id: "refresh_all" });
    chk("G3 refresh_all 이 체크포인트(c3)부터 diff", r.status === "ok" && r.base === c3 && r.head === c4, JSON.stringify(r));
    const v = await unit(gId, "src/v");
    chk("G3 c4 의 수정이 반영됐다", iso(v?.content_changed_at) === "2026-04-04T00:00:00.000Z" && v?.content_changed_sha === c4, JSON.stringify(v));
    chk("G3 체크포인트 = c4", (await checkpointOf(GR)) === c4);
  });

  await section("G4", async () => {
    put("src/r/x.ts", "r\n");
    const c5 = commit("c5", "2026-04-05T00:00:00Z");
    put("src/u/a.ts", "3\n");
    const c6 = commit("c6", "2026-04-06T00:00:00Z");
    // c4→c5 를 반영하는 다른 refresh 가 repo 행을 쥔 사이에 c5→c6 push 가 온다. 웹훅은 체크포인트 c4 를 읽고
    // c4..c6 로 refresh 에 들어가 행 잠금에서 기다린다.
    const holder = await itemsPool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM repo WHERE name=$1 FOR UPDATE", [GR]);
      const pending = push(c5, c6);
      let waiting = false;
      for (let i = 0; i < 200 && !waiting; i++) {
        const [w] = await q(`SELECT count(*)::int n FROM pg_stat_activity
                              WHERE wait_event_type='Lock' AND query ILIKE '%FROM repo WHERE name=%FOR UPDATE%' AND pid <> pg_backend_pid()`);
        waiting = w.n > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 50));
      }
      chk("G4 웹훅이 repo 행 잠금에서 기다린다(전제)", waiting);
      await holder.query("UPDATE repo SET last_refreshed_sha=$1 WHERE name=$2", [c5, GR]);
      await holder.query("COMMIT");
      const r = await pending;
      chk("G4 옮겨진 체크포인트(c5)부터 다시 diff 해 적용", r.status === 200 && !r.body.ignored && r.body.base === c5, JSON.stringify(r));
      chk("G4 체크포인트 = c6", (await checkpointOf(GR)) === c6);
      chk("G4 c6 의 수정이 반영됐다", (await unit(gId, "src/u"))?.content_changed_sha === c6);
      chk("G4 출발점 c4 는 쓰지 않았다(c4..c5 의 새 모듈은 다른 refresh 몫)", (await unit(gId, "src/r")) === null);
    } finally { holder.release(); }
  });

  await section("G5", async () => {
    const c6 = await checkpointOf(GR);
    g(["reset", "-q", "--hard", c1]);
    put("src/z/x.ts", "z\n");
    const c7 = commit("c7", "2026-04-07T00:00:00Z");
    const r = await push(c6, c7);
    chk("G5 force-push 뒤 push 를 체크포인트부터 반영", r.status === 200 && !r.body.ignored && r.body.base === c6, JSON.stringify(r));
    chk("G5 새 모듈 · 체크포인트 = c7", (await unit(gId, "src/z")) !== null && (await checkpointOf(GR)) === c7);
  });

  // 쓸 수 없는 체크포인트 두 갈래 — 브랜치 끝을 가리키는 push 는 재기준한다.
  for (const [id, broken, why, dir] of [
    ["G6a", sha("d"), /not in clone/, "src/y"],
    ["G6b", "not-a-sha", /not a sha/, "src/q"],
  ]) {
    await section(id, async () => {
      const prev = await checkpointOf(GR);
      await q(`UPDATE repo SET last_refreshed_sha=$1 WHERE name=$2`, [broken, GR]);
      put(`${dir}/x.ts`, "x\n");
      const tip = commit(id, "2026-04-08T00:00:00Z");
      const r = await push(prev, tip);
      chk(`${id} 재기준 · 원인 문구`, r.status === 200 && !r.body.ignored && r.body.base === prev && why.test(r.body.note ?? ""), JSON.stringify(r));
      chk(`${id} 새 모듈 · 체크포인트 = 브랜치 끝`, (await unit(gId, dir)) !== null && (await checkpointOf(GR)) === tip);
    });
  }

  await section("G7", async () => {
    const base = await checkpointOf(GR);
    put("src/k/a.ts", "a\n"); put("src/k/b.ts", "b\n");
    const k1 = commit("k1", "2026-04-10T00:00:00Z");
    await push(base, k1);
    g(["mv", "src/k", "src/k2"]);
    const k2 = commit("k2", "2026-04-11T00:00:00Z");
    const r1 = await push(k1, k2);
    chk("G7 전제 — 모듈 이름 변경 src/k → src/k2", !r1.body.ignored && (await unit(gId, "src/k2"))?.state === "active", JSON.stringify(r1));
    // 브랜치를 k1 로 되감아 force-push 했다.
    g(["reset", "-q", "--hard", k1]);
    const r = await push(k2, k1);
    chk("G7 되감기 push 는 무시하지 않는다", r.status === 200 && !r.body.ignored && r.body.base === k2, JSON.stringify(r));
    chk("G7 이름 변경이 되돌아간다", (await unit(gId, "src/k"))?.state === "active" && (await unit(gId, "src/k2")) === null);
    chk("G7 체크포인트 = k1", (await checkpointOf(GR)) === k1);
  });

  await section("G8", async () => {
    const tipNow = await checkpointOf(GR);
    put("src/late/x.ts", "l\n");
    const n1 = commit("n1", "2026-04-12T00:00:00Z");
    put("src/v/b.ts", "3\n");
    const n2 = commit("n2", "2026-04-13T00:00:00Z");
    await q(`UPDATE repo SET last_refreshed_sha=$1 WHERE name=$2`, [sha("e"), GR]);
    // 브랜치 끝은 n2 인데 옛 push(tipNow→n1)가 다시 배달됐다.
    const r = await push(tipNow, n1);
    chk("G8 브랜치 끝이 아닌 push 는 재기준하지 않는다", r.status === 200 && /not the branch tip/.test(r.body.ignored ?? ""), JSON.stringify(r));
    chk("G8 체크포인트·모듈을 쓰지 않았다", (await checkpointOf(GR)) === sha("e") && (await unit(gId, "src/late")) === null);
    const r2 = await push(n1, n2);
    chk("G8 브랜치 끝 push 는 재기준한다", !r2.body.ignored && (await checkpointOf(GR)) === n2, JSON.stringify(r2));
  });
  await section("G9", async () => {
    const n2 = await checkpointOf(GR);
    put("src/m/x.ts", "m\n");
    const m1 = commit("m1", "2026-04-14T00:00:00Z");
    const r0 = await push(n2, m1);
    chk("G9 전제 — m1 반영", !r0.body.ignored && (await checkpointOf(GR)) === m1, JSON.stringify(r0));
    g(["reset", "-q", "--hard", n2]);
    put("src/v/b.ts", "4\n");
    const m2 = commit("m2", "2026-04-15T00:00:00Z");
    // 브랜치 끝은 m2, 체크포인트 m1 은 브랜치 밖. 옛 push(…→n2)가 다시 배달됐다.
    const r = await push(n2, n2);
    chk("G9 브랜치 밖 체크포인트 + 브랜치 끝 아닌 push → 적용하지 않는다",
      r.status === 200 && /off the branch/.test(r.body.ignored ?? ""), JSON.stringify(r));
    chk("G9 체크포인트 그대로", (await checkpointOf(GR)) === m1);
    const r2 = await push(n2, m2);
    chk("G9 브랜치 끝 push 는 체크포인트..after 로 적용", !r2.body.ignored && r2.body.base === m1 && (await checkpointOf(GR)) === m2, JSON.stringify(r2));
  });

  await section("G10", async () => {
    const cp = await checkpointOf(GR);
    const older = execFileSync("git", ["-C", ORIGIN, "rev-parse", "HEAD~1"], { encoding: "utf8" }).trim();
    // 클론에 없는 브랜치를 기본 브랜치로 둔다 — origin/<그 이름> 조회가 git 오류를 낸다.
    await q(`UPDATE repo SET default_branch='ghost-branch' WHERE name=$1`, [GR]);
    try {
      const r = await push(older, older, "ghost-branch");
      chk("G10 판정 실패는 503", r.status === 503, JSON.stringify(r));
      chk("G10 체크포인트를 쓰지 않았다", (await checkpointOf(GR)) === cp);
    } finally {
      await q(`UPDATE repo SET default_branch='main' WHERE name=$1`, [GR]);
    }
  });
} catch (e) {
  fail++; console.error("FAIL 예외", e);
} finally {
  if (server) await new Promise((r) => server.close(r));
  await itemsPool.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.end();
  rmSync(ROOT, { recursive: true, force: true });
}
console.log(`\n${pass} ok · ${fail} fail`);
process.exit(fail ? 1 : 0);
