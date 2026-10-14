// 앱 주소 앞단의 기계 엔드포인트(#4480 v2-1) — 사양 표 E. 가짜 의존으로. 실행: npm run build && node dist/apps/app-front-routes.test.js
//  이게 틀리면: 꺼진 배포에서 경로가 열리거나(404 아님), 서명 없이 아무 신원으로 앱 문서·신원을 받거나, 빠진 사람·「나만」 앱이 앱 주소로는
//   계속 열리거나, 탐침이 아무 앱에나 들어가거나, 교환이 앱 도메인 밖 주소에 대해 코드를 소비한다.
import assert from "node:assert/strict";
import { signAppFront } from "./app-front-auth.js";
import { appFrontMe, appFrontPage, appFrontRedeem, memberDisplayName, type AppFrontDeps } from "./app-front-routes.js";
import type { OrgMember } from "../org/store/members.js";
import type { OrgApp } from "../org/store/apps.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };

const SECRET = "s3cret";
const T = { id: "11111111-1111-1111-1111-111111111111", slug: "lively-46e3" };
const ENV = { LIVELY_TENANT_HEADER_SECRET: SECRET, LIVELY_APP_DOMAIN: "lvly.app" } as NodeJS.ProcessEnv;
const now = (): number => Math.floor(Date.now() / 1000);
const actH = (over: Record<string, unknown> = {}) => ({ "x-lvly-app-front": signAppFront(SECRET, { op: "act", t: T.id, ws: T.slug, app: "deck-edit", var: "pub", mid: "alice", iat: now(), ...over } as never) });
const redeemH = () => ({ "x-lvly-app-front": signAppFront(SECRET, { op: "redeem", t: T.id, ws: T.slug, iat: now() }) });

const member = (id: string, over: Partial<OrgMember> = {}): OrgMember => ({
  id, kind: "human", display_name: id.toUpperCase(), nickname: null, use_nickname: false, email: `${id}@x.io`, identities: [], body_md: "",
  avatar: null, avatar_char: null, avatar_color: null, state: "active", scopes: [], sort: 0, version: 1, updated_at: null, updated_by: null, ...over,
});
const app = (id: string, over: Partial<OrgApp> & { visibility?: string } = {}): OrgApp => ({
  id, title: "장표", version: "1", manifest: { csp: { connect_domains: ["api.example.com"] } }, source: {}, content_hash: null, status: "active", enabled: true,
  installed_by: "alice", installed_at: "", updated_at: "", updated_by: null, ...over,
} as unknown as OrgApp);

function deps(over: Partial<AppFrontDeps> = {}) {
  const calls = { redeem: [] as unknown[], scripts: 0 };
  const members: Record<string, OrgMember> = {
    alice: member("alice"), bob: member("bob", { state: "inactive" }), robo: member("robo", { kind: "agent" }),
    nick: member("nick", { nickname: "닉", use_nickname: true }),
  };
  const apps: Record<string, OrgApp> = { "deck-edit": app("deck-edit"), off: app("off", { enabled: false }), mine: app("mine", { visibility: "me", installed_by: "carol" }) };
  const pages: Record<string, Array<{ page_key: string; html: string }>> = {
    "deck-edit": [{ page_key: "main", html: "<!doctype html><p>main</p>" }, { page_key: "settings", html: "<p>settings</p>" }],
    off: [{ page_key: "main", html: "<p/>" }], mine: [{ page_key: "main", html: "<p/>" }],
  };
  const d: AppFrontDeps = {
    env: ENV,
    tenant: () => T,
    getMember: async (id) => members[id] ?? null,
    getApp: async (id) => apps[id] ?? null,
    listUiAssets: async (id) => pages[id] ?? [],
    getUiAsset: async (id, key) => (pages[id] ?? []).find((p) => p.page_key === key) ?? null,
    redeem: async (i) => { calls.redeem.push(i); return i.code === "good" ? { memberId: "nick", appId: "deck-edit", variant: "pub", mode: "embed" } : null; },
    scripts: async () => { calls.scripts++; return { runtime: "window.lively={}", probe: "PROBE()" }; },
    ...over,
  };
  return { d, calls };
}

