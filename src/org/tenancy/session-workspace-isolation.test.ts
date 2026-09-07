// #1875 — 세션 목록의 워크스페이스 격리. 2026-08-27 장원준 신고: 개인 워크스페이스 사이드바에 **다른
//  워크스페이스(팀·박스)의 세션 제목이 그대로 보인다**. 원인: 세션 목록이 owner(org_member — 워크스페이스를
//  넘나드는 전역 신원)로만 걸러, 그 사람의 모든 세션이 어느 워크스페이스에서든 다 나왔다.
//
// 여기서 잠그는 명제는 "빠지면 조용히 남의 워크스페이스 세션 제목이 새는" 종류다. 그래서 규칙 하나를
//  순수 함수(sessionInWorkspace)로 뽑아 SQL 필터·JS 필터가 같은 명제를 쓰게 했고, 그 명제를 엣지마다 건다.
//  (SQL(listSessionsForOwner)·JS(routes.ts) 두 필터가 이 함수와 같은 규칙인지는 아래 구조 단언이 지킨다.)
//
// 엣지 표(입력=[세션의 맵 소속, 현재 워크스페이스] × 기대=보이나):
//   E1 [부재, primary]  → 보임   (새 헬퍼의 '맵 부재' 엣지 — 옛 세션은 전부 여기)
//   E2 [부재, 개인A]    → 숨김   ★신고의 핵심(박스 세션이 개인 ws 로 샜다)
//   E3 [개인A, 개인A]   → 보임   (자기 것)
//   E4 [개인A, 개인B]   → 숨김   ★개인↔개인 누수
//   E5 [개인A, primary] → 숨김   ★대칭(개인 세션이 박스로 누수)
//   ── 매니지드(#3564) — 기본값이 다르다 ──
//   M1 [부재, 테넌트]   → 보임   ★이 사고(매니지드에선 현재 ws=테넌트 uuid 라 primary 로 접으면 전량 사라진다)
//   M2 [개인A, 테넌트]  → 숨김   (격리는 매니지드에서도 그대로)
//   M3 셀프호스트 규칙 무회귀 — 부재 = primary
//   M4 «부재의 기본값» 자체를 한 헬퍼로(defaultWorkspaceId) — SQL·JS 두 필터가 이 값을 공유한다
//   ── 구조(#3579) — 2026-08-28 에 한 번 고쳤다가 커밋되지 못한 채 사라진 자리 ──
//   S1 세션을 **만드는 자리마다** 소속 기록이 붙는가(호출 수가 아니라 대칭)
//   E11 이력 목록 SQL 도 gw_workspace 가 비어도 매핑을 살린다(LEFT JOIN — E9 의 SQL 쌍둥이)
//   E12 이력 목록 SQL 의 «부재» 귀속이 JS 필터와 **같은 헬퍼**를 쓴다(상수로 굳으면 둘이 갈린다)
import { strict as assert } from "node:assert";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionInWorkspace, defaultWorkspaceId, PRIMARY_TENANT_ID } from "./registry.js";

const PRIMARY = PRIMARY_TENANT_ID;                   // 박스/primary — gw_session_map 에 행이 없으면 여기로 귀속
const WS_A = "11111111-1111-1111-1111-111111111111"; // 개인 워크스페이스 A(예: 하루)
const WS_B = "22222222-2222-2222-2222-222222222222"; // 개인 워크스페이스 B

test("E1 안 묶인 옛 세션은 primary(박스)에서 보인다 — 맵 부재 = primary", () => {
  assert.equal(sessionInWorkspace(undefined, PRIMARY), true);
  assert.equal(sessionInWorkspace(null, PRIMARY), true);
});

test("★ E2 안 묶인(박스) 세션은 개인 워크스페이스로 새지 않는다 — 이 신고의 핵심", () => {
  // owner 로만 걸렀을 때 개인 ws 사이드바에 박스 세션 제목이 뜨던 바로 그 자리.
  assert.equal(sessionInWorkspace(undefined, WS_A), false);
});

test("E3 개인 워크스페이스 세션은 그 워크스페이스에서 보인다", () => {
  assert.equal(sessionInWorkspace(WS_A, WS_A), true);
});

test("★ E4 개인 워크스페이스 세션은 다른 개인 워크스페이스로 새지 않는다", () => {
  assert.equal(sessionInWorkspace(WS_A, WS_B), false);
});

test("★ E5 개인 워크스페이스 세션은 primary(박스)에도 새지 않는다", () => {
  // 대칭 — 개인에서 만든 세션이 팀/박스 목록에 뜨면 그것도 격리 위반이다.
  assert.equal(sessionInWorkspace(WS_A, PRIMARY), false);
});

