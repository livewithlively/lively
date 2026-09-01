// 대화창 로그인 관문의 **교리** (#2055) — 소스를 읽어 검사한다(session-chat.ts 는 전역을 잡아 import 가 안 된다).
//
//  이 관문은 «관문» 이라는 이름과 달리 사람을 막지 않는다. 그 경계가 이 파일의 요점이다:
//   · loggedIn === false 일 때만 말한다. null(모름)이면 **아무 말도 안 한다** — 모르면서 «미로그인» 이라고
//     하면 로그인한 사람을 막는다(코어 profiles.ts AiLoginCheck 가 같은 교리를 문서화한다).
//   · 조회가 실패하면 조용히 넘어간다. 안내를 못 했다고 대화를 막으면 그게 더 나쁜 회귀다.
//  실측 계기(2026-08-27): 「코덱스 세션 만들어봤는데 로그인 하라는 안내도 없고 이거 뭐 어쩌라는거야」.
//  그 전 수정은 «턴이 401 로 죽으면 이유를 말한다» 였는데, 그건 사람이 한 번 헛수고한 뒤에야 뜬다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SRC = readFileSync(new URL("../web/session-chat.ts", import.meta.url), "utf8");
const GATE = SRC.slice(SRC.indexOf("async function loginGate"), SRC.indexOf("let live: CodexLive | null"));

test("배선 · 관문 구간을 실제로 읽었다(vacuous 방지)", () => {
  assert.ok(GATE.length > 400, `관문을 못 찾았다(${GATE.length}자)`);
  assert.match(GATE, /ai-accounts\/check/);
});

test("★ loggedIn 이 false 일 때만 말한다 — null(모름)에는 침묵", () => {
  assert.match(GATE, /loggedIn !== false/, "!== false 로 좁힌다(falsy 검사면 null 도 걸린다)");
  assert.ok(!/!c\.loggedIn|loggedIn\s*===\s*null\s*\)\s*\{[^}]*gate/.test(GATE));
});

test("★ 조회가 실패하면 조용히 넘어간다 — 안내 실패가 대화를 막으면 안 된다", () => {
  assert.match(GATE, /catch\s*\{\s*return;/, "실패 시 return");
});

test("★ 한 번만 뜬다 — 폴링마다 배너가 쌓이면 안 된다", () => {
  assert.match(GATE, /gateShown/);
});

test("★ 로그인을 **이 자리에서** 끝낸다 — 새 탭·새 창을 열지 않는다", () => {
  // 2026-08-28 지시: 앱에서는 새 창까지 떴다. 사람이 할 일은 «주소를 열고 코드를 넣는 것» 뿐이다.
  assert.match(GATE, /ai-login\/start/, "서버가 로그인 명령을 대신 돌린다");
  assert.match(GATE, /ai-login\/state/, "주소·코드를 폴링해 카드로 보여준다");
  assert.ok(!/window\.open/.test(GATE), "새 탭을 열지 않는다");
  assert.ok(!/loginProfile/.test(GATE), "로그인 전용 세션을 더 만들지 않는다");
});

test("★ 주소·코드는 눌러서 복사된다 — 사람이 옮겨 적게 하지 않는다", () => {
  assert.match(GATE, /clipboard\?\.writeText/);
});

test("★ 코드를 되받아야 하는 하네스(claude)의 통로도 있다 — codex 만 보고 만들면 claude 가 빠진다", () => {
  assert.match(GATE, /needsPaste/);
  assert.match(GATE, /ai-login\/paste/);
});

test("★ 시작조차 못 하면 종전 안내(터미널 절차)로 정직하게 내려간다 — 막다른 카드 금지", () => {
  assert.match(GATE, /여기서 바로 로그인할 수 없어요/);
  assert.match(GATE, /c\?\.steps/);
});

test("실측된 절차(steps)가 있으면 같이 보여준다 — 버튼을 못 쓰는 상황의 탈출로", () => {
  assert.match(GATE, /c\??\.steps/);
});
