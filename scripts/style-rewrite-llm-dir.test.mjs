import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { llmRequestId, llmDirExchange, initLlmDir, markLlmDirFinished } from "./style-rewrite-llm-dir.mjs";

const fresh = () => { const d = mkdtempSync(join(tmpdir(), "llm-dir-")); initLlmDir(d); return d; };

/** 가짜 응답자 — pending 을 claimed 로 집고, 요청을 확인한 뒤 answer(req) 결과를 done 에 쓴다. */
function fakeAnswerer(dir, answer, { ext = "txt", pollMs = 5 } = {}) {
  const seen = [];
  const t = setInterval(() => {
    for (const f of readdirSync(join(dir, "pending"))) {
      if (!f.endsWith(".json") || f.startsWith(".")) continue;
      const id = f.slice(0, -5);
      const claimed = join(dir, "claimed", f);
      try { renameSync(join(dir, "pending", f), claimed); } catch { continue; }
      const req = JSON.parse(readFileSync(claimed, "utf8"));
      seen.push(req);
      const tmp = join(dir, "done", `.${id}.tmp`);
      writeFileSync(tmp, answer(req));
      renameSync(tmp, join(dir, "done", `${id}.${ext}`));
    }
  }, pollMs);
  return { seen, stop: () => clearInterval(t) };
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
