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

//  (#5060 원준님 2026-10-27) 갈래(flow)는 다시 적는다 — 올린 파일이 지식이 되는 길(리브 2턴)이 그 갈래로 온다. 단 정해진 판정 한 자리
//   (welcomeFlowMarks — 관리 권한 아래 · 화면이 보낸 모양만)에서만 나온다. 판정의 행은 welcome.test F1~F6 이 잰다.
await t("E14 반영은 리브 세션을 열지 않는다 · 갈래는 welcomeFlowMarks 한 자리에서만 나온다(#5060)", () => {
  assert.doesNotMatch(WELCOME, /kickoffLivAfterWelcome|livKickoff\(|buildFirstTurnPrompt|planLivKickoff/, "★ 리브 킥오프가 남아 있다");
  assert.doesNotMatch(APPLY, /welcome: \{[^}]*\bflow\s*:/, "★ 판정을 거치지 않은 flow 를 손으로 적는다");
  assert.match(APPLY, /const fresh = welcomeFlowMarks\(\{ admin, /, "★ 갈래를 관리 권한 판정 없이 정한다");
});

// ── C. 처음 설정 화면 ────────────────────────────────────────────────────────
const OB_RAW = readFileSync(new URL("../../../web/v2/onboarding.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const OB = code(OB_RAW);

await t("E15 차례는 인사 → 이름 → 앱으로 이어 하기 → 파일 올리기 → AI 연결 → 연결 물음(첫 관리자·합류자 같음) — (PR4) AI 연결이 외부 앱 앞 · (#5060) 파일 올리기가 AI 연결 앞 · 앱 장면은 이름 다음(어디서 건너뛰나는 onboarding-app-scene-runtime A3~A5)", () => {
  const m = OB.match(/const ORDER = (\[[^\]]*\]);/);
  assert.ok(m, "차례표를 못 찾았다 — 검사가 헛돈다");
  assert.deepEqual(JSON.parse(m![1]!.replace(/'/g, '"')), ["intro", "name", "desktop", "upload", "ai", "connect-ask"]);
  assert.doesNotMatch(OB, /ORDER_JOIN|isJoin\(|JOIN\b/, "합류자 갈래가 남아 있다");
});

await t("E16 옛 판의 저장된 자리를 알아본다(team→name · done→connect-ask · 그 밖의 옛 장면→ai · 빈 값→null)", () => {
  const fn = OB.match(/function fitScene\(scene: unknown\): string \| null \{([\s\S]*?)\n  \}/);
  assert.ok(fn, "fitScene 을 못 찾았다");
  //  타입 표기만 걷어 그대로 돌린다(본문은 화면이 쓰는 그 글자다).
  const body = fn![1]!.replace(/: string \| null/g, "");
  const fitScene = new Function("STEP_OF", "scene", body) as (steps: Record<string, number>, s: unknown) => string | null;
  const STEP_OF = { intro: 0, name: 1, desktop: 2, upload: 3, ai: 4, "connect-ask": 5 };
  const cases: Array<[unknown, string | null]> = [
    ["intro", "intro"], ["name", "name"], ["desktop", "desktop"], ["upload", "upload"], ["ai", "ai"], ["connect-ask", "connect-ask"],
    //  (PR4) 옛 «AI 연결»(claude)·질문 장면들은 AI 연결부터 — 외부 앱 물음으로 건너뛰면 AI 를 안 잇고 지나간다.
    ["team", "name"], ["claude", "ai"], ["done", "connect-ask"], ["stage", "ai"], ["app", "ai"],
    ["", null], [null, null],
  ];
  for (const [inp, want] of cases) assert.equal(fitScene(STEP_OF, inp), want, `fitScene(${JSON.stringify(inp)})`);
});

await t("E17 [연결할게요] — 반영 성공 뒤에만 연결 세션 문 · ai:false 면 세 걸음 · ai:true 면 그 주소", () => {
  const yes = OB.slice(OB.indexOf("async function connectYes"), OB.indexOf("function renderScene"));
  const applyAt = yes.indexOf("await finishOnboarding('connect')");
  const openAt = yes.indexOf("openConnectSession({ fromWelcome: true })");
  assert.ok(applyAt > 0 && openAt > applyAt, "반영보다 먼저 연결 세션을 연다 — 반영이 실패해도 세션이 열린다");
  assert.match(yes, /if \(!\(await finishOnboarding\('connect'\)\)\) \{[^}]*return;/, "반영이 실패해도 계속 간다");
  assert.match(yes, /if \(r\.ai\) \{[\s\S]*?location\.hash = r\.href;/, "AI 있음인데 그 세션으로 안 간다");
  assert.match(yes, /ownAiStepsHtml\(\)/, "AI 없음인데 «쓰는 AI 에서 하기» 를 안 그린다");
  const FIN = OB.slice(OB.indexOf("async function finishOnboarding"), OB.indexOf("async function connectYes"));
  assert.match(FIN, /api\('\/api\/ui\/me\/welcome', \{ method: 'POST'/, "반영 문(POST /api/ui/me/welcome)을 안 부른다");
  //  승인받은 적 없는 분류(서랍)를 조용히 만들지 않는다 — 처음 설정은 서랍을 묻지 않으므로 보내지도 않는다(옛 onboarding-no-chat ③).
  assert.doesNotMatch(FIN, /drawers|stage:|job:/, "묻지 않은 서랍·용도·직무를 반영에 싣는다");
  //  (PR3) 연결은 리브에게 맡긴다 — 리브 세션이 있으면 그 세션, 없으면 연결 말로 연다(me_liv_open job:connect).
  const OWN = code(readFileSync(new URL("../../../web/v2/connect-own-ai.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8"));
  assert.match(OWN, /const r = await openLiv\(\{ job: 'connect', fromWelcome: !!o\.fromWelcome \}\);/, "★ [연결할게요]가 리브에게 맡기지 않는다(연결이 리브와 다른 세션으로 갈린다)");
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

// ── F. (PR4 · 상민님 2026-10-23) AI 연결 장면 — 설계: 지식 onboarding-single-flow-connect-in-own-ai-4970 §16 · 표 = 아래 F 행 ─────────────────
//  화면 틀([다음]·PC 길)은 onboarding.ts 의 bindAi, 줄·로그인 칸은 onboarding-ai.ts(mountAiList)다.
const AI = OB.slice(OB.indexOf("function bindAi("), OB.indexOf("function say("));
const OAI_RAW = readFileSync(new URL("../../../web/v2/onboarding-ai.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const OAI = code(OAI_RAW);

await t("F3 이 서버에서 띄울 수 있는(설치된) AI 만 줄로 — installed 가 false 면 안 보인다 · 모름은 보인다 · 순서는 [AI 계정 연결]과 같다", () => {
  assert.ok(AI.length > 200 && OAI.length > 2000, "bindAi·mountAiList 를 못 찾았다 — 검사가 헛돈다");
  assert.match(AI, /mountAiList\(list, \{/, "장면이 목록 부품을 안 붙인다");
  assert.match(OAI, /api\('\/api\/ui\/me\/ai-accounts'\)/, "목록을 서버에 안 묻는다");
  //  고르는 규칙 그 자체를 돌린다 — 타입만 걷어 화면이 쓰는 그 글자를 실행한다.
  const m = OAI_RAW.match(/export function visibleAiRows\(accounts: readonly AiAccountRow\[\]\): AiAccountRow\[\] \{([\s\S]*?)\n\}/);
  assert.ok(m, "visibleAiRows 를 못 찾았다");
  const body = m![1]!.replace(/\(a\): a is AiAccountRow =>/, "(a) =>");
  const pick = new Function("AI_ORDER", "accounts", body) as (order: string[], acc: Array<{ key: string; installed?: boolean | null }>) => Array<{ key: string }>;
  const ORDER = ["claude", "codex", "antigravity", "grok"];
  const got = pick(ORDER, [
    { key: "grok", installed: true }, { key: "codex", installed: false }, { key: "claude", installed: null },
    { key: "antigravity" }, { key: "opencode", installed: true },
  ]).map((a) => a.key);
  assert.deepEqual(got, ["claude", "antigravity", "grok"], "★ 설치 안 된 AI 를 고르게 하거나(위시스트는 클로드뿐) · 모름을 숨기거나 · 순서가 표와 다르다");
  assert.match(OB, /aiNone: '/, "띄울 AI 가 하나도 없을 때 할 말이 없다");
});

//  F4(#5167 개정) — [다음]은 «다 된» AI 가 있어야 켠다. 매니지드는 자동 정리가 따로 받은 자격으로만 돌아, 로그인만 하고 넘어간 사람은
//   리브가 규칙을 다 세워도 정리 잡이 자격 없음으로 멈췄다(2026-10-30 lively-agent-5·-2 실측). 판정 표(aiStepReady):
//   R1 로그인 없음 → 안 켠다 · R2 클로드 로그인 · 현황 모름 → 안 켠다 · R3 클로드 로그인 · 자격 불필요(자체호스팅) → 켠다
//   R4 클로드 로그인 · 자격 필요 · 없음 → 안 켠다 · R5 같은데 승인함 → 켠다 · R6 화면에서 못 받는 AI(제미나이)만 로그인 → 켠다(막아도 해 줄 게 없다)
//   R7 클로드 미승인 · 코덱스 승인 → 켠다(하나면 된다) · R8 로그인 모름(null) → 안 켠다
await t("F4 [다음]은 다 된 AI 가 하나라도 있을 때만 켜진다 — 로그인 + (필요하면) 자동 정리 승인(#5167)", () => {
  assert.match(AI, /onRows: \(ready\) => \{ next\.hidden = false; next\.disabled = !ready; S\.serverAi = ready; save\(\); \}/, "다 되지 않았는데 [다음]이 켜진다");
  assert.match(OAI, /hooks\.onRows\(ready\(\)\)/, "줄을 그린 뒤 판정을 안 다시 잰다");
  assert.doesNotMatch(OAI, /hooks\.onRows\(\[\.\.\.items\.values\(\)\]\.some\(\(\w+\) => \w+\.a\.loggedIn === true\)\)/, "★ 옛 판정(로그인만)이 남아 있다");
  assert.match(OB, /<button class="ob-btn ob-btn-pri" id="aiNext" disabled>/, "처음부터 켜져 있다");
  const m = OAI_RAW.match(/export function aiStepReady\([^)]*\): boolean \{([\s\S]*?)\n\}/);
  assert.ok(m, "aiStepReady 를 못 찾았다 — 검사가 헛돈다");
  type Row = { key: string; loggedIn: boolean | null };
  type Hl = { needed: boolean; ok: Set<string> } | null;
  const ready = new Function("HEADLESS_INLINE", "rows", "hl", m![1]!) as (h: Record<string, true>, rows: Row[], hl: Hl) => boolean;
  const H = { claude: true, codex: true } as Record<string, true>;
  const need = (...ok: string[]): Hl => ({ needed: true, ok: new Set(ok) });
  assert.equal(ready(H, [{ key: "claude", loggedIn: false }], need()), false, "R1");
  assert.equal(ready(H, [{ key: "claude", loggedIn: true }], null), false, "R2 현황을 모르는데 켠다");
  assert.equal(ready(H, [{ key: "claude", loggedIn: true }], { needed: false, ok: new Set() }), true, "R3 자체호스팅을 막는다");
  assert.equal(ready(H, [{ key: "claude", loggedIn: true }], need()), false, "★ R4 자동 정리 자격 없이 넘어간다");
  assert.equal(ready(H, [{ key: "claude", loggedIn: true }], need("claude")), true, "R5");
  assert.equal(ready(H, [{ key: "antigravity", loggedIn: true }], need()), true, "R6 화면에서 못 받는 AI 를 막는다");
  assert.equal(ready(H, [{ key: "claude", loggedIn: true }, { key: "codex", loggedIn: true }], need("codex")), true, "R7");
  assert.equal(ready(H, [{ key: "claude", loggedIn: null }], need("claude")), false, "R8 모름을 로그인으로 접는다");
  //  승인 칸은 [내 AI 계정]과 같은 부품(발급 규칙이 한 곳) — 묻는 곳은 needed 를 싣는 현황 라우트.
  assert.match(OAI, /headlessParts\(row, /, "승인 칸을 따로 지어낸다");
  assert.match(OAI, /api\('\/api\/ui\/me\/headless'\)/, "자동 정리 자격 현황을 안 묻는다");
});

await t("F5 «PC에서 쓰는 AI로» — 다음 장면으로 가고, [연결할게요]가 서버 세션 대신 «쓰는 AI 에서 하기» 를 그린다", () => {
  assert.match(AI, /pc\.onclick = \(\) => \{ S\.viaPc = true; goScene\(nextScene\('ai'\)!\); \};/);
  assert.match(AI, /next\.onclick = \(\) => \{ S\.viaPc = false; goScene\(nextScene\('ai'\)!\); \};/, "AI 를 이은 사람의 PC 표식을 안 지운다");
  const yes = OB.slice(OB.indexOf("async function connectYes"), OB.indexOf("function renderScene"));
  const fin = yes.indexOf("await finishOnboarding('connect')"), pc = yes.indexOf("if (S.viaPc) { showOwnAi(el); return; }"), open = yes.indexOf("await openOrGuide(el)");
  assert.ok(fin > 0 && pc > fin && open > pc, "반영 뒤 · 세션 열기 전에 PC 길을 가르지 않는다");
  assert.match(OB, /viaPc: v\.viaPc === true,/, "이어 열기에서 PC 표식을 잃는다");
});

await t("F6 로그인 칸은 한 벌 — [AI 계정 연결](me-ai)과 처음 설정이 같은 부품(ai-login-panel)을 쓴다", () => {
  assert.match(OAI_RAW, /from '\.\.\/ai-login-panel\.js';/, "처음 설정이 공용 칸을 안 쓴다");
  assert.match(OAI, /aiLoginPanel\(it\.a, /, "줄에 로그인 칸을 안 붙인다");
  assert.match(OAI, /confirmSharedLogin\(it\.a\)/, "서버 공용 계정의 물음을 건너뛴다");
  const ME = code(readFileSync(new URL("../../../web/me-ai.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8"));
  assert.match(ME, /from '\.\/ai-login-panel\.js';/, "[AI 계정 연결]이 공용 칸을 안 쓴다");
  assert.doesNotMatch(ME + OAI, /ensureLoginTerminal|const paintCard|const paintTerminal/, "★ 로그인 칸이 두 벌이다 — 실측 처방이 갈린다");
});

// ── G. (#5060 원준님 2026-10-27) 파일 올리기 — AI 연결 앞 · 기다리지 않는다 · 정리는 세션(리브 2턴)이 ──────────────────
//  G1 고른 파일은 백그라운드 대기열로 — 장면은 올라가길 기다리지 않는다([다음]이 올리기 완료에 묶이지 않는다)
//  G2 반영에 올리기(running|done — uploadVerdict)와 다음 걸음(connect|later)을 싣는다 · PC 의 AI 를 고른 사람은 늘 later(서버가 연결 대화를 안 연다)
//  G3 «리브가 정리해 둘게요» 는 서버가 files 갈래를 세웠을 때만
//  G4 올리기 끝(upload_done)은 판정(uploadVerdict)이 done 일 때만 · 바뀔 때마다 다시 잰다([다시 시도] 뒤에도) · 반영·연결 대화 묶기 뒤 한 번 더
//  G5 대기열 — 주소는 apiUrl(워크스페이스를 싣는다) · 탭 닫기 경고(도는 동안만) · 올린 것 건너뛰기 표지는 워크스페이스마다(동작은 scripts/bg-upload-runtime.test B1~B7)
const UP = OB.slice(OB.indexOf("function bindUpload("), OB.indexOf("function say("));
const BG = code(readFileSync(new URL("../../../web/v2/bg-upload.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8"));
await t("G1 고른 파일은 대기열로 — 장면은 기다리지 않는다", () => {
  assert.ok(UP.length > 300 && BG.length > 1000, "bindUpload·bg-upload 를 못 찾았다 — 검사가 헛돈다");
  assert.match(UP, /bgUploadAdd\(/, "고른 파일을 대기열에 안 넣는다");
  assert.match(UP, /next\.onclick = \(\) => \{ off\(\); goScene\(nextScene\('upload'\)!\); \};/, "[다음]이 바로 다음 장면으로 가지 않는다");
  assert.doesNotMatch(UP, /await\s+bgUpload|await\s+send|whenIdle\([^)]*goScene/, "★ 다 올라갈 때까지 사람을 세운다");
});
await t("G2 반영에 올리기·다음 걸음을 싣는다", () => {
  const FIN = OB.slice(OB.indexOf("async function finishOnboarding"), OB.indexOf("async function connectYes"));
  assert.match(FIN, /const upload = S\.uploaded \? uploadVerdict\(bgUploadState\(\), S\.uploaded\) : undefined;/, "올리기 상태를 판정 없이 싣는다 — 실패만 남아도 «다 올렸다» 가 나간다");
  assert.match(FIN, /next: S\.viaPc \? 'later' : next,/, "PC 의 AI 를 고른 사람의 [연결할게요]가 서버 연결 대화를 기다리는 갈래가 된다");
  assert.match(OB, /finishOnboarding\('later'\)/, "[나중에 할게요]가 다음 걸음을 안 싣는다");
});
await t("G3 «정리해 둘게요» 는 서버가 세운 갈래를 따른다", () => {
  assert.match(OB, /appliedFlow === 'files' \? OB_COPY\.uploadLater/, "★ 서버가 갈래를 안 세웠는데 정리해 두겠다고 약속한다");
});
await t("G4 올리기 끝을 서버에 알린다", () => {
  const POST = OB.slice(OB.indexOf("function postUploadDoneIfSettled("), OB.indexOf("function watchWelcomeUploads("));
  assert.match(POST, /if \(uploadVerdict\(s, welcomeUploadExpected\) !== 'done'/, "★ 판정 없이 «올리기 끝» 을 보낸다(실패만 남아도 2턴이 풀린다)");
  assert.match(POST, /body: JSON\.stringify\(\{ upload_done: true \}\)/, "올리기 끝(upload_done)을 안 보낸다 — 2턴이 상한(90분)까지 기다린다");
  assert.match(OB, /bgUploadOnChange\(\(\) => postUploadDoneIfSettled\(\)\)/, "바뀔 때마다 다시 재지 않는다 — [다시 시도]로 풀린 뒤 알림이 안 간다");
  assert.match(OB, /if \(upload === 'running'\) \{ welcomeUploadExpected = S\.uploaded; welcomeUploadSentAt = -1; postUploadDoneIfSettled\(\); \}/, "반영 직전에 끝난 올리기의 알림이 버려진다");
});
await t("G5 대기열 — 주소는 apiUrl · 탭 닫기 경고 · 표지는 워크스페이스마다", () => {
  assert.match(BG, /xhr\.open\('PUT', apiUrl\(/, "★ 주소를 apiUrl 로 안 만든다 — 셀프호스트 다중 워크스페이스에서 primary 로 올라간다");
  assert.match(BG, /addEventListener\('beforeunload', onBeforeUnload\)/, "탭을 닫아도 묻지 않는다");
  assert.match(BG, /removeEventListener\('beforeunload', onBeforeUnload\)/, "다 끝난 뒤에도 탭 닫기를 막는다");
  assert.match(BG, /const doneKeyName = \(\): string => wsKey\(/, "건너뛰기 표지가 워크스페이스를 모른다 — 다른 워크스페이스에 올린 것을 «이미 올렸다» 로 건너뛴다");
});

await t("F7 다시 읽어도 줄을 갈아 끼우지 않는다 — 로그인 중인 칸(터미널 액자·받은 코드)이 옮겨지거나 지워지지 않는다(격리 리뷰 N1·N3)", () => {
  //  줄 모음이 같으면 제자리 고침(update)만 — 통째 바꾸기(replaceChildren)는 «모음이 달라졌을 때» 한 곳뿐이다.
  const paint = OAI.slice(OAI.indexOf("const paint = "), OAI.indexOf("let running"));
  assert.ok(paint.length > 200, "paint 를 못 찾았다");
  assert.equal((OAI.match(/list\.replaceChildren\(/g) || []).length, 1, "줄을 통째로 바꾸는 자리가 둘 이상이다");
  assert.match(paint, /if \(!same\) \{[\s\S]*list\.replaceChildren\([\s\S]*\} else \{\s*for \(const a of rows\) update\(items\.get\(a\.key\)!, a\);/, "같은 줄 모음인데 통째로 다시 그린다");
  //  다시 읽기가 실패해도 이미 그린 줄은 남는다 — 오류를 목록 자리에 쓰는 것은 «아직 하나도 못 그렸을 때» 뿐이다.
  const fail = OAI.slice(OAI.indexOf("catch (e) {"), OAI.indexOf("const rows = visibleAiRows(acc)"));
  assert.ok(fail.length > 100, "실패 갈래를 못 찾았다 — 검사가 헛돈다");
  assert.match(fail, /if \(!items\.size\) \{[\s\S]*list\.innerHTML =[\s\S]*ob-ai-retry[\s\S]*\} else \{[\s\S]*note\.innerHTML =[\s\S]*ob-ai-retry/, "★ 다시 읽기 실패가 목록·로그인 칸을 지우거나 다시 읽을 길이 없다");
  //  제미나이 확인(수 초)을 기다리느라 다른 줄이 늦지 않게 — 먼저 그리고 나서 묻는다.
  const once = OAI.slice(OAI.indexOf("const once = "), OAI.indexOf("const reload = "));
  assert.ok(once.indexOf("paint(rows);") > 0 && once.indexOf("paint(rows);") < once.indexOf("ai-accounts/check"), "프로브를 기다린 뒤에야 그린다");
  //  겹친 다시 읽기는 끝난 뒤 한 번 더 — 진행 중인 낡은 답을 돌려주고 끝내지 않는다.
  assert.match(OAI, /if \(running\) \{ again = true; return running; \}/, "겹친 다시 읽기가 낡은 답으로 끝난다");
});

await t("G 계정 목록이 설치 여부(installed)를 싣는다", () => {
  const R = code(readFileSync(new URL("../../terminal/routes.js", import.meta.url).pathname.replace("/dist/", "/src/").replace(/\.js$/, ".ts"), "utf8"));
  const at = R.indexOf('app.get("/api/ui/me/ai-accounts"');
  const body = R.slice(at, R.indexOf("}));", at));
  assert.ok(at > 0, "목록 라우트를 못 찾았다");
  assert.match(body, /harnessInstalled\(a\.key\)/, "설치를 안 묻는다");
  assert.match(body, /installed: installed\[i\]/, "설치 여부를 안 싣는다");
});

await t("F8·G2 격리 박스 — 로그인 전에 그 사람 서버 계정을 갖춘다(장면이 준비를 묻고 다 되면 그린다 · 로그인 시작이 끝까지 기다린다)", () => {
  //  안 갖추면 첫 세션 전 로그인이 공용 자리로 가고(resolveMemberOsUser «미프로비저닝 → 공유 폴백»), 계정이 생긴 뒤엔 «로그인 안 됨».
  //  기다림의 순서 자체는 login-seat-prep.test(S·P 행)가 동작으로 잰다 — 여기는 배선이다.
  assert.match(OAI, /api\('\/api\/ui\/me\/ai-login\/prepare', \{ method: 'POST', body: JSON\.stringify\(\{ retry: !!o\.retry, start: !!o\.start \}\) \}\)/, "장면이 계정 준비를 안 묻는다(또는 start 를 안 싣는다)");
  const prep = OAI.slice(OAI.indexOf("const prepare = async"), OAI.lastIndexOf("void prepare();"));
  assert.ok(prep.length > 200, "준비 흐름을 못 찾았다 — 검사가 헛돈다");
  //  (#5031) 장면은 열 때 **묻기만** 한다 — 만들기는 사람이 [연결]을 누를 때(seatThenOpen). 동작은 화면 시험 Q0·Q8~Q11 이 잰다.
  assert.match(prep, /await askSeat\(\{ retry, start: retry \}\)/, "★ 장면을 열자마자 계정을 만든다 — PC 길을 고를 사람도 치른다");
  assert.match(prep, /if \(state === 'preparing' \|\| \(!state && sawPreparing\)\) \{[\s\S]*?setTimeout\(\(\) => \{ void prepare\(\); \}, PREP_POLL_MS\);[\s\S]*?return;/, "★ 만드는 중인데 목록을 그린다(«이 서버 공용 계정» 거짓 문구)");
  assert.ok(prep.indexOf("void reload();") > prep.indexOf("state === 'failed'"), "준비 판정보다 먼저 목록을 그린다");
  const R = code(readFileSync(new URL("../../terminal/routes.js", import.meta.url).pathname.replace("/dist/", "/src/").replace(/\.js$/, ".ts"), "utf8"));
  const pr = R.slice(R.indexOf('app.post("/api/ui/me/ai-login/prepare"'), R.indexOf('app.post("/api/ui/me/ai-login/start"'));
  assert.match(pr, /const state = await prepareMemberSeat\(seatDeps\(req\)/, "준비 라우트가 계정 준비를 안 부른다");
  assert.match(pr, /res\.json\(\{ ok: true, state \}\)/, "준비 상태를 안 돌려준다 — 화면이 언제 그릴지 모른다");
  const start = R.slice(R.indexOf('app.post("/api/ui/me/ai-login/start"'), R.indexOf('app.get("/api/ui/me/ai-login/state"'));
  const w = start.indexOf("await awaitMemberSeat(seatDeps(req));"), seat = start.indexOf("const seat = await loginSeat(req);");
  assert.ok(w > 0 && seat > w, "★ 로그인 자리를 정한 뒤에 계정을 기다린다 — 첫 로그인이 공용 자리로 간다");
  assert.match(R, /const seatDeps = [\s\S]*?inflight: \(\) => memberProvisioning\(u\)/, "진행 중인 만들기를 안 본다 — 계정만 생긴 순간 넘어간다");
  const hl = R.slice(R.indexOf('app.post("/api/ui/me/headless-login/start"'), R.indexOf('app.get("/api/ui/me/headless-login/state"'));
  assert.ok(hl.length > 100, "헤드리스 로그인 시작을 못 찾았다 — 검사가 헛돈다");
  const hw = hl.indexOf("await awaitMemberSeat(seatDeps(req));"), hs = hl.indexOf("const seat = await loginSeat(req);");
  assert.ok(hw > 0 && hs > hw, "★ 헤드리스 로그인 시작이 계정 준비를 안 기다린다 — 같은 틈");
  assert.match(prep, /if \(state === 'preparing' \|\| \(!state && sawPreparing\)\) \{\s*sawPreparing = true;/, "★ «준비하는 중» 뒤 한 번 못 물으면 목록을 그린다(거짓 «공용 계정» 이 되살아난다)");
});

// ── P. (#5167) 처음 설정 뒤 «올린 파일이 지식이 되기까지» — 진행 띠 · 리브 즉시 열기 · 리브보다 먼저 정리하지 않기 ─────────────
//  계기: 2026-10-30 lively-agent-5(75개 → 자료 11 · mp3 64)·agent-2(295개) 실측. 띠가 «다 올렸어요» 뒤 사라지고, 리브는 3분 21초 말없이 기다렸고,
//   정리 잡은 자격 없음으로 멈춘 줄 아무도 몰랐다. 단계 판정은 org/liv/setup-status.test 가 잰다 — 여기는 화면 문구와 배선.
//   P1 단계마다 둘째 줄: waiting·working·organizing·needs-ai 는 띠를 걷지 않는다(keep) · needs-ai 는 [내 AI 계정]으로 · done·stopped 는 걷어도 된다
//   P2 이 브라우저가 올리는 중이면 uploading 은 첫째 줄이 말한다(둘째 줄 없음) · 아니면 이어 올리는 법을 말한다
//   P3 남은 자료 수를 그대로 말한다 · 단계가 없으면(null) 걷는다
//   P4 올리기 줄 — 자료로 안 만든 것이 있으면 그 수와 «파일은 그대로» 를 말한다 · 없으면 붙이지 않는다
//   P5 배선 — 처음 설정 끝 → 띠 시작 · 셸 부팅 → 표지로 이어 보기 · 반영·«다 올렸다» → 리브 즉시 판정 · 증류 → 처음 설정 대기면 쉰다
const SW_RAW = readFileSync(new URL("../../../web/v2/setup-watch.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const BG_RAW = readFileSync(new URL("../../../web/v2/bg-upload.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const fnBody = (src: string, sig: RegExp): string => {
  const m = src.match(sig);
  assert.ok(m, `${sig} 를 못 찾았다 — 검사가 헛돈다`);
  return m![1]!;
};
type Line = { text: string; href?: string; label?: string; keep: boolean } | null;
const setupLine = new Function("s", "uploadingHere",
  fnBody(SW_RAW, /export function setupLine\(s: SetupStatus \| null, uploadingHere: boolean\): BgSetupLine \| null \{([\s\S]*?)\n\}/)) as
  (s: { phase: string; session_id: string | null; backlog: number | null; note: string | null } | null, here: boolean) => Line;
const S = (phase: string, backlog: number | null = null) => ({ phase, session_id: "box-x-1", backlog, note: null });

await t("P1 단계마다 둘째 줄 — 진행 중이면 띠를 안 걷는다 · 자격이 막히면 [내 AI 계정]으로", () => {
  for (const ph of ["waiting", "connecting", "working", "organizing", "needs-ai"]) {
    const l = setupLine(S(ph, 3), false);
    assert.ok(l && l.text.length > 10, `${ph} 에 할 말이 없다`);
    assert.equal(l!.keep, true, `★ ${ph} 인데 띠가 저절로 걷힌다 — 사람이 또 기다리는 이유를 모른다`);
  }
  assert.equal(setupLine(S("needs-ai"), false)?.href, "#/me/ai", "★ 멈췄는데 승인할 곳으로 안 데려간다");
  assert.equal(setupLine(S("working"), false)?.href, "#/liv", "리브 대화로 가는 길이 없다");
  assert.equal(setupLine(S("done", 0), false)?.keep, false, "끝났는데 띠가 남는다");
  assert.equal(setupLine(S("stopped"), false)?.keep, false);
});

await t("P2 uploading — 이 브라우저가 올리는 중이면 비우고, 아니면 이어 올리는 법을 말한다", () => {
  assert.equal(setupLine(S("uploading"), true), null, "첫째 줄과 같은 말을 두 번 한다");
  const l = setupLine(S("uploading"), false);
  assert.ok(l && /다시 올리면/.test(l.text) && l.keep, "★ 창을 닫았다 온 사람에게 이어 올리는 법을 안 말한다");
});

await t("P3 남은 자료 수를 그대로 · 단계 없음은 걷는다", () => {
  assert.match(setupLine(S("organizing", 286), false)!.text, /286개/, "남은 수를 안 말한다");
  assert.equal(setupLine(null, false), null);
});

await t("P4 올리기 줄 — 자료로 안 만든 것의 수와 «파일은 그대로»", () => {
  const body = fnBody(BG_RAW, /export function uploadLineText\(s: BgUploadState\): string \{([\s\S]*?)\n\}/);
  const line = new Function("fmt", "s", body) as (f: (n: number) => string, s: Record<string, unknown>) => string;
  const fmt = (n: number) => n.toLocaleString("ko-KR");
  const base = { total: 75, done: 75, failed: 0, skipped: 0, running: false };
  assert.match(line(fmt, { ...base, notSource: 64 }), /75개를 다 올렸어요.*64개는.*자료로 만들지 않았어요.*그대로/, "★ mp3 64개가 왜 자료가 아닌지 말하지 않는다");
  assert.doesNotMatch(line(fmt, { ...base, notSource: 0 }), /자료로 만들지/, "없는 것을 말한다");
  assert.match(line(fmt, { ...base, done: 12, running: true, notSource: 0 }), /12 \/ 75.*닫으면 멈춰요/, "올리는 중에 창을 닫으면 멈춘다는 걸 안 말한다");
  assert.match(BG_RAW, /resolve\(\{ notSource: notSourceOf\(xhr\.responseText\) \}\)/, "서버의 skipped 를 안 읽는다");
});

await t("P5 배선 — 띠 시작·이어 보기 · 리브 즉시 판정 · 리브보다 먼저 정리하지 않기", () => {
  const fin = OB.slice(OB.indexOf("async function finishOnboarding("), OB.indexOf("async function connectYes(") > 0 ? OB.indexOf("async function connectYes(") : undefined);
  assert.match(fin, /if \(S\.uploaded\) startSetupWatch\(\);/, "★ 처음 설정을 파일과 함께 끝냈는데 띠가 안 이어진다");
  const MAIN = code(readFileSync(new URL("../../../web/v2/main.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8"));
  assert.match(MAIN, /if \(!EMBEDDED\) resumeSetupWatch\(\);/, "새로고침하면 띠가 끊긴다");
  const APPLY_ALL = WELCOME.slice(WELCOME.indexOf('restRead("me_welcome_apply"'));
  assert.match(APPLY_ALL, /if \(profile\.welcome\?\.flow === "files" && profile\.welcome\?\.upload_done_at\) \{\s*void import\("\.\.\/\.\.\/org\/liv\/second-turn-sweep\.js"\)\.then\(\(\{ kickLivSecondTurn \}\) => kickLivSecondTurn\(\)\)/,
    "★ 다 올리고 끝냈는데 리브가 정비 주기(최대 5분)를 기다린다");
  const LIV = code(readFileSync(new URL("./liv.js", import.meta.url).pathname.replace("/dist/", "/src/").replace(/\.js$/, ".ts"), "utf8"));
  assert.match(LIV, /if \(uploadDone && profile\.welcome\?\.flow === "files"\) \{\s*void import\("\.\.\/\.\.\/org\/liv\/second-turn-sweep\.js"\)\.then\(\(\{ kickLivSecondTurn \}\) => kickLivSecondTurn\(\)\)/,
    "★ «다 올렸다» 를 받고도 리브가 정비 주기를 기다린다");
  const DIS = code(readFileSync(new URL("../../scheduler/actions/distill.js", import.meta.url).pathname.replace("/dist/", "/src/").replace(/\.js$/, ".ts"), "utf8"));
  const pick = DIS.slice(DIS.indexOf("async function pickDistillerBatch("));
  const hold = pick.indexOf("await onboardingHoldsDistill()");
  assert.ok(hold > 0 && hold < pick.indexOf("listDistillers"), "★ 리브가 규칙을 세우기 전에 기본 증류가 올린 파일을 먼저 집는다");
  assert.match(pick, /if \(!\(typeof params\.distiller === "string" && params\.distiller\.trim\(\)\) && await onboardingHoldsDistill\(\)\)/,
    "이름으로 부른 레인(사람·리브가 세운 것)까지 쉬게 한다");
  assert.match(DIS, /setupHoldsDistill\(c\.welcome, now\)/, "쉬는 판정을 setup-status 한 자리에서 안 한다");
});

//   P6 (격리 리뷰 2026-10-30) 못 읽은 것을 «끝» 으로 읽지 않는다 — 서버는 남은 수 실패를 0 으로 접지 않고, 화면은 오류면 단계를 그대로 둔 채 다시 묻는다
await t("P6 못 읽음 ≠ 끝 — 서버는 0 으로 접지 않고, 화면은 오류에 띠를 안 바꾼다", () => {
  const setupFn = WELCOME.slice(WELCOME.indexOf("export async function welcomeSetup("));
  assert.ok(setupFn.length > 200, "welcomeSetup 을 못 찾았다 — 검사가 헛돈다");
  assert.doesNotMatch(setupFn.slice(0, 1500), /\.catch\(\(\) => (0|null)\)/, "★ 남은 수·자격 조회 실패를 0·null 로 접는다 — 띠가 «정리했어요» 를 말하고 감시를 멈춘다");
  assert.match(setupFn, /d\.match_kinds\.includes\("local_file"\)/, "올린 파일을 안 받는 정리(슬랙 등)가 비었다고 «끝» 이라 한다");
  assert.match(WELCOME, /paths: \["\/api\/ui\/me\/welcome\/setup"\]/, "가벼운 단계 조회 라우트가 없다 — 띠가 무거운 현황 조회를 몇 시간 폴링한다");
  const SW = code(SW_RAW);
  const tick = SW.slice(SW.indexOf("async function tick("), SW.indexOf("const poke ="));
  const onErr = tick.slice(tick.indexOf("catch (_) {"), tick.indexOf("if (!watching) return;", tick.indexOf("catch (_) {")));
  assert.ok(onErr.length > 10, "tick 의 오류 갈래를 못 찾았다 — 검사가 헛돈다");
  assert.doesNotMatch(onErr, /bgSetupLine|setFlag\(false\)|watching = false/, "★ 한 번 못 읽었다고 띠를 지우거나 감시를 그친다");
  assert.match(tick, /api\('\/api\/ui\/me\/welcome\/setup'\)/, "단계 조회 라우트를 안 쓴다");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
