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

/** AI_GUIDE 안에서 그 하네스의 안내 블록만 잘라 낸다(주석 제외 — 주석은 화면에 안 나간다). */
const GUIDE_ORDER = ["claude", "codex", "antigravity", "grok"];
function guideOf(key) {
  const guide = SRC.slice(SRC.indexOf("const AI_GUIDE = {"), SRC.indexOf("const LOGIN_SESSION"));
  const i = guide.indexOf(`${key}:`);
  assert.ok(i >= 0, `AI_GUIDE 에 ${key} 안내가 없다`);
  const next = GUIDE_ORDER.slice(GUIDE_ORDER.indexOf(key) + 1)
    .map((k) => guide.indexOf(`${k}:`)).filter((x) => x > i).sort((a, b) => a - b)[0];
  return guide.slice(i, next === undefined ? guide.length : next)
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
}
/** 인라인 카드로 끝나는 하네스 — **정본은 공용 모듈**이다(온보딩엔 사본이 없다, #2477).
 *  ⚠ 손으로 쓴 목록을 두지 않는다. 정본이 바뀌면 아래 «걸음 칸» 계약이 그 즉시 새 하네스를 검사해야 한다. */
function inlineKeys() {
  const mod = readFileSync(new URL("../web/lib/ai-login-inline.ts", import.meta.url), "utf8");
  const m = mod.match(/AI_LOGIN_INLINE[^=]*=\s*Object\.freeze\(\{([^}]*)\}/);
  assert.ok(m, "공용 모듈에서 AI_LOGIN_INLINE 표를 못 찾았다");
  return [...m[1].matchAll(/(\w+)\s*:\s*true/g)].map((x) => x[1]).sort();
}
/** 스테퍼 분기 하나 — `h === '<key>'` 부터 다음 `} else` 까지. */
function stepperOf(key) {
  const all = SRC.slice(SRC.indexOf("let stepper = ''"), SRC.indexOf('<div class="ob-tok ob-lgs">'));
  const i = all.indexOf(`h === '${key}'`);
  assert.ok(i >= 0, `${key} 의 스테퍼 분기가 없다`);
  const end = all.indexOf("\n        } else", i);
  return all.slice(i, end === -1 ? all.length : end);
}

