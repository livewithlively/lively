// 세션 결과물 자동 자료 등록(#5790) — 판정 표. 실제 등록(DB·폴더)은 session-outputs.pg-test.mjs 가 잰다.
//  원준 2026-11-24: «지금 우리 AI가 만들어낸 작업물의 결과가 자동으로 자료에 올라가는 상황인게 맞아? 아닌거같지 왜»
//  → 중앙 세션은 공유 저장소에 직접 써서 업로드(=자료 등록)가 없었다. 턴 끝에 그 세션의 프로젝트 폴더를 훑는다.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  isOutputFile, pickSessionOutputs, sweepTarget, sweepSessionOutputs, resetSessionOutputSweeps, sameOutputState, capBlocks,
  MAX_PER_SWEEP, MIN_INTERVAL_MS, type KnownOutput, type SweepSession, type SweepReport, type SweepShared,
} from "./session-outputs.js";

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");

// ── O 결과물인가 ─────────────────────────────────────────────────────────────────
//  | #  | 경로                                   | 결과물? | 왜                                  |
//  | O1 | .hidden.md · .lively/x.md · a.zip     | 아니오  | 자료 형식 규칙(classifyLocalPath)이 버린다 |
//  | O2 | AGENTS.md · CLAUDE.md (맨 위)          | 아니오  | 라이블리가 쓰는 안내 파일              |
//  | O2'| docs/AGENTS.md                         | 예      | 하위 폴더의 같은 이름은 사람 문서다     |
//  | O3 | tmp/a.md · cache/x.png · venv/a.txt    | 아니오  | 임시·가상환경 폴더                     |
//  | O4 | draft.md~                              | 아니오  | 편집기 백업                            |
//  | O5 | run.log · a.tmp · b.bak · c.part       | 아니오  | 임시·로그                              |
//  | O6 | make_chart.py · build.sh · app.ts      | 아니오  | 코드·스크립트(결과물을 만드는 도구)      |
//  | O7 | 보고서.pdf · 홍보물.png · 요약.md · 표.csv · 발표.pptx · 본문.hwp · 페이지.html · data.json · 그림.svg | 예 | 사람에게 줄 결과물 |
test("O1~O7 결과물로 볼 파일 — 문서·이미지·PDF·표는 예, 코드·임시·숨김·안내 파일은 아니오", () => {
  for (const rel of [".hidden.md", ".lively/x.md", "a.zip", "node_modules/x/readme.md"]) assert.equal(isOutputFile(rel), false, `O1 ${rel}`);
  for (const rel of ["AGENTS.md", "CLAUDE.md"]) assert.equal(isOutputFile(rel), false, `O2 ${rel}`);
  assert.equal(isOutputFile("docs/AGENTS.md"), true, "O2' 하위 폴더의 AGENTS.md 는 사람 문서");
  for (const rel of ["tmp/a.md", "cache/x.png", "venv/a.txt", "Temp/b.pdf", "out/site-packages/x.md"]) assert.equal(isOutputFile(rel), false, `O3 ${rel}`);
  assert.equal(isOutputFile("draft.md~"), false, "O4");
  for (const rel of ["run.log", "a.tmp", "b.bak", "c.part", "d.crdownload", "e.swp"]) assert.equal(isOutputFile(rel), false, `O5 ${rel}`);
  for (const rel of ["make_chart.py", "build.sh", "app.ts", "x.ipynb", "q.sql", "s.css"]) assert.equal(isOutputFile(rel), false, `O6 ${rel}`);
  for (const rel of ["보고서.pdf", "크리스마스 생화 트리 재능기부 홍보물.png", "요약.md", "표.csv", "발표.pptx", "본문.hwp", "페이지.html", "data.json", "그림.svg", "결과/최종본.docx", "a.xlsx", "사진.jpg"]) {
    assert.equal(isOutputFile(rel), true, `O7 ${rel}`);
  }
  assert.equal(isOutputFile(""), false, "빈 경로");
});

