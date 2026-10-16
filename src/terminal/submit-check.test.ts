// 제출 확인(#4818) — 입력칸 판정(inputHolds)과 지킴이(submitGuard)의 표 시험.
//
//  ── 무엇을 지키나 ──
//  지킴이가 누르는 Enter 는 **입력칸에 있는 무엇이든** 제출한다. 그래서 «우리 글일 때만» 이 이 모듈의 전부다 — 빈 칸·사람이 쓰던 글·
//   예시 글·대화상자에서 누르면 그것이 사고다(불려 나온 지난 지시가 다시 가거나, 승인 창의 기본 선택이 눌린다).
//  화면은 2026-10-16 이 맥에서 띄운 Claude Code 2.1.301 의 맨글(capture-pane -p) 모양 그대로다 — «❯» 다음은 NBSP 다.
//  엣지 표는 스크래치패드 spec.md 의 H1~H15 · G1~G12.
import assert from "node:assert/strict";
import test from "node:test";
import * as sc from "./submit-check.js";

const { inputHolds, submitGuard, SUBMIT_POLL_MS, SUBMIT_STUCK_MS, SUBMIT_PRESS_MAX, TAIL_MATCH_MIN, PASTE_COLLAPSE_UNITS } = sc;

const NB = "\u{A0}";
const RULE = "─".repeat(100);
const FOOT = "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 6 agents                     ◐ medium · /effort";
const HEAD = [" ▐▛███▛█   Claude Code v2.1.301", "▝▜██████▀  Haiku 5.5 · Claude Max", " ▝▝   ▝▝   /…/repro/work", ""];
/** Claude Code 화면 — 입력칸 줄들을 가로줄 둘 사이에 넣는다. */
const screen = (box: string[], foot = FOOT): string => [...HEAD, RULE, ...box, RULE, foot].join("\n");
const LONG = "Reply with only the word OK. This is a long test prompt typed by the outbox to check Enter handling.";

// ── 입력칸 판정 ──────────────────────────────────────────────────────────────────

test("H1·H14 입력칸에 우리 글 한 줄(«❯» 다음 NBSP) — ours", () => {
  assert.equal(inputHolds(screen([`❯${NB}${LONG}`]), LONG), "ours");
  assert.equal(inputHolds(screen([`❯ ${LONG}`]), LONG), "ours", "보통 공백이어도 같다");
});

test("H2 우리 글 + 입력칸 안 빈 줄(Enter 가 글자 CR 로 박힌 화면 — 2.1.301 실측) — ours", () => {
  assert.equal(inputHolds(screen([`❯${NB}${LONG}`, ""]), LONG), "ours");
  assert.equal(inputHolds(screen([`❯${NB}${LONG}`, "", ""]), LONG), "ours", "빈 줄이 둘이어도(CR 둘)");
});

test("H3 여러 줄로 접힌 우리 글(이어지는 줄 2칸 들여쓰기 · 낱말 경계) — ours", () => {
  const text = "Reply with only the word OK. CHUNK-MARK-1 " + Array.from({ length: 30 }, (_, i) => `word${String(i).padStart(4, "0")}`).join(" ");
  const box = [`❯${NB}${text.slice(0, 70)}`, `  ${text.slice(70, 140).trimStart()}`, `  ${text.slice(140).trimStart()}`];
  assert.equal(inputHolds(screen(box), text), "ours");
});

test("H4 빈 입력칸 — empty(제출됐다)", () => {
  assert.equal(inputHolds(screen([`❯${NB}`]), LONG), "empty");
  assert.equal(inputHolds(screen(["❯"]), LONG), "empty");
});

test("H5 빈 칸의 예시 글(맨글로는 흐림을 못 가린다) — 우리 글이 아니니 other", () => {
  assert.equal(inputHolds(screen([`❯${NB}Try "edit <filepath> to..."`]), LONG), "other");
});

test("H6·H7 다른 글 · 우리 글 뒤에 사람이 덧붙인 글 — other(누르면 그 글이 나간다)", () => {
  assert.equal(inputHolds(screen([`❯${NB}지난번 지시를 다시 해 줘`]), LONG), "other");
  assert.equal(inputHolds(screen([`❯${NB}${LONG} 그리고 이것도`]), LONG), "other");
  assert.equal(inputHolds(screen([`❯${NB}${LONG.slice(0, 40)}`]), LONG), "other", "앞부분만 보이는 것은 아직 다 안 들어간 것 — 누르지 않는다");
});

