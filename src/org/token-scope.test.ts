// P1: 유효 권한 = intersection(토큰 scope, 멤버 scope). 순수 함수라 DB 없이 검증.
import assert from "node:assert";
import { computeEffectiveScopes } from "./store.js";
import { isDbSourceScope, dbSourceCeilingOf } from "./store/tokens.js";
import { dbSourceAllowed } from "./store/db-source-grants.js";
import { canAccessDbSource, visibleDbSources, hasAnyDbAccess, requireNeed, type LivelyUser } from "../context.js";
import { slug } from "../http/rest-util.js";
import { parseMintScopes } from "../capabilities/delivery/tokens-devices.js";
import { needForExternalTool } from "../capabilities/permission-map.js";

// member_id 없는 서비스/레거시 토큰 → 토큰 scope 그대로(교집합 대상 없음).
assert.deepStrictEqual(
  computeEffectiveScopes({ memberId: null, memberState: null, tokenScopes: ["items", "context"], memberScopes: [] }),
  ["items", "context"],
);

// ── #1780 v2 §7-1(사양 H4) — 멤버 없는 앱 토큰은 **앱이 라이브 상한** ──
// 앱 켜짐·active → 토큰 scope 그대로.
assert.deepStrictEqual(
  computeEffectiveScopes({ memberId: null, memberState: null, tokenScopes: ["items"], memberScopes: [], appId: "bot", appLive: true }),
  ["items"],
);
// 앱 꺼짐/비active/행 없음(null) → 거부.
for (const live of [false, null, undefined] as const) {
  assert.strictEqual(
    computeEffectiveScopes({ memberId: null, memberState: null, tokenScopes: ["items"], memberScopes: [], appId: "bot", appLive: live }),
    null, `멤버 없는 앱 토큰은 appLive=${String(live)} 면 거부`,
  );
}
// 멤버 연결 앱 토큰(v1 앱 세션)은 앱 상태와 무관하게 종전 멤버 축(무회귀).
assert.deepStrictEqual(
  computeEffectiveScopes({ memberId: "jang", memberState: "active", tokenScopes: ["items", "context"], memberScopes: ["items"], appId: "browser", appLive: false }),
  ["items"],
);
// 앱도 멤버도 없는 서비스 토큰은 appLive 를 보지 않는다(무회귀).
assert.deepStrictEqual(
  computeEffectiveScopes({ memberId: null, memberState: null, tokenScopes: ["items"], memberScopes: [], appId: null, appLive: null }),
  ["items"],
);

// 활성 멤버 → 교집합(토큰이 멤버 이하).
assert.deepStrictEqual(
  computeEffectiveScopes({
    memberId: "jang", memberState: "active",
    tokenScopes: ["items", "context", "admin"], memberScopes: ["items", "context", "admin", "runtime"],
  }),
  ["items", "context", "admin"],
);

// 멤버가 admin 없음 → 토큰의 admin 탈락(멤버=라이브 상한 = 강등 즉시 반영).
assert.deepStrictEqual(
  computeEffectiveScopes({ memberId: "x", memberState: "active", tokenScopes: ["items", "admin"], memberScopes: ["items"] }),
  ["items"],
);

// 비활성 멤버 → 거부(null = 퇴사 즉시 무효).
assert.strictEqual(
  computeEffectiveScopes({ memberId: "x", memberState: "inactive", tokenScopes: ["items"], memberScopes: ["items"] }),
  null,
);

// 멤버 삭제(LEFT JOIN → state=null) but member_id 보유 → 거부.
assert.strictEqual(
  computeEffectiveScopes({ memberId: "ghost", memberState: null, tokenScopes: ["items"], memberScopes: [] }),
  null,
);

// 손상/위조 scope(비허용 값) 제거 — 양쪽 모두.
assert.deepStrictEqual(
  computeEffectiveScopes({
    memberId: "x", memberState: "active",
    tokenScopes: ["items", "bogus", "admin"], memberScopes: ["items", "admin", "bogus"],
  }),
  ["items", "admin"],
);

