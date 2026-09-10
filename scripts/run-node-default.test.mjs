// #2172 — 새 UI 새 세션의 **기본 실행 노드**. 지시(윤상민 2026-08-27): "디폴트가 직전에 선택했던 노드인데,
//  항상 중앙 컴퓨터가 가장 낮은 우선순위, 내 활성화된 노드가 높은 우선순위로. 활성화된 노드가 여러개면
//  그중 가장 최근에 활성화된 노드를 선택해줘."
//
//  규칙(web/v2/run-prefs.ts defaultNodeId): 켜져 있는 **내 컴퓨터** > 켜져 있는 **공유 컴퓨터** > **중앙**('').
//  꺼진 노드는 후보가 아니다(서버가 409 로 막는다).
//
//  ⚠ #3833(2026-09-09) — 동률 깨기가 바뀌었다. 종전엔 «가장 최근에 붙은 것»(connectedAt) 하나였는데, 그것은
//   사람이 어디서 일하는지를 재지 못한다: 게이트웨이가 재시작하면 전 노드가 **동시에** 재접속하므로(실측:
//   두 노드의 connectedAt 이 134ms 차) 사실상 핸드셰이크 경주가 기본 컴퓨터를 정했다. 그래서 세션 23개가
//   도는 맥북을 두고 세션 0개인 PC 가 기본이 됐다(윤상민 신고). 이제 **내 컴퓨터끼리는 세션이 도는 쪽**이
//   이기고 connectedAt 은 마지막 동률 깨기로 남는다. 아래 S 절이 그 표다.
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
// #3778 — 규칙의 집은 run-prefs.ts 로 옮겨졌다(run-picker 는 재수출). [⚙] 기본값 창의 «실행 컴퓨터» 설정을 실제 노드로
//  푸는 resolveNodeDefault 도 거기 산다 — 설정이 비었으면(규칙대로) 이 규칙과 **같은 답**이어야 한다.
const { resolveNodeDefault, resolveNodeChoice, NODE_CENTRAL } = await import(join(root, "public/app/v2/run-prefs.js"));

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

// ── D. [⚙] 기본값 창의 «실행 컴퓨터» 설정 → 실제 노드(#3778 안 C) — 규칙을 덮되, 비었거나 못 쓰면 규칙으로 ──
{
  const mineOn = n('m1', { mine: true, online: true, connectedAt: 10 });
  const sharedOn = n('s1', { shared: true, online: true, connectedAt: 20 });
  const mineOff = n('m0', { mine: true, online: false });
  const nodes = [sharedOn, mineOn, mineOff];
  eq(resolveNodeDefault(nodes, ''), defaultNodeId(nodes), "D1 설정이 비었으면(규칙대로) 규칙과 같은 답");
  eq(resolveNodeDefault(nodes, NODE_CENTRAL), '', "D2 «항상 중앙» 은 노드가 켜져 있어도 중앙");
  eq(resolveNodeDefault(nodes, 's1'), 's1', "D3 특정 노드를 골랐고 켜져 있으면 그 노드");
  eq(resolveNodeDefault(nodes, 'm0'), defaultNodeId(nodes), "D4 고른 노드가 꺼져 있으면 규칙으로");
  eq(resolveNodeDefault(nodes, 'ghost'), defaultNodeId(nodes), "D5 사라진 노드를 가리키면 규칙으로");
  eq(resolveNodeDefault([], 'm1'), '', "D6 노드가 하나도 없으면 중앙");
}

// ── S. 동률 깨기(#3833) — 내 컴퓨터끼리는 «세션이 도는 쪽» ────────────────────
//  사양: ①소유가 세션 수를 이긴다 ②내 것끼리는 세션 수 ③그래도 같으면 최근 접속
//   ④공유끼리는 세션 수를 안 본다(거기 도는 건 남의 세션이라 «내가 쓰는 곳»을 뜻하지 않는다) ⑤미보고는 0.
eq(defaultNodeId([
  n('win', { mine: true, online: true, connectedAt: 1788947605917, sessions: 0 }),
  n('mac', { mine: true, online: true, connectedAt: 1788947605783, sessions: 23 }),
]), 'mac', "S1 내 것끼리는 세션 수가 최근접속을 이긴다(신고 그 상황 — 134ms 차)");
eq(defaultNodeId([
  n('old', { mine: true, online: true, connectedAt: 100, sessions: 0 }),
  n('new', { mine: true, online: true, connectedAt: 900, sessions: 0 }),
]), 'new', "S2 세션이 둘 다 0 이면 최근접속이 깬다");
eq(defaultNodeId([
  n('busy', { mine: false, shared: true, online: true, connectedAt: 100, sessions: 99 }),
  n('recent', { mine: false, shared: true, online: true, connectedAt: 900, sessions: 0 }),
]), 'recent', "S3 공유끼리는 세션 수를 안 본다 — 남의 세션이다");
eq(defaultNodeId([
  n('team', { mine: false, shared: true, online: true, connectedAt: 900, sessions: 99 }),
  n('mine', { mine: true, online: true, connectedAt: 100, sessions: 0 }),
]), 'mine', "S4 소유가 세션 수를 이긴다");
eq(defaultNodeId([
  n('a', { mine: true, online: true, connectedAt: 100 }),
  n('b', { mine: true, online: true, connectedAt: 900 }),
]), 'b', "S5 세션 수 미보고(구 게이트웨이)는 0 으로 보고 최근접속으로 깬다");
eq(defaultNodeId([
  n('shellbusy', { mine: true, online: true, connectedAt: 900, sessions: 99, harnesses: ['shell'] }),
  n('ai', { mine: true, online: true, connectedAt: 100, sessions: 0, harnesses: ['claude'] }),
]), 'ai', "S6 세션이 아무리 많아도 AI 를 못 띄우면 진다(자격이 순위보다 먼저)");

