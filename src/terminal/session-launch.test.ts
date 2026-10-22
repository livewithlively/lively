// 세션 생성 관문(#3626) — 두 입구(홈·프로젝트)가 **같은 표로** 요청을 읽는다는 것을 붙박는다.
//  사고의 모양: 홈만 화면 테마 헤더를 theme 으로 옮겨 그 값이 psmux 가 못 나르는 argv 가 됐고, 프로젝트 입구엔 그 필드가
//  없어 «홈에서만 죽는» 갈림이 났다. 이 표가 있으면 새 필드는 두 입구에 동시에 생기거나 동시에 없다.
//  (엣지 표 D1~D4·E1~E10 — 사양은 scratchpad spec.md)
import { strict as assert } from "node:assert";
import test from "node:test";
import { launchReply, sessionInputFromBody, themeOf } from "./session-launch.js";

test("themeOf: 헤더가 정본, 바디는 폴백, 모르는 값은 미지정 (D1~D4)", () => {
  assert.equal(themeOf({ headers: { "x-lively-theme": "dark" } }, { theme: "light" }), "dark");
  assert.equal(themeOf({ headers: {} }, { theme: "light" }), "light");
  assert.equal(themeOf({ headers: { "x-lively-theme": "blue" } }, {}), undefined);
  assert.equal(themeOf({ headers: {} }, {}), undefined);
});

test("sessionInputFromBody: 공통 필드를 한 표로 읽는다 — 테마 헤더 포함 (E1)", () => {
  const input = sessionInputFromBody({ "x-lively-theme": "dark" }, {
    harness: "claude", flags: { "--model": "opus" }, autoApprove: true, initialPrompt: "pwd 만 알려줘",
    readOnly: true, incognito: true, writeVis: "audience", runtime: "chat", label: "이름", appId: "  browser ",
    rootKey: "personal", subpath: "x/y",
  });
  assert.equal(input.harness, "claude");
  assert.deepEqual(input.flags, { "--model": "opus" });
  assert.equal(input.autoApprove, true);
  assert.equal(input.readOnly, true);
  assert.equal(input.incognito, true);
  assert.equal(input.writeVis, "audience");   // normalizeCap 이 아는 값(open·audience·private)만 통과한다
  assert.equal(input.theme, "dark");
  assert.equal(input.runtime, "chat");
  assert.equal(input.initialPrompt, "pwd 만 알려줘");
  assert.equal(input.appId, "browser");            // 앞뒤 공백은 걷는다(E9)
  assert.equal(input.kind, "app");                 // appId 가 있으면 앱 세션(E2)
  assert.equal(input.label, "이름");
  assert.equal(input.rootKey, "personal");
  assert.equal(input.subpath, "x/y");
});

test("sessionInputFromBody: kind 는 요청에서 한 번만 정한다(#2162) — loginFor › appId › human (E2~E5)", () => {
  assert.equal(sessionInputFromBody({}, { appId: "browser" }).kind, "app");
  assert.equal(sessionInputFromBody({}, { loginFor: "codex" }).kind, "login");
  assert.equal(sessionInputFromBody({}, { loginFor: "codex", appId: "browser" }).kind, "login");
  assert.equal(sessionInputFromBody({}, {}).kind, "human");
});

test("sessionInputFromBody: 아무것도 안 주면 — 하네스는 비어 있고(셸로 접지 않는다) 좌표·이름은 빈 문자열 (E5)", () => {
  const input = sessionInputFromBody({}, {});
  assert.equal(input.harness, "");                 // 비우면 createSession 이 400 — 첫 지시가 조용히 버려지는 셸 세션을 만들지 않는다
  assert.equal(input.label, "");
  assert.equal(input.rootKey, "");
  assert.equal(input.subpath, "");
  assert.equal(input.theme, undefined);
  assert.equal(input.runtime, undefined);
  assert.equal(input.writeVis, undefined);
  assert.equal(input.initialPrompt, undefined);
  assert.equal(input.appId, undefined);
  assert.equal(input.autoApprove, false);
  assert.equal(input.readOnly, false);
  assert.equal(input.incognito, false);
  assert.deepEqual(input.flags, {});
});

