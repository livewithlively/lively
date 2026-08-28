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

test("★ codex·claude 는 이 자리에서 로그인한다 — 새 탭을 열지 않는다", () => {
  assert.match(SRC, /const LOGIN_INLINE = \{ codex: true, claude: true \}/);
  const fn = SRC.slice(SRC.indexOf("async function startInlineLogin"), SRC.indexOf("async function openLoginWindow"));
  assert.ok(fn.length > 500, "카드 함수를 못 찾았다");
  // 주석은 계약이 아니다 — «window.open 은 팝업차단으로 막힌다» 라고 **설명한** 줄에 걸리면 검열이다.
  const code = fn.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/window\.open/.test(code), "카드 경로에 새 탭이 없다");
  assert.match(fn, /ai-login\/start/);
  assert.match(fn, /ai-login\/state/);
});

test("★ claude 안내는 «첫 세션에서 물음이 더 나온다» 를 숨기지 않는다", () => {
  // claude 는 로그인과 별개로 첫 실행 설정(글자 스타일·보안 안내·폴더 신뢰)을 TUI 에서 묻는다 — 바이너리에
  //  hasCompletedOnboarding·hasTrustDialogAccepted·theme 문자열이 있다(실측 2026-08-28, lvly-tenant:c83).
  //  로그인만 이 자리로 빼면 그 물음은 없어지는 게 아니라 **첫 세션으로 미뤄진다.** 안 적으면 사람이 놀란다.
  //  «폴더를 믿나요» 를 미리 대신 눌러 두지 않는 것은 그게 사람이 할 보안 판단이기 때문이다.
  const guide = SRC.slice(SRC.indexOf("const AI_GUIDE = {"), SRC.indexOf("const LOGIN_SESSION"));
  const claude = guide.slice(guide.indexOf("claude:"), guide.indexOf("codex:"))
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.match(claude, /첫 세션에서 물음이 몇 개 더 나와요/, "미뤄진 물음을 말한다");
  assert.match(claude, /이 폴더를 믿나요|trust the files/, "그 물음이 무엇인지도 말한다");
});

