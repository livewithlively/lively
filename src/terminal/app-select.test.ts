// Claude Code 입력칸 선택(#4406 후속) — 순수 판정 web/standalone/app-select.ts 의 사양 시험.
//  스크래치패드 spec-kbsel.md 의 엣지 표 행 번호(K·D·X·C·T·A·H·N·P·S·Z)를 이름 앞에 단다. 화면 사실(앱 선택의 칸 규칙·
//  빈칸도 칠함·더블클릭 창)은 격리 tmux 의 실제 Claude Code 2.1.283 에서 잰 값이다(app-select.ts 머리말).
//  fail-first: APPSEL_MOD=<변이 산출물> 로 다른 모듈을 물린다 — 어느 줄을 깨면 어느 행이 빨개지는지는 PR 본문에 적었다.
// 실행: npm run build && node dist/terminal/app-select.test.js
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MOD_URL = pathToFileURL(process.env.APPSEL_MOD || path.resolve(here, "..", "standalone", "app-select.js")).href;
const A: any = await import(MOD_URL);

// ── 화면 고정물 — 한글·전각은 두 칸(뒤 칸 w=0), 그 밖 한 칸. 줄 끝은 빈칸으로 채운다. ──
const wide = (ch: string): boolean => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch);
type Cell = { ch: string; w: number; bg: boolean; dim: boolean };
function rowCells(text: string, cols: number, opt: { bg?: [number, number]; dimFrom?: number } = {}): Cell[] {
  const out: Cell[] = [];
  for (const ch of Array.from(text)) {
    const w = wide(ch) ? 2 : 1;
    out.push({ ch, w, bg: false, dim: false });
    if (w === 2) out.push({ ch: "", w: 0, bg: false, dim: false });
  }
  while (out.length < cols) out.push({ ch: " ", w: 1, bg: false, dim: false });
  out.length = cols;
  if (opt.dimFrom !== undefined) for (let x = opt.dimFrom; x < cols; x++) out[x].dim = true;
  return out;
}
const RULE = "─".repeat(40);
function screen(lines: string[], cols = 40): any {
  const rows = lines.map((t) => rowCells(t, cols));
  return { cols, rows: rows.length, row: (r: number) => rows[r] || null, _rows: rows };
}
/** 칸 범위 [first,last](읽는 순서, 양끝 포함)를 앱처럼 칠한다 — 빈칸까지. */
function paint(s: any, first: { row: number; col: number }, last: { row: number; col: number }): void {
  for (let r = first.row; r <= last.row; r++) {
    const x0 = r === first.row ? first.col : 0, x1 = r === last.row ? last.col : s.cols - 1;
    for (let x = x0; x <= x1; x++) s._rows[r][x].bg = true;
  }
}
// 입력칸: 3~5행, 커서 = 셋째 줄 끝(5, 19)
const L = ["", "hello", RULE, "❯ 첫째 줄 안녕하세요", "  둘째 줄 반갑습니다", "  셋째 줄 좋은 하루", RULE, "  ⏵⏵ auto mode on"];
const caret = { row: 5, col: 19 };
const P = (row: number, col: number) => ({ row, col });

const tests: Array<[string, () => void]> = [];
const t = (name: string, fn: () => void): void => { tests.push([name, fn]); };

// ── 입력칸 찾기 (Z0·N2) ──
t("Z0 가로줄 두 줄 사이 · 첫 행 «❯ » → 입력칸 3~5행, 글자는 2칸부터", () => {
  assert.deepEqual(A.findBox(screen(L), caret), { top: 3, bottom: 5, start: 2 });
});
t("Z0 아래 가로줄이 없으면 입력칸이 아니다(손대지 않는다)", () => {
  assert.equal(A.findBox(screen(L.slice(0, 6)), caret), null);
});
t("N2 가로줄 밑에 발치가 너무 길면(대화 중간의 구분선) 입력칸이 아니다", () => {
  const long = [...L.slice(0, 7), ...Array(9).fill("  more")];
  assert.equal(A.findBox(screen(long), caret), null);
});
t("N2 첫 행이 프롬프트로 시작하지 않으면(목록·대화상자) 입력칸이 아니다", () => {
  const menu = ["", "", RULE, "  1. Yes", "❯ 2. No", "  3. Tell Claude", RULE, "  esc"];
  assert.equal(A.findBox(screen(menu), P(4, 3)), null);
});