// ── E1 꺼짐 → 404(세 길 모두) · 서명 틀림 → 401 ──
{
  //  셋째 — 워크스페이스 단위 스위치(LIVELY_APP_DOMAIN_TENANTS) 밖: 서명이 맞아도 경로가 없는 것과 같다.
  for (const env of [{ LIVELY_APP_DOMAIN: "lvly.app" }, { LIVELY_TENANT_HEADER_SECRET: SECRET }, { ...ENV, LIVELY_APP_DOMAIN_TENANTS: "maruru-9f0a" }] as NodeJS.ProcessEnv[]) {
    const { d } = deps({ env });
    assert.equal((await appFrontMe(actH(), d)).status, 404);
    assert.equal((await appFrontPage(actH(), "/", d)).status, 404);
    assert.equal((await appFrontRedeem(redeemH(), { code: "good", host: "deck-edit-lively-46e3.lvly.app" }, d)).status, 404);
  }
  const { d, calls } = deps();
  assert.equal((await appFrontMe({}, d)).status, 401, "헤더 없음");
  assert.equal((await appFrontMe({ "x-lvly-app-front": signAppFront("other", { op: "act", t: T.id, ws: T.slug, app: "deck-edit", var: "pub", mid: "alice", iat: now() }) }, d)).status, 401, "다른 비밀");
  assert.equal((await appFrontMe(redeemH(), d)).status, 401, "redeem 서명을 act 자리에");
  assert.equal((await appFrontRedeem(actH(), { code: "good", host: "deck-edit-lively-46e3.lvly.app" }, d)).status, 401, "act 서명을 redeem 자리에");
  const page401 = await appFrontPage({}, "/", d);
  assert.equal(page401.status, 401);
  assert.ok(page401.html && !page401.json, "page 의 오류는 문서로");
  assert.equal(calls.redeem.length, 0, "문을 못 지나면 교환을 부르지 않는다");
  ok("E1 꺼짐 404 · 서명 틀림 401(교환 안 부름)");
}

// ── E2 redeem — 도메인 밖 주소는 교환 안 부름 · 실패 404 · 성공 모양 · 이름 규칙 ──
{
  const { d, calls } = deps();
  const r0 = await appFrontRedeem(redeemH(), { code: "good", host: "deck-edit-lively-46e3.evil.app" }, d);
  assert.equal(r0.status, 404);
  assert.equal(calls.redeem.length, 0, "앱 도메인 밖이면 교환을 부르지 않는다");
  const r1 = await appFrontRedeem(redeemH(), { code: "bad", host: "deck-edit-lively-46e3.lvly.app", dest: "iframe", state: "" }, d);
  assert.deepEqual([r1.status, r1.json], [404, { error: "invalid_code" }]);
  const r2 = await appFrontRedeem(redeemH(), { code: "good", host: "DECK-EDIT-lively-46e3.lvly.app", dest: "iframe", state: "st" }, d);
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.json, { member_id: "nick", name: "닉", app_id: "deck-edit", variant: "pub", mode: "embed" });
  assert.deepEqual(calls.redeem[1], { code: "good", host: "deck-edit-lively-46e3.lvly.app", dest: "iframe", state: "st" }, "주소는 소문자로 · dest · state 를 그대로 넘긴다");
  ok("E2 redeem — 도메인 밖 · 실패 · 성공 모양");
}
{
  assert.equal(memberDisplayName(member("a", { display_name: "가", nickname: "나", use_nickname: false })), "가");
  assert.equal(memberDisplayName(member("a", { display_name: "가", nickname: "나", use_nickname: true })), "나");
  assert.equal(memberDisplayName(member("a", { display_name: "가", nickname: "  ", use_nickname: true })), "가", "빈 닉네임이면 표시 이름");
  assert.equal(memberDisplayName(member("a", { display_name: null, nickname: null })), "a", "둘 다 없으면 id");
  ok("E3 이름 규칙 — 닉네임 켬 · 빈 닉네임 · id 폴백");
}

// ── E4 me — 구성원 · 앱 · 공개 범위 · 성공 모양 ──
{
  const { d } = deps();
  assert.equal((await appFrontMe(actH({ mid: "bob" }), d)).status, 403, "비활성");
  assert.equal((await appFrontMe(actH({ mid: "robo" }), d)).status, 403, "에이전트");
  assert.equal((await appFrontMe(actH({ mid: "ghost" }), d)).status, 403, "없는 구성원");
  assert.equal((await appFrontMe(actH({ app: "nope" }), d)).status, 404, "없는 앱");
  assert.equal((await appFrontMe(actH({ app: "mine" }), d)).status, 404, "남의 「나만」 앱 — 없는 앱과 같다(#4667)");
  const r = await appFrontMe(actH({ var: "draft" }), d);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { member: { id: "alice", name: "ALICE", email: "alice@x.io" }, workspace: { slug: "lively-46e3" }, app: { id: "deck-edit", variant: "draft" }, session: null });
  ok("E4 me — 403·404·404 · 성공 모양(판 그대로 · 세션 null)");
}

