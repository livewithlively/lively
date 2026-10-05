// #4551 — 위탁 워커 줄 = 리브가 한 일 (원준 2026-10-05).
//
//  사양(행위):
//   · 위탁 워커는 제 소속 프로젝트가 있으면 거기, 없으면 **시킨 세션의 프로젝트** 아래에 선다.
//   · 설 프로젝트가 없는 워커(예약 작업 · 기록이 없던 때의 위탁 · 시킨 세션에 프로젝트가 없음)는 「리브가 한 일」 묶음에 선다.
//     사람이 연 세션은 그 묶음에 안 들어가고, 워커는 「기타 (미분류)」에 안 들어간다.
//   · 줄은 리브 그림 · 이름은 `위탁 #N` 대신 «리브 작업 #N»(누가 지은 이름이 있으면 그 이름) · 둘째 줄이 누가 넘긴 일인지.
//   · 서버가 표식을 안 실으면(옛 서버) 화면은 종전 그대로다.
//
//  엣지 표.
//   T1 표식 읽기 — 온전한 표식 → 그대로 / 번호 문자열도 숫자로
//   T2 표식 아님 — null · undefined · 문자열 · 빈 객체 · 번호 0 · 음수 · NaN → null
//   T3 칸 다듬기 — 빈 문자열 · 공백 이름은 null / originProject 0 · 음수 · 문자열 쓰레기는 null
//   P1 제 소속이 있으면 그것(표식의 프로젝트와 달라도) / P2 없고 표식에 프로젝트 → 그 프로젝트
//   P3 없고 표식도 프로젝트 없음 → null / P4 표식 없음(사람 세션) → 제 소속 그대로(0 · null · undefined → null)
//   K1 시킨 프로젝트를 화면이 모르면 그리로 안 세운다 / K2 제 소속은 몰라도 그대로
//   S1 ★ 설 자리(standId)만 적고 **소속(projectId)은 안 바꾼다**(보관 · 휴지통 · 세션 화면은 소속으로 행동한다) / S2~S4 사이드바가 세울 프로젝트
//   B1 「리브가 한 일」 줄 = 워커 ∧ 설 프로젝트 없음 / 설 자리 있으면 아님 / 사람 세션은 프로젝트 없어도 아님 / B2 설 자리 미기입
//   N1 이름 — `위탁 #41` · `위탁 #t501ac` · 빈 이름 · 공백 → «리브 작업 #N» / N2 누가 지은 이름은 그대로(«위탁 결과 정리» 같은 사람 이름 포함)
//   M1 둘째 줄 — 예약 작업 / M2 시킨 세션 이름 있음 / M3 둘 다 없음 / M4 크론이면서 이름이 있어도 예약 작업이 앞선다
//   C1 카드 나누기 — 프로젝트 없는 줄: 워커는 'liv' 카드, 사람 세션은 'p:0' 카드(둘이 안 섞인다)
//   C2 프로젝트 있는 워커 줄은 그 프로젝트 카드로(liv 표식이 있어도 프로젝트가 이긴다)
//   C3 리브 카드의 「지금 볼 것」 조각 = 'now:liv' · 나머지 = 'liv' · 접힘은 한 장만
//   C4 워커 줄이 하나도 없으면 리브 카드가 안 선다(종전 그대로)
//   F1 접힘 재료 거르개 — 주면 그 술어를 지나는 것만 / 안 주면 전부(종전 그대로) / 휴지통 · 이미 선 것 제외는 그대로
//   F2 접힘은 설 자리로 묶는다 — 시킨 프로젝트 카드가 끝난 워커를 든다 · 사람 세션은 소속으로만
//   R1~R6 런타임(실제 side.ts) — 아래
//   W1~W4 배선
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const root = path.resolve(import.meta.dirname, "..");
const read = (p) => { try { return readFileSync(path.join(root, p), "utf8"); } catch { return ""; } };
const code = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\s\/\/\s.*$/, "")).join("\n");
let pass = 0, fail = 0;
const ok = (cond, name, why = "") => { if (cond) { pass++; console.log(`ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}${why ? " — " + why : ""}`); } };
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), name, `got ${JSON.stringify(got)}`);

