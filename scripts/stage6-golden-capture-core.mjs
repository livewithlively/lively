// Stage⑥ 골든 베이스라인 캡처 (core 엔진 직호출) — 구 :7700 HTTP 서버가 은퇴(dead)해서
//  stage6-golden-capture.mjs(HTTP 캡처)를 못 쓰는 대신, golden-compare 의 --mode=core 가
//  읽는 것과 **동일한 core queries/changelog 함수 + 동일한 직렬화**로 old7700/*.json 베이스라인을
//  생성한다(라이브 domainmap DB 읽기 전용). DomainListItem.space 같은 표면 변경 직전/직후에
//  이 스크립트로 베이스라인을 재캡처해 golden-compare(--mode=core) 가 정공으로 통과하게 한다.
//
//  실행: cd context-ontology && node --env-file=.env scripts/stage6-golden-capture-core.mjs
//  출력: /tmp/stage6-golden/old7700/*.json + /tmp/stage6-golden/manifest.json (domainIds 포함)
//  제약: 전부 read-only(SELECT). 라이브 :8080 비접촉(자체 DB 풀). 시크릿 미출력.
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "/tmp/stage6-golden";
const REPOS = ["lively", "productivity", "e2e-sandbox"];

// golden-compare 와 byte-동일 직렬화: JSON 직렬화 경계(Date→ISO) 통과 후 객체 키 재귀 정렬 + 2-space + 말미 개행.
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
    return o;
  }
  return v;
}
const ser = (payload) => JSON.stringify(sortKeys(JSON.parse(JSON.stringify(payload))), null, 2) + "\n";

function save(dir, file, payload) {
  mkdirSync(`${OUT}/${dir}`, { recursive: true });
  writeFileSync(`${OUT}/${dir}/${file}`, payload);
}

const { listRepos, overview, listDomainsApi, domainDetail, queue, listDebts, listCodeApi, listEntitiesApi } =
  await import("../dist/domainmap/core/queries.js");
const { history } = await import("../dist/domainmap/core/changelog.js");
const { dmPool, endPool } = await import("../dist/domainmap/db.js");

// 도메인 id 전수: 액티브 목록 + merged/deprecated 직접조회(domainDetail 200) — DB 에서 직접 발견.
async function discoverDomainIds(repo) {
  const pool = dmPool();
  const r = await pool.query(
    `SELECT d.id FROM domain d JOIN repo rp ON rp.id=d.repo_id WHERE rp.name=$1 ORDER BY d.id`, [repo]);
  return r.rows.map((x) => Number(x.id));
}

const domainIds = {};
for (const repo of REPOS) domainIds[repo] = await discoverDomainIds(repo);
console.log("domain ids:", JSON.stringify(domainIds));

save("", "manifest.json", JSON.stringify({ capturedAt: new Date().toISOString(), domainIds }, null, 2) + "\n");

save("old7700", "repos.json", ser(await listRepos()));
for (const repo of REPOS) {
  const dir = `old7700/${repo}`;
  save(dir, "overview.json", ser(await overview(repo)));
  save(dir, "domains.json", ser(await listDomainsApi(repo)));
  save(dir, "queue.json", ser(await queue(repo)));
  save(dir, "debts.json", ser(await listDebts(repo)));
  save(dir, "entities.json", ser(await listEntitiesApi(repo)));
  save(dir, "code.json", ser(await listCodeApi(repo, false)));
  save(dir, "code-includeRemoved.json", ser(await listCodeApi(repo, true)));
  save(dir, "history-default.json", ser(await history(repo)));
  save(dir, "history-limit2000.json", ser(await history(repo, 2000)));
  for (const id of domainIds[repo]) {
    save(dir, `domain-${id}.json`, ser(await domainDetail(repo, Number(id))));
  }
}
await endPool();
console.log(`골든 베이스라인(core) 캡처 완료 → ${OUT}/old7700`);