test("H8 승인 대화상자 — dialog(Enter 가 기본 선택을 고른다)", () => {
  const dialog = [
    ...HEAD, RULE,
    " Bash command",
    " Create empty file perm-test-4695.txt",
    "╌".repeat(60), " touch perm-test-4695.txt", "╌".repeat(60),
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and always allow access to repro/ from this project",
    "   3. No",
    " Esc to cancel · Tab to amend",
  ].join("\n");
  assert.equal(inputHolds(dialog, LONG), "dialog");
});

test("H9 입력칸이 없는 화면(부팅) — unknown", () => {
  assert.equal(inputHolds([...HEAD, "✻ Loading…"].join("\n"), LONG), "unknown");
  assert.equal(inputHolds("", LONG), "unknown");
});

test("H10 화면엔 안 그려지는 글자(U+200B·U+FEFF·VS16)가 우리 글에만 있다 — ours", () => {
  const ours = `확인해 줘\u{200B} 지금 바로\u{FEFF} 👍\u{FE0F} 끝`;
  assert.equal(inputHolds(screen([`❯${NB}확인해 줘 지금 바로 👍 끝`]), ours), "ours");
});

test("H11 옛 상자(╭─╮ │ > 글 │ ╰─╯) — ours · 빈 상자는 empty", () => {
  const box = (inner: string): string => ["╭" + "─".repeat(40) + "╮", `│ > ${inner.padEnd(36)} │`, "╰" + "─".repeat(40) + "╯", "  ? for shortcuts"].join("\n");
  assert.equal(inputHolds(box("안녕하세요"), "안녕하세요"), "ours");
  assert.equal(inputHolds(box(""), "안녕하세요"), "empty");
});

test("H12 우리 글이 비었다(부른 쪽이 빈 글을 줬다) — 입력칸에 글이 있으면 other(우리 것이라 말할 근거가 없다)", () => {
  assert.equal(inputHolds(screen([`❯${NB}무언가`]), ""), "other");
  assert.equal(inputHolds(screen([`❯${NB}무언가`]), " \u{200B} "), "other", "보이지 않는 글자뿐이어도 같다");
});

test(`H13 경계 — 위가 잘려 꼬리만 보이면 ${TAIL_MATCH_MIN}자 이상일 때만 ours(정확히 ${TAIL_MATCH_MIN} → ours · ${TAIL_MATCH_MIN - 1} → other)`, () => {
  const tail = "abcdefghijklmnopqrstuvwxyz0123456789".slice(0, TAIL_MATCH_MIN);
  const ours = "가나다라마바사아자차카타파하" + tail;
  assert.equal(inputHolds(screen([`❯${NB}${tail}`]), ours), "ours");
  assert.equal(inputHolds(screen([`❯${NB}${tail.slice(1)}`]), ours), "other");
});

test("H15 번호 목록 대화 위에 입력칸 안내가 보이면 대화상자가 아니다 — 입력칸을 읽는다(ours)", () => {
  const pane = [...HEAD, "⏺ 고를 수 있는 것:", "  ❯ 1. 첫째", "    2. 둘째", "", RULE, `❯${NB}${LONG}`, RULE, FOOT].join("\n");
  assert.equal(inputHolds(pane, LONG), "ours");
});

//  기본 권한 모드는 입력칸에 글이 있으면 꼬리 안내(«? for shortcuts»)를 감추고, 모드 표시도 안 그린다(2.1.301 — 격리 리뷰).
const NOFOOT = "";
test("H16 꼬리 안내가 없는 화면(기본 모드 · 입력칸에 글) — «1. …» 로 시작하는 우리 글도 ours(대화상자로 오판하지 않는다)", () => {
  const ours = "1. 로그를 읽고 2. 원인을 찾고 3. 고쳐 줘 — 번호로 시작하는 지시도 우리 글이다.";
  assert.equal(inputHolds(screen([`❯${NB}${ours}`, ""], NOFOOT), ours), "ours");
});

test("H17 꼬리 안내가 없고 위 대화에 «❯ 1.» 사람 말이 남아 있어도 — 입력칸이 우리 글이면 ours", () => {
  const pane = [...HEAD, "❯ 1. 첫째 할 일", "  2. 둘째 할 일", "⏺ 알겠습니다.", "", RULE, `❯${NB}${LONG}`, RULE, NOFOOT].join("\n");
  assert.equal(inputHolds(pane, LONG), "ours");
  assert.equal(inputHolds(pane, "다른 지시"), "dialog", "우리 글이 아니면 종전 판정(대화상자 보수적)으로 돌아간다");
});

