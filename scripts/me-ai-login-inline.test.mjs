// [내 설정 ▸ 내 AI 계정]의 로그인 통로 계약 (#2477) — 소스를 읽어 검사한다.
//
//  왜: 이 화면이 **온보딩을 끝낸 사람에게는 유일한 로그인 자리**다. 종전엔 여기가 새 탭으로 세션을 열어서,
//  «화면에서 로그인» 이 처음 설정 때 한 번 지나가는 화면에서만 참이었다(상민님 2026-09-01 지적).
//  그리고 agy 는 **목록에 아예 없었다** — 자격이 파일로 안 남아 서버가 건너뛰었다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SRC = readFileSync(new URL("../web/me-ai.ts", import.meta.url), "utf8");
const PROFILES = readFileSync(new URL("../src/terminal/profiles.ts", import.meta.url), "utf8");
const MOD = readFileSync(new URL("../web/lib/ai-login-inline.ts", import.meta.url), "utf8");
const code = (s) => s.split("\n").filter((l) => {
  const t = l.trim();
  return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
}).join("\n");

test("배선 · 소스를 실제로 읽었다(vacuous 방지)", () => {
  assert.ok(SRC.length > 2000 && PROFILES.length > 5000 && MOD.length > 2000);
  assert.match(SRC, /aiAccountRow/);
});

test("★ 로그인이 이 자리에서 끝난다 — 버튼이 새 탭을 여는 것이 기본 동작이 아니다", () => {
  //  종전: openLogin 이 세션을 만들고 곧장 window.open 했다. 이제는 행 아래 패널을 편다.
  const fn = SRC.slice(SRC.indexOf("const openLogin ="), SRC.indexOf("const logout ="));
  assert.ok(fn.length > 100, "openLogin 을 못 찾았다");
  const c = code(fn);
  assert.ok(!/window\.open/.test(c), "누르는 순간 새 탭을 열지 않는다");
  assert.match(c, /\brun\(\)/, "그 자리에서 로그인 절차를 편다");
});

test("★ 로그인 패널을 **행에 붙인다** — 만들어 놓고 안 붙이면 눌러도 아무 일이 안 일어난다", () => {
  //  ⚠ 실측(2026-09-01, 상민님 신고): `panel` 을 만들고 `panel.hidden = false` 까지 했는데 **반환 트리에
  //   안 넣었다.** 그래서 눌러도 화면엔 아무것도 안 뜨고, `alive: () => document.body.contains(panel)` 이
  //   늘 false 라 폴링도 즉시 죽었다 — 오류도 토스트도 없다.
  //   «만든다» 와 «붙인다» 는 다른 사건이고, 그 사이가 끊기면 조용하다(#2477 의 grok 죽은 버튼과 같은 부류).
  const c = code(SRC);
  const ret = c.slice(c.indexOf("return el('div', { class: 'aiacct' }"), c.indexOf("function myAiAccountsCard"));
  assert.ok(ret.length > 100, "행 반환문을 못 찾았다");
  assert.match(ret, /\bpanel\)/, "반환 트리에 panel 이 들어 있다");
});

test("★ 두 갈래를 **하네스로** 가른다 — 주소·코드로 끝나면 카드, 아니면 터미널", () => {
  const c = code(SRC);
  assert.match(c, /isInlineCardHarness\(a\.key\)/, "갈림은 공용 판정을 쓴다(사본 금지)");
  assert.match(c, /paintTerminal\(\)/, "카드로 못 끝내는 하네스는 터미널을 이 자리에 띄운다");
  assert.match(c, /paintCard\(\)/, "끝나는 하네스는 주소·코드만 보여 준다");
  //  ⚠ 표(공용 목록)와 화면(두 그리기 함수)이 **둘 다** 있어야 한다. 실측(#2477): 목록에만 켜고 화면 조각을
  //   안 만들어 버튼이 조용히 죽은 적이 있다 — 각각은 정상인데 사이가 끊긴 부류다.
  assert.match(MOD, /AI_LOGIN_INLINE/, "정본 목록이 모듈에 있다");
});