const s0 = screen(L), b0 = A.findBox(s0, caret);
const mv = (p: any, m: string, goal: number | null = null) => A.move(s0, b0, p, m, goal, caret);
// ── 글자 단위 이동 (K1~K8) ──
t("K1 ← 한 걸음 = 한 글자(넓은 글자도) — 19 → 17(«루» 앞)", () => { assert.deepEqual(mv(caret, "left").pos, P(5, 17)); });
t("K1 → 한 걸음 = 한 글자 — 둘째 줄 «반»(10) → «갑»(12)", () => { assert.deepEqual(mv(P(4, 10), "right").pos, P(4, 12)); });
t("K1 줄 끝에서 → 는 다음 줄 처음 · 줄 처음에서 ← 는 윗줄 끝", () => {
  assert.deepEqual(mv(P(3, 20), "right").pos, P(4, 2));
  assert.deepEqual(mv(P(4, 2), "left").pos, P(3, 20));
});
t("K2 ↑ 는 윗줄 같은 열 — 넓은 글자 가운데(19)면 그 글자 앞(18)", () => {
  const r = mv(caret, "up");
  assert.deepEqual(r.pos, P(4, 18));
  assert.equal(r.goal, 19);
});
t("K3 목표 열 유지 — 짧은 줄을 지나도 ↓ 로 원래 열에 돌아온다", () => {
  const s = screen(["", "", RULE, "❯ abcdefghij", "  ab", "  abcdefghij", RULE, ""]);
  const b = A.findBox(s, P(5, 9));
  const up1 = A.move(s, b, P(5, 9), "up", null, P(5, 9));
  assert.deepEqual(up1.pos, P(4, 4));                       // 짧은 줄 — 끝에 붙는다
  const down = A.move(s, b, up1.pos, "down", up1.goal, P(5, 9));
  assert.deepEqual(down.pos, P(5, 9));                      // 목표 열 9 로 돌아온다
});
t("K4 첫 줄에서 ↑ 는 입력 맨 앞(가로줄 밖으로 안 나간다)", () => { assert.deepEqual(mv(P(3, 9), "up").pos, P(3, 2)); });
t("K5 마지막 줄에서 ↓ 는 입력 맨 끝", () => { assert.deepEqual(mv(P(5, 4), "down").pos, P(5, 19)); });
t("K6 입력 처음 / 끝", () => {
  assert.deepEqual(mv(P(4, 10), "inputStart").pos, P(3, 2));
  assert.deepEqual(mv(P(4, 10), "inputEnd").pos, P(5, 19));
});
t("K7 그 줄 처음 / 끝", () => {
  assert.deepEqual(mv(P(4, 10), "lineStart").pos, P(4, 2));
  assert.deepEqual(mv(P(4, 10), "lineEnd").pos, P(4, 20));
});
t("K8 단어 단위 — «반갑습니다» 가운데에서 ⌥← 는 단어 앞, ⌥→ 는 단어 끝", () => {
  assert.deepEqual(mv(P(4, 14), "wordLeft").pos, P(4, 10));
  assert.deepEqual(mv(P(4, 14), "wordRight").pos, P(4, 20));
});
t("K8 빈 입력의 안내 글(흐린 글자)은 글자가 아니다 — 줄 끝 = 캐럿", () => {
  const s = screen(["", "", RULE, "❯ Try \"fix typecheck\"", RULE, ""]);
  for (let x = 2; x < s.cols; x++) s._rows[3][x].dim = true;
  const b = A.findBox(s, P(3, 2));
  assert.equal(A.lineEnd(s, b, 3, P(3, 2)), 2);
});

