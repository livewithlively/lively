// 앱 등록 보기·지우기 관문 · 노션 워크스페이스 끊기 관문 · 화면에 보일지(조회 실패) · 스킬 안내(#4991).
//  실행: npm run build && node dist/capabilities/connect-register.test.js
//  ⚠ DB 를 요구하지 않는다 — 관문(신원·앱·권한·배포·릴레이)은 DB 를 부르기 전에 결정해야 한다. 관문을 지나면 DB 없는 환경이라
//   다른 오류(500 등)가 난다 — 그래서 «정해진 상태 코드가 나왔다» 가 곧 «DB 전에 막았다» 의 증거다.
//  사양 표(A1 · D · E7 · F7 · H) — 행마다 시험 하나.
import assert from "node:assert/strict";
import { registry } from "./index.js";
import { REGISTER_SAVE } from "./connect-register.js";
import { REGISTRATION_SLOTS, RELAY_ENV } from "../org/connect-unregister.js";
import { githubAppReady, googleReady, linearAppReady, microsoftReady, notionPublicReady, slackAppReady } from "../org/credentials/oauth-broker.js";
import { APP_REGISTRATIONS, registrationMarkdown } from "../org/connect-registration.js";
import { CONNECT_SKILL_SPECS, assembleConnectBody } from "../org/delivery/connect-skills.js";

let pass = 0;
const ok = (name: string) => { pass++; console.log(`ok  ${name}`); };

const who = (scopes: string[]) => ({ userId: `u-${scopes.join("-")}`, email: "u@example.invalid", scopes, projects: ["*"], tokenSource: "db" }) as never;
const member = who(["memory"]);
const reader = who(["context"]);
const admin = who(["memory", "admin"]);
const st = (p: Promise<unknown>) => p.then(() => 200, (e) => (e as { status?: number }).status ?? 500);
const withEnv = async <T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> => {
  const keep: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { keep[k] = process.env[k]; process.env[k] = env[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(env)) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } }
};

const view = registry.get("org_connect_registration");
const del = registry.get("org_connect_unregister");
const reg = registry.get("org_connect_register");
const cut = registry.get("org_notion_workspace_disconnect");

// ── 배선 ──
{
  for (const [name, cap] of [["org_connect_registration", view], ["org_connect_unregister", del], ["org_notion_workspace_disconnect", cut]] as const) {
    assert.ok(cap, `registry 에 ${name} 가 없다`);
    assert.equal(cap!.expose.mcp, true, `${name}: 스킬이 부르려면 MCP 로 열려 있어야 한다`);
    assert.equal(cap!.scope, "memory", `${name}: 권한은 핸들러가 앱마다 본다(등록 문과 같은 선언)`);
  }
  const rest = (c: typeof view) => (Array.isArray(c!.expose.rest) ? c!.expose.rest : []).flatMap((m) => m.paths.map((p) => `${m.method} ${p}`));
  assert.deepEqual(rest(view), ["GET /api/ui/org/connect/registration"]);
  assert.deepEqual(rest(del), ["POST /api/ui/org/connect/unregister"]);
  assert.deepEqual(rest(cut), ["POST /api/ui/org/notion/workspace/disconnect"]);
  ok("배선 — 세 도구가 레지스트리 · MCP · REST 에 있다");
}

// ── A1 지우는 칸의 맨 앞 = 등록 문이 쓰는 칸 ──
{
  assert.deepEqual(Object.keys(REGISTRATION_SLOTS).sort(), Object.keys(REGISTER_SAVE).sort(), "지울 칸이 있는 앱 = 등록 문이 받는 앱");
  for (const [app, save] of Object.entries(REGISTER_SAVE)) {
    const first = REGISTRATION_SLOTS[app]![0]!;
    if (save.cred) assert.deepEqual(first, { kind: save.cred, scope_key: "oauth:client" }, `${app}: 등록 문이 쓰는 칸(${save.cred}/oauth:client)`);
    else assert.deepEqual(first, { kind: "github_app", scope_key: "oauth:client" }, `${app}: GitHub App client 칸`);
  }
  ok("A1 앱마다 지우는 칸의 맨 앞 = 등록 문이 쓰는 칸");
}

