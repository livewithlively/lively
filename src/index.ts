// ★★ 첫 import 고정(#1750 S1) — 셀프호스트 다중 워크스페이스 활성화 상태파일을 읽어 DB 접속을 앱 role 로
//  재배선한다. db/client.ts 가 모듈 로드 시점에 env 를 읽어 풀을 만들므로 **그 어떤 import 보다 먼저**여야
//  한다(ESM 은 import 순서대로 실행). 상태파일이 없으면 아무것도 하지 않는다(단일 워크스페이스 종전 그대로).
import "./boot/tenancy-env.js";
import express from "express";
import { BearerVerifier } from "./auth/bearer.js";
import { bearerWithResourceMetadata } from "./auth/http-auth.js";
import { oauthAuthorizationServer, clientSecretGate } from "./org/auth/oauth-router.js";
import { registerOAuthConsent } from "./org/auth/oauth-consent.js";
import { itemsPool } from "./db/client.js";
import { buildToolCandidates, registry } from "./capabilities/index.js";
import { installTenantBinding } from "./db/tenant-binding-boot.js";
import { tenantContextMiddleware } from "./org/tenant-middleware.js";
import { lookupWorkspace, workspaceForSession } from "./org/tenancy/registry.js";
import { setToolCandidates } from "./mcp/mcp-surface.js";
import { finishConsent, abandonConsent } from "./org/credentials/oauth-broker.js";
import { parseInstallCallback } from "./org/credentials/github-app.js";
import { buildInstallBundle } from "./org/delivery/publish.js";
import { domainmapWebhookRouter } from "./domainmap/webhook.js";
import { registerWebUi } from "./web.js";
import { killAttachedPtys } from "./terminal/terminal-pty.js";
import { registerProjectV6Routes } from "./project/project-routes.js";
import { registerSessionLogRoutes } from "./sessions/session-log-routes.js";
import { ee } from "./enterprise/registry.js"; // #1601 감사 CSV 내보내기는 Enterprise — 미탑재면 그 라우트가 없다
import { registerPreviewRoutes } from "./preview/routes.js";
import { getProject as v6GetProject, listProjectMemberIds as v6ListProjectMemberIds, setProjectFolder as v6SetProjectFolder } from "./v6/project-store.js";
import { isProjectMember as v6IsProjectMember } from "./v6/project-session-store.js";   // #1313 R21 — 멤버십 게이트는 세션 바인딩 모듈
import { listProjectActivities } from "./v6/project-activity-store.js";
import { createProjectFolder } from "./project/project-fs.js";
import { stateRoot } from "./ops/state-dir.js";
import { roots } from "./terminal/terminal-sessions.js";
import { readyReport } from "./ops/health.js";
import { readStageSync } from "./ops/stage-sync-status.js";   // #2116 — dev 동기가 막혔는지 밖에서 보이게
import { buildInfo } from "./build-info.js";
import { effectiveStoragePolicy } from "./org/policies/storage-policy.js";
import { registerMcpTransport } from "./boot/mcp-transport.js";
import { runBootHousekeeping, loadStoragePolicy } from "./boot/housekeeping.js";
import { loadEnterprise } from "./enterprise/load.js";
import { logger } from "./log.js";
import { shutdownGatewayWorkers } from "./apps/worker-service.js";

const PORT = Number(process.env.PORT ?? 8080);
// 바인드 주소(#250) — 기본은 종전과 동일한 전 인터페이스(회귀 없음). SG 같은 방화벽 계층이 없는 호스트
//  (사무실 macOS launchd 등)는 BIND_HOST=127.0.0.1 로 좁히고 노출은 tailscale serve 등 앞단에 맡긴다.
const BIND_HOST = process.env.BIND_HOST || "0.0.0.0";

