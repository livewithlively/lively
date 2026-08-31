// claude 대화 런타임 계약 (#2439 ②) — 가짜 프로세스(spawnFn seam)로 **실제 spawn 없이** 검증한다.
//
//  지키는 것 셋:
//   ① argv 가 필요한 플래그를 다 갖는다(하나라도 빠지면 그 표면이 통째로 안 온다).
//   ② stdout 청크가 줄 가운데서 끊겨도 이벤트를 잃지 않는다.
//   ③ ★ 런타임이 죽으면 걸려 있던 승인이 **반드시 마감**된다 — 안 하면 그 턴은 영영 안 끝난다.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  ClaudeChatUnavailable, claudeChatArgv, claudeChatSpawnArgv,
  ensureClaudeChat, isClaudeChatLive, sendClaudeChat, stopClaudeChat,
} from "./claude-chat-runtime.js";
import { ask, onSessionEvent, pendingAsks, resetSessionBus } from "./runtime-bus.js";
import type { SessionEvent } from "./session-event.js";

let pass = 0;
const t = (name: string, fn: () => Promise<void> | void): Promise<void> =>
  Promise.resolve(fn()).then(() => { pass++; console.log(`ok  ${name}`); });

/** 가짜 자식 프로세스 — stdout 을 우리가 밀어 넣고, exit 를 우리가 낸다. */
function fakeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const written: string[] = [];
  child.stdin = { write: (s: string) => { written.push(s); return true; }, end: () => {}, destroyed: false };
  child.kill = () => {};
  child.written = written;
  return child;
}
const opts = (sessionId: string, child: any) => ({
  sessionId, cwd: "/tmp", osUser: null, spawnFn: () => child,
});

await t("[1] argv — 필요한 플래그가 다 있다(하나 빠지면 그 표면이 통째로 안 온다)", () => {
  const a = claudeChatArgv({});
  for (const f of ["--print", "--input-format", "stream-json", "--output-format", "--verbose",
                   "--replay-user-messages", "--forward-subagent-text"]) {
    assert.ok(a.includes(f), `${f} 가 있다`);
  }
  //  ⚠ 없는 대화 id 로 --resume 하면 프로세스가 즉시 죽는다 — 있을 때만 붙인다.
  assert.ok(!a.includes("--resume"), "convId 가 없으면 --resume 을 안 붙인다");
  assert.ok(claudeChatArgv({ convId: "abc" }).includes("--resume"));
  assert.ok(claudeChatArgv({ model: "claude-haiku-4-5" }).includes("--model"));
});

await t("[2] 실행 경계 사다리 — 세션 → 멤버 → 로컬 (경계 계산을 두 벌로 두지 않는다)", () => {
  const argv = ["claude", "--print"];
  //  중계 env 가 없으면 로컬(비격리) — osUser 도 없으면 argv 그대로.
  assert.deepEqual(claudeChatSpawnArgv("s1", null, argv), argv);
  //  osUser 가 있으면 멤버 경계로 감싼다(sudo→box-spawn). 원 argv 가 꼬리에 그대로 남는다.
  const wrapped = claudeChatSpawnArgv("s1", "box_yoon", argv);
  assert.ok(wrapped.length > argv.length, "감쌌다");
  assert.deepEqual(wrapped.slice(-argv.length), argv, "원 명령이 꼬리에 그대로 있다");
});

await t("[3] stdout 이벤트가 버스로 흐른다 · ★줄 가운데서 끊겨도 잃지 않는다", async () => {
  const S = "r3"; resetSessionBus(S);
  const got: SessionEvent[] = [];
  onSessionEvent(S, (e) => got.push(e));
  const child = fakeChild();
  ensureClaudeChat(opts(S, child) as any);

  const evt = JSON.stringify({
    type: "system", subtype: "task_started", task_id: "T1", task_type: "local_bash",
    description: "빌드", tool_use_id: "tu1",
  });
  //  ⚠ 청크를 **줄 가운데서** 자른다 — 실제 파이프가 그렇게 온다.
  child.stdout.write(evt.slice(0, 20));
  child.stdout.write(evt.slice(20) + "\n");
  await new Promise((r) => setImmediate(r));

  const started = got.find((e) => e.t === "task.started");
  assert.ok(started, "task.started 가 왔다");
  assert.equal((started as any).task.kind, "shell");
  assert.equal((started as any).task.title, "빌드");
  stopClaudeChat(S, "테스트 정리");
});

