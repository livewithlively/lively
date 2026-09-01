// 화면 셸 기본값(#2200, 대표 결정 2026-08-27) — **클래식이 기본이 되는 자리를 하나도 두지 않는다.**
//  사양·엣지 표: <스크래치패드>/spec-ui-mode-default.md — 1~7·11~13 행을 여기서, 8~10 행(실제 마이그레이션)은
//  src/org/schema/ui-mode-default.pg-test.mjs 에서(컬럼 기본값에 사는 버그는 단위테스트로 안 잡힌다).
//  실행: npm run build && node dist/org/store/ui-mode-default.test.js
//
// 왜 한 파일이 자리 넷을 함께 잡나: 새 워크스페이스가 클래식으로 뜬 원인은 한 곳이 아니라
//  **기본값을 정하는 자리가 넷**이었고 그 중 셋이 classic 이었다(uiModeSafe · 컬럼 DEFAULT ·
//  프론트 폴백 · whoami 폴백). 하나만 고치면 나머지 셋으로 되살아나므로 넷을 한 자리에서 못박는다.
//  ①이 결정적이다 — workspace_create 는 행이 없는 상태에서 updateRuntimeConfig 를 부르고,
//  그 INSERT 는 ①이 접은 값을 **명시적으로** 싣는다(컬럼 DEFAULT 는 그 경로에 관여하지 않는다).
//
// red 입증: 변경 전 코드(`git show HEAD:…`)에 대고 돌려 ①③ 행이 빨간불인 것을 먼저 확인했다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { uiModeSafe } from "./runtime-config.js";

let pass = 0, fail = 0;
// 실패해도 멈추지 않는다 — 기본값 자리가 여럿인 게 이 버그의 본질이라 **어느 자리가 빨간불인지 전부** 봐야 한다.
const t = (name: string, fn: () => void): void => {
  try { fn(); pass++; console.log(`ok  ${name}`); }
  catch (e) { fail++; console.log(`not ok  ${name}\n    ${(e as Error).message.split("\n")[0]}`); }
};

// dist 에서 돌지만 읽는 대상은 **소스**다(②③④ 는 실행 가능한 형태로 노출돼 있지 않다 — DDL 문자열·
//  브라우저 모듈·응답 조립부). 소스가 SoT 이므로 dist 경로를 src 로 되돌려 읽는다(welcome.test.ts 선례).
const ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/dist\/$/, "/");
const src = (rel: string): string => readFileSync(ROOT + rel, "utf8");

// ── ① uiModeSafe — 새 워크스페이스의 저장값을 정하는 자리 ────────────────────

t("1·2행 값이 없으면 v2 — 새 워크스페이스가 클래식으로 굳지 않는다", () => {
  assert.equal(uiModeSafe(undefined), "v2");   // 행 자체가 없음(= 새 워크스페이스)
  assert.equal(uiModeSafe(null), "v2");        // 컬럼은 있고 값이 NULL
});

t("3행 잡값·모르는 값도 v2 — 침묵이 클래식이 되지 않는다", () => {
  for (const v of ["", "  ", "v3", "CLASSIC", "Classic", "dashboard", 0, false, {}, []]) {
    assert.equal(uiModeSafe(v), "v2", `uiModeSafe(${JSON.stringify(v)})`);
  }
});

t("4행 'classic' 은 그대로 산다 — 고른 사람의 선택을 코드가 되돌리지 않는다", () => {
  assert.equal(uiModeSafe("classic"), "classic");
});

t("5행 'v2' 는 v2", () => {
  assert.equal(uiModeSafe("v2"), "v2");
});

// ── ② 컬럼 DEFAULT — ①을 안 타는 직접 INSERT 의 이중 안전장치 ───────────────

t("6행 org_runtime_config.ui_mode 컬럼 기본값이 v2 다", () => {
  assert.match(src("src/org/schema/runtime-config.ts"),
    /ADD COLUMN IF NOT EXISTS ui_mode TEXT NOT NULL DEFAULT 'v2'/);
});

t("7행 매 부팅 기본값을 classic 으로 되돌리는 문장이 없다", () => {
  assert.doesNotMatch(src("src/org/schema/runtime-config.ts"),
    /ALTER COLUMN ui_mode SET DEFAULT 'classic'/,
    "그 문장이 살아 있으면 컬럼 기본값이 재시작마다 클래식으로 되돌아간다");
});

// ── ③ 프론트 폴백 — 서버가 값을 못 줘도 새 화면 ─────────────────────────────
//  브라우저 모듈이라 node 로 import 할 수 없다(location·localStorage). 폴백 **방향**만 소스로 못박는다:
//  `'v2' 면 v2, 아니면 classic` 형태가 되살아나면(= 부재가 클래식) 빨간불이 된다.

t("11·12행 web/lib/state.ts uiMode() 는 classic 일 때만 classic 이다", () => {
  const s = src("web/lib/state.ts");
  assert.match(s, /m === 'classic' \? 'classic' : 'v2'/);
  assert.doesNotMatch(s, /return m === 'v2' \? 'v2' : 'classic'/,
    "값 부재·잡값이 클래식으로 떨어지면 안 된다");
});

// ── ④ whoami — 화면이 셸을 고르기 전에 읽는 me.ui_mode ──────────────────────

t("13행 whoami 의 ui_mode 폴백이 v2 다", () => {
  assert.match(src("src/capabilities/whoami.ts"), /ui_mode: ui\?\.ui_mode \?\? "v2"/,
    "ui 조회 실패(ui=null) 시에도 새 화면이어야 한다");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
