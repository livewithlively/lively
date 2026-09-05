// #762 — 곁칸 탭의 열쇠(TabKey): 탭은 «부품의 종류»가 아니라 그 종류의 «인스턴스» 하나다.
//
//  신고(2026-09-05): "뷰어는 여러 탭이 뜨게 하고 싶은데 이거만 예외 두긴 좀 그런데 어케할까?
//  자료에 있는 파일 중에서 한 번에 하나만 열 수 있는 게 이상해서."
//  종전엔 배치가 ['files','knowledge','apps'] 처럼 **종류 이름의 목록**이라 한 종류는 칸마다 하나뿐이었다.
//
//  이 파일은 **사양만 보고** 썼다(스크래치패드 spec-tab.md). 구현(web/lib/tab-key.ts)은 열지 않았다.
//  단언은 전부 값 비교다 — 문자열은 문자열로, 숫자는 숫자로, 참거짓은 참거짓으로 못박는다
//  (truthy 검사로 두면 아무 값이나 통과해 늘 초록불이 된다).
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "tab-key-"));
execFileSync(
  path.join(root, "node_modules/.bin/tsc"),
  [path.join(root, "web/lib/tab-key.ts"), "--outDir", out,
   "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" },
);
const { tabBase, tabNum, tabKey, isTabKey, nextTabKey } = await import(path.join(out, "tab-key.js"));

let pass = 0, fail = 0;
const ok  = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "기대와 다르다") => (cond ? ok(n) : bad(n, why));

const show = (v) => (typeof v === "string" ? JSON.stringify(v) : String(v));
/** 문자열 하나를 글자 그대로 못박는다(타입까지). */
const eqStr = (got, want, n) =>
  check(typeof got === "string" && got === want, n,
    `기대 ${show(want)} · 실제 ${show(got)} (${typeof got})`);
/** 숫자 하나를 값 그대로 못박는다(타입까지 — '2' 나 NaN 이 통과하면 안 된다). */
const eqNum = (got, want, n) =>
  check(typeof got === "number" && Object.is(got, want), n,
    `기대 ${want} · 실제 ${show(got)} (${typeof got})`);
/** 참거짓 하나를 못박는다(truthy 가 아니라 진짜 true/false). */
const eqBool = (got, want, n) =>
  check(typeof got === "boolean" && got === want, n,
    `기대 ${want} · 실제 ${show(got)} (${typeof got})`);

// ───────────────────────── A. 규칙 1 — 열쇠의 모양과 «이미 저장된 것»과의 호환
//
//  첫 번째 인스턴스는 종류 이름 그대로여야 한다. 이 한 줄이 호환의 전부다:
//  이미 저장된 배치(['files','knowledge','apps'])와 부품별 기억(펴 둔 파일·주소·배율)이
//  손대지 않아도 그대로 «첫 탭의 것»으로 살아난다.

eqStr(tabKey("editor", 1), "editor",
  "A1 첫 번째 인스턴스의 열쇠는 종류 이름 그대로다('editor')");

eqStr(tabKey("editor", 2), "editor#2",
  "A2 둘째부터는 '#n' 이 붙는다('editor#2')");

{ // 종전 배치에 적혀 있던 종류 이름들이 손대지 않아도 그대로 첫 탭의 열쇠다
  const old = ["files", "knowledge", "apps"];
  const same = old.every((t) => tabKey(t, 1) === t && isTabKey(t) === true &&
                                tabBase(t) === t && tabNum(t) === 1);
  check(same, "A3 이미 저장된 배치 ['files','knowledge','apps'] 는 그대로 첫 탭의 열쇠로 살아난다",
    `실제 ${old.map((t) => `${t}→${show(tabKey(t, 1))}/${show(tabBase(t))}/${tabNum(t)}/${isTabKey(t)}`).join(" · ")}`);
}

