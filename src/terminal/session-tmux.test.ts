// 세션 컨테이너 안 tmux (#2545 · #2258 이동 2 의 3단계) — 코어 쪽 조각의 사양.
//
//  ① 스위치: `LIVELY_TMUX_IN_SESSION`(슬러그 글롭 목록) 과 ensure 훅(`LIVELY_SESSION_ENSURE`)이 **둘 다** 있고 이 테넌트가
//     목록에 맞을 때만 새 경로다. 셀프호스트(둘 다 없음)·목록 밖 테넌트는 종전 그대로(순수 추가).
//  ② 판 명령: 컨테이너 안 tmux 가 **멤버 uid** 로 돌므로 sudo 도 spawn 훅도 없다 — box-spawn 이 env 계약(session-env.sh)·cwd·exec 만 한다.
//  ③ ensure 훅: 표준입력 JSON → 표준출력 JSON({container}). 실패(비-0·비JSON·타임아웃)는 던진다 — 조용한 폴백 금지(격리가 꺼진 채 도는 것이 최악).
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BOX_SPAWN } from "./terminal-isolation.js";
import { ensureSessionContainerViaRelay, sessionEnsureArgv, sessionEnsureConfigured, sessionPaneArgv, tmuxInSessionContainer } from "./session-tmux.js";

const ENV_ON = { LIVELY_SESSION_ENSURE: "node /opt/lively/libexec/session-ensure-relay.cjs {slug}" };

test("① 스위치 — 글롭 목록 · 훅 유무 · 슬러그 유무", () => {
  assert.equal(tmuxInSessionContainer("e2e-b-20260902-2555", { ...ENV_ON, LIVELY_TMUX_IN_SESSION: "e2e-b-*" }), true);
  assert.equal(tmuxInSessionContainer("lively-46e3", { ...ENV_ON, LIVELY_TMUX_IN_SESSION: "e2e-b-*" }), false, "목록 밖 테넌트는 옛 경로");
  assert.equal(tmuxInSessionContainer("lively-46e3", { ...ENV_ON, LIVELY_TMUX_IN_SESSION: "*" }), true, "* 는 전부");
  assert.equal(tmuxInSessionContainer("lively-46e3", { ...ENV_ON, LIVELY_TMUX_IN_SESSION: "e2e-b-*, lively-46e3" }), true, "쉼표·공백 목록");
  assert.equal(tmuxInSessionContainer("lively-46e3x", { ...ENV_ON, LIVELY_TMUX_IN_SESSION: "lively-46e3" }), false, "정확 일치 — 접두 우연은 아니다");
  assert.equal(tmuxInSessionContainer("e2e-b-x", { ...ENV_ON, LIVELY_TMUX_IN_SESSION: "" }), false, "비면 꺼짐");
  assert.equal(tmuxInSessionContainer("e2e-b-x", { LIVELY_TMUX_IN_SESSION: "*" }), false, "ensure 훅이 없으면 컨테이너를 먼저 만들 길이 없다 — 꺼짐");
  assert.equal(tmuxInSessionContainer(null, { ...ENV_ON, LIVELY_TMUX_IN_SESSION: "*" }), false, "테넌트 컨텍스트가 없으면 옛 경로(셀프호스트 단일 테넌트)");
  assert.equal(tmuxInSessionContainer("a.b", { ...ENV_ON, LIVELY_TMUX_IN_SESSION: "a.b" }), true);
  assert.equal(tmuxInSessionContainer("axb", { ...ENV_ON, LIVELY_TMUX_IN_SESSION: "a.b" }), false, "글롭의 . 은 정규식이 아니다");
});

test("① ensure 훅 argv — {slug} 치환, 없으면 빈 배열, 컨텍스트 없으면 던진다(남의 테넌트로 폴백 금지)", () => {
  assert.equal(sessionEnsureConfigured({}), false);
  assert.equal(sessionEnsureConfigured(ENV_ON), true);
  assert.deepEqual(sessionEnsureArgv("acme", ENV_ON), ["node", "/opt/lively/libexec/session-ensure-relay.cjs", "acme"]);
  assert.deepEqual(sessionEnsureArgv("acme", {}), []);
  assert.throws(() => sessionEnsureArgv(null, ENV_ON), /테넌트 컨텍스트/);
  assert.deepEqual(sessionEnsureArgv(null, { LIVELY_SESSION_ENSURE: "/usr/local/bin/ensure" }), ["/usr/local/bin/ensure"], "{slug} 가 없으면 그대로");
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