// ── 매니지드(#3564) — «매핑 부재» 의 기본값이 배포마다 다르다 ───────────────────────────
//  실측 2026-09-04(lively-46e3): 세션 901건 중 869건이 gw_session_map 부재였고, 목록 API 가 매핑된 8건만
//  돌려줬다. 사용자에겐 «세션이 다 사라짐» 이다. 매니지드에선 현재 ws 가 테넌트 uuid 라 PRIMARY_TENANT_ID
//  로 접으면 **절대** 같아질 수 없다 — 부재는 primary 가 아니라 «이 워크스페이스» 로 읽어야 한다.
const TENANT = "a4b68262-535b-4be0-a1dc-50ec71576441";   // 실측 테넌트 uuid 모양

test("★ M1 매니지드에서 매핑 없는 세션은 **지금 워크스페이스**의 것이다 — 이 사고의 핵심", () => {
  assert.equal(sessionInWorkspace(undefined, TENANT, true), true);
  assert.equal(sessionInWorkspace(null, TENANT, true), true);
  //  기본값을 primary 로 접으면 테넌트 uuid 와 같아질 수 없어 전량 사라진다(회귀 시 여기가 red).
  assert.equal(sessionInWorkspace(undefined, TENANT, false), false, "셀프호스트 규칙을 매니지드에 적용하면 이렇게 사라진다");
});

test("★ M2 매니지드라도 **다른 워크스페이스에 묶인** 세션은 여전히 안 보인다(격리는 그대로)", () => {
  assert.equal(sessionInWorkspace(WS_A, TENANT, true), false);
  assert.equal(sessionInWorkspace(TENANT, TENANT, true), true);
});

test("M3 셀프호스트(비매니지드) 규칙은 종전 그대로 — 부재 = primary", () => {
  assert.equal(sessionInWorkspace(undefined, PRIMARY, false), true);
  assert.equal(sessionInWorkspace(undefined, WS_A, false), false);   // E2 의 누수 방어가 살아 있다
});

// ── 구조·배선: 두 목록 경로가 실제로 워크스페이스로 거른다(누가 필터를 떼면 red) ──────────

function repoRoot(): string {
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(d, "package.json")) && existsSync(path.join(d, "web"))) return d;
    d = path.dirname(d);
  }
  throw new Error("레포 뿌리를 찾지 못했다");
}
const readSrc = (rel: string): string => readFileSync(path.join(repoRoot(), rel), "utf8");

