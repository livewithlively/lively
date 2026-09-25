// #4233 — 홈 사이드바 «V1 안 1 · 고정 카드» (원준 2026-09-25 «이번 v2보다 v1이 더 나은거같음 V1의 1안으로 하자»).
//
//  원칙: **고정한 단위가 그대로 움직인다** — 세션을 고정하면 그 한 줄이, 프로젝트를 고정하면 그 카드가 통째로 올라간다.
//   모든 세션 줄은 카드 안에 선다(두 축 모두). 한 세션은 한 자리에만 선다.
//  함께 고친 것: 세션별 축 둘째 줄에 `<agent-message …>` 원문이 뜨던 것(홈 사이드바 2판 진단) · 묶기 토글 아이콘.
//  V — 잣대(web/lib/home-pins.ts · web/lib/ask-text.ts)를 값으로.  W — 화면이 실제로 그 잣대를 지나는지 소스로.
//  행 번호(H · S · A · W)는 사양의 엣지 표 행이다. 단언을 끝까지 센다(첫 실패에서 멈추지 않는다).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (p) => { try { return readFileSync(path.join(root, p), "utf8"); } catch { return ""; } };
//  주석은 빼고 본다 — 머리말에 적힌 낱말이 단언을 통과시키면 그 시험은 아무것도 안 잡는다.
const code = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const cut = (src, from, to) => { const a = src.indexOf(from); if (a < 0) return ""; const b = to ? src.indexOf(to, a + 1) : -1; return src.slice(a, b > a ? b : undefined); };

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}`); } };
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), `${name}${JSON.stringify(got) === JSON.stringify(want) ? "" : ` — got ${JSON.stringify(got)}`}`);

// ───────────────────────── V. 잣대 ─────────────────────────
let pins = null, ask = null;
try {
  const out = mkdtempSync(path.join(tmpdir(), "home-pins-"));
  execFileSync(path.join(root, "node_modules/.bin/tsc"),
    [path.join(root, "web/lib/home-pins.ts"), path.join(root, "web/lib/ask-text.ts"), "--rootDir", path.join(root, "web"),
     "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"], { stdio: "ignore" });
  pins = await import(path.join(out, "lib/home-pins.js"));
  ask = await import(path.join(out, "lib/ask-text.js"));
} catch { /* 없으면 아래 V0 가 빨간불 */ }
ok(!!pins && !!ask, "V0 잣대가 잎 모듈(lib/home-pins · lib/ask-text)에 있다 — 화면 코드 안에 있으면 시험할 데가 없다");

if (pins) {
  const { splitHomePins, pinnedFirst, splitSessAxis } = pins;
  const PINNED = new Set([7]);
  const isP = (id) => PINNED.has(id);
  const R = (id, o = {}) => ({ id, pinned: false, project: { id: 1 }, group: "오늘", ...o });
  const ids = (xs) => xs.map((x) => x.id);

  const h = splitHomePins([R("a", { pinned: true }), R("b")], isP);
  eq([ids(h.pinnedRows), ids(h.rest)], [["a"], ["b"]], "H1 고정 세션(프로젝트 고정 안 함)은 세션 카드로, 프로젝트 카드에서 빠진다");
  const h2 = splitHomePins([R("n", { pinned: true, project: { id: 7 } })], isP);
  eq([ids(h2.pinnedRows), ids(h2.rest)], [[], ["n"]], "H2 ★고정한 프로젝트 안에서 또 고정한 세션은 프로젝트 카드에 남는다(세션 카드에 두 번 서지 않는다)");
  const h3 = splitHomePins([R("u", { project: { id: 7 } })], isP);
  eq([ids(h3.pinnedRows), ids(h3.rest)], [[], ["u"]], "H3 고정한 프로젝트의 고정 안 한 세션은 카드와 함께 간다");
  const h4 = splitHomePins([R("x", { pinned: true, project: null }), R("z", { pinned: true, project: { id: 0 } })], () => true);
  eq(ids(h4.pinnedRows), ["x", "z"], "H4 경계: 프로젝트 없음(null · id 0)은 고정할 수 없다 — 그 안의 고정 세션은 세션 카드로");
  ok(splitHomePins([], isP).pinnedRows.length === 0 && splitHomePins(null, isP).rest.length === 0, "H5 행이 없거나 null 이면 빈 결과");
  const h6 = splitHomePins([R("1"), R("2", { pinned: true }), R("3"), R("4", { pinned: true }), R("5")], isP);
  eq([ids(h6.pinnedRows), ids(h6.rest)], [["2", "4"], ["1", "3", "5"]], "H6 순서는 들어온 그대로(시간축이 정한 순서를 지어내지 않는다)");
  eq(ids(pinnedFirst([R("1"), R("2", { pinned: true }), R("3"), R("4", { pinned: true })])), ["2", "4", "1", "3"], "H7 카드 안: 고정한 줄이 맨 위, 나머지는 순서 그대로");

  const s = splitSessAxis([R("p1", { pinned: true, group: "고정" }), R("q", { project: { id: 7 }, group: "오늘" }), R("q2", { pinned: true, project: { id: 7 }, group: "고정" }),
    R("t1"), R("t2"), R("y1", { group: "어제" })], isP);
  eq([ids(s.pinnedRows), ids(s.pinnedProjRows), s.dated.map((d) => [d.group, ids(d.rows)])],
    [["p1"], ["q", "q2"], [["오늘", ["t1", "t2"]], ["어제", ["y1"]]]],
    "S1 ★세션별 축: 고정한 프로젝트의 줄은 고정 여부와 무관하게 카드째 · 다른 고정 줄은 세션 카드 · 나머지는 날짜 카드");
  eq(splitSessAxis([R("a"), R("b", { group: "어제" }), R("c")], isP).dated.map((d) => d.group), ["오늘", "어제", "오늘"],
    "S2 경계: 같은 묶음 이름이 떨어져 나오면 두 구간이다(순서를 새로 짓지 않는다)");
  eq(splitSessAxis([R("a", { group: undefined })], isP).dated.map((d) => [d.group, ids(d.rows)]), [["", ["a"]]], "S3 묶음 이름이 없으면 이름 없는 구간 하나");
  const s4 = splitSessAxis(null, isP);
  ok(!s4.pinnedRows.length && !s4.pinnedProjRows.length && !s4.dated.length, "S4 행이 없으면 셋 다 빈 배열");
}

if (ask) {
  const { isInjectedPrompt, cleanAskText } = ask;
  eq([isInjectedPrompt('<agent-message from="a0643242">'), isInjectedPrompt('  \n<agent-message from="x">'), isInjectedPrompt("머지하고 다음 롤 로그까지 확인해줘"), isInjectedPrompt("이 글에 <agent-message 가 섞여 있다")],
    [true, true, false, false], "A1 ★하네스가 끼운 글(`<agent-message …>`)은 앞머리로 가른다 — 앞 공백도 · 사람 말 가운데 태그는 사람 말");
  eq([cleanAskText('어 최종 질문지 보내줄게. <pasted_content id="3bf5">질문 순서</pasted_content> 봐줘'), cleanAskText('보내줄게 <pasted_content id="x">잘린 꼬리'),
    cleanAskText('<agent-message from="x">hi'), cleanAskText("   ")],
    ["어 최종 질문지 보내줄게. (붙여 넣은 글) 봐줘", "보내줄게 (붙여 넣은 글)", null, null],
    "A2 붙여 넣은 글 태그는 «(붙여 넣은 글)»로 줄인다(닫는 태그가 잘렸으면 끝까지) · 끼운 글 · 빈 값은 null");
}

// ───────────────────────── W. 배선 ─────────────────────────
const SIDE = code(read("web/v2/side.ts"));
const kids = cut(SIDE, "function projListKids(", "function projGrpCard(");
//  ⚠ stage 전용: 이 브랜치에는 #3870(projCardRows)이 없다 — rest 는 나누기의 나머지 그대로다.
ok(/const pins = splitHomePins\(shown, projPinnedId\);/.test(kids) && /const rest = pins\.rest;/.test(kids)
  && /if \(pinnedRows\.length\) kids\.push\(pinCard\(pinnedRows, o\)\);/.test(kids),
  "W1a ★프로젝트별 축: 잎 모듈로 나누고, 고정한 세션은 「고정」 세션 카드(pinCard)에 선다 — 카드 밖 줄이 없다");
const card = cut(SIDE, "function projGrpCard(", "function cardPastHead(");
ok(/const pinIn = pinnedFirst\(g\.rows\)\.filter\(\(r\) => r\.pinned\);/.test(card) && /foldCardRows\(g\.rows\.filter\(\(r\) => !r\.pinned\)/.test(card)
  && /\.\.\.pinIn\.map\(row\),\s*\.\.\.fold\.now\.map\(row\)/.test(card),
  "W1b ★카드 안 고정 줄은 맨 위에 서고 「지난 세션」 뒤로 접히지 않는다");
const pc = cut(SIDE, "function pinCard(", "\n}");
ok(/projLine: true/.test(pc) && /v2-pg--pins/.test(pc) && !/v2-pg-row/.test(pc), "W1c 「고정」 세션 카드는 머리가 없고, 줄 둘째 칸이 소속 프로젝트다");
const al = cut(SIDE, "function appListKids(", "\n}\n");
const sx = cut(SIDE, "function sessAxisKids(", "\n}\n");
ok(/groupProj \? projListKids\(shown, o\) : sessAxisKids\(shown, o\)/.test(al) && /if \(kids\.length\) return kids;/.test(al),
  "W2a 세션별 축은 sessAxisKids 로 그린다 · 빈 화면은 그린 것으로 가른다(#3870 E2 그대로)");
ok(/splitSessAxis\(shown, projPinnedId\)/.test(sx) && /text: PINNED_BUCKET/.test(sx) && /kids\.push\(pinCard\(pinRows, o\)\)/.test(sx)
  && /projGroups\(inCards, false, false\)/.test(sx) && /projGrpCard\(g, o, false\)/.test(sx) && /kids\.push\(dayCard\(d\.group, d\.rows, o\)\)/.test(sx),
  "W2b ★세션별 축도 같은 「고정」 층(세션 카드 + 고정한 프로젝트 카드, 자리 기억은 안 건드림) · 나머지는 날짜 카드");
ok(/const inCards = cut\.pinnedProjRows;/.test(sx), "W2c (stage) #3870 이 없는 브랜치 — 카드 재료를 그대로 쓴다");
const LA = code(read("web/v2/last-ask.ts")), ST = code(read("web/v2/sess-tail.ts"));
ok(/cleanAskText\(s\.raw\.lastPrompt\)/.test(LA) && /const INJ_RE = INJECTED_RE;/.test(ST),
  "W3 ★서버 칸(lastPrompt)과 꼬리 조회가 같은 식(lib/ask-text)으로 끼운 글을 거른다");
const IC = read("web/v2/icons.ts"), CSS40 = read("public/styles/40-v2.css");
ok(IC.includes("folderRows: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M7 12h10 M7 15h6'")
  && /icon\('folderRows', 'v2-axisbtn-ic'\)/.test(cut(SIDE, "function axisBtn(", "\n}\n"))
  && /\.v2-axisbtn-ic \{ width: 15px; height: 15px;[^}]*stroke-width: 1\.9;/.test(CSS40),
  "W4 묶기 토글 아이콘 = 폴더 안 줄 둘(검토판 1판 그림 · 15px · 1.9 선)");
const tp = cut(SIDE, "function togglePin(", "\n}\n");
ok(/repaintList\(\);/.test(tp) && !/if \(groupProj\) repaintList\(\);/.test(tp), "W5 프로젝트 압정은 두 축 모두 다시 그린다(세션별 축도 이 핀을 쓴다)");
const CSS = read("public/styles/47-v2-rail.css");
ok(/\.v2-home-cards \.v2-app-group \{ padding: 16px 8px 6px; \}/.test(CSS) && /\.v2-home-cards \.v2-pg \+ \.v2-pg[^{]*\{ margin-top: 8px; \}/.test(CSS)
  && /grid-template-rows: 22px 16px;/.test(CSS) && /\.v2-home-cards \.v2-app-inst \{ padding-left: 8px; \}/.test(CSS) && /\.v2-home-cards \.v2-app-inst-open \{ gap: 7px; \}/.test(CSS),
  "W6 홈 목록 간격 한 벌 — 이름표 16/6 · 카드 사이 8 · 두 줄 22+16 · 기둥(아이콘 28 · 제목 52)");

console.log(`\n#4233 홈 사이드바 고정 카드: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
