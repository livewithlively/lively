// 부팅 하우스키핑(#1313 R17) — app.listen 콜백의 ~120줄 .then 체인을 이름 있는 스텝 선언 배열로 승격.
//  실행 순서 = 배열 순서 그대로(종전 .then 체인과 동일). 각 스텝의 원문 주석은 스텝 선언 위로 이사.
//  게이트 2종:
//   · gate:'scheduler' — LIVELY_NO_SCHEDULER=1 이면 건너뜀(단일 프로세스 전제 하우스키핑). 판정은 schedulerEnabled() 한 곳
//     (종전 index.ts 인라인 if 6곳을 단일화).
//   · DB_BOOT_STEPS 전체 — ITEMS_DATABASE_URL 없으면 체인 자체를 돌리지 않는다(종전 if 블록과 동일).
import type express from "express";
import type { Server } from "node:http";
import type { BearerVerifier } from "../auth/bearer.js";
import { itemsPool } from "../db/client.js";
import { reapDeviceAuth } from "../org/auth/device-auth.js";
import { reapOAuth } from "../org/store/oauth.js";
import { initAllSchemas } from "./schemas.js";
import { ensureSelfRls } from "../db/self-rls.js";
import { seedDefaultContent } from "../org/delivery/seed-content.js";
import { runAutoBackfillSweep } from "../v6/embedding-backfill.js";
import { registerTerminal } from "../terminal/routes.js";
import { liveAttachCount, scanAttachProcs } from "../terminal/terminal-pty.js";
import { selfPtmxFdCount } from "../terminal/host-pty.js";
import { setupNodeUpgrade } from "../node/registry.js";
import { startTaskScheduler } from "../node/task-scheduler.js";
import { backfillMarkerSync, backfillSharedGroupWrite } from "../project/project-fs.js";
import { startScheduler } from "../scheduler/index.js";
import { ensureStateDirs, stateRoot } from "../ops/state-dir.js";
import { ROOTS, SHARED_ROOT } from "../terminal/terminal-sessions.js";
import { startLogJanitor } from "../ops/log-janitor.js";
import { startCallLogPrune } from "../org/policies/call-log-prune.js";
import { effectiveStoragePolicy } from "../org/policies/storage-policy.js";
import { loadStoragePolicy, loadCallLogPolicy } from "../org/policies/runtime-loaders.js";
import { getRuntimeConfig } from "../org/store.js";
import { reapSessionLogs, backfillSessionTitles } from "../v6/session-log-store.js";
import { reapIdleSessions } from "../sessions/session-reaper.js"; // #1059 F — idle 세션 자동 회수(정책 0=끔 기본)
import { backfillSessionStates } from "../sessions/session-state-backfill.js"; // #1059 F 후속 — 레코드 없는 라이브 세션에 desired-state 미러
import { ensureSharedCache } from "../ops/build-cache.js";
import { startBoxWatch } from "../ops/box-watch.js";
import { sendBoxAlert } from "../ops/alerts.js";
import { recoverOrphanConnectorRuns } from "../connectors/run-tracker.js";
import { migrateConnectorsToCollectors } from "../org/store/collectors.js"; // #1419 T1 — 레거시 커넥터 → 수집기 승격(멱등)
import { logger } from "../log.js";

// 스케줄러 게이트 단일 판정(#1313 R17) — 종전 인라인 `process.env.LIVELY_NO_SCHEDULER !== "1"` 6곳을 한 곳으로.
//  배경(왜 게이트인가)은 'scheduler' 스텝 원문 주석 참조.
const schedulerEnabled = (): boolean => process.env.LIVELY_NO_SCHEDULER !== "1";

// 저장소·감사로그 정책 로더는 org/policies/runtime-loaders 로 수렴(#1313 R46 — terminal/sessions.ts 의 인라인
//  람다와 byte-identical 복붙이었다). index.ts 가 여기서 loadStoragePolicy 를 받아가므로 재수출로 표면을 유지한다.
export { loadStoragePolicy };

export type BootGate = "always" | "scheduler";
export interface BootContext {
  app: express.Express;
  server: Server;
  verifier: BearerVerifier;
}
export interface BootStep {
  name: string;
  gate: BootGate;
  run: (ctx: BootContext) => void | Promise<unknown>;
}

