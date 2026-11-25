import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { llmRequestId, llmDirExchange, initLlmDir, markLlmDirFinished } from "./style-rewrite-llm-dir.mjs";

const fresh = () => { const d = mkdtempSync(join(tmpdir(), "llm-dir-")); initLlmDir(d); return d; };

// 권한 비트는 POSIX 에서만 뜻이 있다(윈도우 chmod 는 읽기 전용 표시만 바꾼다).
const POSIX = process.platform !== "win32";
const modeOf = (p) => statSync(p).mode & 0o777;

/** 가짜 응답자 — pending 을 claimed 로 집고, 요청을 확인한 뒤 answer(req) 결과를 done 에 쓴다. */
function fakeAnswerer(dir, answer, { ext = "txt", pollMs = 5 } = {}) {
  const seen = [];
  const modes = [];
  const t = setInterval(() => {
    for (const f of readdirSync(join(dir, "pending"))) {
      if (!f.endsWith(".json") || f.startsWith(".")) continue;
      const id = f.slice(0, -5);
      const claimed = join(dir, "claimed", f);
      try { renameSync(join(dir, "pending", f), claimed); } catch { continue; }
      modes.push(modeOf(claimed));
      const req = JSON.parse(readFileSync(claimed, "utf8"));
      seen.push(req);
      const tmp = join(dir, "done", `.${id}.tmp`);
      writeFileSync(tmp, answer(req));
      renameSync(tmp, join(dir, "done", `${id}.${ext}`));
    }
  }, pollMs);
  return { seen, modes, stop: () => clearInterval(t) };
}

test("요청 id 는 문서·순번·용도·실행마다 달라지고 파일명으로 안전하다", () => {
  const a = llmRequestId("run1", "docs/a 문서", 1, "rewrite");
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(a, llmRequestId("run1", "docs/b 문서", 1, "rewrite"));
  assert.notEqual(a, llmRequestId("run1", "docs/a 문서", 2, "rewrite"));
  assert.notEqual(a, llmRequestId("run1", "docs/a 문서", 1, "judge"));
  assert.notEqual(a, llmRequestId("run2", "docs/a 문서", 1, "rewrite"));
  assert.equal(a, llmRequestId("run1", "docs/a 문서", 1, "rewrite"));
});

test("요청을 pending 에 쓰고 done 의 답을 돌려주며, 끝나면 pending·claimed 를 치운다", async () => {
  const dir = fresh();
  const fa = fakeAnswerer(dir, (req) => `echo:${req.prompt}`);
  try {
    const out = await llmDirExchange({ dir, id: "r1", model: "sonnet", purpose: "rewrite", prompt: "안녕", timeoutMs: 5000, pollMs: 5 });
    assert.equal(out, "echo:안녕");
    assert.deepEqual(fa.seen, [{ id: "r1", model: "sonnet", purpose: "rewrite", prompt: "안녕" }]);
    assert.equal(existsSync(join(dir, "pending", "r1.json")), false);
    assert.equal(existsSync(join(dir, "claimed", "r1.json")), false);
    // 쓰다 만 tmp 가 pending 에 남지 않는다(원자적 쓰기).
    assert.deepEqual(readdirSync(join(dir, "pending")), []);
  } finally { fa.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("답이 없으면 제한 시간 뒤 llm_timeout 으로 실패하고 pending 을 치운다", async () => {
  const dir = fresh();
  try {
    const t0 = Date.now();
    await assert.rejects(llmDirExchange({ dir, id: "r2", model: "m", purpose: "judge", prompt: "p", timeoutMs: 60, pollMs: 10 }), { message: "llm_timeout" });
    assert.ok(Date.now() - t0 >= 60);
    assert.equal(existsSync(join(dir, "pending", "r2.json")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("답하는 쪽이 .error 를 쓰면 llm_exit 로 실패한다(배치의 재시도·연속 실패 판정 대상)", async () => {
  const dir = fresh();
  const fa = fakeAnswerer(dir, () => "사용량 한도", { ext: "error" });
  try {
    await assert.rejects(llmDirExchange({ dir, id: "r3", model: "m", purpose: "judge", prompt: "p", timeoutMs: 5000, pollMs: 5 }),
      (e) => /^llm_exit/.test(e.message) && e.message.includes("사용량 한도"));
    assert.equal(existsSync(join(dir, "claimed", "r3.json")), false);
  } finally { fa.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("init 은 앞 실행의 종료 표시를 지우고 pid 를 남기며, finished 는 종료 표시를 쓴다", () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-dir-"));
  try {
    writeFileSync(join(dir, "finished"), "old");
    initLlmDir(dir);
    assert.equal(existsSync(join(dir, "finished")), false);
    assert.equal(readFileSync(join(dir, "batch.pid"), "utf8").trim(), String(process.pid));
    for (const d of ["pending", "claimed", "done"]) assert.ok(existsSync(join(dir, d)));
    markLlmDirFinished(dir);
    assert.ok(existsSync(join(dir, "finished")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 요청·답 파일에는 지식 문서 전문이 담긴다 — 읽은 답은 남기지 않는다(리뷰 2026-10-14 «--llm-dir»).
test("읽은 답 파일(.txt·.error)은 지운다", async () => {
  const dir = fresh();
  try {
    const ok = fakeAnswerer(dir, () => "답");
    try {
      assert.equal(await llmDirExchange({ dir, id: "r4", model: "m", purpose: "rewrite", prompt: "p", timeoutMs: 5000, pollMs: 5 }), "답");
      assert.equal(existsSync(join(dir, "done", "r4.txt")), false);
    } finally { ok.stop(); }
    const bad = fakeAnswerer(dir, () => "실패", { ext: "error" });
    try {
      await assert.rejects(llmDirExchange({ dir, id: "r5", model: "m", purpose: "judge", prompt: "p", timeoutMs: 5000, pollMs: 5 }), /^Error: llm_exit/);
      assert.equal(existsSync(join(dir, "done", "r5.error")), false);
      assert.deepEqual(readdirSync(join(dir, "done")).filter((f) => !f.startsWith(".")), []);
    } finally { bad.stop(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("교환 디렉터리는 0700, 요청·표시 파일은 0600 이다 — 이미 있던 느슨한 디렉터리도 조인다", { skip: !POSIX && "POSIX 권한 비트 전용" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-dir-"));
  try {
    // 앞 실행이나 사람이 0755 로 만들어 둔 자리 — mkdir 의 mode 는 새로 만들 때만 먹는다.
    for (const d of ["pending", "done"]) { mkdirSync(join(dir, d)); chmodSync(join(dir, d), 0o755); }
    chmodSync(dir, 0o755);
    initLlmDir(dir);
    for (const d of [dir, ...["pending", "claimed", "done"].map((x) => join(dir, x))]) assert.equal(modeOf(d), 0o700, d);
    assert.equal(modeOf(join(dir, "batch.pid")), 0o600);
    const fa = fakeAnswerer(dir, () => "답");
    try {
      await llmDirExchange({ dir, id: "r6", model: "m", purpose: "rewrite", prompt: "문서 전문", timeoutMs: 5000, pollMs: 5 });
      assert.deepEqual(fa.modes, [0o600]);
    } finally { fa.stop(); }
    markLlmDirFinished(dir);
    assert.equal(modeOf(join(dir, "finished")), 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