// ── P 이번 턴에 무엇을 등록하나 ───────────────────────────────────────────────────
//  | #  | 조건                                         | 등록? |
//  | P1 | 세션 시작(since) 전 시각                      | 아니오 |
//  | P2 | 크기 상한 초과                                | 아니오 |
//  | P3 | 결과물이 아님(코드 등)                         | 아니오 |
//  | P4 | 같은 시각·크기로 이미 자료에 있다(지운 행 포함) | 아니오 |
//  | P5 | 자료에 있지만 시각이나 크기가 바뀌었다          | 예     |
//  | P5'| 자료 행의 시각을 모른다(null — 옛 매니지드 행) · 크기 같음 | 아니오(모르는 값 때문에 되살리거나 매 턴 다시 읽지 않는다) |
//  | P5"| 자료 행의 시각을 모른다 · 크기가 다르다         | 예(바뀌었다) |
//  | P6 | 최근 것부터, 같은 시각이면 경로순               | —      |
//  | P7 | 상한(limit)까지만 — 남은 것은 다음 턴           | —      |
//  | P8 | 안쪽에 든 다른 프로젝트의 폴더(#4688)           | 아니오(그 프로젝트의 자료다 · '/' 경계) |
const F = (path: string, mtime: number, size = 10) => ({ path, mtime, size });
test("P1~P7 이번 턴에 등록할 파일 — 세션 뒤에 생겼고 결과물이고 아직 그 상태로 자료에 없는 것, 최근 것부터 상한까지", () => {
  const since = 1_000_000;
  const files = [
    F("old.pdf", since - 1),             // P1
    F("big.pdf", since + 1, 200 * 1024 * 1024),   // P2
    F("chart.py", since + 2),            // P3
    F("same.png", since + 3, 50),        // P4
    F("gone.md", since + 4, 7),          // P4 — 사람이 자료에서 지웠다(행은 남아 있다)
    F("changed.pdf", since + 5, 99),     // P5 시각이 다르다
    F("resized.csv", since + 6, 12),     // P5 크기가 다르다
    F("legacy.png", since + 7, 5),       // P5' 행 시각 모름 · 크기 같음
    F("legacy2.png", since + 8, 6),      // P5" 행 시각 모름 · 크기 다름
    F("new-b.md", since + 9),            // P6 같은 시각 — 경로순
    F("new-a.md", since + 9),
    F("newest.pptx", since + 10),
  ];
  const known = new Map<string, KnownOutput>([
    ["same.png", { mtime: since + 3, bytes: 50 }],
    ["gone.md", { mtime: since + 4, bytes: 7 }],
    ["changed.pdf", { mtime: since + 1, bytes: 99 }],
    ["resized.csv", { mtime: since + 6, bytes: 11 }],
    ["legacy.png", { mtime: null, bytes: 5 }],
    ["legacy2.png", { mtime: null, bytes: 5 }],
  ]);
  assert.deepEqual(pickSessionOutputs(files, known, { sinceMs: since }),
    ["newest.pptx", "new-a.md", "new-b.md", "legacy2.png", "resized.csv", "changed.pdf"]);
  assert.deepEqual(pickSessionOutputs(files, known, { sinceMs: since, limit: 2 }), ["newest.pptx", "new-a.md"], "P7 상한 — 가장 최근 것부터");
  assert.deepEqual(pickSessionOutputs(files, known, { sinceMs: since, limit: 0 }), [], "P7 상한 0");
  assert.equal(MAX_PER_SWEEP, 50);
  assert.deepEqual(pickSessionOutputs([F("/a/b.md", since)], new Map(), { sinceMs: since }), ["a/b.md"], "경로는 정규화해 돌려준다(맨 앞 '/')");
  assert.deepEqual(pickSessionOutputs([F("./a/b.md", since)], new Map(), { sinceMs: since }), [], "'.' 칸은 숨김 규칙이 버린다(매니페스트는 이런 꼴을 안 만든다)");
  assert.deepEqual(pickSessionOutputs([F("x.md", Number.NaN)], new Map(), { sinceMs: since }), [], "시각을 모르는 파일은 고르지 않는다");
  assert.deepEqual(pickSessionOutputs([F("sub/a.md", since), F("sub2/b.md", since + 1), F("sub", since + 2), F("c.md", since + 3)], new Map(),
    { sinceMs: since, skipDirs: ["sub/"] }), ["c.md", "sub2/b.md"], "P8 안쪽 프로젝트 폴더 제외('/' 경계 — sub2 는 남는다)");
});

