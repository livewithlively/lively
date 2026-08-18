// #1750 S1 — 셀프호스트 다중 워크스페이스: 바인딩 모드·상태파일·인증 게이트·slug·DSN·배선 구조.
//  사양·엣지 표: 세션 스크래치패드 spec.md (spec-failfirst-test 1티어 — mutation red 입증 후 커밋).
//
// 여기서 잠그는 명제들은 전부 "빠지면 조용히 새는" 종류다:
//  · registry 리졸버의 primary 폴백 — 없으면 컨텍스트 밖 경로(하우스키핑·크론)가 전부 죽거나,
//    반대로 폴백이 넓으면 남의 컨텍스트가 primary 로 떨어진다.
//  · 게이트의 fail 방향 — 격리 게이트가 "모르겠으면 통과"면 게이트가 아니다.
//  · 배선 위치(첫 import·인증 두 지점) — 소스 구조로 잠근다. 자리를 옮기면 컴파일은 통과하지만
//    격리가 0 이 되는 유형이라, 테스트가 자리를 지켜야 한다(housekeeping-tenancy.test.ts 선례).
import { strict as assert } from "node:assert";
import test, { afterEach } from "node:test";
import { readFileSync, mkdtempSync, statSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearTenantResolver, tenantBindingSql } from "../../db/client.js";
import { SINGLE_TENANT_ID, TENANT_COLUMN_EXEMPT } from "../../db/tenant-column.js";
import { installTenantBinding, resolveBindingMode } from "../../db/tenant-binding-boot.js";
import { withTenant, currentTenant } from "../tenant-context.js";
import { readTenancyRuntimeSync, writeTenancyRuntime, registryModeActive, tenancyRuntimePath } from "./state.js";
import { workspaceAccessAllowed } from "./gate.js";
import { normalizeWorkspaceSlug, PRIMARY_TENANT_ID } from "./registry.js";
import { buildAppDsn, IDENTITY_GLOBAL_TABLES, appRoleName, autoActivationEligible } from "./activate.js";

const E = (o: Record<string, string> = {}) => o as NodeJS.ProcessEnv;
const REG = { LIVELY_TENANT_BINDING: "rls", LIVELY_TENANCY_MODE: "registry" };
const SEC_ID = "33333333-2222-3333-4444-555555555555";

afterEach(() => { clearTenantResolver(); delete process.env.LIVELY_TENANCY_MODE; });

// ── A. 바인딩 모드 판정 ─────────────────────────────────────────────────────

test("A1/A4/A5 — 미설정=off(자가호스팅 무회귀) · rls만=request(매니지드 무회귀) · registry 표시 단독=off", () => {
  assert.deepEqual(resolveBindingMode(E()), { mode: "off" });
  assert.deepEqual(resolveBindingMode(E({ LIVELY_TENANT_BINDING: "rls" })), { mode: "request" });
  // 표시 단독은 활성화가 아니다 — 상태파일 없이 env 만 수동으로 심은 배포가 조용히 registry 로 뜨면 안 된다.
  assert.deepEqual(resolveBindingMode(E({ LIVELY_TENANCY_MODE: "registry" })), { mode: "off" });
});

test("A2/A3 — registry 표시가 있으면 registry, 고정 테넌트 id 가 함께 있어도 registry 가 이긴다", () => {
  assert.deepEqual(resolveBindingMode(E(REG)), { mode: "registry" });
  assert.deepEqual(resolveBindingMode(E({ ...REG, LIVELY_TENANT_ID: "11111111-2222-3333-4444-555555555555" })), { mode: "registry" });
});

// ── B. registry 리졸버 — 폴백이 이 설계의 하위호환 전부다 ────────────────────

