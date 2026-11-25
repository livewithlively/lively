import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { ensureCursorChat, sendCursorChat, stopClaudeChat, ClaudeChatUnavailable } from "./claude-chat-runtime.js";

function fakeCursor(authOk: boolean) {
  const requests: Array<{ id?: number; method: string; params?: Record<string, unknown> }> = [];
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(String(chunk).trim());
    requests.push(request);
    const reply = request.method === "initialize" ? { protocolVersion: 1, agentCapabilities: {} }
      : request.method === "authenticate" ? (authOk ? {} : undefined)
      : request.method === "session/new" ? { sessionId: "new-cursor-id" }
      : request.method === "session/load" ? { sessionId: request.params.sessionId }
      : { stopReason: "end_turn" };
    if (request.id !== undefined) setImmediate(() => stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id,
      ...(reply === undefined ? { error: { code: -32000, message: "Authentication required" } } : { result: reply }) }) + "\n"));
    done();
  } });
  Object.assign(child, { stdin, stdout, stderr, kill: () => true });
  return { child, requests };
}

const first = fakeCursor(true);
let argv: string[] = [];
const entry = await ensureCursorChat({ sessionId: "cursor-new-test", cwd: "/tmp", osUser: null, model: "sample-model",
  spawnFn: (a) => { argv = a; return first.child; } });
assert.deepEqual(argv, ["agent", "--model", "sample-model", "acp"]);
assert.deepEqual(first.requests.map((r) => r.method), ["initialize", "authenticate", "session/new"]);
assert.equal(entry.convId, "new-cursor-id");
assert.equal(sendCursorChat(entry, "안녕", 9), true);
assert.equal(first.requests[3]?.method, "session/prompt");
assert.equal(first.requests[3]?.params?.sessionId, "new-cursor-id");
stopClaudeChat("cursor-new-test", "test");

const resumed = fakeCursor(true);
const loaded = await ensureCursorChat({ sessionId: "cursor-resume-test", cwd: "/tmp", osUser: null, convId: "old-cursor-id",
  spawnFn: () => resumed.child });
assert.deepEqual(resumed.requests.map((r) => r.method), ["initialize", "authenticate", "session/load"]);
assert.equal(resumed.requests[2]?.params?.sessionId, "old-cursor-id");
assert.equal(loaded.convId, "old-cursor-id");
stopClaudeChat("cursor-resume-test", "test");

const unauth = fakeCursor(false);
await assert.rejects(() => ensureCursorChat({ sessionId: "cursor-unauth-test", cwd: "/tmp", osUser: null,
  spawnFn: () => unauth.child }), (err: unknown) => err instanceof ClaudeChatUnavailable && /로그인/.test(err.message));
assert.deepEqual(unauth.requests.map((r) => r.method), ["initialize", "authenticate"], "로그인 실패 뒤에 새 세션을 열면 안 된다");
console.log("cursor-chat-runtime: 새 세션·재개·로그인 실패 통과");
