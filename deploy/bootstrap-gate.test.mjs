// 설치 게이트(#2578) — wait_ready(스키마 준비 대기) · bootstrap_step/summary(실패를 삼키지 않음) · 배선 회귀 가드.
//
//  왜 이 테스트인가: 2026-09-03 EC2 실측 — install.sh 가 healthz(listen) 만 보고 6/7 로 가서 부트스트랩 셋이 전부
//  `column "tenant_id" does not exist` 로 죽었는데, 경고만 내고 '완료'로 끝나며 요약에 에러 텍스트를 ✓ 로 찍었다.
//  여기서는 가짜 /readyz(node http) 앞에서 실제 bash 함수를 돌려 (1) pending/restarting/connection-refused 를 견디고
//  ready 에서 통과 (2) failed 는 즉시 die (3) 실패 단계가 ✗ 로 요약되고 비-0 이 되는 것을 락한다.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const COMMON = path.join(here, "lib", "common.sh");
const INSTALL = readFileSync(path.join(here, "install.sh"), "utf8");
const UPDATE = readFileSync(path.join(here, "update.sh"), "utf8");
const COMMON_SRC = readFileSync(COMMON, "utf8");

// 가짜 /readyz — 대본(script)을 순서대로 낸다. 대본이 끝나면 마지막 것을 반복.
async function fakeReadyz(script, port = 0) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    const next = script.length > 1 ? script.shift() : script[0];
    res.writeHead(next.status, { "content-type": "application/json" });
    res.end(JSON.stringify(next.body));
  });
  // ⚠ 호스트를 지정하지 않는다(dual-stack) — wait_ready 는 wait_healthz 와 같이 `localhost` 로 붙는데, 이 이름이 ::1 로
  //  먼저 풀리는 기계에서 127.0.0.1 전용 서버는 «연결 거부»가 아니라 --max-time 까지 매달렸다(맥 실측 5초×20회 = 2분).
  await new Promise((r, j) => { server.once("error", j); server.listen(port, r); });
  return { port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}