// ── 같은 상태인가(P4·P5의 판정 자체) ─────────────────────────────────────────────
//  | 행 시각 | 행 크기 | 파일과            | 같은가 |
//  | 같음    | 같음    |                   | 예 |
//  | 다름    | 같음    |                   | 아니오 |
//  | 같음    | 다름    |                   | 아니오 |
//  | null    | 같음    | (옛 매니지드 행)   | 예 |
//  | null    | 다름    |                   | 아니오 |
//  | 같음    | null    | (크기 없는 옛 행)  | 예 |
//  | null    | null    | (아무것도 모름)    | 예 — 모르는 것 때문에 되살리지 않는다 |
//  | 행 없음 |         |                   | 아니오 |
test("같은 상태 판정 — 행이 모르는 값(null)은 비교하지 않는다", () => {
  const f = { mtime: 100, size: 10 };
  assert.equal(sameOutputState({ mtime: 100, bytes: 10 }, f), true);
  assert.equal(sameOutputState({ mtime: 99, bytes: 10 }, f), false);
  assert.equal(sameOutputState({ mtime: 100, bytes: 11 }, f), false);
  assert.equal(sameOutputState({ mtime: null, bytes: 10 }, f), true);
  assert.equal(sameOutputState({ mtime: null, bytes: 11 }, f), false);
  assert.equal(sameOutputState({ mtime: 100, bytes: null }, f), true);
  assert.equal(sameOutputState({ mtime: null, bytes: null }, f), true);
  assert.equal(sameOutputState(undefined, f), false);
});

// ── W 기록 범위(#1291 v2) ─────────────────────────────────────────────────────────
//  | #  | 세션 기록 범위 | 프로젝트            | 막나 |
//  | W1 | open          | 어떤 것이든          | 아니오 |
//  | W2 | audience      | 대상을 좁히지 않음    | 예 |
//  | W3 | private       | 대상을 좁히지 않음    | 예 |
//  | W4 | private       | 대상을 좁힘          | 아니오(좁은 곳에 다는 건 넓히는 게 아니다) |
test("W1~W4 좁혀진 세션은 대상을 좁히지 않은 프로젝트에 자동 등록하지 않는다 — 작업기록과 같은 판정", () => {
  assert.equal(capBlocks("open", true), false, "W1");
  assert.equal(capBlocks("open", false), false, "W1");
  assert.equal(capBlocks("audience", true), true, "W2");
  assert.equal(capBlocks("private", true), true, "W3");
  assert.equal(capBlocks("private", false), false, "W4");
  assert.equal(capBlocks("audience", false), false, "W4");
});

