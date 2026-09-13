// 초대로 합류한 사람의 처음 설정 (#3872 → #1631 결정 2026-09-13)
//
//  #3872(2026-09-12) 지시: *"초대 합류자용 처음 설정을 따로 만드는게 좋겠어. 그들도 자료를 로컬에서 업로드 할 수 있어야지."*
//  #1631(2026-09-13) 결정 — 합류자 차례표를 다시 짠다(knowledge signup-onboarding-two-paths-review-1631 §9·§11):
//   · 판정은 «초대로 들어왔나»(서버 사실). 워크스페이스 용도는 먼저 정한 사람 것을 물려받는다 — 아무도 안 정했으면 그때만 묻는다.
//   · 팀의 외부 앱 연결은 **보여 주되 수정은 못 하게**(연결·해제·수집 계정 변경 불가) — connect 장면은 합류자에게 없다.
//   · 올린 로컬 파일은 팀원 모두가 보는 팀 자료로.
//   · 합류자에게 리브를 띄우지 않는다.
//   · «터미널 → 내 컴퓨터 연결 / 앱 받기» 는 초대 전부터 계정이 있던 사람에게만.
//  ⚠ 종전 가드 ②(«외부 앱·내 컴퓨터는 합류자에게도 그대로다»)는 이 결정으로 **뒤집혔다** — 대표 결정이 옛 가드를 이긴다.
//
//  엣지 표(합류 · 용도 · 켜진 팀 수집 · 초대 전 계정) → 차례표:
//   F1 주인(합류 아님)                       → ORDER 그대로
//   F2 합류 · 용도 있음 · 수집 2 · 기존 계정  → intro team name role files ai claude sources terminal local app
//   F3 합류 · 용도 없음 · 수집 2 · 기존 계정  → … name stage role … (stage 는 name 바로 다음)
//   F4 합류 · 용도 있음 · 수집 0 · 처음 계정  → … claude 로 끝난다(sources·설치 장면 없음)
//   F5 합류 · 용도 있음 · 수집 1 · 처음 계정  → … claude sources 로 끝난다
//   F6 어느 합류 갈래에도 connect 가 없다
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildFirstTurnPrompt, type FirstTurnInput } from "./first-turn.js";

