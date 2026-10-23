// 외부 앱 연결 «다음 걸음» 판정(org/connect-next.ts) + 상태 도구(org_connect_status) — 사양 Q1~Q6 · 엣지 N1~N13(#4970).
//  실행: npm run build && node dist/capabilities/connect-status.test.js
//  ⚠ DB 를 요구하지 않는다 — DB 주소가 없으면 앱 상태 조회가 즉시 실패한다(db/client.ts #2457). 그 상태가 곧 N12(모든 앱 조회 실패)다.
import assert from "node:assert/strict";
import { decideConnectNext, type ConnectFacts } from "../org/connect-next.js";
import { registry } from "./index.js";
import { CONNECT_APPS, routeFactsOf, githubViaOf, claudeLoginOf } from "./connect-status.js";
import { decideRoutes } from "../org/connect-routes.js";
import { APP_REGISTRATIONS, registrationView, registrationMarkdown } from "../org/connect-registration.js";
import { REGISTER_SAVE } from "./connect-register.js";
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
  //  (#4970 길) 조회가 실패한 앱은 길을 지어내지 않는다.
  for (const a of r.apps as unknown as Array<{ app: string; routes: unknown; recommended: unknown }>) {
    assert.equal(a.routes, null, `조회 실패한 '${a.app}' 의 길은 null`);
    assert.equal(a.recommended, null, a.app);
  }
  await assert.rejects(cap!.handler({}, undefined as never), (e: unknown) => (e as { status?: number }).status === 401, "신원 없는 호출은 401");
  ok("N12 모든 앱 조회 실패 — 도구는 성공, 앱마다 error·next=null · 권한별 can_register · 신원 없으면 401");
}

// ── (#4970 길) 앱마다 길 구성 — 사양 표 1 ──
{
  const want: Record<string, string[]> = {
    slack: ["app", "ai"], notion: ["app", "ai"], google: ["app", "ai"], linear: ["app"], outlook: ["app"],
    github: ["app", "token"], gitlab: ["token"], clickup: ["token"], figma: ["token"],
  };
  const p = { app_ready: true, me_connected: false, collecting: false };
  const ctx = { heldBy: "workspace" as const, canRegister: false, canCollect: true, aiPolicy: "allowed" as const, aiMine: null };
  for (const a of CONNECT_APPS) {
    const kinds = decideRoutes(routeFactsOf(a, p, ctx)).routes.map((r) => r.kind);
    assert.deepEqual(kinds, want[a.app], `${a.app} 의 길`);
  }
  //  구글의 Claude 길은 지메일만 모은다 — 커넥터 앱 키가 gmail 이어야 «내 지메일 커넥터» 를 본다.
  assert.equal(CONNECT_APPS.find((a) => a.app === "google")!.routes.aiApp, "gmail");
  ok("G1 앱마다 길 구성(app · ai · token) — 사양 표와 같다 · 구글 Claude 길 = 지메일");
}

// ── (#4970 길) 깃허브 — 한 수집기를 앱 연결·개인 토큰이 함께 쓴다: 모으는 중이면 어느 길인가 ──
{
  const gh = CONNECT_APPS.find((a) => a.app === "github")!;
  const ctx = { heldBy: "workspace" as const, canRegister: true, canCollect: true, aiPolicy: "allowed" as const, aiMine: null };
  const st = (p: Parameters<typeof routeFactsOf>[1]) => decideRoutes(routeFactsOf(gh, p, ctx)).routes.map((r) => `${r.kind}:${r.state}`);
  assert.deepEqual(st({ app_ready: true, me_connected: true, collecting: true, via: { app: true, token: false } }), ["app:collecting", "token:connect"], "앱으로 연결해 모으는 중");
  assert.deepEqual(st({ app_ready: true, me_connected: true, collecting: true, via: { app: false, token: true } }), ["app:connect", "token:collecting"], "★ 개인 토큰으로 모으는 중이면 토큰 길");
  assert.deepEqual(st({ app_ready: false, me_connected: true, collecting: true, via: { app: false, token: true } }), ["app:register", "token:collecting"], "앱 미등록이면 모으는 길은 토큰");
  assert.deepEqual(st({ app_ready: true, me_connected: false, collecting: true, via: { app: false, token: false } }), ["app:collecting", "token:connect"], "남의 연결로 모으는 중 — 앱이 있으면 앱 길");
  assert.deepEqual(st({ app_ready: true, me_connected: true, collecting: false, via: { app: true, token: true } }), ["app:set_scope", "token:set_scope"], "둘 다 연결 · 수집 꺼짐");
  //  내 연결 종류 — 같은 칸(github_pat)이라 meta 로 가른다.
  const row = (scope_key: string, meta: Record<string, unknown>) => ({ kind: "github_pat", scope_key, has_secret: true, meta });
  assert.deepEqual(githubViaOf([row("", { token_type: "bearer", expires_at: 1 })]), { app: true, token: false }, "[GitHub 연결] 의 토큰 묶음");
  assert.deepEqual(githubViaOf([row("", { auth_header: "Authorization", token_prefix: "Bearer " })]), { app: false, token: true }, "★ 연결 스킬대로 scope_key \"\" 로 넣은 개인 토큰");
  assert.deepEqual(githubViaOf([row("github.com", {})]), { app: false, token: true }, "옛 수집기 폼의 개인 토큰(호스트)");
  assert.deepEqual(githubViaOf([{ ...row("", { token_type: "bearer" }), has_secret: false }, { kind: "slack_oauth", scope_key: "", has_secret: true, meta: { token_type: "bearer" } }]), { app: false, token: false }, "값 없는 칸 · 다른 앱 칸은 안 센다");
  ok("G2 깃허브 앱 연결·개인 토큰 — 모으는 길 가르기 · 내 연결 종류(meta 로)");
}

