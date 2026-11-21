// #5650 — 데스크톱 앱이 `lively work-root add <절대경로> --json-events` 로 작업 폴더를 등록한다.
//  엣지 표(행마다 테스트 1개 이상):
//   W1 폴더 있음            → 그대로 쓴다(created=false)
//   W2 폴더 없음 · 위 있음   → 한 단계 만든다(created=true)
//   W3 폴더 없음 · 위도 없음 → 만들지 않는다(오타로 폴더 나무를 만들지 않게)
//   W4 같은 이름의 파일      → 거절
//   W5 실제 CLI · 이벤트 모드 → 묻지 않고(prompt 0) 만들어 등록 · result 이벤트 · 판정이 켜짐
//   W6 다시 부름            → already(멱등) · created=false
//   W7 실제 CLI · 위도 없음  → 종료 2 · 아무것도 안 만듦 · end.ok=false
//  실행: node --test kit/cli/work-root-add.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sandboxEnv } from "../testlib/os-sandbox.mjs";

const HERE = join(fileURLToPath(import.meta.url), "..");
const CLI = join(HERE, "lively.mjs");
const { prepareWorkRootDir } = await import(pathToFileURL(CLI));
const rs = await import(pathToFileURL(join(HERE, "..", "hooks", "record-scope.mjs")));

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "wroot-"));
  const home = join(root, "home"), lively = join(home, ".lively"), tmp = join(root, "tmp");
  mkdirSync(lively, { recursive: true }); mkdirSync(tmp, { recursive: true });
  rs.writeScopeFile(lively, { scope: "work_folders", work_roots: [], updated_at: "t", synced_at: "t" });
  return { root, home, lively, tmp };
}
// 게이트웨이 없음(오프라인) — 등록은 사본에 pending 으로 쌓이고 판정엔 바로 반영된다(record-scope.test.mjs C1 과 같은 꼴).
const runCli = (sb, args) => {
  const env = { ...process.env, ...sandboxEnv({ home: sb.home, tmp: sb.tmp }), LIVELY_HOST_EFFECTS_TEST_MODE: "sandbox",
    LIVELY_HOME: sb.home, CLAUDE_PROJECT_DIR: sb.root, LIVELY_SESSION_DIR: "", LIVELY_HARNESS: "", LIVELY_WORK_ROOTS: "",
    LIVELY_TOKEN: "", LIVELY_GATEWAY_URL: "",
    // 닫힌 PATH — 실제 claude·codex 를 가린다(cli-spawn-harness-sandbox 관례). node 자리만 둔다.
    PATH: dirname(process.execPath) };
  //  stdin 을 닫아 둔다 — 프롬프트가 하나라도 나가면 이벤트 모드는 EOF 를 실패로 본다(fail-closed). 그러니 통과 = 묻지 않았다.
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 });
  const events = String(r.stdout || "").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { code: r.status ?? -1, events, err: String(r.stderr || "") };
};

test("W1 있는 폴더는 그대로 쓴다(만들지 않음)", () => {
  const sb = sandbox(); const d = join(sb.root, "have"); mkdirSync(d);
  assert.deepEqual(prepareWorkRootDir(d), { ok: true, created: false });
});
test("W2 없는 폴더 + 위 폴더 있음 → 한 단계 만든다", () => {
  const sb = sandbox(); const d = join(sb.root, "new-one");
  const r = prepareWorkRootDir(d);
  assert.equal(r.ok, true); assert.equal(r.created, true);
  assert.ok(statSync(d).isDirectory());
});
test("W3 위 폴더까지 없으면 만들지 않는다(오타로 폴더 나무를 만들지 않게)", () => {
  const sb = sandbox(); const d = join(sb.root, "no-parent", "child");
  const r = prepareWorkRootDir(d);
  assert.equal(r.ok, false); assert.ok(r.error && !r.error.includes("—"), r.error);
  assert.equal(existsSync(join(sb.root, "no-parent")), false);
});
test("W4 같은 이름의 파일이면 거절한다", () => {
  const sb = sandbox(); const f = join(sb.root, "a-file"); writeFileSync(f, "x");
  assert.equal(prepareWorkRootDir(f).ok, false);
});

test("W5 ★ 실제 CLI: --json-events 로 없는 폴더를 묻지 않고 만들어 등록하고 result 로 알린다", () => {
  const sb = sandbox(); const d = join(sb.root, "work");
  const r = runCli(sb, ["work-root", "add", d, "--json-events"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(d) && statSync(d).isDirectory(), "폴더를 만들지 않았다");
  assert.ok(r.events.some((e) => e.t === "start"), "관측 장치(이벤트 스트림)가 죽어 있다: " + r.err);
  assert.equal(r.events.filter((e) => e.t === "prompt").length, 0, "묻지 않아야 한다");
  const res = r.events.find((e) => e.t === "result");
  assert.ok(res, JSON.stringify(r.events));
  assert.equal(res.data.action, "add"); assert.equal(res.data.path, d);
  assert.equal(res.data.created, true); assert.equal(res.data.outcome, "added");
  assert.equal(r.events.find((e) => e.t === "end")?.ok, true);
  assert.ok(rs.decideRecordScope({ env: {}, dir: d, lively: sb.lively }).inScope, "등록했는데 판정이 꺼져 있다");
});
test("W6 실제 CLI: 다시 부르면 already(멱등) · created=false", () => {
  const sb = sandbox(); const d = join(sb.root, "work2");
  assert.equal(runCli(sb, ["work-root", "add", d, "--json-events"]).code, 0);
  const r = runCli(sb, ["work-root", "add", d, "--json-events"]);
  assert.equal(r.code, 0, r.err);
  const res = r.events.find((e) => e.t === "result");
  assert.equal(res?.data?.outcome, "already"); assert.equal(res?.data?.created, false);
});
test("W7 실제 CLI: 위 폴더까지 없으면 종료 2 · 아무것도 만들지 않는다", () => {
  const sb = sandbox(); const d = join(sb.root, "missing", "work");
  const r = runCli(sb, ["work-root", "add", d, "--json-events"]);
  assert.equal(r.code, 2, r.err);
  assert.equal(existsSync(join(sb.root, "missing")), false);
  assert.equal(r.events.find((e) => e.t === "end")?.ok, false);
});