// ── #2174 멤버 추종(followMemberScopes) ────────────────────────────────────────
//  정책: 추종 표시가 붙은 토큰은 scope 를 발급 시점에 박제하지 않고 **멤버의 현재 권한을 그대로** 쓴다.
//   왜 필요했나 — 종전엔 강등만 즉시 반영되고 승격은 토큰 재발급을 요구했다. 그런데 세션이 쓰는 토큰은 사람이
//   들고 다니는 게 아니라 박스에 심긴 것이라, 그 재발급이 **사람 눈에 안 보이는 경로**다. 거기가 실패하면
//   관리자가 올린 권한이 영영 도달하지 않는다(2026-08-28 실측 — 격리 박스에서 토큰 파일만 안 갱신됨).
//  아래 행들은 사양 엣지 표와 1:1 이다. 지켜야 할 불변식은 "멤버가 상한" 과 "내리는 방향은 종전 그대로".

// [1] 승격이 재발급 없이 닿는다 — 이 변경의 목적. 발급 당시엔 admin 이 없던 토큰이다.
assert.deepStrictEqual(
  computeEffectiveScopes({
    memberId: "yoon", memberState: "active",
    tokenScopes: ["items", "context"], memberScopes: ["items", "context", "admin", "runtime"],
    followMemberScopes: true,
  }),
  ["items", "context", "admin", "runtime"],
);

// [2] 멤버가 상한이다 — 추종이어도 멤버에게 없는 권한은 나오지 않는다(증폭 불가).
assert.deepStrictEqual(
  computeEffectiveScopes({
    memberId: "yoon", memberState: "active",
    tokenScopes: ["items", "admin"], memberScopes: ["items"],
    followMemberScopes: true,
  }),
  ["items"],
);

// [3] 내리는 방향은 종전 그대로 즉시 — 이 행이 회귀하면 강등이 안 먹는 보안 사고다.
assert.deepStrictEqual(
  computeEffectiveScopes({
    memberId: "yoon", memberState: "active",
    tokenScopes: ["items", "context", "admin"], memberScopes: ["items"],
    followMemberScopes: true,
  }),
  ["items"],
);

// [4][5] 비활성·삭제 멤버는 추종이어도 거부(멤버 축이 죽으면 토큰도 죽는다).
for (const state of ["inactive", null] as const) {
  assert.strictEqual(
    computeEffectiveScopes({
      memberId: "gone", memberState: state, tokenScopes: ["items"], memberScopes: ["items", "admin"],
      followMemberScopes: true,
    }),
    null, `추종 토큰도 memberState=${String(state)} 면 거부해야 한다`,
  );
}

// [6] ★ member_id 가 없으면 따라갈 대상이 없다 → 토큰 scope 그대로(서비스/레거시 토큰 무회귀).
//  이 행이 없으면, 플래그가 잘못 켜진 서비스 토큰이 빈 멤버 scope 를 따라가 **조용히 권한 0** 이 된다
//  (거부도 아니고 오류도 아닌 '아무것도 못 하는 토큰' — 원인 찾기가 가장 어려운 형태다).
assert.deepStrictEqual(
  computeEffectiveScopes({
    memberId: null, memberState: null, tokenScopes: ["items", "context"], memberScopes: [],
    followMemberScopes: true,
  }),
  ["items", "context"],
);

// [7] ★ 멤버 없는 앱 토큰은 **앱이 상한**이다 — 추종 플래그가 그 규칙을 앞지르지 않는다.
assert.deepStrictEqual(
  computeEffectiveScopes({
    memberId: null, memberState: null, tokenScopes: ["items"], memberScopes: [],
    appId: "bot", appLive: true, followMemberScopes: true,
  }),
  ["items"],
);
for (const live of [false, null] as const) {
  assert.strictEqual(
    computeEffectiveScopes({
      memberId: null, memberState: null, tokenScopes: ["items"], memberScopes: [],
      appId: "bot", appLive: live, followMemberScopes: true,
    }),
    null, `추종 플래그가 켜져도 appLive=${String(live)} 면 거부해야 한다`,
  );
}

// [8] 경계값 — 박제된 scope 가 **비어 있어도** 추종이면 멤버 전체가 나온다.
//  (교집합이었다면 빈 배열이다. 이 행이 곧 '박제를 안 본다'의 직접 증거다.)
assert.deepStrictEqual(
  computeEffectiveScopes({
    memberId: "yoon", memberState: "active",
    tokenScopes: [], memberScopes: ["items", "admin"],
    followMemberScopes: true,
  }),
  ["items", "admin"],
);