// ── S 이 세션을 훑나 ─────────────────────────────────────────────────────────────
//  | #  | 세션                                                   | 훑나 |
//  | S1 | 프로젝트 없음 / project_id 0                            | 아니오(개인 폴더는 그 사람 것) |
//  | S2 | 읽기전용 · 인코그니토                                    | 아니오 |
//  | S3 | 공유 루트 밖(root_key personal)                          | 아니오 |
//  | S4 | 프로젝트 폴더를 모름                                     | 아니오 |
//  | S5 | 프로젝트 폴더 그 자리 · 그 안(워크트리 하위)              | 예 |
//  | S6 | 다른 폴더(이름이 접두로 겹치는 project/12 vs project/123) | 아니오 |
const ST = (o: Partial<Parameters<typeof sweepTarget>[0] & object> = {}) => ({
  project_id: 123, root_key: "shared", subpath: "project/123", read_only: false, incognito: false, ...o,
});
test("S1~S6 턴 끝에 훑을 세션 — 프로젝트 폴더에서 도는, 기록을 남기는 세션만", () => {
  assert.equal(sweepTarget(null, "project/123"), false, "S1 세션 없음");
  assert.equal(sweepTarget(ST({ project_id: null }), "project/123"), false, "S1");
  assert.equal(sweepTarget(ST({ project_id: 0 }), "project/123"), false, "S1 0");
  assert.equal(sweepTarget(ST({ read_only: true }), "project/123"), false, "S2 읽기전용");
  assert.equal(sweepTarget(ST({ incognito: true }), "project/123"), false, "S2 인코그니토");
  assert.equal(sweepTarget(ST({ root_key: "personal" }), "project/123"), false, "S3");
  assert.equal(sweepTarget(ST({ root_key: null }), "project/123"), false, "S3 null");
  assert.equal(sweepTarget(ST(), null), false, "S4");
  assert.equal(sweepTarget(ST(), ""), false, "S4 빈 값");
  assert.equal(sweepTarget(ST(), "project/123"), true, "S5 그 자리");
  assert.equal(sweepTarget(ST({ subpath: "project/123/lively" }), "project/123"), true, "S5 그 안");
  assert.equal(sweepTarget(ST({ subpath: "/project/123/" }), "/project/123"), true, "S5 앞뒤 '/' 무시");
  assert.equal(sweepTarget(ST({ subpath: "project/1234" }), "project/123"), false, "S6 접두만 겹친다");
  assert.equal(sweepTarget(ST({ subpath: "project/9" }), "project/123"), false, "S6 다른 폴더");
});

// ── C 한 번에 하나 ─────────────────────────────────────────────────────────────────
//  | #  | 상황                                                     | 기대 |
//  | C1 | 훑는 중에 다른 세션이 같은 프로젝트에서 턴을 끝냈다         | 같은 약속을 받고, 앞 훑기가 끝나면 **그 세션 정보로** 한 번 더 |
//  | C2 | 다른 프로젝트                                             | 서로 기다리지 않는다 |
//  | C3 | 훑는 중에 같은 세션이 세 번 턴을 끝냈다                     | 다시 훑기는 한 번 |
//  | C4 | 훑기가 실패했다                                           | 던지지 않는다 · 대기한 세션은 그래도 훑는다 |
//  | C5 | 읽기전용 · 인코그니토 · 프로젝트 없음                       | 훑기를 부르지도 않는다 |
//  | C6 | 훑는 중에 여러 세션이 턴을 끝냈다                           | 그 묶음은 매니페스트를 한 번만(같은 shared) — 세션마다 제 정보로 |
//  | C7 | 훑기가 첫 await 전에 동기로 던졌다                          | null · 그 프로젝트가 «영원히 도는 중» 으로 남지 않는다 |
const SS = (id: string, o: Partial<SweepSession> = {}): SweepSession => ({
  id, owner: "u", project_id: 7, root_key: "shared", subpath: "project/7", read_only: false, incognito: false, created: 1, ...o,
});
const REP: SweepReport = { scanned: 0, picked: 0, ingested: 0, skipped: 0, truncated: false };
// 부를 때마다 MIN_INTERVAL 이 지난 것으로 — 최소 간격을 실제로 기다리지 않게
const clockOf = () => { let t = 1_000_000; return () => (t += MIN_INTERVAL_MS + 1); };
function gated() {
  const calls: string[] = [];
  const gates: Array<() => void> = [];
  const once = (st: SweepSession) => { calls.push(st.id); return new Promise<SweepReport>((r) => gates.push(() => r(REP))); };
  const release = async () => { for (let i = 0; i < 20 && !gates.length; i++) await new Promise((r) => setImmediate(r)); gates.shift()?.(); };
  return { calls, once, release };
}