// ── 캐럿 자리 → 앱 선택 칸 (K9 · 줄바꿈 규칙) ──
t("K9 길이 0 이면 칠할 것도 지울 것도 없다(null)", () => { assert.equal(A.rangeCells(P(4, 10), P(4, 10)), null); });
t("K1 «루» 한 글자 = 칸 17~18(넓은 글자는 뒤 칸이 끝 칸)", () => {
  assert.deepEqual(A.rangeCells(caret, P(5, 17)), { first: P(5, 17), last: P(5, 18) });
});
t("K2 두 줄 선택 — 앞 자리 칸부터 뒤 자리 바로 앞 칸까지(방향 무관)", () => {
  assert.deepEqual(A.rangeCells(caret, P(4, 18)), { first: P(4, 18), last: P(5, 18) });
});
t("D1 줄 끝 → 다음 줄 처음 = 줄바꿈 하나: 끝 칸은 들여쓰기 칸(앱이 다음 줄 첫 글자를 안 지운다 — 실측)", () => {
  assert.deepEqual(A.rangeCells(P(3, 20), P(4, 2)), { first: P(3, 20), last: P(4, 1) });
});
t("X2 앱이 칠한 칸 범위 → 캐럿 자리(끝 칸이 넓은 글자의 앞 칸이면 그 글자 뒤까지)", () => {
  assert.deepEqual(A.cellsToRange(s0, P(4, 10), P(4, 12)), { from: P(4, 10), to: P(4, 14) });
  assert.deepEqual(A.cellsToRange(s0, P(4, 10), P(4, 13)), { from: P(4, 10), to: P(4, 14) });
});

// ── 클립보드 글자 (X1·C1) ──
t("C1 여러 줄 — 들여쓰기는 빼고 사람이 친 줄바꿈은 \\n", () => {
  assert.equal(A.selText(s0, b0, P(4, 18), caret, caret), "다\n셋째 줄 좋은 하루");
});
t("C1 자동 줄바꿈(다음 단어가 안 들어가 내려간 것)은 띄어쓰기 하나", () => {
  // 폭 40 → 글자 폭 37. 윗줄 글자 30칸 + 띄어쓰기 + 다음 단어 10칸 = 41 > 37 → 자동 줄바꿈이다
  const s = screen(["", "", RULE, "❯ " + "가나다라마바사아자차카타파하하", "  가나다라마", RULE, ""]);
  const b = A.findBox(s, P(4, 12));
  assert.equal(A.selText(s, b, P(3, 26), P(4, 6), P(4, 12)), "파하하 가나");
});
t("C1 자리가 있었는데 내려간 줄은 사람이 친 줄바꿈 — \\n", () => {
  const s = screen(["", "", RULE, "❯ 짧은 줄", "  둘째", RULE, ""]);
  const b = A.findBox(s, P(4, 6));
  assert.equal(A.selText(s, b, P(3, 2), P(4, 6), P(4, 6)), "짧은 줄\n둘째");
});

// ── 합성 끌기 (D1 · 한 칸 · 방향) ──
t("D1 끌기 = 누름 → 눌린 채 이동 → 뗌(1-기준 SGR), 누를 쪽을 고를 수 있다", () => {
  assert.equal(A.dragSeq(P(4, 18), P(5, 18), "first", 40), "\x1b[<0;19;5M\x1b[<32;19;6M\x1b[<0;19;6m");
  assert.equal(A.dragSeq(P(4, 18), P(5, 18), "last", 40), "\x1b[<0;19;6M\x1b[<32;19;5M\x1b[<0;19;5m");
});
t("D1 한 칸짜리는 옆 칸에 갔다 돌아와 뗀다(제자리 누름·뗌은 클릭이다 — 실측)", () => {
  assert.equal(A.dragSeq(P(3, 8), P(3, 8), "first", 40), "\x1b[<0;9;4M\x1b[<32;10;4M\x1b[<32;9;4M\x1b[<0;9;4m");
});
t("A1 클릭 = 같은 칸 누름·뗌", () => { assert.equal(A.clickSeq(P(5, 19)), "\x1b[<0;20;6M\x1b[<0;20;6m"); });