// ── listen 직후 동기 배선(DB 무관) — 종전 listen 콜백 본문 선두와 동일 순서·즉시 실행. ──
export const LISTEN_STEPS: BootStep[] = [
  // 런타임 쓰기 루트(#618) 보장 — 서비스 유저 소유 <cwd>/data 하위 디렉을 부팅 시 멱등 생성(스캐너 repos·notion-assets 등).
  //  DB 무관·비치명이라 스키마 체인 밖에서 즉시. 개별 기능도 각자 mkdir 하지만 여기서 '단일 지점' 보장(재발방지).
  { name: "state-dirs", gate: "always", run: () => { ensureStateDirs().catch((err) => logger.warn({ err }, "state dir ensure 실패(비치명)")); } },
  // 중앙 박스 도그푸드 — ttyd 터미널을 정문 뒤로 프록시(/terminal). server 핸들(upgrade)이 필요해 listen 후 배선.
  { name: "terminal-proxy", gate: "always", run: ({ app, server, verifier }) => registerTerminal(app, server, verifier) },
  // 분산 노드(#869) — 노드 에이전트의 아웃바운드 WSS(/node/ws) 수신. 노드는 포트를 열지 않는다(단일 정문 유지).
  { name: "node-upgrade", gate: "always", run: ({ server }) => setupNodeUpgrade(server) },
];