{ // 열쇠는 문자열이다 — 만드는 자리도, 다음 번호를 고르는 자리도
  const a = tabKey("web", 3), b = nextTabKey("web", []);
  check(typeof a === "string" && typeof b === "string",
    "A4 열쇠는 문자열이다(만든 것도·다음 빈 번호로 고른 것도)",
    `tabKey→${typeof a} · nextTabKey→${typeof b}`);
}

// ───────────────────────── B. 규칙 2 — 열쇠에서 «종류» 를 뽑는다 (tabBase)

eqStr(tabBase("editor#2"), "editor",
  "B1 'editor#2' 의 종류는 'editor' 다");

eqStr(tabBase("editor"), "editor",
  "B2 번호가 없는 'editor' 의 종류도 'editor' 다(자기 자신)");

eqStr(tabBase("editor#7"), "editor",
  "B3 'editor#7' 의 종류도 'editor' 다(번호가 두 자리 앞이든 뒤든 종류는 하나)");

eqStr(tabBase("editor#123"), "editor",
  "B4 번호가 여러 자리여도 종류는 '#' 앞이다('editor#123' → 'editor')");

eqStr(tabBase("web#2"), "web",
  "B5 다른 종류도 같은 규칙이다('web#2' → 'web')");

eqStr(tabBase("files"), "files",
  "B6 종전 배치에 있던 이름도 그대로 종류다('files' → 'files')");

// ───────────────────────── C. 규칙 3 — 열쇠에서 «번호» 를 뽑는다 (tabNum)

eqNum(tabNum("editor"), 1,
  "C1 번호가 없는 'editor' 는 1 번이다");

eqNum(tabNum("editor#2"), 2,
  "C2 'editor#2' 는 2 번이다");

eqNum(tabNum("editor#7"), 7,
  "C3 'editor#7' 은 7 번이다");

eqNum(tabNum("editor#10"), 10,
  "C4 번호가 두 자리여도 그대로 읽는다('editor#10' → 10)");

eqNum(tabNum("editor#123"), 123,
  "C5 번호가 세 자리여도 그대로 읽는다('editor#123' → 123)");

// ── 말이 안 되는 번호는 전부 1 로 읽는다(사양이 적은 네 가지 그대로)
eqNum(tabNum("editor#0"), 1,
  "C6 말이 안 되는 번호는 1 로 읽는다 — 'editor#0'");

eqNum(tabNum("editor#1"), 1,
  "C7 말이 안 되는 번호는 1 로 읽는다 — 'editor#1'(1 번은 번호를 안 붙이는 게 성한 모양이다)");

eqNum(tabNum("editor#x"), 1,
  "C8 말이 안 되는 번호는 1 로 읽는다 — 'editor#x'");

eqNum(tabNum("editor#"), 1,
  "C9 말이 안 되는 번호는 1 로 읽는다 — 'editor#'(번호 자리가 비었다)");

{ // 1 로 읽는다 = «NaN 도 아니고 undefined 도 아니다». 숫자로 곧장 세도 안전해야 한다
  const got = ["editor", "editor#0", "editor#1", "editor#x", "editor#"].map(tabNum);
  check(got.every((n) => typeof n === "number" && n === 1),
    "C10 번호가 없거나 말이 안 되는 다섯 가지는 모두 숫자 1 이다(NaN·undefined 가 아니다)",
    `실제 [${got.map(show).join(", ")}]`);
}

// ───────────────────────── D. 규칙 4 — 종류와 번호로 열쇠를 만든다 (tabKey)

eqStr(tabKey("editor", 1), "editor",
  "D1 1 번은 종류 이름 그대로다");

eqStr(tabKey("editor", 0), "editor",
  "D2 «1 이하» 이므로 0 도 종류 이름 그대로다");

eqStr(tabKey("editor", -3), "editor",
  "D3 «1 이하» 이므로 음수도 종류 이름 그대로다");

eqStr(tabKey("editor", 2), "editor#2",
  "D4 2 번은 '종류#번호' 다");

eqStr(tabKey("editor", 7), "editor#7",
  "D5 7 번은 'editor#7' 이다");