// [9] 추종이 아닌 토큰(플래그 없음/false)은 종전 교집합 그대로 — 무회귀.
for (const flag of [undefined, false] as const) {
  assert.deepStrictEqual(
    computeEffectiveScopes({
      memberId: "yoon", memberState: "active",
      tokenScopes: ["items", "admin"], memberScopes: ["items", "admin", "runtime"],
      followMemberScopes: flag,
    }),
    ["items", "admin"], `followMemberScopes=${String(flag)} 는 종전 교집합이어야 한다`,
  );
}

// [10] 허용되지 않은 값(JSONB 손상·마이그레이션·위조)은 추종 경로에서도 떨군다.
assert.deepStrictEqual(
  computeEffectiveScopes({
    memberId: "x", memberState: "active",
    tokenScopes: [], memberScopes: ["items", "bogus", "admin"],
    followMemberScopes: true,
  }),
  ["items", "admin"],
);

// ── 소스 한정 DB scope 'db:<source>' ──
//  멤버 scope 는 'db' 까지만 받는다 — 토큰의 'db:<source>' 는 멤버 'db' 아래에서만 산다.
type Case = { name: string; memberId: string | null; tokenScopes: string[]; memberScopes: string[]; follow?: boolean; want: string[] };
const dbSourceCases: Case[] = [
  { name: "(a) 멤버 db + 토큰 db:x → db:x", memberId: "m", tokenScopes: ["db:x"], memberScopes: ["items", "db"], want: ["db:x"] },
  { name: "(b) 멤버 db 없음 + 토큰 db:x → 버림", memberId: "m", tokenScopes: ["db:x"], memberScopes: ["items"], want: [] },
  { name: "(c) 규칙 위반 이름은 멤버 db 가 있어도 버림", memberId: "m",
    tokenScopes: ["db:a b", "db:", "db:x;y", "db:../x", "db: x", "db:x\n", `db:${"a".repeat(101)}`], memberScopes: ["db"], want: [] },
  { name: "(d) 멤버 없는 토큰 db:x → db:x, 규칙 위반 이름은 여기서도 버림", memberId: null, tokenScopes: ["items", "db:x", "db:a b"], memberScopes: [], want: ["items", "db:x"] },
  { name: "(e) 토큰 db + db:x 를 함께 → 둘 다", memberId: "m", tokenScopes: ["db", "db:x"], memberScopes: ["db"], want: ["db", "db:x"] },
  { name: "(f) 추종 토큰은 박제(db:x)를 안 보고 멤버 그대로", memberId: "m", tokenScopes: ["db:x"], memberScopes: ["items", "db"], follow: true, want: ["items", "db"] },
  { name: "(g) 추종 토큰 — 멤버 쪽 db:x(위조)는 떨군다", memberId: "m", tokenScopes: [], memberScopes: ["items", "db:x"], follow: true, want: ["items"] },
];
for (const c of dbSourceCases) {
  assert.deepStrictEqual(
    computeEffectiveScopes({
      memberId: c.memberId, memberState: c.memberId ? "active" : null,
      tokenScopes: c.tokenScopes, memberScopes: c.memberScopes, followMemberScopes: c.follow,
    }),
    c.want, c.name,
  );
}
// 멤버 없는 앱 토큰 — 켜져 있으면 db:x 도 통과(꺼진 앱의 거부는 위 appLive 표가 덮는다).
assert.deepStrictEqual(
  computeEffectiveScopes({ memberId: null, memberState: null, tokenScopes: ["db:x"], memberScopes: [], appId: "bot", appLive: true }),
  ["db:x"],
);

// 이름 규칙은 DB 소스 등록(org_db_source_upsert 의 slug)과 같아야 한다 — 복제한 정규식의 대조 표.
const accepts = (name: string): boolean => { try { return slug(name, "name") === name; } catch { return false; } };
for (const name of ["x", "Prod_DB", "dw-01", "운영", "a".repeat(100), "a".repeat(101), "", "a b", "x;y", "../x", "x.y", "x:y", "x\n"]) {
  assert.strictEqual(isDbSourceScope(`db:${name}`), accepts(name), `db:${JSON.stringify(name)} 판정이 소스 등록 규칙과 다르다`);
}