test("★ agy 가 목록에 **나온다** — 자격이 파일로 안 남는다고 없는 사람 취급하지 않는다", () => {
  //  종전 aiAccountStatus 는 HARNESS_CRED 에 없는 하네스를 통째로 건너뛰었다(`if (!rel) continue`).
  //  그래서 [내 AI 계정]에 agy 가 안 보였고, 온보딩 밖에서 agy 를 잇는 자리가 **하나도 없었다.**
  const c = code(PROFILES);
  assert.ok(!/if \(!rel\) continue;/.test(c), "파일이 없다고 그냥 건너뛰지 않는다");
  assert.match(c, /harnessLoginProbe\(h\.key\)/, "잴 방법(프로브)이 있으면 목록에 낸다");
  assert.match(c, /how: "probe"/, "무엇으로 쟀는지 화면에 알려 준다");
  //  ⚠ 그렇다고 이 목록에서 프로브를 **돌리지는 않는다** — 4.3초·네트워크인데 여러 화면이 부르는 자리다.
  //   모르는 것은 null 로 낸다(모르면서 «미로그인» 이라 하면 로그인한 사람을 막는다 — 이 파일의 교리).
  assert.match(c, /loggedIn: null, canLogout: false, how: "probe"/, "프로브 행은 «모름» 으로 낸다");
});

test("★ «모름» 두 종류를 갈라 말한다 — 아직 안 물어본 것과 못 잰 것은 다르다", () => {
  //  probe 하네스(agy)의 null 은 «이 서버가 고장났다» 가 아니라 «목록에서는 재지 않았다» 다.
  //  같은 문장으로 말하면 사람이 서버 탓으로 읽는다.
  const c = code(SRC);
  assert.match(c, /a\.how === 'probe'/, "probe 행을 따로 말한다");
  assert.match(c, /확인 필요/, "아직 안 물어본 상태의 이름이 따로 있다");
  assert.match(c, /확인 불가/, "정말 못 잰 상태의 이름도 남아 있다");
  //  그리고 **그 자리에서 물어볼 길**을 준다 — 안 그러면 영영 «확인 필요» 로 남는다(막다른 배지).
  assert.match(c, /ai-accounts\/check/, "그 행만 따로 물어볼 수 있다");
  //  ⚠ null 을 «연결됨» 으로 접지 않는다(이 화면의 교리).
  assert.match(c, /r\.loggedIn === true[^]{0,200}r\.loggedIn === false/, "true·false·모름 셋을 갈라 말한다");
});

test("★ 막다른 패널 금지 — 어떤 갈래에서도 창으로 나가는 길이 있다", () => {
  const c = code(SRC);
  assert.match(c, /openWindow/, "창으로 여는 탈출로가 있다");
  //  ⚠ 이미 만든 세션이 있으면 **그 세션**을 연다(새 세션을 또 만들면 두 자리에서 로그인하게 된다).
  assert.match(c, /if \(term\) \{[^]{0,160}loginTerminalPopoutUrl\(term\)/, "탈출로는 같은 세션을 연다");
  //  액자를 못 띄운 갈래에도 나갈 링크가 남아야 한다.
  assert.match(c, /catch \(e: any\)[^]{0,400}out\.hidden = false/, "못 띄웠으면 나갈 링크를 남긴다");
});

test("★ 창 열기는 **사람이 누를 때만** — await 뒤의 window.open 은 팝업차단에 조용히 막힌다", () => {
  //  #2055 실측. 그래서 window.open 은 onclick 안에서만 나타나야 한다.
  const c = code(SRC);
  for (const m of c.matchAll(/window\.open/g)) {
    const before = c.slice(Math.max(0, m.index - 600), m.index);
    assert.ok(/onclick|openWindow/.test(before), `window.open 이 사람이 누르는 자리 안에 있다 (index ${m.index})`);
  }
});

test("★ 끝나면 상태를 다시 읽는다 — «로그인했는데 화면은 연결 안 됨» 을 남기지 않는다", () => {
  const c = code(SRC);
  assert.match(c, /done: \(\)[^]{0,200}reload\(\)/, "카드가 끝나면 목록을 새로 읽는다");
  assert.match(c, /상태 새로고침/, "터미널 갈래는 사람이 끝냈다고 알릴 수 있다(그 자리에서 판정을 다시 잰다)");
});
