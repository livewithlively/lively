// Stage⑥ 골든 리드 캡처 — domainmap 엔진 흡수 전, 모든 읽기 표면의 스냅샷.
// 실행: cd context-ontology && node --env-file=.env scripts/stage6-golden-capture.mjs
// 출력: /tmp/stage6-golden/{old7700,gw-rest,gw-mcp}/ — pretty-print + 객체 키 재귀 정렬
//       (배열 순서는 엔진 정렬 결과 자체가 검증 대상이므로 보존).
// 제약: 전부 read-only(GET / MCP 읽기 op). 라이브 :7700/:8080 비간섭. 시크릿(토큰 값) 미출력.
// 비고: old 엔진 history 는 saneLimit(max=500)으로 limit=2000 요청도 500행 클램프 —
//       이 클램프 동작 자체가 골든. change_log 전체(971행)는 DB 덤프+3단계 DB-diff 가 커버.
import { mkdirSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const OUT = "/tmp/stage6-golden";
const OLD = (process.env.DOMAINMAP_URL ?? "http://localhost:7700").replace(/\/$/, "");
const GW = process.env.STAGE6_GW_URL ?? "http://localhost:8080"; // 재캡처 시 신엔진 게이트웨이로 덮어쓰기 가능
const SUFFIX = process.env.STAGE6_SUFFIX ?? ""; // 컷오버 후 재캡처: STAGE6_SUFFIX=-new → gw-rest-new/
const REPOS = ["lively", "productivity", "e2e-sandbox"];
const SKIP_OLD = process.env.STAGE6_SKIP_OLD === "1"; // 컷오버 후엔 old :7700 이 없을 수 있음

// ── 토큰: AUTH_TOKENS_JSON 에서 scopes ⊇ {items, context} 첫 항목(값 절대 비출력) ──
function pickToken() {
  const raw = process.env.AUTH_TOKENS_JSON;
  if (!raw) fail("AUTH_TOKENS_JSON 미설정 — .env 확인");
  let table;
  try { table = JSON.parse(raw); } catch { fail("AUTH_TOKENS_JSON 파싱 실패"); }
  for (const [token, user] of Object.entries(table)) {
    const scopes = user?.scopes ?? [];
    if (scopes.includes("items") && scopes.includes("context")) return token;
  }
  fail("items+context 스코프 토큰이 AUTH_TOKENS_JSON 에 없음");
}
function fail(msg) { console.error(`FATAL: ${msg}`); process.exit(2); }
const TOKEN = pickToken();

// ── 결정적 직렬화: 객체 키만 재귀 정렬, 배열 순서 보존 ──
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
    return o;
  }
  return v;
}
const failures = [];
let captured = 0;
const manifest = { capturedAt: new Date().toISOString(), oldBase: OLD, gwBase: GW, files: {} };

function save(dir, file, payload, srcDesc) {
  mkdirSync(`${OUT}/${dir}`, { recursive: true });
  writeFileSync(`${OUT}/${dir}/${file}`, JSON.stringify(sortKeys(payload), null, 2) + "\n");
  manifest.files[`${dir}/${file}`] = srcDesc;
  captured++;
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not-json */ }
  if (res.status !== 200 || json === null) {
    throw new Error(`${res.status} ${url.replace(GW, "<gw>").replace(OLD, "<old>")} :: ${text.slice(0, 200)}`);
  }
  return json;
}
async function cap(dir, file, url, headers, srcDesc) {
  try { save(dir, file, await getJson(url, headers), srcDesc); }
  catch (e) { failures.push(`${dir}/${file}: ${e.message}`); }
}

