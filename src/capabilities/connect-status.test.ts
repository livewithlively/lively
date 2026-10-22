// 외부 앱 연결 «다음 걸음» 판정(org/connect-next.ts) + 상태 도구(org_connect_status) — 사양 Q1~Q6 · 엣지 N1~N13(#4970).
//  실행: npm run build && node dist/capabilities/connect-status.test.js
//  ⚠ DB 를 요구하지 않는다 — DB 주소가 없으면 앱 상태 조회가 즉시 실패한다(db/client.ts #2457). 그 상태가 곧 N12(모든 앱 조회 실패)다.
import assert from "node:assert/strict";
import { decideConnectNext, type ConnectFacts } from "../org/connect-next.js";
import { registry } from "./index.js";
import { CONNECT_APPS } from "./connect-status.js";
import { CONNECT_SKILL_SPECS } from "../org/delivery/connect-skills.js";

let pass = 0;
const ok = (name: string) => { pass++; console.log(`ok  ${name}`); };

const T = true, F = false;
const f = (variant: ConnectFacts["variant"], needsApp: boolean, appReady: boolean, canRegister: boolean, canCollect: boolean, meConnected: boolean, collecting: boolean): ConnectFacts =>
  ({ variant, needsApp, appReady, canRegister, canCollect, meConnected, collecting });

// ── N1~N11 판정 표 ──
{
  const rows: Array<[string, ConnectFacts, string]> = [
    ["N1 매니지드·앱 미준비 → 관리자여도 준비 중", f("managed", T, F, T, T, F, F), "preparing"],
    ["N2 매니지드·앱 미준비 → 수집 중이어도 준비 중", f("managed", T, F, F, F, T, T), "preparing"],
    ["N3 셀프호스트·앱 미준비·등록 가능 → 앱 등록", f("selfhost", T, F, T, F, F, F), "register_app"],
    ["N4 셀프호스트·앱 미준비·등록 불가 → 관리자에게", f("selfhost", T, F, F, T, T, F), "ask_admin"],
    ["N5 셀프호스트·앱 미준비 → 수집 중이어도 앱 등록이 먼저", f("selfhost", T, F, T, T, T, T), "register_app"],
    ["N6 토큰 앱은 앱 준비를 보지 않는다 → 연결", f("selfhost", F, F, F, T, F, F), "connect"],
    ["N7 토큰 앱·수집 중 → 모으는 중", f("managed", F, F, F, F, F, T), "collecting"],
    ["N8 수집 중이면 내 연결이 없어도 모으는 중", f("selfhost", T, T, F, F, F, T), "collecting"],
    ["N9 앱 준비·미연결 → 연결", f("selfhost", T, T, F, T, F, F), "connect"],
    ["N10 연결됨·수집 꺼짐·켤 수 있음 → 범위 정하기", f("managed", T, T, F, T, T, F), "set_scope"],
    ["N11 연결됨·수집 꺼짐·켤 수 없음 → 관리자에게", f("selfhost", T, T, T, F, T, F), "ask_admin"],
  ];
  for (const [name, facts, want] of rows) assert.equal(decideConnectNext(facts), want, name);
  ok(`N1~N11 판정 표 ${rows.length}행`);
}

// ── N13 상태 도구의 앱 목록 = 연결 스킬 카탈로그의 앱 스킬 ──
{
  const skillIds = new Set(CONNECT_SKILL_SPECS.map((s) => s.id));
  for (const a of CONNECT_APPS) assert.ok(skillIds.has(`liv-connect-${a.app}`), `상태 도구의 앱 '${a.app}' 에 맞는 스킬 liv-connect-${a.app} 이 카탈로그에 없다`);
  const appSkills = CONNECT_SKILL_SPECS.filter((s) => /^liv-connect-/.test(s.id) && s.id !== "liv-connect-claude").map((s) => s.id.slice("liv-connect-".length));
  assert.deepEqual(CONNECT_APPS.map((a) => a.app).sort(), appSkills.sort(), "앱 스킬과 상태 도구의 앱 목록이 같아야 한다(한쪽만 늘리면 입구가 넘길 곳을 잃는다)");
  ok(`N13 상태 도구 앱 ${CONNECT_APPS.length}개 ↔ 연결 스킬 카탈로그 일치`);
}

// ── N12 / Q6 앱 조회가 전부 실패해도 도구는 성공하고 앱마다 error 를 단다 ──
{
  const cap = registry.get("org_connect_status");
  assert.ok(cap, "registry 에 org_connect_status 가 없다(배선 확인)");
  assert.equal(cap!.expose.mcp, true, "MCP 로 열려 있어야 스킬이 부른다");
  const user = { userId: "__connect_status_test__", email: "t@example.invalid", scopes: ["memory"], projects: ["*"], tokenSource: "db" } as never;
  const r = await cap!.handler({}, user) as { variant: string; can_collect: boolean; apps: Array<{ app: string; skill: string; next: unknown; error?: string; can_register: boolean }> };
  assert.equal(r.apps.length, CONNECT_APPS.length, "앱 하나의 실패가 목록을 줄이면 안 된다");
  assert.equal(r.variant, "selfhost", "테넌트 헤더 비밀이 없는 테스트 환경 = selfhost");
  assert.equal(r.can_collect, true, "memory scope = 워크스페이스 관리(수집 켜기) 가능");
  for (const a of r.apps) {
    assert.equal(a.skill, `liv-connect-${a.app}`);
    assert.ok(a.error && a.error.length > 0, `DB 없는 환경에서 '${a.app}' 는 error 가 있어야 한다(배선이 진짜 조회를 탔는지)`);
    assert.equal(a.next, null, `조회 실패한 '${a.app}' 는 다음 걸음을 지어내지 않는다`);
  }
  // 등록 권한: admin 이 아닌 memory 사용자는 admin 등록 앱(슬랙·노션·리니어·구글·아웃룩)은 못 하고, 워크스페이스 관리 앱(깃허브 등)은 한다.
  const byApp = new Map(r.apps.map((a) => [a.app, a]));
  assert.equal(byApp.get("slack")!.can_register, false);
  assert.equal(byApp.get("github")!.can_register, true);
  await assert.rejects(cap!.handler({}, undefined as never), (e: unknown) => (e as { status?: number }).status === 401, "신원 없는 호출은 401");
  ok("N12 모든 앱 조회 실패 — 도구는 성공, 앱마다 error·next=null · 권한별 can_register · 신원 없으면 401");
}

console.log(`\n${pass} passed`);
