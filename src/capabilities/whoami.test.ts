// whoami(#1072) — "지금 이 세션의 사람은 누구인가" 표면 검증. 사양: 스크래치 spec.md 엣지표 E2~E14.
//  실행: npm run build && node dist/capabilities/whoami.test.js
//  ⚠ DB 를 요구하지 않는다 — 부가 조회(멤버·팀·조직)는 실패하면 fail-open 이라, DB 없는 환경에서 돌리면
//   그 자체가 E3(조회 장애) 시나리오가 된다. DB 가 있는 환경에서도 존재하지 않는 member id 를 쓰므로 결과는 같다(E2).
//  E1(실제 멤버가 있을 때 이름·외부계정·팀이 채워지는가)만 여기서 못 본다 → 라이브 게이트웨이 실호출로 검증한다.
import assert from "node:assert/strict";
import { registry, capMutates, isReadOnlyBlocked, isToolExposed, resolveToolMeta } from "./index.js";
import { renderMeBlock } from "../org/delivery/publish.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const ta = (name: string, fn: () => Promise<void>): Promise<void> =>
  fn().then(() => { pass++; console.log(`ok  ${name}`); });

const whoami = registry.get("whoami")!;
const me = registry.get("me")!;
// 어느 DB 상태에서도 '멤버 레코드 없음'이 보장되는 principal(E2/E3 공통 경로).
const ghost = { userId: "__no_such_member_1072__", email: "ghost@example.invalid", scopes: ["memory"], projects: ["*"], tokenSource: "db" } as any;

// ── 노출 (사양 1·6·7·8) ──
t("인증만으로 호출 가능한 MCP 툴이다(scope 불요) — 사양1", () => {
  assert.ok(whoami, "registry 에 whoami 가 없다");
  assert.equal(whoami.expose.mcp, true);
  assert.equal(isToolExposed(whoami), true);
  assert.equal(whoami.scope, null);
});

t("REST 등가 GET /api/ui/me/whoami — 같은 handler(기계적 호출용)", () => {
  const rest = whoami.expose.rest;
  assert.ok(Array.isArray(rest) && rest.length === 1);
  assert.equal(rest[0].method, "GET");
  assert.deepEqual(rest[0].paths, ["/api/ui/me/whoami"]);
});

t("E6: 읽기전용 세션에서도 살아 있다(신원 조회는 write 가 아니다)", () => {
  assert.equal(capMutates(whoami), false);
  assert.equal(isReadOnlyBlocked(whoami), false);
});

t("E7: 상시로드 비트 — claude-code·미식별엔 emit, codex 엔 제거", () => {
  assert.equal(resolveToolMeta(whoami, undefined, "claude-code")?.["anthropic/alwaysLoad"], true);
  assert.equal(resolveToolMeta(whoami, undefined, null)?.["anthropic/alwaysLoad"], true);
  assert.equal(resolveToolMeta(whoami, undefined, "codex")?.["anthropic/alwaysLoad"], undefined);
});

t("E8: 웹 게이트 me 는 MCP 로 새지 않는다(avatar=base64 이미지 → 컨텍스트 폭탄)", () => {
  assert.equal(me.expose.mcp, false);
  assert.equal(isToolExposed(me), false);
});

t("E5: 대상 지정 인자가 없다 — 남의 신원을 물을 경로가 구조적으로 없다", () => {
  assert.deepEqual(Object.keys(whoami.input), []);
});

// ── 핸들러 (사양 2·4·5·9 / E2·E3·E4·E9·E10·E11) ──
await ta("E4: 미인증이면 401 — 부가 조회 전에 거부", async () => {
  await assert.rejects(
    () => whoami.handler({}, { userId: "", email: "", scopes: [], projects: [] } as any) as Promise<unknown>,
    (e: any) => e && e.status === 401,
  );
});

await ta("E2·E3: 멤버 레코드가 없거나 조회가 실패해도 '너는 누구다'는 답한다(fail-open)", async () => {
  const r = await whoami.handler({}, ghost) as any;
  assert.equal(r.member_id, ghost.userId, "principal 은 토큰 주체 그대로여야 한다");
  assert.equal(r.registered, false, "멤버 미등록이면 registered=false 로 드러나야 한다");
  assert.equal(r.display_name, null);
  assert.equal(r.email, ghost.email, "멤버 레코드가 없으면 토큰 이메일로 폴백");
  assert.deepEqual(r.teams, []);
  assert.deepEqual(r.categories, { owner: [], stakeholder: [] });
  assert.deepEqual(r.identities, []);
  assert.deepEqual(r.scopes, ["memory"], "권한은 이 요청 토큰의 실효 scope");
  assert.equal(r.is_admin, false);
});