await t("[4] 대화 id 를 첫 줄에서 잡는다(재개·대화 파일 찾기의 단서)", async () => {
  const S = "r4"; resetSessionBus(S);
  const child = fakeChild();
  ensureClaudeChat(opts(S, child) as any);
  child.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "conv-9", model: "m" }) + "\n");
  await new Promise((r) => setImmediate(r));
  const { convId } = sendClaudeChat({ ...opts(S, child), text: "hi" } as any);
  assert.equal(convId, "conv-9");
  stopClaudeChat(S, "테스트 정리");
});

await t("[5] 말을 걸면 stream-json 한 줄이 stdin 으로 나간다", async () => {
  const S = "r5"; resetSessionBus(S);
  const child = fakeChild();
  sendClaudeChat({ ...opts(S, child), text: "안녕" } as any);
  assert.equal(child.written.length, 1);
  const sent = JSON.parse(child.written[0]);
  assert.equal(sent.type, "user");
  assert.equal(sent.message.content[0].text, "안녕");
  assert.ok(child.written[0].endsWith("\n"), "줄바꿈으로 끝난다(JSONL)");
  stopClaudeChat(S, "테스트 정리");
});

await t("[6] 빈 말은 거부 — 런타임을 띄우지도 않는다", () => {
  const S = "r6"; resetSessionBus(S);
  assert.throws(() => sendClaudeChat({ ...opts(S, fakeChild()), text: "   " } as any), ClaudeChatUnavailable);
  assert.equal(isClaudeChatLive(S), false);
});

await t("[7] ★★ 프로세스가 죽으면 걸려 있던 승인이 마감된다 — 안 하면 그 턴은 영영 안 끝난다", async () => {
  const S = "r7"; resetSessionBus(S);
  const child = fakeChild();
  ensureClaudeChat(opts(S, child) as any);
  const p = ask<string>(S, "a1", { toolName: "Bash" }, "deny");
  assert.equal(pendingAsks(S).length, 1);
  child.emit("exit", 1, null);                       // 런타임 사망
  assert.equal(await p, "deny", "기본값(거부)으로 마감됐다");
  assert.equal(pendingAsks(S).length, 0);
  assert.equal(isClaudeChatLive(S), false);
});

await t("[8] stop 은 멱등 · 죽은 뒤에도 남은 승인을 마감한다", async () => {
  const S = "r8"; resetSessionBus(S);
  const child = fakeChild();
  ensureClaudeChat(opts(S, child) as any);
  assert.equal(stopClaudeChat(S, "1차"), true);
  assert.equal(stopClaudeChat(S, "2차"), false, "두 번 불러도 안전하다");
  //  런타임이 없어도 남은 승인은 마감한다(경합으로 순서가 뒤집힐 수 있다).
  const p = ask<string>(S, "a1", {}, "deny");
  stopClaudeChat(S, "3차");
  assert.equal(await p, "deny");
});

await t("[9] 같은 세션에 두 번 ensure 하면 프로세스는 하나다", () => {
  const S = "r9"; resetSessionBus(S);
  let spawned = 0;
  const child = fakeChild();
  const o = { sessionId: S, cwd: "/tmp", osUser: null, spawnFn: () => { spawned++; return child; } };
  ensureClaudeChat(o as any); ensureClaudeChat(o as any);
  assert.equal(spawned, 1);
  stopClaudeChat(S, "테스트 정리");
});

console.log(`\n${pass}건 통과`);