// ── E5 page — 꺼진 앱 · 경로 · 화면 키 · 탐침 · CSP · 준비물 없음 ──
{
  const { d, calls } = deps();
  assert.equal((await appFrontPage(actH({ app: "off" }), "/", d)).status, 409, "꺼진 앱");
  assert.equal((await appFrontPage(actH({ app: "mine" }), "/", d)).status, 404, "남의 「나만」 앱 — 없는 앱과 같다(#4667)");
  assert.equal((await appFrontPage(actH(), "/x", d)).status, 404, "맨 앞이 아닌 경로");
  assert.equal((await appFrontPage(actH(), "//evil", d)).status, 404, "틀린 경로");
  assert.equal((await appFrontPage(actH(), "/?page=nope", d)).status, 404, "없는 화면 키");
  assert.equal(calls.scripts, 0, "오류 길에선 준비물을 읽지 않는다");
  const first = await appFrontPage(actH(), "/", d);
  assert.equal(first.status, 200);
  assert.ok(first.html!.startsWith("<!doctype html><script>window.lively={}</script><p>main</p>"), "첫 화면 + 런타임");
  assert.ok(!first.html!.includes("PROBE"), "쿼리 없으면 탐침 없음");
  assert.ok(/connect-src 'self' https:\/\/api\.example\.com/.test(first.headers!["Content-Security-Policy"]), "CSP 헤더 — 같은 주소 + 선언");
  const s = await appFrontPage(actH(), "/?page=settings&__lively_probe=1", d);
  assert.equal(s.status, 200);
  assert.equal(s.html, "<script>window.lively={}</script><script>PROBE()</script><p>settings</p>", "화면 키 · 탐침");
  const noScripts = deps({ scripts: async () => { throw new Error("없음"); } });
  const e = await appFrontPage(actH(), "/", noScripts.d);
  assert.equal(e.status, 503);
  assert.ok(e.html && e.html.includes("<b>"), "503 도 문서로");
  ok("E5 page — 409·404·404·404·404 · 첫 화면 · 화면 키 · 탐침 · CSP · 503");
}

// ── E6 page — #4667 남의 초안이 걸린 공개 앱: 공개 판을 보는 사람은 판 행의 화면 · CSP, 초안을 만든 사람은 설치된 화면 ──
{
  const drafted = app("deck-edit", { visibility: "all", draft_by: "carol", published_version_no: 3, manifest: { csp: { connect_domains: ["draft.example.com"] } } } as never);
  const pubManifest = { id: "deck-edit", title: "장표", version: "1", ui: { pages: [{ key: "main", title: "장표", entry: "ui/index.html" }] }, csp: { connect_domains: ["pub.example.com"] } };
  const asked: Array<[string, number]> = [];
  const { d } = deps({
    getApp: async (id) => (id === "deck-edit" ? drafted : null),
    getMember: async (id) => member(id),
    getAppVersion: async (id, no) => { asked.push([id, no]); return { manifest: pubManifest, files: [{ path: "lively-app.json", content: JSON.stringify(pubManifest) }, { path: "ui/index.html", content: "<p>공개 판</p>" }] }; },
  });
  const pub = await appFrontPage(actH({ mid: "alice" }), "/", d);
  assert.equal(pub.status, 200);
  assert.ok(pub.html!.includes("<p>공개 판</p>") && !pub.html!.includes("<p>main</p>"), "공개 판의 화면");
  assert.ok(/pub\.example\.com/.test(pub.headers!["Content-Security-Policy"]) && !/draft\.example\.com/.test(pub.headers!["Content-Security-Policy"]), "공개 판의 CSP");
  assert.deepEqual(asked, [["deck-edit", 3]], "공개 판 번호의 판 행을 읽는다");
  assert.equal((await appFrontPage(actH({ mid: "alice" }), "/?page=nope", d)).status, 404, "공개 판에 없는 화면 키");
  const own = await appFrontPage(actH({ mid: "carol" }), "/", d);
  assert.ok(own.status === 200 && own.html!.includes("<p>main</p>"), "초안을 만든 사람은 설치된 화면");
  ok("E6 page — 남의 초안이 걸린 공개 앱은 공개 판의 화면 · CSP(#4667) · 초안 주인은 설치된 화면");
}

console.log(`\n${pass} passed`);