test("★ 대상이 아닌 하네스는 종전 «로그인 창» 그대로다 — 그쪽은 비대화형 한 줄이 없다", () => {
  assert.match(SRC, /if \(LOGIN_INLINE\[h\]\) \{ await startInlineLogin/);
  const win = SRC.slice(SRC.indexOf("async function openLoginWindow"));
  assert.match(win, /window\.open\(sessionTermUrl/);
});

test("★ 시작조차 못 하면 창으로 내려간다 — 막다른 카드 금지", () => {
  const fn = SRC.slice(SRC.indexOf("async function startInlineLogin"), SRC.indexOf("async function openLoginWindow"));
  // 탈출로는 «자동으로 연다» 가 아니라 «누를 것을 준다» 로 바뀌었다(팝업차단) — 계약은 그대로 «막다른 카드 금지».
  assert.match(fn, /catch \(e\) \{[^]{0,400}escape\(/, "시작 실패에 탈출로를 준다");
  assert.match(fn, /openLoginWindow\(h, label\)/, "그 탈출로가 종전 창 경로로 간다");
});

test("★ 문구가 동작과 어긋나지 않는다 — codex·claude 안내에 «검은 창»·«새 탭» 이 없다", () => {
  const guide = SRC.slice(SRC.indexOf("const AI_GUIDE = {"), SRC.indexOf("const LOGIN_SESSION"));
  // 주석이 아니라 **화면에 나가는 문구만** 본다 — 주석에 «검은 창» 이라 적었다고 걸리면 계약이 아니라 검열이다
  //  (실측: 이 단언의 첫 판이 내가 쓴 설명 주석에 걸렸다).
  const inline = guide.slice(guide.indexOf("claude:"), guide.indexOf("antigravity:"))
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  // «창» 을 가리키는 말은 판마다 바뀐다(#2232 가 «검은 창» → «터미널 창» 으로 고쳤다). 그래서 특정 낱말이 아니라
  //  **창을 연다는 뜻의 표현 전부**를 본다 — 낱말 하나만 잠그면 다음 판올림에서 조용히 통과한다.
  const OPENS_WINDOW = /검은 창|터미널 창|새 탭/;
  assert.ok(!OPENS_WINDOW.test(inline), "그 둘은 더 이상 창을 안 띄운다");
  assert.match(inline, /이 자리에/, "«이 자리에서 한다» 고 말한다");
  // 대조군 — agy·grok 은 여전히 창이 뜨므로 그 표현이 남아 있어야 한다(안 남으면 이 표가 아무것도 안 지킨다).
  assert.match(guide.slice(guide.indexOf("antigravity:")), OPENS_WINDOW);
});

test("★ 주소가 안 오면 «시작하는 중» 으로 버티지 않는다 — 무반응으로 보인다", () => {
  // 실측(2026-08-28 프로덕션, dabetai-68ca): 이 상한이 없어서 카드가 «로그인 절차를 시작하는 중이에요…» 를
  //  영원히 띄웠다. 사람에게 그건 «눌러도 반응이 없다» 다. 상한과 탈출로가 반드시 있어야 한다.
  const fn = SRC.slice(SRC.indexOf("async function startInlineLogin"), SRC.indexOf("async function openLoginWindow"));
  assert.match(fn, /STALL_MS/, "상한이 있다");
  assert.match(fn, /Date\.now\(\) - startedAt > STALL_MS/, "상한을 실제로 잰다");
  assert.match(fn, /escape\(/, "상한을 넘기면 탈출로를 준다");
});

test("★ 탈출로는 사람이 누르는 버튼이다 — await 뒤의 window.open 은 팝업차단으로 조용히 막힌다", () => {
  const fn = SRC.slice(SRC.indexOf("async function startInlineLogin"), SRC.indexOf("async function openLoginWindow"));
  // 카드 경로에 자동 창열기가 없어야 한다. openLoginWindow 는 **버튼 onclick 안에서만** 불린다.
  assert.ok(!/await openLoginWindow\(/.test(fn), "자동으로 창을 열지 않는다");
  assert.match(fn, /b\.onclick = \(\) => \{ void openLoginWindow\(h, label\); \}/);
});

test("★ 다시 시도는 **새로** 띄운다 — 안 그러면 죽은 코드를 다시 보여 준다", () => {
  // 실측 2026-08-28: ChatGPT 계정에 «Codex용 장치 코드 인증» 이 꺼져 있으면 그 코드가 브라우저에서 죽는다.
  //  그런데 우리 쪽 프로세스는 15분을 더 기다리므로, 설정을 켜고 다시 눌러도 start 가 «이미 돌고 있다» 며
  //  **같은 죽은 코드**를 돌려줬다. 몇 번을 눌러도 같은 벽이다.
  const fn = SRC.slice(SRC.indexOf("async function startInlineLogin"), SRC.indexOf("async function openLoginWindow"));
  assert.match(fn, /restart: restart === true/, "start 에 restart 를 실어 보낸다");
  assert.match(fn, /again\.onclick = \(\) => \{ void startInlineLogin\(el, h, label, true\); \}/, "다시 시도가 restart 로 부른다");
});

test("★ 막히는 갈래에 누를 수 있는 출구가 있다 — 터미널 명령을 시키지 않는다", () => {
  const guide = SRC.slice(SRC.indexOf("const AI_GUIDE = {"), SRC.indexOf("const LOGIN_SESSION"));
  const codex = guide.slice(guide.indexOf("codex:"), guide.indexOf("antigravity:"))
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.match(codex, /href="https:\/\/chatgpt\.com/, "설정을 누를 수 있게 준다");
  assert.match(codex, /다시 시도/, "화면에 실제로 있는 버튼 이름으로 말한다");
});

test("코드는 눌러서 복사된다 — 사람이 옮겨 적게 하지 않는다", () => {
  const fn = SRC.slice(SRC.indexOf("async function startInlineLogin"), SRC.indexOf("async function openLoginWindow"));
  assert.match(fn, /clipboard\.writeText/);
});