// ── (#4970 길) Claude 커넥터 기록 → ai 길 ──
{
  const sl = CONNECT_APPS.find((a) => a.app === "slack")!;
  const p = { app_ready: true, me_connected: false, collecting: false };
  const ai = (aiPolicy: "allowed" | "blocked" | "unknown", aiMine: Map<string, string> | null) =>
    decideRoutes(routeFactsOf(sl, p, { heldBy: "lively", canRegister: false, canCollect: true, aiPolicy, aiMine })).routes[1]!.state;
  assert.equal(ai("allowed", new Map([["slack", "connected"]])), "connected");
  assert.equal(ai("allowed", new Map([["gmail", "connected"]])), "connect", "다른 앱의 커넥터를 슬랙으로 치지 않는다");
  assert.equal(ai("allowed", null), "connect", "기록을 못 읽으면 «연결» 로 권한다(R14)");
  assert.equal(ai("unknown", new Map([["slack", "connected"]])), "off", "정책을 못 읽으면 꺼짐(fail-closed)");
  //  마지막 확인 → 서버의 Claude 로그인. 로그인 사유가 아닌 실패는 모른다.
  assert.equal(claudeLoginOf(null), null, "확인한 적 없음");
  assert.equal(claudeLoginOf({ ok: true, error: null }), true);
  assert.equal(claudeLoginOf({ ok: false, error: "not-logged-in" }), false);
  assert.equal(claudeLoginOf({ ok: false, error: "not-claude-ai-login" }), false, "API 키 로그인 = claude.ai 커넥터가 없다");
  assert.equal(claudeLoginOf({ ok: false, error: "timeout" }), null, "시간 초과는 로그인 문제가 아니다");
  const needs = decideRoutes(routeFactsOf(sl, p, { heldBy: "lively", canRegister: false, canCollect: true, aiPolicy: "allowed", aiMine: new Map(), aiLogin: false })).routes[1]!.needs;
  assert.equal(needs, "claude_login", "로그인 없음이 길까지 이어진다(배선)");
  ok("G3 Claude 커넥터 기록 → ai 길 상태(앱 키 · 못 읽음 · 정책) · 서버 Claude 로그인 → «로그인부터»");
}

