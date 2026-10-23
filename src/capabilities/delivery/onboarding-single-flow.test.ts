// 처음 설정 단일화(#4970 PR2) — 반영의 관리 권한 가드 · 처음 설정 차례 · [연결할게요] 순서 · 리브 입구.
//  사양·엣지 표: <스크래치패드>/spec-onboarding.md (PR2 의 E12~E18 — PR2 는 connect-session.test 에 있었다). PR3(#4970 «리브 = 세션 하나»)이
//   따로 열던 연결 세션 문을 리브에게 일 맡기기(me_liv_open)로 합치면서 그 파일을 걷어, 처음 설정 쪽 행만 여기로 옮겼다(행 번호 그대로).
//   바뀐 행: E17 의 마지막 줄(연결 문 = openLiv job:connect) · E18(리브 입구 스위치 — 이제 켜짐).
//  실행: npm run build && node dist/capabilities/delivery/onboarding-single-flow.test.js
//  ⚠ 반영(B)·화면(C)은 DB·브라우저가 필요해 소스 구조로 못박는다(레포 선례 — welcome.test W1~W7).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** 주석 줄을 걷은 소스 — 주석에 적힌 «하지 않는다» 설명이 단언에 걸리지 않게. */
const code = (s: string): string => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

let pass = 0, fail = 0;
const t = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); pass++; console.log(`ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
};

// ── B. 반영 — 관리 권한 가드 ──────────────────────────────────────────────────
const WELCOME = code(readFileSync(new URL("./welcome.js", import.meta.url).pathname.replace("/dist/", "/src/").replace(/\.js$/, ".ts"), "utf8"));
const APPLY = WELCOME.slice(WELCOME.indexOf('restRead("me_welcome_apply"'));

await t("E12 팀 구조는 관리 권한 아래에서만 만든다 · 합류 판정을 쓰지 않는다", () => {
  assert.match(APPLY, /const admin = isAdmin\(user\);/, "권한을 서버 신원으로 안 잰다");
  const guard = APPLY.indexOf("if (admin) {");
  assert.ok(guard > 0, "팀 구조 블록이 관리 권한 가드 아래에 없다");
  for (const k of ["createCategory(", "ensureLocalFilesDistiller(", "applyLaneSkeleton(", "seedCategoryGroups("]) {
    const at = APPLY.indexOf(k);
    assert.ok(at > guard, `${k} 가 권한 가드 밖에 있다`);
  }
  assert.doesNotMatch(WELCOME, /is_join|currentJoinFact|joinFactFor|resolveJoinFact|\/api\/tenant\/membership/, "★ 처음 설정이 아직 합류 판정·계정 서버 membership 을 쓴다");
});

await t("E13 용도는 관리 권한이면 입력값, 아니면 지금의 용도", () => {
  assert.match(APPLY, /const stage = admin\s*\?\s*s\(input\.stage, 40\)\s*:\s*await workspacePurposeStage\(/, "권한 없는 사람의 답이 워크스페이스 용도가 된다");
});

await t("E14 반영은 리브 세션을 열지 않는다 · 새로 끝내는 사람에게 flow 를 적지 않는다", () => {
  assert.doesNotMatch(WELCOME, /kickoffLivAfterWelcome|livKickoff\(|buildFirstTurnPrompt|planLivKickoff/, "★ 리브 킥오프가 남아 있다");
  assert.doesNotMatch(APPLY, /welcome: \{[^}]*\bflow\b/, "★ flow 를 적는다 — 리브 2턴 후보가 된다");
});

// ── C. 처음 설정 화면 ────────────────────────────────────────────────────────
const OB_RAW = readFileSync(new URL("../../../web/v2/onboarding.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const OB = code(OB_RAW);

await t("E15 차례는 인사 → 이름 → AI 연결 → 연결 물음(첫 관리자·합류자 같음) — (PR4) AI 연결이 외부 앱 앞이다", () => {
  const m = OB.match(/const ORDER = (\[[^\]]*\]);/);
  assert.ok(m, "차례표를 못 찾았다 — 검사가 헛돈다");
  assert.deepEqual(JSON.parse(m![1]!.replace(/'/g, '"')), ["intro", "name", "ai", "connect-ask"]);
  assert.doesNotMatch(OB, /ORDER_JOIN|isJoin\(|JOIN\b/, "합류자 갈래가 남아 있다");
});

await t("E16 옛 판의 저장된 자리를 알아본다(team→name · done→connect-ask · 그 밖의 옛 장면→ai · 빈 값→null)", () => {
  const fn = OB.match(/function fitScene\(scene: unknown\): string \| null \{([\s\S]*?)\n  \}/);
  assert.ok(fn, "fitScene 을 못 찾았다");
  //  타입 표기만 걷어 그대로 돌린다(본문은 화면이 쓰는 그 글자다).
  const body = fn![1]!.replace(/: string \| null/g, "");
  const fitScene = new Function("STEP_OF", "scene", body) as (steps: Record<string, number>, s: unknown) => string | null;
  const STEP_OF = { intro: 0, name: 1, ai: 2, "connect-ask": 3 };
  const cases: Array<[unknown, string | null]> = [
    ["intro", "intro"], ["name", "name"], ["ai", "ai"], ["connect-ask", "connect-ask"],
    //  (PR4) 옛 «AI 연결»(claude)·질문 장면들은 AI 연결부터 — 외부 앱 물음으로 건너뛰면 AI 를 안 잇고 지나간다.
    ["team", "name"], ["claude", "ai"], ["done", "connect-ask"], ["stage", "ai"], ["app", "ai"],
    ["", null], [null, null],
  ];
  for (const [inp, want] of cases) assert.equal(fitScene(STEP_OF, inp), want, `fitScene(${JSON.stringify(inp)})`);
});

await t("E17 [연결할게요] — 반영 성공 뒤에만 연결 세션 문 · ai:false 면 세 걸음 · ai:true 면 그 주소", () => {
  const yes = OB.slice(OB.indexOf("async function connectYes"), OB.indexOf("function renderScene"));
  const applyAt = yes.indexOf("await finishOnboarding()");
  const openAt = yes.indexOf("openConnectSession()");
  assert.ok(applyAt > 0 && openAt > applyAt, "반영보다 먼저 연결 세션을 연다 — 반영이 실패해도 세션이 열린다");
  assert.match(yes, /if \(!\(await finishOnboarding\(\)\)\) \{[^}]*return;/, "반영이 실패해도 계속 간다");
  assert.match(yes, /if \(r\.ai\) \{[\s\S]*?location\.hash = r\.href;/, "AI 있음인데 그 세션으로 안 간다");
  assert.match(yes, /ownAiStepsHtml\(\)/, "AI 없음인데 «쓰는 AI 에서 하기» 를 안 그린다");
  const FIN = OB.slice(OB.indexOf("async function finishOnboarding"), OB.indexOf("async function connectYes"));
  assert.match(FIN, /api\('\/api\/ui\/me\/welcome', \{ method: 'POST'/, "반영 문(POST /api/ui/me/welcome)을 안 부른다");
  //  승인받은 적 없는 분류(서랍)를 조용히 만들지 않는다 — 처음 설정은 서랍을 묻지 않으므로 보내지도 않는다(옛 onboarding-no-chat ③).
  assert.doesNotMatch(FIN, /drawers|stage:|job:/, "묻지 않은 서랍·용도·직무를 반영에 싣는다");
  //  (PR3) 연결은 리브에게 맡긴다 — 리브 세션이 있으면 그 세션, 없으면 연결 말로 연다(me_liv_open job:connect).
  const OWN = code(readFileSync(new URL("../../../web/v2/connect-own-ai.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8"));
  assert.match(OWN, /const r = await openLiv\(\{ job: 'connect' \}\);/, "★ [연결할게요]가 리브에게 맡기지 않는다(연결이 리브와 다른 세션으로 갈린다)");
  const OPEN = code(readFileSync(new URL("../../../web/v2/liv-open.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8"));
  assert.match(OPEN, /api\('\/api\/ui\/me\/liv\/open', \{ method: 'POST'/, "리브에게 일 맡기기 문을 안 부른다");
});

await t("E18 리브 진입점 네 자리가 한 스위치를 본다 — (PR3) 켜짐: 레일 [리브]는 남고 도착지가 리브 세션이다", () => {
  const SW = readFileSync(new URL("../../../web/lib/liv-entry.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
  assert.match(SW, /export const LIV_ENTRY_VISIBLE: boolean = true;/, "★ 스위치가 없거나 꺼져 있다 — 리브로 들어가는 문이 없다(상민님 결정 2026-10-22 «레일 [리브] 줄은 남긴다»)");
  for (const f of ["rail.ts", "side.ts", "mobile.ts", "me-modal.ts"]) {
    const src = code(readFileSync(new URL(`../../../web/v2/${f}`, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8"));
    assert.match(src, /LIV_ENTRY_VISIBLE/, `${f} 가 스위치를 안 본다`);
    //  스위치 밖에 남은 리브 링크가 없어야 한다 — '#/liv' 가 나오는 줄은 전부 스위치와 같은 줄이거나 그 조건 안이다.
    for (const line of src.split("\n").filter((l) => l.includes("'#/liv'"))) {
      assert.match(line, /LIV_ENTRY_VISIBLE|livOn/, `${f}: 스위치 밖의 리브 링크 — ${line.trim().slice(0, 80)}`);
    }
  }
});

// ── F. (PR4 · 상민님 2026-10-23) AI 연결 장면 — 사양·엣지 표: 스크래치패드 spec-ai-step.md §F·§G ─────────────────
const AI = OB.slice(OB.indexOf("function bindAi("), OB.indexOf("function say("));

await t("F3 이 서버에서 띄울 수 있는(설치된) AI 만 줄로 — 서버 installed 가 false 면 안 보인다 · 순서는 [AI 계정 연결]과 같다", () => {
  assert.ok(AI.length > 200, "bindAi 를 못 찾았다 — 검사가 헛돈다");
  assert.match(AI, /api\('\/api\/ui\/me\/ai-accounts'\)/, "목록을 서버에 안 묻는다");
  assert.match(AI, /AI_ORDER\.map\(\(k\) => byKey\.get\(k\)\)\.filter\(\(a\) => a && a\.installed !== false\)/, "★ 설치 안 된 AI 를 고르게 한다(위시스트는 클로드뿐이다)");
  assert.match(AI, /OB_COPY\.aiNone/, "띄울 AI 가 하나도 없을 때 할 말이 없다");
});

await t("F4 [다음]은 연결된 AI 가 하나라도 있을 때만 켜진다", () => {
  assert.match(AI, /next\.disabled = !rows\.some\(\(a\) => a\.loggedIn === true\);/, "연결 없이 [다음]이 켜진다 — 외부 앱 연결이 AI 없이 시작된다");
  assert.match(OB, /<button class="ob-btn ob-btn-pri" id="aiNext" disabled>/, "처음부터 켜져 있다");
});

await t("F5 «PC에서 쓰는 AI로» — 다음 장면으로 가고, [연결할게요]가 서버 세션 대신 «쓰는 AI 에서 하기» 를 그린다", () => {
  assert.match(AI, /pc\.onclick = \(\) => \{ S\.viaPc = true; goScene\(nextScene\('ai'\)!\); \};/);
  assert.match(AI, /next\.onclick = \(\) => \{ S\.viaPc = false; goScene\(nextScene\('ai'\)!\); \};/, "AI 를 이은 사람의 PC 표식을 안 지운다");
  const yes = OB.slice(OB.indexOf("async function connectYes"), OB.indexOf("function renderScene"));
  const fin = yes.indexOf("await finishOnboarding()"), pc = yes.indexOf("if (S.viaPc) { showOwnAi(el); return; }"), open = yes.indexOf("await openOrGuide(el)");
  assert.ok(fin > 0 && pc > fin && open > pc, "반영 뒤 · 세션 열기 전에 PC 길을 가르지 않는다");
  assert.match(OB, /viaPc: v\.viaPc === true,/, "이어 열기에서 PC 표식을 잃는다");
});

await t("F6 로그인 칸은 한 벌 — [AI 계정 연결](me-ai)과 처음 설정이 같은 부품(ai-login-panel)을 쓴다", () => {
  assert.match(OB_RAW, /from '\.\.\/ai-login-panel\.js';/, "처음 설정이 공용 칸을 안 쓴다");
  assert.match(AI, /aiLoginPanel\(a, /, "줄에 로그인 칸을 안 붙인다");
  assert.match(AI, /confirmSharedLogin\(a\)/, "서버 공용 계정의 물음을 건너뛴다");
  const ME = code(readFileSync(new URL("../../../web/me-ai.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8"));
  assert.match(ME, /from '\.\/ai-login-panel\.js';/, "[AI 계정 연결]이 공용 칸을 안 쓴다");
  assert.doesNotMatch(ME, /ensureLoginTerminal|const paintCard|const paintTerminal/, "★ 로그인 칸이 두 벌이다 — 실측 처방이 갈린다");
});

await t("G 계정 목록이 설치 여부(installed)를 싣는다", () => {
  const R = code(readFileSync(new URL("../../terminal/routes.js", import.meta.url).pathname.replace("/dist/", "/src/").replace(/\.js$/, ".ts"), "utf8"));
  const at = R.indexOf('app.get("/api/ui/me/ai-accounts"');
  const body = R.slice(at, R.indexOf("}));", at));
  assert.ok(at > 0, "목록 라우트를 못 찾았다");
  assert.match(body, /harnessInstalled\(a\.key\)/, "설치를 안 묻는다");
  assert.match(body, /installed: installed\[i\]/, "설치 여부를 안 싣는다");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