test(`H18·H19 접힌 붙여넣기 표시만 남은 입력칸 — 우리 글이 ${PASTE_COLLAPSE_UNITS}자 넘을 때만 ours(경계: 정확히 ${PASTE_COLLAPSE_UNITS} → other · +1 → ours)`, () => {
  const long = "가".repeat(PASTE_COLLAPSE_UNITS + 1);
  assert.equal(inputHolds(screen([`❯${NB}[Pasted text #1]`]), long), "ours");
  assert.equal(inputHolds(screen([`❯${NB}[Pasted text #2 +3 lines]`]), long), "ours");
  assert.equal(inputHolds(screen([`❯${NB}[Pasted text #1]`]), "가".repeat(PASTE_COLLAPSE_UNITS)), "other");
  assert.equal(inputHolds(screen([`❯${NB}[Pasted text #1] 그리고 사람이 덧붙인 글`]), long), "other");
});

// ── 지킴이 ──────────────────────────────────────────────────────────────────────

/** 가짜 화면·시계 — 박자마다 무엇을 했는지(peek·enter) 남긴다. pane 은 지금 보여 줄 화면(함수면 부를 때마다). */
function rig(pane: string | null | (() => string | null), o: { enterThrows?: boolean; peekThrows?: boolean } = {}) {
  const clock = { t: 0 };
  const log: string[] = [];
  const g = submitGuard({
    peek: async () => {
      log.push("peek");
      if (o.peekThrows) throw new Error("tmux 무응답");
      const p = typeof pane === "function" ? pane() : pane;
      return p === null ? { ok: false } : { ok: true, pane: p };
    },
    enter: async () => { log.push("enter"); if (o.enterThrows) throw new Error("send-keys 실패"); },
    now: () => clock.t,
  }, LONG);
  /** ms 만큼 시계를 민 뒤 박자 하나 */
  const step = async (ms: number): Promise<string[]> => { clock.t += ms; const before = log.length; await g.tick(); return log.slice(before); };
  return { g, log, clock, step };
}
const STUCK = screen([`❯${NB}${LONG}`, ""]);

test("G1 직전 걸음으로부터 간격이 덜 찬 박자는 아무것도 안 한다(보기 0)", async () => {
  const r = rig(STUCK);
  assert.deepEqual(await r.step(SUBMIT_POLL_MS - 1), []);
  assert.deepEqual(await r.step(1), ["peek"], "간격이 차면 본다(경계: 정확히 SUBMIT_POLL_MS)");
  assert.deepEqual(await r.step(SUBMIT_POLL_MS - 1), [], "본 직후도 간격을 지킨다");
});

test("G2 우리 글이 Enter 뒤 1.5초 넘게 남아 있으면 — 그 박자엔 보기만, 다음 박자에 Enter(그 박자엔 보기 없음)", async () => {
  const r = rig(STUCK);
  assert.deepEqual(await r.step(SUBMIT_STUCK_MS + 100), ["peek"]);
  assert.equal(r.g.last(), "ours");
  assert.deepEqual(await r.step(SUBMIT_POLL_MS), ["enter"], "누르는 박자에 RPC 를 둘 쓰면 한 행의 시간 상한이 깨진다");
  assert.equal(r.g.presses(), 1);
});

test("G3 경계 — 마지막 Enter 뒤 1,499ms 에 본 우리 글은 누르지 않고, 1,500ms 면 누른다", async () => {
  const early = rig(STUCK);
  assert.deepEqual(await early.step(SUBMIT_STUCK_MS - 1), ["peek"]);
  assert.deepEqual(await early.step(SUBMIT_POLL_MS), ["peek"], "아직 1.5초가 안 된 관측으로 누르면 바쁜 순간에 덧누른다");
  const exact = rig(STUCK);
  assert.deepEqual(await exact.step(SUBMIT_STUCK_MS), ["peek"]);
  assert.deepEqual(await exact.step(SUBMIT_POLL_MS), ["enter"]);
});

test(`G4·G11 계속 우리 글이면 1.5초씩 띄워 다시 — 총 ${SUBMIT_PRESS_MAX}번에서 멈춘다 · 그 뒤 창 끝 Enter 도 없다`, async () => {
  const r = rig(STUCK);
  for (let i = 0; i < 40; i++) await r.step(SUBMIT_POLL_MS);
  assert.equal(r.log.filter((x) => x === "enter").length, SUBMIT_PRESS_MAX);
  assert.equal(r.g.presses(), SUBMIT_PRESS_MAX);
  assert.equal(r.g.shouldPressAtWindowEnd(), false, "상한을 채웠는데 창 끝에서 또 누른다");
  //  누른 뒤 1.5초가 안 됐으면 다시 안 누른다 — 누른 박자 다음의 첫 관측은 누를 차례를 만들지 않는다.
  const s = rig(STUCK);
  await s.step(SUBMIT_STUCK_MS); await s.step(SUBMIT_POLL_MS);            // 본다 → 누른다
  assert.deepEqual(await s.step(SUBMIT_POLL_MS), ["peek"]);              // 누른 지 1초 — 보기만
  assert.deepEqual(await s.step(SUBMIT_POLL_MS), ["peek"], "누른 지 1초 뒤 관측(1.5초 전)으로 누를 차례를 만들었다");
});

