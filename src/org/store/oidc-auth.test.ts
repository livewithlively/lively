// #1520 — 외부 IdP 로그인의 **진행 중 상태** 보관 계약(state/nonce/PKCE + 계정 연결 갈림길). DB 불요.
//  차단하는 회귀 3건:
//   🔴 state 를 1회용으로 태우지 않으면 인가응답 **재생**으로 같은 로그인을 반복 성립시킬 수 있다(A 표).
//   🔴 '연결 모드'를 개시 시점에 못박지 않고 콜백 파라미터로 받으면, 공격자가 그 값을 조작해
//      **남의 계정에 자기 IdP 를 붙일** 수 있다 — A2/A3 이 그 값이 저장·복원되는 경계를 고정한다.
//   🔴 연결코드 '읽기'가 소비까지 해버리면, 비밀번호 오타 한 번에 IdP 로그인을 처음부터 다시 해야 한다(B2).
//
//  실 DB 대신 **가짜 풀**을 db seam 에 꽂는다(session-mint.test.ts 와 같은 관례). 가짜의 판정은 자기 로직이
//  아니라 **도착한 SQL 에 그 조건(used_at IS NULL·expires_at > now())이 있는지**에서 파생된다 —
//  구현 SQL 에서 조건을 지우는 mutation 이 여기서 빨간불이 되게(재진술 방지).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { Db } from "../../db/client.js";
import {
  createOidcAuthRequest, consumeOidcAuthRequest, safeReturnTo,
  createOidcLink, readOidcLink, consumeOidcLink, OIDC_AUTH_TTL_MS, OIDC_LINK_TTL_MS,
} from "./oidc-auth.js";

let pass = 0;
const ok = (n: string): void => { pass++; console.log(`ok  ${n}`); };
const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

interface AuthRow {
  state_hash: string; nonce_hash: string; code_verifier: string;
  return_to: string | null; expires_at: string; used_at: string | null; link_member: string | null;
}
interface LinkRow {
  code_hash: string; sub: string; email: string; display_name: string | null;
  can_provision: boolean; expires_at: string; used_at: string | null;
}

function fakePool() {
  const auth = new Map<string, AuthRow>();
  const links = new Map<string, LinkRow>();
  const f = {
    now: Date.now(),
    auth, links,
    queries: [] as string[],
    async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
      f.queries.push(sql);
      if (sql.includes("INSERT INTO pending_oidc_auth")) {
        const [sh, nh, cv, rt, exp, lm] = params as [string, string, string, string | null, string, string | null];
        auth.set(sh, { state_hash: sh, nonce_hash: nh, code_verifier: cv, return_to: rt, expires_at: exp, used_at: null, link_member: lm });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("DELETE FROM pending_oidc_auth")) {
        let n = 0;
        for (const [k, r] of auth) if (Date.parse(r.expires_at) < f.now - 3_600_000) { auth.delete(k); n++; }
        return { rows: [], rowCount: n };
      }
      if (sql.includes("UPDATE pending_oidc_auth")) {
        const r = auth.get(String(params[0]));
        if (!r) return { rows: [], rowCount: 0 };
        // 조건은 하드코딩하지 않는다 — 구현 SQL 이 그 조건을 잃으면 가짜도 통과시켜 테스트가 빨간불이 된다.
        if (sql.includes("used_at IS NULL") && r.used_at !== null) return { rows: [], rowCount: 0 };
        if (sql.includes("expires_at > now()") && !(Date.parse(r.expires_at) > f.now)) return { rows: [], rowCount: 0 };
        if (sql.includes("SET used_at=now()")) r.used_at = new Date(f.now).toISOString();
        return {
          rows: [{ nonce_hash: r.nonce_hash, code_verifier: r.code_verifier, return_to: r.return_to, link_member: r.link_member }],
          rowCount: 1,
        };
      }
      if (sql.includes("INSERT INTO pending_oidc_link")) {
        const [ch, sub, email, dn, cp, exp] = params as [string, string, string, string | null, boolean, string];
        links.set(ch, { code_hash: ch, sub, email, display_name: dn, can_provision: cp, expires_at: exp, used_at: null });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("DELETE FROM pending_oidc_link")) {
        let n = 0;
        for (const [k, r] of links) if (Date.parse(r.expires_at) < f.now - 3_600_000) { links.delete(k); n++; }
        return { rows: [], rowCount: n };
      }
      if (sql.includes("FROM pending_oidc_link") || sql.includes("UPDATE pending_oidc_link")) {
        const r = links.get(String(params[0]));
        if (!r) return { rows: [], rowCount: 0 };
        if (sql.includes("used_at IS NULL") && r.used_at !== null) return { rows: [], rowCount: 0 };
        if (sql.includes("expires_at > now()") && !(Date.parse(r.expires_at) > f.now)) return { rows: [], rowCount: 0 };
        if (sql.includes("SET used_at=now()")) r.used_at = new Date(f.now).toISOString();
        return {
          rows: [{ sub: r.sub, email: r.email, display_name: r.display_name, can_provision: r.can_provision }],
          rowCount: 1,
        };
      }
      throw new Error("가짜 풀이 모르는 SQL: " + sql.slice(0, 70));
    },
  };
  return f;
}
const asDb = (f: ReturnType<typeof fakePool>): Db => f as unknown as Db;