const SRC = readFileSync(
  new URL("../../../web/v2/onboarding.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const code = SRC.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const grab = (re: RegExp, what: string): string => {
  const m = code.match(re);
  assert.ok(m, `${what} 를 소스에서 못 찾았다 — 검사가 헛돈다`);
  return m![1];
};
const list = (name: string): string[] =>
  JSON.parse(grab(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`), name).replace(/'/g, '"')) as string[];
/** head 에서 시작하는 블록을 괄호 짝으로 잘라 온다. */
function blockFrom(src: string, head: string): string {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} 를 못 찾았다 — 검사가 헛돈다`);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  assert.fail(`${head} 의 닫는 괄호를 못 찾았다`);
}
type Fn = (...args: unknown[]) => unknown;
const compile = (params: string[], body: string): Fn => new Function(...params, body) as unknown as Fn;

/** 소스의 flowFor 를 그대로 돌린다 — 글자가 아니라 계산 결과로 단언한다. */
type Facts = { join: boolean; askStage: boolean; teamSources: number; existingAccount: boolean };
const flowOf = (f: Facts): string[] => compile(["ORDER", "ORDER_JOIN", "JOIN_INSTALL", "f"],
  `${blockFrom(code, "function flowFor(f) {")}\nreturn flowFor(f);`)(list("ORDER"), list("ORDER_JOIN"), list("JOIN_INSTALL"), f) as string[];

test("F1 주인의 차례표는 종전 그대로다 (무회귀)", () => {
  const solo = list("ORDER");
  assert.deepEqual(flowOf({ join: false, askStage: true, teamSources: 3, existingAccount: true }), solo);
  assert.ok(solo.includes("stage") && solo.includes("connect") && !solo.includes("team"), "주인 차례표가 바뀌었다");
});

test("F2·F3 ★합류자 — 용도는 물려받고, 아무도 안 정했을 때만 name 바로 다음에 묻는다", () => {
  const base = { join: true, teamSources: 2, existingAccount: true };
  assert.deepEqual(flowOf({ ...base, askStage: false }),
    ["intro", "team", "name", "role", "files", "ai", "claude", "sources", "terminal", "local", "app"]);
  assert.deepEqual(flowOf({ ...base, askStage: true }),
    ["intro", "team", "name", "stage", "role", "files", "ai", "claude", "sources", "terminal", "local", "app"]);
});

test("F4·F5 ★합류자 — 설치 장면은 초대 전부터 계정이 있던 사람에게만, sources 는 켜진 팀 수집이 있을 때만", () => {
  assert.deepEqual(flowOf({ join: true, askStage: false, teamSources: 0, existingAccount: false }),
    ["intro", "team", "name", "role", "files", "ai", "claude"]);
  assert.deepEqual(flowOf({ join: true, askStage: false, teamSources: 1, existingAccount: false }),
    ["intro", "team", "name", "role", "files", "ai", "claude", "sources"]);
});

test("F6 어느 합류 갈래에도 connect(외부 앱 연결)가 없다", () => {
  for (const askStage of [true, false]) for (const teamSources of [0, 1]) for (const existingAccount of [true, false]) {
    const f = flowOf({ join: true, askStage, teamSources, existingAccount });
    assert.ok(!f.includes("connect"), `합류자 차례표에 connect 가 있다: ${f.join(",")}`);
    assert.equal(f[0], "intro"); assert.equal(f[1], "team");
  }
});

test("F7 차례표는 서버 사실에서만 만든다 — existing_account 는 true 일 때만, 용도는 서버가 준 값", () => {
  assert.match(code, /if \(WS && WS\.joining\) JOIN = WS\.joining;/, "서버의 joining 을 안 싣는다");
  assert.match(code, /const isJoin = \(\) => !!\(JOIN && JOIN\.is_join\);/, "판정이 서버 사실에서 파생되지 않는다");
  assert.match(code, /const showInstall = \(\) => !!\(JOIN && JOIN\.existing_account === true\);/, "설치 장면을 null·false 에도 보여 준다");
  assert.match(code, /const askStage = \(\) => !\(WS && WS\.workspace_purpose\);/, "용도가 정해졌는지를 서버 값으로 안 본다");
  assert.match(code, /const FLOW = \(\) => flowFor\(\{ join: isJoin\(\), askStage: askStage\(\), teamSources: teamCollectOn\(\)\.length, existingAccount: showInstall\(\) \}\);/,
    "화면이 쓰는 차례표가 flowFor 를 안 거친다");
  //  물려받기 — 합류자만, 지금 이 화면에서 고른 값은 덮지 않는다.
  assert.match(code, /if \(isJoin\(\) && WS && WS\.workspace_purpose && !S\.stage\) \{ S\.stage = String\(WS\.workspace_purpose\); save\(\); \}/,
    "먼저 정한 사람의 용도를 물려받지 않는다");
  //  진행 눈금은 실제 차례표를 따른다.
  assert.match(code, /const QPROG = \(\) => QPROG_ALL\.filter\(\(k\) => FLOW\(\)\.includes\(k\)\);/, "진행 눈금이 실제 차례표와 어긋난다");
  for (const k of new Set([...list("ORDER"), ...list("ORDER_JOIN"), ...list("JOIN_INSTALL")])) {
    if (["intro", "team", "name"].includes(k)) continue;
    assert.ok(list("QPROG_ALL").includes(k), `진행 눈금 표에 ${k} 가 없다`);
  }
});

test("F8 이름 다음·AI 다음은 차례표가 정한다 — 차례표의 끝이면 마무리로 간다", () => {
  assert.match(code, /function nextScene\(cur\)/, "차례표 기반 다음 장면 함수가 없다");
  assert.doesNotMatch(code, /goScene\('stage'\)/, "이름 장면이 무대로 하드코딩돼 합류자도 끌려간다");
  const nameBlock = code.slice(code.indexOf("    name: {"), code.indexOf("    stage: {"));
  assert.equal((nameBlock.match(/goScene\(nextScene\('name'\)\)/g) || []).length, 2, "이름 장면의 출구는 [이렇게 불러 주세요]와 [그냥 넘어갈게요] 둘이다");
  //  AI 두 장면의 출구 — sources 로 박지 않는다(합류자는 sources 가 없을 수 있다).
  const aiBlock = code.slice(code.indexOf("    ai: {"), code.indexOf("    terminal: {"));
  assert.doesNotMatch(aiBlock, /goScene\('sources'\)/, "AI 장면이 sources 로 하드코딩돼 있다 — 켜진 팀 수집이 없는 합류자도 끌려간다");
  //  goNext — 차례표에 남은 장면이 없으면 마무리. 가짜 차례표로 행위를 잰다.
  const goNext = compile(["SEQ_ALL", "FLOW", "goScene", "finishOnboarding", "cur"], `${blockFrom(code, "function goNext(cur, opts) {")}\ngoNext(cur);`);
  const SEQ = list("SEQ_ALL");
  const run = (flow: string[], cur: string) => { const hit = { to: "", fin: false }; goNext(SEQ, () => flow, (k: string) => { hit.to = k; }, () => { hit.fin = true; }, cur); return hit; };
  assert.deepEqual(run(["intro", "team", "name", "role", "files", "ai", "claude"], "claude"), { to: "", fin: true }, "차례표 끝(claude)에서 마무리로 안 간다");
  assert.deepEqual(run(["intro", "team", "name", "role", "files", "ai", "claude", "terminal", "local", "app"], "claude"), { to: "terminal", fin: false }, "건너뛴 sources 뒤를 못 찾는다");
  assert.deepEqual(run(list("ORDER"), "claude"), { to: "sources", fin: false }, "주인의 AI 다음이 sources 가 아니다(무회귀)");
});

// ── 팀 연결은 보여 주되 고치지 못한다 ────────────────────────────────────────────
test("R1 ★합류자 sources — 켜진 팀 수집의 이름만 그리고, 고르기·연결·해제 문이 없다", () => {
  const html = blockFrom(code, "function joinSourcesHtml() {");
  const bind = blockFrom(code, "function bindJoinSources(el) {");
  for (const bad of ["wireUnlink", "svcDisconnect", "startMemberCollect", "startCollect", "enableCollect", "doneCardHtml", "data-unlink", "data-conn", "/collect", "card(", "loadConn"]) {
    assert.ok(!html.includes(bad) && !bind.includes(bad), `합류자 sources 에 수정 경로(${bad})가 닿는다`);
  }
  assert.match(html, /이 팀은 이곳의 자료를 모으고 있어요\./);
  //  장면 입구가 합류자를 먼저 가른다 — 주인 갈래(해제·켜기 배선)보다 앞에서 return 한다.
  const scene = code.slice(code.indexOf("    sources: {"), code.indexOf("    connect: {"));
  assert.match(scene, /html: \(\) => \{\s*if \(isJoin\(\)\) return joinSourcesHtml\(\);/, "sources 그리기가 합류자를 먼저 가르지 않는다");
  assert.match(scene, /bind: \(el\) => \{\s*if \(isJoin\(\)\) \{ bindJoinSources\(el\); return; \}/, "sources 배선이 합류자를 먼저 가르지 않는다 — 해제 버튼 배선이 붙는다");
});

test("R2 합류자에게는 해제·켜기 함수 자체가 문을 닫는다(오래된 탭·주소 점프 대비)", () => {
  assert.match(blockFrom(code, "async function svcDisconnect(id) {"), /^async function svcDisconnect\(id\) \{\s*if \(isJoin\(\)\) throw /, "svcDisconnect 가 합류자를 막지 않는다");
  assert.match(blockFrom(code, "async function startMemberCollect(id, scopeText) {"), /^async function startMemberCollect\(id, scopeText\) \{\s*if \(isJoin\(\)\) return \{ ok: false/, "startMemberCollect 가 합류자를 막지 않는다");
  const connect = code.slice(code.indexOf("    connect: {"), code.indexOf("    ai: {"));
  assert.match(connect, /bind: \(el\) => \{\s*if \(isJoin\(\)\) \{ goNext\('connect', \{ back: true \}\); return; \}/, "connect 장면이 합류자를 내보내지 않는다(또는 자취를 남겨 뒤로가기가 여기서 튕긴다)");
});

test("R3 켜진 팀 수집 판정 — 못 읽은 것은 켜진 것으로 치지 않는다 · 슬랙은 search 축", () => {
  const fn = compile(["COLLECT_FIRST", "COLL", "DATA", "BRAND"], `${blockFrom(code, "function teamCollectOn() {")}\nreturn teamCollectOn();`);
  const DATA = { SOURCE_ROWS: [{ items: [{ id: "slack", label: "Slack", logo: "slack" }, { id: "notion", label: "Notion", logo: "notion" }, { id: "github", label: "GitHub", logo: "github" }] }] };
  const FIRST = { slack: "slack", notion: "notion", figma: "figma", github: "github" };
  const on = fn(FIRST, { slack: { search: { enabled: true }, enabled: false }, notion: { enabled: false }, figma: null, github: { enabled: true } }, DATA, {}) as Array<{ id: string; label: string }>;
  assert.deepEqual(on.map((x) => x.label), ["Slack", "GitHub"]);
  assert.deepEqual(fn(FIRST, {}, DATA, {}), [], "수집 상태를 못 읽었는데 켜진 것이 있다고 한다");
});

// ── 올린 자료는 팀원 모두 · 마무리 · 문구 ──────────────────────────────────────
test("C1 합류자 파일 — «팀원 모두가 봅니다» 이고, 업로드가 그 옵션을 싣는다(주인은 그대로)", () => {
  const files = code.slice(code.indexOf("    files: {"), code.indexOf("    sources: {"));
  assert.match(files, /올린 자료는 팀원 모두가 봅니다\./, "합류자에게 공개 범위를 안 알린다");
  assert.doesNotMatch(files, /기본적으로 나만 봅니다/, "옛 «나만 봅니다» 문구가 남았다");
  assert.match(files, /root=personal&path=' \+ encodeURIComponent\(rel\) \+ \(isJoin\(\) \? '&share=team' : ''\)/, "합류자 업로드가 팀 옵션을 안 싣는다(또는 주인에게도 싣는다)");
});

test("C2 마무리 — 합류자면 리브 없이 홈으로, 판정은 서버 응답을 따른다", () => {
  const fin = blockFrom(code, "async function finishOnboarding() {");
  assert.match(fin, /const joined = applied && applied\.joining \? !!applied\.joining\.is_join : isJoin\(\);/, "마무리가 서버 판정을 안 본다");
  const joinBranch = blockFrom(fin, "if (joined) {");
  assert.match(joinBranch, /준비됐어요\. 팀 워크스페이스로 모시겠습니다\./);
  assert.match(joinBranch, /location\.hash = '#\/';/, "합류자를 홈으로 안 보낸다");
  assert.doesNotMatch(joinBranch, /리브|livHref/, "합류자 마무리에 리브 이야기가 남았다");
});

test("C3 주인 — AI 를 안 이었을 때 없는 자리를 가리키거나 못 지킬 약속을 하지 않는다", () => {
  assert.doesNotMatch(code, /\[외부 앱 연결\]에서 AI 를 이으면/, "AI 로그인이 없는 화면을 가리킨다");
  assert.doesNotMatch(code, /리브가 이어서 정리해 드립니다/, "리브는 처음 설정이 끝나는 순간에만 열린다 — 지킬 수 없는 약속이다");
  assert.match(code, /\[AI 계정 연결\]/, "AI 로그인이 실제로 있는 자리(내 프로필 · 환경설정 ▸ AI 계정 연결)를 안 가리킨다");
});

test("C4 «하는 일» 질문은 주인·합류자 모두 이 워크스페이스 기준이고, 안 물은 용도를 되뇌지 않는다", () => {
  const role = code.slice(code.indexOf("    role: {"), code.indexOf("    files: {"));
  assert.match(role, /'이 워크스페이스에서 어떤 일을 하시나요\?'/, "질문이 워크스페이스 기준이 아니다");
  assert.match(role, /FLOW\(\)\.includes\('stage'\) && S\.stage \? \(stageOf\(\)\.ack \|\| stageOf\(\)\.label\)/, "물려받은 용도를 «…자리군요» 로 되뇐다");
});

// ── 리브 1턴 — 주인만 받는다 ─────────────────────────────────────────────────
const base = (over: Partial<FirstTurnInput> = {}): FirstTurnInput => ({
  displayName: "수아", purpose: null, work: null, drawers: [], firstOrder: null, decisions: [],
  uploads: { total: 3, kinds: [], names: ["a", "b", "c"], forms: [] },
  categories: [{ name: "산출물" }], collectors: [], aiHarnesses: ["claude"], harness: "claude", ...over,
});

test("⑥ 혼자 여는 사람의 1턴은 종전 그대로다 (무회귀)", () => {
  const p = buildFirstTurnPrompt(base());
  assert.match(p, /- 올린 자료 3건/);
  assert.doesNotMatch(p, /합류/);
  assert.doesNotMatch(p, /팀에 이미 쌓인 지식/);
});

// ── #3872 후속(2026-09-13) — 개인 워크스페이스가 «구성원 2명 팀» 이 되던 것 ──
//  실측(원준님 개인 워크스페이스 온보딩): 명부 3줄 = 본인 · 플랫폼 운영 계정(admin/ops@lvly.io, 매니지드가 모든 테넌트에 심는다) ·
//   세션 호스트(system). listMembers() 를 사람으로 세면 «구성원 2명 · 이미 있는 팀에 합류» 가 된다.
//   이 수는 이제 **판정의 폴백**(계정 서버를 못 물었을 때)과 팀 소개의 숫자로만 쓰인다.
const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");

test("⑦ 구성원 수는 «자기 계정으로 들어오는 사람» 으로 센다 — 운영 계정·미러 행·system 행을 세지 않는다", () => {
  const src = read("../../capabilities/delivery/welcome.ts");
  assert.match(src, /countWorkspacePeople\(\{ managed: managedMode\(\) \}\)/, "«자기 계정으로 들어오는 사람» 수를 안 쓴다");
  assert.doesNotMatch(src, /listMembers\(\)/, "welcome 이 다시 전체 명부를 센다(운영 계정·미러 행이 섞인다)");
  const store = read("../store/members.ts");
  const fn = store.slice(store.indexOf("export async function countWorkspacePeople"), store.indexOf("export async function getMember"));
  assert.ok(fn.length > 0, "countWorkspacePeople 이 members.ts 에 없다");
  assert.match(fn, /m\.kind='human' AND m\.state='active'/, "system·agent 행이나 비활성 행이 섞인다");
  assert.match(fn, /'lvly_account'/, "매니지드 계정 신원(CP 프로비저닝)을 안 본다");
  assert.match(fn, /'oidc'/, "SSO 신원을 안 본다");
  assert.match(fn, /\$1::boolean = false AND EXISTS \(SELECT 1 FROM member_credential/,
    "로컬 로그인 자격은 셀프호스트에서만 세야 한다 — 매니지드 운영 계정(admin)이 바로 그 자격으로 들어온다");
});

test("⑧ «팀에 이미 쌓인 지식» 은 설치가 심은 시드(사용 설명서 3건)를 빼고 센다", () => {
  const src = read("../../capabilities/delivery/welcome.ts");
  assert.match(src, /countKnowledge\(\{ excludeSeed: true \}, userId\)/, "시드 지식이 «팀이 쌓은 지식» 으로 세어진다");
  const store = read("../../v6/knowledge-store.ts");
  assert.match(store, /if \(f\.excludeSeed\) wh\.push\(`COALESCE\(k\.updated_by,''\) <> 'system'`\)/, "excludeSeed 필터가 store 에 없다");
});

test("C5 팀 소개 — 사람 수를 «쌓였다» 고 하지 않고, 0 인 숫자는 말하지 않고, 장면 수를 줄여 약속하지 않는다 (격리 리뷰 2026-09-13)", () => {
  const team = blockFrom(code, "team: {\n      html");
  assert.doesNotMatch(team, /\$\{bits\}이 이미 쌓여 있어요/,
    "구성원 수와 지식 수를 한 문장에 «쌓여 있어요» 로 붙인다 — 지식이 0이면 «구성원 3명이 이미 쌓여 있어요» 가 된다");
  assert.match(team, /cnt \?/, "구성원 수가 0 일 때 그 문장을 빼는 갈래가 없다");
  assert.match(team, /kn \?/, "지식 수가 0 일 때 그 문장을 빼는 갈래가 없다");
  assert.doesNotMatch(team, /두어 가지만/, "합류자 차례표는 대여섯 장면인데 «두어 가지만» 이라고 약속한다");
});
