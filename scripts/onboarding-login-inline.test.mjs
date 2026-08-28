// 온보딩 «AI 연결» 의 로그인 통로 계약 (#2055 후속, 2026-08-28) — 소스를 읽어 검사한다.
//
//  왜: 이 화면이 틀리면 사람이 **안 뜨는 창을 기다린다**. 실제로 그 반대 사고가 있었다 —
//  문구는 «새 탭에 검은 창이 열려요» 인데 동작은 바뀌어 있으면, 사람은 무엇을 기다리는지도 모른 채 멈춘다.
//  그래서 «동작»과 «문구»가 같은 사실을 말하는지 함께 잠근다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SRC = readFileSync(new URL("../web/v2/onboarding.ts", import.meta.url), "utf8");

test("배선 · 소스를 실제로 읽었다(vacuous 방지)", () => {
  assert.ok(SRC.length > 10000);
  assert.match(SRC, /LOGIN_INLINE/);
});

test("★ codex 는 이 자리에서 로그인한다 — 새 탭을 열지 않는다", () => {
  assert.match(SRC, /const LOGIN_INLINE = \{ codex: true \}/);
  const fn = SRC.slice(SRC.indexOf("async function startInlineLogin"), SRC.indexOf("async function openLoginWindow"));
  assert.ok(fn.length > 500, "카드 함수를 못 찾았다");
  assert.ok(!/window\.open/.test(fn), "카드 경로에 새 탭이 없다");
  assert.match(fn, /ai-login\/start/);
  assert.match(fn, /ai-login\/state/);
});

test("★ claude 는 서버 통로가 있어도 인라인이 아니다 — 그 창은 로그인만 하는 게 아니다", () => {
  // 왜 잠그나: `claude auth login` 은 서버가 돌릴 수 있다(ai-login-flow.ts 가 다룬다). 그래서 «되니까 켜자» 가
  //  쉽게 나온다. 그런데 claude 는 그 창에서 첫 실행 설정(글자 스타일·보안 안내·폴더 신뢰)을 함께 지나므로,
  //  로그인만 인라인으로 빼면 그 설정이 **첫 세션에서 뒤늦게** 떨어진다. 그 판단을 코드가 아니라 여기에 남긴다.
  assert.ok(!/LOGIN_INLINE = \{[^}]*claude/.test(SRC), "claude 는 인라인 표에 없다");
  // 대화창 관문(session-chat)도 codex 고정이다 — 두 자리의 판정이 갈리면 사람이 자리마다 다른 걸 본다.
  const CHAT = readFileSync(new URL("../web/session-chat.ts", import.meta.url), "utf8");
  const gate = CHAT.slice(CHAT.indexOf("async function loginGate"));
  assert.ok(gate.length > 500, "관문을 못 찾았다");
  assert.ok(!/ai-login\/start[^]{0,200}claude/.test(gate), "관문도 codex 만 인라인이다");
});

test("★ 대상이 아닌 하네스는 종전 «로그인 창» 그대로다 — 그쪽은 비대화형 한 줄이 없다", () => {
  assert.match(SRC, /if \(LOGIN_INLINE\[h\]\) \{ await startInlineLogin/);
  const win = SRC.slice(SRC.indexOf("async function openLoginWindow"));
  assert.match(win, /window\.open\(sessionTermUrl/);
});

test("★ 시작조차 못 하면 창으로 내려간다 — 막다른 카드 금지", () => {
  const fn = SRC.slice(SRC.indexOf("async function startInlineLogin"), SRC.indexOf("async function openLoginWindow"));
  assert.match(fn, /await openLoginWindow\(h, label\)/);
});

test("★ 문구가 동작과 어긋나지 않는다 — codex 안내에 «검은 창»·«새 탭» 이 없다", () => {
  const guide = SRC.slice(SRC.indexOf("const AI_GUIDE = {"), SRC.indexOf("const LOGIN_SESSION"));
  // 주석이 아니라 **화면에 나가는 문구만** 본다 — 주석에 «검은 창» 이라 적었다고 걸리면 계약이 아니라 검열이다
  //  (실측: 이 단언의 첫 판이 내가 쓴 설명 주석에 걸렸다).
  const inline = guide.slice(guide.indexOf("codex:"), guide.indexOf("antigravity:"))
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  // «창» 을 가리키는 말은 판마다 바뀐다(#2232 가 «검은 창» → «터미널 창» 으로 고쳤다). 그래서 특정 낱말이 아니라
  //  **창을 연다는 뜻의 표현 전부**를 본다 — 낱말 하나만 잠그면 다음 판올림에서 조용히 통과한다.
  const OPENS_WINDOW = /검은 창|터미널 창|새 탭/;
  assert.ok(!OPENS_WINDOW.test(inline), "그 둘은 더 이상 창을 안 띄운다");
  assert.match(inline, /이 자리에/, "«이 자리에서 한다» 고 말한다");
  // 대조군 — claude·agy·grok 은 여전히 창이 뜨므로 그 표현이 남아 있어야 한다(안 남으면 이 표가 아무것도 안 지킨다).
  assert.match(guide.slice(guide.indexOf("claude:"), guide.indexOf("codex:")), OPENS_WINDOW);
  assert.match(guide.slice(guide.indexOf("antigravity:")), OPENS_WINDOW);
});

test("코드는 눌러서 복사된다 — 사람이 옮겨 적게 하지 않는다", () => {
  const fn = SRC.slice(SRC.indexOf("async function startInlineLogin"), SRC.indexOf("async function openLoginWindow"));
  assert.match(fn, /clipboard\.writeText/);
});