eqStr(tabKey("editor", 10), "editor#10",
  "D6 두 자리 번호도 그대로 붙인다('editor#10' — 0 을 채우지 않는다)");

eqStr(tabKey("web", 3), "web#3",
  "D7 종류가 달라도 같은 규칙이다('web', 3 → 'web#3')");

{ // 만든 것을 되읽으면 그대로 나온다(왕복) — 규칙 2·3·4 가 서로 어긋나지 않는다
  const bads = [];
  for (const t of ["editor", "web", "files", "knowledge"]) {
    for (const n of [1, 2, 3, 7, 10, 42]) {
      const k = tabKey(t, n);
      if (tabBase(k) !== t) bads.push(`${k}: 종류 ${show(tabBase(k))}`);
      if (tabNum(k) !== n) bads.push(`${k}: 번호 ${show(tabNum(k))}`);
      if (isTabKey(k) !== true) bads.push(`${k}: 성하지 않다고 한다`);
    }
  }
  check(bads.length === 0,
    "D8 만든 열쇠를 되읽으면 종류·번호가 그대로다(종류 4 × 번호 6 = 24 개, 전부 성한 모양)",
    `어긋난 것 [${bads.slice(0, 5).join(" · ")}]`);
}

{ // «1 이하» 쪽의 왕복 — 0·음수로 만들어도 1 번 열쇠로 읽힌다
  const bads = [];
  for (const n of [1, 0, -1, -99]) {
    const k = tabKey("editor", n);
    if (k !== "editor" || tabNum(k) !== 1) bads.push(`${n}→${show(k)}/${show(tabNum(k))}`);
  }
  check(bads.length === 0,
    "D9 1 이하로 만든 열쇠는 모두 'editor' 이고 되읽으면 1 번이다",
    `어긋난 것 [${bads.join(" · ")}]`);
}

// ───────────────────────── E. 규칙 5 — 열쇠 모양이 성한지 가린다 (isTabKey)
//
//  성한 것: 종류 이름만, 또는 «종류#N»(N 은 2 이상의 정수).

eqBool(isTabKey("editor"), true,
  "E1 종류 이름만 있는 'editor' 는 성하다");

eqBool(isTabKey("a"), true,
  "E2 한 글자 종류 'a' 도 성하다");

eqBool(isTabKey("editor#2"), true,
  "E3 'editor#2' 는 성하다(N = 2)");

eqBool(isTabKey("editor#7"), true,
  "E4 'editor#7' 은 성하다");

eqBool(isTabKey("editor#10"), true,
  "E5 'editor#10' 은 성하다(두 자리 번호)");

eqBool(isTabKey("editor#123"), true,
  "E6 'editor#123' 은 성하다(세 자리 번호)");

// ── 성하지 않은 것 — 사양이 적은 여덟 가지 전부
eqBool(isTabKey(""), false,
  "E7 성하지 않다 — 빈 문자열");

eqBool(isTabKey("a#0"), false,
  "E8 성하지 않다 — 'a#0'(N 이 2 보다 작다)");

eqBool(isTabKey("a#1"), false,
  "E9 성하지 않다 — 'a#1'(1 번은 번호를 안 붙인다)");

eqBool(isTabKey("a#x"), false,
  "E10 성하지 않다 — 'a#x'(번호가 아니다)");

eqBool(isTabKey("a#"), false,
  "E11 성하지 않다 — 'a#'(번호 자리가 비었다)");

eqBool(isTabKey("a#2#3"), false,
  "E12 성하지 않다 — 'a#2#3'('#' 이 둘이다)");

eqBool(isTabKey("a#02"), false,
  "E13 성하지 않다 — 'a#02'(0 을 채운 번호는 성한 모양이 아니다)");

eqBool(isTabKey("a#-1"), false,
  "E14 성하지 않다 — 'a#-1'(2 이상의 정수가 아니다)");

eqBool(isTabKey("a#2.5"), false,
  "E15 성하지 않다 — 'a#2.5'(정수가 아니다)");