// ── DB 부팅 직렬 체인(ITEMS_DATABASE_URL 필요) — 종전 .then 체인과 동일 순서. 스텝 하나가 throw 하면
//    뒤 스텝은 돌지 않는다(runBootHousekeeping 의 단일 catch — 종전 체인 말미 .catch 와 동일 시맨틱). ──
export const DB_BOOT_STEPS: BootStep[] = [
  // 스키마 직렬 체인(item→org→domainmap→v6) — 순서 규약·원문 주석은 boot/schemas.ts(단일 출처).
  { name: "schemas", gate: "always", run: () => initAllSchemas() },
  // #1291 v3 — self 소스 행 단위 공개범위(롤·스코프테이블·정책). v6 스키마 뒤여야 대상 테이블이 존재한다.
  //  실패해도 부팅을 막지 않는다(그 경우 self 는 v2 처럼 '잠긴 맥락이 있으면 닫힘'으로 폴백).
  { name: "self-rls", gate: "always", run: () => ensureSelfRls().then((ok) => logger.info({ rowLevel: ok }, "self 소스 공개범위 준비됨")) },
  // 프로비저닝 디폴트 콘텐츠 시딩(#713) — 코드가 이름으로 전제하는 지식·훅·스킬(예: 모든 프로젝트 AGENTS.md 가
  //  가리키는 project-closeout 스킬(#878), 도메인맵 is-부트스트랩 런북 2개, 커스텀훅·스킬)을 신규 게이트웨이에
  //  idempotent 주입한다(없을 때만 — 운영자 토글·편집 보존). org(훅·스킬)+v6(지식) 스키마가 모두 준비된 뒤. 비치명.
  { name: "seed-default-content", gate: "always", run: () => seedDefaultContent().catch((err) => logger.warn({ err }, "디폴트 콘텐츠 시딩 실패(비치명)")) },
  // 구 마커 sync 백필(#905 P1-②) — 이 박스가 만든 프로젝트 폴더의 .lively/project.json 에 sync:"pull" 을 stamp.
  //  pull 훅이 '이 폴더에 서버 파일을 써도 되나'를 마커의 sync 로 판정하게 됐는데, sync 없는 구 마커의 폴백은
  //  ~/lively/projects/<id>(꼴 고정) 만 인정한다 — 박스 폴더는 folder 가 임의(예: 'project/관리탭 수정')라
  //  구조로 못 알아본다. 자기 폴더를 아는 서버가 여기서 명시한다. 멱등(이미 sync 있으면 무시)·비치명.
  //  DB 무관(순수 fs)이라 스키마 체인 어디에 붙어도 되지만, 세션이 붙기 전 초기에 한 번 도는 게 목적이다.
  { name: "marker-sync-backfill", gate: "always", run: () => backfillMarkerSync()
      .then((r) => { if (r.stamped) logger.info(r, "프로젝트 마커 sync 백필(구 마커에 sync:pull stamp)"); })
      .catch((err) => logger.warn({ err }, "마커 sync 백필 실패(비치명) — 해당 폴더는 자동 pull 이 멈출 수 있음(파일 파괴 아님)")) },
  // 공유폴더 그룹권한 소급 보정(#1246) — 이 수정 전에 게이트웨이가 만든 하위 폴더/파일(755/644, 그룹 w 없음)을
  //  고쳐 box_ 격리 세션이 쓸 수 있게 한다. 격리 박스(Linux+box-spawn)에서만, find 백그라운드(부팅 안 막음)·비치명.
  { name: "shared-group-write-backfill", gate: "always", run: () => { try { if (backfillSharedGroupWrite()) logger.info("공유폴더 그룹권한 소급 보정 시작(백그라운드 find)"); } catch (err) { logger.warn({ err }, "공유폴더 그룹권한 소급 보정 실패(비치명)"); } } },
  // 부팅 스윕(#586) — 재시작으로 추적이 끊긴 connector_run 잔재 정리(유령 running 이 새 싱크를 막지 않게).
  //  스케줄러 기동 **전**에 — 크론 첫 tick 이 유령 행에 막히지 않도록.
  { name: "orphan-connector-run-sweep", gate: "always", run: () => recoverOrphanConnectorRuns().catch((err) => logger.warn({ err }, "부팅 스윕 실패(비치명) — 유령 run 은 하트비트 정리로 수렴")) },
  // 수집기 마이그레이션(#1419 T1) — 레거시 org_connector 1행/시스템을 org_collector 기본 인스턴스로 승격.
  //  멱등(이미 있으면 no-op)이라 매 부팅 돌아도 안전하고, 원본 행은 지우지 않아 롤백 가능하다.
  //  ⚠ **스케줄러 기동 전**에 — 크론 첫 tick 이 구 잡(sync-<system>)과 새 잡(collector-<id>)을 동시에 보면
  //   같은 소스를 두 번 긁는다. 마이그레이션이 구 잡을 끄고 나서 스케줄러가 떠야 그 창이 없다.
  { name: "collector-migration", gate: "always", run: () => migrateConnectorsToCollectors()
      .then((r) => { if (r.migrated.length) logger.info({ migrated: r.migrated }, "레거시 커넥터 → 수집기 마이그레이션 완료"); })
      .catch((err) => logger.warn({ err }, "수집기 마이그레이션 실패(비치명) — 레거시 커넥터 경로로 계속 동작")) },
  // 스키마 직렬 체인 완료 후 인프로세스 스케줄러 기동(org_cron 테이블 보장됨) — 서버사이드 cron 트리거.
  //  ⚠ 스케줄러는 단일 프로세스 전제(리더선출 없음) — 보조/검증 인스턴스는 LIVELY_NO_SCHEDULER=1 로 꺼서
  //   라이브 게이트웨이와 org_cron tick 이 중복(동일 잡 동시 실행)되지 않게 한다. 같은 DB 를 공유하는 스모크용.
  { name: "scheduler", gate: "scheduler", run: () => startScheduler() },
  // 위탁 태스크 스케줄러(P2 #869) — org_task 큐를 노드 리소스와 대조 배치·감시·재스케줄. 같은 단일 프로세스 게이트.
  { name: "task-scheduler", gate: "scheduler", run: () => startTaskScheduler() },
  // 로그 재니터(#813 T4) — logs/ 의 로그가 상한(관리탭 저장소 정책)을 넘으면 copytruncate 로 회전한다.
  //  유닛이 append 로 무한히 쓰는 구조라(systemd StandardOutput=append) 이게 없으면 상한이 없다.
  //  스케줄러와 같은 게이트: 하우스키핑은 단일 프로세스 전제 — 두 인스턴스가 같은 파일을 동시에 copytruncate 하면 꼬인다.
  { name: "log-janitor", gate: "scheduler", run: () => startLogJanitor(loadStoragePolicy) },
  // 호출 감사로그 prune(#1082) — mcp_call_log 를 보존기간(관리탭) 밖까지만 남긴다. 도입 이래 무기한 쌓이던 표라
  //  기간 정책이 없으면 개인 단위 활동 기록이 박스 수명 내내 축적된다. 같은 단일 프로세스 게이트(중복 DELETE 방지).
  { name: "call-log-prune", gate: "scheduler", run: () => startCallLogPrune(loadCallLogPolicy) },
  // 공유 빌드 캐시(#813 T3) — 세션이 쓸 캐시 디렉터리를 그룹쓰기(2775)로 미리 보장한다.
  //  멤버별 격리 OS 유저(#524)들이 같은 캐시를 써야 하므로 권한이 중요하다. 비치명(툴이 각자 만들기도 한다).
  { name: "shared-build-cache", gate: "always", run: ensureSharedBuildCache },
  // 박스 감시 + 경보(#813) — 디스크·DB 상태가 **바뀔 때만** 로그하고, 등록된 웹훅으로 **밀어서** 알린다.
  //  2026-07-13 사고의 본질은 "디스크가 찼다"가 아니라 **"아무도 몰랐다"** 였다 — /readyz·관리탭은 가서 봐야 알고
  //  로그는 아무도 안 본다. 웹훅 미설정이면 send 는 조용히 no-op(로그는 그대로 남는다).
  //  스케줄러와 같은 게이트(단일 프로세스 하우스키핑 — 두 인스턴스가 같은 경보를 중복 발송하면 안 된다).
  { name: "box-watch", gate: "scheduler", run: startBoxWatchStep },
  // 자동 pending 임베딩 백필(#669) — 부팅 30초 후 1회(배포/업데이트 직후 잔량 자가치유 — 30초는 사이드카
  //  Ollama 동시 부팅 박스의 헬스 확보 여유) + 10분 주기(미러 리셋·훅 실패 잔량 흡수; sync 완료 트리거의 폴백).
  //  provider off 면 설정 조회 후 no-op. 스케줄러와 같은 게이트 — 스모크 인스턴스(LIVELY_NO_SCHEDULER=1,
  //  같은 DB 공유)가 라이브와 중복 스윕(같은 행 이중 임베딩)하지 않게.
  { name: "background-sweeps", gate: "scheduler", run: startBackgroundSweeps },
];

