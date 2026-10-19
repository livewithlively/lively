#!/usr/bin/env node
// 곁칸 «콘솔»(#4876) — 순수 규칙(web/lib/console-phase.ts) + 배선(panes-parts · panes · pane-tabs · icon · agents-md).
//
//  사양(원준 2026-10-19 · 지식 session-summary-widget-3-proposals-4876 4판): 때는 둘 — A 시작(세션을 열고 첫 답 전) · B 돌아왔을 때(첫 답 뒤
//   언제나, 끝난 세션도). 열기 전 화면은 없다. B 맨 위에 «다녀온 사이»(마지막으로 본 때 뒤에 생긴 것). 허가 카드는 띄우지 않는다.
//  엣지 표(행마다 검사 하나 이상):
//   P1 세션 없음 → none · P2 질문 0 → start · P3 질문 1 · 답 없음 → start · P4 질문 1 · 답 있음 → back · P5 질문 2 · 답 없음(=새 질문이 또 갔다) → back
//   R1 답의 증거: say·meta 만 있으면 거짓 · 파일 하나면 참
//   C1 채울 것(todo)이 위로, 같은 상태끼리는 정한 차례 · C2 프로젝트 없음 → 프로젝트·자료·실행 설정만 · C3 본문 0자 → todo «쓰기» · C4 규칙 null → opt
//   C5 선행 있음 → done «바꾸기» · C6 지식 0·추천 4 → «추천 4건 · 아직 안 넣음» todo
//   A1 다녀온 사이: leftAt 0 → 비어 있음 · A2 경계(같은 시각)는 본 것 · A3 사람 말·메타는 빠진다 · A4 오래된 순
//   K1 종류: say→질문 · file/out→파일 · knowledge 남김→지식 · knowledge 읽음→참고 · cmd 커밋→반영 · cmd 그 밖→없음 · reply→없음
//   F1 거르기: 칩 + 띄어쓰기 무시 찾기 · 최신이 위 · F2 수 세기
//   L1 저장소가 던져도(사생활 모드) 0 · 안 던진다 · L2 쓰고 읽으면 같은 값 · L3 0 이하는 안 쓴다
//   H1 지시 문장: 시작 + 선행 있음 → 선행 문장이 먼저 · 태스크 0 → 쪼개기 문장 · 돌아왔을 때 → 넷
//   S1 seedConsoleTab: 곁칸 맨 앞에 한 번만 · 켜진 탭이 files 였으면 console · 사람이 켜 둔 다른 탭은 그대로 · 이미 있으면 자리 안 옮김 · 표식 뒤엔 손 안 댐 · 빈 저장소도 표식
//   W1 PART_DEFS 에 console(이름 콘솔 · 그림 console) · W2 기본 배치 첫 탭 console · act.side console · W3 seedLayoutStore 가 seedConsoleTab 을 잇고 그 결과를 저장
//   W4 그림 표에 console · W5 셸이 trailItems 를 준다 · W6 떠날 때 writeLeftAt · W7 AGENTS.md 에 선행 프로젝트 절(follow_up 만) · W8 콘솔 부품은 document 이벤트를 안 건다
//  fail-first: 변경 전 트리(git show HEAD)는 모듈이 없어 전부 빨갛다(신규). 규칙 돌연변이 — consolePhase 의 `>= 2` 를 `> 2` 로 → P5 빨강 ·
//   sinceAway 의 `>` 를 `>=` 로 → A2 빨강 · seedConsoleTab 의 files 조건을 빼면 S1 «다른 탭 그대로» 빨강(2026-10-19 실측).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
const out = mkdtempSync(path.join(tmpdir(), "console-phase-"));
execFileSync(path.join(root, "node_modules/.bin/tsc"),
  [path.join(root, "web/lib/console-phase.ts"), path.join(root, "web/lib/pane-tabs.ts"), "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" });
const L = await import(path.join(out, "console-phase.js"));
const T = await import(path.join(out, "pane-tabs.js"));