// ── 문자열이 아닌 값은 전부 성하지 않다
{
  const nots = [
    ["undefined", undefined], ["null", null], ["숫자 2", 2], ["숫자 0", 0],
    ["true", true], ["false", false], ["객체", { base: "editor", n: 2 }],
    ["배열", ["editor", 2]], ["문자열 객체", new String("editor")], ["심볼", Symbol("editor")],
  ];
  // 던지는 것도 «성하지 않다고 답하지 못한 것»으로 친다 — 가려내는 자리는 무엇을 받아도 답해야 한다
  const ask = (v) => { try { return isTabKey(v); } catch (e) { return `던짐(${e.message})`; } };
  const wrong = nots.filter(([, v]) => ask(v) !== false).map(([n, v]) => `${n}→${show(ask(v))}`);
  check(wrong.length === 0,
    "E16 문자열이 아닌 값은 열 가지 모두 성하지 않다(undefined·null·숫자·참거짓·객체·배열·String 객체·심볼)",
    `성하다고 한 것 [${wrong.join(" · ")}]`);
}

{ // 규칙 3·5 가 서로 어긋나지 않는다: 말이 안 되는 번호는 1 로 읽히지만 «성한 모양은 아니다»
  const junk = ["editor#0", "editor#1", "editor#x", "editor#"];
  const bads = junk.filter((k) => !(tabNum(k) === 1 && isTabKey(k) === false));
  check(bads.length === 0,
    "E17 말이 안 되는 번호는 1 로 읽되(규칙 3) 성한 모양은 아니다(규칙 5) — 네 가지 모두",
    `어긋난 것 [${bads.map((k) => `${k}: 번호 ${show(tabNum(k))} · 성함 ${show(isTabKey(k))}`).join(" · ")}]`);
}

// ───────────────────────── F. 규칙 6 — 다음 빈 번호로 새 열쇠를 만든다 (nextTabKey)

eqStr(nextTabKey("editor", []), "editor",
  "F1 목록이 비어 있으면 종류 이름 그대로다(1 번)");

eqStr(nextTabKey("editor", ["web", "web#2", "files"]), "editor",
  "F2 그 종류가 하나도 없으면 종류 이름 그대로다");

eqStr(nextTabKey("editor", ["editor"]), "editor#2",
  "F3 'editor' 만 있으면 'editor#2' 다");

eqStr(nextTabKey("editor", ["editor", "editor#2"]), "editor#3",
  "F4 'editor'·'editor#2' 가 있으면 'editor#3' 이다");

eqStr(nextTabKey("editor", ["editor", "editor#3"]), "editor#2",
  "F5 빈 번호는 되쓴다 — 'editor'·'editor#3' 만 있으면 'editor#2' 다");

eqStr(nextTabKey("editor", ["editor", "web#2"]), "editor#2",
  "F6 다른 종류의 열쇠는 번호 계산에 끼어들지 않는다 — 'web#2' 가 있어도 editor 의 다음은 'editor#2' 다");

eqStr(nextTabKey("editor", ["files", "editor", "web", "web#2", "web#3", "knowledge"]), "editor#2",
  "F7 남의 종류가 잔뜩 섞인 배치에서도 editor 의 다음은 'editor#2' 다(남의 2·3 번을 세지 않는다)");

eqStr(nextTabKey("editor", ["editor#2"]), "editor",
  "F8 'editor#2' 만 있고 1 번이 비었으면 «가장 작은» 1 번을 쓴다 → 'editor'");

eqStr(nextTabKey("editor", ["editor", "editor#2", "editor#3"]), "editor#4",
  "F9 1·2·3 이 차 있으면 'editor#4' 다");

eqStr(nextTabKey("editor", ["editor", "editor#2", "editor#4", "editor#5"]), "editor#3",
  "F10 가운데가 비면 그 «가장 작은» 빈 번호다 — 1·2·4·5 가 있으면 'editor#3'");

