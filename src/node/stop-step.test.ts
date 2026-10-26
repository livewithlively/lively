// #5043 — 원격 PC 하네스 종료 규칙의 노드 걸음. 사양: 스크래치 spec.md 표 F.
//  부작용으로 단언한다: tmux 에 실제로 보낸 argv · 새긴 열람 · 판정에 쓴 표.
//  틀리면:
//   🔴 웹 화면 클라이언트를 «사람이 직접 붙음» 으로 세면 — 탭만 열어 둔 세션이 영영 안 꺼진다(누수가 그대로).
//   🔴 사람 클라이언트를 못 세면 — 그 PC 터미널에서 보고 있는 세션이 눈앞에서 꺼진다.
//   🔴 키 화이트리스트가 없으면 — 이 걸음이 하네스에 아무 입력이나 넣는 통로가 된다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { runStopStep, localViewerCounts, localQuotaWait, STOP_STEP_IDS_MAX, type StopStepDeps, type LocalQuotaDeps } from "./stop-step.js";

const AGENT = 900;
function rig(o: { clients?: string; table?: Map<number, { ppid: number }>; jobs?: { jobs: string[]; unknown: string[] } } = {}) {
  const tmuxCalls: string[][] = [];
  const seen: string[] = [];
  const deps: StopStepDeps = {
    tmux: async (args) => {
      tmuxCalls.push(args);
      if (args[0] === "list-clients") return o.clients ?? "";
      if (args[0] === "capture-pane") return "screen";
      if (args[0] === "display-message") return "1";
      return "";
    },
    jobs: async () => ({ jobs: new Set(o.jobs?.jobs ?? []), unknown: new Set(o.jobs?.unknown ?? []) }),
    procTable: async () => o.table ?? new Map(),
    owned: () => [AGENT],
    markSeen: async (id) => { seen.push(id); },
    quota: async (a) => ({ kind: "armed", atMs: a.nowMs - 1, text: `${a.id}:${a.threadId}:${a.reportedPath}:${a.launchedAtMs}` }),
  };
  return { deps, tmuxCalls, seen };
}

