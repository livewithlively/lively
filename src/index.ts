import express from "express";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { BearerVerifier } from "./auth/bearer.js";
import { itemsPool } from "./db/client.js";
import { buildToolCandidates } from "./capabilities/index.js";
import { setToolCandidates } from "./mcp/mcp-surface.js";
import { finishConsent, abandonConsent } from "./org/credentials/oauth-broker.js";
import { buildInstallBundle } from "./org/delivery/publish.js";
import { domainmapWebhookRouter } from "./domainmap/webhook.js";
import { registerWebUi } from "./web.js";
import { killAttachedPtys } from "./terminal/terminal-pty.js";
import { registerProjectV6Routes } from "./project/project-routes.js";
import { registerSessionLogRoutes } from "./sessions/session-log-routes.js";
import { registerAuditExportRoutes } from "./audit-export-routes.js";
import { registerPreviewRoutes } from "./preview/routes.js";
import { getProject as v6GetProject, listProjectMemberIds as v6ListProjectMemberIds, setProjectFolder as v6SetProjectFolder } from "./v6/project-store.js";
import { isProjectMember as v6IsProjectMember } from "./v6/project-session-store.js";   // #1313 R21 — 멤버십 게이트는 세션 바인딩 모듈
import { listProjectActivities } from "./v6/project-activity-store.js";
import { createProjectFolder } from "./project/project-fs.js";
import { stateRoot } from "./ops/state-dir.js";
import { ROOTS } from "./terminal/terminal-sessions.js";
import { readyReport } from "./ops/health.js";
import { effectiveStoragePolicy } from "./org/policies/storage-policy.js";
import { registerMcpTransport } from "./boot/mcp-transport.js";
import { runBootHousekeeping, loadStoragePolicy } from "./boot/housekeeping.js";
import { loadEnterprise } from "./enterprise/load.js";
import { logger } from "./log.js";

const PORT = Number(process.env.PORT ?? 8080);

// ── 프로세스 안전망(최대한 안 죽게) — launchd KeepAlive 와 함께 2중 방어. ──
//  unhandledRejection: 미처리 promise 거부로 프로세스가 통째로 죽지 않게 — 로그만 남기고 계속(요청 1건 실패 ≠ 전체 다운).
//  uncaughtException: 상태가 오염됐을 수 있으니 로그 후 종료 → launchd 가 즉시 새 프로세스로 재기동(깨끗한 상태).
process.on("unhandledRejection", (reason) => logger.error({ reason }, "unhandledRejection — 무시하고 계속"));
process.on("uncaughtException", (err) => { logger.error({ err }, "uncaughtException — 종료 후 재기동"); try { killAttachedPtys(); } catch { /* noop */ } process.exit(1); });
// 정상 종료(재배포 SIGTERM·Ctrl+C SIGINT) 시 attach node-pty 를 전부 kill 하고 나간다(#687). 안 하면 자식이 init 로
//  재부모화돼 PTY 를 영구 점유(고아). 재시작이 잦은 게이트웨이라 이게 없으면 매 배포가 PTY 를 흘린다.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => { logger.info({ sig }, "shutdown — attach PTY 정리 후 종료"); try { killAttachedPtys(); } catch { /* noop */ } process.exit(0); });
}

// Enterprise(src/ee) 적재 — **툴 표면을 굳히기 전에** 끝나야 한다(EE capability 가 registry 에 합류할 기회).
//  ee 가 없으면(무료 배포판) 조용히 false 로 지나가고 코어 기능만 뜬다.
await loadEnterprise();

// 부팅 시 MCP 툴 후보 주입 — registry(정적) + db 직접등록. 웹 도구탭(org_tools)·검증(org_tool_upsert)·http_proxy 섀도잉 차단이 참조.
setToolCandidates(buildToolCandidates());

const app = express();

// domainmap 웹훅(:7700 시절과 동일 경로) — 반드시 전역 express.json() '이전'에 마운트:
// HMAC 은 정확한 raw bytes 대상이라 JSON 파서가 스트림을 먼저 소비하면 검증이 영원히 실패한다.
// bearer 인증 밖(구 :7700 과 동일 — HMAC 자체가 fail-closed 인증). raw 파싱은 라우터 내부 소유.
app.use("/api/webhook", domainmapWebhookRouter());