eqStr(nextTabKey("editor", ["editor#5", "editor#3", "editor"]), "editor#2",
  "F11 목록 순서가 뒤죽박죽이어도 가장 작은 빈 번호를 짚는다(5·3·1 → 'editor#2')");

eqStr(nextTabKey("editor", ["editor#3", "editor#2", "editor"]), "editor#4",
  "F12 목록 순서가 뒤죽박죽이어도 답은 같다(3·2·1 → 'editor#4')");

eqStr(nextTabKey("editor", ["editor", "editor", "editor#2"]), "editor#3",
  "F13 같은 열쇠가 목록에 두 번 들어 있어도 답은 같다");

eqStr(nextTabKey("editor", ["editor-notes", "editor-notes#2"]), "editor",
  "F14 이름이 앞부분만 겹치는 다른 종류('editor-notes')는 editor 의 번호를 먹지 않는다");

eqStr(nextTabKey("web", ["editor", "editor#2", "editor#3"]), "web",
  "F15 남의 종류만 잔뜩 차 있어도 처음 여는 종류는 이름 그대로다('web')");

// ── used 는 Iterable 이다 — 배열 말고 Set·제너레이터로도 같은 답
eqStr(nextTabKey("editor", new Set(["editor", "editor#2"])), "editor#3",
  "F16 used 는 Iterable 이다 — Set 으로 줘도 'editor'·'editor#2' 다음은 'editor#3'");

eqStr(nextTabKey("editor", new Set(["editor", "editor#3"])), "editor#2",
  "F17 Set 으로 줘도 빈 번호는 되쓴다 — 'editor'·'editor#3' 다음은 'editor#2'");

eqStr(nextTabKey("editor", new Set()), "editor",
  "F18 빈 Set 이면 종류 이름 그대로다");

eqStr(nextTabKey("editor", new Set(["web", "web#2"])), "editor",
  "F19 Set 에 남의 종류만 있으면 종류 이름 그대로다");

{ // 배치를 Map(열쇠 → 부품 상태)으로 들고 있어도 그 열쇠들을 그대로 넘길 수 있다
  const panes = new Map([["editor", {}], ["editor#2", {}], ["files", {}]]);
  eqStr(nextTabKey("editor", panes.keys()), "editor#3",
    "F20 Map 의 열쇠 반복자(Iterable)로 줘도 답은 같다 — 'editor#3'");
}

{ // 제너레이터 = 배열도 Set 도 아닌 순수 Iterable
  function* gen() { yield "editor"; yield "web#2"; yield "editor#3"; }
  eqStr(nextTabKey("editor", gen()), "editor#2",
    "F21 제너레이터(순수 Iterable)로 줘도 빈 번호를 되쓴다 — 'editor#2'");
}

{ // 불변식 — 고른 번호는 «이미 쓰는 것»이 아니고 «성한 모양»이다
  const cases = [
    [], ["editor"], ["editor", "editor#2"], ["editor", "editor#3"], ["editor#2"],
    ["web#2"], ["editor", "editor#2", "editor#4", "editor#5"], ["editor#9", "editor"],
  ];
  const bads = [];
  for (const used of cases) {
    for (const box of [used, new Set(used)]) {
      const k = nextTabKey("editor", box);
      if (used.includes(k)) bads.push(`[${used}] → 이미 쓰는 ${show(k)}`);
      if (isTabKey(k) !== true) bads.push(`[${used}] → 성하지 않은 ${show(k)}`);
      if (tabBase(k) !== "editor") bads.push(`[${used}] → 종류가 ${show(tabBase(k))}`);
    }
  }
  check(bads.length === 0,
    "F22 고른 열쇠는 늘 «안 쓰는·성한·그 종류의» 것이다(8 가지 목록 × 배열·Set)",
    `어긋난 것 [${bads.slice(0, 5).join(" · ")}]`);
}

// ───────────────────────── G. 규칙들이 함께 도는 한 판 — 신고 그대로
//
//  "자료에 있는 파일 중에서 한 번에 하나만 열 수 있는 게 이상해서."
//  이제 파일을 세 번 누르면 뷰어 탭이 셋 선다. 하나를 닫으면 그 번호를 되쓴다.