// 끝까지 — 유효 권한 → DB 소스 접근 판정. db:x 토큰은 x 만 연다.
{
  const scopes = computeEffectiveScopes({ memberId: "m", memberState: "active", tokenScopes: ["db:x"], memberScopes: ["db"] });
  assert.ok(scopes);
  const u: LivelyUser = { userId: "m", email: "", scopes, projects: ["*"] };
  assert.strictEqual(canAccessDbSource(u, "x"), true);
  assert.strictEqual(canAccessDbSource(u, "y"), false);
  // db_sources 목록 — 좁힌 토큰은 그 소스만, db 전체는 전부, admin 은 db 없이도 self 를 포함해 전부 본다.
  const srcs = [{ name: "x" }, { name: "y" }, { name: "self" }];
  const names = (scopes: string[]): string[] => visibleDbSources({ ...u, scopes }, srcs).map((s) => s.name);
  assert.deepStrictEqual(names(u.scopes), ["x"], "소스 하나로 좁힌 토큰이 db_sources 로 다른 소스까지 열거한다");
  assert.deepStrictEqual(names(["db"]), ["x", "y", "self"]);
  assert.deepStrictEqual(names(["admin"]), ["x", "y", "self"]);
}

// 발급 입력 검증(org_token_mint) — db:<source> 는 받고 이름 규칙 위반은 400.
assert.deepStrictEqual(parseMintScopes(["items", "db:x"]), ["items", "db:x"]);
assert.throws(() => parseMintScopes(["db:a b"]), (e: unknown) => (e as { status?: number }).status === 400 && /허용되지 않은 scope/.test(String((e as Error).message)));

console.log("token-scope.test ok");