// ── A: 인가요청 상태(state/nonce/PKCE/연결모드) ─────────────────────────────
{
  const f = fakePool();
  const r = await createOidcAuthRequest({ returnTo: "/ui/#/knowledge" }, asDb(f));
  const row = [...f.auth.values()][0];
  assert.equal(f.auth.size, 1);
  // 평문 미저장 — 저장된 건 해시고, 그 해시가 반환된 평문에서 나온 값이어야 한다.
  assert.equal(row.state_hash, sha256(r.state));
  assert.equal(row.nonce_hash, sha256(r.nonce));
  assert.notEqual(row.state_hash, r.state);
  assert.equal([...f.auth.keys()].some((k) => k === r.state || k === r.nonce), false, "평문이 키로 새면 안 된다");
  assert.equal(row.code_verifier, r.codeVerifier, "verifier 는 PKCE 상 원본이 있어야 교환할 수 있다");
  assert.equal(row.return_to, "/ui/#/knowledge");
  assert.ok(Date.parse(row.expires_at) > f.now && Date.parse(row.expires_at) <= f.now + OIDC_AUTH_TTL_MS + 1000);
  ok("A1 개시 — 평문은 반환만, 저장은 해시(+TTL)");
}
{
  const f = fakePool();
  const r = await createOidcAuthRequest({ linkMember: "yoon" }, asDb(f));
  assert.equal([...f.auth.values()][0].link_member, "yoon");
  const c = await consumeOidcAuthRequest(r.state, asDb(f));
  assert.equal(c?.linkMember, "yoon", "연결 대상은 개시 시점에 못박고 소비 때 그대로 돌아와야 한다");
  ok("A2 연결 대상 지정 → 저장·복원");
}
{
  const f = fakePool();
  const r = await createOidcAuthRequest({}, asDb(f));
  const c = await consumeOidcAuthRequest(r.state, asDb(f));
  assert.equal(c?.linkMember, null, "지정 안 하면 평범한 로그인");
  ok("A3 연결 대상 부재 → null(로그인 모드)");
}
{
  const f = fakePool();
  await createOidcAuthRequest({ returnTo: "https://evil.example/x" }, asDb(f));
  assert.equal([...f.auth.values()][0].return_to, null);
  const f2 = fakePool();
  await createOidcAuthRequest({ returnTo: "//evil.example" }, asDb(f2));
  assert.equal([...f2.auth.values()][0].return_to, null);
  ok("A4 외부 복귀 주소는 저장 단계에서 걸러진다");
}
{
  const f = fakePool();
  const r = await createOidcAuthRequest({}, asDb(f));
  assert.ok(await consumeOidcAuthRequest(r.state, asDb(f)));
  assert.equal(await consumeOidcAuthRequest(r.state, asDb(f)), null);
  ok("A5 state 는 1회용(재생 차단)");
}
{
  const f = fakePool();
  const r = await createOidcAuthRequest({}, asDb(f));
  f.now += OIDC_AUTH_TTL_MS + 1000;
  assert.equal(await consumeOidcAuthRequest(r.state, asDb(f)), null);
  ok("A6 만료된 state 는 소비되지 않는다");
}
{
  const f = fakePool();
  assert.equal(await consumeOidcAuthRequest("존재하지-않는-state", asDb(f)), null);
  ok("A7 없는 state 거부");
}
{
  const f = fakePool();
  assert.equal(await consumeOidcAuthRequest("x".repeat(201), asDb(f)), null);
  assert.equal(f.queries.length, 0, "형태만 보고 DB 왕복 없이 끝나야 한다(무인증 표면 스캐너 방어)");
  assert.equal(await consumeOidcAuthRequest("", asDb(f)), null);
  ok("A8 비정상 길이·빈 state 는 DB 를 건드리지 않고 거부(경계)");
}
{
  const f = fakePool();
  const r = await createOidcAuthRequest({}, asDb(f));
  f.now += OIDC_AUTH_TTL_MS + 3_600_000 + 1000;
  await consumeOidcAuthRequest(r.state, asDb(f));
  assert.equal(f.auth.size, 0, "만료 후 1시간 지난 행은 정리된다");
  ok("A9 lazy GC — 표가 무한정 자라지 않는다");
}