test("★ E6 이력 목록(/api/ui/v6/sessions)의 SQL 이 gw_session_map 으로 거른다 — 없으면 owner 전체가 샌다", () => {
  const src = readSrc("src/v6/session-log-store.ts");
  // listSessionsForOwner 가 gw_session_map 을 술어로 쓰고, 맵 부재를 primary 로 귀속(COALESCE … SINGLE_TENANT_ID)한다.
  assert.match(src, /gw_session_map[\s\S]{0,240}COALESCE|COALESCE[\s\S]{0,240}gw_session_map/,
    "listSessionsForOwner 에 gw_session_map 워크스페이스 필터가 없다 — owner 로만 걸러 개인 ws 에 박스 세션이 샌다");
  //  ⚠ 귀속값은 **상수가 아니라 헬퍼**여야 한다(E12) — 매니지드에선 primary 로 접으면 전량 사라진다.
  assert.match(src, /defaultWorkspaceId\(/, "맵 부재 시 귀속을 배포 모드 헬퍼(defaultWorkspaceId)로 정하지 않는다");
});

test("★ E7 라이브 목록(/api/ui/terminal/sessions)이 sessionInWorkspace 로 거른다", () => {
  const src = readSrc("src/terminal/routes.ts");
  assert.match(src, /sessionInWorkspace\(/, "라이브 세션 목록 응답에 워크스페이스 필터(sessionInWorkspace)가 없다");
});

test("E8 세션 목록 엔드포인트가 현재 워크스페이스를 필터로 넘긴다", () => {
  const src = readSrc("src/sessions/session-log-routes.ts");
  // 현재 워크스페이스를 뽑아(currentTenant, 부재=primary) listSessionsForOwnerPage 의 3번째 인자로 넘긴다.
  assert.match(src, /const wsId = currentTenant\(\)\?\.id \?\? PRIMARY_TENANT_ID/,
    "/api/ui/v6/sessions 가 현재 워크스페이스(currentTenant)를 읽지 않는다");
  assert.match(src, /listSessionsForOwnerPage\([\s\S]{0,80}?,\s*wsId\)/,
    "/api/ui/v6/sessions 가 listSessionsForOwnerPage 에 wsId(현재 워크스페이스)를 넘기지 않는다");
});

// ── E9 매니지드 회귀 (실측 2026-08-27 프로덕션) ──────────────────────────────────────────
//  위 격리가 배포된 직후 매니지드에서 **세션 목록이 통째로 비었다**(e2e `[10] 세션이 목록에 안 나타남`,
//  `{"sessions":[]}`). 규칙(sessionInWorkspace)은 옳았고, 깨진 건 소속을 **읽어 오는** SQL 이었다:
//   · gw_session_map 에는 매핑이 멀쩡히 있다.
//   · 그런데 `gw_workspace` 는 **0행**이다 — 매니지드는 워크스페이스 축을 CP 가 테넌트로 갖고 있어
//     이 표를 안 쓴다(실측: 테넌트 컨텍스트 유무와 무관하게 count=0).
//   · INNER JOIN 이라 매핑이 있어도 **전부** 버려졌고, 모든 세션이 «소속 부재» 로 떨어졌다.
//     현재 워크스페이스는 테넌트 UUID 인데 부재의 기본값은 primary(all-zero)라 하나도 안 맞는다.
//  조인의 목적은 «보관된(archived) 워크스페이스 제외» 이지 «레코드 없는 배포 전멸» 이 아니다.
test("★ E9 소속 조회는 gw_workspace 가 비어도 매핑을 살린다 — 매니지드에서 목록이 통째로 비었다", () => {
  const src = readSrc("src/org/tenancy/registry.ts");
  const fn = src.slice(src.indexOf("export async function sessionWorkspaceIds"));
  assert.match(fn, /LEFT JOIN gw_workspace/,
    "INNER JOIN 이면 gw_workspace 가 빈 배포(매니지드)에서 매핑이 전부 버려진다");
  assert.match(fn, /w\.id IS NULL OR w\.state='active'/,
    "행이 없으면 '모름'이라 매핑을 그대로 쓰고, 있는데 보관됐을 때만 뺀다");
});

test("E10 워크스페이스 레코드를 돌려주는 쪽은 INNER 가 맞다 — 두 계약을 섞지 않는다", () => {
  const src = readSrc("src/org/tenancy/registry.ts");
  const fn = src.slice(src.indexOf("export async function workspaceForSession"), src.indexOf("export async function sessionWorkspaceIds"));
  // 주석이 아니라 **SQL 문장만** 본다 — 주석에 'LEFT JOIN' 이라 적기만 해도 걸리면 그건 계약이 아니라 검열이다.
  const sql = fn.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.match(sql, /JOIN gw_workspace/, "레코드가 필요한 자리라 행이 없으면 줄 것이 없다");
  assert.ok(!/LEFT JOIN gw_workspace/.test(sql), "이쪽까지 LEFT 로 바꾸면 null 필드의 가짜 워크스페이스가 나간다");
});

// ── #3579 — 2026-08-28 에 완결됐다가 **커밋되지 못한 채** 사라진 세 조각 ─────────────────────
//  그날의 고침(지식 managed-session-list-missing-workspace-map-2179)은 회귀 테스트까지 green 이었는데
//  git 에는 한 줄도 안 남았다(전 브랜치 `git log -S defaultWorkspaceId` = 0건). 그래서 «부재의 기본값» 은
//  #3564 가 모르고 다시 고쳤고(sessionInWorkspace), 아래 셋은 **오늘까지 깨진 채**였다.
//  잴 자가 함께 사라지면 아무도 모른다 — 그래서 이 셋을 구조 단언으로 박는다.

test("M4 «부재의 기본값» 은 배포 모드가 정한다 — SQL·JS 가 이 한 헬퍼를 공유한다", () => {
  //  이 값이 두 벌로 갈리면 라이브 목록과 이력 목록이 서로 다른 세션 집합을 보여 준다(실측: 이력만 0건).
  assert.equal(defaultWorkspaceId(TENANT, true), TENANT, "매니지드에선 «모름» 이 곧 이 워크스페이스다");
  assert.equal(defaultWorkspaceId(WS_A, false), PRIMARY, "셀프호스트에선 «모름» 이 primary(박스)다");
  assert.equal(defaultWorkspaceId(PRIMARY, false), PRIMARY);
  //  sessionInWorkspace 가 정말 이 헬퍼와 같은 답을 내는가(둘이 갈리면 여기서 red).
  for (const [cur, managed] of [[TENANT, true], [WS_A, false], [PRIMARY, false]] as [string, boolean][]) {
    assert.equal(sessionInWorkspace(undefined, cur, managed), defaultWorkspaceId(cur, managed) === cur,
      `sessionInWorkspace 와 defaultWorkspaceId 가 갈렸다 (cur=${cur}, managed=${managed})`);
  }
});

test("★ S1 세션을 **만드는 자리마다** 소속 기록이 붙는다 — 한 곳만 빠져도 그 세션은 영구 실종된다", () => {
  //  ⚠ 호출 **수**를 세지 않는다. 수는 생성 자리가 늘면 조용히 맞아 버린다(6↔6 이면 통과하는데 새 7번째가
  //   안 붙어도 모른다). 여기서 잠그는 명제는 «생성하는 자리마다 기록이 붙는가» 라는 **대칭**이다.
  //  실측 2026-08-28·2026-09-07: 생성 6곳 중 복원 **박스(로컬)** 분기 한 곳만 기록이 없었다. 그 세션은
  //   gw_session_map 행 없이 태어나 매니지드/registry 배포에서 목록에 영영 안 뜬다(= 복원했는데 못 엶).
  const lines = readSrc("src/terminal/routes.ts").split("\n");
  const CREATES = /await (createSession|relayNodeOp<SessionInfo>)\(/;
  const sites = lines.map((l, i) => (CREATES.test(l) ? i : -1)).filter((i) => i >= 0);
  //  정규식이 낡으면(생성 형태가 바뀌면) 이 테스트는 조용히 아무것도 안 지킨다 — 하한을 같이 박는다.
  assert.ok(sites.length >= 6, `세션 생성 자리를 ${sites.length}곳만 찾았다 — 생성 형태가 바뀌었으면 위 정규식을 같이 고쳐라`);
  const missing = sites
    .filter((i) => !lines.slice(i, i + 40).some((l) => l.includes("recordSessionTenant(")))
    .map((i) => `${i + 1}행: ${lines[i].trim().slice(0, 90)}`);
  assert.deepEqual(missing, [], `세션을 만들고 소속을 안 새기는 자리가 있다(그 세션은 목록에서 사라진다):\n  ${missing.join("\n  ")}`);
});

test("★ E11 이력 목록 SQL 도 gw_workspace 가 비어도 매핑을 살린다 — E9 의 SQL 쌍둥이", () => {
  //  E9 가 sessionWorkspaceIds 를 LEFT 로 고칠 때 **이 SQL 은 INNER 로 남았다.** 같은 결함의 두 자리를
  //   따로 고치면 반쪽만 낫는다 — 매니지드는 gw_workspace 0행이라 서브쿼리가 항상 NULL 이 되고,
  //   /api/ui/v6/sessions 가 **항상 0건**이었다(#3564 의 백필 869건으로도 안 풀린다: INNER 에서 탈락한다).
  const src = readSrc("src/v6/session-log-store.ts");
  const fn = src.slice(src.indexOf("export async function listSessionsForOwner("));
  const sql = fn.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("--")).join("\n");
  assert.match(sql, /LEFT JOIN gw_workspace/,
    "INNER JOIN 이면 gw_workspace 가 빈 배포(매니지드)에서 이력 목록이 통째로 0건이 된다");
  assert.match(sql, /w\.id IS NULL OR w\.state = 'active'/,
    "행이 없으면 '모름'이라 매핑을 그대로 쓰고, 있는데 보관됐을 때만 뺀다(sessionWorkspaceIds 와 같은 규칙)");
});

test("★ E12 이력 목록 SQL 의 «부재» 귀속은 상수가 아니라 공유 헬퍼다", () => {
  //  상수(SINGLE_TENANT_ID)로 굳히면 매니지드에서 현재 ws(테넌트 uuid)와 절대 안 맞아 전량 탈락한다.
  //  JS 필터(sessionInWorkspace)와 **같은 명제**를 써야 두 목록이 갈리지 않는다.
  const src = readSrc("src/v6/session-log-store.ts");
  const fn = src.slice(src.indexOf("export async function listSessionsForOwner("));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /defaultWorkspaceId\(workspaceId\)/,
    "맵 부재 시 귀속값을 defaultWorkspaceId(workspaceId) 로 정하지 않는다 — 배포 모드를 못 본다");
  assert.ok(!/SINGLE_TENANT_ID/.test(body),
    "귀속값이 아직 상수(SINGLE_TENANT_ID)로 박혀 있다 — 매니지드에서 이력 목록이 0건이 된다");
});