app.use(express.json({ limit: "1mb" }));

const verifier = new BearerVerifier();
const auth = requireBearerAuth({ verifier });

// liveness — '프로세스가 살아있나'. **얕은 채로 둔다.**
//  deploy/lib/common.sh 의 wait_healthz() 가 설치·업데이트 중 이걸 60회 재시도로 폴링해 기동을 확인하는데,
//  그 시점엔 DB 가 아직 안 떠 있을 수 있다 → 여기에 DB 를 물리면 정상 설치가 실패한다(닭-달걀). 깊은 점검은 /readyz.
app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// readiness — '실제로 서비스가 되나'(#813 T2). DB 도달 + 디스크 여유. **모니터·알림은 healthz 가 아니라 이걸 봐야 한다.**
//  2026-07-13: 디스크풀 → Postgres recovery mode → 모든 로그인 500 인데도 /healthz 는 초록이라 아무도 몰랐다.
//  DB 불가 → 503(진짜 not-ready). 디스크 경고는 200 + status=degraded — 멀쩡한 서비스를 LB 에서 빼지 않는다(health.ts 참조).
//  미인증: LB·모니터가 호출한다(k8s readiness 관례). 응답의 DB 에러는 health.ts 가 자격증명을 마스킹한다.
//  저장소 정책 로더(loadStoragePolicy — 관리탭 DB 단일 출처·DB 다운에도 판정)는 boot/housekeeping.ts 참조.
app.get("/readyz", async (_req, res) => {
  try {
    const policy = await effectiveStoragePolicy(loadStoragePolicy);
    const report = await readyReport({
      pool: itemsPool,
      paths: [stateRoot(), ...ROOTS.map((r) => r.base)],
      thresholds: { warnPct: policy.disk_warn_pct, criticalPct: policy.disk_critical_pct },
    });
    res.status(report.ok ? 200 : 503).json(report);
  } catch (err) {
    // 점검 자체가 터지면 '준비됨'이라 우길 근거가 없다 → fail-closed.
    logger.error({ err }, "readyz 점검 실패");
    res.status(503).json({ ok: false, status: "down" });
  }
});

// MCP 전송 계층 — /mcp POST/GET/DELETE + 요청별 서버 조립(무상태/sessioned). 본문·불변식은 boot/mcp-transport.ts.
registerMcpTransport(app, auth);

// 멤버 설치 — 토큰게이트 curl 모델(git clone 대체). 인증된 멤버 토큰이면 그 조직의 발행 아티팩트를
//  tar.gz 로 동적 생성해 스트림한다(DB→materialize→generator→tar). 설치 한 줄:
//    curl -fsSL <GW>/cli | sh          (→ lively CLI 가 /install 번들을 받아 설치)
//  격리 모델: **조직당 1 게이트웨이+DB 인스턴스**(배포 유형화 T1~T5, 멀티테넌트 SaaS 제외). 따라서 org-content
//  테이블에 org_id 컬럼이 없고 모든 멤버 토큰이 그 단일 조직 묶음을 받는다 — 이건 설계상 의도다.
//  ⚠️ 만약 한 게이트웨이를 여러 조직이 공유하도록 바꾼다면 org_id 격리(스키마+모든 쿼리 필터)가 선행 필수.
app.get("/install", auth, async (_req, res) => {
  try {
    const { buffer } = await buildInstallBundle("claude");
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", 'attachment; filename="lively-context-setup.tgz"');
    res.send(buffer);
  } catch (err) {
    logger.error({ err }, "install bundle 생성 실패");
    if (!res.headersSent) res.status(500).json({ error: "install_bundle_failed" });
  }
});