// ── B: 계정 갈림길(연결코드) ────────────────────────────────────────────────
const LINK = { sub: "sub-1", email: "a@honest.ai", displayName: "테스터", canProvision: true };
{
  const f = fakePool();
  const code = await createOidcLink(LINK, asDb(f));
  const row = [...f.links.values()][0];
  assert.equal(row.code_hash, sha256(code));
  assert.notEqual(row.code_hash, code);
  assert.ok(Date.parse(row.expires_at) > f.now && Date.parse(row.expires_at) <= f.now + OIDC_LINK_TTL_MS + 1000);
  ok("B1 연결코드 — 평문 미저장(해시만) + TTL");
}
{
  const f = fakePool();
  const code = await createOidcLink(LINK, asDb(f));
  const a = await readOidcLink(code, asDb(f));
  const b = await readOidcLink(code, asDb(f));
  assert.deepEqual(a, LINK);
  assert.deepEqual(b, LINK, "읽기는 소비가 아니다 — 비밀번호 오타로 IdP 로그인을 다시 시키지 않는다");
  assert.ok(await consumeOidcLink(code, asDb(f)), "읽기 뒤에도 소비는 가능해야 한다");
  ok("B2 읽기는 소비하지 않는다");
}
{
  const f = fakePool();
  const code = await createOidcLink(LINK, asDb(f));
  assert.deepEqual(await consumeOidcLink(code, asDb(f)), LINK);
  assert.equal(await consumeOidcLink(code, asDb(f)), null);
  assert.equal(await readOidcLink(code, asDb(f)), null, "소비된 코드는 읽히지도 않는다");
  ok("B3 연결코드는 1회용");
}
{
  const f = fakePool();
  const code = await createOidcLink(LINK, asDb(f));
  f.now += OIDC_LINK_TTL_MS + 1000;
  assert.equal(await readOidcLink(code, asDb(f)), null);
  assert.equal(await consumeOidcLink(code, asDb(f)), null);
  ok("B4 만료된 연결코드는 읽기·소비 모두 실패");
}
{
  const f = fakePool();
  const code = await createOidcLink({ ...LINK, canProvision: false, displayName: null }, asDb(f));
  const got = await consumeOidcLink(code, asDb(f));
  assert.equal(got?.canProvision, false, "'새로 시작' 제안 가능 여부가 뒤집히면 안 된다(자동가입 우회 차단)");
  assert.equal(got?.displayName, null);
  ok("B5 canProvision·표시이름이 그대로 복원된다");
}

// ── R: 복귀 주소 필터(오픈 리다이렉트) ─────────────────────────────────────
{
  assert.equal(safeReturnTo("/ui/#/x"), "/ui/#/x");
  assert.equal(safeReturnTo("//evil.example/x"), null);
  assert.equal(safeReturnTo("/\\evil.example"), null);
  assert.equal(safeReturnTo("https://evil.example"), null);
  assert.equal(safeReturnTo(""), null);
  assert.equal(safeReturnTo(null), null);
  ok("R same-origin 경로만 통과");
}

console.log(`oidc-auth store tests: ${pass} groups passed`);