test("★ codex·claude·grok 은 이 자리에서 로그인한다 — 새 탭을 열지 않는다", () => {
  //  ⚠ 리터럴을 통째로 요구하지 않는다 — 종전 판은 `const LOGIN_INLINE = { … }` 를 **문자열로** 요구해,
  //   하네스를 하나 더하는 정당한 변경에 거짓 실패했다(계약이 아니라 구현의 사본). 기대값은 **하드코딩**한다 —
  //   소스에서 만들어 비교하면 표를 표로 검증하는 tautology 가 된다.
  assert.deepEqual(inlineKeys(), ["claude", "codex", "grok"],
    "이 통로를 쓰는 하네스 — agy 는 파이프 stdin 거절 + 60초 하드 타임아웃이라 여기 없다(실측 2026-09-01)");
  const fn = SRC.slice(SRC.indexOf("async function startInlineLogin"), SRC.indexOf("async function openLoginWindow"));
  assert.ok(fn.length > 500, "카드 함수를 못 찾았다");
  // 주석은 계약이 아니다 — «window.open 은 팝업차단으로 막힌다» 라고 **설명한** 줄에 걸리면 검열이다.
  const code = fn.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/window\.open/.test(code), "카드 경로에 새 탭이 없다");
  //  주고받는 일은 공용 모듈이 한다(#2477) — 여기선 «그 한 벌을 부르는가» 만 본다.
  //  프로토콜 자체(상한·restart·정리)의 계약은 scripts/ai-login-inline.test.mjs 가 진다.
  assert.match(fn, /startInlineAiLogin\(h, \{/, "공용 통로로 시작한다");
});

test("★ 인라인 하네스는 걸음 칸에 **주소 자리**가 있다 — 없으면 버튼이 조용히 죽는다", () => {
  //  ⚠ 실측(#2477): LOGIN_INLINE 에 grok 을 켜 놓고 스테퍼는 옛 «명령 붙여넣기» 판이라 `#lgAddr` 가 없었다.
  //   startInlineLogin 은 `if (!addr) return` 으로 즉시 빠져나가 **버튼을 눌러도 아무 일도 안 일어났다**
  //   — 오류도 토스트도 없다. 표(LOGIN_INLINE)와 화면(스테퍼)이 **따로 놀 수 있다**는 것이 이 함정의 본질이라
  //   둘을 여기서 맞댄다. 표에 하네스를 더하고 걸음 칸을 잊으면 이 단언이 먼저 깨진다.
  for (const k of inlineKeys()) {
    const st = stepperOf(k);
    assert.match(st, /id="lgAddr"/, `${k} 걸음에 주소가 뜰 자리가 있다`);
    assert.ok(/id="lgCode"/.test(st) || /id="lgIn"/.test(st),
      `${k} 걸음에 코드를 **보여줄** 칸이나 **되받을** 칸 중 하나가 있다`);
  }
});

test("★ claude 안내는 «첫 세션에서 물음이 더 나온다» 를 숨기지 않는다", () => {
  // claude 는 로그인과 별개로 첫 실행 설정(글자 스타일·보안 안내·폴더 신뢰)을 TUI 에서 묻는다 — 바이너리에
  //  hasCompletedOnboarding·hasTrustDialogAccepted·theme 문자열이 있다(실측 2026-08-28, lvly-tenant:c83).
  //  로그인만 이 자리로 빼면 그 물음은 없어지는 게 아니라 **첫 세션으로 미뤄진다.** 안 적으면 사람이 놀란다.
  //  «폴더를 믿나요» 를 미리 대신 눌러 두지 않는 것은 그게 사람이 할 보안 판단이기 때문이다.
  const claude = guideOf("claude");
  // 글자 스타일·보안 안내는 키트가 미리 넘긴다(member-kit-seed). 남는 건 폴더 신뢰 하나 — 그건 반드시 말한다.
  assert.match(claude, /첫 세션에서/, "첫 세션에 남는 몫을 말한다");
  assert.match(claude, /이 폴더를 믿나요|trust the files/, "그 물음이 무엇인지도 말한다");
  // 그리고 «로그인 방법» 화면을 만나도 로그인이 풀린 게 아님을 말해 준다 — 실측으로 사람이 그렇게 읽었다.
  assert.match(claude, /Select login method|로그인 방법/, "첫 실행 안내와 미로그인을 구분해 준다");
});

test("★ 인라인 카드를 못 쓰는 하네스도 새 탭으로 안 내보낸다 — 터미널을 이 자리에 띄운다(#2477)", () => {
  //  agy 는 «비대화형 한 줄» 이 없어 주소·코드 카드를 못 쓴다(파이프 stdin 거절 + 60초 하드 타임아웃, 실측
  //  2026-09-01). 그렇다고 새 탭으로 내보내면 온보딩도 안 끝난 사람이 «어디로 돌아오지» 를 만난다
  //  (데스크톱 앱에서는 아예 새 창). 그래서 터미널을 **이 카드 안에** 띄운다.
  assert.match(SRC, /if \(LOGIN_INLINE\[h\]\) \{ await startInlineLogin/, "두 값이면 되는 하네스는 터미널조차 안 보여 준다");
  assert.match(SRC, /await startInlineTerminal\(el, h, label, term\)/, "그 밖은 인라인 터미널로 간다(새 탭 아님)");
  const fn = SRC.slice(SRC.indexOf("async function startInlineTerminal"), SRC.indexOf("async function openLoginWindow"));
  assert.ok(fn.length > 500, "인라인 터미널 함수를 못 찾았다");
  const code = fn.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
  assert.ok(!/window\.open/.test(code), "이 경로가 스스로 새 탭을 열지 않는다");
  assert.match(code, /ensureLoginTerminal\(/, "세션 확보는 공용 함수가 한다(한 번만 만든다는 규약이 거기 있다)");
  assert.match(code, /loginTerminalSrc\(/, "액자에는 공용 함수가 만든 embed 주소를 싣는다");
});

test("★ 터미널 액자는 걸음(step) **밖**에 있다 — 안에 두면 걸음이 끝나는 순간 사라진다", () => {
  //  실측(#2477 구현 중): `.ob-lg-step.done .ob-lg-in{display:none}` 이라, [로그인 시작] 이 걸음 1 을 done 으로
  //  바꾸는 순간 그 안에 있던 액자가 통째로 숨겨졌다. 액자는 세 걸음 내내 쓰는 작업면이므로 걸음 밖에 있어야 한다.
  //  ⚠ 끝 앵커는 **시작점 뒤에서** 찾는다 — `id="cGo"` 는 이 파일 앞쪽에도 있어서, 그냥 indexOf 로 잡으면
  //   시작보다 앞이라 슬라이스가 빈 문자열이 된다(그러면 이 단언은 조용히 아무것도 안 본다).
  const cardAt = SRC.indexOf('<div class="ob-tok ob-lgs">');
  assert.ok(cardAt > 0, "카드 템플릿 시작을 못 찾았다");
  const card = SRC.slice(cardAt, SRC.indexOf('id="cGo"', cardAt));
  assert.match(card, /\$\{stepper\}[^]{0,120}termBox/, "액자는 스테퍼 뒤(=걸음 밖)에 붙는다");
  const steppers = SRC.slice(SRC.indexOf("let stepper = ''"), cardAt);
  assert.ok(!/\$\{termBox\}/.test(steppers), "걸음 본문 안에 액자를 두지 않는다");
});

test("★ 탈출로는 **같은 세션**을 연다 — 새 세션을 또 만들면 두 자리에서 로그인하게 된다", () => {
  const fn = SRC.slice(SRC.indexOf("async function startInlineTerminal"), SRC.indexOf("async function openLoginWindow"));
  assert.match(fn, /out\.href = loginTerminalPopoutUrl\(loginTermSession\)/, "크게 보기는 같은 세션을 연다");
  //  하단 상시 탈출로도 마찬가지다(이미 만든 세션이 있으면 그것을 연다).
  assert.match(SRC, /if \(loginTermSession\) \{[^]{0,160}loginTerminalPopoutUrl\(loginTermSession\)/,
    "상시 탈출로도 같은 세션을 연다");
});

test("★ 막다른 액자 금지 — 액자가 안 뜨면 갈 곳을 준다", () => {
  const fn = SRC.slice(SRC.indexOf("async function startInlineTerminal"), SRC.indexOf("async function openLoginWindow"));
  assert.match(fn, /catch \(e\)[^]{0,400}out\.hidden = false/, "실패해도 나갈 링크를 남긴다");
  //  그리고 종전 «새 탭» 길 자체는 마지막 탈출로로 살아 있어야 한다(어떤 갈래에서도 갇히지 않는다).
  const win = SRC.slice(SRC.indexOf("async function openLoginWindow"));
  assert.match(win, /window\.open\(sessionTermUrl/);
  //  상시 탈출로는 이제 **모든 하네스**에 있어야 한다 — 전부 이 자리에서 끝나므로 전부 나갈 길이 필요하다.
  assert.match(SRC, /\$\{fbLine\}/, "탈출로를 하네스로 가르지 않는다");
});

test("★ 막다른 카드 금지 — 탈출로는 상시, 실패해도 화면을 지우지 않는다", () => {
  const fn = SRC.slice(SRC.indexOf("async function startInlineLogin"), SRC.indexOf("async function openLoginWindow"));
  //  #2232 안 1 — 탈출로가 «실패 시 화면 대체»에서 «하단 상시 버튼»으로 바뀌었다. 계약은 그대로: 막다른 카드 금지.
  assert.match(fn, /fbBtn\.onclick[^]{0,160}openLoginWindow\(h, label\)/, "상시 탈출로가 종전 창 경로로 간다");
  //  시작 실패를 «잔글씨로만» 말하는 계약은 공용 모듈(view.failed)로 옮겼다 — 여기선 그 자리를 잇는지만 본다.
  assert.match(fn, /failed: \(m\) => note\(/, "실패는 잔글씨 한 줄로만 말한다(화면 유지)");
});

test("★ 받은 주소·치던 코드를 지우는 경로가 없다 — replaceChildren 철거(코드 증발 사고의 뿌리)", () => {
  const fn = SRC.slice(SRC.indexOf("async function startInlineLogin"), SRC.indexOf("async function openLoginWindow"));
  //  2026-08-31 실측: 상태 조회가 30초 끊기자 «주소가 오지 않았어요» 탈출로가 카드를 통째로 덮어
  //  받은 주소와 입력 중이던 코드까지 지웠다. 이제 그 함수 안에 카드를 갈아치우는 호출이 있어선 안 된다.
  const code = fn.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/replaceChildren/.test(code), "startInlineLogin 이 화면을 통째로 갈아치운다");
  assert.ok(!fn.includes("로그인 주소가 오지 않았어요"), "옛 «주소 미도착» 대체 화면이 되살아났다");
  assert.match(fn, /주소가 늦네요/, "정체는 잔글씨 한 줄로 말한다(기다림 유지)");
});

test("★ 문구가 동작과 어긋나지 않는다 — 어느 안내도 사람을 다른 탭·창으로 내보내지 않는다", () => {
  // 주석이 아니라 **화면에 나가는 문구만** 본다 — 주석에 «검은 창» 이라 적었다고 걸리면 계약이 아니라 검열이다
  //  (실측: 이 단언의 첫 판이 내가 쓴 설명 주석에 걸렸다).
  //  ⚠ 2026-09-01(#2477)로 계약이 한 단계 세졌다. 종전엔 «인라인 하네스만 창을 안 띄운다» 였고 agy 가
  //   대조군이었다. 이제 agy 도 터미널을 **이 자리에** 띄우므로 대조군이 없어졌다 — 재는 축을 바꾼다:
  //   문제는 «터미널» 이라는 낱말이 아니라 **사람을 다른 탭·창으로 내보내는 것**이다.
  const LEAVES_PAGE = /새 탭|새 창|검은 창/;
  for (const k of GUIDE_ORDER) {
    const g = guideOf(k);
    assert.ok(!LEAVES_PAGE.test(g), `${k} 안내가 사람을 다른 탭·창으로 내보내지 않는다`);
    assert.match(g, /이 자리에/, `${k} 는 «이 자리에서 한다» 고 말한다`);
  }
  //  ⓪ vacuous 방지 — 대조군이 사라졌으므로 «이 정규식이 실제로 무언가를 잡는다» 를 따로 못박는다.
  assert.match("새 탭에 창이 열려요", LEAVES_PAGE, "판정 정규식이 살아 있다");
  //  그리고 «막다른 카드 금지» 의 상시 탈출로는 여전히 창으로 나가는 길이어야 한다 — 그건 사라지면 안 된다.
  assert.match(SRC, /창으로 열어서 로그인/, "잘 안 될 때 창으로 나가는 길은 남아 있다");
});

test("★ 주소가 안 오면 «시작하는 중» 으로 버티지 않는다 — 무반응으로 보인다", () => {
  // 실측(2026-08-28 프로덕션, dabetai-68ca): 상한이 없어서 카드가 «로그인 절차를 시작하는 중이에요…» 를
  //  영원히 띄웠다. 사람에게 그건 «눌러도 반응이 없다» 다.
  //  상한을 **재는** 계약은 공용 모듈이 진다(scripts/ai-login-inline.test.mjs) — 여기선 그 알림을
  //  화면이 **잔글씨로만** 받는지 본다(#2232 안 1: 화면을 대체하지 않는다).
  const fn = SRC.slice(SRC.indexOf("async function startInlineLogin"), SRC.indexOf("async function openLoginWindow"));
  assert.match(fn, /stalled: \(\) => note\(/, "상한 알림을 잔글씨로 받는다(화면 유지)");
});

test("★ 탈출로는 사람이 누르는 버튼이다 — await 뒤의 window.open 은 팝업차단으로 조용히 막힌다", () => {
  const fn = SRC.slice(SRC.indexOf("async function startInlineLogin"), SRC.indexOf("async function openLoginWindow"));
  // 카드 경로에 자동 창열기가 없어야 한다. openLoginWindow 는 **버튼 onclick 안에서만** 불린다.
  assert.ok(!/await openLoginWindow\(/.test(fn), "자동으로 창을 열지 않는다");
  assert.match(fn, /fbBtn\.onclick = \(\) => \{ void openLoginWindow\(h, label\);/, "탈출로는 버튼 onclick 안에서만 연다");
});

test("★ 다시 시도는 **새로** 띄운다 — 안 그러면 죽은 코드를 다시 보여 준다", () => {
  // 실측 2026-08-28: ChatGPT 계정에 «Codex용 장치 코드 인증» 이 꺼져 있으면 그 코드가 브라우저에서 죽는다.
  //  그런데 우리 쪽 프로세스는 15분을 더 기다리므로, 설정을 켜고 다시 눌러도 start 가 «이미 돌고 있다» 며
  //  **같은 죽은 코드**를 돌려줬다. 몇 번을 눌러도 같은 벽이다.
  const fn = SRC.slice(SRC.indexOf("async function startInlineLogin"), SRC.indexOf("async function openLoginWindow"));
  assert.match(fn, /restart: restart === true/, "화면이 restart 를 공용 통로로 넘긴다");
  assert.match(fn, /retry\.onclick[^]{0,400}startInlineLogin\(el, h, label, true\)/, "다시 시도가 restart 로 부른다");
});

test("★ 막히는 갈래에 누를 수 있는 출구가 있다 — 터미널 명령을 시키지 않는다", () => {
  const codex = guideOf("codex");
  assert.match(codex, /href="https:\/\/chatgpt\.com/, "설정을 누를 수 있게 준다");
  assert.match(codex, /다시 시도/, "화면에 실제로 있는 버튼 이름으로 말한다");
});

test("코드는 눌러서 복사된다 — 사람이 옮겨 적게 하지 않는다", () => {
  const fn = SRC.slice(SRC.indexOf("async function startInlineLogin"), SRC.indexOf("async function openLoginWindow"));
  assert.match(fn, /clipboard\.writeText/);
});
