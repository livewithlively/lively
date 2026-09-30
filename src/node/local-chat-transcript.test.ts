// 노드가 session id로 확인한 실제 하네스 메타만 사용해 로컬 대화 파일을 읽는 계약 (#3870).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readLocalSessionTranscriptChunk } from "./local-chat-transcript.js";

const uuid = "4e2e9a14-34aa-45ca-b061-c8a97465ff0e";

test("Claude 세션 메타로 찾은 파일을 크기 조회와 제한 청크로 읽는다", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "node-claude-transcript-"));
  const file = path.join(tmp, `${uuid}.jsonl`);
  const raw = Buffer.from(`${JSON.stringify({ type: "user", message: { role: "user", content: "Set model to fable" } })}\n`);
  await fs.writeFile(file, raw);
  let locateCalls = 0;
  const session = { harness: "claude", dir: "/Users/lively/workspace/project/4135", owner: "wonjoon-jang" };
  const deps = {
    locate: async (_io: unknown, ctx: { cwd: string; convId: string; owner: string }) => {
      locateCalls++;
      assert.deepEqual(ctx, { cwd: session.dir, convId: uuid, owner: session.owner });
      return { file, size: raw.length, via: "convention" as const };
    },
  };
  try {
    const stat = await readLocalSessionTranscriptChunk(session, uuid, 0, 0, deps);
    assert.deepEqual(stat, { found: true, size: raw.length, offset: 0, data: "", eof: false });
    const part = await readLocalSessionTranscriptChunk(session, uuid, 4, 11, deps);
    assert.equal(Buffer.from(part.data, "base64").toString(), raw.subarray(4, 15).toString());
    assert.equal(part.offset, 4);
    assert.equal(part.eof, false);
    assert.equal(locateCalls, 2);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test("세션 없음·잘못된 Claude UUID는 파일 위치를 묻기 전에 거부한다", async () => {
  let locateCalls = 0;
  const deps = { locate: async () => { locateCalls++; return null; } };
  const missing = await readLocalSessionTranscriptChunk(null, uuid, 0, 0, deps);
  const invalid = await readLocalSessionTranscriptChunk({ harness: "claude", dir: "/w", owner: "wonjoon-jang" }, "../../etc/passwd", 0, 10, deps);
  assert.equal(missing.found, false);
  assert.equal(invalid.found, false);
  assert.equal(locateCalls, 0);
});

test("Codex 세션은 기존 rollout 제한 읽기에 그대로 위임한다", async () => {
  let called = 0;
  const got = await readLocalSessionTranscriptChunk(
    { harness: "codex", dir: "/w", owner: "wonjoon-jang" },
    "01a0a3f3-8e21-7b41-a203-8b58dfbca1c5", 7, 19,
    { readCodex: async (threadId, offset, len) => {
      called++;
      assert.deepEqual([threadId, offset, len], ["01a0a3f3-8e21-7b41-a203-8b58dfbca1c5", 7, 19]);
      return { found: true, size: 20, offset: 7, data: "", eof: false };
    } },
  );
  assert.equal(called, 1);
  assert.equal(got.found, true);
});