test("C1 · C3 훑는 중 턴이 끝난 세션은 대기 — 앞 것이 끝나면 각자 제 정보로 한 번씩", async () => {
  resetSessionOutputSweeps();
  const g = gated(); const now = clockOf();
  const a = sweepSessionOutputs(SS("s1"), now, g.once);
  const b = sweepSessionOutputs(SS("s2"), now, g.once);
  const b2 = sweepSessionOutputs(SS("s2"), now, g.once);
  const b3 = sweepSessionOutputs(SS("s2"), now, g.once);
  assert.equal(a, b, "C1 같은 약속");
  assert.equal(b, b2); assert.equal(b2, b3);
  await g.release();                       // s1 끝
  await g.release();                       // s2 다시 훑기 끝
  await a;
  assert.deepEqual(g.calls, ["s1", "s2"], "C1 대기한 세션을 제 정보로 · C3 같은 세션은 한 번만");
});

test("C2 다른 프로젝트는 서로 기다리지 않는다", async () => {
  resetSessionOutputSweeps();
  const g = gated(); const now = clockOf();
  const a = sweepSessionOutputs(SS("s1", { project_id: 7 }), now, g.once);
  const b = sweepSessionOutputs(SS("s9", { project_id: 8, subpath: "project/8" }), now, g.once);
  assert.notEqual(a, b);
  for (let i = 0; i < 20 && g.calls.length < 2; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(g.calls.sort(), ["s1", "s9"], "둘 다 이미 돌고 있다");
  await g.release(); await g.release(); await Promise.all([a, b]);
});

test("C4 훑기가 실패해도 던지지 않고, 대기한 세션은 그래도 훑는다", async () => {
  resetSessionOutputSweeps();
  const calls: string[] = []; const now = clockOf();
  let open!: () => void; const gate = new Promise<void>((r) => { open = r; });
  const once = async (st: SweepSession) => { calls.push(st.id); if (st.id === "s1") { await gate; throw new Error("폴더 못 읽음"); } return REP; };
  const a = sweepSessionOutputs(SS("s1"), now, once);
  void sweepSessionOutputs(SS("s2"), now, once);
  open();
  assert.deepEqual(await a, REP, "마지막 훑기(s2)의 보고");
  assert.deepEqual(calls, ["s1", "s2"]);
});

test("C5 기록을 남기지 않는 세션 · 프로젝트 없는 세션은 훑기를 부르지 않는다", async () => {
  resetSessionOutputSweeps();
  let n = 0; const once = async () => { n++; return REP; };
  assert.equal(await sweepSessionOutputs(SS("r", { read_only: true }), Date.now, once), null);
  assert.equal(await sweepSessionOutputs(SS("i", { incognito: true }), Date.now, once), null);
  assert.equal(await sweepSessionOutputs(SS("p", { project_id: null }), Date.now, once), null);
  assert.equal(n, 0);
});

test("C6 훑는 중에 턴을 끝낸 세션들은 한 묶음 — 매니페스트를 한 번만 읽는다", async () => {
  resetSessionOutputSweeps();
  const seen: Array<[string, SweepShared]> = []; const now = clockOf();
  let open!: () => void; const gate = new Promise<void>((r) => { open = r; });
  const once = async (st: SweepSession, _n: () => number, shared: SweepShared) => {
    seen.push([st.id, shared]);
    if (st.id === "s1") await gate;
    return REP;
  };
  const a = sweepSessionOutputs(SS("s1"), now, once);
  void sweepSessionOutputs(SS("s2"), now, once);
  void sweepSessionOutputs(SS("s3"), now, once);
  void sweepSessionOutputs(SS("s4"), now, once);
  open(); await a;
  assert.deepEqual(seen.map(([id]) => id), ["s1", "s2", "s3", "s4"]);
  assert.notEqual(seen[0][1], seen[1][1], "앞 훑기와 대기 묶음은 다른 매니페스트(그 사이 생긴 파일을 봐야 한다)");
  assert.equal(seen[1][1], seen[2][1], "대기 묶음은 한 매니페스트");
  assert.equal(seen[2][1], seen[3][1]);
});

test("C7 훑기가 동기로 던져도 그 프로젝트가 막히지 않는다", async () => {
  resetSessionOutputSweeps();
  const now = clockOf();
  const bad = ((): Promise<SweepReport | null> => { throw new Error("동기 예외"); }) as unknown as (st: SweepSession) => Promise<SweepReport | null>;
  assert.equal(await sweepSessionOutputs(SS("s1"), now, bad), null);
  let n = 0;
  assert.deepEqual(await sweepSessionOutputs(SS("s1"), now, async () => { n++; return REP; }), REP, "다음 턴은 정상으로 돈다");
  assert.equal(n, 1);
});

// ── 배선 ──────────────────────────────────────────────────────────────────────────
test("배선 — 중앙 세션의 턴 끝(idle) 보고가 훑기를 부른다 · 노드 갈래는 부르지 않는다(project-push 훅이 올린다)", () => {
  const R = read("../terminal/routes.ts");
  const route = R.slice(R.indexOf('app.post("/api/ui/terminal/sessions/:id/active"'), R.indexOf('app.post("/api/ui/terminal/sessions/:id/last-prompt"'));
  assert.ok(route.length > 0, "활동 보고 라우트를 못 찾았다");
  const central = route.slice(route.indexOf("if (st && !stNodeId) {"), route.indexOf("if (st && stNodeId && st.owner !== me)"));
  assert.match(central, /if \(phase === "idle"\) void sweepSessionOutputs\(st\);\s*\n\s*res\.json\(\{ ok: true \}\);\s*\n\s*return;/,
    "중앙 갈래가 턴 끝에 결과물을 훑지 않는다(또는 응답 뒤로 밀렸다)");
  const node = route.slice(route.indexOf("if (st && stNodeId && st.owner !== me)"));
  assert.doesNotMatch(node, /sweepSessionOutputs/, "노드 세션까지 훑는다 — 노드 파일은 게이트웨이가 못 본다(훅이 올린다)");
  assert.match(R, /import \{ sweepSessionOutputs \} from "\.\.\/ingest\/session-outputs\.js";/);
});

test("배선 — 기록 범위 판정이 등록보다 먼저다 · 작업기록과 같은 조회(sessionWriteCap · hiddenProjects(PUBLIC_VIEWER))", () => {
  const M = read("./session-outputs.ts");
  const body = M.slice(M.indexOf("async function sweepOnce("), M.indexOf("async function capBlocksSession("));
  assert.ok(body.indexOf("capBlocksSession(st.id, project.id)") > 0 && body.indexOf("capBlocksSession(st.id, project.id)") < body.indexOf("ingestLocalUpload({"),
    "기록 범위 판정 없이(또는 등록 뒤에) 등록한다");
  const fn = M.slice(M.indexOf("async function capBlocksSession("));
  assert.match(fn, /sessionWriteCap\(sessionId\)/);
  assert.match(fn, /hiddenProjects\(PUBLIC_VIEWER\)/);
});

test("배선 — 멤버 저장소 파일의 시각은 멤버 경계가 잰 값으로(매니지드 자료 행 occurred_at 이 비던 것)", () => {
  const L = read("./local-file.ts");
  const fn = L.slice(L.indexOf("async function statOf("), L.indexOf("async function readHead("));
  assert.match(fn, /typeof st\.mtime === "number" && Number\.isFinite\(st\.mtime\) && st\.mtime > 0\s*\n?\s*\? new Date\(st\.mtime\)\.toISOString\(\)/,
    "멤버 stat 의 mtime 을 안 쓴다 — 매니지드에선 게이트웨이 stat 이 늘 실패해 «이미 있나» 판정이 매 턴 다시 등록한다");
});

test("안내 — 프로젝트 AGENTS.md 에 «결과물은 이 프로젝트 폴더 안에» 절이 실린다(등록 장치와 같은 배포)", () => {
  const A = read("../v6/agents-md.ts");
  assert.match(A, /"## 결과물 파일"/);
  assert.match(A, /이 프로젝트 폴더 안에/);
  assert.match(A, /바탕화면·홈·\/tmp/);
  assert.match(A, /L\.push\(OUTPUTS_RULE, ""\);\s*\n\s*L\.push\(SESSION_TASK_RULE, ""\);/, "digest 에 안 싣는다");
});
