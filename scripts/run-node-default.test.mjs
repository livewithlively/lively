// #2172 — 새 UI 새 세션의 **기본 실행 노드**. 지시(윤상민 2026-08-27): "디폴트가 직전에 선택했던 노드인데,
//  항상 중앙 컴퓨터가 가장 낮은 우선순위, 내 활성화된 노드가 높은 우선순위로. 활성화된 노드가 여러개면
//  그중 가장 최근에 활성화된 노드를 선택해줘."
//
//  규칙(web/v2/run-picker.ts defaultNodeId): 켜져 있는 **내 컴퓨터** > 켜져 있는 **공유 컴퓨터** > **중앙**('').
//  같은 등급이면 **가장 최근에 붙은 것**(connectedAt). 꺼진 노드는 후보가 아니다(서버가 409 로 막는다).
//
//  ⚠ 값(규칙)과 소스텍스트를 함께 보는 이유: 규칙이 맞아도 화면이 그걸 안 부르고 기억(prefs.node)을 되살리면
//   그대로고, 서버가 mine·connectedAt 을 안 실어 보내면 규칙이 늘 '목록 첫 노드'로 무너진다(조용한 회귀).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };
const eq = (got, want, name) => { assert.equal(got, want, `${name} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); pass++; console.log(`ok  ${name}`); };

// 번들은 브라우저 코드다 — core.js 가 최상단에서 location 등을 읽으므로 최소 스텁을 깔고 부른다(#2022 log-rows 와 같은 방식).
globalThis.window = globalThis;
globalThis.location = { href: "http://localhost/", hash: "", search: "", pathname: "/", origin: "http://localhost" };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} }), addEventListener() {}, documentElement: {}, body: {} };
const { defaultNodeId, nodeCanRunAi } = await import(join(root, "public/app/v2/run-picker.js"));

const n = (id, o) => ({ id, name: id, ...o });

// ── A. 후보가 없을 때는 중앙('') ────────────────────────────────────────────
eq(defaultNodeId([]), "", "A1 노드가 하나도 없으면 중앙");
eq(defaultNodeId([n("mac", { mine: true, online: false, connectedAt: null })]), "", "A2 내 노드가 꺼져 있으면 중앙(꺼진 노드엔 세션을 못 만든다)");
eq(defaultNodeId([n("box", { mine: false, shared: true, online: false })]), "", "A3 공유 노드가 꺼져 있어도 중앙");

// ── B. 켜져 있는 내 컴퓨터가 최우선 ──────────────────────────────────────────
eq(defaultNodeId([n("mac", { mine: true, online: true, connectedAt: 100 })]), "mac", "B1 켜져 있는 내 노드 하나면 그것");
eq(defaultNodeId([
  n("old", { mine: true, online: true, connectedAt: 100 }),
  n("new", { mine: true, online: true, connectedAt: 900 }),
]), "new", "B2 켜진 내 노드가 여럿이면 가장 최근에 붙은 것");
eq(defaultNodeId([
  n("new", { mine: true, online: true, connectedAt: 900 }),
  n("old", { mine: true, online: true, connectedAt: 100 }),
]), "new", "B3 목록 순서와 무관하게 최신 연결이 이긴다");
eq(defaultNodeId([
  n("off", { mine: true, online: false, connectedAt: null }),
  n("on", { mine: true, online: true, connectedAt: 10 }),
]), "on", "B4 꺼진 내 노드는 건너뛰고 켜진 내 노드");

// ── C. 등급이 연결시각을 이긴다 — 내 것 > 공유 > 중앙 ────────────────────────
eq(defaultNodeId([
  n("shared", { mine: false, shared: true, online: true, connectedAt: 900 }),
  n("mine", { mine: true, online: true, connectedAt: 100 }),
]), "mine", "C1 공유 노드가 더 최근에 붙었어도 내 노드가 이긴다");
eq(defaultNodeId([
  n("shared-a", { mine: false, shared: true, online: true, connectedAt: 100 }),
  n("shared-b", { mine: false, shared: true, online: true, connectedAt: 900 }),
]), "shared-b", "C2 내 노드가 없으면 공유 노드 중 최근 것(중앙은 가장 낮다)");
eq(defaultNodeId([n("mine-shared", { mine: true, shared: true, online: true, connectedAt: 1 })]), "mine-shared",
  "C3 내 노드를 관리자가 공유로 지정해도 '내 것' 등급(shared 와 mine 은 직교)");

// ── D. 구 게이트웨이 폴백 — mine·connectedAt 을 안 줄 때 ─────────────────────
eq(defaultNodeId([
  n("theirs", { shared: true, online: true }),
  n("mine", { online: true }),
]), "mine", "D1 mine 미보고면 '공유가 아니면 내 것'으로 본다");
eq(defaultNodeId([
  n("first", { mine: true, online: true }),
  n("second", { mine: true, online: true }),
]), "first", "D2 connectedAt 미보고로 동률이면 서버가 준 목록 순서를 따른다(안정 정렬)");

// ── G. #2172 회귀(윤상민 2026-08-28 신고, 매니지드) — **AI 를 못 띄우는 노드를 자동 기본으로 뽑았다** ──
//  그 PC 는 하네스 탐지에서 `shell` 만 보고한다. 노드를 고르면 그 PC 가 띄울 수 있는 것만 남기는 규칙(#1744)과
//  겹치면서 제공자 목록이 통째로 비고, 제공자·모델·추론강도 세 칸이 잠긴 채 **기억해 둔 하네스로만** 세션이
//  열렸다(클로드를 고를 방법이 없었다). 종전엔 기본이 '직전에 고른 값'이라 직접 고를 때만 들어가던 자리를,
//  #2172 가 '가장 최근에 붙은 내 노드'로 바꾸면서 **자동으로** 들어가게 만들었다.
//  → 자동 기본은 AI 를 하나라도 띄울 수 있는 노드만 고른다. 직접 고르는 것은 그대로 된다.
//  사양·엣지 표는 스크래치패드 spec2.md — 아래 번호가 그 행이다.
eq(defaultNodeId([n('win', { mine: true, online: true, connectedAt: 900, harnesses: ['shell'] })]), "",
  "G7 켜진 노드가 shell 뿐이면 중앙 — AI 를 못 고르는 자리에 자동으로 보내지 않는다");
eq(defaultNodeId([
  n('win', { mine: true, online: true, connectedAt: 900, harnesses: ['shell'] }),
  n('mac', { mine: true, online: true, connectedAt: 100, harnesses: ['claude', 'shell'] }),
]), 'mac', "G8 더 최근에 붙었어도 AI 가 없으면 진다");
eq(defaultNodeId([
  n('win', { mine: true, online: true, connectedAt: 900, harnesses: ['shell'] }),
  n('team', { mine: false, shared: true, online: true, connectedAt: 100, harnesses: ['codex'] }),
]), 'team', "G9 '내 것' 등급보다 '열 수 있나'가 먼저다");
eq(defaultNodeId([
  n('a', { mine: true, online: true, connectedAt: 100, harnesses: ['claude'] }),
  n('b', { mine: true, online: true, connectedAt: 900, harnesses: ['claude'] }),
]), 'b', "G10 둘 다 AI 가 있으면 기존 규칙 그대로(최근 우선)");
eq(defaultNodeId([
  n('off', { mine: true, online: false, connectedAt: null, harnesses: ['claude'] }),
  n('win', { mine: true, online: true, connectedAt: 900, harnesses: ['shell'] }),
]), "", "G11 꺼진 AI 노드와 켜진 shell-only 뿐이면 중앙");

// nodeCanRunAi 자체의 경계 — 미보고는 '제한 없음'이라야 목록(nodeAllow)과 기본값이 갈리지 않는다.
eq(nodeCanRunAi(n('x', { harnesses: ['shell'] })), false, "G1 shell 뿐이면 AI 를 못 연다");
eq(nodeCanRunAi(n('x', { harnesses: ['claude', 'shell'] })), true, "G2 AI 가 하나라도 있으면 된다");
eq(nodeCanRunAi(n('x', { harnesses: ['codex'] })), true, "G3 셸이 없어도 AI 만 있으면 된다");
eq(nodeCanRunAi(n('x', {})), true, "G4 미보고(구 번들)는 제한 없음으로 본다");
eq(nodeCanRunAi(n('x', { harnesses: [] })), true, "G5 빈 배열도 미보고와 같게 본다");
eq(nodeCanRunAi(n('x', { harnesses: ['shell', 'shell'] })), false, "G6 셸만 여러 개여도 AI 는 없다");

// ── E. 화면이 그 규칙을 실제로 쓰나 — 기억(prefs.node)을 기본으로 되살리지 않는다 ──
const PICKER = read("web/v2/run-picker.ts");
const codeOnly = PICKER.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
ok(/nodeKey\s*=\s*defaultNodeId\(nodes\)/.test(codeOnly), "E1 초기 노드 값이 규칙에서 온다");
ok(/if\s*\(!nodePicked\s*\|\|/.test(codeOnly), "E2 사람이 고르기 전에는 다시 그릴 때마다 규칙이 정한다");
ok(!/prefs\.node/.test(codeOnly), "E3 실행 노드는 기억(prefs.node)을 기본으로 읽지 않는다 — 이 지시의 핵심");
ok(/node:\s*nodeKey/.test(codeOnly), "E4 고른 값을 기억에 되쓰는 것은 그대로(클래식 폼이 아직 그 기억을 쓴다)");

// ── W. 배선 — 빈 목록 문구가 둘로 갈리나, 셸 판정이 한 곳인가 ────────────────
//  값(규칙)이 맞아도 화면이 여전히 '지난번 설정 그대로'만 말하면, 왜 못 고르는지는 화면에서 답을 못 얻는다.
ok(/harnesses\.length \? '이 컴퓨터엔 AI 가 없어요' : '지난번 설정 그대로'/.test(codeOnly),
  "W1 고를 것이 없을 때 — 카탈로그를 받았으면 'AI 가 없어요', 못 받았으면 '지난번 설정 그대로'");
ok(/const isAiHarness = \(key: string\): boolean => key !== 'shell'/.test(codeOnly),
  "W2a 셸 제외 판정이 이름 붙은 한 곳에 있다");
ok(/filter\(\(h\) => isAiHarness\(h\.key\)/.test(codeOnly) && /harnesses\.some\(isAiHarness\)/.test(codeOnly),
  "W2b 목록 거르기(paint)와 노드 판정(nodeCanRunAi)이 같은 규칙을 쓴다");

// ── F. 서버가 규칙의 근거를 실어 보내나 ─────────────────────────────────────
const ROUTES = read("src/terminal/routes.ts");
const REGISTRY = read("src/node/registry.ts");
ok(/mine:\s*n\.owner_member === me/.test(ROUTES), "F1 /terminal/config 가 mine(내 소유)을 준다");
ok(/connectedAt:\s*live\.get\(n\.id\)\?\.connectedAt/.test(ROUTES), "F2 /terminal/config 가 connectedAt(연결 시각)을 준다");
ok(/connectedAt:\s*Date\.now\(\)/.test(REGISTRY), "F3 노드 연결이 수립될 때 그 시각을 기록한다");
ok(/connectedAt:\s*c\.connectedAt/.test(REGISTRY), "F4 liveNodes() 가 그 시각을 노출한다");

console.log(`\n${pass} assertions passed`);
