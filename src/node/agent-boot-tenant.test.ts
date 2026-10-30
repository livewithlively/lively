// 세션 호스트가 **어느 테넌트를 소유하나** — 부팅 계약 (#2600 T2).
//
//  매니지드 세션 호스트는 노드 박스(브로커 옆)에서 도는 노드 에이전트다. 그 자리에서 tmux 는 «중계 너머»
//   이고(`LIVELY_TMUX_EXEC="… {slug}"`), 코어는 `{slug}` 치환으로 그 테넌트의 브로커 소켓을 고른다.
//   슬러그는 요청이 아니라 **프로세스**에 붙는다 — 이 프로세스는 테넌트 하나만 본다.
//
//  ★ 여기서 지키는 것은 «부팅에서 선다» 다. 슬러그가 없으면 프로세스는 **첫 attach 가 올 때까지 멀쩡해
//   보이다가** 거기서 던진다(`tmuxArgvFor` 의 «컨텍스트가 필요합니다»). 그 실패는 사람에게 «터미널이 안
//   붙는다» 로만 보이고, 원인은 배선 누락이다. 부팅에서 서면 배포가 그 자리에서 실패한다.
//
//  ⚠ 순수 술어(아래 P행)만으로는 이 계약이 안 지켜진다 — 술어가 맞아도 **진입점이 그걸 안 부르면** 그만이다.
//   그래서 B행은 **번들을 실제로 띄워** 종료코드를 본다.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { tmuxNeedsTenantSlug } from "../exec-topology.js";
import { TMUX_PIN, tmuxPinBin } from "../terminal/mux-pin.js";

// ── 순수 술어 ────────────────────────────────────────────────────────────────
test("P1 tmux 가 이 호스트의 소켓이면 테넌트 컨텍스트가 필요 없다(멤버 PC — 종전 무회귀)", () => {
  assert.equal(tmuxNeedsTenantSlug({ kind: "socket", socket: null }), false);
  assert.equal(tmuxNeedsTenantSlug({ kind: "socket", socket: "lvly-{slug}" }), false,
    "소켓 템플릿의 {slug} 는 **요청 컨텍스트**가 채운다 — 프로세스에 고정할 값이 아니다");
});

test("P2 치환자 없는 중계는 테넌트 컨텍스트가 필요 없다", () => {
  assert.equal(tmuxNeedsTenantSlug({ kind: "exec", command: "node /opt/relay.cjs" }), false);
});

test("P3 ★ 치환자 있는 중계는 테넌트 컨텍스트를 요구한다 — 매니지드 세션 호스트가 이것이다", () => {
  assert.equal(tmuxNeedsTenantSlug({ kind: "exec", command: "node /opt/relay.cjs {slug}" }), true);
});

// ── 진입점 부팅 ──────────────────────────────────────────────────────────────
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUNDLE = path.join(REPO, "dist", "node-agent", "agent.mjs");
const DEAD_GW = "http://127.0.0.1:9";   // discard 포트 — 붙지 않는다(부팅을 지난 뒤 재연결만 돈다)

//  ⚠ 번들은 **임시 HOME · 임시 tmux 소켓 폴더**에서 띄운다(#4931 2단계). 노드의 기본값이 tmux 세대(auto)라, 진짜 HOME 으로 띄우면
//   부팅이 고정판을 GitHub 에서 받아 그 HOME 에 깔고(시험이 바깥에 쓴다) 진짜 소켓 폴더의 빈 전용 서버를 정리하려 든다.
//   고정판 자리에는 `-V` 에만 그 판을 답하고 나머지엔 «서버 없음» 을 답하는 가짜를 미리 둔다 — 부팅은 기본값 그대로(고정판 세대)
//   지나가되 내려받기도 진짜 서버도 없다.
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), "agent-boot-"));
const SANDBOX_HOME = path.join(SANDBOX, "home");
const SANDBOX_SOCK = path.join(SANDBOX, "sock");
const FAKE_PINNED = tmuxPinBin(SANDBOX_HOME);
mkdirSync(path.dirname(FAKE_PINNED), { recursive: true });
mkdirSync(SANDBOX_SOCK);
writeFileSync(FAKE_PINNED, `#!/bin/sh
[ "$1" = "-V" ] && { echo "tmux ${TMUX_PIN.version}"; exit 0; }
echo "no server running on ${SANDBOX_SOCK}/fake" >&2
exit 1
`, { mode: 0o755 });
after(() => rmSync(SANDBOX, { recursive: true, force: true }));

