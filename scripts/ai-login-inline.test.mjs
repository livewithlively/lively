// «화면에서 끝나는 AI 로그인» 의 **클라이언트 프로토콜 한 벌** 계약 (#2055 · #2477) — 소스를 읽어 검사한다.
//
//  왜 이 파일이 생겼나: 이 통로는 처음엔 처음 설정(v2/onboarding.ts) 안에만 있었다. 그래서 온보딩을 끝낸
//  사람에게는 아무것도 안 바뀌어 있었다(상민님 2026-09-01: "저 웤스는 이미 온보딩 끝난앤데").
//  이제 [내 설정 ▸ 내 AI 계정]도 같은 통로를 쓰는데, **두 벌로 두면** 이 통로가 실측으로 얻은 처방들이
//  두 곳에서 갈린다. 그래서 «한 벌인가» 를 여기서 못박는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SRC = readFileSync(new URL("../web/lib/ai-login-inline.ts", import.meta.url), "utf8");
const ONB = readFileSync(new URL("../web/v2/onboarding.ts", import.meta.url), "utf8");
const MEAI = readFileSync(new URL("../web/me-ai.ts", import.meta.url), "utf8");
/** 주석은 계약이 아니다 — «종전엔 이랬다» 를 설명한 줄에 걸리면 검열이지 검사가 아니다. */
const code = (s) => s.split("\n").filter((l) => {
  const t = l.trim();
  return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
}).join("\n");

test("배선 · 세 소스를 실제로 읽었다(vacuous 방지)", () => {
  assert.ok(SRC.length > 2000);
  assert.ok(ONB.length > 10000);
  assert.ok(MEAI.length > 2000);
});

test("★ 한 벌이다 — 두 화면이 같은 모듈을 쓰고, 자기 폴링 루프를 갖지 않는다", () => {
  //  이 계약이 이 파일의 존재 이유다. 화면이 스스로 start/state 를 두드리기 시작하면 그 순간 사본이 둘이 된다.
  for (const [name, s] of [["onboarding", ONB], ["me-ai", MEAI]]) {
    assert.match(s, /from ['"][^'"]*ai-login-inline\.js['"]/, `${name} 이 공용 모듈을 가져온다`);
    const c = code(s);
    assert.ok(!/ai-login\/state/.test(c), `${name} 이 상태 폴링을 스스로 하지 않는다`);
    assert.ok(!/ai-login\/start/.test(c), `${name} 이 시작을 스스로 부르지 않는다`);
    assert.ok(!/ai-login\/paste/.test(c), `${name} 이 붙여넣기를 스스로 부르지 않는다`);
  }
  //  그리고 그 호출은 **모듈 안에** 있어야 한다(아무도 안 부르는 죽은 모듈이 아니다).
  const c = code(SRC);
  for (const p of ["ai-login/start", "ai-login/state", "ai-login/paste", "ai-login/cancel"]) {
    assert.ok(c.includes(p), `모듈이 ${p} 를 부른다`);
  }
});

test("★ 어느 하네스가 «주소·코드로 끝나나» 는 한 곳에서만 정한다", () => {
  //  기대값은 **하드코딩**한다 — 소스에서 만들어 비교하면 표를 표로 검증하는 tautology 다.
  const m = SRC.match(/AI_LOGIN_INLINE[^=]*=\s*Object\.freeze\(\{([^}]*)\}/);
  assert.ok(m, "AI_LOGIN_INLINE 표를 못 찾았다");
  const keys = [...m[1].matchAll(/(\w+)\s*:\s*true/g)].map((x) => x[1]).sort();
  assert.deepEqual(keys, ["claude", "codex", "grok"],
    "agy 는 파이프 stdin 거절 + 60초 하드 타임아웃이라 여기 없다(실측 2026-09-01) — 그쪽은 인라인 터미널로 간다");
  //  화면이 사본을 두지 않는다 — 온보딩은 그 표를 **가져다** 쓴다.
  assert.match(ONB, /const LOGIN_INLINE = AI_LOGIN_INLINE/, "온보딩이 목록 사본을 만들지 않는다");
});

test("★ 다시 시도는 **새로** 띄운다 — 안 그러면 죽은 코드를 다시 보여 준다", () => {
  //  실측 2026-08-28: ChatGPT 계정에 «장치 코드 인증» 이 꺼져 있으면 그 코드는 브라우저에서 죽는데
  //  우리 프로세스는 15분을 더 기다린다. restart 없이는 몇 번을 눌러도 같은 벽이다.
  assert.match(code(SRC), /restart:\s*opts\.restart === true/, "start 에 restart 를 실어 보낸다");
});

test("★ 완료하면 그 자리를 치운다 — 안 치우면 다음 사람이 만료된 코드를 본다", () => {
  const c = code(SRC);
  assert.match(c, /loggedIn === true/, "완료 판정은 **자격 확인**이 한다(프로세스 종료와 다른 사실)");
  assert.match(c, /ai-login\/cancel/, "끝나면 정리한다");
});

