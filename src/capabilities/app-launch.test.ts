// 앱 주소 열기(org_app_launch, #4480 v2-1) — 사양 표 F. 가짜 의존으로. 실행: npm run build && node dist/capabilities/app-launch.test.js
//  이게 틀리면: 앱 토큰(앱 코드)이 다른 앱의 주소 코드를 받아 앱이 앱을 열거나, 정적·에이전트 신원이 사람 자리로 앱에 들어가거나,
//   「나만」 앱 · 꺼진 앱 · 초안이 앱 주소로 새거나, 주소 안 경로 검사가 빠져 로그인 뒤 다른 사이트로 보내게 된다.
import assert from "node:assert/strict";
import { launchAppFor, type LaunchDeps } from "./app-launch.js";
import type { LivelyUser } from "../context.js";
import type { OrgApp } from "../org/store/apps.js";
import type { MintLaunchInput } from "../apps/app-launch-store.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };

const ENV = { LIVELY_TENANT_HEADER_SECRET: "x", LIVELY_APP_DOMAIN: "lvly.app" } as NodeJS.ProcessEnv;
const T = { id: "t-1", slug: "lively-46e3" };
const STATE = "s".repeat(43);
const app = (id: string, over: Record<string, unknown> = {}): OrgApp => ({ id, title: "장표 수정", manifest: {}, status: "active", enabled: true, installed_by: "alice", ...over } as unknown as OrgApp);

function deps(over: Partial<LaunchDeps> = {}) {
  const mints: MintLaunchInput[] = [];
  const d: LaunchDeps = {
    env: ENV,
    tenant: () => T,
    getMember: async (id) => ({ alice: { id, kind: "human", state: "active" }, admin: { id, kind: "human", state: "active" }, robo: { id, kind: "agent", state: "active" }, bob: { id, kind: "human", state: "inactive" } } as Record<string, { id: string; kind: "human" | "agent"; state: "active" | "inactive" }>)[id] ?? null,
    getApp: async (id) => ({ "deck-edit": app("deck-edit"), off: app("off", { enabled: false }), failed: app("failed", { status: "failed" }), mine: app("mine", { visibility: "me", installed_by: "carol" }), empty: app("empty"), [`a${"b".repeat(31)}`]: app(`a${"b".repeat(31)}`) } as Record<string, OrgApp>)[id] ?? null,
    listUiAssets: async (id) => (id === "empty" ? [] : [{ page_key: "main" }, { page_key: "settings" }]),
    mint: async (i) => { mints.push(i); return { code: "lva_" + "c".repeat(32) }; },
    ...over,
  };
  return { d, mints };
}
const user = (over: Partial<LivelyUser> = {}): LivelyUser => ({ userId: "alice", email: "a@x", scopes: [], projects: ["*"], tokenSource: "session", ...over });
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> => {
  try { await p; return { status: 200 }; } catch (e: any) { return { status: e?.status ?? 500, code: e?.body?.code }; }
};

// ── F1 누가 — 로그인 없음 · 앱 토큰 · 정적 토큰 · 에이전트 · 비활성 · 없는 구성원 ──
{
  const { d, mints } = deps();
  assert.equal((await status(launchAppFor({ app_id: "deck-edit" }, undefined, d))).status, 401);
  assert.deepEqual(await status(launchAppFor({ app_id: "deck-edit" }, user({ appId: "other-app", tokenSource: "db" }), d)), { status: 403, code: "app_token" });
  assert.deepEqual(await status(launchAppFor({ app_id: "deck-edit" }, user({ tokenSource: "static" }), d)), { status: 403, code: "static_token" });
  for (const id of ["robo", "bob", "ghost"]) assert.deepEqual(await status(launchAppFor({ app_id: "deck-edit" }, user({ userId: id }), d)), { status: 403, code: "not_human" }, id);
  assert.equal(mints.length, 0, "거부된 자리에선 코드를 만들지 않는다");
  ok("F1 사람 본인만 — 401 · 앱 토큰 · 정적 토큰 · 에이전트 · 비활성 · 없음");
}

// ── F2 꺼짐 — 매니지드 아님 · 도메인 없음 · 테넌트 없음 ──
{
  for (const over of [{ env: { LIVELY_APP_DOMAIN: "lvly.app" } as NodeJS.ProcessEnv }, { env: { LIVELY_TENANT_HEADER_SECRET: "x" } as NodeJS.ProcessEnv }, { tenant: () => null },
    { env: { ...ENV, LIVELY_APP_DOMAIN_TENANTS: "maruru-9f0a" } as NodeJS.ProcessEnv }]) {   // 넷째 — 워크스페이스 단위 스위치 밖
    const { d, mints } = deps(over);
    assert.deepEqual(await status(launchAppFor({ app_id: "deck-edit" }, user(), d)), { status: 409, code: "app_domain_off" });
    assert.equal(mints.length, 0);
  }
  ok("F2 꺼짐 — 409 app_domain_off(넷 다 · 워크스페이스 단위 스위치 밖 포함)");
}