// ── 더블클릭 오인 피하기 (P1) ──
t("P1 직전 누름이 0.6초 밖이면 첫 칸에서 바로", () => {
  assert.deepEqual(A.pressPlan({ row: 4, col: 18, at: 0 }, P(4, 18), P(5, 18), 700), { press: "first", wait: 0 });
});
t("P1 첫 칸이 직전 누름과 1칸 이내 · 0.6초 안 → 먼 쪽(끝 칸)에서 누른다", () => {
  assert.deepEqual(A.pressPlan({ row: 4, col: 19, at: 1000 }, P(4, 18), P(5, 10), 1100), { press: "last", wait: 0 });
});
t("P1 두 끝이 다 가까우면 창이 지날 때까지 기다린다(경계 1칸)", () => {
  assert.deepEqual(A.pressPlan({ row: 3, col: 9, at: 1000 }, P(3, 8), P(3, 8), 1100), { press: "first", wait: 500 });
});
t("P1 행이 2칸 떨어지면 가깝지 않다(경계)", () => {
  assert.equal(A.nearPress({ row: 2, col: 8, at: 1000 }, P(4, 8), 1100), false);
  assert.equal(A.nearPress({ row: 3, col: 8, at: 1000 }, P(4, 9), 1100), true);
});

// ── 앱이 칠했나 (D1·D2) ──
t("D1 범위(빈칸 포함)가 전부 칠해지고 바로 앞·뒤가 안 칠해졌으면 맞다", () => {
  const s = screen(L); const b = A.findBox(s, caret);
  paint(s, P(4, 18), P(5, 18));
  assert.equal(A.highlightMatches(s, b, P(4, 18), P(5, 18)), true);
});
t("D2 한 칸이라도 더 칠해졌으면(앱이 다른 범위를 골랐다) 틀리다 → 안 지운다", () => {
  const s = screen(L); const b = A.findBox(s, caret);
  paint(s, P(4, 16), P(5, 18));
  assert.equal(A.highlightMatches(s, b, P(4, 18), P(5, 18)), false);
});
t("D2 덜 칠해졌거나 안 칠해졌으면 틀리다", () => {
  const s = screen(L); const b = A.findBox(s, caret);
  assert.equal(A.highlightMatches(s, b, P(4, 18), P(5, 18)), false);
  paint(s, P(4, 18), P(5, 10));
  assert.equal(A.highlightMatches(s, b, P(4, 18), P(5, 18)), false);
});
t("D1 줄바꿈만 고른 선택(글자 칸 0)도 빈칸 칠함으로 가린다", () => {
  const s = screen(L); const b = A.findBox(s, caret);
  paint(s, P(3, 20), P(4, 1));
  assert.equal(A.highlightMatches(s, b, P(3, 20), P(4, 1)), true);
});

// ── 앱이 칠해 둔 선택 읽기 (X2·X3) ──
t("X2 입력칸 안에 칠해진 한 덩이 → 그 칸 범위", () => {
  const s = screen(L); const b = A.findBox(s, caret);
  paint(s, P(4, 10), P(4, 19));
  assert.deepEqual(A.scanHighlight(s, b), { first: P(4, 10), last: P(4, 19) });
});
t("X3 가로줄까지 칠해졌으면(선택이 대화에서 이어짐) 자를 수 없다 → null", () => {
  const s = screen(L); const b = A.findBox(s, caret);
  paint(s, P(1, 0), P(4, 5));
  assert.equal(A.scanHighlight(s, b), null);
});
t("X3 칠한 곳이 두 덩이면 선택이 아니다 → null · 없으면 null", () => {
  const s = screen(L); const b = A.findBox(s, caret);
  assert.equal(A.scanHighlight(s, b), null);
  paint(s, P(3, 2), P(3, 5)); paint(s, P(5, 2), P(5, 5));
  assert.equal(A.scanHighlight(s, b), null);
});

