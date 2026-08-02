// Stage⑥ 골든 리드 비교 — 흡수된 엔진의 읽기 표면을 컷오버 전 골든과 대조.
// 모드:
//   --mode=core  : 신규 core queries 를 dist 에서 직접 import 해 라이브 domainmap DB(읽기만)에 실행,
//                  캡처 스크립트와 동일한 직렬화(객체 키 재귀 정렬 + 2-space pretty + 말미 개행)로
//                  /tmp/stage6-golden/old7700/*.json 과 **byte 비교** — queue/code 등 게이트웨이
//                  비노출 표면까지 검증한다. (라이브 :7700/:8080 비간섭, 쓰기 0)
//   --mode=gw    : 컷오버 재기동 후 — gw-rest-new/gw-mcp-new 재캡처본을 구캡처와 deepStrictEqual.
// 허용 정규화 리스트 목표 = 빈 리스트. 불일치는 파일·키 단위로 출력하고 exit 1.
// 실행: cd context-ontology && node --env-file=.env scripts/stage6-golden-compare.mjs --mode=core
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import assert from "node:assert";

const OUT = "/tmp/stage6-golden";
const mode = (process.argv.find((a) => a.startsWith("--mode=")) ?? "--mode=core").slice(7);

// 캡처 스크립트(stage6-golden-capture.mjs)와 동일한 결정적 직렬화.
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
    return o;
  }
  return v;
}
// core 직호출 결과는 pg Date 객체를 포함 — 게이트웨이 표면(res.json/MCP)과 동일하게
// JSON 직렬화 경계를 먼저 통과시킨 뒤(Date.toJSON → ISO) 키 정렬한다. 정규화가 아니라
// 실제 직렬화 표면의 재현(구 경로도 HTTP JSON.stringify 가 같은 일을 했다).
const ser = (payload) => JSON.stringify(sortKeys(JSON.parse(JSON.stringify(payload))), null, 2) + "\n";

let pass = 0;
const failures = [];
function compare(name, actualStr, goldenPath) {
  const golden = readFileSync(goldenPath, "utf8");
  if (actualStr === golden) { pass++; return; }
  // 첫 불일치 지점 요약(키 단위 진단은 diff 로)
  const a = actualStr.split("\n"), g = golden.split("\n");
  let i = 0;
  while (i < Math.min(a.length, g.length) && a[i] === g[i]) i++;
  failures.push(`${name}: line ${i + 1}\n    golden: ${(g[i] ?? "<EOF>").slice(0, 160)}\n    actual: ${(a[i] ?? "<EOF>").slice(0, 160)}`);
}

if (mode === "core") {
  const manifest = JSON.parse(readFileSync(`${OUT}/manifest.json`, "utf8"));
  const domainIds = manifest.domainIds;
  const REPOS = Object.keys(domainIds);

  const { listRepos, overview, listDomainsApi, domainDetail, queue, listDebts, listCodeApi, listEntitiesApi } =
    await import("../dist/domainmap/core/queries.js");
  const { history } = await import("../dist/domainmap/core/changelog.js");
  const { endPool } = await import("../dist/domainmap/db.js");

  compare("repos.json", ser(await listRepos()), `${OUT}/old7700/repos.json`);
  for (const repo of REPOS) {
    const dir = `${OUT}/old7700/${repo}`;
    compare(`${repo}/overview`, ser(await overview(repo)), `${dir}/overview.json`);
    compare(`${repo}/domains`, ser(await listDomainsApi(repo)), `${dir}/domains.json`);
    compare(`${repo}/queue`, ser(await queue(repo)), `${dir}/queue.json`);
    compare(`${repo}/debts`, ser(await listDebts(repo)), `${dir}/debts.json`);
    compare(`${repo}/entities`, ser(await listEntitiesApi(repo)), `${dir}/entities.json`);
    compare(`${repo}/code`, ser(await listCodeApi(repo, false)), `${dir}/code.json`);
    compare(`${repo}/code?includeRemoved`, ser(await listCodeApi(repo, true)), `${dir}/code-includeRemoved.json`);
    compare(`${repo}/history(기본50)`, ser(await history(repo)), `${dir}/history-default.json`);
    compare(`${repo}/history?limit=2000(클램프500)`, ser(await history(repo, 2000)), `${dir}/history-limit2000.json`);
    for (const id of domainIds[repo]) {
      compare(`${repo}/domain/${id}`, ser(await domainDetail(repo, Number(id))), `${dir}/domain-${id}.json`);
    }
  }
  await endPool();
} else if (mode === "gw") {
  // 컷오버 후: 재캡처본(gw-rest-new/gw-mcp-new)을 구캡처(gw-rest/gw-mcp)와 byte 비교.
  for (const pair of [["gw-rest", "gw-rest-new"], ["gw-mcp", "gw-mcp-new"]]) {
    const [oldD, newD] = pair.map((d) => `${OUT}/${d}`);
    assert.ok(existsSync(newD), `${newD} 없음 — 재캡처(STAGE6_SUFFIX=-new) 먼저`);
    const walk = (dir, rel = "") => readdirSync(dir).flatMap((f) => {
      const p = `${dir}/${f}`;
      return statSync(p).isDirectory() ? walk(p, `${rel}${f}/`) : [`${rel}${f}`];
    });
    for (const f of walk(oldD)) {
      const np = `${newD}/${f}`;
      if (!existsSync(np)) { failures.push(`${pair[1]}/${f}: 재캡처본 없음`); continue; }
      compare(`${pair[1]}/${f}`, readFileSync(np, "utf8"), `${oldD}/${f}`);
    }
  }
} else {
  console.error(`unknown --mode=${mode} (core|gw)`);
  process.exit(2);
}

console.log(`PASS ${pass}건`);
if (failures.length) {
  console.error(`FAIL ${failures.length}건 — 정규화 허용 리스트는 빈 것이 목표(불일치는 정당화 문서화 없이는 FAIL):\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("골든 비교 전부 일치 (정규화 허용 리스트: 빈 리스트)");
