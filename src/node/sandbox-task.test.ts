// 맥락 잡 샌드박스 실행기 — 코어 쪽 (#4012 T3 L1). 사양 spec-sandbox-core 의 R·A·C·S·M·J·O·P·K 행.
//
//  왜 이렇게 재나: 이 모듈은 root op 에 **무엇을 넘기고**(자격·파일·env) 판이 **어떻게 끝났다고 믿는지**(종료 줄·상태)가
//   전부다. 둘 다 틀리면 조용하다 — 자격이 새거나, 멀쩡한 판을 실패로 닫거나, 죽은 판을 영원히 기다린다.
//  ★ 판 스크립트는 문자열 비교로 끝내지 않고 **실제 sh 로 돌린다**(가짜 curl·가짜 하네스) — 69·70·fd3 반환은 실행해야 보인다.
//  ★ op 는 가짜 유닉스 소켓 서버로 흉내 낸다 — 무엇이 어떤 순서로 도착했는지를 서버 쪽에서 기록한다.
import { strict as assert } from "node:assert";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  schedulingRoute, sandboxAvailable, sandboxCoordsOfDir, sandboxRunScript, sandboxMcpConfig, judgeSandboxTask,
  callTaskOp, spawnSandboxTask, checkSandboxTask, SandboxBusyError, SANDBOX_EXIT_GATEWAY, SANDBOX_EXIT_NOCRED,
  type SandboxSpawnDeps, type TaskOpReply,
} from "./sandbox-task.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-core-"));
const GW = "https://acme.app.lvly.io";

// ── R: 경로 ─────────────────────────────────────────────────────────────────
assert.deepEqual(schedulingRoute(false, true), { central: "tmux", remotes: true }, "R1 op 없음 · 맥락");
assert.deepEqual(schedulingRoute(false, false), { central: "tmux", remotes: true }, "R1 op 없음 · 그 밖");
assert.deepEqual(schedulingRoute(true, true), { central: "sandbox", remotes: false }, "R2 매니지드 맥락 잡은 중앙 샌드박스만");
assert.deepEqual(schedulingRoute(true, false), { central: null, remotes: true }, "R3 매니지드 그 밖 위탁은 중앙이 후보 아님");

// ── A: 기능 탐지 ────────────────────────────────────────────────────────────
{
  const sockPath = path.join(TMP, "probe.sock");
  const srv = net.createServer(() => { /* 연결 안 받음 */ });
  await new Promise<void>((r) => srv.listen(sockPath, r));
  const plain = path.join(TMP, "plain.txt");
  fs.writeFileSync(plain, "x");
  const saved = { sock: process.env.LIVELY_TASK_OP_SOCK, sw: process.env.LIVELY_TASK_SANDBOX };
  process.env.LIVELY_TASK_OP_SOCK = sockPath; delete process.env.LIVELY_TASK_SANDBOX;
  assert.equal(sandboxAvailable(), true, "A1 소켓 있음");
  for (const v of ["off", " OFF ", "Off"]) {
    process.env.LIVELY_TASK_SANDBOX = v;
    assert.equal(sandboxAvailable(), false, `A3 되돌림 스위치(${JSON.stringify(v)})`);
  }
  delete process.env.LIVELY_TASK_SANDBOX;
  process.env.LIVELY_TASK_OP_SOCK = plain;
  assert.equal(sandboxAvailable(), false, "A2 일반 파일은 소켓이 아니다");
  process.env.LIVELY_TASK_OP_SOCK = path.join(TMP, "nope.sock");
  assert.equal(sandboxAvailable(), false, "A2 없음");
  process.env.LIVELY_TASK_OP_SOCK = saved.sock ?? "";
  if (saved.sock === undefined) delete process.env.LIVELY_TASK_OP_SOCK;
  if (saved.sw !== undefined) process.env.LIVELY_TASK_SANDBOX = saved.sw;
  await new Promise<void>((r) => srv.close(() => r()));
}