// ── 프로세스 안전망(최대한 안 죽게) — launchd KeepAlive 와 함께 2중 방어. ──
//  unhandledRejection: 미처리 promise 거부로 프로세스가 통째로 죽지 않게 — 로그만 남기고 계속(요청 1건 실패 ≠ 전체 다운).
//  uncaughtException: 상태가 오염됐을 수 있으니 로그 후 종료 → launchd 가 즉시 새 프로세스로 재기동(깨끗한 상태).
process.on("unhandledRejection", (reason) => logger.error({ reason }, "unhandledRejection — 무시하고 계속"));
process.on("uncaughtException", (err) => {
  logger.error({ err }, "uncaughtException — 종료 후 재기동");
  try { killAttachedPtys(); } catch { /* noop */ }
  void shutdownGatewayWorkers().finally(() => process.exit(1));
  setTimeout(() => process.exit(1), 1_500).unref();
});
// 정상 종료(재배포 SIGTERM·Ctrl+C SIGINT) 시 attach node-pty 를 전부 kill 하고 나간다(#687). 안 하면 자식이 init 로
//  재부모화돼 PTY 를 영구 점유(고아). 재시작이 잦은 게이트웨이라 이게 없으면 매 배포가 PTY 를 흘린다.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => {
    logger.info({ sig }, "shutdown — attach PTY·앱 worker 정리 후 종료");
    try { killAttachedPtys(); } catch { /* noop */ }
    void shutdownGatewayWorkers().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_500).unref();
  });
}

// Enterprise(src/ee) 적재 — **툴 표면을 굳히기 전에** 끝나야 한다(EE capability 가 registry 에 합류할 기회).
//  ee 가 없으면(무료 배포판) 조용히 false 로 지나가고 코어 기능만 뜬다.
await loadEnterprise();

// 부팅 시 MCP 툴 후보 주입 — registry(정적) + db 직접등록. 웹 도구탭(org_tools)·검증(org_tool_upsert)·http_proxy 섀도잉 차단이 참조.
setToolCandidates(buildToolCandidates());

// 테넌트 바인딩(#1437) — **DB 를 처음 쓰기 전에** 꽂아야 한다. 미설정이면 no-op 이고(자가호스팅 기본),
//  값이 이상하면 여기서 던져 기동을 막는다(조용히 안 켜지면 그게 곧 유출이다).
console.log(`[boot] ${installTenantBinding()}`);

// #2165 — 게이트웨이 전용 능력 등록. 노드 에이전트 번들에서 DB·자격 코드를 떼어내기 위해 방향을 뒤집었다:
//  노드가 도달하는 모듈(terminal/sessions·project/project-provision)이 이 구현들을 **정적으로 import 하지 않고**,
//  게이트웨이인 여기가 부팅 때 꽂는다. 노드에선 아무도 등록하지 않으므로 그쪽은 종전대로 '없음' 분기를 탄다.
//  ⚠ 여기서 빠뜨리면 git 자격이 조용히 죽는다(사설 레포 clone·세션 자격 주입). 그래서
//   scripts/gateway-capabilities-wired.test.mjs 가 선언된 능력이 전부 등록되는지 소스로 못박는다.
{
  const { registerGatewayCapabilities } = await import("./sessions/gateway-capabilities.js");
  const { materializeMemberGit } = await import("./org/credentials/git-credential-materialize-gateway.js");
  const { resolveGitSecret, leaseGitSecretForNode } = await import("./org/credentials/git-credential-store.js");
  registerGatewayCapabilities({ materializeMemberGit, resolveGitSecret, leaseGitSecretForNode });
}

const app = express();

// ★★ 테넌트 컨텍스트를 **가장 바깥**에서 연다(#1437 v1 5단계). 라우터마다 붙이면 새로 만든 라우터가
//  빠지고, 빠뜨림이 곧 유출인 구조는 사람 규율로 못 지킨다. 웹훅(아래)보다도 앞이다 — 그 경로도
//  DB 를 쓴다. `LIVELY_TENANT_HEADER_SECRET` 이 없으면 아무것도 하지 않는다(자가호스팅 무회귀).
//  registry 모드(#1750 셀프호스트 다중 워크스페이스)에서는 x-lively-workspace 헤더를 등록부로 해석한다 —
//  해석기는 여기서 주입한다(미들웨어 모듈이 스토어를 직접 물면 계층이 꼬인다).
app.use(tenantContextMiddleware(process.env, lookupWorkspace, workspaceForSession));

// domainmap 웹훅(:7700 시절과 동일 경로) — 반드시 전역 express.json() '이전'에 마운트:
// HMAC 은 정확한 raw bytes 대상이라 JSON 파서가 스트림을 먼저 소비하면 검증이 영원히 실패한다.
// bearer 인증 밖(구 :7700 과 동일 — HMAC 자체가 fail-closed 인증). raw 파싱은 라우터 내부 소유.
app.use("/api/webhook", domainmapWebhookRouter());