test("sessionInputFromBody: 모르는 값은 조용히 기본으로 — runtime·writeVis·flags·빈 첫 지시·공백뿐인 appId (E6·E9)", () => {
  const input = sessionInputFromBody({}, { runtime: "weird", writeVis: "nope", flags: "x", initialPrompt: "   ", appId: "   " });
  assert.equal(input.runtime, undefined);
  assert.equal(input.writeVis, undefined);
  assert.deepEqual(input.flags, {});
  assert.equal(input.initialPrompt, undefined);
  assert.equal(input.appId, undefined);
  assert.equal(input.kind, "human");               // 공백뿐인 appId 는 앱 세션이 아니다
});

test("sessionInputFromBody: runtime 은 chat·terminal 둘만 (E6·E10)", () => {
  assert.equal(sessionInputFromBody({}, { runtime: "terminal" }).runtime, "terminal");
  assert.equal(sessionInputFromBody({}, { runtime: "chat" }).runtime, "chat");
  assert.equal(sessionInputFromBody({}, { runtime: true }).runtime, undefined);
});

test("sessionInputFromBody: 첫 지시는 20_000자에서 자르고, 앞뒤 공백은 그대로 둔다 (E7·E8)", () => {
  assert.equal(sessionInputFromBody({}, { initialPrompt: "x".repeat(25_000) }).initialPrompt?.length, 20_000);
  assert.equal(sessionInputFromBody({}, { initialPrompt: "x".repeat(20_000) }).initialPrompt?.length, 20_000);   // 경계값 그대로
  assert.equal(sessionInputFromBody({}, { initialPrompt: "  pwd  " }).initialPrompt, "  pwd  ");
});

// #4906 — 두 입구가 같은 모양으로 답한다: 세션과 함께 **서버가 넣을 첫 지시**(화면이 그 글을 첫 지시로 기억한다 — launchReply 머리말).
//  엣지 표 B1~B8(태스크 이름 채우기 · 태스크 여러 개 · 첨부 좌표 고침 · 평범 · 없음 · 옛 서버 · 이상값) — 화면 쪽 표는 scripts/spawn-first-prompt-runtime.test.mjs.
test("launchReply: 넣을 첫 지시를 세션과 함께 답한다 — 서버가 지은 글 그대로(다듬지 않는다) (#4906 B1~B5)", () => {
  const s = { id: "box-a", projectId: 7 };
  assert.deepEqual(launchReply(s, { initialPrompt: "태스크 #9 진행해\n\n본문 끝 공백  " }), { session: s, initialPrompt: "태스크 #9 진행해\n\n본문 끝 공백  " });
  assert.equal(launchReply(s, { initialPrompt: "지시" }).session, s);   // 같은 세션 객체 — 복사 · 변형 없이 싣는다
});

test("launchReply: 넣을 첫 지시가 없으면 싣지 않는다 — 없음 · 빈 · 공백뿐 · 문자열 아님 (#4906 B6·B8)", () => {
  const s = { id: "box-a" };
  for (const v of [undefined, null, "", "   ", "\n\t", 123, {}]) {
    const r = launchReply(s, { initialPrompt: v });
    assert.deepEqual(r, { session: s }, JSON.stringify(v));
    assert.equal(Object.prototype.hasOwnProperty.call(r, "initialPrompt"), false, JSON.stringify(v));
  }
});

test("launchReply: 관문이 읽은 첫 지시를 그대로 답한다 — sessionInputFromBody 의 20,000자 자르기 뒤의 글 (#4906)", () => {
  const input = sessionInputFromBody({}, { harness: "claude", initialPrompt: "가".repeat(25_000) });
  assert.equal(launchReply({ id: "x" }, input).initialPrompt, "가".repeat(20_000));
  assert.equal(launchReply({ id: "x" }, sessionInputFromBody({}, { harness: "claude", initialPrompt: "   " })).initialPrompt, undefined);
});