// ── R. 폴백을 조용히 하지 않는다(#3833) — 어디서 어디로 왜 옮겼는지가 값으로 나온다 ──
//  이게 없으면 «내가 고른 컴퓨터가 아닌 데서 열린 이유» 를 화면이 말할 수 없다(종전 상태).
{
  const macN = n('mac', { mine: true, online: true, connectedAt: 10, sessions: 23 });
  const winOff = n('win', { mine: true, online: false, sessions: 0 });
  const winShell = n('win', { mine: true, online: true, connectedAt: 90, harnesses: ['shell'] });
  const both = [macN, n('win', { mine: true, online: true, connectedAt: 90, sessions: 0 })];
  const deep = (got, want, name) => { assert.deepEqual(got, want, name); pass++; console.log(`ok  ${name}`); };
  deep(resolveNodeChoice(both, NODE_CENTRAL), { id: '', fellBack: null }, "R1 «항상 중앙» 은 폴백이 아니다");
  deep(resolveNodeChoice(both, 'win'), { id: 'win', fellBack: null }, "R2 고른 컴퓨터가 켜져 있으면 그대로 — 폴백 아님");
  deep(resolveNodeChoice(both, ''), { id: 'mac', fellBack: null }, "R3 아무것도 안 골랐으면 규칙대로 — 폴백이 아니다");
  deep(resolveNodeChoice([macN, winOff], 'win'),
    { id: 'mac', fellBack: { id: 'win', name: 'win', why: 'offline' } }, "R4 꺼진 컴퓨터 → 사유 offline");
  deep(resolveNodeChoice(both, 'ghost'),
    { id: 'mac', fellBack: { id: 'ghost', name: 'ghost', why: 'gone' } }, "R5 목록에 없는 컴퓨터 → 사유 gone");
  deep(resolveNodeChoice([macN, winShell], 'win'),
    { id: 'mac', fellBack: { id: 'win', name: 'win', why: 'no-ai' } }, "R6 AI 를 못 띄우는 컴퓨터 → 사유 no-ai");
  deep(resolveNodeChoice([winOff], 'win'),
    { id: '', fellBack: { id: 'win', name: 'win', why: 'offline' } }, "R7 갈 곳이 중앙뿐이어도 사유는 남는다");
  // 두 자리가 갈리면 «칸이 말하는 곳»과 «실제로 열리는 곳»이 어긋난다.
  for (const pref of ['', NODE_CENTRAL, 'win', 'ghost']) {
    eq(resolveNodeDefault(both, pref), resolveNodeChoice(both, pref).id, `R8 id 만 내는 쪽이 같은 답 (pref='${pref}')`);
  }
}

// ── E. 화면이 그 규칙을 실제로 쓰나 — 기억(prefs.node)을 기본으로 되살리지 않는다 ──
//  #3778 뒤 구조: 규칙(defaultNodeId·isAiHarness·nodeCanRunAi)은 run-prefs.ts, 화면(run-picker.ts)은 그걸 부른다.
const PICKER = read("web/v2/run-picker.ts");
const PREFS = read("web/v2/run-prefs.ts");
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const codeOnly = strip(PICKER);
const prefsOnly = strip(PREFS);
ok(/const nodeKey = \(\): string => resolveNodeDefault\(nodes, sessionDefaults\(\)\.nodeDefault\)/.test(codeOnly),
  "E1 노드 값은 매번 «기본값 설정 → 규칙» 으로 다시 정한다(캐시된 직전 값을 되살리지 않는다)");
ok(/id: defaultNodeId\(nodes\)/.test(prefsOnly) && /if \(pref === NODE_CENTRAL\) return \{ id: '', fellBack: null \};/.test(prefsOnly),
  "E2 설정이 비었거나 못 쓰면 규칙(defaultNodeId)으로 떨어진다");
ok(!/prefs\.node\b/.test(codeOnly) && !/\bp\.node\b/.test(prefsOnly) && !/prefs\.node\b/.test(prefsOnly),
  "E3 실행 노드는 기억(prefs.node)을 기본으로 읽지 않는다 — 이 지시의 핵심(nodeDefault 는 사람이 창에서 고른 설정이지 직전 값이 아니다)");