test("★★ B1/B2 — 컨텍스트 없으면 primary 상수로 바인딩, 있으면 그 워크스페이스", () => {
  installTenantBinding(E(REG));
  const noCtx = tenantBindingSql();
  assert.ok(noCtx, "컨텍스트 밖에서도 바인딩이 걸려야 한다(하우스키핑·크론 = primary 의 일)");
  assert.deepEqual(noCtx!.params, [SINGLE_TENANT_ID]);
  withTenant({ id: SEC_ID, slug: "acme" }, () => {
    assert.deepEqual(tenantBindingSql()!.params, [SEC_ID]);
  });
});

// ── C. 상태파일 ─────────────────────────────────────────────────────────────

test("C1~C4 — 왕복·파손 폴백·0600", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lvly-tenancy-"));
  const prev = process.env.LIVELY_STATE_DIR;
  process.env.LIVELY_STATE_DIR = tmp;
  try {
    assert.equal(readTenancyRuntimeSync(), null, "C1: 없으면 비활성");
    await writeTenancyRuntime({ mode: "registry", app_dsn: "postgres://lvly_app:pw@localhost:5432/lively" });
    assert.equal(readTenancyRuntimeSync()?.app_dsn, "postgres://lvly_app:pw@localhost:5432/lively", "C2: 왕복");
    assert.equal(statSync(tenancyRuntimePath()).mode & 0o777, 0o600, "C4: DSN 에 비밀번호가 있다 — 소유자 전용");
    // C3: 파손 3종 — 전부 조용한 단일 폴백(null). 유출이 아니라 '활성화가 덜 된 것'이다.
    const bad = path.join(tmp, "bad.json");
    for (const body of ['{"mode":"other","app_dsn":"postgres://a@b/c"}', '{"mode":"registry","app_dsn":"mysql://x"}', "{널브러진 json"]) {
      await import("node:fs/promises").then((f) => f.writeFile(bad, body));
      assert.equal(readTenancyRuntimeSync(bad), null, `C3 폴백 실패: ${body.slice(0, 30)}`);
    }
  } finally {
    if (prev === undefined) delete process.env.LIVELY_STATE_DIR; else process.env.LIVELY_STATE_DIR = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("C5 — 모드 표시 env 부재/존재 판정", () => {
  assert.equal(registryModeActive(E()), false);
  assert.equal(registryModeActive(E({ LIVELY_TENANCY_MODE: "registry" })), true);
});

// ── D. 게이트 — fail 방향이 전부다 ──────────────────────────────────────────

test("D1 — registry 모드가 아니면 항상 통과(단일·매니지드 무회귀)", async () => {
  assert.equal(await workspaceAccessAllowed("m1"), true);
});

test("★★ D2/D3/D4 — 무컨텍스트·primary = 통과(박스 로그인 = primary 접근), secondary + 신원 없음 = 거부", async () => {
  process.env.LIVELY_TENANCY_MODE = "registry";
  assert.equal(await workspaceAccessAllowed("m1"), true, "D2: 컨텍스트 없음 = primary");
  await withTenant({ id: PRIMARY_TENANT_ID, slug: "primary" }, async () => {
    assert.equal(await workspaceAccessAllowed("m1"), true, "D3: primary 컨텍스트");
  });
  await withTenant({ id: SEC_ID, slug: "sec" }, async () => {
    assert.equal(await workspaceAccessAllowed(null), false, "D4: 신원 없음 = 거부(fail-closed)");
    assert.equal(await workspaceAccessAllowed(""), false, "D4: 빈 신원 = 거부");
    assert.equal(await workspaceAccessAllowed(undefined), false, "D4: undefined = 거부");
  });
});

test("★★ D5 — secondary 에서 명부에 없는 신원은 거부(명부가 비었든·조회가 실패했든 같은 방향)", async () => {
  process.env.LIVELY_TENANCY_MODE = "registry";
  await withTenant({ id: SEC_ID, slug: "sec" }, async () => {
    // DB 가 없으면 조회 실패 → 거부(fail-closed), DB 가 있어도 이 신원은 명부에 없다 → 거부.
    //  어느 환경에서 돌아도 기대가 같다 — 그게 fail-closed 의 정의다.
    assert.equal(await workspaceAccessAllowed("no-such-member-e2e-xyz"), false);
  });
});

// ── E. slug — 경로·tmux 소켓 이름에 들어간다 ────────────────────────────────

test("E1~E4 — 정규화·경계(3/40 허용, 2/41 거부)·위반 거부", () => {
  assert.equal(normalizeWorkspaceSlug(" Acme-1 "), "acme-1", "E1: 트림·소문자화");
  assert.equal(normalizeWorkspaceSlug("abc"), "abc", "E2: 정확히 3자");
  assert.equal(normalizeWorkspaceSlug("a".repeat(40)), "a".repeat(40), "E2: 정확히 40자");
  for (const bad of ["ab", "a".repeat(41), "-abc", "abc-", "한글", "a b", null, undefined, ""]) {
    assert.throws(() => normalizeWorkspaceSlug(bad), /형식/, `E3/E4 허용되면 안 됨: ${String(bad)}`);
  }
});

// ── F. 앱 DSN 파생 ──────────────────────────────────────────────────────────

test("F1' — 사용자=주어진 role(상수 아님)·비밀번호 교체, 호스트·포트·DB·쿼리 보존", () => {
  const out = buildAppDsn("postgresql://owner:old@db.local:5433/lively?sslmode=require", "lvly_app_lively", "npw");
  const u = new URL(out);
  assert.equal(u.username, "lvly_app_lively");
  assert.equal(u.password, "npw");
  assert.equal(u.hostname, "db.local");
  assert.equal(u.port, "5433");
  assert.equal(u.pathname, "/lively");
  assert.equal(u.searchParams.get("sslmode"), "require");
});

test("F2/F3 — 못 알아보는 형태는 추측하지 않고 던진다(직접 지정 안내)", () => {
  for (const bad of ["postgres:///lively?host=/tmp", "not-a-url", ""]) {
    assert.throws(() => buildAppDsn(bad, "r", "x"), /직접 지정|해석할 수 없습니다/, `허용되면 안 됨: ${bad}`);
  }
});

// ── I. 앱 role 이름 — 클러스터 전역이라 DB 별로 갈라야 한다(공유 클러스터에서 비밀번호 상호 회전 사고) ──

test("I1~I4 — DB 이름 파생·63자 상한·DB 마다 다름·빈 이름 오류", () => {
  assert.equal(appRoleName("Lively-Prod.1"), "lvly_app_lively_prod_1", "I1: 소문자·비허용문자 _ 치환");
  assert.equal(appRoleName("x".repeat(100)).length, 63, "I2: Postgres 식별자 상한");
  assert.notEqual(appRoleName("ws_a"), appRoleName("ws_b"), "I3: 같은 클러스터의 두 DB 가 같은 role 을 쓰면 안 된다");
  for (const bad of ["", "   "]) assert.throws(() => appRoleName(bad), /비어/, "I4");
});

// ── J. 자동 활성화 대상 판정 — 매니지드·외부 바인딩에서 켜지면 CP 캡 우회/권위 이중화가 된다 ──

test("★★ J1~J6 — 순수 셀프호스트만 대상, 매니지드·바인딩·opt-out·기활성·무DB 는 제외", () => {
  const base = { ITEMS_DATABASE_URL: "postgres://u:p@h/db" };
  assert.equal(autoActivationEligible(E(base)).ok, true, "J1: 관리 env 없음 = 대상");
  assert.equal(autoActivationEligible(E({ ...base, LIVELY_WORKSPACE_REGISTRY: "off" })).ok, false, "J2: opt-out");
  assert.equal(autoActivationEligible(E({ ...base, LIVELY_TENANT_HEADER_SECRET: "s" })).ok, false, "J3: 매니지드 공유 게이트웨이");
  assert.equal(autoActivationEligible(E({ ...base, LIVELY_TENANT_BINDING: "rls" })).ok, false, "J4: 외부 바인딩(fixed/request)");
  assert.equal(autoActivationEligible(E({ ...base, ...REG })).ok, false, "J5: 이미 registry");
  assert.equal(autoActivationEligible(E({})).ok, false, "J6: DB 미설정");
});

// ── G. 면제 2축 — 겹치면 같은 표를 두 이유로 면제한 것(판단이 흐려진다) ──────

test("G1 — IDENTITY_GLOBAL ∩ TENANT_COLUMN_EXEMPT = ∅", () => {
  for (const t of IDENTITY_GLOBAL_TABLES) assert.ok(!TENANT_COLUMN_EXEMPT.has(t), `${t} 가 양쪽에 있다`);
});

// ── L. 세션→워크스페이스 정본 + URL 신호 — dev '다온' 유출(헤더 못 싣는 표면 → primary 오귀속) 대응 ──

import { tenantContextMiddleware, sessionIdFromRequest } from "../tenant-middleware.js";

/** express 없이 registry 미들웨어를 돌린다(비동기 분기 포함). */
async function runMw(headers: Record<string, string>, url: string) {
  const env = E({ ...REG });
  let nexted = false; let seen: { id: string; slug: string } | null = null; let status = 0;
  const lookup = async (slug: string) => slug === "acme" ? { id: SEC_ID, slug } : null;
  const sessionLookup = async (sid: string) => {
    if (sid === "box-a-11112222") return { id: SEC_ID, slug: "acme" };
    if (sid === "box-err-33334444") throw new Error("boom");
    return null;
  };
  const res = { status(c: number) { status = c; return this; }, json() { return this; } };
  await new Promise<void>((done) => {
    tenantContextMiddleware(env, lookup, sessionLookup)(
      { headers, url } as never, res as never,
      () => { nexted = true; seen = currentTenant(); done(); });
    // 거절 경로는 next 가 안 불린다 — 마이크로태스크 몇 번이면 프라미스 체인이 끝난다.
    setTimeout(done, 30);
  });
  return { nexted, seen: seen as { id: string; slug: string } | null, status };
}

test("L1/L6 — 명시 slug 가 최우선(세션 신호가 함께 있어도), miss 는 404", async () => {
  const a = await runMw({ "x-lively-workspace": "acme", "x-lively-session": "box-b-99998888" }, "/api/ui/me");
  assert.equal(a.seen?.slug, "acme", "L6: 명시가 이긴다");
  const b = await runMw({ "x-lively-workspace": "no-such" }, "/api/ui/me");
  assert.equal(b.status, 404, "L1: 명시 miss 는 primary 로 조용히 꽂히지 않는다");
});

test("L2 — lvly_ws 쿼리는 헤더와 동등(헤더를 못 싣는 SSE·iframe 표면용)", async () => {
  const a = await runMw({}, "/api/ui/v6/projects/1/chat/turn?lvly_ws=acme");
  assert.equal(a.seen?.slug, "acme");
  const b = await runMw({}, "/api/ui/me?lvly_ws=no-such");
  assert.equal(b.status, 404);
});

test("★★ L3/L4/L5 — 세션 축 폴백: 헤더·경로의 세션 id → 정본 맵 → 컨텍스트, 맵 없음 = primary", async () => {
  const a = await runMw({ "x-lively-session": "box-a-11112222" }, "/api/ui/knowledge/similar");
  assert.equal(a.seen?.slug, "acme", "L3: x-lively-session 헤더(구 kit 도 이미 보낸다 — #852)");
  const b = await runMw({}, "/api/ui/v6/sessions/box-a-11112222/log/watermark?node=");
  assert.equal(b.seen?.slug, "acme", "L4: URL 경로의 세션 id(캡처 훅·SSE)");
  const c = await runMw({}, "/api/ui/terminal/sessions/box-a-11112222/prompt");
  assert.equal(c.seen?.slug, "acme", "L4: terminal 경로");
  const d = await runMw({ "x-lively-session": "box-old-77776666" }, "/api/ui/me");
  assert.equal(d.nexted, true); assert.equal(d.seen, null, "L5: 맵 없음 = primary(구 세션 무회귀)");
});

test("L7/L8 — 형식 위반은 신호가 아니고, 해석기 오류는 500(오귀속 금지)", async () => {
  assert.equal(sessionIdFromRequest({ "x-lively-session": "a b c" }, "/api/ui/me"), null, "L7: 형식 위반");
  assert.equal(sessionIdFromRequest({}, "/api/ui/knowledge/box-a-11112222"), null, "L7: 세션 경로가 아니다");
  assert.equal(sessionIdFromRequest({}, "/api/ui/v6/sessions/box-a-11112222"), "box-a-11112222");
  const e = await runMw({ "x-lively-session": "box-err-33334444" }, "/api/ui/me");
  assert.equal(e.status, 500, "L8: 해석 실패를 primary 로 넘기면 그 순간이 오귀속이다");
  assert.equal(e.seen, null);
});

// ── M. 배선 구조 잠금(소스) — 세션 정본의 기록·정리·업그레이드·클라 신호 ──────

test("★★ M3/M4 — 세션 생성이 맵을 기록(실패=생성 실패)하고, 삭제가 정리한다(회수 제외)", () => {
  const rt = readFileSync("src/terminal/routes.ts", "utf8");
  assert.match(rt, /recordSessionTenant\(session\.id/, "생성 두 갈래(로컬·노드) 모두 기록해야 한다");
  assert.ok(rt.split("recordSessionTenant(session.id").length - 1 >= 2, "노드 릴레이 갈래가 빠지면 노드 세션이 오귀속된다");
  assert.match(rt, /생성 실패로 승격|생성을 실패시킨다/, "M3: 기록 실패를 삼키면 그 세션의 모든 무헤더 요청이 primary 로 간다");
  assert.match(rt, /clearSessionWorkspace/, "M4: 삭제 정리");
  assert.match(rt, /if \(!reclaim\) forgetTenantMap/, "M4: 회수(복원 가능)는 소속을 남긴다");
});

test("★ M5 — WS 업그레이드(registry)는 세션 정본으로 컨텍스트를 복원한다", () => {
  const pty = readFileSync("src/terminal/terminal-pty.ts", "utf8");
  assert.match(pty, /workspaceForSession/, "업그레이드는 헤더를 못 싣는다 — 정본 복원이 없으면 secondary attach 가 가짜 4410");
});

test("★ M1/M6 — apiUrl 이 lvly_ws 를 싣고, 훅·프록시가 세션 신호를 싣는다", () => {
  const net = readFileSync("web/lib/net.ts", "utf8");
  assert.match(net, /lvly_ws=/, "M1: URL 로 가는 요청(SSE·iframe)의 유일한 신호");
  const preload = readFileSync("kit/hooks/session-preload.mjs", "utf8");
  assert.match(preload, /SCOPE_HDRS/, "M6: 주입 훅이 무신호면 primary 컨텍스트('다온')가 주입된다");
  assert.match(readFileSync("kit/cli/lively-mcp-gateway.mjs", "utf8"), /x-lively-session/, "M6: MCP 프록시");
});

// ── H. 배선 구조 잠금(소스) ─────────────────────────────────────────────────

test("★★ H1/H2 — 인증 수렴 두 지점에 게이트: 웹 세션 + bearer(정적·DB 토큰 양쪽)", () => {
  assert.match(readFileSync("src/auth/sessions.ts", "utf8"), /workspaceAccessAllowed/, "세션 인증에 게이트가 없다");
  const bearer = readFileSync("src/auth/bearer.ts", "utf8");
  const calls = bearer.split("await assertWorkspaceMember(").length - 1;
  assert.ok(calls >= 2, `bearer 의 두 토큰 경로 모두 게이트를 불러야 한다(호출 ${calls}곳) — 한쪽만 걸면 정적 토큰이 뒷문이 된다`);
});

test("★★ H3 — index.ts 첫 import 는 env 재배선 — DB 클라이언트가 env 를 읽기 전이어야 한다", () => {
  const firstImport = readFileSync("src/index.ts", "utf8").match(/^import .*$/m)?.[0] ?? "";
  assert.match(firstImport, /boot\/tenancy-env\.js/, `첫 import 가 tenancy-env 가 아니다: ${firstImport}`);
});

test("H4 — 경로·파싱 규약은 state.ts 단일 출처: tenancy-env 는 그 동기 읽기를 그대로 쓴다", () => {
  const envSrc = readFileSync("src/boot/tenancy-env.ts", "utf8");
  assert.match(envSrc, /readTenancyRuntimeSync/, "tenancy-env 가 state.ts 를 안 쓴다 — 규약이 두 벌이 되면 갈린다");
  assert.ok(!envSrc.includes("process.cwd()"), "cwd 런타임 경로 금지(state-dir 가드레일) — stateRoot 경유여야 한다");
  assert.ok(tenancyRuntimePath().endsWith(path.join("tenancy", "runtime.json")));
});

test("H5 — registry 스키마 초기화는 자식 프로세스 + 신규 테이블 정책 보장 + 하우스키핑은 registry 에서 돈다", () => {
  const hk = readFileSync("src/boot/housekeeping.ts", "utf8");
  assert.match(hk, /registryModeActive\(\) \? runSchemaInitChild\(\)/, "schemas 스텝의 registry 분기가 없다");
  assert.match(hk, /&& !registryModeActive\(\)/, "requestScopedTenancy 가 registry 를 제외해야 하우스키핑이 primary 로 돈다");
  assert.match(readFileSync("src/boot/schema-init-child.ts", "utf8"), /ensureTenantPolicies/,
    "자식이 신규 테이블 정책 보장을 안 한다 — 새 테이블이 전 워크스페이스에 보인다");
});

test("H6 — 활성화는 격리 검증을 통과한 뒤에만 상태파일을 쓴다", () => {
  const act = readFileSync("src/org/tenancy/activate.ts", "utf8");
  const verify = act.indexOf("await verifyAppIsolation(");
  const write = act.indexOf("await writeTenancyRuntime(");
  assert.ok(verify > 0 && write > verify, `verify(${verify}) 가 write(${write}) 보다 앞이어야 한다`);
});

test("★★ K1/K2 — 부팅이 스스로 활성화한다: self-rls 뒤 스텝 + 성공 시 재기동(exit)", () => {
  const hk = readFileSync("src/boot/housekeeping.ts", "utf8");
  const selfRls = hk.indexOf('name: "self-rls"');
  const auto = hk.indexOf('name: "workspace-registry"');
  assert.ok(auto > 0, "K1: 자동 활성화 스텝이 없다 — 활성화가 도로 수동이 된다");
  assert.ok(auto > selfRls, "K1: self-rls 뒤여야 reader 정책까지 첫 판에 걸린다");
  const stepBody = hk.slice(auto, auto + 900);
  assert.match(stepBody, /process\.exit\(0\)/, "K2: 성공 후 재기동이 없으면 앱 role 재배선이 영영 안 된다");
});

test("K3 — 자동 활성화 실패는 던지지 않는다(단일 모드 유지) + 사유 보존", () => {
  const act = readFileSync("src/org/tenancy/activate.ts", "utf8");
  const at = act.indexOf("export async function autoActivateWorkspaceRegistry");
  assert.ok(at > 0);
  const body = act.slice(at, at + 1400);
  assert.match(body, /catch/, "실패가 부팅 체인을 죽이면 안 된다 — fail-closed 는 '단일 유지'지 '기동 실패'가 아니다");
  assert.match(body, /lastAutoActivationError/, "사유를 보존해야 화면(workspace_registry_status)이 '왜 아직 single 인가'에 답한다");
});