// OAuth 콜백(#746 T2) — 인가서버가 code+state 로 리다이렉트하는 착지점. 브라우저-facing 이라 bearer 인증 밖:
//  보안은 서명된 state(HMAC·만료·멤버 귀속)가 담보한다 — 위조 불가 → 타인 vault 에 토큰 주입 불가. finishConsent 가 검증·교환·저장.
const oauthPage = (msg: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Lively 커넥터</title><body style="font-family:system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem;line-height:1.6"><h2>Lively 커넥터</h2><p>${String(msg).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string))}</p></body>`;
app.get("/oauth/callback", async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  if (q.error) {
    if (q.state) await abandonConsent(String(q.state)).catch(() => { /* best-effort 정리 */ }); // 거부 시 임시 PKCE verifier 정리(리뷰 #1)
    return res.status(400).send(oauthPage(`인증이 거부되었습니다: ${q.error}`));
  }
  if (!q.code || !q.state) return res.status(400).send(oauthPage("code 또는 state 가 없습니다."));
  try {
    const r = await finishConsent(String(q.state), String(q.code));
    res.send(oauthPage(`연결이 완료되었습니다 — ${r.serverName}. 이 창을 닫아도 됩니다.`));
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "oauth 콜백 실패");
    res.status(400).send(oauthPage(`연결에 실패했습니다: ${(err as Error).message}`));
  }
});

// Lively Context 웹 UI — /api/ui/*(REST, 동일 verifier 재사용) + /ui(정적 프론트).
registerWebUi(app, verifier);
// v6(projects2) 상세 — 동일 파일/세션/타임라인 로직, 데이터만 v6 project. folder 비면 lazy 생성(데이터 쓰기, 스키마 불변).
// (v1 registerProjectRoutes/projects.ts 폐기 2026-06-24 — projects2(v6) 통합, 고아 v1 제거)
registerProjectV6Routes(app, verifier, {
  getProject: async (id) => {
    const p = await v6GetProject(id);
    return p ? { id: p.id, name: p.name, folder: p.folder } : undefined;
  },
  isProjectMember: (id, m) => v6IsProjectMember(id, m),
  listProjectMembers: (id) => v6ListProjectMemberIds(id),
  listProjectActivities: (id, a, l, o) => listProjectActivities(id, a, l, o),
  ensureFolder: async (project) => {
    const folder = await createProjectFolder(project.id);
    await v6SetProjectFolder(project.id, folder, { source: "web" });
    return folder;
  },
});
// 세션이력 회수·수집(#905 C1) — 트랜스크립트 델타 offset-CAS append + watermark. 캡처 훅(kit)이 POST 한다.
registerSessionLogRoutes(app, verifier);
// 감사로그 CSV 내보내기(#1309) — 관리탭 [감사 로그] 3탭의 "CSV 다운로드". capability(res.json 일괄)로는 담을 수
//  없는 무제한 행수를 keyset 커서로 스트리밍한다(상세·불변식은 audit-export-routes.ts 머리주석).
registerAuditExportRoutes(app, verifier);
// #1036 프리뷰 환경 — /preview/<id>/* 를 프리뷰 환경의 워크트리 public/ 로 정적 서빙(shared-proxy: /api 는 게이트웨이 자신).
//  express.json 이후·app.listen 이전. WS 불요(정적+REST 만)라 server 핸들 불필요.
registerPreviewRoutes(app, verifier);

const server = app.listen(PORT, () => {
  logger.info(`Lively gateway listening on :${PORT}/mcp`);
  // 부팅 하우스키핑(#1313 R17) — 종전 이 콜백의 ~120줄 .then 체인. 스텝 선언(이름·게이트·순서)·스키마 직렬
  //  체인(boot/schemas.ts)·LIVELY_NO_SCHEDULER 게이트 단일 판정은 전부 boot/housekeeping.ts 소유.
  runBootHousekeeping({ app, server, verifier });
});
// 포트 바인딩 실패(구 게이트웨이 미종료 등) → 마이그레이션 미실행 보장 + 즉시 종료(half-state 방지).
server.on("error", (err) => {
  logger.error({ err }, `listen failed on :${PORT} — 스키마 마이그레이션 미실행, 종료`);
  process.exit(1);
});
