// 로그인 판 작업 행(org_login_job)의 실 SQL · 워크스페이스 격리 (#4067) — 가짜 저장소(login-job.test)가 흉내 낸 규칙이
//  **진짜 SQL** 에서도 그런지 본다: 살아 있을 때만 끝낸다 · 붙여넣기는 한 번만(동시 박동에도) · 남의 워크스페이스 행은 0 ·
//  돌지 않은 행만 지운다 · CHECK 가 모르는 값을 막는다 · 스키마 체인이 두 번 돌아도 무사하다.
//  ⚠ 수동 실행(docker):  npm run build && node scripts/login-job-store.itest.mjs
//  구성: 자식 프로세스(소유자)가 전체 스키마 체인 + 테넌트 정책을 올리고, 본 프로세스는 **앱 role(NOBYPASSRLS)** 로
//   붙어 요청별 바인딩(installTenantResolver)으로 두 워크스페이스를 오간다 — 게이트웨이와 같은 길이다.
import { execFileSync, execSync } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const PORT = 59481, CNAME = "co-login-job-store-itest";
const superUrl = `postgres://postgres:pw@127.0.0.1:${PORT}/postgres`;
const appUrl = `postgres://lvly_app_postgres:apppw@127.0.0.1:${PORT}/postgres`;
const A = "11111111-1111-1111-1111-111111111111", B = "22222222-2222-2222-2222-222222222222";

// ── 자식: 소유자로 스키마·정책·앱 role ──────────────────────────────────────────
if (process.argv[2] === "--schema") {
  process.env.ITEMS_DATABASE_URL = superUrl;
  delete process.env.LIVELY_TENANT_BINDING;
  const { itemsPool } = await import("../dist/db/client.js");
  const { initAllSchemas } = await import("../dist/boot/schemas.js");
  const { ensureTenantPolicies } = await import("../dist/org/tenancy/activate.js");
  await initAllSchemas({ quiet: true });
  await initAllSchemas({ quiet: true });   // 멱등 — 롤마다 다시 돈다
  await itemsPool.query("CREATE ROLE lvly_app_postgres LOGIN PASSWORD 'apppw' NOSUPERUSER NOBYPASSRLS");
  await itemsPool.query("GRANT USAGE ON SCHEMA public TO lvly_app_postgres");
  await itemsPool.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO lvly_app_postgres");
  await itemsPool.query("GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO lvly_app_postgres");
  const r = await ensureTenantPolicies(itemsPool);
  console.log(`· 정책 ${r.tables}표 · 손댐 ${r.touched}`);
  await itemsPool.end();
  process.exit(0);
}

let pass = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString();
try { sh(`docker rm -f -v ${CNAME} 2>/dev/null`); } catch { /* */ }
console.log("· pg 컨테이너 기동…");
execFileSync("docker", ["run", "-d", "--name", CNAME, "-e", "POSTGRES_PASSWORD=pw", "-p", `${PORT}:5432`, "postgres:16-alpine"], { stdio: "ignore" });

