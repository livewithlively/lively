// #3870 — 끝난 세션만 든 프로젝트 카드는 **접힌 채 프로젝트 이름만** 선다.
//
//  신고(원준 2026-09-27): "흐리게 보이는건 <지난 세션>이어야해 … 지난세션보다 위쪽에 있는데 흐리게 보이는
//   세션이 존재하는거지?" → 정한 모양: "구분선 없이, 흐리게, 다만 세션 이름들 접힌 상태로 프로젝트 이름만."
//
//  원인은 펼침 기억이었다 — 하던 때 한 번 펴 둔(또는 보고 있어서 펴진) 카드는 세션이 전부 끝난 뒤에도 영영
//   펴진 채 흐린 줄을 날짜 묶음 아래 늘어놓았다. 이 파일은 판정(cardOpenVerdict)과 배선(side.ts)을 함께 못박는다.
//
//  ⚠ 판정은 종전 규칙을 **모형으로 따로 적지 않고** side.ts 의 실제 루프를 돌려 본다(F 절) — 배선이 판정을
//   안 부르면 A 절이 초록이어도 화면은 그대로이기 때문이다.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "card-collapse-"));
execFileSync(
  path.join(root, "node_modules/.bin/tsc"),
  [path.join(root, "web/lib/sess-fold.ts"), "--outDir", out,
   "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" },
);
const mod = await import(path.join(out, "sess-fold.js"));
const cardOpenVerdict = typeof mod.cardOpenVerdict === "function" ? mod.cardOpenVerdict : () => ({ open: undefined });

let pass = 0, fail = 0;
const ok  = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "기대와 다르다") => (cond ? ok(n) : bad(n, why));
const is = (inp, open, remember, n) => {
  const v = cardOpenVerdict(inp);
  check(v.open === open && v.remember === remember, n,
    `기대 open=${open} remember=${remember} · 실제 open=${v.open} remember=${v.remember}`);
};

// ── A. 끝난 세션만 든 카드 — 기본은 접힘, 어떤 기억도 그걸 못 편다 ─────────────
is({ allPast: true }, false, undefined, "A1 끝난 카드 · 엿보기 값 부재(새 변수) · 기억 없음 → 접힘");
is({ allPast: true, opened: true }, false, undefined, "A2 ★하던 때 펴 둔 기억(grpOpened)이 있어도 접힘 — 사진의 그 카드");
is({ allPast: true, active: true }, false, undefined, "A3 보고 있는 세션이 들어 있어도 접힘 · 기억에 안 적는다");
is({ allPast: true, auto: true }, false, undefined, "A4 자동 걸쇠(grpAuto)가 있어도 접힘");
is({ allPast: true, opened: true, active: true, auto: true, asks: true }, false, undefined, "A5 기억·신호가 다 있어도 접힘");
is({ allPast: true, closed: true }, false, undefined, "A6 사람이 접어 둔 끝난 카드 → 접힘");
// ── B. 사람이 이 페이지에서 편·접은 끝난 카드 ──────────────────────────────
is({ allPast: true, peek: true }, true, undefined, "B1 사람이 폈다(peek) → 펴짐 · 기억에 안 적는다");
is({ allPast: true, peek: true, closed: true }, true, undefined, "B2 예전에 접어 둔 카드라도 지금 편 게 이긴다");
is({ allPast: true, peek: false, opened: true, active: true }, false, undefined, "B3 사람이 도로 접었다 → 접힘");
// ── C. 찾는 중 ────────────────────────────────────────────────────────────
is({ allPast: true, searching: true }, true, undefined, "C1 찾는 중이면 끝난 카드도 편다(#1719)");
is({ allPast: true, searching: true, peek: false }, true, undefined, "C2 찾는 중이면 접어 둔 끝난 카드도 편다");
is({ searching: true, closed: true }, true, undefined, "C3 찾는 중이면 사람이 접은 도는 카드도 편다");
// ── D. 도는 세션이 있는 카드 — 종전 규칙 그대로 ───────────────────────────
is({}, false, undefined, "D1 아무 일 없음 → 접힘");
is({ closed: true, asks: true, active: true }, false, undefined, "D2 사람이 접었다 → 확인 필요·보고 있음도 안 뒤집는다");
is({ opened: true }, true, undefined, "D3 사람이 폈다 → 펴짐");
is({ auto: true }, true, undefined, "D4 자동 걸쇠 → 펴짐");
is({ active: true }, true, "opened", "D5 보고 있는 카드 → 펴고 «편 것»으로 남긴다(선택이 옮겨 가도 안 접힘)");
is({ active: true, opened: true }, true, undefined, "D6 이미 편 기억이 있으면 다시 안 적는다");
is({ asks: true }, true, "auto", "D7 확인 필요·완료 → 한 번 펴고 걸쇠");
is({ asks: true, auto: true }, true, undefined, "D8 걸쇠가 이미 있으면 다시 안 적는다");
is({ peek: true }, false, undefined, "D9 도는 카드에선 엿보기로 펴지 않는다 — 영속 기억이 정본");

