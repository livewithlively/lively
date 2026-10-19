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

//  ── 접힌 표시 둘 이상 · 가운데 접힘(격리 리뷰 · 2026-10-16 실측) ──
//   붙여넣기를 모르는 옛 호스트가 긴 글을 덩어리로 치면 덩어리마다 `[Pasted text #N]` 이 생긴다(900자 둘 → `[Pasted text #1][Pasted text #2]`).
//   입력이 1만 자를 넘으면 Claude Code 는 가운데를 `[...Truncated text #N +M lines...]` 로 접는다 — 12,000자를 500자씩 붙였을 때 앞 495자 ·
//   표시 · 뒤 1,969자가 보였다(가로줄 사이 38줄). 둘 다 종전 판정에선 other 라, 그 글이 멈춰 있어도 지킴이가 안 눌렀다(창 끝 Enter 까지).
const KO_UNIT = "세션을 새로 열거나 회수된 세션에 말을 보낼 때 입력칸에 글만 남고 제출되지 않던 문제를 끝단에서 재는 긴 한국어 문장입니다. ";
const KO_LONG = ("OK 라고만 답해 주세요. BOX-long " + KO_UNIT.repeat(220)).slice(0, 12_000).trim();
/** 입력칸 폭으로 꺾어 그린다 — 첫 줄은 «❯ », 이어지는 줄은 두 칸 들여쓰기. */
const wrapped = (s: string, w = 57): string[] => Array.from({ length: Math.ceil(s.length / w) }, (_, i) => (i ? "  " : `❯${NB}`) + s.slice(i * w, (i + 1) * w));

test("H20 접힌 표시가 여럿(옛 호스트가 친 긴 글) — 우리 글이 800자 넘으면 ours", () => {
  const long = KO_LONG.slice(0, 1_800);
  assert.equal(inputHolds(screen([`❯${NB}[Pasted text #1][Pasted text #2]`]), long), "ours");
  assert.equal(inputHolds(screen([`❯${NB}[Pasted text #1 +2 lines] [Pasted text #2]`]), long), "ours");
  assert.equal(inputHolds(screen([`❯${NB}[Pasted text #1][Pasted text #2]`]), long.slice(0, PASTE_COLLAPSE_UNITS)), "other", "800자 이하면 접힐 수 없다");
});

test("H21 가운데가 접힌 1만 자 넘는 우리 글(앞·표시·뒤) — ours · 표시가 줄 끝에서 꺾여도 ours", () => {
  const shown = KO_LONG.slice(0, 495) + "[...Truncated text #1 +0 lines...]" + KO_LONG.slice(KO_LONG.length - 1_969);
  assert.equal(inputHolds(screen(wrapped(shown)), KO_LONG), "ours");
  assert.equal(inputHolds(screen(wrapped(shown, 61)), KO_LONG), "ours", "다른 폭(표시가 다른 자리에서 꺾인다)");
  const mixed = "[Pasted text #1]" + KO_LONG.slice(KO_LONG.length - 300);   // 접힌 덩어리 뒤에 펼쳐진 꼬리
  assert.equal(inputHolds(screen(wrapped(mixed)), KO_LONG.slice(0, 2_000) + KO_LONG.slice(KO_LONG.length - 300)), "ours");
});

test("H22 접힌 표시 + 사람이 쓴 글(앞이나 뒤) — other(누르면 그 글이 나간다)", () => {
  const shown = KO_LONG.slice(0, 495) + "[...Truncated text #1 +0 lines...]" + KO_LONG.slice(KO_LONG.length - 1_969);
  assert.equal(inputHolds(screen(wrapped("잠깐 이것부터 " + shown)), KO_LONG), "other", "앞에 덧붙임");
  assert.equal(inputHolds(screen(wrapped(shown + " 그리고 이것도")), KO_LONG), "other", "뒤에 덧붙임");
  assert.equal(inputHolds(screen([`❯${NB}메모[Pasted text #1]`]), KO_LONG), "other", "사람 글 + 접힌 표시");
});

