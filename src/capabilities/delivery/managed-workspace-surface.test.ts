// #2188 — 매니지드에서 **워크스페이스를 여기서** 만들고 고르고 부른다. 2026-08-27 장원준 신고 셋:
//   ① 가입 때 정한 이름이 워크스페이스에 안 붙는다 — "내 워크스페이스" 로 굳는다
//   ② 「새 워크스페이스」가 app.lvly.io 링크 + 새 탭 — *"????? 이건 왜..? 앱에서처럼 해줘"*
//   ③ app.lvly.io 에서 만들고 활성화까지 끝난 워크스페이스가 게이트웨이 스위처에 **안 나타난다**
//
// ③ 이 이 파일의 출발점이다. 원인은 한 줄이었다 — 목록 핸들러가 매니지드면 `workspaces: []` 를
//  **무조건** 돌려줬다. 권위가 CP 에 있는 것과 "묻지 않는 것"은 다른 말인데 그게 같아져 있었다.
//
// 여기서 잠그는 명제는 "빠지면 조용히 기능이 사라지는" 종류다. 매니지드 경로는 CP 가 있어야 도는
//  통합 경로라 유닛으로 끝까지 못 몬다 — 그래서 **분기와 신뢰 재료의 구조**를 소스에서 못박는다
//  (레포 선례: org/tenancy/session-workspace-isolation.test.ts E6~E8, boot/housekeeping-tenancy.test.ts).
//
// ── 엣지 표(무엇이 빠지면 무엇이 조용히 깨지나) ─────────────────────────────
//   E1 목록이 매니지드에서 CP 에 **묻는다**          → 안 물으면 신고 ③ 이 그대로 재발
//   E2 만들기가 매니지드에서 CP 로 **간다**          → 안 가면 신고 ② (밖으로 내보내는 화면)
//   E3 명부·초대도 같은 통로                          → 안 되면 "사람 초대도 여기서" 가 반쪽
//   E4 화면이 '여기서 된다'를 알 수 있다(whoami)     → 모르면 UI 가 통째로 안 열린다
//   E5 registry 를 **켜지 않는다**                    → 켜면 CP 캡이 우회된다(설계 위반)
//   E6 계정 id 는 **서버가 자기 신원에서** 뽑는다     → 받으면 남의 계정으로 만들고 부르는 통로
//   E7 CP 가 안 잡히면 **끊는다**(빈 목록 금지)       → 빈 목록이면 "워크스페이스가 사라졌다"로 읽힌다
//   E8 온보딩 이름이 CP 로 간다(부수효과)             → 안 가면 신고 ①
//   E9 전환은 매니지드에서 **이동**이다               → 헤더로 바꾸면 그 워크스페이스가 거기 없다
import { strict as assert } from "node:assert";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function repoRoot(): string {
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(d, "package.json"))) return d;
    d = path.dirname(d);
  }
  throw new Error("레포 뿌리를 찾지 못했다");
}
const ROOT = repoRoot();
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
const REG = read("src/capabilities/delivery/workspace-registry.ts");
const CP = read("src/capabilities/delivery/managed-cp.ts");
const WHOAMI = read("src/capabilities/whoami.ts");
const WELCOME = read("src/capabilities/delivery/welcome.ts");
const SWITCHER = read("web/v2/switcher.ts");
const RAIL = read("web/v2/rail.ts");