{
  const panes = ["files", "knowledge"];   // 종전 배치 — 열쇠가 곧 종류 이름이었다
  const opened = [];
  for (let i = 0; i < 3; i++) {           // 자료에서 파일을 세 번 눌렀다
    const k = nextTabKey("editor", panes);
    panes.push(k); opened.push(k);
  }
  check(opened.join(",") === "editor,editor#2,editor#3",
    "G1 파일을 세 번 누르면 뷰어 탭이 셋 선다 — 'editor'·'editor#2'·'editor#3'(첫 탭은 종류 이름 그대로)",
    `실제 [${opened.map(show).join(", ")}]`);

  const closed = panes.filter((k) => k !== "editor#2");   // 가운데 탭을 닫았다
  eqStr(nextTabKey("editor", closed), "editor#2",
    "G2 가운데 탭을 닫고 다시 열면 그 빈 번호를 되쓴다 — 'editor#2'");

  eqStr(nextTabKey("web", panes), "web",
    "G3 같은 칸에서 다른 종류를 처음 열면 그 종류 이름 그대로다('web') — 뷰어 번호와 안 섞인다");

  const kinds = panes.map(tabBase).join(",");
  check(kinds === "files,knowledge,editor,editor,editor",
    "G4 배치의 열쇠에서 종류만 뽑으면 어떤 부품을 그릴지 그대로 나온다(뷰어 셋은 같은 종류)",
    `실제 [${kinds}]`);

  const nums = panes.map(tabNum).join(",");
  check(nums === "1,1,1,2,3",
    "G5 배치의 열쇠에서 번호만 뽑으면 1,1,1,2,3 이다(옛 탭 둘은 1 번으로 살아난다)",
    `실제 [${nums}]`);

  check(panes.every((k) => isTabKey(k) === true),
    "G6 이 판에 선 다섯 열쇠는 모두 성한 모양이다",
    `실제 [${panes.filter((k) => isTabKey(k) !== true).map(show).join(", ")}] 가 성하지 않다`);
}

{ // 부품별 기억(펴 둔 파일·주소·배율)을 열쇠로 찾는다 — 옛 기억은 첫 탭이 그대로 받는다
  const memory = { editor: "펴 둔 파일 A", web: "주소 B" };   // 종전에 종류 이름으로 저장돼 있던 것
  const first = tabKey("editor", 1), second = tabKey("editor", 2);
  check(memory[first] === "펴 둔 파일 A" && memory[second] === undefined,
    "G7 종류 이름으로 저장돼 있던 기억은 첫 탭('editor')이 그대로 받고, 둘째 탭('editor#2')은 새 자리다",
    `첫 탭 ${show(memory[first])} · 둘째 탭 ${show(memory[second])}`);
}

{ // 뷰어 탭을 열두 번 열었다 — 규칙 5 의 N 에는 위끝이 없다(2 이상의 정수면 성하다)
  const used = [];
  for (let i = 0; i < 12; i++) used.push(nextTabKey("editor", used));
  const want = ["editor", "editor#2", "editor#3", "editor#4", "editor#5", "editor#6",
                "editor#7", "editor#8", "editor#9", "editor#10", "editor#11", "editor#12"];
  check(used.join(",") === want.join(","),
    "G8 파일을 열두 번 누르면 열쇠가 1..12 번까지 차례로 난다",
    `실제 [${used.map(show).join(", ")}]`);

  const sick = used.filter((k) => isTabKey(k) !== true);
  check(sick.length === 0,
    "G9 그렇게 난 열두 열쇠는 모두 성한 모양이다 — 만드는 자리와 가리는 자리가 어긋나면 안 된다",
    `만들어 놓고 성하지 않다고 하는 것 [${sick.map(show).join(", ")}]`);
}

console.log(`tab-key: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
if (fail) process.exit(1);