// ── D. 보기·지우기 관문 ──
{
  for (const cap of [view, del]) {
    const n = cap!.name;
    assert.equal(await st(cap!.handler({ app: "notion" }, undefined as never)), 401, `D1 ${n}: 신원 없음`);
    assert.equal(await st(cap!.handler({ app: "nope" }, admin)), 400, `D2 ${n}: 모르는 앱`);
    assert.equal(await st(cap!.handler({ app: "gitlab" }, admin)), 400, `D2 ${n}: 앱 등록이 없는 앱`);
    for (const app of ["slack", "notion", "google", "linear", "outlook"]) {
      assert.equal(await st(cap!.handler({ app }, member)), 403, `D3 ${n}: ${app} 는 관리자만`);
    }
    assert.equal(await st(cap!.handler({ app: "github" }, reader)), 403, `D3 ${n}: 깃허브는 워크스페이스 관리 권한`);
    for (const app of Object.keys(REGISTER_SAVE)) {
      assert.equal(await st(withEnv({ LIVELY_TENANT_HEADER_SECRET: "t" }, () => cap!.handler({ app }, admin))), 409, `D4 ${n}: 매니지드 ${app}`);
    }
  }
  //  등록 문(덮어쓰기)도 매니지드에선 막는다 — 화면이 숨기는 것만으로 두지 않는다.
  for (const app of Object.keys(REGISTER_SAVE)) {
    assert.equal(await st(withEnv({ LIVELY_TENANT_HEADER_SECRET: "t" }, () => reg!.handler({ app, values: {} }, admin))), 409, `D4 등록 문: 매니지드 ${app}`);
  }
  //  깃허브 + 워크스페이스 관리 권한(memory)은 관문을 지난다 — 매니지드면 409 가 그 증거다(권한에서 막혔다면 403).
  assert.equal(await st(withEnv({ LIVELY_TENANT_HEADER_SECRET: "t" }, () => del!.handler({ app: "github" }, member))), 409, "D3 깃허브는 memory 로 관문을 지난다");
  ok("D1~D4 신원 401 · 모르는 앱/앱 등록 없는 앱 400 · 관리자 앱 403 · 깃허브 관리 권한 · 매니지드 409");
}
{
  assert.equal(await st(withEnv({ SLACK_OAUTH_RELAY_URL: "https://app.lvly.io/oauth/slack/start" }, () => del!.handler({ app: "slack" }, admin))), 409, "D5 릴레이 앱은 지울 것이 없다");
  assert.equal(await st(withEnv({ NOTION_OAUTH_RELAY_URL: "https://app.lvly.io/oauth/notion/start" }, () => reg!.handler({ app: "notion", values: {} }, admin))), 409, "D5 릴레이 앱은 등록할 것도 없다");
  ok("D5 릴레이 env 가 있는 앱을 지우거나 등록하면 409(DB 전)");
}
{
  //  같은 사용자 → 등록 문과 같은 권한 결과(관문 판정 하나). 등록 문은 빠진 값(400)으로, 보기·지우기는 매니지드(409)로 «권한 통과» 를 드러낸다.
  for (const [user, label] of [[member, "member"], [reader, "reader"], [admin, "admin"]] as const) {
    for (const app of Object.keys(REGISTER_SAVE)) {
      const r = await st(reg!.handler({ app, values: {} }, user));
      const v = await st(withEnv({ LIVELY_TENANT_HEADER_SECRET: "t" }, () => view!.handler({ app }, user)));
      assert.equal(r === 403, v === 403, `D6 ${label} ${app}: 등록 문 ${r} · 보기 ${v} — 권한 판정이 갈렸다`);
    }
  }
  ok("D6 등록 · 보기 · 지우기의 권한 판정이 같다");
}