// ── C: 좌표 ─────────────────────────────────────────────────────────────────
{
  const root = "/var/lib/lvly/tasks";
  assert.deepEqual(sandboxCoordsOfDir(`${root}/acme/12-a1/out`, root),
    { slug: "acme", taskId: 12, attempt: 1, unit: "lvly-task-acme-12-a1", base: `${root}/acme/12-a1` }, "C1");
  assert.equal(sandboxCoordsOfDir(`${root}/lively-46e3/1234567890123456-a9999/out`, root)?.unit, "lvly-task-lively-46e3-1234567890123456-a9999", "C1 경계");
  for (const bad of [
    "/work/shared/delegated/task-12/.lively-task/12", `${root}/acme/12-a1`, `${root}x/acme/12-a1/out`, `${root}/../acme/12-a1/out`,
    `${root}/Acme/12-a1/out`, `${root}/acme/12-a0/out`, `${root}/acme/0-a1/out`, `${root}/acme/12345678901234567-a1/out`,
    `${root}/acme/12-a1/out/x`, `${root}/a/b/12-a1/out`, "", null, undefined,
  ]) {
    assert.equal(sandboxCoordsOfDir(bad as string, root), null, `C2 ${String(bad)}`);
  }
  const saved = process.env.LIVELY_TASK_DATA_ROOT;
  process.env.LIVELY_TASK_DATA_ROOT = "/srv/t/";
  assert.equal(sandboxCoordsOfDir("/srv/t/acme/3-a2/out")?.unit, "lvly-task-acme-3-a2", "C3 env 뿌리의 끝 슬래시");
  assert.equal(sandboxCoordsOfDir(`${root}/acme/3-a2/out`), null, "C3 env 뿌리를 따른다");
  if (saved === undefined) delete process.env.LIVELY_TASK_DATA_ROOT; else process.env.LIVELY_TASK_DATA_ROOT = saved;
}

// ── S: 판 스크립트(문자열) ──────────────────────────────────────────────────
{
  const claude = sandboxRunScript({ harness: "claude", flags: ["--model", "sonnet"], systemPrompt: false, bypassPermissions: true, gatewayUrl: GW });
  const gwAt = claude.indexOf("/healthz");
  const runAt = claude.indexOf('"$LVLY_HARNESS_BIN"');
  assert.ok(gwAt > 0 && runAt > gwAt, "S1 게이트웨이 확인이 하네스보다 먼저");
  assert.ok(claude.includes(`exit ${SANDBOX_EXIT_GATEWAY}`), "S1 69");
  assert.ok(claude.includes('CLAUDE_CODE_OAUTH_TOKEN=$(cat "$CREDENTIALS_DIRECTORY/anthropic"'), "S2 자격은 파일에서");
  assert.ok(claude.includes(`exit ${SANDBOX_EXIT_NOCRED}`), "S2 70");
  assert.ok(claude.includes("--mcp-config /task/in/mcp.json --strict-mcp-config"), "S3 MCP 설정");
  assert.ok(claude.includes('< "/task/in/prompt.txt"'), "S3 프롬프트는 stdin");
  assert.ok(claude.includes("--dangerously-skip-permissions"), "S3 무인 배치는 승인 우회");
  assert.ok(claude.includes("--model sonnet"), "S3 화이트리스트 플래그");
  assert.ok(!claude.includes("--append-system-prompt-file"), "S4 시스템 프롬프트 없으면 없음");
  const noBypass = sandboxRunScript({ harness: "claude", flags: [], systemPrompt: true, bypassPermissions: false, gatewayUrl: GW });
  assert.ok(!noBypass.includes("--dangerously-skip-permissions"), "S3 우회 끔");
  assert.ok(noBypass.includes("--append-system-prompt-file /task/in/system.md"), "S4");
  const codex = sandboxRunScript({ harness: "codex", flags: ["--config", "model_reasoning_effort=high"], systemPrompt: false, bypassPermissions: true, gatewayUrl: GW });
  assert.ok(codex.includes('install -m 600 "$CREDENTIALS_DIRECTORY/codex-auth" "$CODEX_HOME/auth.json"'), "S5 auth.json 0600");
  for (const piece of [
    `mcp_servers.lively.url="${GW}/mcp"`, 'mcp_servers.lively.bearer_token_env_var="LIVELY_MCP_TOKEN"',
    'mcp_servers.lively.env_http_headers={"x-lively-session"="LIVELY_SESSION_ID"}', '"x-lively-harness"="codex"',
    "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "exec --json",
  ]) assert.ok(codex.includes(piece), `S5 ${piece}`);
  assert.ok(codex.includes('exit "$rc"'), "S5 종료코드 보존");
  assert.throws(() => sandboxRunScript({ harness: "grok", flags: [], systemPrompt: false, bypassPermissions: true, gatewayUrl: GW }), /하네스/, "S7 목록 밖 하네스");
  for (const bad of ["https://x/mcp", "https://x; rm", "ftp://x", ""]) {
    assert.throws(() => sandboxRunScript({ harness: "claude", flags: [], systemPrompt: false, bypassPermissions: true, gatewayUrl: bad }), /주소/, `S7 ${bad}`);
  }
  assert.ok(!/lvk_|sk-ant|Bearer [A-Za-z0-9]/.test(claude + codex), "S8 스크립트에 토큰 값이 없다");
}

