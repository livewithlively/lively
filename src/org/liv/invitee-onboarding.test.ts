// 초대로 합류한 사람의 처음 설정 (#3872, 원준 2026-09-12 지시)
//
//  지시: *"초대 합류자용 처음 설정을 따로 만드는게 좋겠어. 그들도 자료를 로컬에서 업로드 할 수 있어야지."*
//
//  실측(2026-09-11 테스트 초대)이 남긴 사실 — 초대로 가입한 사람은 **팀 워크스페이스로 곧장** 들어오고,
//   거기서 주인과 **똑같은 11장면**을 다시 겪었다: 이미 있는 팀인데 「어디에서 일하고 계세요?」를 묻고,
//   어느 팀에 들어왔는지는 어디에도 말해 주지 않았다.
//  그래서 차례표를 둘로 가른다. 이 검사는 **갈렸나** 와 **자료 올리기가 남았나**(원준 지시)를 함께 지킨다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildFirstTurnPrompt, type FirstTurnInput } from "./first-turn.js";

const SRC = readFileSync(
  new URL("../../../web/v2/onboarding.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const code = SRC.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const orderOf = (name: string): string => {
  const m = code.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  assert.ok(m, `${name} 를 못 찾았다 — 검사가 헛돈다`);
  return m![1];
};

test("① 합류자 차례표가 따로 있고, 갈리는 것은 «어느 팀인가»와 «무대»뿐이다", () => {
  const join = orderOf("ORDER_JOIN");
  const solo = orderOf("ORDER");
  assert.ok(join.includes("'team'"), "합류자 차례표에 팀 소개 장면이 없다");
  assert.ok(!join.includes("'stage'"), "이미 있는 팀인데 「어디에서 일하고 계세요?」를 또 묻는다");
  assert.ok(!solo.includes("'team'"), "혼자 여는 사람에게 팀 소개 장면이 뜬다");
  assert.ok(solo.includes("'stage'"), "종전 차례표에서 무대 장면이 사라졌다(무회귀)");
});

test("② 자료 올리기·외부 앱·내 컴퓨터는 합류자에게도 그대로다 (원준 지시)", () => {
  const join = orderOf("ORDER_JOIN");
  for (const k of ["'files'", "'sources'", "'connect'", "'terminal'", "'local'", "'app'", "'ai'", "'claude'", "'role'", "'name'"]) {
    assert.ok(join.includes(k), `합류자 차례표에서 ${k} 가 빠졌다`);
  }
});

test("③ 다음 장면은 차례표가 정한다 — 이름 다음을 하드코딩하지 않는다", () => {
  assert.match(code, /function nextScene\(cur\)/, "차례표 기반 다음 장면 함수가 없다");
  assert.doesNotMatch(code, /goScene\('stage'\)/, "이름 장면이 무대로 하드코딩돼 합류자도 끌려간다");
  const nameBlock = code.slice(code.indexOf("    name: {"), code.indexOf("    stage: {"));
  assert.ok(nameBlock.includes("goScene(nextScene('name'))"), "이름 장면의 출구가 차례표를 안 본다");
  assert.equal((nameBlock.match(/goScene\(nextScene\('name'\)\)/g) || []).length, 2, "이름 장면의 출구는 [이렇게 불러 주세요]와 [그냥 넘어갈게요] 둘이다");
});

test("④ 합류자 판정은 서버가 준 사실만 쓴다 — 화면이 인원을 세지 않는다", () => {
  assert.match(code, /if \(WS && WS\.joining\) JOIN = WS\.joining;/, "서버의 joining 을 안 싣는다");
  assert.match(code, /const isJoin = \(\) => !!\(JOIN && JOIN\.is_join\);/, "판정이 서버 사실에서 파생되지 않는다");
  //  team 장면은 실측 숫자만 쓴다 — 0 이면 그 줄을 아예 쓰지 않는다(없는 것을 있다고 하지 않는다).
  const teamBlock = code.slice(code.indexOf("    team: {"), code.indexOf("    name: {"));
  assert.ok(teamBlock.includes("JOIN.member_count") && teamBlock.includes("JOIN.knowledge_n"), "팀 소개가 서버 숫자를 안 쓴다");
  assert.ok(teamBlock.includes("filter(Boolean)"), "0 인 값을 걸러내지 않아 «구성원 0명» 같은 문구가 나간다");
});

// ── 리브 1턴 — 합류자에게 팀 자료를 «이 사람이 올린 것» 으로 읽어 주지 않는다 ──
const base = (over: Partial<FirstTurnInput> = {}): FirstTurnInput => ({
  displayName: "수아", purpose: null, work: null, drawers: [], firstOrder: null, decisions: [],
  uploads: { total: 3, kinds: [], names: ["a", "b", "c"], forms: [] },
  categories: [{ name: "산출물" }], collectors: [], aiHarnesses: ["claude"], harness: "claude", ...over,
});

test("⑤ 합류자면 1턴이 «팀에 이미 있는 것»과 «내 자료»를 가른다", () => {
  const p = buildFirstTurnPrompt(base({ joining: { is_join: true, member_count: 3, workspace_name: "라이블리", knowledge_n: 442 } }));
  assert.match(p, /이미 굴러가는 팀에 합류/, "합류자라는 사실이 1턴에 안 실린다");
  assert.match(p, /구성원 3명 · 라이블리/);
  assert.match(p, /팀에 이미 쌓인 지식 442건 — \*\*이 사람이 만든 것이 아니다\.\*\*/);
  assert.doesNotMatch(p, /- 올린 자료 3건/, "팀 자료를 이 사람이 «올린 자료» 로 읽어 준다");
  assert.match(p, /이 사람이 볼 수 있는 자료 3건/);
  assert.match(p, /섞어 말하지 마라/, "섞지 말라는 지시가 빠졌다");
});

test("⑥ 혼자 여는 사람의 1턴은 종전 그대로다 (무회귀)", () => {
  const p = buildFirstTurnPrompt(base());
  assert.match(p, /- 올린 자료 3건/);
  assert.doesNotMatch(p, /합류/);
  assert.doesNotMatch(p, /팀에 이미 쌓인 지식/);
});

// ── #3872 후속(2026-09-13) — 개인 워크스페이스가 «구성원 2명 팀» 이 되던 것 ──
//  실측(원준님 개인 워크스페이스 온보딩): 명부 3줄 = 본인 · 플랫폼 운영 계정(admin/ops@lvly.io, 매니지드가 모든 테넌트에 심는다) ·
//   세션 호스트(system). listMembers() 를 사람으로 세면 «구성원 2명 · 이미 있는 팀에 합류» 가 되고, 리브가 첫 문장부터
//   «합류 전에 만들어진 지식 3건은 당신이 쓴 게 아닙니다» 라고 말한다. lively-46e3 에선 미러 행 88개가 더 섞여 91명이었다(9/12).
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