app.use(express.json({ limit: "1mb" }));

const verifier = new BearerVerifier();
// /mcp 의 401 은 RFC 9728 resource_metadata 를 실어 인가서버를 가리킨다(#1473 T2 — 이게 없으면 챗 클라이언트가
//  로그인 지점을 못 찾는다). 공개 주소가 미설정이면 종전 401 그대로.
const auth = bearerWithResourceMetadata(verifier);

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
      paths: [stateRoot(), ...roots().map((r) => r.base)],
      thresholds: { warnPct: policy.disk_warn_pct, criticalPct: policy.disk_critical_pct },
    });
    // 배포 신원(#1289) — "지금 도는 게 몇 버전인가"를 밖에서 한 번에. 없으면 null 로 정직하게 낸다.
    //  비밀이 아닌 것만 싣는다(버전·커밋·빌드시각). 경로·env 는 싣지 않는다 — 이 응답은 미인증이다.
    // #2116 — dev 동기가 막혔나. **없는 설치가 대다수라 null 이면 아예 안 싣는다.**
    //  ⚠ 503 으로 만들지 않는다: 동기가 막힌 것은 '못 선다'가 아니라 '내용이 낡았다'이다(디스크 경고와 같은 등급).
    const sync = await readStageSync();
    const degraded = !!sync && !sync.ok;
    res.status(report.ok ? 200 : 503).json({
      ...report,
      ...(degraded && report.ok ? { status: "degraded" } : {}),
      ...(sync ? { stageSync: sync } : {}),
      build: buildInfo(),
    });
  } catch (err) {
    // 점검 자체가 터지면 '준비됨'이라 우길 근거가 없다 → fail-closed.
    logger.error({ err }, "readyz 점검 실패");
    res.status(503).json({ ok: false, status: "down" });
  }
});

// ── OAuth 2.1 인가서버(#1473 T2) — claude.ai 챗·ChatGPT 웹·Gemini Enterprise 를 여는 단일 열쇠. ──
//  그 표면들의 커넥터 UI 에는 Bearer·커스텀 헤더 입력란이 아예 없어(2026-08-04 실측) OAuth 가 유일한 경로다.
//  순서 — ① 동의 화면(/oauth/consent, 서버렌더) ② /token·/revoke 앞의 시크릿 게이트 ③ SDK 인가서버 라우터.
//  ②가 ③보다 **반드시** 먼저여야 한다: SDK 의 클라이언트 인증은 시크릿 평문 비교라 우리 해시 저장과 맞지 않아
//   우회시켜 두었고, 실제 검증은 이 게이트가 한다(oauth-clients.ts 머리주석 ★★). 빠지면 시크릿 검사가 사라진다.
//  ③은 앱 **루트**에 마운트해야 한다(SDK 요구) — 자기 경로가 아니면 즉시 통과시키므로 다른 라우트엔 무영향.
registerOAuthConsent(app);
// (계정 갈림길 /auth/link 는 #1601 로 Enterprise 로 옮겼다 — registerWebUi 안에서 ee().sso 훅이 등록한다.
//  동의 화면과 나란히 두던 자리였지만, SSO 신원이 있어야만 뜨는 화면이라 SSO 라우트와 함께 있는 편이 맞다.)
app.use(["/token", "/revoke"], express.urlencoded({ extended: false }), clientSecretGate());
app.use(oauthAuthorizationServer());

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
    //  GitHub App 은 설치 직후 installation_id 를 함께 보낸다(#1881 G5) — 숫자만 통과시킨다(그 값이 API 경로에 들어간다).
    const r = await finishConsent(String(q.state), String(q.code), undefined,
      { installationId: parseInstallCallback(q).installationId });
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
//  없는 무제한 행수를 keyset 커서로 스트리밍한다(상세·불변식은 ee/audit/export-routes.ts 머리주석).
//  ★ #1601 로 Enterprise 로 갔다 — 화면 집계(3탭)는 코어에 그대로 있고, 증빙 반출만 EE 다.
const auditExportHooks = ee().auditExport;
if (auditExportHooks) {
  auditExportHooks.registerAuditExportRoutes(app, verifier);
} else {
  // EE 미탑재 — 라우트가 없으면 express 기본 404(HTML)가 나가고 화면엔 "요청 실패 (404)" 만 뜬다.
  //  그러면 관리자는 필터를 바꿔가며 헤맨다. 무엇이 없어서 안 되는지 화면이 읽을 수 있게 JSON 으로 답한다
  //  (web/lib/net.ts 의 api() 가 응답 error 를 그대로 토스트에 쓴다).
  const eeRequired: express.RequestHandler = (_req, res) => {
    res.status(404).json({
      error: "감사 로그 CSV 내보내기는 Enterprise 모듈(src/ee)이 필요합니다 — 화면의 조회·집계는 그대로 쓰실 수 있습니다.",
    });
  };
  app.get("/api/ui/audit-export/plan", eeRequired);
  app.get("/api/ui/audit-export.csv", eeRequired);
}