test("G5·G6·G7 빈 칸·다른 글·대화상자 — 박자에서도, 창 끝에서도 안 누른다", async () => {
  const panes: Record<string, string> = {
    empty: screen([`❯${NB}`]),
    other: screen([`❯${NB}사람이 쓰던 글`]),
    dialog: [...HEAD, RULE, " Do you want to proceed?", " ❯ 1. Yes", "   2. No", " Esc to cancel · Tab to amend"].join("\n"),
  };
  for (const [want, pane] of Object.entries(panes)) {
    const r = rig(pane);
    for (let i = 0; i < 10; i++) await r.step(SUBMIT_POLL_MS);
    assert.equal(r.g.last(), want);
    assert.equal(r.log.filter((x) => x === "enter").length, 0, `${want}: 눌렀다`);
    assert.equal(r.g.shouldPressAtWindowEnd(), false, `${want}: 창 끝에서 누른다`);
  }
});

test("G8·G9·G10 화면을 못 읽음(ok:false·던짐)·입력칸을 모름·아직 안 봄 — 박자에선 안 누르고, 창 끝에선 종전대로 누른다", async () => {
  for (const r of [rig(null), rig(STUCK, { peekThrows: true }), rig([...HEAD, "✻ Loading…"].join("\n"))]) {
    for (let i = 0; i < 10; i++) await r.step(SUBMIT_POLL_MS);
    assert.equal(r.log.filter((x) => x === "enter").length, 0);
    assert.equal(r.g.shouldPressAtWindowEnd(), true, "모르는 화면에서 창 끝 Enter 를 뺐다 — #1867 빈 폴더 첫 지시가 다시 막힌다");
  }
  assert.equal(rig(STUCK).g.shouldPressAtWindowEnd(), true, "G10 박자가 한 번도 없었다");
});

test("G12 Enter 가 던져도 삼키고 누른 수에 센다 · 창 끝 Enter 도 같다", async () => {
  const r = rig(STUCK, { enterThrows: true });
  await r.step(SUBMIT_STUCK_MS); await r.step(SUBMIT_POLL_MS);
  assert.equal(r.g.presses(), 1);
  assert.equal(await r.g.pressAtWindowEnd(), true, "누른 뒤 아직 안 본 화면 = 모름 → 종전대로 누른다");
  assert.equal(r.g.presses(), 2);
});

test(`G13 창 끝 Enter 는 지킴이가 상한을 쥔다 — ${SUBMIT_PRESS_MAX}번 뒤엔 눌러 달라고 해도 안 누른다 · 빈 칸이면 안 누른다`, async () => {
  const r = rig(STUCK);
  for (let i = 0; i < 40; i++) await r.step(SUBMIT_POLL_MS);
  const before = r.log.filter((x) => x === "enter").length;
  assert.equal(await r.g.pressAtWindowEnd(), false);
  assert.equal(r.log.filter((x) => x === "enter").length, before);
  const e = rig(screen([`❯${NB}`]));
  await e.step(SUBMIT_POLL_MS);
  assert.equal(await e.g.pressAtWindowEnd(), false);
  assert.equal(e.log.filter((x) => x === "enter").length, 0);
});

test("G-흐름 글자 CR → «검토 후 Enter» → 제출: 우리 글이 사라지면 더 안 누른다", async () => {
  //  2.1.301 실측 순서 — 첫 Enter 가 글자 CR(빈 줄), 둘째가 그걸 지우고 멈춤(같은 글이 남는다), 셋째에 제출(빈 칸).
  let presses = 0;
  const r = rig(() => (presses >= 2 ? screen([`❯${NB}`]) : STUCK));
  for (let i = 0; i < 20; i++) { const did = await r.step(SUBMIT_POLL_MS); if (did.includes("enter")) presses++; }
  assert.equal(presses, 2, "제출된 뒤에도 눌렀거나, 남아 있는데 덜 눌렀다");
  assert.equal(r.g.last(), "empty");
  assert.equal(r.g.shouldPressAtWindowEnd(), false);
});
