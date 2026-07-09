// 커넥터 통합(P1·P2·P3 결선, #746) — http_proxy 툴의 vault 인증/등급/PII스크럽 필드 store 왕복 + 해소 합성.
//  runHttpProxyTool 의 네트워크 경로(safeFetch)는 SSRF 가드가 localhost 를 막아 E2E 불가 → 여기선 DB 계층(스키마·store·해소)만.
// 실행: npm run build && CONNECTOR_SECRET_KEY=$(openssl rand -hex 32) \
//        ITEMS_DATABASE_URL='postgresql://postgres@localhost/conn_test?host=/tmp/pgXXX&port=54329' \
//        node scripts/integration/connector-proxy-pg.mjs
import { fileURLToPath } from "node:url";
import path from "node:path";

if (!process.env.ITEMS_DATABASE_URL) { console.error("ITEMS_DATABASE_URL 미설정"); process.exit(2); }
if (!process.env.CONNECTOR_SECRET_KEY) { console.error("CONNECTOR_SECRET_KEY 미설정"); process.exit(2); }
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist");
const { initOrgSchema } = await import(path.join(DIST, "org/schema.js"));
const { itemsPool } = await import(path.join(DIST, "items/store.js"));
const store = await import(path.join(DIST, "org/store.js"));
const v = await import(path.join(DIST, "org/member-secret-store.js"));
const { proxyAuthFallback } = await import(path.join(DIST, "capabilities/dynamic-tools.js"));

let step = "";
const ok = (m) => console.log("ok  " + m);
try {
  step = "① initOrgSchema(org_tool auth_kind/auth_scope_key/pii_scrub/level 컬럼)";
  await initOrgSchema();
  // allowed_auth_envs 는 불필요(auth_kind 경로) — runtime config 기본으로 진행.
  ok(step);

  step = "② upsertTool http_proxy + 커넥터 필드 왕복(auth_kind·level·pii_scrub·scope_key)";
  await store.upsertTool({
    name: "gitlab_mr_list", kind: "http_proxy", scope: "code",
    url: "https://git.honestfund.kr/api/v4/merge_requests", method: "GET",
    auth_kind: "gitlab_pat", auth_scope_key: "git.honestfund.kr", level: "L1", pii_scrub: true,
    description: "GitLab MR 목록(요청자 PAT)",
  }, { actor: "admin" });
  const t = await store.getTool("gitlab_mr_list");
  if (t.auth_kind !== "gitlab_pat" || t.auth_scope_key !== "git.honestfund.kr" || t.level !== "L1" || t.pii_scrub !== true || t.auth_env !== null)
    throw new Error("필드 왕복 실패 " + JSON.stringify(t));
  ok(step);

  step = "③ listEnabledProxyTools 가 필드 포함해 로드(동적 등록 소스)";
  const list = await store.listEnabledProxyTools();
  const got = list.find((x) => x.name === "gitlab_mr_list");
  if (!got || got.auth_kind !== "gitlab_pat" || got.pii_scrub !== true) throw new Error("동적 로드 필드 누락 " + JSON.stringify(got));
  ok(step);

  step = "④ 등급→폴백 정책(proxyAuthFallback) — L2 만 false";
  if (proxyAuthFallback("L0") !== true || proxyAuthFallback("L1") !== true || proxyAuthFallback(null) !== true || proxyAuthFallback("L2") !== false)
    throw new Error("폴백 정책 오류");
  ok(step);

  step = "⑤ 해소 합성 — L1(read) 은 통합 폴백, L2(write) 는 per-user 필수";
  await v.setMemberSecret(v.GATEWAY_OWNER, "gitlab_pat", "git.honestfund.kr", { secret: "glpat-ORG" }, "admin");
  // u1 개인 자격 없음 → L1 은 통합(gateway) 폴백으로 해소
  const l1 = await v.resolveMemberSecret("u1", "gitlab_pat", { scopeKey: "git.honestfund.kr", allowFallback: proxyAuthFallback("L1") });
  if (l1?.secret !== "glpat-ORG") throw new Error("L1 통합 폴백 실패 " + l1?.secret);
  // L2 는 개인 자격 없으면 null(통합 폴백 금지)
  const l2 = await v.resolveMemberSecret("u1", "gitlab_pat", { scopeKey: "git.honestfund.kr", allowFallback: proxyAuthFallback("L2") });
  if (l2 !== null) throw new Error("L2 가 통합 폴백함(사칭 위험) " + JSON.stringify(l2));
  // u1 개인 자격 등록 후엔 L2 도 그걸로 해소
  await v.setMemberSecret(v.memberOwner("u1"), "gitlab_pat", "git.honestfund.kr", { secret: "glpat-U1" }, "u1");
  const l2b = await v.resolveMemberSecret("u1", "gitlab_pat", { scopeKey: "git.honestfund.kr", allowFallback: proxyAuthFallback("L2") });
  if (l2b?.secret !== "glpat-U1") throw new Error("L2 개인자격 해소 실패 " + l2b?.secret);
  ok(step);

  step = "⑥ auth_env↔auth_kind 배타 — auth_kind 설정 시 auth_env 는 null 로 저장됨(store)";
  if (got.auth_env !== null) throw new Error("auth_env 잔류 " + got.auth_env);
  ok(step);

  console.log("\nCONNECTOR-PROXY INTEGRATION ALL GREEN");
} catch (e) {
  console.error("FAIL @ " + step + " — " + e.message);
  process.exitCode = 1;
} finally {
  await itemsPool.end();
}