test("F1 직접 붙은 클라이언트 — 부모가 에이전트면 안 센다 · 다른 부모면 센다 · 부모를 모르면 센다(놓친 사람은 못 되돌린다) · 안 물은 세션 · 깨진 줄은 무시", () => {
  const raw = [
    "101\tbox-a",     // 웹 화면(부모 = 에이전트)
    "102\tbox-a",     // 사람이 터미널에서(부모 = 셸 500)
    "103\tbox-b",     // 사람(부모 501)
    "104\tbox-b",     // 사람(부모 501)
    "105\tbox-c",     // 부모 모름(표에 없음 — 그새 끝났거나 표가 못 봤다) → 보는 중으로 센다
    "106\tbox-z",     // 안 물은 세션
    "garbage",
    "x\tbox-a",
    "",
  ].join("\n");
  const ppid = new Map([[101, AGENT], [102, 500], [103, 501], [104, 501], [106, 777]]);
  assert.deepEqual(localViewerCounts(raw, (p) => ppid.get(p), new Set([AGENT]), new Set(["box-a", "box-b", "box-c"])), { "box-a": 1, "box-b": 2, "box-c": 1 });
});
test("F2 클라이언트가 있는데 프로세스 표가 비면 던진다(모르는 채 «없다» 고 답하지 않는다) · 클라이언트가 없으면 빈 답", async () => {
  const withClients = rig({ clients: "102\tbox-a\n" });
  await assert.rejects(runStopStep({ step: "viewers", ids: ["box-a"] }, withClients.deps));
  const none = rig({ clients: "" });
  assert.deepEqual(await runStopStep({ step: "viewers", ids: ["box-a"] }, none.deps), { local: {} });
});
test("F3 직접 붙은 세션만 마지막 열람을 지금으로 새긴다 · 클라이언트 목록은 세대를 가로질러 한 번 묻는다", async () => {
  const r = rig({ clients: "101\tbox-a\n102\tbox-b\n", table: new Map([[101, { ppid: AGENT }], [102, { ppid: 500 }]]) });
  const out = await runStopStep({ step: "viewers", ids: ["box-a", "box-b"] }, r.deps);
  assert.deepEqual(out, { local: { "box-b": 1 } });
  assert.deepEqual(r.seen, ["box-b"]);
  assert.deepEqual(r.tmuxCalls, [["list-clients", "-F", "#{client_pid}\t#{session_name}"]]);
});
test("F4 키는 → (Right) 하나만 받는다 — 그 밖은 tmux 에 아무것도 안 보내고 거절", async () => {
  const r = rig();
  assert.deepEqual(await runStopStep({ step: "keys", id: "box-a", key: "Right" }, r.deps), { ok: true });
  for (const key of ["Enter", "C-c", "y", "", "Right; kill-server"]) {
    await assert.rejects(runStopStep({ step: "keys", id: "box-a", key }, r.deps), Error, key);
  }
  assert.deepEqual(r.tmuxCalls, [["send-keys", "-t", "box-a", "Right"]]);
});
test("F5 화면 — 색을 실어(-e) 캡처한다 · 형식 밖 id 는 tmux 를 부르기 전에 거절", async () => {
  const r = rig();
  assert.equal(await runStopStep({ step: "capture", id: "box-a.1" }, r.deps), "screen");
  for (const id of ["", "x", "box-", "box-a b", "-t", "box-a;ls", undefined]) await assert.rejects(runStopStep({ step: "capture", id }, r.deps), Error, String(id));
  assert.deepEqual(r.tmuxCalls, [["capture-pane", "-t", "box-a.1", "-p", "-e"]]);
});
test("F6 작업 판정은 물은 세션만 돌려준다", async () => {
  const r = rig({ jobs: { jobs: ["box-a", "box-other"], unknown: ["box-b", "box-other2"] } });
  assert.deepEqual(await runStopStep({ step: "jobs", ids: ["box-a", "box-b"] }, r.deps), { jobs: ["box-a"], unknown: ["box-b"] });
});
test("F7 한 번에 묻는 세션 수 상한 — 상한까지는 받고 하나 넘으면 거절 · 배열이 아니면 거절", async () => {
  const r = rig();
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `box-s${i}`);
  await runStopStep({ step: "jobs", ids: ids(STOP_STEP_IDS_MAX) }, r.deps);
  await assert.rejects(runStopStep({ step: "jobs", ids: ids(STOP_STEP_IDS_MAX + 1) }, r.deps));
  await assert.rejects(runStopStep({ step: "viewers", ids: "box-a" }, r.deps));
});
test("F8 모르는 걸음은 거절", async () => {
  await assert.rejects(runStopStep({ step: "kill", id: "box-a" }, rig().deps));
  await assert.rejects(runStopStep({}, rig().deps));
});
test("F9 한도 대기 · 안 본 결과 — 인자를 그대로 넘기고 답을 돌려준다", async () => {
  const r = rig();
  assert.deepEqual(await runStopStep({ step: "quota", id: "box-a", threadId: "t-1", reportedPath: "/p/t-1.jsonl", launchedAtMs: 1000, nowMs: 5000 }, r.deps),
    { kind: "armed", atMs: 4999, text: "box-a:t-1:/p/t-1.jsonl:1000" });
  //  보고된 경로가 글이 아니면 빈 글로(그 칸을 믿지 않는다)
  assert.deepEqual(await runStopStep({ step: "quota", id: "box-a", threadId: "t-1", reportedPath: ["/x"], launchedAtMs: 1000, nowMs: 5000 }, r.deps),
    { kind: "armed", atMs: 4999, text: "box-a:t-1::1000" });
  const seen = await runStopStep({ step: "seen", id: "box-a" }, r.deps);
  assert.equal(typeof seen === "boolean" || seen === null, true);
  assert.equal(r.tmuxCalls[0]?.[0], "display-message");
});
test("F10 물은 세션에 붙은 클라이언트가 없으면 프로세스 표를 안 읽는다(빈 답)", async () => {
  let reads = 0;
  const r = rig({ clients: "101\tbox-other\n" });
  const out = await runStopStep({ step: "viewers", ids: ["box-a"] }, { ...r.deps, procTable: async () => { reads++; return new Map(); } });
  assert.deepEqual(out, { local: {} });
  assert.equal(reads, 0);
  //  배선 — 물은 세션에 붙어 있으면 읽는다(빈 표면 던진다 — F2)
  await assert.rejects(runStopStep({ step: "viewers", ids: ["box-other"] }, { ...r.deps, procTable: async () => { reads++; return new Map(); } }));
  assert.equal(reads, 1);
});
test("F11 한도 대기(이 PC) — 보고된 경로를 파일 찾기에 넘긴다 · 대화 id 가 없으면 찾지 않는다 · 이 PC 에 세션이 없으면 던진다", async () => {
  const located: Array<Record<string, unknown>> = [];
  const resolved: unknown[] = [];
  const deps: Partial<LocalQuotaDeps> = {
    sessions: async () => [{ id: "box-a", harness: "claude", dir: "/w", owner: "kim" }],
    locate: (async (_io: unknown, ctx: Record<string, unknown>) => { located.push(ctx); return null; }) as unknown as LocalQuotaDeps["locate"],
    read: (async (id: string, _at: unknown, resolve: (id: string) => Promise<unknown>) => { resolved.push(await resolve(id)); return null; }) as unknown as LocalQuotaDeps["read"],
  };
  const base = { id: "box-a", threadId: "t-1", reportedPath: "", launchedAtMs: 1, nowMs: 2 };
  await localQuotaWait({ ...base, reportedPath: "/Users/kim/.claude/projects/-w/t-1.jsonl" }, deps);
  await localQuotaWait(base, deps);
  assert.deepEqual(located, [
    { cwd: "/w", convId: "t-1", owner: "kim", reportedPath: "/Users/kim/.claude/projects/-w/t-1.jsonl" },
    { cwd: "/w", convId: "t-1", owner: "kim" },
  ]);
  await localQuotaWait({ ...base, threadId: "" }, deps);
  assert.equal(located.length, 2, "대화 id 가 없으면 파일을 찾지 않는다");
  assert.deepEqual(resolved.map((t) => (t as { why?: string }).why), ["not-found", "not-found", "no-uuid"]);
  await assert.rejects(localQuotaWait({ ...base, id: "box-gone" }, deps));
});