// ── #5712 비위험 권한 추종(followSafeScopes) ───────────────────────────────────
//  정책: 사람이 자기 컴퓨터를 연결해 받은 로그인 토큰(lively login · 데스크톱 앱 · 설치 탭 본인 발급)은
//   위험 scope(admin · runtime)를 뺀 나머지에서 **멤버의 지금 권한**을 따른다. 위험 scope 는 토큰에 실린 것만.
//   왜 필요했나 — 관리자가 구성원 권한을 올려도 그 사람 컴퓨터의 토큰은 발급 때 권한에 묶여 있어 다시 로그인해야 했다.
//  아래 행들은 사양 엣지 표와 1:1 이다.
{
  const safe = (o: { tokenScopes: string[]; memberScopes: string[]; memberId?: string | null; memberState?: string | null; followMemberScopes?: boolean; appId?: string | null; appLive?: boolean | null }) =>
    computeEffectiveScopes({ memberId: "kim", memberState: "active", ...o, followSafeScopes: true });

  // [S1] 올린 비위험 권한이 재발급 없이 닿는다 — 이 변경의 목적. 발급 때는 db · code 가 없었다.
  assert.deepStrictEqual(safe({ tokenScopes: ["items", "context"], memberScopes: ["items", "context", "db", "code"] }),
    ["items", "context", "db", "code"], "S1 올린 비위험 권한");

  // [S2] 내린 권한은 종전 그대로 곧바로 빠진다.
  assert.deepStrictEqual(safe({ tokenScopes: ["items", "context", "memory"], memberScopes: ["items"] }), ["items"], "S2 내린 권한");

  // [S3] ★ 위험 scope 는 따르지 않는다 — «관리자 기능 허용» 을 켜지 않고 받은 토큰은 관리자로 승격돼도 관리자 기능이 없다.
  assert.deepStrictEqual(safe({ tokenScopes: ["items", "context"], memberScopes: ["items", "context", "admin", "runtime"] }),
    ["items", "context"], "S3 승격된 admin · runtime 은 안 실린다");

  // [S4] 토큰에 실린 위험 scope 는 멤버가 지금도 가질 때 유효하다(켜고 받은 토큰).
  assert.deepStrictEqual(safe({ tokenScopes: ["items", "admin"], memberScopes: ["items", "context", "admin"] }),
    ["items", "context", "admin"], "S4 실린 admin 유지 + 비위험은 멤버 그대로");

  // [S5] 실린 위험 scope 라도 멤버가 잃으면 빠진다(강등 즉시).
  assert.deepStrictEqual(safe({ tokenScopes: ["items", "admin"], memberScopes: ["items", "context"] }), ["items", "context"], "S5 강등");

  // [S6] 위험 scope 는 scope 마다 따로 본다 — admin 만 실은 토큰은 멤버가 runtime 을 얻어도 runtime 이 없다.
  assert.deepStrictEqual(safe({ tokenScopes: ["items", "admin"], memberScopes: ["items", "admin", "runtime"] }),
    ["items", "admin"], "S6 runtime 은 실리지 않았다");

  // [S7] 발급 때 비위험 권한이 하나도 없던 토큰도 멤버가 얻으면 따른다(토큰 scope 는 기록일 뿐이다).
  assert.deepStrictEqual(safe({ tokenScopes: [], memberScopes: ["items", "context"] }), ["items", "context"], "S7 빈 기록");

  // [S8][S9] 비활성 · 삭제 멤버는 거부.
  for (const state of ["inactive", null] as const) {
    assert.strictEqual(safe({ tokenScopes: ["items"], memberScopes: ["items"], memberState: state }), null, `S8/S9 memberState=${String(state)} 면 거부`);
  }

  // [S10] member_id 가 없으면 따를 대상이 없다 → 토큰 scope 그대로(잘못 켜진 서비스 토큰이 권한 0 이 되지 않는다).
  assert.deepStrictEqual(safe({ tokenScopes: ["items", "context"], memberScopes: [], memberId: null, memberState: null }),
    ["items", "context"], "S10 멤버 없는 토큰");

  // [S11] 멤버 없는 앱 토큰은 앱이 상한이다 — 이 표시가 그 규칙을 앞지르지 않는다.
  assert.deepStrictEqual(safe({ tokenScopes: ["items"], memberScopes: [], memberId: null, memberState: null, appId: "bot", appLive: true }), ["items"], "S11 앱 켜짐");
  assert.strictEqual(safe({ tokenScopes: ["items"], memberScopes: [], memberId: null, memberState: null, appId: "bot", appLive: false }), null, "S11 앱 꺼짐");

  // [S12] 전부 추종(followMemberScopes)이 같이 켜져 있으면 그쪽이 이긴다(세션 · 박스 토큰 — 위험 scope 도 멤버 그대로).
  assert.deepStrictEqual(safe({ tokenScopes: ["items"], memberScopes: ["items", "admin"], followMemberScopes: true }), ["items", "admin"], "S12 전부 추종 우선");

  // [S13] 손상된 scope 값은 여전히 걸러진다(B4) — 멤버 쪽에 든 알 수 없는 값이 나오지 않는다.
  assert.deepStrictEqual(safe({ tokenScopes: ["items", "root"], memberScopes: ["items", "root", "db"] }), ["items", "db"], "S13 알 수 없는 scope");

  // [S14] 표시가 꺼진 토큰은 종전 그대로 교집합이다(무회귀) — 올린 권한이 닿지 않는다.
  assert.deepStrictEqual(
    computeEffectiveScopes({ memberId: "kim", memberState: "active", tokenScopes: ["items", "context"], memberScopes: ["items", "context", "db"] }),
    ["items", "context"], "S14 표시 없는 토큰");
}
console.log("token-scope: followSafeScopes 14 rows passed");