// ── 선택 뒤 입력칸이 바뀜 (S1) ──
t("S1 지문 — 입력칸 글자가 바뀌면 다르다 · 색만 바뀌면 같다", () => {
  const s = screen(L); const b = A.findBox(s, caret);
  const fp = A.boxFingerprint(s, b);
  paint(s, P(4, 10), P(4, 13));
  assert.equal(A.boxFingerprint(s, b), fp);
  const s2 = screen([...L.slice(0, 5), "  셋째 줄 좋은 하루!", ...L.slice(6)]);
  assert.notEqual(A.boxFingerprint(s2, A.findBox(s2, caret)), fp);
});

// ── 키 판정 (맥 · 그 밖) ──
const K = (key: string, mods: Record<string, unknown> = {}, hasSel = false, mac = true) => A.decideAppSelKey({ key, ...mods }, { mac, hasSel });
t("K1·K2 Shift+화살표 = 넓히기(선택 유무 무관)", () => {
  assert.deepEqual(K("ArrowLeft", { shiftKey: true }), { k: "extend", m: "left" });
  assert.deepEqual(K("ArrowUp", { shiftKey: true }, true), { k: "extend", m: "up" });
});
t("K6 맥 ⌘⇧↑/↓ = 입력 처음/끝 · Win Ctrl+Shift+Home/End", () => {
  assert.deepEqual(K("ArrowDown", { shiftKey: true, metaKey: true }), { k: "extend", m: "inputEnd" });
  assert.deepEqual(K("Home", { shiftKey: true, ctrlKey: true }, false, false), { k: "extend", m: "inputStart" });
});
t("K7 맥 ⌘⇧←/→ · Shift+Home/End = 그 줄 처음/끝", () => {
  assert.deepEqual(K("ArrowRight", { shiftKey: true, metaKey: true }), { k: "extend", m: "lineEnd" });
  assert.deepEqual(K("Home", { shiftKey: true }, false, false), { k: "extend", m: "lineStart" });
});
t("K8 맥 ⌥⇧← · Win Ctrl+Shift+← = 단어", () => {
  assert.deepEqual(K("ArrowLeft", { shiftKey: true, altKey: true }), { k: "extend", m: "wordLeft" });
  assert.deepEqual(K("ArrowRight", { shiftKey: true, ctrlKey: true }, false, false), { k: "extend", m: "wordRight" });
});
t("H1 맥 ⌘↓/⌘↑ = 캐럿을 입력 끝/처음으로", () => {
  assert.deepEqual(K("ArrowDown", { metaKey: true }), { k: "caret", m: "inputEnd" });
  assert.deepEqual(K("ArrowUp", { metaKey: true }), { k: "caret", m: "inputStart" });
});
t("H1 Windows Ctrl+Home/End 는 뺏지 않는다(Claude Code 의 대화 스크롤 키)", () => {
  assert.deepEqual(K("Home", { ctrlKey: true }, false, false), { k: "pass" });
  assert.deepEqual(K("End", { ctrlKey: true }, false, false), { k: "pass" });
});
t("X1 ⌘X / Win Ctrl+X 는 선택이 없어도 잘라내기 판정(앱이 칠한 마우스 선택을 이어받을 수 있다)", () => {
  assert.deepEqual(K("x", { metaKey: true }), { k: "cut" });
  assert.deepEqual(K("x", { ctrlKey: true }, false, false), { k: "cut" });
});
t("C1 ⌘C 는 우리 선택이 있을 때만 복사 — 없으면 종전 경로(앱 복사 다리)", () => {
  assert.deepEqual(K("c", { metaKey: true }, true), { k: "copy" });
  assert.deepEqual(K("c", { metaKey: true }, false), { k: "pass" });
  assert.deepEqual(K("c", { ctrlKey: true }, false, false), { k: "pass" }); // Win 선택 없는 Ctrl+C = 중단(뺏지 않는다)
});
t("D1 선택 + Backspace/Delete = 지우기", () => {
  assert.deepEqual(K("Backspace", {}, true), { k: "del" });
  assert.deepEqual(K("Delete", {}, true), { k: "del" });
  assert.deepEqual(K("Backspace", {}, false), { k: "pass" });
});
t("T1 선택 + 글자·IME 시작(229) = 덮어쓰기 · 조합 중이면 지우지 않는다", () => {
  assert.deepEqual(K("가", {}, true), { k: "replace" });
  assert.deepEqual(K("Process", { keyCode: 229 }, true), { k: "replace" });
  assert.deepEqual(K("Process", { keyCode: 229, isComposing: true }, true), { k: "clear" });
});
t("A1 선택 + 맨 ←/→ = 선택 앞/뒤로 접기", () => {
  assert.deepEqual(K("ArrowLeft", {}, true), { k: "collapse", to: "start" });
  assert.deepEqual(K("ArrowRight", {}, true), { k: "collapse", to: "end" });
});
t("A2 선택 + ↑·Esc·Enter·Tab·⌘+글자 = 거두고 흘린다 · 수정자 키만 누르면 그대로", () => {
  for (const k of ["ArrowUp", "Escape", "Enter", "Tab"]) assert.deepEqual(K(k, {}, true), { k: "clear" }, k);
  assert.deepEqual(K("z", { metaKey: true }, true), { k: "clear" });
  for (const k of ["Shift", "Meta", "Alt", "Control"]) assert.deepEqual(K(k, {}, true), { k: "pass" }, k);
});
t("T2 글자 넣는 키 — 글자·IME 시작(229)은 맞고, 조합 중·⌘/Ctrl/⌥ 조합·기능키는 아니다", () => {
  assert.equal(A.isTypingKey({ key: "가" }), true);
  assert.equal(A.isTypingKey({ key: "Process", keyCode: 229 }), true);
  assert.equal(A.isTypingKey({ key: "Process", keyCode: 229, isComposing: true }), false);
  assert.equal(A.isTypingKey({ key: "v", metaKey: true }), false);
  assert.equal(A.isTypingKey({ key: "a", altKey: true }), false);
  assert.equal(A.isTypingKey({ key: "Backspace" }), false);
});
t("⌘A 첫 번 = 입력 전체 · 선택이 서 있으면 터미널 전체", () => {
  assert.deepEqual(K("a", { metaKey: true }, false), { k: "selectInput" });
  assert.deepEqual(K("a", { metaKey: true }, true), { k: "selectTerminal" });
});
t("Z0 판 — 실측한 2.1.283 이상만(판을 알 때)", () => {
  assert.equal(A.versionAtLeast("2.1.283", A.APP_SELECT_MIN), true);
  assert.equal(A.versionAtLeast("2.1.290", A.APP_SELECT_MIN), true);
  assert.equal(A.versionAtLeast("2.1.282", A.APP_SELECT_MIN), false);
  assert.equal(A.versionAtLeast("box-spawn", A.APP_SELECT_MIN), false);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log("ok   " + name); }
  catch (e: any) { failed++; console.log("FAIL " + name + "\n     " + String(e && e.message || e).split("\n").slice(0, 6).join("\n     ")); }
}
console.log(`\n${tests.length - failed} passed${failed ? `, ${failed} failed` : ""}`);
process.exit(failed ? 1 : 0);
