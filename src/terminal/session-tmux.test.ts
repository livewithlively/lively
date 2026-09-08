// 세션 컨테이너 안 tmux (#2545 · #2258 이동 2 의 3단계) — 코어 쪽 조각의 사양.
//
//  ① 스위치(#2546 4단계 — 옛 경로 폐지): ensure 훅(`LIVELY_SESSION_ENSURE`) 이 있고 테넌트 슬러그가 있으면 **항상** 새 경로다.
//     (3단계의 LIVELY_TMUX_IN_SESSION 글롭 게이트는 4단계에서 폐지, 5단계 #2547 에서 흔적까지 제거.) 셀프호스트(훅 없음)·슬러그 없음만 wrapAsMember=box-spawn.
//  ② 판 명령: 컨테이너 안 tmux 가 **멤버 uid** 로 돌므로 sudo 도 spawn 훅도 없다 — box-spawn 이 env 계약(session-env.sh)·cwd·exec 만 한다.
//  ③ ensure 훅: 표준입력 JSON → 표준출력 JSON({container}). 실패(비-0·비JSON·타임아웃)는 던진다 — 조용한 폴백 금지(격리가 꺼진 채 도는 것이 최악).
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BOX_SPAWN } from "./terminal-isolation.js";
import { ensureSessionContainerViaRelay, sessionEnsureArgv, sessionEnsureConfigured, sessionPaneArgv, tmuxInSessionContainer } from "./session-tmux.js";
import { computeExecTopology } from "../exec-topology.js";

// #2599 T2 — 이 판정들은 env 가 아니라 **실행 토폴로지**를 받는다. 시험은 표면(env 한 벌)에서 토폴로지를 만들어 넘긴다.
const ENV_ON = { LIVELY_SESSION_ENSURE: "node /opt/lively/libexec/session-ensure-relay.cjs {slug}" };
const ON = computeExecTopology(ENV_ON);
const OFF = computeExecTopology({});

test("① 스위치(#2546 4단계) — ensure 훅 + 슬러그면 항상 새 경로", () => {
  //  ensure 훅이 있으면(=매니지드) 어느 테넌트든 새 경로다.
  assert.equal(tmuxInSessionContainer("e2e-b-20260902-2555", ON), true);
  assert.equal(tmuxInSessionContainer("lively-46e3", ON), true, "훅만 있으면 모든 테넌트 새 경로");
  //  훅이 없으면(=셀프호스트) wrapAsMember 경로. 컨테이너를 먼저 만들 길이 없다.
  assert.equal(tmuxInSessionContainer("e2e-b-x", OFF), false, "훅 없음 = 셀프호스트 경로");
  //  슬러그가 없으면(단일 테넌트 셀프호스트) 훅이 있어도 셀프호스트 경로 — 훅에 테넌트 컨텍스트를 줄 수 없다.
  assert.equal(tmuxInSessionContainer(null, ON), false, "테넌트 컨텍스트가 없으면 셀프호스트 경로");
  //  ★ 5단계(#2547): 3단계의 글롭 게이트(LIVELY_TMUX_IN_SESSION)는 코드에서 흔적까지 사라졌다 — 되살아나면 여기서 걸린다.
  assert.ok(!/LIVELY_TMUX_IN_SESSION/.test(fs.readFileSync(path.join(process.cwd(), "src", "terminal", "session-tmux.ts"), "utf8")), "글롭 게이트가 되살아났다");
});

test("① ensure 훅 argv — {slug} 치환, 없으면 빈 배열, 컨텍스트 없으면 던진다(남의 테넌트로 폴백 금지)", () => {
  assert.equal(sessionEnsureConfigured(OFF), false);
  assert.equal(sessionEnsureConfigured(ON), true);
  assert.deepEqual(sessionEnsureArgv("acme", ON), ["node", "/opt/lively/libexec/session-ensure-relay.cjs", "acme"]);
  assert.deepEqual(sessionEnsureArgv("acme", OFF), []);
  assert.throws(() => sessionEnsureArgv(null, ON), /테넌트 컨텍스트/);
  assert.deepEqual(sessionEnsureArgv(null, computeExecTopology({ LIVELY_SESSION_ENSURE: "/usr/local/bin/ensure" })), ["/usr/local/bin/ensure"], "{slug} 가 없으면 그대로");
});

test("② 판 명령 — box-spawn --cwd <dir> <launch…>; 셸 세션(launch 비면)은 box-spawn 이 로그인 셸을 띄운다", () => {
  assert.deepEqual(sessionPaneArgv("/home/box_yoon/box", ["sh", "-c", "launch", "lively-launch", "n1", "n2", "claude", "--model", "opus"]),
    [BOX_SPAWN, "--cwd", "/home/box_yoon/box", "sh", "-c", "launch", "lively-launch", "n1", "n2", "claude", "--model", "opus"]);
  assert.deepEqual(sessionPaneArgv("/work/shared/p", []), [BOX_SPAWN, "--cwd", "/work/shared/p"]);
  //  sudo·session-spawn 이 끼지 않는다 — 그게 이 단계가 없애는 층이다.
  const a = sessionPaneArgv("/w", ["claude"]);
  assert.ok(!a.includes("sudo") && !a.some((x) => x.includes("session-spawn")));
});

// ── ③ ensure 훅 호출 — 가짜 릴레이(node 스크립트)로 stdin JSON → stdout JSON 왕복 ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-ens-"));
const relay = (body: string) => {
  const p = path.join(TMP, `relay-${Math.random().toString(16).slice(2)}.cjs`);
  fs.writeFileSync(p, body);
  return [process.execPath, p, "acme"];
};
const REQ = { sessionId: "box-yoon-1a2b3c4d", osUser: "box_yoon", cwd: "/home/box_yoon/box", memMb: 3072, memRequestMb: 768, tmux: "inside" as const };

test("③ ensure — 요청 JSON 을 그대로 실어 보내고 응답의 container 를 돌려준다", async () => {
  const argv = relay(`let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{const j=JSON.parse(b);process.stdout.write(JSON.stringify({container:"lvly-s-"+process.argv[2]+"-"+j.sessionId,created:true,echo:j}))});`);
  const out = await ensureSessionContainerViaRelay(argv, REQ);
  assert.equal(out.container, "lvly-s-acme-box-yoon-1a2b3c4d");
  assert.equal(out.created, true);
  assert.deepEqual((out as { echo?: unknown }).echo, REQ, "요청이 바이트 그대로 간다(tmux:inside 포함)");
});

test("③ ensure — 비-0 종료는 stderr 를 실어 던진다 · 비JSON·container 없음도 던진다 · 타임아웃도 던진다", async () => {
  await assert.rejects(ensureSessionContainerViaRelay(relay(`process.stderr.write("브로커 연결 실패(hub 503)");process.exit(7)`), REQ), /브로커 연결 실패/);
  await assert.rejects(ensureSessionContainerViaRelay(relay(`process.stdout.write("not json")`), REQ), /JSON|응답/);
  await assert.rejects(ensureSessionContainerViaRelay(relay(`process.stdout.write(JSON.stringify({message:"용량 부족"}))`), REQ), /container/);
  await assert.rejects(ensureSessionContainerViaRelay(relay(`setTimeout(()=>{}, 5000)`), REQ, { timeoutMs: 300 }), /시간|timeout/i);
  await assert.rejects(ensureSessionContainerViaRelay([], REQ), /훅/);
});