test("H24 우리 글이 다 펼쳐져 있고 그 앞이나 뒤에 접힌 표시 — 그 표시는 사람이 붙여넣은 다른 글이다: other(격리 리뷰)", () => {
  const ours = KO_LONG.slice(0, 1_200);
  assert.equal(inputHolds(screen(wrapped("[Pasted text #1]" + ours)), ours), "other", "앞에 사람의 붙여넣기");
  assert.equal(inputHolds(screen(wrapped(ours + "[Pasted text #1 +4 lines]")), ours), "other", "뒤에 사람의 붙여넣기");
  assert.equal(inputHolds(screen(wrapped("[Pasted text #1]" + ours.slice(0, 600) + "[Pasted text #2]" + ours.slice(ours.length - 200))), ours), "other",
    "첫 표시가 아무것도 안 감췄다(펼쳐진 조각이 우리 글 맨 앞부터) — 그 표시는 사람 것");
  assert.equal(inputHolds(screen(wrapped("[Pasted text #1][Pasted text #2]" + ours.slice(ours.length - 200))), ours), "ours", "표시가 앞을 감췄으면 우리 글");
});

test(`H25 접힌 표시 옆의 짧은 글 조각 — ${TAIL_MATCH_MIN}자 미만이면 other(«OK[Pasted text #1]» 은 사람 글과 우연히 겹친다) · 경계 ${TAIL_MATCH_MIN} → ours`, () => {
  assert.equal(inputHolds(screen([`❯${NB}OK[Pasted text #1]`]), "OK " + KO_LONG.slice(0, 1_200)), "other");
  const oursNoSpace = "가".repeat(1_000) + "abcdefghijklmnopqrstuvwxyz";   // 꼬리에 공백이 없어야 보이는 길이가 그대로 센다
  assert.equal(inputHolds(screen([`❯${NB}[Pasted text #1]${oursNoSpace.slice(-TAIL_MATCH_MIN)}`]), oursNoSpace), "ours");
  assert.equal(inputHolds(screen([`❯${NB}[Pasted text #1]${oursNoSpace.slice(-(TAIL_MATCH_MIN - 1))}`]), oursNoSpace), "other");
});

test("H23 접힌 표시 앞뒤가 우리 글과 다르다(다른 긴 글) — other · 꼬리가 머리와 겹칠 만큼 짧은 우리 글도 other", () => {
  const other = "다른 지시 " + KO_UNIT.repeat(200);
  const shown = other.slice(0, 495) + "[...Truncated text #1 +0 lines...]" + other.slice(other.length - 1_969);
  assert.equal(inputHolds(screen(wrapped(shown)), KO_LONG), "other");
  const ours = "가".repeat(900);
  assert.equal(inputHolds(screen([`❯${NB}${"가".repeat(500)}[...Truncated text #1 +0 lines...]${"가".repeat(500)}`]), ours), "other",
    "보이는 앞뒤(1,000자)가 우리 글(900자)보다 길다 — 같은 글이 접혔을 리 없다");
});

// ── 지킴이 ──────────────────────────────────────────────────────────────────────

/** 가짜 화면·시계 — 박자마다 무엇을 했는지(peek·enter) 남긴다. pane 은 지금 보여 줄 화면(함수면 부를 때마다). */
function rig(pane: string | null | (() => string | null), o: { enterThrows?: boolean; peekThrows?: boolean; guard?: sc.SubmitGuardOpts } = {}) {
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
  }, LONG, o.guard);
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