/** capability 하나의 핸들러 본문만 떼어 낸다(다음 capability 시작 전까지). */
function capBody(name: string): string {
  const at = REG.indexOf(`"${name}"`);
  assert.ok(at > 0, `capability 를 찾지 못했다: ${name}`);
  const next = REG.slice(at + 10).search(/\n  rest(Read|Work|Only)\(/);
  return next > 0 ? REG.slice(at, at + 10 + next) : REG.slice(at);
}

test("★ E1 워크스페이스 목록이 매니지드에서 CP 에 묻는다 (신고 ③)", () => {
  const body = capBody("workspace_registry_status");
  //  ⚠ "문자열이 있다" 로는 부족하다 — `if (managed)` 를 `if (false)` 로 바꿔도 통과했다(돌연변이로 실측).
  //   **그 분기의 조건이 매니지드 판정 자체**여야 하므로 가드와 호출을 한 덩어리로 본다.
  assert.match(body, /const managed = managedMode\(\);/, "매니지드 판정을 안 뜬다");
  assert.match(body, /if \(managed\) \{[\s\S]{0,1200}"\/api\/tenant\/workspaces"/,
    "★ 매니지드일 때 CP 목록을 부르지 않는다 — app.lvly.io 에서 만든 워크스페이스가 영영 안 보인다");
  // 종전의 "무조건 빈 배열"이 매니지드 경로에 다시 생기지 않게: 매니지드 분기가 mode!=='registry' 분기보다 앞이어야 한다.
  assert.ok(body.indexOf("managedMode()") < body.indexOf('mode !== "registry"'),
    "매니지드 분기가 '빈 배열' 분기보다 뒤에 있다 — 그러면 영영 빈 목록이다");
});

test("★ E2/E3 만들기·명부·초대가 매니지드에서 CP 로 간다 (신고 ②)", () => {
  const cases: Array<[string, string]> = [
    ["workspace_create", "/api/tenant/workspace-create"],
    ["workspace_people", "/api/tenant/workspace-people"],
    ["workspace_invite", "/api/tenant/workspace-invite"],
  ];
  for (const [cap, route] of cases) {
    const body = capBody(cap);
    assert.match(body, /managedMode\(\)/, `${cap} 에 매니지드 분기가 없다`);
    assert.ok(body.includes(route), `${cap} 이 CP 창구(${route})를 부르지 않는다`);
    // 매니지드 분기가 requireRegistry() 보다 **앞**이어야 한다 — 뒤면 그 자리에서 400 으로 끊긴다.
    const m = body.indexOf("managedMode()"), r = body.indexOf("requireRegistry()");
    assert.ok(r === -1 || m < r, `${cap} 의 매니지드 분기가 requireRegistry 보다 뒤다 — 매니지드에서 그냥 거절된다`);
  }
});

test("★ E4 화면이 '여기서 된다'를 알 수 있다 — whoami 가 managed 를 싣는다", () => {
  //  ⚠ 반환 경로가 **둘**이다(registry 꺼짐 / 켜짐). 한쪽만 보면 다른 쪽이 빠져도 통과한다(돌연변이로 실측).
  assert.match(WHOAMI, /return \{ active, managed, current: currentTenant\(\)\?\.slug \?\? "primary" \}/,
    "whoami 의 **registry 꺼진 경로**가 managed 를 안 준다 — 매니지드는 늘 이 경로다(UI 가 통째로 닫힌다)");
  assert.match(WHOAMI, /return \{ active, managed, current: slug/,
    "whoami 의 registry 켜진 경로가 managed 를 안 준다 — 두 경로가 서로 다른 모양을 준다");
  assert.match(SWITCHER, /export function registryActive\(\)[\s\S]{0,320}reg\.active[\s\S]{0,40}reg\.managed/,
    "registryActive 가 managed 를 안 본다 — 매니지드에서 UI 가 통째로 닫힌다");
});

test("★★ E5 매니지드에서 **로컬 registry 를 켜지 않는다**(CP 캡 우회 금지)", () => {
  // 이 축을 켜면 테넌트 안에서 워크스페이스가 무한히 생겨 CP 의 계정당 상한이 무의미해진다.
  //  (org/tenancy/activate.ts 의 LIVELY_WORKSPACE_REGISTRY=off opt-out 머리말이 그 결정이다.)
  assert.match(WHOAMI, /const active = registryModeActive\(\);/,
    "whoami 의 active 가 registryModeActive 말고 다른 것에서 나온다 — 매니지드가 registry 로 둔갑할 수 있다");
  assert.doesNotMatch(WHOAMI, /active:\s*true/, "active 를 상수로 켜 뒀다");
  const create = capBody("workspace_create");
  assert.ok(create.indexOf("callCp") < create.indexOf("insertWorkspace"),
    "매니지드가 로컬 등록부(insertWorkspace)로 흘러갈 수 있다 — 워크스페이스 축의 권위가 둘이 된다");
});

test("★★ E6 계정 id 는 서버가 **자기 신원에서** 뽑는다 — 입력으로 받지 않는다", () => {
  assert.match(CP, /identities[\s\S]{0,120}lvly_account/,
    "CP 계정 id 를 org_member.identities 에서 뽑지 않는다");
  assert.match(CP, /body: JSON\.stringify\(\{ \.\.\.body, account_id: t\.accountId \}\)/,
    "account_id 를 호출부가 넣을 수 있다 — 언젠가 남의 것이 실린다");
  // 화면이 보낸 값이 그대로 CP 로 가면 안 된다.
  assert.doesNotMatch(REG, /account_id:\s*input\./, "화면 입력의 account_id 를 그대로 CP 로 넘긴다");
});

test("★ E7 CP 가 안 잡히면 끊는다 — 빈 목록으로 떨어뜨리지 않는다", () => {
  assert.match(CP, /catch \{[\s\S]{0,160}HttpError\(502/,
    "CP 연결 실패를 502 로 끊지 않는다 — 사람은 '워크스페이스가 사라졌다'고 읽는다");
  assert.match(CP, /AbortSignal\.timeout\(/, "타임아웃이 없다 — 계정 서버가 늘어지면 화면이 통째로 멈춘다");
});

test("★ E8 처음 설정의 이름이 CP 로 간다 — 부수효과로(온보딩을 막지 않는다) (신고 ①)", () => {
  assert.match(WELCOME, /callCpBestEffort[\s\S]{0,200}"\/api\/tenant\/account-name"/,
    "★ 온보딩 이름을 계정 서버에 안 알린다 — 워크스페이스가 '내 워크스페이스' 로 굳는다");
  assert.match(CP, /export async function callCpBestEffort[\s\S]{0,320}catch/,
    "부수호출이 실패를 삼키지 않는다 — 계정 서버가 죽으면 온보딩이 막힌다");
});

test("★ E9 매니지드의 전환은 **이동**이다(워크스페이스마다 주소가 다르다)", () => {
  assert.match(SWITCHER, /export function switchWorkspace\(slug: string, enterUrl\?[\s\S]{0,220}location\.assign\(enterUrl\)/,
    "enter_url 로 이동하지 않는다 — 헤더만 바꾸면 그 워크스페이스가 이 게이트웨이에 없다");
  assert.match(RAIL, /switchWorkspace\(w\.slug, \(w as any\)\.enter_url\)/,
    "목록 행이 enter_url 을 안 넘긴다");
});

test("E10 '밖에서 만드세요' 안내가 화면에서 사라졌다", () => {
  //  ⚠ **주석은 빼고 본다.** 왜 뒤집었는지는 주석에 남아 있어야 하고(그게 다음 사람이 되돌리지 않게 하는 장치다),
  //   그 문장까지 금지하면 "이유를 지워야 통과하는" 테스트가 된다.
  const code = RAIL.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.doesNotMatch(code, /app\.lvly\.io 에서 만들기/,
    "아직 사람을 밖으로 내보내는 링크가 남아 있다(신고 ②의 그 화면)");
  assert.doesNotMatch(code, /새 워크스페이스도 거기서 만듭니다/,
    "아직 '거기서 만듭니다' 문구가 남아 있다");
  assert.doesNotMatch(code, /target: '_blank'[\s\S]{0,80}icon\('web'\)/,
    "'새 탭으로 열립니다' 행이 남아 있다");
});

test("★★ E12 매니지드에서도 ✕ 가 돈다 — 삭제·나가기가 CP 창구로 간다 (#1875 D5\u2033)", () => {
  //  이 축이 빠지면 게이트웨이의 ✕ 는 매니지드에서 requireRegistry() 에 걸려 400 만 낸다 —
  //   «있는데 안 되는 버튼» 이 되고, 그건 신고 ②(밖으로 내보내는 화면)와 같은 종류의 실패다.
  for (const [cap, route] of [
    ["workspace_delete", "/api/tenant/workspace-delete"],
    ["workspace_leave", "/api/tenant/workspace-leave"],
  ] as Array<[string, string]>) {
    const body = capBody(cap);
    assert.match(body, /if \(managedMode\(\)\) \{[\s\S]{0,900}"\/api\/tenant\/workspace-(delete|leave)"/,
      `${cap} 이 매니지드에서 CP 창구를 부르지 않는다 — ✕ 가 매니지드에서 죽는다`);
    assert.ok(body.includes(route), `${cap} 이 ${route} 를 부르지 않는다`);
    const m = body.indexOf("managedMode()"), r = body.indexOf("requireRegistry()");
    assert.ok(r === -1 || m < r, `${cap} 의 매니지드 분기가 requireRegistry 보다 뒤다 — 그 자리에서 400 이다`);
  }
  //  ★ 갈래 재료(어드민 수)가 매니지드 목록에도 실려야 한다. 없으면 owner 는 늘 «유일 어드민» 으로
  //   보여서, 공동 어드민이 있어도 이양을 강요당한다(서버는 안 시키는데 화면만 시킨다).
  assert.match(REG, /member_count: w\.member_count, owner_count: w\.owner_count/,
    "★ cpWsView 가 owner_count 를 안 싣는다 — 매니지드에서 공동 어드민도 이양을 강요당한다");
  //  ★ «나» 를 가리키는 키가 배포마다 다르다(코어 member_id vs CP 이메일) — is_me 를 흘려야
  //   «넘길 사람» 후보에서 내가 빠진다.
  assert.match(REG, /is_creator: m\.role === "owner", is_me: m\.is_me/,
    "★ 매니지드 명부가 is_me 를 안 흘린다 — 넘길 후보에 내가 남는다(고르면 400)");
});

test("★★ E13 이름·아바타(workspace_update)도 매니지드에서 CP 로 간다 (#2188 설정 모달)", () => {
  //  ★실측: 종전엔 이 분기가 없어서 **매니지드에서 이름 바꾸기가 이미 죽어 있었다** — 화면(설정)은
  //   폼을 그리는데 누르면 requireRegistry 400("다중 워크스페이스가 아직 활성화되지 않았습니다").
  //   화면이 문을 그렸으면 그 문은 열려야 한다.
  const body = capBody("workspace_update");
  assert.match(body, /if \(managedMode\(\)\) \{[\s\S]{0,900}"\/api\/tenant\/workspace-update"/,
    "★매니지드에서 CP 창구를 부르지 않는다 — 설정 모달의 저장이 매니지드에서 400 난다");
  const m = body.indexOf("managedMode()"), r = body.indexOf("requireRegistry()");
  assert.ok(r === -1 || m < r, "매니지드 분기가 requireRegistry 보다 뒤다 — 그 자리에서 400 이다");
  //  ★입력 검증은 분기보다 앞 — 같은 값이 셀프호스트에선 400 인데 매니지드에선 CP 로 흘러가면 규칙이 두 벌.
  assert.ok(body.indexOf("normalizeWorkspaceFace") < m,
    "★face 검증이 매니지드 분기 뒤다 — 걸러지지 않은 값이 CP 로 흘러간다");
  //  얼굴 필드는 양쪽 목록에 **같은 이름**으로 실려야 한다(cpWsView 머리말의 규칙).
  const face = /face: w\.face && Object\.keys\(w\.face\)\.length \? w\.face : null/g;
  assert.equal((REG.match(face) || []).length, 2,
    "★face 가 wsView·cpWsView 중 한쪽에만 있다 — 셀프호스트와 매니지드 화면이 갈린다");
});

test("E11 초대는 '보냈다'고 말하지 않는다 — 링크를 준다(계정 서버가 메일을 안 보낸다)", () => {
  const people = read("web/v2/ws-people.ts");
  assert.match(people, /invite\?\.url/, "초대 응답의 링크를 읽지 않는다 — 사람에게 줄 것이 없다");
  assert.match(people, /초대 링크를 만들었어요/, "링크를 준 경우의 문구가 없다");
});