// ── 역할을 받은 구성원(grants)의 소스 한정 토큰 — 'db:<source>' 가 새 권한 'db' 로 번역돼도 그 소스만 연다 ──
{
  assert.deepStrictEqual(dbSourceCeilingOf(["items", "db:x"]), ["x"]);
  assert.deepStrictEqual(dbSourceCeilingOf(["db:x", "db:y"]), ["x", "y"]);
  assert.strictEqual(dbSourceCeilingOf(["db", "db:x"]), null, "db 전체가 함께 있으면 상한이 없다");
  assert.strictEqual(dbSourceCeilingOf(["items", "memory"]), null);
  assert.deepStrictEqual(dbSourceCeilingOf(["db:bad name!"]), [], "이름 규칙 위반만 실린 손상 행은 빈 상한(닫힌 쪽)");
  const roleUser: LivelyUser = { userId: "m", email: "", scopes: ["db:x"], projects: ["*"], grants: { db: "read" }, dbSourceCeiling: ["x"] };
  const srcs = [{ name: "x" }, { name: "y" }, { name: "self" }];
  assert.deepStrictEqual(visibleDbSources(roleUser, srcs).map((s) => s.name), ["x", "self"], "역할 구성원의 좁힌 토큰이 다른 소스를 열거한다");
  assert.deepStrictEqual(visibleDbSources({ ...roleUser, dbSourceCeiling: undefined }, srcs).map((s) => s.name), ["x", "y", "self"]);
  //  상한 밖 소스는 지정 조회(DB) 전에 거절한다 — 그 사람이 y 에 지정돼 있어도 이 토큰으로는 못 연다.
  assert.strictEqual(await dbSourceAllowed(roleUser, "y"), false, "역할 구성원의 좁힌 토큰이 상한 밖 소스를 연다");
  //  손상 행의 빈 상한([])은 닫힌 쪽이다 — 상한 밖은 전부 거절, 목록엔 self 만.
  const brokenUser: LivelyUser = { ...roleUser, dbSourceCeiling: [] };
  assert.deepStrictEqual(visibleDbSources(brokenUser, srcs).map((s) => s.name), ["self"], "빈 상한이 소스를 연다");
  assert.strictEqual(await dbSourceAllowed(brokenUser, "x"), false, "빈 상한이 소스를 연다");
}
console.log("token-scope: role-member db source ceiling passed");

// ── 소스 한정 토큰은 «DB 전체» 를 묻는 판정을 통과하지 못한다 — 외부 앱 도구(http_proxy · MCP 프록시)의 호출 scope 'db' ──
//  옛 주체는 'db:x' 가 'db' 가 아니라 이미 막힌다. 역할 주체는 번역(legacyScopesToGrants)이 'db:x' 를 권한 db 로 바꾸므로 따로 막아야
//  같은 답이 된다. 소스는 dbSourceAllowed 가 하나씩 열고, db_sources 목록(hasAnyDbAccess)은 그대로 열린다(상한 안의 소스만 싣는다).
{
  const ext = needForExternalTool("db", "L0");
  const roleUser: LivelyUser = { userId: "m", email: "", scopes: ["db:x"], projects: ["*"], grants: { db: "read" }, dbSourceCeiling: ["x"] };
  const legacyUser: LivelyUser = { userId: "m", email: "", scopes: ["db:x"], projects: ["*"], dbSourceCeiling: ["x"] };
  assert.throws(() => requireNeed(roleUser, ext, "db"), /Forbidden/, "역할 구성원의 소스 한정 토큰이 호출 scope 'db' 인 외부 도구를 부른다");
  assert.throws(() => requireNeed({ ...roleUser, dbSourceCeiling: [] }, ext, "db"), /Forbidden/, "빈 상한(손상 행)이 호출 scope 'db' 인 외부 도구를 부른다");
  assert.throws(() => requireNeed(legacyUser, ext, "db"), /Forbidden/, "옛 주체의 소스 한정 토큰이 호출 scope 'db' 인 외부 도구를 부른다");
  //  무회귀 — 상한 없는 주체(역할 · 옛)는 종전 그대로 통과한다.
  assert.doesNotThrow(() => requireNeed({ ...roleUser, dbSourceCeiling: undefined }, ext, "db"));
  assert.doesNotThrow(() => requireNeed({ userId: "m", email: "", scopes: ["db"], projects: ["*"] }, ext, "db"));
  //  db_sources 목록은 소스 한정 토큰에도 열린다(목록은 visibleDbSources 가 상한으로 거른다).
  assert.strictEqual(hasAnyDbAccess(roleUser), true, "역할 구성원의 소스 한정 토큰이 db_sources 목록을 못 연다");
  assert.strictEqual(hasAnyDbAccess(legacyUser), true);
  assert.strictEqual(hasAnyDbAccess({ ...roleUser, grants: { content: "read" } }), false, "DB 권한 없는 역할 주체가 db_sources 목록을 연다");
}
console.log("token-scope: source-limited token vs whole-db checks passed");