// install.sh·update.sh 와 같은 셸 옵션으로 돈다. ⚠ 종전 harness 는 set -e 없이 돌아 «grep 무매치 → 대입문 errexit» 로
//  wait_ready 가 재기동 창에서 조용히 죽는 결함을 못 잡았다(EC2 실측: '준비 대기' 한 줄 뒤 INSTALL_EXIT=1).
const SHELL_OPTS = "set -euo pipefail";
// ⚠ 가짜 서버가 **이 프로세스**에 산다 — 서버를 상대하는 호출은 bashAsync 로. spawnSync 는 이벤트루프를 막아
//  서버가 응답을 못 하고 curl 이 --max-time 까지 매달린다(실측: 5초×20회 = 2분 뒤 실패 — 환경 문제로 오인하기 쉽다).
function bashSync(snippet, env = {}) {
  const r = spawnSync("bash", ["-c", `${SHELL_OPTS}; source ${JSON.stringify(COMMON)}; ${snippet}`], {
    encoding: "utf8", env: { ...process.env, ...env },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
function bashAsync(snippet, env = {}) {
  return new Promise((resolve) => {
    const p = spawn("bash", ["-c", `${SHELL_OPTS}; source ${JSON.stringify(COMMON)}; ${snippet}`], { env: { ...process.env, ...env } });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (status) => resolve({ status, out, err }));
  });
}
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

const pending = { status: 503, body: { ok: false, status: "starting", schema: "pending" } };
const restarting = { status: 503, body: { ok: false, status: "starting", schema: "restarting" } };
const ready = { status: 200, body: { ok: true, status: "ok", schema: "ready" } };
const failed = { status: 503, body: { ok: false, status: "down", schema: "failed" } };

// ── T1: pending → restarting → ready 순으로 기다렸다 통과한다 ──
{
  const f = await fakeReadyz([pending, restarting, ready]);
  const r = await bashAsync("wait_ready 20", { PORT: String(f.port) });
  await f.close();
  assert.equal(r.status, 0, r.err);
  assert.match(r.err, /schema=ready/);
  assert.equal(f.seen.length, 3, "세 번 물어봤어야 한다(pending·restarting 은 통과가 아니다)");
}

// ── T2: failed 는 즉시 die(타임아웃까지 안 기다린다) + 로그 안내 ──
{
  const f = await fakeReadyz([pending, failed]);
  const t0 = Date.now();
  const r = await bashAsync("wait_ready 60", { PORT: String(f.port), APP_DIR: "/tmp/app" });
  await f.close();
  assert.equal(r.status, 1);
  assert.match(r.err, /schema=failed/);
  assert.match(r.err, /schema init failed/, "운영자가 gateway.log 에서 grep 할 문구를 알려준다");
  assert.ok(Date.now() - t0 < 10_000, "failed 를 보고 곧바로 멈춰야 한다");
}

// ── T3: skipped(체인을 안 도는 프로세스)는 통과 — 기다릴 것이 없다 ──
{
  const f = await fakeReadyz([{ status: 200, body: { ok: true, status: "ok", schema: "skipped" } }]);
  const r = await bashAsync("wait_ready 5", { PORT: String(f.port) });
  await f.close();
  assert.equal(r.status, 0, r.err);
  assert.match(r.err, /schema=skipped/);
}

// ── T4: schema 필드가 없는 200(구버전 게이트웨이) 은 통과가 아니다 — 타임아웃 후 die 하며 이유를 말한다 ──
{
  const f = await fakeReadyz([{ status: 200, body: { ok: true, status: "ok" } }]);
  const r = await bashAsync("wait_ready 2", { PORT: String(f.port) });
  await f.close();
  assert.equal(r.status, 1);
  assert.match(r.err, /schema='none'/);
  assert.ok(f.seen.length >= 2);
}

// ── T5: 재기동 창(connection refused)을 견딘다 — 서버가 늦게 떠도 ready 에서 통과 ──
{
  const port = await freePort();
  const t0 = Date.now();
  const pr = bashAsync("wait_ready 20", { PORT: String(port) });
  await new Promise((r) => setTimeout(r, 1500));
  const f = await fakeReadyz([ready], port);
  const r = await pr;
  await f.close();
  assert.equal(r.status, 0, r.err);
  assert.ok(Date.now() - t0 >= 1500, "서버가 없는 동안 기다렸어야 한다");
  assert.match(r.err, /schema=ready/);
}

// ── T6: bootstrap_step — stdout 만 캡처·stderr 는 흘리고, 실패는 기록돼 summary 가 ✗ + 1 을 낸다 ──
{
  const r = bashSync(`
    bootstrap_step "관리자 시드" "hint-a" sh -c 'echo "{\\"ok\\":true}"; echo ERR-A >&2'; echo "rc=$? last=$BOOTSTRAP_LAST_OUT"
    bootstrap_step "baseline 시드" "node --env-file=.env deploy/bootstrap-baseline.mjs" sh -c 'echo ERR-B >&2; exit 1' || echo "rc=$?"
    echo "last-after-fail=[$BOOTSTRAP_LAST_OUT]"
    if bootstrap_summary; then echo "sum=0"; else echo "sum=$?"; fi
  `);
  assert.equal(r.status, 0);
  assert.match(r.out, /rc=0 last=\{"ok":true\}/, "성공 단계의 stdout(JSON) 이 BOOTSTRAP_LAST_OUT 에 남는다");
  assert.match(r.out, /rc=1/);
  assert.match(r.out, /last-after-fail=\[\]/, "실패 단계는 LAST_OUT 을 비운다(에러 텍스트가 결과로 둔갑하지 않게)");
  assert.match(r.out, /sum=1/, "실패가 있으면 summary 는 1");
  assert.match(r.err, /✓.*관리자 시드 완료/);
  assert.match(r.err, /ERR-A/, "stderr 는 그대로 흘러 install.log 에 남는다");
  assert.match(r.err, /⚠.*baseline 시드 실패/);
  assert.match(r.err, /✗.*baseline 시드 — 재시도: node --env-file=\.env deploy\/bootstrap-baseline\.mjs/);
  assert.ok(!/✗.*관리자 시드/.test(r.err), "성공한 단계는 ✗ 에 없다");
}
{
  const r = bashSync(`bootstrap_step "A" "h" true; if bootstrap_summary; then echo "sum=0"; else echo "sum=$?"; fi`);
  assert.match(r.out, /sum=0/, "실패가 없으면 0");
  assert.ok(!r.err.includes("✗"));
}

// ── 배선 회귀 가드 ──
{
  // install.sh: healthz → ready → (프록시) → 6/7 부트스트랩 순. ready 를 빼면 2026-09-03 결함이 그대로 돌아온다.
  const h = INSTALL.indexOf("  wait_healthz\n");
  const rdy = INSTALL.indexOf("  wait_ready\n");
  const boot = INSTALL.indexOf('phase "6/7');
  assert.ok(h > 0 && rdy > h && boot > rdy, `install.sh 순서: wait_healthz(${h}) < wait_ready(${rdy}) < 6/7(${boot})`);
  for (const f of ["bootstrap-admin.mjs", "bootstrap-baseline.mjs", "bootstrap-connectors.mjs"]) {
    assert.ok(new RegExp(`bootstrap_step [^\\n]*${f.replace(".", "\\.")}`).test(INSTALL), `${f} 는 bootstrap_step 으로 돌아야 한다(warn 삼킴 금지)`);
    assert.ok(!new RegExp(`warn [^\\n]*${f.replace(".", "\\.")}[^\\n]*경고`).test(INSTALL), `${f} 실패를 warn 으로 삼키면 안 된다`);
  }
  assert.match(INSTALL, /if ! bootstrap_summary; then\n\s+die /, "부트스트랩 실패면 ✗ 요약 뒤 비-0 으로 끝나야 한다");
  assert.ok(!/\[ -n "\$admin_out" \] && ok "첫 관리자/.test(INSTALL), "실패 텍스트가 ✓ 첫 관리자 로 찍히던 자리");
  assert.match(INSTALL, /admin_out="\$BOOTSTRAP_LAST_OUT"/, "요약의 관리자 JSON 은 성공한 stdout 에서만 온다");
  // update.sh 도 같은 게이트를 쓴다.
  const uh = UPDATE.indexOf("\nwait_healthz\n");
  const ur = UPDATE.indexOf("\nwait_ready");
  const useed = UPDATE.indexOf("bootstrap-connectors.mjs");
  assert.ok(uh > 0 && ur > uh && useed > ur, `update.sh 순서: wait_healthz(${uh}) < wait_ready(${ur}) < 커넥터 시드(${useed})`);
  // 부트스트랩 env 가 sudo 경계(run_as_service)에서 떨어지지 않는다 — 종전엔 BOOTSTRAP_ADMIN_PASSWORD 가 빠져 있었다.
  const ras = COMMON_SRC.slice(COMMON_SRC.indexOf("run_as_service() {"), COMMON_SRC.indexOf("render_service_unit() {"));
  for (const v of ["BOOTSTRAP_ADMIN_EMAIL", "BOOTSTRAP_ADMIN_PASSWORD", "BOOTSTRAP_ADMIN_ID", "BOOTSTRAP_RETRY_MAX_MS", "SKIP_BASELINE", "SKIP_CONNECTORS"]) {
    assert.ok(ras.includes(`${v}="\${${v}:-}"`), `run_as_service 화이트리스트에 ${v} 가 없다`);
  }
  // 세 부트스트랩 스크립트는 재시도 헬퍼를 쓰고 실패 시 exit 1 이다.
  for (const f of ["bootstrap-admin.mjs", "bootstrap-baseline.mjs", "bootstrap-connectors.mjs"]) {
    const src = readFileSync(path.join(here, f), "utf8");
    assert.match(src, /withBootstrapRetry\(/, `${f}: 재시도 없음`);
    assert.match(src, /exitOnBootstrapFailure\(/, `${f}: 실패 exit 1 없음`);
  }
}
console.log("bootstrap-gate ok");