async function ensureSharedBuildCache(): Promise<void> {
  const sp = await effectiveStoragePolicy(loadStoragePolicy);
  await ensureSharedCache(SHARED_ROOT.base, {
    enabled: sp.shared_cache_enabled,
    relocateHome: sp.shared_cache_relocate_home,
  });
}

function startBoxWatchStep(): void {
  startBoxWatch({
    pool: itemsPool,
    paths: () => [stateRoot(), ...ROOTS.map((r) => r.base)],
    loadThresholds: async () => {
      const sp = await effectiveStoragePolicy(loadStoragePolicy);
      return { warnPct: sp.disk_warn_pct, criticalPct: sp.disk_critical_pct };
    },
    // #1059 — 메모리 경보 임계(사용%, 0=끔). box-watch 가 디스크와 같은 채널로 push.
    loadMemThresholds: async () => {
      const sp = await effectiveStoragePolicy(loadStoragePolicy);
      return { warnPct: sp.mem_warn_pct, criticalPct: sp.mem_critical_pct };
    },
    // #687 후속 — PTY 슬롯 경보(기본 켬 70/85). 고갈되면 ssh 접속까지 막혀 원격 복구가 불가능해지므로
    //  디스크·메모리보다 이르게 알린다. attachCount 는 '누수 vs 실사용' 판별 힌트로 경보 본문에 실린다.
    loadPtyThresholds: async () => {
      const sp = await effectiveStoragePolicy(loadStoragePolicy);
      return { warnPct: sp.pty_warn_pct, criticalPct: sp.pty_critical_pct };
    },
    attachCount: () => liveAttachCount(),
    // 누수 관측 — 장부(liveTerms)가 아니라 실제로 열린 fd·살아있는 자식을 센다. 둘의 차이가 곧 회수 실패분이고,
    //  시스템 전체 사용량과 달리 박스 규모(멤버 세션·ssh)에 흔들리지 않는다. 고아(PPID=1)는 자식 게이트에
    //  원리적으로 안 걸리는 별개 축이라 같은 ps 스캔에서 함께 센다(#687 버그B — 안 세면 0 으로 보인다).
    leakProbe: async () => {
      const procs = await scanAttachProcs();
      return { ptmxFd: selfPtmxFdCount(), attachChildren: procs ? procs.children : null, orphanAttach: procs ? procs.orphans : null };
    },
    send: async (a) => (await sendBoxAlert(a)).sent,
  });
}