test("★ «이미 로그인돼 있다» 를 «이번에 끝났다» 로 읽지 않는다 — [다시 로그인] 이 죽는다", () => {
  //  ⚠ 실측(2026-09-01, 상민님 신고): 자격 판정은 «파일이 있나» 라 만료된 자격도 true 다(#1516).
  //   그 true 를 첫 조회에서 완료로 읽으면, [다시 로그인] 을 눌러도 «✓ 끝났어요» 만 깜빡이고
  //   start→state→cancel 로 끝난다 — 정작 다시 로그인해야 하는 그 상황에서 아무것도 안 한다.
  //   «이번 시도의 결과» 로만 인정해야 한다: 주소를 봤거나 · 프로세스가 끝났거나.
  const c = code(SRC);
  //  ⚠ «주소를 봤나» 로 재면 안 된다 — 이미 로그인된 하네스도 주소를 정상적으로 찍으므로(실측:
  //   grok 은 자격이 있어도 device-auth 주소를 찍고 기다린다) 주소가 뜨는 순간 완료가 돼 버린다.
  //   기준은 «이번 시도 중에 **바뀌었나**» 다 — 첫 조회를 기준선으로 잡는다.
  assert.match(c, /wasLoggedIn === null\) wasLoggedIn = st\.loggedIn === true/, "첫 조회를 기준선으로 잡는다");
  assert.match(c, /loggedIn === true && \(wasLoggedIn === false \|\| st\.exited === true\)/,
    "완료는 «처음엔 아니었다» 또는 «프로세스가 끝났다» 를 요구한다");
});

test("★ 주소가 늦어도 화면을 덮지 않는다 — 상한은 «말하기» 용이지 «포기» 가 아니다", () => {
  //  실측 2026-08-31: 조회가 30초 끊기자 탈출로가 카드를 통째로 덮어 **받은 주소와 치던 코드까지 지웠다.**
  const c = code(SRC);
  assert.match(c, /STALL_MS/, "상한이 있다");
  assert.match(c, /Date\.now\(\) - startedAt > STALL_MS/, "상한을 실제로 잰다");
  assert.match(c, /saidStall = true; view\.stalled\(\)/, "상한을 넘기면 **알리기만** 한다");
  //  그리고 그 뒤로도 계속 폴링해야 한다 — 조회가 돌아오면 주소는 그때 채워진다.
  assert.match(c, /view\.stalled\(\)[^]{0,200}setTimeout/, "알린 뒤에도 계속 기다린다");
});

test("★ 조회 실패를 화면 지우기로 옮기지 않는다", () => {
  const c = code(SRC);
  //  state 조회는 catch 로 삼키고 다음 틱에 다시 묻는다(끊긴 순간이 곧 실패는 아니다).
  assert.match(c, /ai-login\/state[^]{0,200}catch/, "조회 실패는 다음 틱으로 넘긴다");
  assert.ok(!/replaceChildren/.test(c), "모듈은 DOM 을 모른다 — 화면을 갈아치울 수 없다");
  assert.ok(!/document\./.test(c), "모듈은 DOM 을 모른다");
});

test("★ 로그인 세션은 **한 번만** 만든다 — 두 자리에서 로그인하면 어느 쪽이 진짜인지 모른다", () => {
  const c = code(SRC);
  assert.match(c, /if \(have\) return have/, "이미 있으면 그대로 쓴다");
  assert.match(c, /embed: true/, "액자에는 «터미널만» 판(#1744)을 싣는다");
  //  크게 보기는 **같은 세션**이어야 한다(새 세션을 또 만들면 사람이 두 자리에서 로그인한다).
  assert.match(c, /loginTerminalPopoutUrl[^]{0,160}sessionTermUrl\(t\.id/, "크게 보기는 같은 세션을 연다");
});

test("★ 모듈이 스스로 새 탭을 열지 않는다 — 창을 여는 것은 사람이 누를 때만이다", () => {
  //  `await` 뒤의 window.open 은 사람이 누른 순간과 끊겨 팝업차단에 조용히 막힌다(#2055 실측).
  //  그래서 창 열기는 화면의 버튼 onclick 안에서만 일어나야 하고, 이 모듈은 주소만 만들어 준다.
  assert.ok(!/window\.open/.test(code(SRC)), "모듈에 window.open 이 없다");
});

test("★ 시작에 실패해도 던지지 않는다 — 막다른 카드를 만들지 않는다", () => {
  const c = code(SRC);
  assert.match(c, /ai-login\/start[^]{0,300}catch \(e\)[^]{0,120}view\.failed/,
    "시작 실패는 화면에 한 줄로 알리고, 화면은 종전 «창으로 열기» 를 그대로 둔다");
});