// ── S6: 판 스크립트를 실제 sh 로 ────────────────────────────────────────────
interface Run { rc: number; argv: string; stdin: string; fd3: string; stderr: string; ran: boolean; env: string }
function runScript(o: { harness: "claude" | "codex"; curlRc?: number; creds?: Record<string, string>; harnessRc?: number; rotate?: boolean }): Run {
  const root = fs.mkdtempSync(path.join(TMP, "run-"));
  const bin = path.join(root, "bin");
  const credDir = path.join(root, "cred");
  fs.mkdirSync(bin); fs.mkdirSync(credDir);
  fs.mkdirSync(path.join(root, "task", "in"), { recursive: true });
  fs.mkdirSync(path.join(root, "task", "work"), { recursive: true });
  fs.writeFileSync(path.join(root, "task", "in", "prompt.txt"), "PROMPT-BODY");
  for (const [k, v] of Object.entries(o.creds ?? {})) fs.writeFileSync(path.join(credDir, k), v);
  fs.writeFileSync(path.join(bin, "curl"), `#!/bin/sh\necho "$*" >> "${root}/curl.log"\nexit ${o.curlRc ?? 0}\n`, { mode: 0o755 });
  //  가짜 하네스 — 무엇으로 불렸나(argv)·무엇을 받았나(stdin)·env 를 남긴다. rotate 면 codex 처럼 auth.json 을 다시 쓴다.
  const harness = path.join(bin, "harness");
  fs.writeFileSync(harness, [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > "${root}/argv"`,
    `cat > "${root}/stdin"`,
    `echo "TOKEN=\${CLAUDE_CODE_OAUTH_TOKEN:-}|MCP=\${LIVELY_MCP_TOKEN:-}|CFG=\${CLAUDE_CONFIG_DIR:-}" > "${root}/env"`,
    o.rotate ? 'printf "%s" "rotated-auth" > "$CODEX_HOME/auth.json"' : ":",
    `exit ${o.harnessRc ?? 0}`,
  ].join("\n") + "\n", { mode: 0o755 });
  const script = sandboxRunScript({ harness: o.harness, flags: [], systemPrompt: false, bypassPermissions: true, gatewayUrl: GW })
    .split("/task/").join(`${root}/task/`);
  fs.writeFileSync(path.join(root, "run.sh"), script);
  const fd3Path = path.join(root, "fd3");
  const fd3 = fs.openSync(fd3Path, "w");
  const r = spawnSync("/bin/sh", [path.join(root, "run.sh")], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`, HOME: path.join(root, "task", "work", "home"), CREDENTIALS_DIRECTORY: credDir,
      LVLY_HARNESS_BIN: harness, LIVELY_GATEWAY_URL: GW, LIVELY_SESSION_ID: "box-x-0000abcd",
    },
    stdio: ["ignore", "pipe", "pipe", fd3],
    encoding: "utf8",
  });
  fs.closeSync(fd3);
  const read = (f: string): string => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), "utf8") : "");
  return { rc: r.status ?? -1, argv: read("argv"), stdin: read("stdin"), fd3: read("fd3"), stderr: r.stderr ?? "", ran: fs.existsSync(path.join(root, "argv")), env: read("env") };
}