// ── F3 판 · 경로 · state ──
{
  const { d, mints } = deps();
  assert.deepEqual(await status(launchAppFor({ app_id: "deck-edit", variant: "draft" }, user(), d)), { status: 409, code: "draft_unavailable" });
  for (const next of ["//evil.com", "https://evil.com", "/a b"]) assert.deepEqual(await status(launchAppFor({ app_id: "deck-edit", next }, user(), d)), { status: 400, code: "bad_next" }, next);
  assert.deepEqual(await status(launchAppFor({ app_id: "deck-edit", mode: "top" }, user(), d)), { status: 400, code: "bad_state" });
  assert.deepEqual(await status(launchAppFor({ app_id: "deck-edit", mode: "top", state: "짧" }, user(), d)), { status: 400, code: "bad_state" });
  assert.equal(mints.length, 0);
  ok("F3 초안 409 · next 400 · top state 400");
}

// ── F4 앱 — 없음 · 남의 「나만」 · 꺼짐 · 실패 · 화면 없음 · 없는 화면 키 · 주소 못 만듦 ──
{
  const { d, mints } = deps();
  assert.equal((await status(launchAppFor({ app_id: "nope" }, user(), d))).status, 404);
  assert.equal((await status(launchAppFor({ app_id: "mine" }, user(), d))).status, 403);
  assert.equal((await status(launchAppFor({ app_id: "off" }, user(), d))).status, 409);
  assert.equal((await status(launchAppFor({ app_id: "failed" }, user(), d))).status, 409);
  assert.equal((await status(launchAppFor({ app_id: "empty" }, user(), d))).status, 404);
  assert.equal((await status(launchAppFor({ app_id: "deck-edit", next: "/?page=nope" }, user(), d))).status, 404);
  const longSlug = deps({ tenant: () => ({ id: "t", slug: "s" + "1".repeat(25) + "-46e3x" }) });   // 앱 32 + 1 + 슬러그 32 = 65자(63 초과)
  assert.deepEqual(await status(launchAppFor({ app_id: `a${"b".repeat(31)}` }, user(), longSlug.d)), { status: 409, code: "no_address" });
  assert.equal(mints.length + longSlug.mints.length, 0);
  ok("F4 앱 판정 — 404 · 403 · 409 · 409 · 404 · 404 · no_address");
}

// ── F5 성공 — embed · top · 관리자는 남의 「나만」 앱도 ──
{
  const { d, mints } = deps();
  const r = await launchAppFor({ app_id: "deck-edit", next: "/?page=settings&__lively_probe=1" }, user(), d) as Record<string, unknown>;
  assert.equal(r.origin, "https://deck-edit-lively-46e3.lvly.app");
  assert.equal(r.url, "https://deck-edit-lively-46e3.lvly.app/_lively/auth?code=lva_" + "c".repeat(32) + "&next=" + encodeURIComponent("/?page=settings&__lively_probe=1"));
  assert.equal(r.page_key, "settings");
  assert.equal(r.expires_in, 60);
  assert.deepEqual(mints[0], { memberId: "alice", appId: "deck-edit", variant: "pub", host: "deck-edit-lively-46e3.lvly.app", mode: "embed", state: null });
  const plain = await launchAppFor({ app_id: "deck-edit" }, user(), d) as Record<string, unknown>;
  assert.equal(plain.page_key, "main", "화면 키가 없으면 첫 화면");
  assert.ok(String(plain.url).endsWith("&next=%2F"), "next 기본 /");
  await launchAppFor({ app_id: "deck-edit", mode: "top", state: STATE, next: "/x" }, user(), d);
  assert.deepEqual(mints[2], { memberId: "alice", appId: "deck-edit", variant: "pub", host: "deck-edit-lively-46e3.lvly.app", mode: "top", state: STATE });
  const adm = await launchAppFor({ app_id: "mine" }, user({ userId: "admin", scopes: ["admin"] }), d) as Record<string, unknown>;
  assert.equal(adm.origin, "https://mine-lively-46e3.lvly.app", "관리자는 「나만」 앱도 연다");
  ok("F5 성공 — url · origin · page_key · 발급 인자 · top state · 관리자");
}

console.log(`\n${pass} passed`);
