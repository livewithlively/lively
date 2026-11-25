// getMember 의 테넌트 고르기 PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//    npm run build && ITEMS_DATABASE_URL=… node src/org/store/get-member-tenant.pg-test.mjs
//
//  왜 이 계층인가: 고르는 규칙이 SQL 한 문장(tenant_id 조건과 정렬)에 산다. 목 풀로는 조건을 지워도 초록이다.
//  지키는 것:
//   ① 셀프호스트 다중 워크스페이스는 org_member 를 신원 전역 자리(SINGLE_TENANT_ID)에 못박는다. 둘째 워크스페이스 맥락에서도
//      그 사람이 읽혀야 한다 — 안 읽히면 그 맥락에서 배차한 위탁이 의뢰자를 비활성으로 보고 setup-token 리스 없이 떠
//      박스의 옛 로그인으로 인증에 실패한다(leaseEnvFor).
//   ② 맥락 행이 있으면 그 행이다(매니지드 모양 — 테넌트마다 자기 행이 있다).
//   ③ 맥락도 전역 자리도 아닌 테넌트의 행은 고르지 않는다.
import crypto from "node:crypto";

const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
if (!process.env.ITEMS_DATABASE_URL) { console.error("ITEMS_DATABASE_URL 이 필요하다(실 Postgres)"); process.exit(2); }
const { itemsPool, installTenantResolver, clearTenantResolver } = await import(`${DIST}/db/client.js`);
const { SINGLE_TENANT_ID } = await import(`${DIST}/db/tenant-column.js`);
const { currentTenant, withTenant } = await import(`${DIST}/org/tenant-context.js`);
const { getMember } = await import(`${DIST}/org/store/members.js`);
const { leaseEnvFor } = await import(`${DIST}/node/task-scheduler.js`);

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };

const TAG = "__getmember_tenant_pg__";
const OTHER = { id: crypto.randomUUID(), slug: "pgt-other" };    // 둘째 워크스페이스
const THIRD = crypto.randomUUID();                                // 맥락도 전역 자리도 아닌 테넌트
const inOther = (fn) => withTenant(OTHER, fn);

const put = (tenant, id, display, state = "active") => itemsPool.query(
  `INSERT INTO org_member(tenant_id, id, kind, display_name, email, state, scopes)
     VALUES($1::uuid,$2,'human',$3,$2||'@example.invalid',$4,'["items"]'::jsonb)`, [tenant, id, display, state]);
const cleanup = () => itemsPool.query(`DELETE FROM org_member WHERE left(id, length($1)) = $1`, [TAG]);

try {
  // 스키마 init 은 멱등이다 — 앞 스텝이 없어도 이 파일 혼자 돈다.
  await (await import(`${DIST}/boot/schemas.js`)).initAllSchemas({ quiet: true });
  await cleanup();
  // 셀프호스트 다중 워크스페이스(registry 모드)와 같은 배선 — 쿼리마다 app.tenant_id 를 지금 맥락으로, 맥락이 없으면 primary 로 건다.
  installTenantResolver(() => currentTenant()?.id ?? SINGLE_TENANT_ID);

  // ── ① 전역 자리에만 있는 사람이 둘째 워크스페이스 맥락에서도 읽힌다 ──────────
  const A = `${TAG}a`;
  await put(SINGLE_TENANT_ID, A, "A-global");
  const a = await inOther(() => getMember(A));
  chk("① 둘째 워크스페이스 맥락에서 전역 자리 행을 읽는다", a?.id === A, `받은 것: ${JSON.stringify(a)}`);
  chk("① 그 행의 상태가 active 다", a?.state === "active", a?.state);
  const primary = await getMember(A);
  chk("① primary 맥락에서도 같은 행이다", primary?.display_name === "A-global", primary?.display_name);

  //  증상 그대로 — 둘째 워크스페이스 맥락의 리스 판정이 active 를 보고 setup-token 을 싣는다(값 조회는 대역).
  const lookup = async (owner, kind) => (kind === "claude_setup_token" ? { secret: `tok-${owner}` } : null);
  const env = await inOther(() => leaseEnvFor({ requester: A, harness: "claude", created_by: A }, lookup));
  chk("① 둘째 워크스페이스 맥락의 위탁에 setup-token 리스가 실린다",
    typeof env?.CLAUDE_CODE_OAUTH_TOKEN === "string" && env.CLAUDE_CODE_OAUTH_TOKEN.length > 0, JSON.stringify(env));

  // ── ② 맥락 행이 있으면 그 행이다 ────────────────────────────────────────────
  const B = `${TAG}b`;
  await put(SINGLE_TENANT_ID, B, "B-global");
  await put(OTHER.id, B, "B-ctx");
  const b = await inOther(() => getMember(B));
  chk("② 맥락 행과 전역 자리 행이 둘 다 있으면 맥락 행을 고른다", b?.display_name === "B-ctx", b?.display_name);
  const bp = await getMember(B);
  chk("② primary 맥락에선 전역 자리 행이다", bp?.display_name === "B-global", bp?.display_name);

  // ── ③ 맥락도 전역 자리도 아닌 테넌트의 행은 고르지 않는다 ────────────────────
  const C = `${TAG}c`;
  await put(THIRD, C, "C-third");
  chk("③ 다른 테넌트에만 있는 행은 둘째 워크스페이스 맥락에서 안 보인다", (await inOther(() => getMember(C))) === null);
  chk("③ primary 맥락에서도 안 보인다", (await getMember(C)) === null);
} catch (e) {
  fail++; console.error("FAIL 예외 —", e);
} finally {
  clearTenantResolver();
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