/** 번들을 띄우고 **일찍 죽었나**를 본다. null = 살아남았다(부팅을 지났다). */
function bootExit(env: Record<string, string>): Promise<{ code: number | null; err: string; out: string }> {
  const c = spawn(process.execPath, [BUNDLE], {
    env: {
      PATH: process.env.PATH ?? "", HOME: SANDBOX_HOME, TMUX_TMPDIR: SANDBOX_SOCK,
      LIVELY_GATEWAY_URL: DEAD_GW, LIVELY_NODE_TOKEN: "lvk_test",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const err: Buffer[] = [];
  const out: Buffer[] = [];
  c.stderr.on("data", (d) => err.push(d));
  c.stdout.on("data", (d) => out.push(d));
  return new Promise((resolve) => {
    let done = false;
    const finish = (code: number | null) => {
      if (done) return; done = true;
      try { c.kill("SIGKILL"); } catch { /* 이미 죽음 */ }
      resolve({ code, err: Buffer.concat(err).toString(), out: Buffer.concat(out).toString() });
    };
    c.on("exit", (code) => finish(code));
    //  살아남았다 = 부팅을 지났다. 재연결 루프만 도는 상태라 더 기다릴 것이 없다.
    setTimeout(() => finish(null), 3000);
  });
}

test("B2 ★ 중계 tmux 인데 LVLY_TENANT_SLUG 가 없으면 **부팅에서 선다**(exit 2)", { skip: !existsSync(BUNDLE) && "노드 번들 미빌드" }, async () => {
  const r = await bootExit({ LIVELY_TMUX_EXEC: "node /opt/lively/libexec/tmux-relay.cjs {slug}" });
  assert.equal(r.code, 2, `살아남으면 안 된다 — stderr=${r.err.slice(0, 300)}`);
  assert.match(r.err, /LVLY_TENANT_SLUG/, "사람이 무엇을 안 실었는지 알 수 있어야 한다");
});

test("B3 ★ 슬러그가 있으면 부팅을 지난다", { skip: !existsSync(BUNDLE) && "노드 번들 미빌드" }, async () => {
  const r = await bootExit({
    LIVELY_TMUX_EXEC: "node /opt/lively/libexec/tmux-relay.cjs {slug}",
    LVLY_TENANT_SLUG: "acme-1234",
  });
  assert.equal(r.code, null, `부팅에서 서면 안 된다(code=${r.code}) — stderr=${r.err.slice(0, 300)}`);
});

test("B5 ★ 슬러그가 **형식 밖**이면 부팅에서 선다 — 실어 줬는데 접히면 첫 attach 까지 안 보인다", { skip: !existsSync(BUNDLE) && "노드 번들 미빌드" }, async () => {
  //  `tenantSlug()` 는 형식 밖 값을 null 로 접는다. 그러면 "LVLY_TENANT_SLUG 를 넣었는데도
  //   «컨텍스트가 필요합니다»" 라는, 부팅 가드가 없애려던 바로 그 증상이 남는다.
  //   공백이 든 값은 특히 나쁘다 — 치환 뒤 `split(/\s+/)` 가 중계 argv 의 **개수**를 바꾼다.
  for (const bad of ["Acme-1234", "a b", "-lead", "acme_1234"]) {
    const r = await bootExit({
      LIVELY_TMUX_EXEC: "node /opt/lively/libexec/tmux-relay.cjs {slug}",
      LVLY_TENANT_SLUG: bad,
    });
    assert.equal(r.code, 2, `${JSON.stringify(bad)} 는 서야 한다 — stderr=${r.err.slice(0, 200)}`);
    assert.match(r.err, /LVLY_TENANT_SLUG/);
  }
});

test("B1 ★ 멤버 PC(로컬 tmux)는 슬러그 없이도 부팅한다 — 무회귀(기본값 tmux 세대로)", { skip: !existsSync(BUNDLE) && "노드 번들 미빌드" }, async () => {
  const r = await bootExit({});
  assert.equal(r.code, null, `멤버 노드가 서면 안 된다(code=${r.code}) — stderr=${r.err.slice(0, 300)}`);
  if (process.platform !== "win32") {
    //  배선 — 기본값(auto)으로 미리 깔린 고정판 세대를 탔고(가짜가 그 바이너리다), 내려받기 자국이 HOME 에 없다.
    assert.ok(r.out.includes(JSON.stringify(FAKE_PINNED)), `고정판 세대로 부팅했다 — stdout=${r.out.slice(0, 600)}`);
    assert.deepEqual(readdirSync(path.dirname(path.dirname(FAKE_PINNED))), [path.basename(path.dirname(FAKE_PINNED))], "임시 HOME 의 bin 엔 가짜 고정판 폴더 하나뿐");
  }
});

test("B4 ★ 치환자 없는 중계는 슬러그 없이도 부팅한다 — 요구를 필요 이상으로 넓히지 않는다", { skip: !existsSync(BUNDLE) && "노드 번들 미빌드" }, async () => {
  const r = await bootExit({ LIVELY_TMUX_EXEC: "node /opt/lively/libexec/tmux-relay.cjs fixed-tenant" });
  assert.equal(r.code, null, `서면 안 된다(code=${r.code}) — stderr=${r.err.slice(0, 300)}`);
});
