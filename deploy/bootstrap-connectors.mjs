// 기본 커넥터 시드(#746) — DCR 지원 호스팅 OAuth MCP 를 '없으면 등록'(멱등, 기존 보존). 배포에 자동 포함.
//  근거·정책은 src/org/delivery/mcp-server-presets.ts 헤더 참조. 커넥터는 등록만으로 데이터가 안 흐름(구성원 OAuth 연결 전) →
//  기본 enabled 출하 안전. 이름이 이미 존재하면 보존(관리자 편집·disable 유지). 영구 제외는 삭제가 아니라 disable.
//
// 실행(앱 루트, 빌드·.env·DB 기동 후): node --env-file=.env deploy/bootstrap-connectors.mjs
//  env: SKIP_CONNECTORS=1 → 건너뜀.
import { listMcpServers, upsertMcpServer } from "../dist/org/store.js";
import { MCP_SERVER_PRESETS } from "../dist/org/delivery/mcp-server-presets.js";

if (process.env.SKIP_CONNECTORS === "1") {
  console.log(JSON.stringify({ ok: true, seeded: [], reason: "SKIP_CONNECTORS=1" }));
  process.exit(0);
}

const existing = new Set((await listMcpServers()).map((s) => s.name));
const seeded = [];
const skipped = [];
for (const c of MCP_SERVER_PRESETS) {
  if (!c.seed) { skipped.push(c.name + "(needs-client)"); continue; }
  if (existing.has(c.name)) { skipped.push(c.name + "(exists)"); continue; }
  await upsertMcpServer(
    {
      name: c.name, transport: "http", url: c.url, mode: "proxy", auth_mode: "oauth",
      auth_kind: c.auth_kind, scope: c.scope, level: c.level, pii_scrub: c.pii_scrub,
      enabled: true, note: c.note,
    },
    "bootstrap", "deploy/connectors",
  );
  seeded.push(c.name);
}
console.log(JSON.stringify({ ok: true, seeded, skipped }));
process.exit(0);
