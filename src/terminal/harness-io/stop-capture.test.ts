// #4695 T5 — 끄기 직전 화면에서 «쓰다 만 글»·«답을 기다리던 질문» 을 읽는 계약. **실제 하네스 화면 원문**(색 신호 포함, -e 캡처)으로만 검사한다.
//  자료: src/terminal/__fixtures__/stop-capture/*.ansi — claude 2.1.300 · codex 0.162.1 · agy 1.3.5 (2026-10-15 맥미니, 별도 tmux 서버 -L exp4695 ·
//   깨끗한 env · 경로·메일은 지움). 화면 모양 설명은 stop-capture.ts 머리말. 엣지 표 D1~D10 · Q1~Q7 은 작업 스크래치의 사양(spec.md A).
//  틀리면 티가 크다:
//   🔴 흐린 예시 글(claude «Try "…"» · codex «Ask Codex to do anything»)을 글로 읽으면 — 아무것도 안 쓴 세션마다 «보내지 못한 말» 이 생긴다.
//   🔴 «Chat about this» · «Type something» 을 선택지로 남기면 — 사람에게 의미 없는 단추가 생긴다(앞은 claude 의 화면 안내, 뒤는 직접 쓰기).
//   🔴 승인 대상(명령)을 못 읽으면 — 다시 열었을 때 «무엇을 허락하는지» 가 사라진다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  captureOf, draftFromScreen, questionFromScreen, questionTabs, screenAsks, startsDim, stripAnsi, clampDraft, DRAFT_MAX_CHARS,
} from "./stop-capture.js";