ok(/node:\s*nodeKey\(\)/.test(codeOnly), "E4 생성 바디의 node 는 그 값이다");

// ── W. 배선 — 빈 목록 문구가 둘로 갈리나, 셸 판정이 한 곳인가 ────────────────
//  값(규칙)이 맞아도 화면이 여전히 '지난번 설정 그대로'만 말하면, 왜 못 고르는지는 화면에서 답을 못 얻는다.
ok(/harnesses\.length \? 'AI 를 못 찾았어요' : '지난번 설정 그대로'/.test(codeOnly),
  "W1 고를 것이 없을 때 — 카탈로그를 받았으면 'AI 를 못 찾았어요', 못 받았으면 '지난번 설정 그대로'");
//  #2172 실측 — 그 PC 에 AI 가 깔려 있어도 PATH 를 못 물려받으면 탐지가 빈손이 된다. 화면이 '없다'고
//  단정하면 사람이 설치를 다시 하러 간다. 단정하는 문구가 다시 들어오면 여기서 잡는다.
ok(!/AI 가 없어요/.test(codeOnly), "W1b 없다고 단정하는 문구를 쓰지 않는다");
ok(/provSel\.title = harnesses\.length/.test(codeOnly), "W1c 왜 못 찾았는지 확인할 거리를 title 로 남긴다");
ok(/export const isAiHarness = \(key: string\): boolean => key !== 'shell'/.test(prefsOnly) && !/const isAiHarness\b/.test(codeOnly),
  "W2a 셸 제외 판정이 이름 붙은 한 곳(run-prefs)에 있다 — 화면에 사본이 없다");
ok(/filter\(\(h\) => isAiHarness\(h\.key\)/.test(codeOnly) && /harnesses\.some\(isAiHarness\)/.test(prefsOnly),
  "W2b 목록 거르기(paint)와 노드 판정(nodeCanRunAi)이 같은 규칙을 쓴다");

// ── F. 서버가 규칙의 근거를 실어 보내나 ─────────────────────────────────────
const ROUTES = read("src/terminal/routes.ts");
const REGISTRY = read("src/node/registry.ts");
ok(/mine:\s*n\.owner_member === me/.test(ROUTES), "F1 /terminal/config 가 mine(내 소유)을 준다");
ok(/connectedAt:\s*live\.get\(n\.id\)\?\.connectedAt/.test(ROUTES), "F2 /terminal/config 가 connectedAt(연결 시각)을 준다");
ok(/connectedAt:\s*Date\.now\(\)/.test(REGISTRY), "F3 노드 연결이 수립될 때 그 시각을 기록한다");
ok(/connectedAt:\s*c\.connectedAt/.test(REGISTRY), "F4 liveNodes() 가 그 시각을 노출한다");
ok(/sessions:\s*live\.get\(n\.id\)\?\.sessions/.test(ROUTES), "F5 /terminal/config 가 sessions(지금 도는 세션 수)를 준다");
//  #3833 — 노드 축만 다시 읽는 가벼운 경로. 이게 없으면 화면은 전체 config 를 다시 받거나(비싸다) 굳은 값을 쓴다.
ok(/req\.query\.only/.test(ROUTES) && /runNodesFor/.test(ROUTES), "F6 서버에 노드 축만 다시 주는 경로가 있다");

// ── N. 신선도(#3833) — online 은 «지금» 이라 캐시가 굳으면 화면이 거짓말한다 ──────
//  이 절이 없으면, 노드 목록을 세션 내내 한 번만 받는 종전 구조로 되돌아가도 아무도 못 잡는다.
//  실제로 그렇게 굳어서 «켜져 있는 맥북이 홈에서 계속 꺼짐으로 보이고 [시키기]가 딴 PC 로 갔다».
ok(/export async function refreshNodes/.test(codeOnly), "N1 노드 축만 다시 읽는 문이 있다");
ok(/config\?only=nodes/.test(codeOnly), "N2 그 문은 전체 config 가 아니라 노드 축만 부른다");
ok(/refreshNodes\([\s\S]{0,40}\)[\s\S]{0,300}openSessionDefaults\(/.test(codeOnly),
  "N3 [⚙] 기본값 창은 열기 전에 노드 축을 다시 읽는다 — «지금 꺼짐» 은 지금 사실이어야 한다");
ok(/const resolve = async \(\): Promise<RunPick> => \{[\s\S]{0,120}await refreshNodes\(/.test(codeOnly),
  "N4 [시키기] 직전에도 다시 읽는다");
ok(/toast\(/.test(codeOnly) && /fellBack/.test(codeOnly), "N5 폴백이 났으면 화면이 그 사실을 말한다");
for (const [f, why] of [["web/v2/views.ts", "홈"], ["web/v2/panes-parts.ts", "프로젝트"]]) {
  ok(/await runPicker\??\.resolve\(\)|runPicker \? await runPicker\.resolve\(\)/.test(strip(read(f))),
    `N6 ${why} 컴포저가 value() 가 아니라 resolve() 로 연다 (${f})`);
}

console.log(`\n${pass} assertions passed`);