// ── X 릴레이 환경변수 이름 — 지울 칸 표(RELAY_ENV)가 앱마다 준비 판정이 실제로 읽는 이름이어야 관문(릴레이 409 · 화면에 보일지)이 맞는다 ──
{
  //  X1 — 노션·구글·리니어·아웃룩·깃허브의 준비 판정은 첫 줄에서 릴레이 env 를 본다: 그 이름으로 켜면 DB 없이 참이다(이름이 틀리면 DB 로 가서 거짓·실패).
  const ready: Record<string, () => Promise<boolean>> = { notion: notionPublicReady, google: googleReady, linear: linearAppReady, outlook: microsoftReady, github: githubAppReady };
  for (const [app, fn] of Object.entries(ready)) {
    const name = RELAY_ENV[app]!;
    const got = await withEnv({ [name]: "https://relay.example.invalid/oauth/start" }, () => fn().catch(() => false));
    assert.equal(got, true, `X1 ${app}: RELAY_ENV(${name}) 로 켰는데 준비 판정이 참이 아니다 — 판정이 읽는 이름과 어긋났다`);
  }
  //  X2 — 슬랙은 연결 창구(MCP 행)를 먼저 읽어 DB 없이는 못 잰다 → 판정 함수 본문이 그 이름을 읽는지로 대신 본다.
  assert.ok(String(slackAppReady).includes(`process.env.${RELAY_ENV.slack}`), `X2 slack: 준비 판정이 RELAY_ENV.slack(${RELAY_ENV.slack}) 을 읽지 않는다`);
  ok("X1·X2 릴레이 환경변수 이름이 앱마다 준비 판정이 읽는 이름과 같다");
}

// ── E7 앱 조회가 실패한 앱은 보이지 않는다 ──
{
  const status = registry.get("org_connect_status")!;
  const r = await status.handler({}, admin) as { apps: Array<{ app: string; error?: string; can_edit_registration?: unknown }> };
  assert.ok(r.apps.length >= 6 && r.apps.every((a) => !!a.error), "배선 — DB 없는 환경이라 앱마다 조회 실패여야 한다");
  for (const a of r.apps) assert.equal(a.can_edit_registration, false, `${a.app}: 조회 실패면 false`);
  ok("E7 앱 조회가 실패한 앱은 can_edit_registration=false");
}

// ── F7 노션 워크스페이스 끊기 관문 ──
{
  assert.equal(await st(cut!.handler({ workspace_id: "w" }, undefined as never)), 401, "신원 없음");
  assert.equal(await st(cut!.handler({}, member)), 400, "workspace_id 없음");
  assert.equal(await st(cut!.handler({ workspace_id: "   " }, member)), 400, "workspace_id 공백");
  ok("F7 신원 없음 401 · workspace_id 없음/공백 400");
}

// ── H. 스킬 안내 ──
{
  for (const app of Object.keys(APP_REGISTRATIONS)) {
    const md = registrationMarkdown(app);
    assert.ok(md.includes(`org_connect_registration { app:"${app}" }`), `H1 ${app}: 보기 안내`);
    assert.ok(md.includes(`org_connect_unregister { app:"${app}" }`), `H1 ${app}: 지우기 안내`);
    assert.match(md, /impact\.remove/, `H1 ${app}: 지우기 전에 끊기는 것을 말한다`);
  }
  const notion = assembleConnectBody(CONNECT_SKILL_SPECS.find((s) => s.id === "liv-connect-notion")!);
  assert.match(notion, /`org_notion_workspace_disconnect \{ workspace_id \}`/, "H2 노션 스킬에 워크스페이스 끊기");
  assert.ok(notion.includes(`org_connect_unregister { app:"notion" }`), "H1 조립된 노션 스킬에도 등록 지우기가 들어간다");
  ok("H1·H2 앱 스킬마다 등록 보기·지우기 · 노션 스킬에 워크스페이스 끊기");
}

console.log(`\n${pass} passed`);