// ── #4852 격리 리뷰 후속 — 보이지 않는 것의 집합(U1~U4) · 제어열 든 우리 글(H26) · 다시 보고 누르기(G14) ─────────────────────
//  U — Claude Code 2.1.301 이 지우는 글자(그 번들의 숨은 글자 판정 — 격리 리뷰가 번들에서 옮겼다)를 우리도 모두 지우나. 하나라도 빠지면 그 글자가 든
//   지시는 화면이 «다른 글»(지킴이가 안 누른다 — 입력칸에 남는다) · 기록이 «미확인» 이 된다(한글 채움 문자 U+3164 · CGJ 가 그렇게 빠져 있었다).
function claudeHidden(e: number): boolean {   // 그 판정 그대로 — 조건부로 남기는 것(이모지 뒤 VS16 등)은 무조건 지우는 쪽에 둔다(양쪽에서 지우면 같다)
  if (e < 160) return (e < 32 && e !== 9 && e !== 10) || e >= 127;
  if (e < 8192) return e === 173 || e === 847 || e === 1564 || e === 4447 || e === 4448 || e === 6068 || e === 6069 || (e >= 6155 && e <= 6159);
  if (e < 65536) return (e >= 8203 && e <= 8207) || (e >= 8232 && e <= 8238) || (e >= 8288 && e <= 8303) || e === 12644 || (e >= 65024 && e <= 65039) || e === 65279 || e === 65440 || (e >= 65520 && e <= 65531);
  return e === 69759 || (e >= 78896 && e <= 78911) || e === 94180 || (e >= 113824 && e <= 113827) || (e >= 119155 && e <= 119162) || (e >= 917504 && e <= 921599);
}
//  Claude Code 는 이 글자들을 지우지 않고 **줄바꿈으로 바꾼다**(그 번들의 숨은 글자 처리 nEe 실측 — 격리 리뷰가 바이너리에서 뽑아 돌렸다) — 공백 접기가 맡는다.
const NEWLINED = new Set([0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029]);
const allCodePoints = function* (): Generator<number> { for (let c = 0; c <= 0x10ffff; c++) if (c < 0xd800 || c > 0xdfff) yield c; };
//  글자는 **끝에** 붙여 잰다 — ESC·8비트 CSI·끈(DCS·OSC …)을 여는 글자는 뒤따르는 글자를 제어열로 함께 먹는다(Bun 과 같다 · U4 가 그 모양을 잰다).

test("U1·#4852 Claude Code 가 지우는 글자는 모두 지운다(모든 코드 포인트) — 줄바꿈으로 바꾸는 VT·FF·CR·NEL·U+2028·U+2029 만 빼고", () => {
  const missed: string[] = [];
  for (const c of allCodePoints()) {
    if (!claudeHidden(c) || NEWLINED.has(c)) continue;
    if (sc.stripUnseen("ab" + String.fromCodePoint(c)) !== "ab") missed.push("U+" + c.toString(16).toUpperCase());
  }
  assert.deepEqual(missed.slice(0, 20), [], `안 지운 글자 ${missed.length}개`);
});
test("U1b·#4852 줄바꿈으로 바뀌는 글자(VT·FF·CR·NEL·U+2028·U+2029)는 지우지 않는다 — 화면 대조는 공백처럼 다 지운다(NEL 은 \\s 밖)", () => {
  for (const c of NEWLINED) {
    const ch = String.fromCodePoint(c);
    assert.equal(sc.stripUnseen("a" + ch + "b"), "a" + ch + "b", `U+${c.toString(16)} 를 지웠다 — Claude Code 는 줄바꿈으로 적는다`);
    assert.equal(sc.unseenStripped("a" + ch + "b"), "ab", `U+${c.toString(16)} 화면 대조`);
  }
});
test("U2·#4852 서식 글자(Cf — 이 런타임의 유니코드)·이체 선택자(VS1~256)·한글 채움 문자도 지운다 · 공백류는 안 지운다(접기가 맡는다)", () => {
  const missed: string[] = [];
  for (const c of allCodePoints()) {
    const ch = String.fromCodePoint(c);
    const want = /\p{Cf}/u.test(ch) || (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0xe0100 && c <= 0xe01ef) || [0x115f, 0x1160, 0x3164, 0xffa0].includes(c);
    if (want && sc.stripUnseen("ab" + ch) !== "ab") missed.push("U+" + c.toString(16).toUpperCase());
  }
  assert.deepEqual(missed.slice(0, 20), [], `안 지운 글자 ${missed.length}개 — 새 유니코드에 서식 글자가 늘었으면 HIDDEN_CHARS 와 화면 사본을 함께 늘린다`);
  for (const ws of ["\t", "\n", "\r", "\x0b", "\x0c", "\x85", "\u{2028}", "\u{2029}", " ", "\u{A0}", "\u{3000}"]) assert.equal(sc.stripUnseen("a" + ws + "b"), "a" + ws + "b", JSON.stringify(ws));
});
test("U3·#4852 보이는 글자는 안 지운다 — 한글·한자·라틴·결합 문자·이모지(피부색)·기호·전각", () => {
  for (const x of ["가힣", "漢字", "Ünïcødé", "e\u{301}", "👍🏽", "①→★", "Ａ１"]) assert.equal(sc.stripUnseen(x), x, x);
});
test("U4·#4852 제어열은 통째로 지운다 — CSI(7·8비트) · OSC(BEL·ST·안 닫힘) · DCS · nF(ESC ( B) · ESC+글자 · 붙여넣기 표지 · 홀로 남은 ESC", () => {
  const rows: Array<[string, string]> = [
    ["a\x1b[31mb\x1b[0mc", "abc"], ["a\u{9B}1;2mb", "ab"], ["a\x1b]0;t\x07b", "ab"], ["a\x1b]8;;u\x1b\\b", "ab"], ["a\x1b]0;t", "a"],
    ["a\x1bP1$r\x1b\\b", "ab"], ["a\x1b(Bb", "ab"], ["a\x1b7b\x1b8", "ab"], ["a\x1bcb", "ab"], ["a\x1b[200~b\x1b[201~", "ab"], ["a\x1b", "a"],
  ];
  for (const [raw, want] of rows) assert.equal(sc.stripUnseen(raw), want, JSON.stringify(raw));
});

