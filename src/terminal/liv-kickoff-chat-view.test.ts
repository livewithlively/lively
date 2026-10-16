// #1631 — 가입 온보딩 때 서버가 여는 리브 세션은 «대화로 보기» 가 기본이다(원준 2026-09-14).
//
//  처음 설정이 끝나면 서버가 리브 킥오프 세션(src/org/liv/kickoff.ts LIV_SESSION_LABEL)을 열고 그 세션(#/s/<id>)으로 보낸다.
//  세션 화면(web/session-chat.ts)은 터미널이 붙은 세션이면 터미널을 기본으로 열었다(2026-08-18 지시) — 처음 온 사람이
//  TUI 를 먼저 보고, 대화창은 [보기 ▸ 대화로 보기 (베타)] 를 찾아 눌러야 나왔다.
//  이제 그 세션은 대화창이 기본이다: 보기 판정(chatHome)이 그 세션 이름을 알아본다. 이름 글자는 서버 상수와 같아야 한다.
//
//  화면 모듈은 DOM 바운드라 유닛으로 못 돌린다 — 구조를 소스에서 못박는다(레포 선례).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const KICKOFF = readFileSync("src/org/liv/kickoff.ts", "utf8");
const CHAT = readFileSync("web/session-chat.ts", "utf8");

test("★★ 세션 화면의 리브 세션 이름이 서버 킥오프 세션 이름과 같다 — 글자가 갈리면 대화 기본이 조용히 풀린다", () => {
  const server = KICKOFF.match(/export const LIV_SESSION_LABEL = "([^"]+)";/);
  assert.ok(server, "서버 킥오프 세션 이름 상수를 찾지 못했다");
  const web = CHAT.match(/(?:export )?const LIV_KICKOFF_LABEL = '([^']+)';/);
  assert.ok(web, "★ 세션 화면에 리브 킥오프 세션 이름이 없다 — 온보딩 세션을 알아볼 수 없다");
  assert.equal(web![1], server![1], "세션 화면과 서버의 리브 세션 이름이 다르다");
});

test("★★ 리브 킥오프 세션은 보기 판정(chatHome)에서 대화가 본자리다 — 열 때도, 목록 갱신 때도 터미널로 넘기지 않는다", () => {
  assert.match(CHAT, /const livKickoff = \(\): boolean => String\(target\.label \|\| ''\) === LIV_KICKOFF_LABEL;/, "리브 킥오프 세션 판정이 없다");
  assert.match(CHAT, /const chatHome = \(\): boolean => [^\n]*livKickoff\(\)/, "★ 보기 판정이 리브 킥오프 세션을 모른다 — 터미널로 열린다");
  //  보기 판정을 쓰는 세 자리(열 때 · 목록 갱신 두 방향)가 chatHome 을 본다 — 판정 한 곳만 바꾸면 셋이 함께 따른다.
  //  #4794 — 열 때의 판정이 chatFirstView 로 꺼내졌고, «말을 보낸 직후(warmFirst — 터미널을 숨겨 붙였다 그린 순간 넘긴다)» 는
  //   그 조건이 거짓일 때만 선다. 리브 세션(첫 지시를 들고 온다 — liv-chat.ts rememberFirstPrompt)을 터미널로 넘기지 않는다.
  assert.match(CHAT, /const chatFirstView = chatHome\(\) \|\| target\.raw\?\.observed === false \|\| draftBack;/, "열 때의 기본 보기가 chatHome 을 안 본다");
  assert.match(CHAT, /const warmFirst = !chatFirstView && /, "★ 말을 보낸 직후의 숨겨 붙이기가 대화가 본자리인 화면까지 건드린다");
  assert.match(CHAT, /setMode\(chatFirstView \|\| warmFirst \? 'chat' : 'term'\);/, "열 때의 기본 보기가 chatFirstView 를 안 본다");
  assert.match(CHAT, /mode === 'chat' && !chatHome\(\) && String\(target\.raw\?\.chatMode \|\| ''\) === 'tmux' && hasTerm\(\)\) setMode\('term'\)/, "목록 갱신이 chatHome 과 무관하게 터미널로 되돌린다");
});