// ── 도메인 id 전수: 액티브 목록 + 1..50 프로브(merged/deprecated 도 domainDetail 200) ──
async function discoverDomainIds(repo) {
  const ids = new Set();
  try {
    for (const d of await getJson(`${OLD}/api/repo/${repo}/domains`)) ids.add(Number(d.id));
  } catch (e) { failures.push(`discover ${repo}/domains: ${e.message}`); }
  for (let id = 1; id <= 50; id++) {
    if (ids.has(id)) continue;
    const res = await fetch(`${OLD}/api/repo/${repo}/domain/${id}`);
    await res.text().catch(() => {});
    if (res.status === 200) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}
// old 가 없을 때(STAGE6_SKIP_OLD) 게이트웨이 domains 목록으로 발견(merged 는 manifest 의 기존 id 사용 권장).
async function discoverViaGw(repo) {
  const list = await getJson(`${GW}/api/ui/domainmap/${repo}/domains`, { authorization: `Bearer ${TOKEN}` });
  return list.map((d) => Number(d.id)).sort((a, b) => a - b);
}

const domainIds = {};
for (const repo of REPOS) {
  domainIds[repo] = SKIP_OLD ? await discoverViaGw(repo) : await discoverDomainIds(repo);
}
// 재캡처(-new) 시 구캡처와 같은 id 집합을 쓰도록 환경변수로 강제 주입 가능: STAGE6_IDS_JSON
if (process.env.STAGE6_IDS_JSON) Object.assign(domainIds, JSON.parse(process.env.STAGE6_IDS_JSON));
manifest.domainIds = domainIds;
console.log("domain ids:", JSON.stringify(domainIds));

// ════════ (a) old :7700 — 무인증, 전 읽기 엔드포인트 ════════
if (!SKIP_OLD) {
  await cap("old7700", "repos.json", `${OLD}/api/repos`, {}, "GET /api/repos");
  for (const repo of REPOS) {
    const base = `${OLD}/api/repo/${repo}`;
    for (const ep of ["overview", "domains", "queue", "debts", "entities", "projects"]) {
      await cap(`old7700/${repo}`, `${ep}.json`, `${base}/${ep}`, {}, `GET /api/repo/${repo}/${ep}`);
    }
    await cap(`old7700/${repo}`, "code.json", `${base}/code`, {}, `GET /api/repo/${repo}/code`);
    await cap(`old7700/${repo}`, "code-includeRemoved.json", `${base}/code?includeRemoved=1`, {}, `GET /api/repo/${repo}/code?includeRemoved=1`);
    await cap(`old7700/${repo}`, "history-default.json", `${base}/history`, {}, `GET /api/repo/${repo}/history (기본 50)`);
    await cap(`old7700/${repo}`, "history-limit2000.json", `${base}/history?limit=2000`, {}, `GET /api/repo/${repo}/history?limit=2000 (saneLimit→500 클램프)`);
    for (const id of domainIds[repo]) {
      await cap(`old7700/${repo}`, `domain-${id}.json`, `${base}/domain/${id}`, {}, `GET /api/repo/${repo}/domain/${id}`);
    }
  }
}

// ════════ (b) 게이트웨이 REST :8080 — Bearer ════════
const H = { authorization: `Bearer ${TOKEN}` };
const GWD = `gw-rest${SUFFIX}`;
await cap(GWD, "repos.json", `${GW}/api/ui/repos`, H, "GET /api/ui/repos");
await cap(GWD, "stats.json", `${GW}/api/ui/stats`, H, "GET /api/ui/stats");
for (const repo of REPOS) {
  for (const kind of ["domains", "projects", "entities", "overview"]) {
    await cap(`${GWD}/${repo}`, `${kind}.json`, `${GW}/api/ui/domainmap/${repo}/${kind}`, H, `GET /api/ui/domainmap/${repo}/${kind}`);
  }
  await cap(`${GWD}/${repo}`, "debts.json", `${GW}/api/ui/domainmap/debts?repo=${repo}`, H, `GET /api/ui/domainmap/debts?repo=${repo}`);
  await cap(`${GWD}/${repo}`, "history-limit500.json", `${GW}/api/ui/domainmap/history?repo=${repo}&limit=500`, H, `GET /api/ui/domainmap/history?repo=${repo}&limit=500`);
  for (const id of domainIds[repo]) {
    await cap(`${GWD}/${repo}`, `domain-${id}.json`, `${GW}/api/ui/domainmap/${repo}/domain/${id}`, H, `GET /api/ui/domainmap/${repo}/domain/${id}`);
  }
}

// ════════ (c) MCP :8080/mcp — StreamableHTTP + Bearer ════════
const MCPD = `gw-mcp${SUFFIX}`;
const transport = new StreamableHTTPClientTransport(new URL(`${GW}/mcp`), {
  requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
});
const client = new Client({ name: "stage6-golden-capture", version: "0.0.1" });
await client.connect(transport);

async function mcpCap(file, name, args, opts = {}) {
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    if (r.isError) throw new Error(`isError: ${text.slice(0, 200)}`);
    save(MCPD + (opts.sub ? `/${opts.sub}` : ""), file, JSON.parse(text), `MCP ${name} ${JSON.stringify(args)}`);
  } catch (e) { failures.push(`${MCPD}/${opts.sub ? opts.sub + "/" : ""}${file}: ${e.message}`); }
}

// tools/list — 표면 동결 21 단언 + 전체 정의(이름순) 골든.
{
  const { tools } = await client.listTools();
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const names = sorted.map((t) => t.name);
  save(MCPD, "tools-list.json", { count: names.length, names, tools: sorted }, "MCP tools/list (이름순)");
  if (names.length !== 21) failures.push(`tools/list: ${names.length}개 — 21개여야 함 [${names.join(",")}]`);
  else console.log("tools/list: 21 OK");
}

await mcpCap("repo_list.json", "repo_list", {});
for (const repo of REPOS) {
  await mcpCap("context_overview.json", "context_overview", { repo }, { sub: repo });
  await mcpCap("domain_list.json", "domain_list", { repo }, { sub: repo });
  await mcpCap("debt_list.json", "debt_list", { repo }, { sub: repo });
  for (const id of domainIds[repo]) {
    await mcpCap(`domain-get-${id}.json`, "domain_get", { id, repo }, { sub: repo });
  }
}
await client.close().catch(() => {});

// ── 마무리 ──
manifest.captured = captured;
manifest.failures = failures;
writeFileSync(`${OUT}/manifest${SUFFIX}.json`, JSON.stringify(manifest, null, 2) + "\n");
console.log(`captured: ${captured} files → ${OUT}`);
if (failures.length) {
  console.error(`실패 ${failures.length}건:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("골든 캡처 완료 (실패 0)");
