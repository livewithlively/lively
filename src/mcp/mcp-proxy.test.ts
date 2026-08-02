// MCP 프록시(#746 T1) 순수/네트워크-가드 단위 체크 — DB 불요. 실 pg E2E 는 scripts/integration/mcp-proxy-pg.mjs.
// 실행: npm run build && node dist/mcp/mcp-proxy.test.js
//  커버: scope fail-closed(P2) / 툴이름 위생·절단 / 주입자격 리터럴 스크럽(응답·에러 유출 차단) / SSRF 가드(사설·메타데이터·self·scheme).
import assert from "node:assert/strict";
import { proxyScopeAllowed, proxyToolName, redactSecret, classifyToolLevel } from "./mcp-proxy.js";
import { makeSsrfFetch } from "../net/mcp-ssrf-fetch.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const ta = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };
async function rejectsWith(fn: () => Promise<unknown>, re: RegExp): Promise<string> {
  try { await fn(); assert.fail("throw 예상"); }
  catch (e) { const msg = (e as Error).message; assert.match(msg, re); return msg; }
}
async function rejectsMsg(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); assert.fail("throw 예상"); } catch (e) { return (e as Error).message; }
}

// ── P2 scope fail-closed — 미지정/무효/admin·runtime 은 프록시 등록 제외(기본 'items' 로 전체 표면 노출 금지) ──
t("proxyScopeAllowed: callable scope(items/context/db/memory/code) → true", () => {
  for (const s of ["items", "context", "db", "memory", "code"]) assert.equal(proxyScopeAllowed(s), true, s);
});
t("proxyScopeAllowed: 미지정/무효/fleet제어 scope → false(fail-closed)", () => {
  assert.equal(proxyScopeAllowed(null), false);
  assert.equal(proxyScopeAllowed(undefined), false);
  assert.equal(proxyScopeAllowed(""), false);
  assert.equal(proxyScopeAllowed("admin"), false);   // 관리 표면 자가호출 차단
  assert.equal(proxyScopeAllowed("runtime"), false);
  assert.equal(proxyScopeAllowed("bogus"), false);
});

// ── 툴 이름 위생 — MCP 허용 문자만·128자 상한(빌트인/http_proxy 이름과 네임스페이스 격리) ──
t("proxyToolName: ext__ 접두 + 특수문자 → _ 치환", () => {
  assert.equal(proxyToolName("slack", "search.messages"), "ext__slack__search_messages");
  assert.equal(proxyToolName("git lab", "get/mr"), "ext__git_lab__get_mr");
});
t("proxyToolName: 128자 절단", () => {
  const long = proxyToolName("s", "x".repeat(300));
  assert.equal(long.length, 128);
  assert.ok(long.startsWith("ext__s__xxx"));
});

// ── per-tool 등급 휴리스틱(#746) — read=L0 / write=L2 / 나머지=서버 기본, ambiguous 는 안전측(L2) ──
t("classifyToolLevel: read 동사 → L0", () => {
  for (const n of ["describe_instances", "ListBuckets", "getObject", "search_messages", "query", "head_object"]) assert.equal(classifyToolLevel(n, "L1"), "L0", n);
});
t("classifyToolLevel: write/mutate 동사 → L2", () => {
  for (const n of ["put_object", "DeleteBucket", "create_stack", "terminate_instances", "update_item", "runInstances", "send_message", "reset_x"]) assert.equal(classifyToolLevel(n, "L1"), "L2", n);
});
t("classifyToolLevel: 미매칭 → 서버 기본", () => {
  assert.equal(classifyToolLevel("frobnicate", "L1"), "L1");
  assert.equal(classifyToolLevel("frobnicate", "L0"), "L0");
});
// 회귀(#746 실측 Notion) — 상류가 네임스페이스 접두를 붙이면 동사가 접두 뒤에 온다. ^앵커면 놓쳐 쓰기가 L0 로 새던 버그.
t("classifyToolLevel: 네임스페이스 접두 뒤 동사도 분류(notion-/github_/slack.)", () => {
  for (const n of ["notion-create-pages", "notion-update-page", "notion-move-pages", "notion-duplicate-page", "notion-create-database", "github_create_issue", "slack.postMessage", "jira-delete-ticket"]) assert.equal(classifyToolLevel(n, "L0"), "L2", n);
  for (const n of ["notion-search", "notion-fetch", "notion-get-users", "notion-query-data-sources", "notion-get-comments", "github_list_repos"]) assert.equal(classifyToolLevel(n, "L2"), "L0", n);
});