{
  const down = runScript({ harness: "claude", curlRc: 22, creds: { lively: "L", anthropic: "A" } });
  assert.equal(down.rc, SANDBOX_EXIT_GATEWAY, `S1 게이트웨이 실패 → 69 (${down.stderr})`);
  assert.equal(down.ran, false, "S1 하네스는 안 불린다");
  assert.match(down.stderr, /게이트웨이/, "S1 사유가 stderr 에");

  const noLively = runScript({ harness: "claude", creds: { anthropic: "A" } });
  assert.equal(noLively.rc, SANDBOX_EXIT_NOCRED, "S2 lively 자격 없음 → 70");
  assert.equal(noLively.ran, false, "S2 하네스 안 불림");
  const noAnth = runScript({ harness: "claude", creds: { lively: "L" } });
  assert.equal(noAnth.rc, SANDBOX_EXIT_NOCRED, "S2 claude 자격 없음 → 70");
  assert.equal(noAnth.ran, false);

  const ok = runScript({ harness: "claude", creds: { lively: "lvk_live", anthropic: "sk-ant-x" }, harnessRc: 0 });
  assert.equal(ok.rc, 0, `S3 정상 ${ok.stderr}`);
  assert.equal(ok.stdin, "PROMPT-BODY", "S3 프롬프트가 stdin 으로");
  const argv = ok.argv.trim().split("\n");
  assert.equal(argv[0], "-p", "S3 헤드리스");
  for (const a of ["--mcp-config", "--strict-mcp-config", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"]) {
    assert.ok(argv.includes(a), `S3 ${a}`);
  }
  //  배선: 자격이 파일에서 하네스 env 로 실제로 실렸다(export 가 빠지면 하네스는 미로그인으로 돈다).
  assert.match(ok.env, /TOKEN=sk-ant-x\|MCP=lvk_live\|CFG=.*\/\.claude/, `S2 자격이 하네스 env 로: ${ok.env}`);
  const failing = runScript({ harness: "claude", creds: { lively: "L", anthropic: "A" }, harnessRc: 3 });
  assert.equal(failing.rc, 3, "S3 하네스 종료코드가 그대로");

  const codexSame = runScript({ harness: "codex", creds: { lively: "L", "codex-auth": "orig-auth" } });
  assert.equal(codexSame.rc, 0, `S5 codex ${codexSame.stderr}`);
  assert.equal(codexSame.fd3, "", "S6 auth.json 이 그대로면 반환하지 않는다");
  assert.ok(codexSame.argv.split("\n").includes("--skip-git-repo-check"), "S5");
  const codexRot = runScript({ harness: "codex", creds: { lively: "L", "codex-auth": "orig-auth" }, rotate: true, harnessRc: 4 });
  assert.equal(codexRot.fd3, "rotated-auth", "S6 갱신본만 fd3 로");
  assert.equal(codexRot.rc, 4, "S5 반환 뒤에도 하네스 종료코드 보존");
  const codexNoAuth = runScript({ harness: "codex", creds: { lively: "L" } });
  assert.equal(codexNoAuth.rc, SANDBOX_EXIT_NOCRED, "S5 codex 자격 없음 → 70");
  assert.equal(codexNoAuth.ran, false);
}

// ── M: MCP 설정 ─────────────────────────────────────────────────────────────
{
  const m = JSON.parse(sandboxMcpConfig(GW)) as { mcpServers: { lively: { type: string; url: string; headers: Record<string, string> } } };
  assert.equal(m.mcpServers.lively.type, "http", "M1");
  assert.equal(m.mcpServers.lively.url, `${GW}/mcp`, "M1");
  assert.equal(m.mcpServers.lively.headers.Authorization, "Bearer ${LIVELY_MCP_TOKEN}", "M1 토큰은 자리표시");
  assert.equal(m.mcpServers.lively.headers["x-lively-session"], "${LIVELY_SESSION_ID}", "M1 세션 자리표시");
  assert.equal(m.mcpServers.lively.headers["x-lively-harness"], "claude-code", "M1 하네스 도장");
  assert.throws(() => sandboxMcpConfig("https://x/mcp"), /주소/, "M1 형식 밖");
}

// ── J: 종결 판정 ────────────────────────────────────────────────────────────
{
  const N = "a".repeat(32);
  const end = (o: Partial<Record<string, string>>): string =>
    JSON.stringify({ type: "lvly_task_end", nonce: N, exit_code: "exited", exit_status: "0", result: "success", ...o });
  const tail = (...lines: string[]): string => ['{"type":"result","result":"x"}', ...lines].join("\n") + "\n";
  const unit = (o: Partial<Record<string, string>>) => ({ load: "loaded", active: "active", result: "success", exec_code: "0", exec_status: "0", ...o });

  assert.deepEqual(judgeSandboxTask({ tail: tail(end({})), nonce: N, unit: null }), { state: "done", ok: true, exit: 0, reason: null }, "J1");
  assert.deepEqual(judgeSandboxTask({ tail: tail(end({ nonce: "b".repeat(32) })), nonce: N, unit: null }), { state: "running" }, "J2 위조 줄");
  assert.deepEqual(judgeSandboxTask({ tail: tail(end({})), nonce: null, unit: null }), { state: "running" }, "J3 nonce 모름");
  const cases: Array<[Partial<Record<string, string>>, RegExp, number | null]> = [
    [{ exit_code: "killed", exit_status: "TERM", result: "timeout" }, /시간 상한/, null],
    [{ exit_code: "killed", exit_status: "KILL", result: "oom-kill" }, /메모리 상한/, null],
    [{ exit_status: "69", result: "exit-code" }, /게이트웨이/, 69],
    [{ exit_status: "70", result: "exit-code" }, /자격이 없었다/, 70],
    [{ exit_code: "killed", exit_status: "SEGV", result: "signal" }, /신호로/, null],
    [{ exit_status: "3", result: "exit-code" }, /exit 3/, 3],
    [{ exit_status: "0", result: "exit-code" }, /exit 0/, 0],
  ];
  for (const [o, re, exit] of cases) {
    const v = judgeSandboxTask({ tail: tail(end(o)), nonce: N, unit: null });
    assert.equal(v.state, "done", `J4 ${JSON.stringify(o)}`);
    if (v.state === "done") {
      assert.equal(v.ok, false, `J4 ok=false ${JSON.stringify(o)}`);
      assert.equal(v.exit, exit, `J4 exit ${JSON.stringify(o)}`);
      assert.match(String(v.reason), re, `J4 사유 ${JSON.stringify(o)}`);
    }
  }
  const gone = judgeSandboxTask({ tail: tail(), nonce: N, unit: unit({ load: "not-found", active: "inactive" }) });
  assert.equal(gone.state === "done" && gone.ok === false && /사라졌다/.test(String(gone.reason)), true, "J5");
  const ns = judgeSandboxTask({ tail: "", nonce: N, unit: unit({ active: "failed", result: "exit-code", exec_code: "1", exec_status: "226" }) });
  assert.deepEqual(ns, { state: "done", ok: false, exit: 226, reason: "샌드박스를 세우지 못했다(226/NAMESPACE)" }, "J6");
  const odd = judgeSandboxTask({ tail: "", nonce: N, unit: unit({ active: "failed", result: "resources", exec_code: "1", exec_status: "999" }) });
  assert.equal(odd.state === "done" && /resources 1\/999/.test(String(odd.reason)), true, "J6 모르는 상태값");
  for (const active of ["active", "activating", "deactivating", "inactive"]) {
    assert.deepEqual(judgeSandboxTask({ tail: tail(), nonce: N, unit: unit({ active }) }), { state: "running" }, `J7 ${active}`);
  }
  const many = tail(end({ exit_status: "5", result: "exit-code" }), end({ nonce: "c".repeat(32), exit_status: "0" }), end({ exit_status: "0" }), end({ nonce: "d".repeat(32), exit_status: "9" }));
  const v8 = judgeSandboxTask({ tail: many, nonce: N, unit: null });
  assert.deepEqual(v8, { state: "done", ok: true, exit: 0, reason: null }, "J8 nonce 맞는 마지막 줄");
  assert.deepEqual(judgeSandboxTask({ tail: tail('{"type":"lvly_task_end","nonce":"' + N + '","exit_co'), nonce: N, unit: null }), { state: "running" }, "J9 깨진 줄");
}

// ── 가짜 op 서버 ────────────────────────────────────────────────────────────
interface Req { head: Record<string, unknown>; body: Buffer }
function fakeOp(reply: (req: Req) => TaskOpReply | "silent" | "close" | "garbage"): Promise<{ sock: string; reqs: Req[]; close: () => Promise<void> }> {
  const sock = path.join(TMP, `op-${Math.random().toString(16).slice(2)}.sock`);
  const reqs: Req[] = [];
  const open = new Set<net.Socket>();
  const srv = net.createServer({ allowHalfOpen: true }, (c) => {
    open.add(c);
    c.on("close", () => open.delete(c));
    const chunks: Buffer[] = [];
    c.on("data", (d) => chunks.push(d));
    c.on("end", () => {
      const all = Buffer.concat(chunks);
      const nl = all.indexOf(0x0a);
      const req: Req = { head: JSON.parse(all.subarray(0, nl).toString("utf8")), body: all.subarray(nl + 1) };
      reqs.push(req);
      const r = reply(req);
      if (r === "silent") return;
      if (r === "close") { c.end(); return; }
      if (r === "garbage") { c.end("not json\n"); return; }
      c.end(JSON.stringify(r) + "\n");
    });
  });
  //  닫을 때 남은 연결을 끊는다 — 무응답 흉내(silent)가 연결을 쥔 채라 close 가 영원히 안 끝난다.
  return new Promise((resolve) => srv.listen(sock, () => resolve({
    sock, reqs, close: () => new Promise((r) => { for (const c of open) c.destroy(); srv.close(() => r()); }),
  })));
}

// ── O: op 클라이언트 ────────────────────────────────────────────────────────
{
  const op = await fakeOp(() => ({ ok: true, unit: "u" }));
  const r = await callTaskOp({ op: "launch", slug: "acme" }, {
    files: [{ name: "prompt.txt", data: Buffer.from("AB") }, { name: "run.sh", data: Buffer.from("CDE") }],
    creds: [{ name: "lively", data: Buffer.from("Z") }],
  }, { sock: op.sock });
  assert.deepEqual(r, { ok: true, unit: "u" }, "O1 응답");
  assert.equal(op.reqs.length, 1);
  assert.equal(op.reqs[0]!.head.v, 1, "O1 계약 판");
  assert.deepEqual(op.reqs[0]!.head.files, [{ name: "prompt.txt", size: 2 }, { name: "run.sh", size: 3 }], "O1 파일 크기");
  assert.deepEqual(op.reqs[0]!.head.creds, [{ name: "lively", size: 1 }], "O1 자격 크기");
  assert.equal(op.reqs[0]!.body.toString(), "ABCDEZ", "O1 본문 순서 — 파일 다음 자격");
  const st = await callTaskOp({ op: "status", unit: "u" }, {}, { sock: op.sock });
  assert.equal(st.ok, true);
  assert.equal(op.reqs[1]!.head.files, undefined, "O1 launch 가 아니면 크기 목록을 안 붙인다");
  assert.equal(op.reqs[1]!.body.length, 0);
  await op.close();

  const unreachable = await callTaskOp({ op: "hello" }, {}, { sock: path.join(TMP, "none.sock") });
  assert.equal(unreachable.code, "op_unreachable", "O2");
  const closer = await fakeOp(() => "close");
  assert.equal((await callTaskOp({ op: "hello" }, {}, { sock: closer.sock })).code, "op_bad_reply", "O3");
  await closer.close();
  const silent = await fakeOp(() => "silent");
  const t0 = Date.now();
  assert.equal((await callTaskOp({ op: "hello" }, {}, { sock: silent.sock, timeoutMs: 300 })).code, "op_timeout", "O4");
  assert.ok(Date.now() - t0 < 5000, "O4 상한 안에 끝난다");
  await silent.close();
  const garbage = await fakeOp(() => "garbage");
  assert.equal((await callTaskOp({ op: "hello" }, {}, { sock: garbage.sock })).code, "op_bad_reply", "O5 JSON 아님");
  await garbage.close();
  const noOk = await fakeOp(() => ({ nope: 1 } as unknown as TaskOpReply));
  assert.equal((await callTaskOp({ op: "hello" }, {}, { sock: noOk.sock })).code, "op_bad_reply", "O5 ok 없음");
  await noOk.close();
}

// ── P: 스폰 ─────────────────────────────────────────────────────────────────
interface SpawnLog { order: string[]; minted: number; revoked: string[]; calls: Array<Record<string, unknown>>; parts: Array<{ files: string[]; creds: Array<[string, string]> }> }
function deps(script: (head: Record<string, unknown>, n: number) => TaskOpReply, over: Partial<SandboxSpawnDeps> = {}): { d: Partial<SandboxSpawnDeps>; log: SpawnLog } {
  const log: SpawnLog = { order: [], minted: 0, revoked: [], calls: [], parts: [] };
  const d: Partial<SandboxSpawnDeps> = {
    mint: async (member, sid) => { log.minted++; log.order.push(`mint:${member}`); assert.match(sid, /^box-[a-z0-9-]+-[0-9a-f]{8}$/, "P 세션 id 규약"); return "lvk_session_token"; },
    revoke: async (sid) => { log.revoked.push(sid); log.order.push("revoke"); },
    bind: async () => { log.order.push("bind"); },
    call: async (head, parts = {}) => {
      log.order.push(`call:${String(head.op)}`);
      log.calls.push(head);
      log.parts.push({ files: (parts.files ?? []).map((f) => f.name), creds: (parts.creds ?? []).map((c) => [c.name, c.data.toString("utf8")]) });
      return script(head, log.calls.length);
    },
    ...over,
  };
  return { d, log };
}
const INPUT = (o: Record<string, unknown> = {}) => ({
  user: { userId: "sangmin-yoon" }, taskId: 77, rootKey: "shared", subpath: "", prompt: "증류해", harness: "claude",
  flags: { "--model": "sonnet" }, env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-lease" }, gatewayUrl: GW, tenantSlug: "acme",
  attempt: 1, timeoutSec: 600, ...o,
}) as never;

{
  const { d, log } = deps(() => ({ ok: true, unit: "lvly-task-acme-77-a1", task_dir: "/var/lib/lvly/tasks/acme/77-a1", state: "active" }));
  const r = await spawnSandboxTask(INPUT(), d);
  assert.equal(r.taskDir, "/var/lib/lvly/tasks/acme/77-a1/out", "P1 좌표");
  assert.match(r.sessionId, /^box-sangmin-yoon-[0-9a-f]{8}$/, "P1 세션 id");
  assert.deepEqual(log.order, ["mint:sangmin-yoon", "bind", "call:launch"], "P1 ★ 바인딩이 launch 보다 먼저 · 회수 없음");
  const h = log.calls[0]!;
  assert.equal(h.profile, "context"); assert.equal(h.harness, "claude"); assert.equal(h.task_id, 77); assert.equal(h.attempt, 1);
  assert.deepEqual(h.env, { LIVELY_GATEWAY_URL: GW, LIVELY_SESSION_ID: r.sessionId, LIVELY_TASK_ID: "77", LVLY_TENANT_SLUG: "acme", LIVELY_HARNESS: "claude" }, "P1 env");
  assert.deepEqual(h.limits, { runtime_sec: 660 }, "P10 시간 상한 = timeout + 60");
  assert.match(String(h.nonce), /^[0-9a-f]{32}$/, "P10 nonce");
  assert.deepEqual(log.parts[0]!.files, ["prompt.txt", "run.sh", "mcp.json"], "P1 파일");
  assert.deepEqual(log.parts[0]!.creds, [["anthropic", "sk-ant-lease"], ["lively", "lvk_session_token"]], "P1 자격(리스·판 전용 토큰)");
  assert.ok(!JSON.stringify(h).includes("sk-ant-lease") && !JSON.stringify(h).includes("lvk_session_token"), "P1 자격 값은 머리말에 없다");
}
{
  const { d, log } = deps(() => ({ ok: true, task_dir: "/x/acme/78-a2" }));
  await spawnSandboxTask(INPUT({ taskId: 78, attempt: 2, systemPrompt: "역할" }), d);
  assert.deepEqual(log.parts[0]!.files, ["prompt.txt", "run.sh", "mcp.json", "system.md"], "P2 claude + systemPrompt");
  const c = deps(() => ({ ok: true, task_dir: "/x/acme/79-a1" }));
  await spawnSandboxTask(INPUT({ taskId: 79, harness: "codex", systemPrompt: "역할", env: { CODEX_AUTH_JSON: "{\"tokens\":1}" } }), c.d);
  assert.deepEqual(c.log.parts[0]!.files, ["prompt.txt", "run.sh"], "P2 codex 는 mcp.json·system.md 없음");
  assert.deepEqual(c.log.parts[0]!.creds, [["codex-auth", "{\"tokens\":1}"], ["lively", "lvk_session_token"]], "P2 codex 자격");
}
{
  for (const bad of [INPUT({ env: {} }), INPUT({ harness: "codex", env: { CLAUDE_CODE_OAUTH_TOKEN: "x" } })]) {
    const { d, log } = deps(() => ({ ok: true }));
    await assert.rejects(spawnSandboxTask(bad, d), /자격/, "P3 자격 없음");
    assert.equal(log.minted, 0, "P3 ★ 토큰 발급 전에 멈춘다");
    assert.equal(log.calls.length, 0);
  }
  const noTok = deps(() => ({ ok: true }), { mint: async () => null });
  await assert.rejects(spawnSandboxTask(INPUT(), noTok.d), /lively 토큰/, "P4");
  assert.equal(noTok.log.calls.length, 0, "P4 launch 0");
  for (const bad of [INPUT({ harness: "grok" }), INPUT({ gatewayUrl: null }), INPUT({ gatewayUrl: "https://x/mcp" }), INPUT({ tenantSlug: null }), INPUT({ taskId: "turn-1" }), INPUT({ taskId: 0 })]) {
    const { d, log } = deps(() => ({ ok: true }));
    await assert.rejects(spawnSandboxTask(bad, d), (e: unknown) => e instanceof Error, "P9 형식 밖");
    assert.equal(log.minted, 0, "P9 발급 0");
  }
}
{
  const busy = deps(() => ({ ok: false, code: "busy", error: "context 판이 가득 찼다(4/4)" }));
  await assert.rejects(spawnSandboxTask(INPUT(), busy.d), (e: Error) => e instanceof SandboxBusyError && /가득/.test(e.message), "P5 busy");
  assert.equal(busy.log.revoked.length, 1, "P5 토큰 회수");
  const again = deps((head, n) => n === 1 ? { ok: false, code: "exists", unit: "lvly-task-acme-77-a1", state: "failed" }
    : head.op === "reap" ? { ok: true } : { ok: true, task_dir: "/x/acme/77-a1" });
  await spawnSandboxTask(INPUT(), again.d);
  assert.deepEqual(again.log.calls.map((c) => c.op), ["launch", "reap", "launch"], "P6 끝난 옛 판 치우고 다시");
  assert.equal(again.log.calls[1]!.unit, "lvly-task-acme-77-a1");
  assert.equal(again.log.revoked.length, 0, "P6 성공이면 회수 없음");
  const live = deps(() => ({ ok: false, code: "exists", unit: "lvly-task-acme-77-a1", state: "active" }));
  await assert.rejects(spawnSandboxTask(INPUT(), live.d), (e: Error) => e instanceof SandboxBusyError, "P7 살아 있는 옛 판은 배압");
  assert.deepEqual(live.log.calls.map((c) => c.op), ["launch"], "P7 reap 안 함");
  for (const code of ["spawn_failed", "op_unreachable", "bad_harness"]) {
    const f = deps(() => ({ ok: false, code, error: "boom" }));
    await assert.rejects(spawnSandboxTask(INPUT(), f.d), (e: Error) => !(e instanceof SandboxBusyError) && e.message.includes(code), `P8 ${code}`);
    assert.equal(f.log.revoked.length, 1, `P8 ${code} 회수`);
  }
}

// ── K: 감시 ─────────────────────────────────────────────────────────────────
{
  const root = fs.mkdtempSync(path.join(TMP, "tasks-"));
  const N = "e".repeat(32);
  const mk = (id: number, stream: string, stderr = ""): string => {
    const dir = path.join(root, "acme", `${id}-a1`, "out");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "stream.jsonl"), stream);
    fs.writeFileSync(path.join(dir, "stderr.log"), stderr);
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ nonce: N }));
    return dir;
  };
  const endLine = (o: Record<string, string> = {}) => JSON.stringify({ type: "lvly_task_end", nonce: N, exit_code: "exited", exit_status: "0", result: "success", ...o }) + "\n";
  let statusReply: (req: Req) => TaskOpReply = () => ({ ok: true, load: "loaded", active: "active", result: "success", exec_code: "0", exec_status: "0" });
  const op = await fakeOp((req) => statusReply(req));
  process.env.LIVELY_TASK_OP_SOCK = op.sock;
  process.env.LIVELY_TASK_DATA_ROOT = root;
  const statusCalls = (): number => op.reqs.filter((r) => r.head.op === "status").length;

  const d1 = mk(101, '{"type":"system"}\n{"type":"result","subtype":"success","result":"지식 3건"}\n' + endLine());
  const o1 = await checkSandboxTask({ taskId: 101, taskDir: d1, harness: "claude" }, 1_000_000);
  assert.deepEqual(o1, { taskId: 101, ok: true, exit: 0, summary: "지식 3건" }, "K1 종료 줄 → 성공 · 결과 추출");
  assert.equal(statusCalls(), 0, "K1 op 호출 없음");

  const d2 = mk(102, '{"type":"system"}\n');
  assert.equal(await checkSandboxTask({ taskId: 102, taskDir: d2, harness: "claude" }, 2_000_000), null, "K2 진행 중");
  assert.equal(statusCalls(), 1, "K2 첫 조회는 status 를 본다");
  assert.equal(await checkSandboxTask({ taskId: 102, taskDir: d2, harness: "claude" }, 2_000_000 + 5_000), null);
  assert.equal(statusCalls(), 1, "K2 간격 안에서는 다시 안 묻는다");
  assert.equal(await checkSandboxTask({ taskId: 102, taskDir: d2, harness: "claude" }, 2_000_000 + 25_000), null);
  assert.equal(statusCalls(), 2, "K2 간격이 지나면 다시 묻는다");

  const d3 = mk(103, '{"type":"system"}\n');
  statusReply = () => {
    //  ★ 경합 — 상태를 묻는 사이 판이 끝나(종료 줄을 쓰고) 치워졌다.
    fs.appendFileSync(path.join(d3, "stream.jsonl"), '{"type":"result","result":"끝"}\n' + endLine());
    return { ok: true, load: "not-found", active: "inactive", result: "success", exec_code: "0", exec_status: "0" };
  };
  const o3 = await checkSandboxTask({ taskId: 103, taskDir: d3, harness: "claude" }, 3_000_000);
  assert.deepEqual(o3, { taskId: 103, ok: true, exit: 0, summary: "끝" }, "K3 ★ 두 번째 읽기로 성공 — «사라짐» 오판 없음");

  const d4 = mk(104, '{"type":"system"}\n' + endLine({ exit_status: "69", result: "exit-code" }), "lvly-task: 게이트웨이(https://acme.app.lvly.io)에 닿지 않는다\n");
  const o4 = await checkSandboxTask({ taskId: 104, taskDir: d4, harness: "claude" }, 4_000_000);
  assert.equal(o4?.ok, false, "K4");
  assert.equal(o4?.exit, 69);
  assert.match(String(o4?.error), /게이트웨이에 닿지 못했다\(exit 69\) — lvly-task: 게이트웨이/, "K4 사유 + stderr 꼬리");

  const d5 = mk(105, "");
  statusReply = () => ({ ok: true, load: "loaded", active: "failed", result: "exit-code", exec_code: "1", exec_status: "226" });
  const o5 = await checkSandboxTask({ taskId: 105, taskDir: d5, harness: "claude" }, 5_000_000);
  assert.equal(o5?.ok, false, "K4 기동 실패");
  assert.match(String(o5?.error), /226\/NAMESPACE/);

  const before = statusCalls();
  assert.equal(await checkSandboxTask({ taskId: 9, taskDir: "/work/shared/delegated/task-9/.lively-task/9" }, 6_000_000), null, "K5 샌드박스 좌표 아님");
  assert.equal(statusCalls(), before, "K5 op 호출 없음");
  delete process.env.LIVELY_TASK_OP_SOCK;
  delete process.env.LIVELY_TASK_DATA_ROOT;
  await op.close();
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log("✓ sandbox-task — 경로·탐지·좌표·판 스크립트(실행)·MCP·판정·op 클라이언트·스폰·감시 (R·A·C·S·M·J·O·P·K)");