let L = null, P = null, F = null;
try {
  const out = mkdtempSync(path.join(tmpdir(), "liv-work-"));
  execFileSync(path.join(root, "node_modules/.bin/tsc"),
    ["web/lib/liv-work.ts", "web/lib/home-pins.ts", "web/lib/sess-fold.ts"].map((f) => path.join(root, f)).concat(["--rootDir", path.join(root, "web"), "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"]), { stdio: "ignore" });
  L = await import(path.join(out, "lib/liv-work.js")); P = await import(path.join(out, "lib/home-pins.js")); F = await import(path.join(out, "lib/sess-fold.js"));
} catch { /* V0 가 빨간불 */ }
ok(!!L && !!P && !!F, "V0 잣대가 잎 모듈(lib/liv-work · home-pins · sess-fold)에 있다");

if (L && P && F) {
  const { taskMarkOf, standingProjectId, sideProjectId, placeLivWork, isLooseLivWork, livWorkName, livWorkNote, LIV_BUCKET_NAME, LIV_CARD } = L;
  const full = { id: 41, originSession: "box-a-12345678", originLabel: "결제 백오프", originProject: 4551, cron: null };
  eq(taskMarkOf(full), full, "T1 온전한 표식은 그대로 읽는다");
  eq(taskMarkOf({ id: "41" }), { id: 41, originSession: null, originLabel: null, originProject: null, cron: null }, "T1 번호 문자열도 숫자로 · 빠진 칸은 null");
  ok([null, undefined, "task", 7, {}, { id: 0 }, { id: -3 }, { id: "x" }].every((v) => taskMarkOf(v) === null), "T2 ★ 표식이 아니면 null — 옛 서버의 행은 종전 그대로 선다");
  eq(taskMarkOf({ id: 1, originSession: "", originLabel: "   ", originProject: 0, cron: "" }), { id: 1, originSession: null, originLabel: null, originProject: null, cron: null }, "T3 빈 문자열 · 공백 · 0 은 null");
  eq([taskMarkOf({ id: 1, originProject: -5 }).originProject, taskMarkOf({ id: 1, originProject: "abc" }).originProject, taskMarkOf({ id: 1, originProject: "12" }).originProject], [null, null, 12], "T3 프로젝트 번호 — 음수 · 쓰레기는 null, 숫자 문자열은 숫자");

  eq(standingProjectId(7, full), 7, "P1 ★ 제 소속이 이긴다(사람이 그 워커를 옮겼으면 그 결정이 앞선다)");
  eq(standingProjectId(null, full), 4551, "P2 ★★ 제 소속이 없는 워커는 시킨 세션의 프로젝트 아래에 선다");
  eq([standingProjectId(0, full), standingProjectId(undefined, full), standingProjectId("", full)], [4551, 4551, 4551], "P2 0 · undefined · 빈 값도 «없음» 이다");
  eq(standingProjectId(null, { ...full, originProject: null }), null, "P3 표식에도 프로젝트가 없으면 null");
  eq([standingProjectId(9, null), standingProjectId(0, null), standingProjectId(null, null), standingProjectId(undefined, null), standingProjectId("12", null)], [9, null, null, null, 12], "P4 사람 세션은 제 소속 그대로");

  //  K — 아는 프로젝트일 때만 그리로 세운다(지워졌거나 못 보는 프로젝트의 카드는 서지 않는다).
  eq([standingProjectId(null, full, new Set([4551])), standingProjectId(null, full, new Set([1, 2])), standingProjectId(null, full, new Set())], [4551, null, null],
    "K1 ★★ 시킨 프로젝트를 화면이 모르면(지워짐 · 못 봄) 그리로 세우지 않는다 — 어느 카드에도 못 서는 줄을 만들지 않는다");
  eq(standingProjectId(7, full, new Set()), 7, "K2 제 소속은 화면이 몰라도 그대로다(소속은 사실이다)");

  //  S — 설 자리와 소속은 다른 칸이다.
  const ws = [{ id: "w", projectId: null, task: full }, { id: "x", projectId: null, task: { ...full, originProject: 99 } }, { id: "o", projectId: 3, task: full }, { id: "h", projectId: 8 }, { id: "n", projectId: null }];
  placeLivWork(ws, new Set([4551, 3, 8]));
  eq(ws.map((s) => [s.id, s.projectId, s.standId]), [["w", null, 4551], ["x", null, null], ["o", 3, 3], ["h", 8, undefined], ["n", null, undefined]],
    "S1 ★★ 설 자리(standId)만 적는다 — **소속(projectId)은 안 바뀐다**. 사람 세션은 안 건드린다");
  eq(ws.map(sideProjectId), [4551, 0, 3, 8, 0], "S2 사이드바가 세울 프로젝트 — 워커는 설 자리, 사람 세션은 소속, 없으면 0");
  eq(sideProjectId({ projectId: 5, task: full }), 5, "S3 설 자리를 아직 안 적은 워커(낱개로 받은 줄)는 소속으로 떨어진다");
  eq(sideProjectId({ projectId: 5, standId: 77 }), 5, "S4 워커가 아니면 standId 를 안 본다(사람 세션의 자리는 소속뿐이다)");

  eq(ws.map(isLooseLivWork), [false, true, false, false, false], "B1 ★ 「리브가 한 일」 줄 = 워커 ∧ 설 프로젝트 없음 — 설 자리가 있는 워커 · 사람 세션(프로젝트가 없어도)은 아니다");
  eq([isLooseLivWork({ projectId: null, task: full }), isLooseLivWork({ projectId: 0, task: full }), isLooseLivWork({ task: full }), isLooseLivWork({ projectId: 4551, task: full })], [true, true, true, false],
    "B2 설 자리를 아직 안 적은 워커는 소속으로 가른다");

  eq(["위탁 #41", "위탁 #t501ac", "위탁#7", "", "   ", null, undefined].map((l) => livWorkName(l, full)), Array(7).fill("리브 작업 #41"), "N1 기계가 붙인 이름 · 빈 이름 → «리브 작업 #N»");
  eq(["코어 배포", "위탁 결과 정리", "위탁 #41 재시도 건", "주간 집계 #3"].map((l) => livWorkName(l, full)), ["코어 배포", "위탁 결과 정리", "위탁 #41 재시도 건", "주간 집계 #3"], "N2 ★ 누가 지은 이름은 그대로 — 그 낱말로 시작할 뿐인 이름을 덮지 않는다");
  eq(livWorkNote({ ...full, originLabel: null, cron: "weekly" }), "리브가 대신 처리 · 예약 작업", "M1 예약 작업");
  eq(livWorkNote(full), "리브가 대신 처리 · 결제 백오프에서 시작", "M2 시킨 세션 이름이 있으면 어디서 시작했는지");
  eq(livWorkNote({ ...full, originLabel: null }), "리브가 대신 처리", "M3 둘 다 모르면 사실만");
  eq(livWorkNote({ ...full, cron: "weekly" }), "리브가 대신 처리 · 예약 작업", "M4 예약 작업이 앞선다");
  ok(LIV_BUCKET_NAME === "리브가 한 일" && LIV_CARD === "liv", "N0 묶음 이름 · 카드 키");

  const { planNowCards } = P;
  const NOW = "지금 볼 것";
  const R = (id, o = {}) => ({ id, pinned: false, project: null, group: "오늘", ...o });
  const shape = (cs) => cs.map((c) => [c.key, c.pkey, c.id, c.liv, c.fold, c.rows.map((r) => r.id)]);
  eq(shape(planNowCards([R("h1"), R("w1", { liv: true }), R("h2"), R("w2", { liv: true })], () => false, NOW)),
    [["p:0", "p:0", 0, false, true, ["h1", "h2"]], ["liv", "liv", 0, true, true, ["w1", "w2"]]], "C1 ★★ 프로젝트 없는 줄 — 워커는 리브 카드, 사람 세션은 「기타」 카드. 둘이 안 섞인다");
  eq(shape(planNowCards([R("w", { liv: true, project: { id: 5 } }), R("s", { project: { id: 5 } })], () => false, NOW)),
    [["p:5", "p:5", 5, false, true, ["w", "s"]]], "C2 ★ 프로젝트가 있는 줄은 그 프로젝트 카드로 — liv 표식이 있어도 프로젝트가 이긴다");
  eq(shape(planNowCards([R("wn", { liv: true, group: NOW }), R("w1", { liv: true }), R("hn", { group: NOW }), R("h1")], () => false, NOW)),
    [["now:liv", "liv", 0, true, false, ["wn"]], ["liv", "liv", 0, true, true, ["w1"]], ["now:p:0", "p:0", 0, false, false, ["hn"]], ["p:0", "p:0", 0, false, true, ["h1"]]],
    "C3 리브 카드도 같은 규칙으로 나뉜다 — 조각 'now:liv' · 나머지 'liv' · 접힘은 한 장만");
  ok(planNowCards([R("a"), R("b", { project: { id: 2 } })], () => false, NOW).every((c) => c.liv === false && c.pkey !== "liv"), "C4 워커 줄이 없으면 리브 카드가 안 선다");

  const { projectPastRows } = F;
  const S = (id, o = {}) => ({ id, projectId: null, lastSeen: 1, ...o });
  const all = [S("h1"), S("w1", { task: full }), S("h2", { lastSeen: 5 }), S("w2", { task: full, lastSeen: 9 }), S("t", { task: full, trashedAt: "2026-10-01" }), S("p", { projectId: 3 })];
  const ids = (r) => r.rows.map((x) => x.id);
  eq([ids(projectPastRows(all, 0, new Set(), 12, (s) => isLooseLivWork(s))), ids(projectPastRows(all, 0, new Set(), 12, (s) => !isLooseLivWork(s)))], [["w2", "w1"], ["h2", "h1"]],
    "F1 ★★ 거르개를 주면 그 술어를 지나는 것만 — 워커와 사람 세션이 서로의 접힘에 안 들어간다(휴지통은 여전히 빠진다)");
  eq(ids(projectPastRows(all, 0, new Set(), 12)), ["w2", "h2", "h1", "w1"], "F1 거르개를 안 주면 전부(종전 그대로)");
  eq(ids(projectPastRows(all, 0, new Set(["w2"]), 12, (s) => isLooseLivWork(s))), ["w1"], "F1 이미 줄로 선 것은 거르개와 무관하게 빠진다");
  const placed = [S("pw", { task: full, standId: 4551 }), S("ph", { projectId: 4551 }), S("lw", { task: full, standId: null }), S("hx", { projectId: 4551, standId: 1 })];
  eq([ids(projectPastRows(placed, 4551, new Set(), 12)).sort(), ids(projectPastRows(placed, 0, new Set(), 12)), ids(projectPastRows(placed, 1, new Set(), 12))], [["hx", "ph", "pw"], ["lw"], []],
    "F2 ★★ 접힘은 «설 자리» 로 묶는다 — 시킨 프로젝트의 카드가 끝난 워커를 들고, 사람 세션은 소속으로만 묶인다(standId 를 안 본다)");
}