let pass = 0, fail = 0;
const check = (cond, n, why = "기대와 다르다") => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} — ${why}`); } };
const J = (v) => JSON.stringify(v);
const eq = (got, want, n) => check(J(got) === J(want), n, `기대 ${J(want)} · 실제 ${J(got)}`);

// ── 때 ──
eq(L.consolePhase({ sid: null, prompts: 3, hasReply: true }), "none", "P1 세션 없음 → none");
eq(L.consolePhase({ sid: "s", prompts: 0, hasReply: false }), "start", "P2 질문 0 → start");
eq(L.consolePhase({ sid: "s", prompts: 1, hasReply: false }), "start", "P3 질문 1 · 답 없음 → start");
eq(L.consolePhase({ sid: "s", prompts: 1, hasReply: true }), "back", "P4 질문 1 · 답 있음 → back");
eq(L.consolePhase({ sid: "s", prompts: 2, hasReply: false }), "back", "P5 질문 2 → back(답 없이도 — 새 질문이 또 갔다)");
eq(L.hasReplyIn([{ kind: "say" }, { kind: "meta" }]), false, "R1 say·meta 만 → 답 없음");
eq(L.hasReplyIn([{ kind: "say" }, { kind: "file" }]), true, "R1 파일 하나 → 답 있음");

// ── 점검표 ──
const base = { projectId: 10, descriptionChars: 1840, prior: [], required: 0, recommended: 4, rulesLines: null, repos: ["lively"], attachments: 0, task: null, run: "" };
const rows = L.checklistRows(base);
eq(rows.map((r) => r.key), ["prior", "knowledge", "project", "rules", "repos", "files", "task", "run"], "C1 채울 것(선행 · 지식)이 위로, 나머지는 정한 차례");
eq(rows.map((r) => r.st), ["todo", "todo", "done", "opt", "done", "opt", "opt", "opt"], "C1 상태");
eq(L.checklistRows({ ...base, projectId: 0 }).map((r) => r.key), ["project", "files", "run"], "C2 프로젝트 없는 세션은 셋만");
eq(L.checklistRows({ ...base, descriptionChars: 0 }).find((r) => r.key === "project"), { key: "project", name: "프로젝트", value: "#10 · 본문 없음", st: "todo", action: "쓰기" }, "C3 본문 0자 → todo 쓰기");
eq(L.checklistRows({ ...base, rulesLines: null }).find((r) => r.key === "rules").st, "opt", "C4 규칙을 모르면 opt(채울 것으로 세지 않는다)");
eq(L.checklistRows({ ...base, rulesLines: 0 }).find((r) => r.key === "rules").st, "todo", "C4 규칙 0줄이면 todo");
eq(L.checklistRows({ ...base, prior: [{ id: 4443, name: "곁칸" }] }).find((r) => r.key === "prior"), { key: "prior", name: "선행 프로젝트", value: "#4443 곁칸", st: "done", action: "바꾸기" }, "C5 선행 있음 → done 바꾸기");
eq(L.checklistRows(base).find((r) => r.key === "knowledge").value, "추천 4건 · 아직 안 넣음", "C6 지식 0 · 추천 4");
eq(L.checklistRows({ ...base, required: 3 }).find((r) => r.key === "knowledge"), { key: "knowledge", name: "지식", value: "3건 넣음", st: "done", action: "더" }, "C6 지식 3 → done");

// ── 다녀온 사이 ──
const T0 = Date.parse("2026-10-19T03:00:00Z");
const items = [
  { id: "a", kind: "say", verb: "지시", label: "질문", ts: "2026-10-19T03:00:01Z" },
  { id: "b", kind: "file", verb: "씀", label: "a.html", ts: "2026-10-19T03:00:00Z" },
  { id: "c", kind: "knowledge", verb: "남김", label: "k1", ts: "2026-10-19T03:05:00Z" },
  { id: "d", kind: "meta", verb: "", label: "m", ts: "2026-10-19T03:06:00Z" },
  { id: "e", kind: "file", verb: "고침", label: "b.html", ts: "2026-10-19T03:02:00Z" },
];
eq(L.sinceAway(items, 0).length, 0, "A1 떠난 때를 모르면 비어 있다");
eq(L.sinceAway(items, T0).map((i) => i.id), ["e", "c"], "A2/A3/A4 경계(같은 시각 b)는 본 것 · say·meta 빠짐 · 오래된 순");

// ── 종류 ──
eq(["say", "file", "out"].map((k) => L.consoleKind({ kind: k, verb: "" })), ["ask", "file", "file"], "K1 say→질문 · file/out→파일");
eq([L.consoleKind({ kind: "knowledge", verb: "남김" }), L.consoleKind({ kind: "knowledge", verb: "읽음" })], ["knowledge", "ref"], "K1 지식 남김→지식 · 읽음→참고");
eq([L.consoleKind({ kind: "cmd", verb: "커밋" }), L.consoleKind({ kind: "cmd", verb: "검사" }), L.consoleKind({ kind: "reply", verb: "답" })], ["done", null, null], "K1 커밋→반영 · 그 밖 cmd·답→없음");
const f = L.filterItems(items, "all", "");
eq(f.map((i) => i.id), ["c", "e", "a", "b"], "F1 전체 · 최신이 위(meta 는 빠짐)");
eq(L.filterItems(items, "file", "b .ht").map((i) => i.id), ["e"], "F1 칩 + 띄어쓰기 무시 찾기");
eq(L.kindCounts(items), { all: 4, ask: 1, file: 2, knowledge: 1, done: 0, ref: 0 }, "F2 수 세기");

// ── 마지막으로 본 때 ──
const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
eq(L.readLeftAt(broken, "s"), 0, "L1 저장소가 던져도 0");
L.writeLeftAt(broken, "s", 5); pass++; console.log("ok  L1 쓰기도 안 던진다");
const mem = new Map(); const st = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
L.writeLeftAt(st, "s1", 1700000000123.7);
eq(L.readLeftAt(st, "s1"), 1700000000123, "L2 쓰고 읽으면 같은 값(정수)");
L.writeLeftAt(st, "s2", 0); eq(L.readLeftAt(st, "s2"), 0, "L3 0 은 안 쓴다");

// ── 지시 문장 ──
const ph = L.phrasesFor("start", { prior: [{ id: 4443, name: "곁칸" }], tasks: 0, task: null });
check(ph[0].text.includes("#4443") && ph.some((p) => p.hint === "태스크 0"), "H1 시작 — 선행 문장이 먼저 · 태스크 0 이면 쪼개기", J(ph));
eq(L.phrasesFor("back", { prior: [], tasks: 3, task: null }).length, 4, "H1 돌아왔을 때 — 넷");

// ── seedConsoleTab ──
const lay = (side, act = "files") => ({ main: ["sessions"], side, bottom: [], act: { main: "sessions", side: act, bottom: null }, sideOn: true, bottomOn: false, pin: [] });
let r = T.seedConsoleTab({ last: lay(["files", "tasks", "knowledge"]), p: { 1: lay(["files", "web"], "web"), 2: lay(["console", "files"], "files") } });
eq([r.changed, r.added, r.store.last.side, r.store.last.act.side], [true, 2, ["console", "files", "tasks", "knowledge"], "console"], "S1 곁칸 맨 앞에 · files 가 켜져 있었으면 console");
eq([r.store.p[1].side, r.store.p[1].act.side], [["console", "files", "web"], "web"], "S1 사람이 켜 둔 다른 탭(web)은 그대로");
eq([r.store.p[2].side, r.store.seeded.console], [["console", "files"], 1], "S1 이미 있으면 자리 안 옮김 · 표식");
r = T.seedConsoleTab(r.store);
eq([r.changed, r.added], [false, 0], "S1 표식 뒤엔 손 안 댐");
r = T.seedConsoleTab(null);
eq([r.changed, r.store.seeded.console], [true, 1], "S1 빈 저장소도 표식만 찍는다");

// ── 배선 ──
const parts = read("web/v2/panes-parts.ts");
check(/\{ type: 'console', name: '콘솔', icon: 'console'/.test(parts) && /if \(type === 'console'\) return consolePart\(ctx\);/.test(parts) && /trailItems: \(\) => TlItem\[\];/.test(parts), "W1 PART_DEFS 에 콘솔 · makePart 분기 · PartCtx.trailItems");
const panes = read("web/v2/panes.ts");
const defAt = panes.indexOf("const DEF_LAYOUT = (): Layout => ({");
const defBlock = panes.slice(defAt, panes.indexOf("});", defAt));
check(/side: \['console', 'files', 'tasks', 'knowledge'\],/.test(defBlock) && /side: 'console'/.test(defBlock), "W2 기본 배치 첫 탭 콘솔 · 켜진 곁칸 탭 콘솔");
const seedAt = panes.indexOf("function seedLayoutStore(): void {");
const seedFn = panes.slice(seedAt, panes.indexOf("\n}\n", seedAt));
check(/const c = seedConsoleTab\(a\.store\);/.test(seedFn) && /a\.changed \|\| c\.changed\) localStorage\.setItem\(LAYOUT_KEY, JSON\.stringify\(c\.store\)\)/.test(seedFn), "W3 seedLayoutStore 가 콘솔 씨앗을 잇고 그 결과를 저장");
check(/trailItems: \(\) => \(trailW \? trailW\.items\(\) : \[\]\)/.test(panes), "W5 셸이 발자취 항목을 준다");
check(/^  console: '/m.test(read("web/lib/icon-paths.ts")), "W4 그림 표에 console");
check(/items\(\): TlItem\[\];/.test(read("web/timeline.ts")) && /items\(\) \{ return items\.slice\(\); \}/.test(read("web/timeline.ts")), "W5 TimelineHandle.items()");
const main = read("web/v2/main.ts");
check(/writeLeftAt\(localStorage, sid, Date\.now\(\)\)/.test(main.slice(main.indexOf("function leaveViewed("))), "W6 떠날 때 writeLeftAt");
const agents = read("src/v6/agents-md.ts");
check(/## 선행 프로젝트/.test(agents) && /e\.relation === "follow_up"/.test(agents), "W7 AGENTS.md 에 선행 프로젝트 절(follow_up)");
const con = read("web/v2/panes-console.ts");
check(!/document\.addEventListener/.test(con) && !/document\.dispatchEvent/.test(con), "W8 콘솔 부품은 document 이벤트를 안 건다(#1819)");
check(/'\/keys'|\/keys`/.test(con) && /action: 'interrupt'/.test(con), "W8 멈추기는 keys interrupt");
check(/recommend-knowledge/.test(con) && /\/link`/.test(con) && /\/knowledge`/.test(con), "W8 추천 · 선행 잇기 · 필요지식 넣기 통로");
check(/허가/.test(con) === false || !/permission\.asked/.test(con), "W8 허가 카드 없음");
check(/49-v2-console\.css/.test(read("public/index.html")), "W9 스타일시트 등록");

console.log(`\n${fail ? "✗" : "✓"} console-phase: ${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
