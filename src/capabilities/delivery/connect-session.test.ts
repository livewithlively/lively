// 처음 설정 단일화(#4970) — 외부 앱 연결 세션 열기 · 반영의 관리 권한 가드 · 처음 설정 차례.
//  사양·엣지 표: <스크래치패드>/spec-onboarding.md (E1~E18). red 입증은 mutation(신규) · 변경 전 코드(welcome.ts·onboarding.ts).
//  실행: npm run build && node dist/capabilities/delivery/connect-session.test.js
//  ⚠ 세션 열기(A)는 의존을 주입해 **부작용(호출 기록)** 으로 잰다. 반영(B)·화면(C)은 DB·브라우저가 필요해 소스 구조로 못박는다(레포 선례 — welcome.test W1~W7).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CONNECT_FIRST_PROMPT, connectSessionHref, openConnectSession, pickConnectHarness, type ConnectOpenDeps,
} from "./connect-session.js";

/** 주석 줄을 걷은 소스 — 주석에 적힌 «하지 않는다» 설명이 단언에 걸리지 않게. */
const code = (s: string): string => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

let pass = 0, fail = 0;
const t = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); pass++; console.log(`ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
};

const user = { userId: "u1", email: "u1@example.invalid", scopes: ["memory"], projects: ["*"] } as never;
/** 호출 기록이 남는 가짜 의존 — 무엇이 실제로 불렸나로 단언한다. */
function fake(o: { current?: string | null | Error; usable?: string[] | Error; launchable?: string[]; launchId?: string; rememberFails?: boolean } = {}) {
  const log = { current: 0, usable: 0, launch: [] as Array<{ harness: string }>, remember: [] as string[] };
  const deps: ConnectOpenDeps = {
    current: async () => { log.current++; if (o.current instanceof Error) throw o.current; return o.current ?? null; },
    usable: async () => { log.usable++; if (o.usable instanceof Error) throw o.usable; return o.usable ?? []; },
    launchable: async () => o.launchable ?? ["claude", "codex", "opencode", "antigravity", "grok"],
    launch: async (_u, harness) => { log.launch.push({ harness }); return { id: o.launchId ?? "box-u1-new", session: { id: o.launchId ?? "box-u1-new" } }; },
    remember: async (_uid, sid) => { if (o.rememberFails) throw new Error("db down"); log.remember.push(sid); },
  };
  return { deps, log };
}

// ── A. 세션 열기 ────────────────────────────────────────────────────────────
await t("E1 쓸 세션이 있으면 그 세션 — 로그인 조회·생성 0회", async () => {
  const { deps, log } = fake({ current: "box-u1-old", usable: ["claude"] });
  const r = await openConnectSession(user, deps);
  assert.deepEqual(r, { ai: true, session_id: "box-u1-old", href: "#/s/box-u1-old", reused: true });
  assert.equal(log.current, 1, "좌표를 안 봤다(배선)");
  assert.equal(log.usable, 0, "남은 세션이 있는데 비싼 로그인 조회를 했다");
  assert.equal(log.launch.length, 0, "남은 세션이 있는데 또 열었다");
});

await t("E2 쓸 세션 없음 · 로그인 없음 → ai:false · 생성·기록 0회", async () => {
  const { deps, log } = fake({ usable: [] });
  const r = await openConnectSession(user, deps);
  assert.deepEqual(r, { ai: false, reason: "ai-not-connected" });
  assert.equal(log.usable, 1, "로그인을 안 물었다(배선)");
  assert.equal(log.launch.length, 0);
  assert.equal(log.remember.length, 0);
});

await t("E3 우대 없음 — 로그인한 것 가운데 첫 번째(codex)로 연다", async () => {
  const { deps, log } = fake({ usable: ["codex", "claude"] });
  const r = await openConnectSession(user, deps);
  assert.equal(r.ai, true);
  assert.deepEqual(log.launch, [{ harness: "codex" }], "claude 를 우대했다 — 설계는 우대 없음");
  assert.deepEqual(log.remember, ["box-u1-new"], "새로 연 세션의 좌표를 안 남겼다");
});

await t("E4 띄울 수 없는 것(셸)은 건너뛰고 다음(opencode)", async () => {
  const { deps, log } = fake({ usable: ["shell", "opencode"], launchable: ["claude", "opencode"] });
  await openConnectSession(user, deps);
  assert.deepEqual(log.launch, [{ harness: "opencode" }]);
});

await t("E5 카탈로그에 없는 것만 로그인돼 있으면 ai:false", async () => {
  const { deps, log } = fake({ usable: ["cursor"], launchable: ["claude"] });
  assert.deepEqual(await openConnectSession(user, deps), { ai: false, reason: "ai-not-connected" });
  assert.equal(log.launch.length, 0);
});

await t("E6 좌표 기록이 실패해도 세션은 연 것으로 답한다", async () => {
  const { deps } = fake({ usable: ["claude"], rememberFails: true, launchId: "box-u1-x" });
  const r = await openConnectSession(user, deps) as { ai: boolean; session_id?: string };
  assert.equal(r.ai, true);
  assert.equal(r.session_id, "box-u1-x");
});

await t("E7 좌표 조회가 던지면 쓸 세션 없음으로 보고 연다", async () => {
  const { deps, log } = fake({ current: new Error("db"), usable: ["claude"] });
  const r = await openConnectSession(user, deps);
  assert.equal(r.ai, true);
  assert.equal(log.launch.length, 1);
});

await t("E8 로그인 조회가 던지면 ai:false", async () => {
  const { deps, log } = fake({ usable: new Error("probe") });
  assert.deepEqual(await openConnectSession(user, deps), { ai: false, reason: "ai-not-connected" });
  assert.equal(log.launch.length, 0);
});

await t("E9 인증 없으면 401 — 아무것도 부르지 않는다", async () => {
  const { deps, log } = fake({ usable: ["claude"] });
  await assert.rejects(openConnectSession({ userId: "" } as never, deps), (e: { status?: number }) => e?.status === 401);
  assert.equal(log.current + log.usable + log.launch.length, 0);
});

await t("E10 세션 모양 — task · 개인 루트 그 자체 · 첫 지시가 연결 스킬을 부른다 · 자동 승인 없음", () => {
  //  launch 의 실제 구현(realDeps)은 launchSession 을 부른다 — 그 입력을 소스에서 못박는다(tmux·DB 없이).
  const SRC = code(readFileSync(new URL("./connect-session.js", import.meta.url).pathname.replace("/dist/", "/src/").replace(/\.js$/, ".ts"), "utf8"));
  const launch = SRC.slice(SRC.indexOf("launch: async (user, harness)"), SRC.indexOf("remember: async"));
  assert.match(launch, /kind: "task"/, "세션 종류가 task 가 아니다 — 이름 짓기·프로젝트 자동 생성 승인이 뜬다");
  assert.match(launch, /rootKey: "personal", subpath: ""/, "개인 루트 그 자체가 아니다 — 신뢰 대화상자 앞에서 첫 지시가 멈추거나 리브 부팅 훅이 붙는다");
  assert.match(launch, /autoApprove: false/);
  assert.match(launch, /initialPrompt: CONNECT_FIRST_PROMPT/);
  assert.match(CONNECT_FIRST_PROMPT, /liv-connect/, "첫 지시가 연결 스킬 이름을 말하지 않는다");
  assert.doesNotMatch(SRC, /welcome[^\n]*session_id|setLivSession\(/, "★ 연결 세션 좌표를 리브 자리(welcome.session_id·liv_session)에 적는다 — 리브 2턴이 끼어든다");
});

await t("E11 화면이 갈 곳 — 세션 화면(id 인코딩)", () => {
  assert.equal(connectSessionHref("box-a 1"), "#/s/box-a%201");
  assert.equal(pickConnectHarness([], ["claude"]), null, "빈 로그인 목록");
});

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

await t("E15 차례는 인사 → 이름 → 연결 물음 하나뿐(첫 관리자·합류자 같음)", () => {
  const m = OB.match(/const ORDER = (\[[^\]]*\]);/);
  assert.ok(m, "차례표를 못 찾았다 — 검사가 헛돈다");
  assert.deepEqual(JSON.parse(m![1]!.replace(/'/g, '"')), ["intro", "name", "connect-ask"]);
  assert.doesNotMatch(OB, /ORDER_JOIN|isJoin\(|JOIN\b/, "합류자 갈래가 남아 있다");
});

await t("E16 옛 판의 저장된 자리를 알아본다(team→name · 그 뒤의 장면·done→connect-ask · 빈 값→null)", () => {
  const fn = OB.match(/function fitScene\(scene: unknown\): string \| null \{([\s\S]*?)\n  \}/);
  assert.ok(fn, "fitScene 을 못 찾았다");
  //  타입 표기만 걷어 그대로 돌린다(본문은 화면이 쓰는 그 글자다).
  const body = fn![1]!.replace(/: string \| null/g, "");
  const fitScene = new Function("STEP_OF", "scene", body) as (steps: Record<string, number>, s: unknown) => string | null;
  const STEP_OF = { intro: 0, name: 1, "connect-ask": 2 };
  const cases: Array<[unknown, string | null]> = [
    ["intro", "intro"], ["name", "name"], ["connect-ask", "connect-ask"],
    ["team", "name"], ["claude", "connect-ask"], ["done", "connect-ask"], ["stage", "connect-ask"], ["app", "connect-ask"],
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
  const OWN = readFileSync(new URL("../../../web/v2/connect-own-ai.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
  assert.match(OWN, /api\('\/api\/ui\/me\/connect-session', \{ method: 'POST'/, "연결 세션 문을 안 부른다");
});

await t("E18 리브 진입점 네 자리가 한 스위치(기본 꺼짐)를 본다", () => {
  const SW = readFileSync(new URL("../../../web/lib/liv-entry.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
  assert.match(SW, /export const LIV_ENTRY_VISIBLE: boolean = false;/, "스위치가 없거나 켜져 있다");
  for (const f of ["rail.ts", "side.ts", "mobile.ts", "me-modal.ts"]) {
    const src = code(readFileSync(new URL(`../../../web/v2/${f}`, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8"));
    assert.match(src, /LIV_ENTRY_VISIBLE/, `${f} 가 스위치를 안 본다`);
    //  스위치 밖에 남은 리브 링크가 없어야 한다 — '#/liv' 가 나오는 줄은 전부 스위치와 같은 줄이거나 그 조건 안이다.
    for (const line of src.split("\n").filter((l) => l.includes("'#/liv'"))) {
      assert.match(line, /LIV_ENTRY_VISIBLE|livOn/, `${f}: 스위치 밖의 리브 링크 — ${line.trim().slice(0, 80)}`);
    }
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