let exitCode = 0;
try {
  let ready = false;
  for (let i = 0; i < 60; i++) { try { sh(`docker exec ${CNAME} pg_isready -U postgres`); ready = true; break; } catch { /* */ } execSync("sleep 0.5"); }
  assert.ok(ready, "pg 준비 실패");
  execSync("sleep 1");

  const env = { ...process.env };
  for (const k of ["ITEMS_DATABASE_URL", "LIVELY_TENANT_BINDING", "LIVELY_TENANCY_MODE", "LIVELY_OWNER_DATABASE_URL", "LIVELY_SKIP_SCHEMA_INIT"]) delete env[k];
  execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--schema"], { env, stdio: "inherit" });
  ok("스키마 체인 두 번 + 테넌트 정책 — 새 표가 체인 안에서 선다");

  // ── 표 모양(소유자 시야) ──
  const pg = (await import("pg")).default;
  const owner = new pg.Client({ connectionString: superUrl });
  await owner.connect();
  const meta = await owner.query(`
    SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
           (SELECT array_agg(policyname::text ORDER BY policyname) FROM pg_policies WHERE tablename='org_login_job') AS pols,
           (SELECT array_agg(indexname::text ORDER BY indexname) FROM pg_indexes WHERE tablename='org_login_job') AS idx,
           EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='org_login_job' AND column_name='tenant_id') AS has_tenant
      FROM pg_class c WHERE c.relname='org_login_job'`);
  const m = meta.rows[0];
  assert.ok(m, "org_login_job 표가 없다");
  assert.equal(m.has_tenant, true, "tenant_id 가 붙었다");
  assert.equal(m.rls, true);
  assert.equal(m.forced, true);
  assert.ok(m.pols.includes("tenant_isolation") && m.pols.includes("owner_all"), m.pols.join(","));
  assert.ok(m.idx.includes("org_login_job_member_idx") && m.idx.includes("org_login_job_open_idx"), m.idx.join(","));
  ok("표 — tenant_id · RLS(FORCE) · 격리 정책 · 두 색인");

  // ── 본: 앱 role + 요청별 바인딩 ──
  process.env.ITEMS_DATABASE_URL = appUrl;
  delete process.env.LIVELY_TENANT_BINDING;
  const client = await import("../dist/db/client.js");
  let cur = A;
  client.installTenantResolver(() => cur);
  const as = async (t, fn) => { const prev = cur; cur = t; try { return await fn(); } finally { cur = prev; } };
  const S = await import("../dist/terminal/login-job-store.js");

  // S1 만들기
  const s1 = S.newJobSecret();
  const j = await as(A, () => S.createLoginJob({ memberId: "m-1", harness: "claude", purpose: "headless", secretHash: s1.hash, adminBasis: "member" }));
  assert.equal(typeof j.id, "number");
  assert.equal(j.status, "starting");
  assert.equal(j.admin_basis, "member");
  assert.equal(j.reaped, false);
  assert.equal(j.screen, "");
  assert.equal(j.paste, null);
  assert.ok(j.created_at instanceof Date && j.ui_seen_at instanceof Date);
  assert.equal(j.unit_seen_at, null);
  assert.equal(S.jobSecretMatches(j, s1.secret), true, "DB 에서 읽은 해시로 대조한다");
  assert.equal(S.jobSecretMatches(j, s1.secret + "x"), false);
  assert.ok(!JSON.stringify(j).includes(s1.secret), "원문은 행에 없다");
  ok("S1 만들기 — 기본값(starting · 빈 화면 · 박동 없음) · 해시만");

  // S2 남의 워크스페이스는 0
  assert.equal(await as(B, () => S.getLoginJob(j.id)), null);
  assert.equal(await as(B, () => S.latestLoginJob("m-1", "headless", "claude")), null);
  assert.deepEqual(await as(B, () => S.openLoginJobs()), []);
  assert.equal(await as(B, () => S.tickLoginJob(j.id, "B 가 쓴 화면")), null);
  assert.equal(await as(B, () => S.setLoginJobPaste(j.id, "enc:B")), false);
  assert.equal(await as(B, () => S.finishLoginJob(j.id, "cancelled", { error: "B" })), false);
  assert.equal(await as(B, () => S.markLoginJobRunning(j.id, "lvly-task-b-1-l1")), null);
  await as(B, () => S.markLoginJobReaped(j.id));
  await as(B, () => S.touchLoginJobUi(j.id));
  await as(B, () => S.deleteLoginJob(j.id));
  const still = await as(A, () => S.getLoginJob(j.id));
  assert.equal(still.status, "starting");
  assert.equal(still.unit, null);
  assert.equal(still.reaped, false);
  assert.equal(still.screen, "");
  assert.equal(still.paste, null);
  assert.equal(still.ui_seen_at.getTime(), j.ui_seen_at.getTime());
  ok("★ S2 격리 — B 는 A 의 작업을 못 보고 못 바꾼다(읽기·박동·붙여넣기·끝내기·치우기·지우기)");

  // S3 바인딩 없음 = 시끄럽게 실패
  cur = null;
  await assert.rejects(() => S.getLoginJob(j.id), /app\.tenant_id|unrecognized configuration|invalid input/);
  cur = A;
  ok("S3 컨텍스트 없는 조회는 0행이 아니라 오류(fail-closed)");

  // S4 running 은 starting 에서만
  assert.equal(await as(A, () => S.markLoginJobRunning(j.id, "lvly-task-a-1-l1")), "running");
  assert.equal(await as(A, () => S.markLoginJobRunning(j.id, "lvly-task-other-l1")), null);
  const r4 = await as(A, () => S.getLoginJob(j.id));
  assert.equal(r4.status, "running");
  assert.equal(r4.unit, "lvly-task-a-1-l1", "두 번째 표시는 무시");
  ok("S4 running 표시는 starting 에서 한 번만");

  // S5 박동 · 붙여넣기 한 번
  assert.equal(await as(A, () => S.setLoginJobPaste(j.id, "enc:code-1")), true);
  const t1 = await as(A, () => S.tickLoginJob(j.id, "화면 1"));
  assert.deepEqual(t1, { paste: "enc:code-1" });
  const t2 = await as(A, () => S.tickLoginJob(j.id, "화면 2"));
  assert.deepEqual(t2, { paste: null });
  const r5 = await as(A, () => S.getLoginJob(j.id));
  assert.equal(r5.screen, "화면 2");
  assert.ok(r5.unit_seen_at instanceof Date);
  assert.equal(r5.paste, null);
  ok("S5 박동 — 화면·박동 시각 · 붙여넣기는 꺼내며 지운다");

  // S6 동시 박동에도 코드는 한 번
  for (let round = 0; round < 5; round++) {
    assert.equal(await as(A, () => S.setLoginJobPaste(j.id, `enc:race-${round}`)), true);
    const got = await as(A, () => Promise.all(Array.from({ length: 6 }, (_, i) => S.tickLoginJob(j.id, `동시 ${i}`))));
    const delivered = got.filter((g) => g && g.paste);
    assert.equal(delivered.length, 1, `round ${round}: ${JSON.stringify(got)}`);
    assert.equal(delivered[0].paste, `enc:race-${round}`);
  }
  ok("★ S6 동시 박동 6개 × 5회 — 코드는 매번 정확히 한 번만 나간다");

  // S7 먼저 온 끝이 이긴다
  await as(A, () => S.setLoginJobPaste(j.id, "enc:left"));
  assert.equal(await as(A, () => S.finishLoginJob(j.id, "done", {})), true);
  assert.equal(await as(A, () => S.finishLoginJob(j.id, "failed", { error: "늦은 실패" })), false);
  const r7 = await as(A, () => S.getLoginJob(j.id));
  assert.equal(r7.status, "done");
  assert.equal(r7.error, null);
  assert.equal(r7.paste, null, "끝나며 코드를 지운다");
  assert.ok(r7.finished_at instanceof Date);
  assert.equal(await as(A, () => S.tickLoginJob(j.id, "끝난 뒤")), null);
  assert.equal(await as(A, () => S.setLoginJobPaste(j.id, "enc:late")), false);
  ok("★ S7 끝 — 살아 있을 때만 · 먼저 온 쪽이 이긴다 · 끝난 뒤 박동·코드 없음");

  // S8 끝의 부가 칸 — 준 것만 바꾼다
  const k = await as(A, () => S.createLoginJob({ memberId: "m-1", harness: "codex", purpose: "login", secretHash: S.newJobSecret().hash, adminBasis: "none" }));
  await as(A, () => S.tickLoginJob(k.id, "박동 화면"));
  assert.equal(await as(A, () => S.finishLoginJob(k.id, "failed", { exitCode: 3 })), true);
  const r8 = await as(A, () => S.getLoginJob(k.id));
  assert.equal(r8.exit_code, 3);
  assert.equal(r8.error, null);
  assert.equal(r8.screen, "박동 화면", "끝 화면을 안 주면 박동 화면이 남는다");
  const k2 = await as(A, () => S.createLoginJob({ memberId: "m-1", harness: "codex", purpose: "login", secretHash: S.newJobSecret().hash, adminBasis: "none" }));
  assert.equal(await as(A, () => S.finishLoginJob(k2.id, "expired", { error: "사유", screen: "끝 화면" })), true);
  const r8b = await as(A, () => S.getLoginJob(k2.id));
  assert.equal(r8b.error, "사유");
  assert.equal(r8b.screen, "끝 화면");
  assert.equal(r8b.exit_code, null);
  ok("S8 끝의 사유·종료코드·화면은 준 것만");

  // S9 최근 작업
  const latest = await as(A, () => S.latestLoginJob("m-1", "login", "codex"));
  assert.equal(latest.id, k2.id, "같은 사람·용도·하네스의 가장 최근");
  assert.equal((await as(A, () => S.latestLoginJob("m-1", "headless", "claude"))).id, j.id);
  assert.equal(await as(A, () => S.latestLoginJob("m-1", "login", "claude")), null, "용도가 다르면 다른 시도");
  assert.equal(await as(A, () => S.latestLoginJob("m-2", "login", "codex")), null, "사람이 다르면 다른 시도");
  ok("S9 최근 작업 — (사람·용도·하네스) 별 가장 큰 id");

  // S10 정리 감시가 볼 행
  const open1 = (await as(A, () => S.openLoginJobs())).map((r) => r.id);
  assert.deepEqual(open1, [j.id, k.id, k2.id], "끝났어도 안 치운 행은 본다 · id 순");
  await as(A, () => S.markLoginJobReaped(j.id));
  const live = await as(A, () => S.createLoginJob({ memberId: "m-3", harness: "grok", purpose: "login", secretHash: S.newJobSecret().hash, adminBasis: "none" }));
  await as(A, () => S.markLoginJobReaped(live.id));
  const open2 = (await as(A, () => S.openLoginJobs())).map((r) => r.id);
  assert.deepEqual(open2, [k.id, k2.id, live.id], "치운 끝난 행은 빠지고, 살아 있는 행은 치움 표시와 무관하게 본다");
  assert.deepEqual((await as(A, () => S.openLoginJobs(1))).map((r) => r.id), [k.id], "상한");
  ok("S10 정리 감시 대상 — 살아 있거나 안 치운 것");

  // S11 지우기는 돌지 않은 행만
  const gone = await as(A, () => S.createLoginJob({ memberId: "m-4", harness: "grok", purpose: "login", secretHash: S.newJobSecret().hash, adminBasis: "none" }));
  await as(A, () => S.deleteLoginJob(gone.id));
  assert.equal(await as(A, () => S.getLoginJob(gone.id)), null);
  const kept = await as(A, () => S.createLoginJob({ memberId: "m-4", harness: "grok", purpose: "login", secretHash: S.newJobSecret().hash, adminBasis: "none" }));
  await as(A, () => S.markLoginJobRunning(kept.id, "lvly-task-a-9-l1"));
  await as(A, () => S.deleteLoginJob(kept.id));
  assert.notEqual(await as(A, () => S.getLoginJob(kept.id)), null, "돈 행은 안 지운다");
  await as(A, () => S.deleteLoginJob(k.id));
  assert.notEqual(await as(A, () => S.getLoginJob(k.id)), null, "끝난 행도 안 지운다");
  ok("S11 지우기 — starting 행만");

  // S12 CHECK
  for (const bad of [
    { purpose: "admin", adminBasis: "none" },
    { purpose: "login", adminBasis: "root" },
  ]) {
    await assert.rejects(() => as(A, () => S.createLoginJob({ memberId: "m-5", harness: "codex", secretHash: "h", ...bad })), /check constraint/i, JSON.stringify(bad));
  }
  await assert.rejects(() => as(A, () => S.finishLoginJob(live.id, "weird", {})), /check constraint/i);
  assert.equal((await as(A, () => S.getLoginJob(live.id))).status, "starting");
  ok("S12 CHECK — 모르는 용도·근거·상태를 막는다");

  // S13 화면 박동 · 없는 id
  const before = (await as(A, () => S.getLoginJob(live.id))).ui_seen_at.getTime();
  await new Promise((r) => setTimeout(r, 20));
  await as(A, () => S.touchLoginJobUi(live.id));
  assert.ok((await as(A, () => S.getLoginJob(live.id))).ui_seen_at.getTime() > before);
  for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 60]) assert.equal(await as(A, () => S.getLoginJob(bad)), null, String(bad));
  assert.equal(await as(A, () => S.getLoginJob(999999)), null);
  ok("S13 화면 박동 · 형식 밖 id 는 조회 없이 null");

  // S14 B 는 제 작업을 따로 갖는다(같은 사람 id 여도)
  const jb = await as(B, () => S.createLoginJob({ memberId: "m-1", harness: "claude", purpose: "headless", secretHash: S.newJobSecret().hash, adminBasis: "token" }));
  assert.equal((await as(B, () => S.latestLoginJob("m-1", "headless", "claude"))).id, jb.id);
  assert.equal((await as(A, () => S.latestLoginJob("m-1", "headless", "claude"))).id, j.id, "A 의 최근 작업은 여전히 A 의 것");
  assert.equal(await as(A, () => S.getLoginJob(jb.id)), null);
  const tenants = await owner.query("SELECT tenant_id::text AS t, count(*)::int AS n FROM org_login_job GROUP BY 1 ORDER BY 1");
  assert.deepEqual(tenants.rows, [{ t: A, n: 5 }, { t: B, n: 1 }], "A: j·k·k2·live·kept (gone 은 지웠다)");
  ok("★ S14 두 워크스페이스 — 같은 멤버 id 라도 행이 갈린다(소유자 시야 A=5 · B=1)");

  await owner.end();
  await client.itemsPool.end();
  console.log(`\n${pass} passed`);
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  try { sh(`docker rm -f -v ${CNAME}`); } catch { /* */ }
}
process.exit(exitCode);