function startBackgroundSweeps(): void {
  setTimeout(() => { void runAutoBackfillSweep(); }, 30_000).unref();
  setInterval(() => { void runAutoBackfillSweep(); }, 600_000).unref();
  // #880 device-auth reaper — 만료 1h 경과 pending 행 정리(user_code 회수). start/poll 이 lazy 백업도 함.
  setInterval(() => { void reapDeviceAuth().catch(() => { /* best-effort */ }); }, 600_000).unref();
  // #1473 T2 OAuth reaper — 만료된 인가요청·인가코드 정리. 리프레시는 회전 사슬(도난 탐지 근거)이라 더 오래 둔다.
  setInterval(() => { void reapOAuth().catch(() => { /* best-effort */ }); }, 600_000).unref();
  // #905 C1 — 세션이력 retention reap: session_share.retention_days 지나도록 손대지 않은 로그·청크 정리
  //  (session 레코드는 불멸). retention_days=0 이면 no-op. 일 단위 보존이라 6h 주기로 충분.
  setInterval(() => {
    void getRuntimeConfig().then((c) => reapSessionLogs(c.session_share.retention_days)).catch(() => { /* best-effort */ });
  }, 6 * 60 * 60_000).unref();
  // #905 C1 — 제목 컬럼 도입(슬⑤b) 전 캡처/백필된 세션의 title 소급 채움(부팅 35초 후 1회, 멱등). 다 채우면 no-op.
  setTimeout(() => { void backfillSessionTitles().catch(() => { /* best-effort */ }); }, 35_000).unref();
  // #1059 F — idle 세션 자동 회수(reaper). 정책(session_reclaim_policy) 0=끔이 기본이라 켜기 전엔 no-op.
  //  5분 주기(회수는 tmux kill 로 싸다). 켜지면 오래 idle 인 세션을 desired-state 보존하며 회수 → restorable(E lazy resume).
  //  ⚠ 부팅 직후 즉시 돌리지 않는다 — 재부팅 복원(E)과 겹쳐 갓 뜬 세션을 오판하지 않게 첫 tick 은 주기 뒤.
  //  ⚠ 회수 **전에** 백필한다 — 레코드가 없는 구세션은 회수 면역이면서(불변식 ④) 죽으면 복원도 안 된다.
  //   백필이 먼저 돌면 그 세션들이 '회수해도 복원 가능한' 상태가 되어 F 가 실제로 작동한다(고객사 A 실측:
  //   라이브 38건 중 19건이 레코드 없음 = 회수 면역). 판정 시각은 tmux 메타(작업·열람)를 그대로 쓰므로
  //   갓 백필한 세션이 곧바로 회수되지는 않는다(활동이 최근이면 보존).
  setInterval(() => {
    void backfillSessionStates()
      .catch((err) => logger.warn({ err }, "session-state 백필 tick 실패"))
      .then(() => reapIdleSessions())
      .catch((err) => logger.warn({ err }, "session-reaper tick 실패"));
  }, 5 * 60_000).unref();
  // 부팅 직후 1회 백필(회수는 하지 않는다 — 재부팅 복원과 겹쳐 갓 뜬 세션을 오판하지 않게). 40초 뒤: 스키마·tmux 안정 후.
  setTimeout(() => { void backfillSessionStates().catch((err) => logger.warn({ err }, "session-state 백필(부팅) 실패")); }, 40_000).unref();
}

// listen 콜백에서 호출 — LISTEN_STEPS 를 동기 배선한 뒤 DB 부팅 직렬 체인을 비동기로 돌린다.
// 스키마 보장(비치명적) — **포트 바인딩 성공 후에만** 실행. 파괴적 마이그레이션(예: DROP COLUMN)이 EADDRINUSE
//  (구 게이트웨이 미종료) 상황에서 구코드 밑의 컬럼을 떨어뜨리지 않게: listen 성공 = 포트 소유 확보 = 구 인스턴스 부재.
//  스키마 순서 규약(직렬 체인 이유)은 boot/schemas.ts 참조. listen 성공 후 실행 불변식 유지.
export function runBootHousekeeping(ctx: BootContext): void {
  for (const step of LISTEN_STEPS) {
    if (step.gate === "scheduler" && !schedulerEnabled()) continue;
    void step.run(ctx);
  }
  if (!process.env.ITEMS_DATABASE_URL) return;
  (async () => {
    for (const step of DB_BOOT_STEPS) {
      if (step.gate === "scheduler" && !schedulerEnabled()) continue;
      await step.run(ctx);
    }
  })().catch((err) => logger.error({ err }, "schema init failed"));
}