test("H26·#4852 우리 글에 제어열(색 코드)·한글 채움 문자·CGJ 가 있다 — 입력칸엔 지워진 꼴로 보인다 — ours · 다른 글이면 other", () => {
  const ours = "로그: \x1b[31mERROR\x1b[0m 디스크 가득 — 복사해 온\u{3164}글\u{34F} 끝까지 확인해 줘";
  assert.equal(inputHolds(screen([`❯${NB}로그: ERROR 디스크 가득 — 복사해 온글 끝까지 확인해 줘`]), ours), "ours");
  assert.equal(inputHolds(screen([`❯${NB}로그: ERROR 디스크 가득 — 다른 글`]), ours), "other");
});

test("H27·#4852 VT·FF·NEL 든 우리 글 — Claude Code 가 줄바꿈으로 바꿔 입력칸이 여러 줄이 돼도 ours · 줄이 다르면 other", () => {
  const ours = "세로\x0b탭\x0c넘김 \x85다음 그리고 끝";   // 보낸 그대로(oneLineOf 는 이 셋을 펴지 않는다)
  assert.equal(inputHolds(screen([`❯${NB}세로`, "  탭", "  넘김 ", "  다음 그리고 끝"]), ours), "ours");
  assert.equal(inputHolds(screen([`❯${NB}세로탭넘김 다음 그리고 끝`]), ours), "ours", "멈추기 전(줄바꿈 전) 모양");
  assert.equal(inputHolds(screen([`❯${NB}세로`, "  탭", "  다른 글"]), ours), "other");
});

test("G14·#4852 다시 보고 누르기(confirmBeforePress) — 누를 박자에 다시 봐서 아직 우리 글이면 누르고, 그새 바뀌었으면(사람의 글) 안 누른다 · 기본은 종전대로", async () => {
  const a = rig(STUCK, { guard: { confirmBeforePress: true } });
  assert.deepEqual(await a.step(SUBMIT_STUCK_MS + 100), ["peek"]);
  assert.deepEqual(await a.step(SUBMIT_POLL_MS), ["peek", "enter"], "다시 보지 않고 눌렀다");
  assert.equal(a.g.presses(), 1);
  const HUMAN = screen([`❯${NB}사람이 이어서 치는 다른 글`]);
  let n = 0;
  const b = rig(() => (n++ === 0 ? STUCK : HUMAN), { guard: { confirmBeforePress: true } });
  assert.deepEqual(await b.step(SUBMIT_STUCK_MS + 100), ["peek"]);
  assert.deepEqual(await b.step(SUBMIT_POLL_MS), ["peek"], "바뀐 입력칸에 눌렀다");
  assert.equal(b.g.presses(), 0);
  assert.equal(b.g.last(), "other");
  assert.deepEqual(await b.step(SUBMIT_POLL_MS), ["peek"], "다음 박자엔 다시 보기만");
  const c = rig(STUCK);
  await c.step(SUBMIT_STUCK_MS + 100);
  assert.deepEqual(await c.step(SUBMIT_POLL_MS), ["enter"], "기본(아웃박스)은 한 박자 한 걸음 그대로");
});