const fx = (n: string): string =>
  readFileSync(new URL(`../__fixtures__/stop-capture/${n}`, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const cap = (n: string) => captureOf(fx(n));

// ── 쓰다 만 글 ────────────────────────────────────────────────────────────────────────────────

test("D1 claude 빈 입력칸(흐린 «Try …» 예시 글) → 글 없음", () => {
  assert.equal(draftFromScreen("claude", cap("claude-2.1.300-empty.ansi")), null);
});

test("D2 claude 짧은 글 → 그대로", () => {
  assert.equal(draftFromScreen("claude", cap("claude-2.1.300-draft.ansi")), "보내지 않은 글입니다 — draft test 123");
});

test("D3 claude 긴 글(낱말 경계에서 접힘) → 공백 하나로 이어 붙인다", () => {
  const d = draftFromScreen("claude", cap("claude-2.1.300-draft-long.ansi"));
  assert.equal(d, "보내지 않은 글입니다 — draft test 123" + " 이어서 길게 씁니다".repeat(18));
});

test("D4 codex 빈 입력칸(흐린 «Ask Codex to do anything») → 글 없음", () => {
  assert.equal(draftFromScreen("codex", cap("codex-0.162.1-empty.ansi")), null);
});

test("D5 codex 짧은 글 → 그대로(아래 «모델 · 폴더» 꼬리줄은 글이 아니다)", () => {
  assert.equal(draftFromScreen("codex", cap("codex-0.162.1-draft.ansi")), "보내지 않은 글입니다 — codex draft 123");
});

test("D5b codex 화면에 지난 사람 말(«›» 만 굵게+흐림, 글은 보통 — 실측 모양)만 있고 입력 줄이 안 보이면 글 없음 — 지난 말을 쓰다 만 글로 읽지 않는다", () => {
  const c = captureOf(["\x1b[1;2m› \x1b[0m어제 보낸 말입니다", "", "• 작업을 마쳤습니다."].join("\n"));
  assert.equal(draftFromScreen("codex", c), null);
});
test("D6 codex 긴 글(글자 단위로 접힘) → 이음새 없이 붙인다", () => {
  assert.equal(draftFromScreen("codex", cap("codex-0.162.1-draft-long.ansi")), "보내지 않은 글입니다 — codex draft 123" + " 이어서 길게 씁니다".repeat(16));
});

test("D7 agy 빈 입력칸 → 글 없음 · 글 → 그대로", () => {
  assert.equal(draftFromScreen("antigravity", cap("agy-1.3.5-empty.ansi")), null);
  assert.equal(draftFromScreen("antigravity", cap("agy-1.3.5-draft.ansi")), "보내지 않은 글입니다 — agy draft 123");
});

test("D8 질문 창이 떠 있는 화면엔 입력칸이 없다 → 글 없음(지어내지 않는다)", () => {
  assert.equal(draftFromScreen("claude", cap("claude-2.1.300-ask-one.ansi")), null);
  assert.equal(draftFromScreen("claude", cap("claude-2.1.300-permission.ansi")), null);
  assert.equal(draftFromScreen("codex", cap("codex-0.162.1-permission.ansi")), null);
});

test("D8b codex 대화상자가 떠 있으면 어떤 «›» 줄도 쓰다 만 글로 읽지 않는다 — 판이 바뀌어 지난 말의 흐림이 빠져도", () => {
  //  실측 승인 화면에서 지난 사람 말 줄(\x1b[1;2m›)의 흐림만 뺀 모양 — «굵게만 칠한 ›» 가 입력 줄 표식이라 그것만으론 못 가른다.
  const raw = fx("codex-0.162.1-permission.ansi").replace("\x1b[1;2m› \x1b[0m셸에서", "\x1b[1m› \x1b[0m셸에서");
  assert.notEqual(raw, fx("codex-0.162.1-permission.ansi"), "[배선] 픽스처의 지난 말 줄을 실제로 바꿨다");
  assert.equal(draftFromScreen("codex", captureOf(raw)), null);
});
test("D9 흐림 판정 — 트루컬러(38;2;…)의 2 는 흐림이 아니다 · 22 는 흐림을 끈다 · 신호만 있으면 예시 글이 아니다", () => {
  assert.equal(startsDim("\x1b[2mTry"), true);
  assert.equal(startsDim("\x1b[0m\x1b[2mAsk"), true);
  assert.equal(startsDim("\x1b[38;2;99;168;248m글"), false);
  assert.equal(startsDim("\x1b[38;5;2m글"), false);
  assert.equal(startsDim("\x1b[2m\x1b[22m글"), false);
  assert.equal(startsDim("글"), false);
  assert.equal(startsDim("\x1b[2m"), false);
});

test("D10 쪽지 상한 — 넘으면 자른다 · 없으면 없다", () => {
  assert.equal(clampDraft(null), null);
  assert.equal(clampDraft("짧은 글"), "짧은 글");
  assert.equal(clampDraft("가".repeat(DRAFT_MAX_CHARS + 5))!.length, DRAFT_MAX_CHARS);
  assert.equal(clampDraft("가".repeat(DRAFT_MAX_CHARS))!.length, DRAFT_MAX_CHARS);
});

// ── 질문 ──────────────────────────────────────────────────────────────────────────────────────

test("Q1 claude 선택 질문 하나 — 머리(색상)·질문·선택지 셋(설명 포함) · 직접 쓰기 가능 · «Chat about this» 는 버린다", () => {
  const q = questionFromScreen("claude", cap("claude-2.1.300-ask-one.ansi"))!;
  assert.ok(q, "질문을 읽어야 한다");
  assert.equal(q.kind, "ask");
  assert.equal(q.items.length, 1);
  const it = q.items[0];
  assert.equal(it.header, "색상");
  assert.equal(it.text, "가장 좋아하는 색은?");
  assert.deepEqual(it.options.map((o) => [o.n, o.label]), [[1, "빨강"], [2, "파랑"], [3, "초록"]]);
  assert.deepEqual(it.options.map((o) => o.desc), ["열정적이고 강렬한 색", "차분하고 시원한 색", "편안하고 자연스러운 색"]);
  assert.equal(it.free, true);
  assert.equal(it.multi, undefined);
  assert.equal(q.reappears, undefined, "claude 는 다시 열어도 질문 창이 안 뜬다(실측 3/3)");
});

test("Q2 claude 질문 여러 개 — 탭 이름(Submit 제외)과 지금 보이는 질문", () => {
  const c0 = cap("claude-2.1.300-ask-tabs-0.ansi");
  assert.deepEqual(questionTabs(c0), ["색", "과일"]);
  const q0 = questionFromScreen("claude", c0)!;
  assert.equal(q0.kind, "ask");
  assert.equal(q0.items[0].text, "가장 좋아하는 색은?");
  assert.deepEqual(q0.items[0].options.map((o) => o.label), ["빨강", "파랑", "초록"]);
  const q1 = questionFromScreen("claude", cap("claude-2.1.300-ask-tabs-1.ansi"))!;
  assert.equal(q1.items[0].text, "좋아하는 과일을 모두 고르세요");
  assert.equal(q1.items[0].multi, true, "[ ] 선택지 = 여러 개 고르기");
  assert.deepEqual(q1.items[0].options.map((o) => o.label), ["사과", "배", "감"]);
  assert.equal(q1.items[0].free, true);
  assert.equal(questionTabs(cap("claude-2.1.300-ask-one.ansi")).length, 0, "질문 하나엔 탭 줄이 없다");
});

test("Q3 claude Submit 탭 — 아직 묻는 화면이다", () => {
  assert.equal(screenAsks(cap("claude-2.1.300-ask-tabs-submit.ansi")), true);
});

test("Q4 claude 실행 승인 — 제목·대상 명령·질문·선택지 넷 · 화면 팁은 질문이 아니다", () => {
  const q = questionFromScreen("claude", cap("claude-2.1.300-permission.ansi"))!;
  assert.equal(q.kind, "permission");
  assert.equal(q.target, "touch perm-test-4695.txt");
  const it = q.items[0];
  assert.equal(it.header, "Bash command");
  assert.match(it.text, /Do you want to proceed\?/);
  assert.doesNotMatch(it.text, /Tip:/);
  assert.deepEqual(it.options.map((o) => o.n), [1, 2, 3, 4]);
  assert.equal(it.options[0].label, "Yes");
  assert.equal(it.options[3].label, "No");
  assert.equal(q.reappears, undefined);
});

test("Q5 codex 실행 승인 — 대상($ 줄)·선택지(단축키 꼬리 제거) · 다시 열면 같은 창이 뜬다", () => {
  const q = questionFromScreen("codex", cap("codex-0.162.1-permission.ansi"))!;
  assert.equal(q.kind, "permission");
  assert.equal(q.target, "touch codex-perm-4695.txt");
  assert.equal(q.reappears, true);
  const it = q.items[0];
  assert.match(it.text, /Would you like to run the following command\?/);
  assert.deepEqual(it.options.map((o) => o.label), [
    "Yes, proceed",
    "Yes, and don't ask again for commands that start with `touch codex-perm-4695.txt`",
    "No, and tell Codex what to do differently",
  ]);
});

test("Q6 입력칸만 있는 화면 → 질문 없음 · 묻는 화면 아님", () => {
  for (const [h, f] of [["claude", "claude-2.1.300-draft.ansi"], ["claude", "claude-2.1.300-empty.ansi"], ["codex", "codex-0.162.1-draft.ansi"], ["antigravity", "agy-1.3.5-draft.ansi"]] as const) {
    const c = cap(f);
    assert.equal(questionFromScreen(h, c), null, f);
    assert.equal(screenAsks(c), false, f);
  }
});

test("Q6b claude 대화에 번호 목록을 보냈던 사람 말(«❯ 1. …»)이 남아 있어도 입력칸이 떠 있으면 묻는 화면이 아니다(#853) · 쓰다 만 글은 입력칸의 것", () => {
  const c = captureOf([
    "❯\u00a01. 위키를 정리해 줘",
    "  2. 끝나면 알려 줘",
    "",
    "● 정리했습니다.",
    "────────────────────────────────────────",
    "❯\u00a0다음 할 일",
    "────────────────────────────────────────",
    "  ⏵⏵ auto mode on (shift+tab to cycle)",
  ].join("\n"));
  assert.equal(screenAsks(c), false);
  assert.equal(draftFromScreen("claude", c), "다음 할 일");
});
test("Q7 질문 화면은 묻는 화면이다", () => {
  for (const f of ["claude-2.1.300-ask-one.ansi", "claude-2.1.300-ask-tabs-1.ansi", "claude-2.1.300-permission.ansi", "codex-0.162.1-permission.ansi"]) {
    assert.equal(screenAsks(cap(f)), true, f);
  }
});

test("C1 captureOf — 끝의 빈 줄을 걷고 맨글엔 색 신호·NBSP 가 없다", () => {
  const c = captureOf("\x1b[39m❯ \x1b[2mTry\x1b[0m\n\n\n");
  assert.equal(c.raw.length, 1);
  assert.equal(c.plain[0], "❯ Try");
  assert.equal(stripAnsi("\x1b]0;title\x07글"), "글");
});