await ta("E9: 표시용·대용량 필드(avatar·개인 규칙 본문)는 응답에 없다", async () => {
  const r = await whoami.handler({}, ghost) as any;
  const banned = ["avatar", "avatar_char", "avatar_color", "body_md"];
  const seen: string[] = [];
  const walk = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (banned.includes(k)) seen.push(k);
      walk(val);
    }
  };
  walk(r);
  assert.deepEqual(seen, [], `응답에 금지 필드가 실렸다: ${seen.join(", ")}`);
});

await ta("E10: 접속 맥락이 없으면 하네스·세션·채널은 null, 모드는 normal", async () => {
  const r = await whoami.handler({}, ghost) as any;
  assert.deepEqual(r.session, {
    harness: null, session_id: null, mode: "normal", channel: null, token_source: "db",
  });
});

await ta("E11: 모드는 ctx 에서 파생 — readonly / incognito, 동시면 incognito 우선", async () => {
  const mode = async (ctx: unknown): Promise<string> => ((await whoami.handler({}, ghost, ctx as any)) as any).session.mode;
  assert.equal(await mode({ readOnly: true }), "readonly");
  assert.equal(await mode({ incognito: true }), "incognito");
  assert.equal(await mode({ readOnly: true, incognito: true }), "incognito");
  assert.equal(await mode({}), "normal");
});

await ta("접속 맥락이 있으면 게이트웨이가 본 하네스·세션·채널이 그대로 실린다", async () => {
  const r = await whoami.handler({}, ghost, { agent: "claude-code", session: "box-x-0011aabb", source: "mcp" } as any) as any;
  assert.equal(r.session.harness, "claude-code");
  assert.equal(r.session.session_id, "box-x-0011aabb");
  assert.equal(r.session.channel, "mcp");
});

// ── 앱 세션 토큰(#1780 v2.1 R4-M1, 사양 spec-h8) — 외부 계정·팀·카테고리는 앱에게 주지 않는다 ──
await ta("앱 토큰: identities·teams·categories 는 비고 app 에 앱 id 가 실린다 / 일반 토큰은 app=null", async () => {
  const appUser = { ...ghost, appId: "browser" };
  const r = await whoami.handler({}, appUser) as any;
  assert.equal(r.app, "browser");
  assert.deepEqual(r.identities, []);
  assert.deepEqual(r.teams, []);
  assert.deepEqual(r.categories, { owner: [], stakeholder: [] });
  assert.equal(r.member_id, ghost.userId, "사람 축 식별자는 남는다(on_behalf_of 성립)");
  assert.deepEqual(r.scopes, ["memory"]);
  const p = await whoami.handler({}, ghost) as any;
  assert.equal(p.app, null);
});

// ── 주입 블록 (사양 10 / E12·E13·E14) ──
t("E12: 멤버를 특정할 수 없으면 '나' 블록은 아예 없다(정적 산출물 불변)", () => {
  assert.equal(renderMeBlock("", { display_name: "누구", email: "a@b.c" }), "");
});

t("E13: 이름·member_id·이메일 + 다음 행동 안내가 두 줄로 들어간다", () => {
  const block = renderMeBlock("yoon", { display_name: "윤상민", email: "y@lively.io" });
  assert.equal(block.split("\n").length, 2, "짧게 — 헤더 1줄 + 내용 1줄");
  assert.match(block, /^## 나 \(현재 로그인\)\n/);
  assert.ok(block.includes("윤상민"), "표시이름");
  assert.ok(block.includes("member_id `yoon`"), "조인 키가 그대로 보여야 한다");
  assert.ok(block.includes("y@lively.io"), "이메일");
  assert.ok(block.includes("project_list_v6 {mine:true}"), "내 프로젝트로 가는 다음 행동");
  assert.ok(block.includes("whoami"), "상세 신원 창구");
});

t("E14: 이름·이메일이 없거나 공백뿐이면 member_id 로 대체하고 빈 조각은 새지 않는다", () => {
  for (const member of [null, {}, { display_name: "   ", email: "  " }, { display_name: null, email: null }]) {
    const block = renderMeBlock("yoon", member as any);
    assert.ok(block.includes("**yoon**"), `이름 폴백 실패: ${JSON.stringify(member)}`);
    assert.ok(block.includes("member_id `yoon`"));
    assert.equal(block.split("\n").length, 2);
    assert.ok(!/·\s*·/.test(block) && !/·\s*—/.test(block), `빈 조각이 구분자로 새어나왔다: ${block}`);
  }
});

console.log(`\nwhoami tests: ${pass} passed`);