// ── P1/P2 주입 자격 유출 차단 — 상류 응답/에러에 에코된 자격 리터럴 스크럽 ──
t("redactSecret: 길이 ≥8 자격은 [REDACTED] 로", () => {
  assert.equal(redactSecret("token=glpat-SECRETVAL 확인", "glpat-SECRETVAL"), "token=[REDACTED] 확인");
  assert.equal(redactSecret("a xoxb-longtokenvalue b xoxb-longtokenvalue c", "xoxb-longtokenvalue"), "a [REDACTED] b [REDACTED] c");
});
t("redactSecret: 짧은/빈/null 자격은 무변경(과잉 스크럽 방지)", () => {
  assert.equal(redactSecret("hello short", "short"), "hello short"); // <8 → 스킵
  assert.equal(redactSecret("hello", ""), "hello");
  assert.equal(redactSecret("hello", null), "hello");
  assert.equal(redactSecret("hello", undefined), "hello");
});

// ── SSRF 가드(Blocking #1) — 관리자 등록 URL 이라도 사설/메타데이터/self/평문은 차단. 검증은 connect 이전에 fail-closed ──
const F = makeSsrfFetch({ allowedInternalHosts: [], selfHosts: ["gw.example.com"] });
await ta("SSRF: 메타데이터 IP(169.254.169.254) 차단", async () => {
  await rejectsWith(() => F("https://169.254.169.254/mcp"), /차단된 host/);
});
await ta("SSRF: 사설 IP(10.x) 차단", async () => {
  await rejectsWith(() => F("https://10.1.2.3/mcp"), /차단된 host/);
  await rejectsWith(() => F("https://127.0.0.1/mcp"), /차단된 host/); // loopback(허용목록 없음)
});
await ta("SSRF: http(평문)는 원격 금지(https 전용)", async () => {
  await rejectsWith(() => F("http://example.com/mcp"), /허용되지 않은 scheme/);
});
await ta("SSRF: 게이트웨이 자기자신(self-host) 차단 — confused-deputy", async () => {
  await rejectsWith(() => F("https://gw.example.com/mcp"), /자기 자신/);
});
await ta("SSRF: self-host trailing-dot 우회 차단(정규화)", async () => {
  await rejectsWith(() => F("https://gw.example.com./mcp"), /자기 자신/); // DNS 등가 후행점으로 문자열검사 우회 시도
});
await ta("SSRF: self-host 를 해소 IP(리터럴)로 우회해도 차단", async () => {
  const Fip = makeSsrfFetch({ allowedInternalHosts: [], selfHosts: ["93.184.216.34"] }); // 공인 IP 를 self 로
  await rejectsWith(() => Fip("https://93.184.216.34/mcp"), /자기 자신/); // 핀된 IP 가 self IP 집합에 속함
});
await ta("SSRF: 잘못된 URL 거부", async () => {
  await rejectsWith(() => F("not-a-url"), /잘못된 URL/);
});
// 운영자 명시 내부 host 는 검증 통과 → 연결 시도(포트 미개방=연결오류). '차단'/'scheme' 이 아니라 '연결' 단계까지 갔음을 확인.
await ta("SSRF: allowed_internal_hosts 등록 host 는 검증 통과(내부 MCP 허용)", async () => {
  const Fi = makeSsrfFetch({ allowedInternalHosts: ["127.0.0.1"], selfHosts: [], timeoutMs: 800 });
  const msg = await rejectsMsg(() => Fi("http://127.0.0.1:9/mcp")); // discard 포트 — 연결 거부/타임아웃
  assert.doesNotMatch(msg, /차단된 host|허용되지 않은 scheme|자기 자신/, `검증을 통과해 연결단계여야: ${msg}`);
  assert.match(msg, /연결 오류|타임아웃|ECONNREFUSED|ECONNRESET/);
});

console.log(`\nMCP-PROXY UNIT: ${pass} passed`);