// 자료 공개범위 정책(#1601) — capability 가 Enterprise 로 갔다(ee/capabilities/source-vis-policy.ts).
//  미탑재면 registry 에 op 가 없어 REST 경로가 통째로 안 생기고, 관리탭 [수집 ▸ 자료 공개범위] 패널은
//  express 기본 404 를 받아 "정책을 불러오지 못했습니다" 만 띄운다 — 기능이 EE 라서 없는 건지, 서버가
//  고장난 건지, 권한 문제인지 구분할 수 없다. 위 감사 export 와 **같은 처리**를 여기에도 준다.
//  ⚠ registry 조회로 조건을 건다: EE 가 있으면 capability 마운트가 이 경로를 가져가야 하므로,
//   무조건 등록하면 스텁이 진짜 기능을 가로챈다.
if (!registry.has("source_vis_policy_list")) {
  const eeRequired: express.RequestHandler = (_req, res) => {
    res.status(404).json({
      error: "자료 공개범위 정책은 Enterprise 모듈(src/ee)이 필요합니다 — 이미 설정된 정책은 그대로 계속 적용됩니다.",
      enterprise_required: true,
    });
  };
  app.get("/api/ui/source-vis-policy", eeRequired);
  app.get("/api/ui/source-vis-policy/targets", eeRequired);
  app.post("/api/ui/source-vis-policy", eeRequired);
  app.post("/api/ui/source-vis-policy/delete", eeRequired);
  app.post("/api/ui/source-vis-policy/backfill", eeRequired);
}
// #1036 프리뷰 환경 — /preview/<id>/* 를 프리뷰 환경의 워크트리 public/ 로 정적 서빙(shared-proxy: /api 는 게이트웨이 자신).
//  express.json 이후·app.listen 이전. WS 불요(정적+REST 만)라 server 핸들 불필요.
registerPreviewRoutes(app, verifier);

const server = app.listen(PORT, BIND_HOST, () => {
  logger.info(`Lively gateway listening on ${BIND_HOST}:${PORT}/mcp`);
  // 부팅 하우스키핑(#1313 R17) — 종전 이 콜백의 ~120줄 .then 체인. 스텝 선언(이름·게이트·순서)·스키마 직렬
  //  체인(boot/schemas.ts)·LIVELY_NO_SCHEDULER 게이트 단일 판정은 전부 boot/housekeeping.ts 소유.
  runBootHousekeeping({ app, server, verifier });
});
// 대용량 업로드(#1870 — 파일 상한 1GB): Node 기본 requestTimeout(5분)은 느린 회선의 1GB PUT 본문을 중간에 끊는다.
//  헤더 대기(headersTimeout 60초 기본)는 그대로라 slowloris 방어는 유지된다 — 본문 정지는 receiveUpload 의
//  무진행 타이머(#1272)가 따로 잡으므로, 여기는 '진행 중인 큰 본문'만 살리는 값이다.
server.requestTimeout = 60 * 60 * 1000;
// 포트 바인딩 실패(구 게이트웨이 미종료 등) → 마이그레이션 미실행 보장 + 즉시 종료(half-state 방지).
server.on("error", (err) => {
  logger.error({ err }, `listen failed on :${PORT} — 스키마 마이그레이션 미실행, 종료`);
  process.exit(1);
});