// ── (#4970 앱 등록) 안내 데이터 — 화면·스킬 한 벌 (R16·R17) ──
{
  assert.deepEqual(Object.keys(APP_REGISTRATIONS).sort(), Object.keys(REGISTER_SAVE).sort(), "안내가 있는 앱 = 저장할 수 있는 앱");
  const needsApp = CONNECT_APPS.filter((a) => a.routes.app).map((a) => a.app).sort();
  assert.deepEqual(Object.keys(APP_REGISTRATIONS).sort(), needsApp, "라이블리 앱 길이 있는 앱마다 안내가 있다");
  const v = registrationView("notion", { callbackUrl: "https://acme.example/oauth/callback", gatewayUrl: "https://acme.example" })!;
  const cb = v.steps.find((s) => s.copy?.what === "callback_url")!;
  assert.equal(cb.copy!.value, "https://acme.example/oauth/callback", "돌아올 주소 자리에 실제 값");
  assert.deepEqual(v.missing, []);
  const none = registrationView("github", { callbackUrl: null, gatewayUrl: null })!;
  assert.deepEqual(none.missing.sort(), ["callback_url", "gateway_url"], "공개 주소가 없으면 «먼저 할 일» 로 알린다");
  assert.equal(registrationView("gitlab", { callbackUrl: null, gatewayUrl: null }), null, "앱 등록이 없는 앱");
  for (const app of Object.keys(APP_REGISTRATIONS)) {
    const md = registrationMarkdown(app);
    for (const s of APP_REGISTRATIONS[app]!.steps) assert.ok(md.includes(s.text), `${app}: 스킬 안내에 화면과 같은 걸음이 없다 — «${s.text.slice(0, 20)}…»`);
    assert.match(md, /`prereq\.callback_url`/, `${app}: 돌아올 주소 없음 처리`);
    assert.match(md, new RegExp("org_connect_register \\{ app:\"" + app + "\""), `${app}: 대화 대안이 한 문을 쓴다`);
    assert.doesNotMatch(md, /\{callback_url\}|\{gateway_url\}/, `${app}: 자리표가 그대로 남았다`);
  }
  //  알아 둘 것 — 화면(view)과 스킬(markdown)에 같은 글로.
  for (const app of Object.keys(APP_REGISTRATIONS)) {
    const notes = APP_REGISTRATIONS[app]!.notes ?? [];
    assert.deepEqual(registrationView(app, { callbackUrl: "https://x.example/oauth/callback", gatewayUrl: "https://x.example" })!.notes, notes, `${app}: 화면 알아 둘 것`);
    for (const n of notes) assert.ok(registrationMarkdown(app).includes(n), `${app}: 스킬에 알아 둘 것이 없다 — «${n.slice(0, 20)}…»`);
  }
  assert.ok((APP_REGISTRATIONS.google!.notes ?? []).some((n) => /100개/.test(n)), "구글 미검증 앱 계정 한도를 미리 알린다");
  //  깃허브 키는 파일로 받는다 — 붙여 넣기 실수(경로·잘린 값)가 흔하다.
  assert.equal(APP_REGISTRATIONS.github!.fields.find((f) => f.key === "private_key")!.file, true);
  ok("G4 앱 등록 안내 — 앱 목록 일치 · 자리표 채움 · 주소 없으면 먼저 할 일 · 스킬 글 = 화면 글");
}

// ── (#4970 앱 등록) 저장 문 — 권한·값 확인은 DB 전에 ──
{
  const cap = registry.get("org_connect_register");
  assert.ok(cap, "registry 에 org_connect_register 가 없다");
  const member = { userId: "m", email: "m@example.invalid", scopes: ["memory"], projects: ["*"], tokenSource: "db" } as never;
  const reader = { userId: "r", email: "r@example.invalid", scopes: ["context"], projects: ["*"], tokenSource: "db" } as never;
  const admin = { userId: "a", email: "a@example.invalid", scopes: ["memory", "admin"], projects: ["*"], tokenSource: "db" } as never;
  const st = (p: Promise<unknown>) => p.then(() => 200, (e) => (e as { status?: number }).status ?? 500);
  assert.equal(await st(cap!.handler({ app: "nope", values: {} }, admin)), 400, "모르는 앱");
  assert.equal(await st(cap!.handler({ app: "slack", values: { client_id: "x", client_secret: "y" } }, member)), 403, "★ 슬랙은 관리자만(금고 등록 권한)");
  assert.equal(await st(cap!.handler({ app: "github", values: {} }, reader)), 403, "깃허브는 워크스페이스 관리 권한");
  assert.equal(await st(cap!.handler({ app: "notion", values: { client_id: "x" } }, admin)), 400, "빠진 값은 저장 전에 거른다");
  assert.equal(await st(cap!.handler({ app: "notion", values: { client_id: "  ", client_secret: "y" } }, admin)), 400, "공백뿐인 값");
  assert.equal(await st(cap!.handler({ app: "notion", values: { client_id: "x", client_secret: "y" } }, undefined as never)), 401);
  ok("G5 앱 등록 저장 문 — 모르는 앱 400 · 슬랙 관리자만 · 깃허브 관리 권한 · 빠진 값 400 · 신원 없음 401");
}

console.log(`\n${pass} passed`);
