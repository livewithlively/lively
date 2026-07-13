// T1 A-어댑터 E2E(#746) — 게이트웨이가 상류 MCP 를 프록시. 상류 = 살아있는 게이트웨이 자신(루프백, localhost:8080/mcp).
//  검증: proxy 서버 등록 → refresh(상류 tools/list 캡처·핀) → listProxyServers → callProxyTool(요청자 자격 주입 포워딩)
//        → registerProxiedMcpTools(네임스페이스 등록) → 자격 폴백(L0 통합 / L2 per-user).
// 실행: npm run build && CONNECTOR_SECRET_KEY=$(openssl rand -hex 32) \
//        ITEMS_DATABASE_URL='postgresql://postgres@localhost/proxy_test?host=/tmp/pgXXX&port=54329' \
//        LOOPBACK_TOKEN=$(cat ~/.lively/ernest-token) node scripts/integration/mcp-proxy-pg.mjs
import { fileURLToPath } from "node:url";
import path from "node:path";

if (!process.env.ITEMS_DATABASE_URL) { console.error("ITEMS_DATABASE_URL 미설정(스크래치 pg)"); process.exit(2); }
if (!process.env.CONNECTOR_SECRET_KEY) { console.error("CONNECTOR_SECRET_KEY 미설정"); process.exit(2); }
if (!process.env.LOOPBACK_TOKEN) { console.error("LOOPBACK_TOKEN 미설정(상류 /mcp 인증용)"); process.exit(2); }
const UP = process.env.LOOPBACK_URL || "http://localhost:8080/mcp";
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist");
const { initOrgSchema } = await import(path.join(DIST, "org/schema.js"));
const { itemsPool } = await import(path.join(DIST, "items/store.js"));
const store = await import(path.join(DIST, "org/store.js"));
const v = await import(path.join(DIST, "org/member-secret-store.js"));
const proxy = await import(path.join(DIST, "capabilities/mcp-proxy.js"));

let step = "";
const ok = (m) => console.log("ok  " + m);
try {
  step = "① initOrgSchema(org_mcp_server proxy 컬럼)";
  await initOrgSchema();
  ok(step);

  step = "② 통합 자격(gateway) 등록 + proxy 서버 upsert(mode=proxy, auth_kind=selfloop, level L0)";
  await v.setMemberSecret(v.GATEWAY_OWNER, "selfloop", "", { secret: process.env.LOOPBACK_TOKEN }, "admin");
  await store.upsertMcpServer({
    name: "selfloop", transport: "http", url: UP, mode: "proxy",
    scope: "items", level: "L0", auth_kind: "selfloop", pii_scrub: false, enabled: true,
  }, "admin", "web");
  const srv = await store.getMcpServer("selfloop");
  if (srv.mode !== "proxy" || srv.auth_kind !== "selfloop" || srv.auth_env !== null) throw new Error("proxy 필드 왕복 실패 " + JSON.stringify(srv));
  ok(step);

  step = "③ refreshProxySnapshot — 상류 접속·tools/list 캡처·핀 저장";
  const r = await proxy.refreshProxySnapshot("selfloop", "admin");
  if (!(r.count > 0)) throw new Error("스냅샷 툴 0개");
  const srv2 = await store.getMcpServer("selfloop");
  if (!srv2.tools_snapshot || srv2.tools_snapshot.length !== r.count || !srv2.snapshot_at) throw new Error("스냅샷 저장 실패");
  ok(step + ` (상류 툴 ${r.count}개 핀)`);

  step = "④ listProxyServers — 발행된 proxy 서버만(스냅샷 보유)";
  const list = await store.listProxyServers();
  if (!list.find((s) => s.name === "selfloop")) throw new Error("listProxyServers 누락");
  ok(step);

  step = "⑤ callProxyTool — 요청자(u1) 자격 해소(L0=통합 폴백)→상류 포워딩";
  // u1 개인 자격 없음 → L0 이라 gateway(selfloop) 통합 자격으로 폴백해 상류 인증
  const call = await proxy.callProxyTool("selfloop", "db_sources", {}, "u1");
  const txt = (call.content?.[0]?.text || "");
  if (call.isError || !txt.includes("source")) throw new Error("프록시 호출 결과 이상: " + txt.slice(0, 120));
  ok(step + " (db_sources 프록시 응답 수신)");

  step = "⑥ registerProxiedMcpTools — pinned 스냅샷을 네임스페이스(ext__selfloop__*)로 등록";
  const registered = [];
  const mockServer = { registerTool: (name) => registered.push(name) };
  await proxy.registerProxiedMcpTools(mockServer);
  const sample = registered.filter((n) => n.startsWith("ext__selfloop__"));
  if (sample.length !== r.count) throw new Error(`등록 수 불일치 ${sample.length}/${r.count}`);
  if (!sample.includes("ext__selfloop__db_sources")) throw new Error("db_sources 네임스페이스 등록 누락");
  ok(step + ` (${sample.length}개 등록, 예: ${sample.slice(0, 3).join(", ")})`);

  step = "⑦ L2 자격 폴백 금지 — 개인 자격 없는 u2 는 L2 서버 호출 시 자격 없음";
  await store.upsertMcpServer({ name: "selfloop", mode: "proxy", level: "L2" }, "admin", "web"); // 등급만 L2 로
  let denied = false;
  try { await proxy.callProxyTool("selfloop", "db_sources", {}, "u2"); }
  catch (e) { if (String(e.message).includes("자격 없음")) denied = true; }
  if (!denied) throw new Error("L2인데 통합 폴백으로 호출됨(사칭 위험)");
  ok(step);

  console.log("\nMCP-PROXY(T1) INTEGRATION ALL GREEN");
} catch (e) {
  console.error("FAIL @ " + step + " — " + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  await itemsPool.end();
}
