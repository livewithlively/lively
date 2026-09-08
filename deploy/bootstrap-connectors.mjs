// 기본 커넥터 시드(#746) — DCR 지원 호스팅 OAuth MCP 를 '없으면 등록'(멱등, 기존 보존). 배포에 자동 포함.
//  근거·정책은 src/org/delivery/mcp-server-presets.ts 헤더 참조. 커넥터는 등록만으로 데이터가 안 흐름(구성원 OAuth 연결 전) →
//  기본 enabled 출하 안전. 이름이 이미 존재하면 보존(관리자 편집·disable 유지). 영구 제외는 삭제가 아니라 disable.
//
// 실행(앱 루트, 빌드·.env·DB 기동 후): node --env-file=.env deploy/bootstrap-connectors.mjs
//  env: SKIP_CONNECTORS=1 → 건너뜀. BOOTSTRAP_RETRY_MAX_MS(기본 60000)
//  #2578: 스키마 미준비(42703/42P01)·DB 기동 중이면 ≤60s 백오프 재시도(lib/bootstrap-retry.mjs). 실패 = exit 1.
import { listMcpServers, upsertMcpServer } from "../dist/org/store.js";
import { MCP_SERVER_PRESETS } from "../dist/org/delivery/mcp-server-presets.js";
import { withBootstrapRetry, exitOnBootstrapFailure } from "./lib/bootstrap-retry.mjs";

if (process.env.SKIP_CONNECTORS === "1") {
  console.log(JSON.stringify({ ok: true, seeded: [], reason: "SKIP_CONNECTORS=1" }));
  process.exit(0);
}

try {
  const result = await withBootstrapRetry("bootstrap-connectors", async () => {
    const existing = new Set((await listMcpServers()).map((s) => s.name));
    const seeded = [];
    const skipped = [];
    for (const c of MCP_SERVER_PRESETS) {
      if (!c.seed) { skipped.push(c.name + "(needs-client)"); continue; }
      if (existing.has(c.name)) { skipped.push(c.name + "(exists)"); continue; }
      // 레인(#1881) — proxy 는 게이트웨이가 대리하므로 금고 슬롯(auth_kind)+oauth 가 필요하고,
      //  client(레인 C)는 멤버 클라가 자체 OAuth 로 붙으므로 게이트웨이 쪽 자격이 **없어야** 한다.
      //  종전엔 proxy·oauth 가 하드코딩돼 있어서 레인 C 프리셋을 넣으면 상류가 거부하는 프록시로 심겼다.
      const client = c.mode === "client";
      await upsertMcpServer(
        {
          name: c.name, transport: "http", url: c.url,
          mode: client ? "client" : "proxy",
          auth_mode: client ? null : "oauth",
          auth_kind: client ? null : c.auth_kind,
          scope: c.scope, level: c.level, pii_scrub: c.pii_scrub,
          enabled: true, note: c.note,
        },
        "bootstrap", "deploy/connectors",
      );
      seeded.push(c.name);
    }
    return { ok: true, seeded, skipped };
  });
  console.log(JSON.stringify(result));
  process.exit(0);
} catch (err) {
  exitOnBootstrapFailure("bootstrap-connectors", err);
}