// ── E. 배선 — 판정이 맞아도 안 부르면 화면은 그대로다 ─────────────────────
const side = readFileSync(path.join(root, "web/v2/side.ts"), "utf8");
const code = side.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
const loop = code.slice(code.indexOf("function projGroups("), code.indexOf("function grpSums("));
check(/cardOpenVerdict\(\{/.test(loop), "E1 projGroups 가 카드 펼침을 cardOpenVerdict 로 정한다");
check(/allPast\s*=\s*!g\.live\s*&&\s*g\.past\s*>\s*0/.test(loop), "E2 끝난 카드 판정 = 도는 줄 0 · 끝난 줄 ≥1");
check(/peek:\s*pastPeek\.get\(g\.key\)/.test(loop), "E3 사람이 편 끝난 카드(pastPeek)를 넘긴다");
check(/if \(!allPast\) pastPeek\.delete\(g\.key\)/.test(loop), "E4 도는 세션이 생기면 엿보기를 비운다 — 다시 끝나면 또 접힌다");
check(!/grpOpened\.add\(g\.key\)/.test(loop.replace(/if \(v\.remember === 'opened'\)[^\n]*/, "")),
  "E5 «보고 있어서 편 것» 은 판정이 시킬 때만 기억에 적는다(끝난 카드엔 안 적힌다)");
const tog = code.slice(code.indexOf("function toggleGrp("), code.indexOf("function toggleGrp(") + 600);
check(/if \(allPast\) \{ pastPeek\.set\(key, !wasOpen\);[^}]*return; \}/.test(tog),
  "E6 끝난 카드 접기·펴기는 페이지 수명(pastPeek)만 — 영속 기억(grpClosed·grpOpened)을 안 건드린다");
const head = code.slice(code.indexOf("function projGrpHead("), code.indexOf("function grpFacesEl("));
check((head.match(/toggleGrp\(g\.key, [^)]*allPast\)/g) || []).length === 2,
  "E7 머리줄의 두 손짓(클릭 · 더블클릭 되돌리기)이 모두 allPast 를 넘긴다");

// ── F. 실제 루프를 돌린다 — 사진의 상태(하던 때 펴 둔 카드가 전부 끝남)를 재현 ─────────
//  side.ts 의 펼침 루프 본문을 그대로 떼어 실행한다(주변 재료만 스텁). 판정·배선을 한 번에 본다.
{
  const start = side.indexOf("  for (const g of groups) {\n    //  펼침");
  const end = side.indexOf("  return ordered;\n}", start);
  const body = start > 0 && end > start ? side.slice(start, end) : "";
  check(!!body, "F0 펼침 루프를 찾았다(배선 확인의 전제)");
  const js = body;   // 이 루프 본문엔 타입 표기가 없다 — 있으면 F0 뒤에서 SyntaxError 로 빨갛게 드러난다
  const run = (groups, st) => {
    const saved = [];
    const f = new Function("groups", "searching", "grpClosed", "grpOpened", "grpAuto", "pastPeek", "OPENS", "saveSet", "GRPOPENED_STORE", "cardOpenVerdict", js);
    f(groups, false, st.closed, st.opened, st.auto, st.peek, { waiting: true, done: true }, (k) => saved.push(k), "k", cardOpenVerdict);
    return saved;
  };
  const card = (key, live, past, extra = {}) => ({ key, live, past, rows: [], active: false, open: true, ...extra });
  const st = () => ({ closed: new Set(), opened: new Set(["p:1", "p:2"]), auto: new Set(), peek: new Map() });

  let s = st(); const g1 = card("p:1", 0, 2), g2 = card("p:2", 1, 1);
  run([g1, g2], s);
  check(g1.open === false, "F1 ★펴 둔 기억이 있는 끝난 카드 → 접힘(프로젝트 이름만)", `open=${g1.open}`);
  check(g2.open === true, "F2 펴 둔 기억이 있는 도는 카드 → 그대로 펴짐", `open=${g2.open}`);

  s = st(); s.opened = new Set(); const g3 = card("p:3", 0, 1, { active: true });
  const saved = run([g3], s);
  check(g3.open === false && !s.opened.has("p:3") && !saved.length, "F3 보고 있는 끝난 카드 → 접힘 · 기억에 안 적힘",
    `open=${g3.open} opened=${[...s.opened]} saved=${saved}`);

  s = st(); s.peek.set("p:1", true); const g4 = card("p:1", 0, 2);
  run([g4], s);
  check(g4.open === true, "F4 사람이 이 페이지에서 편 끝난 카드 → 펴짐", `open=${g4.open}`);

  s = st(); s.peek.set("p:2", true); const g5 = card("p:2", 1, 0);
  run([g5], s);
  check(!s.peek.has("p:2"), "F5 도는 세션이 생긴 카드는 엿보기 값을 버린다", `peek=${[...s.peek]}`);
}

console.log(`\n${pass} ok · ${fail} fail`);
process.exit(fail ? 1 : 0);