// ───────────────────────── W. 배선 ─────────────────────────
const VIEWS = code(read("web/v2/views.ts")), MAIN = code(read("web/v2/main.ts")), SIDE = code(read("web/v2/side.ts"));
ok(/projectId: r\.projectId \? Number\(r\.projectId\) : null,\s*task: taskMarkOf\(r\.task\),/.test(VIEWS) && !/standingProjectId/.test(VIEWS),
  "W1 ★★ 세션을 짤 때 표식만 읽는다 — **소속(projectId)은 서버가 준 그대로다**(파생값으로 덮으면 보관 · 휴지통이 워커를 건드린다)");
ok(/placeLivWork\(sessions, new Set\(projects\.map\(\(p\) => Number\(p\.id\)\)\)\);/.test(MAIN)
  && /const base = projectPath\(worker && worker\.task \? sideProjectId\(worker\) : projectIdForRoute\(route\)\);/.test(MAIN),
  "W1b 셸이 설 자리를 적고(아는 프로젝트만), 홈 줄의 프로젝트는 설 자리로 정한다");
//  소속으로 **행동**하는 자리는 설 자리를 안 쓴다 — 프로젝트 보관 · 휴지통 · 프로젝트 화면의 세션 목록.
const destructive = [/function setArchived\(/, /function trashProject\(/].map((re) => { const m = re.exec(SIDE); return m ? SIDE.slice(m.index, m.index + 1800) : ""; });
ok(destructive.every((b) => b.length > 0 && !/sideProjectId|standId/.test(b)) && /Number\(s\.projectId\) === p\.id/.test(destructive.join("\n")),
  "W1c ★★ 프로젝트 보관 · 휴지통은 소속(projectId)으로만 세션을 고른다 — 설 자리를 안 본다(워커를 끄지 않는다)");
ok(/if \(s && s\.task\) \{ icon = 'liv'; ask = livWorkNote\(s\.task\); livTitle = livWorkName\(s\.label, s\.task\); liv = isLooseLivWork\(s\);/.test(MAIN)
  && /title: \(!page \|\| page === 'dashboard'\) \? '새 작업' : \(livTitle \|\| info\.title\)/.test(MAIN) && /owner, ask, liv \};/.test(MAIN),
  "W2 홈 줄 얼굴 — 워커는 리브 그림 · 이름 · 둘째 줄 · 묶음 표식을 싣는다");
ok(/const sid = sideProjectId\(s\);\s*const p = sid \? last!\.data\.projects\.find\(\(x\) => x\.id === sid\) : null;/.test(SIDE) && /title: mark \? livWorkName\(s\.label, mark\) : t\.main,/.test(SIDE) && /icon: mark \? 'liv' : 'chat',/.test(SIDE) && /liv: isLooseLivWork\(s\),/.test(SIDE),
  "W3 카드 접힘 안의 줄(sessAsInst)도 같은 얼굴이다 — 홈 줄과 접힌 줄이 다른 말을 하지 않는다");
ok(/c\.liv \? LIV_BUCKET_NAME : NO_PROJECT_NAME/.test(SIDE) && /g\.id \? undefined : \(s\) => isLooseLivWork\(s\) === g\.liv\)/.test(SIDE) && /glyph\(g\.id \? 'proj' : g\.liv \? 'liv' : 'projNone', 'v2-pg-ic'\)/.test(SIDE),
  "W4 ★ 카드 — 리브 묶음 이름 · 리브 그림 · 접힘 재료를 둘로 가른다(프로젝트 카드는 거르지 않는다)");

// ───────────────────────── R. 런타임 — 실제 side.ts 를 크롬에서 ─────────────────────────
//   R1 프로젝트 없는 워커 줄은 「리브가 한 일」 카드에, 사람 세션은 「기타 (미분류)」 카드에 선다
//   R2 리브 카드엔 압정 · ＋ · [→] 가 없다(프로젝트가 아니다)
//   R3 워커 줄은 리브 그림(다른 줄과 다른 그림)이다
//   R4 접힘 — 리브 카드의 「지난 세션」엔 끝난 워커만, 「기타」 카드엔 끝난 사람 세션만
//   R5 시킨 프로젝트가 있는 워커는 그 프로젝트 카드 안에 선다
//   R6 배선 — 카드가 실제로 그려졌다(R1 이 빈 화면에서 초록이 되지 않게)
const chrome = findChrome();
const ESBUILD = path.join(root, "node_modules/.bin/esbuild");
if (!chrome || !existsSync(ESBUILD)) console.log("skip  크롬 · esbuild 가 없어 런타임 절을 건너뜁니다");
else {
  const SRC = process.env.SIDE_SRC || path.join(root, "web/v2/side.ts");
  const bundle = execFileSync(ESBUILD, [SRC, "--bundle", "--format=iife", "--global-name=Side", "--platform=browser", "--log-level=error"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const CSS = ["01-base.css", "40-v2.css", "47-v2-rail.css"].map((f) => read("public/styles/" + f)).join("\n");
  const PAGE = `<!doctype html><html data-theme="light"><meta charset="utf-8"><style>${CSS.replace(/<\/style/gi, "<\\/style")}
  html,body{margin:0} #v2-root{display:block} .v2-side{width:300px;height:900px}</style>
<div id="v2-root"><nav class="v2-side stu-side"><div class="stu-panel"><div class="stu-panel-tree" id="host"></div></div></nav></div><pre id="out">PENDING</pre>
<script>${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>
(async function(){
  const R = {}; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const host = document.getElementById('host');
    let t = 1700000000000;
    //  main.ts sideRowFace 가 만드는 줄 모양 그대로 — 워커 줄은 icon 'liv' · liv 표식.
    const row = (id, o) => Object.assign({ id: 'sess:' + id, title: 'ROW-' + id, active: false, icon: 'chat', meta: 'AI', project: null, owner: null, ask: null,
      pinned: false, past: false, status: null, group: 'TODAY-GROUP', rank: 9, at: t-- }, o || {});
    const rows = [row('h1'), row('w1', { icon: 'liv', liv: true }), row('w5', { icon: 'liv', project: { id: 5, name: 'PROJ-5' } }), row('s5', { project: { id: 5, name: 'PROJ-5' } })];
    const mark = { id: 9, originSession: null, originLabel: null, originProject: null, cron: 'weekly' };
    const sess = (id, o) => Object.assign({ id, label: 'PAST-' + id, projectId: null, node: null, live: false, alive: false, owned: true, stateKey: 'offline', stateLabel: 'x', lastSeen: 1600000000000, raw: {} }, o || {});
    const data = { projects: [{ id: 5, name: 'PROJ-5' }], lists: [], folders: [], loadedAt: 1700000000000,
      sessions: [sess('pw1', { task: mark, label: '위탁 #9' }), sess('pw2', { task: mark, label: '위탁 #9' }), sess('ph1')] };   // worker default label
    const hooks = { section: () => 'home', instances: () => rows, navHost: () => null, railHidden: () => false };
    Side.drawSide(host, data, () => '', hooks); await sleep(40);
    const axis = host.querySelector('.v2-axisbtn'); if (!axis) throw new Error('no axis button');
    axis.click(); await sleep(40);
    const card = (anch) => host.querySelector('.v2-pg[data-anch="' + anch + '"]');
    const open = async (anch) => { const c = card(anch); if (c && !c.classList.contains('open')) { c.querySelector('.v2-pg-t').click(); await sleep(40); } };
    const past = async (anch) => { const b = card(anch) && card(anch).querySelector('.v2-pg-past'); if (b && !b.classList.contains('open')) { b.click(); await sleep(40); } };
    for (const a of ['liv', 'p:0', 'p:5']) { await open(a); await past(a); }
    const snap = (anch) => { const c = card(anch); if (!c) return null;
      const d = (n) => { const p = n && n.querySelector('path'); return p ? p.getAttribute('d') : null; };
      return { name: (c.querySelector('.v2-pg-row .n') || {}).textContent || '', pin: !!c.querySelector('.v2-pg-row .v2-pinb'), plus: !!c.querySelector('.v2-pg-row .v2-newb:not(.v2-openb)'), go: !!c.querySelector('.v2-pg-row .v2-openb'),
        headIc: d(c.querySelector('.v2-pg-row .v2-pg-ic')), rows: Array.from(c.querySelectorAll('.v2-app-inst')).map((n) => [(n.querySelector('.v2-app-inst-title') || {}).textContent, d(n.querySelector('.v2-app-inst-open'))]) }; };
    R.liv = snap('liv'); R.none = snap('p:0'); R.p5 = snap('p:5');
    R.anchors = Array.from(host.querySelectorAll('.v2-pg[data-anch]')).map((n) => n.getAttribute('data-anch'));
  } catch (e) { R.error = String((e && e.stack) || e).slice(0, 600); }
  document.getElementById('out').textContent = 'RESULT' + JSON.stringify(R) + 'ENDRESULT';
})();
</script></html>`;
  const dom = await dumpDom(chrome, { html: PAGE, prefix: "liv-work-", args: ["--window-size=1200,1000"] });
  const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  const R = m ? JSON.parse(m[1]) : { error: "결과 표지를 못 받았다" };
  if (R.error) ok(false, "R0 페이지가 끝까지 돌았다", R.error);
  else {
    const names = (c) => (c ? c.rows.map((r) => r[0]) : null);
    ok(Array.isArray(R.anchors) && R.anchors.length >= 3 && !!R.p5, "R6 카드가 실제로 그려졌다", JSON.stringify(R.anchors));
    ok(!!R.liv && R.liv.name === "리브가 한 일" && names(R.liv).includes("ROW-w1") && !names(R.liv).includes("ROW-h1")
      && !!R.none && R.none.name === "기타 (미분류)" && names(R.none).includes("ROW-h1") && !names(R.none).includes("ROW-w1"),
      "R1 ★★ 프로젝트 없는 워커는 「리브가 한 일」 카드에, 사람 세션은 「기타 (미분류)」 카드에 선다", JSON.stringify([R.liv, R.none]));
    ok(!!R.liv && R.liv.pin === false && R.liv.plus === false && R.liv.go === false && !!R.p5 && R.p5.pin === true && R.p5.go === true,
      "R2 리브 카드엔 압정 · ＋ · [→] 가 없다(프로젝트 카드엔 있다)", JSON.stringify([R.liv && [R.liv.pin, R.liv.plus, R.liv.go], R.p5 && [R.p5.pin, R.p5.go]]));
    const w1 = R.liv && R.liv.rows.find((r) => r[0] === "ROW-w1"), h1 = R.none && R.none.rows.find((r) => r[0] === "ROW-h1");
    ok(!!w1 && !!h1 && !!w1[1] && w1[1] !== h1[1] && !!R.liv.headIc && R.liv.headIc !== R.none.headIc && R.liv.headIc !== R.p5.headIc,
      "R3 워커 줄 · 리브 카드 머리는 다른 줄 · 다른 카드와 다른 그림(리브)이다");
    ok(!!R.liv && ["리브 작업 #9"].every((n) => names(R.liv).filter((x) => x === n).length === 2) && !names(R.liv).includes("PAST-ph1")
      && !!R.none && names(R.none).includes("PAST-ph1") && !names(R.none).some((n) => /리브 작업/.test(n)),
      "R4 ★★ 접힘 — 끝난 워커는 리브 카드에만(«리브 작업 #N» 이름으로), 끝난 사람 세션은 「기타」 카드에만", JSON.stringify([names(R.liv), names(R.none)]));
    ok(!!R.p5 && names(R.p5).includes("ROW-w5") && names(R.p5).includes("ROW-s5") && !names(R.liv).includes("ROW-w5"),
      "R5 ★ 시킨 프로젝트가 있는 워커는 그 프로젝트 카드 안에 선다", JSON.stringify(names(R.p5)));
  }
}

console.log(`\n#4551 위탁 워커 = 리브가 한 일: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
