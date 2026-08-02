// 크론 액션: 커넥터 sync/push·위키 push — R16 에서 scheduler runJob if-체인 본문을 원문 이동.
import { itemsPool, q } from "../../db/client.js";

// sync 대상 커넥터 — 관리탭에서 켠 것(org_connector.enabled=true, #541) 우선.
//  비었으면(마이그레이션 전) 기존 data_source.status='active' 로 폴백 — 하위호환 무중단.
async function activeConnectorSystems(): Promise<string[]> {
  try {
    const on = await q(itemsPool, `SELECT system FROM org_connector WHERE enabled=true`);
    if (on.length) return on.map((r) => r.system);
    const rows = await q(itemsPool, `SELECT system FROM data_source WHERE status='active'`);
    return rows.map((r) => r.system);
  } catch { return []; }
}

export async function runConnectorSync(params: Record<string, unknown>): Promise<{ status: string; summary: unknown }> {
  // #586 run-tracker 경유 — 실행이 connector_run 엔티티로 기록되고(상태·로그·통계) 웹에서 관찰 가능.
  //  크론은 완주를 기다려 잡 상태에 결과를 남긴다(타임아웃·중복 가드는 tracker 내부).
  const { startConnectorRun } = await import("../../connectors/run-tracker.js");
  const systems = params.system ? [String(params.system)] : await activeConnectorSystems();
  const out: unknown[] = [];
  for (const sys of systems) {
    try {
      // params.full=true → 전체 재수집(일일 full 스윕 잡 — 증분 델타가 못 보는 것들의 수렴 경로 #586).
      const run = await startConnectorRun(sys, { trigger: "cron", full: params.full === true });
      if (run.alreadyRunning) { out.push({ system: sys, ok: true, skipped: "already_running", run_id: run.runId }); continue; }
      const r = await run.done;
      out.push({ system: sys, ok: r.ok, run_id: run.runId, exit_code: r.exitCode });
    } catch (e) { out.push({ system: sys, ok: false, error: (e as Error)?.message ?? String(e) }); }
  }
  // #669 sync 완료 후 임베딩 잔량 스윕(백그라운드·중복 자체 거부) — 미러가 남긴 pending(신규·제목/본문 변경 리셋)을
  //  10분 주기 스윕을 기다리지 않고 곧바로 흡수. 실패는 삼킨다(다음 주기/다음 sync 가 또 돈다).
  void import("../../v6/embedding-backfill.js").then((m) => m.runAutoBackfillSweep()).catch(() => {});
  return { status: "ok", summary: { systems: out } };
}

export async function runConnectorPush(params: Record<string, unknown>): Promise<{ status: string; summary: unknown }> {
  // 아웃바운드 — external_outbox(우리 편집) 드레인 → 외부 PM 미러. connector_sync 와 대칭(검증된 run-push CLI 서브프로세스).
  //  우리 DB=master 라 push 는 additive(외부 미러 생성/갱신) — 우리 데이터엔 무영향. params.system 없으면 active 전체.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileP = promisify(execFile);
  const systems = params.system ? [String(params.system)] : await activeConnectorSystems();
  const out: unknown[] = [];
  for (const sys of systems) {
    try {
      const r = await execFileP("node", ["--env-file-if-exists=.env", "dist/connectors/run-push.js", sys],
        { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
      out.push({ system: sys, ok: true, tail: (r.stdout || "").trim().split("\n").slice(-1)[0] ?? "" });
    } catch (e) { out.push({ system: sys, ok: false, error: (e as Error)?.message ?? String(e) }); }
  }
  return { status: "ok", summary: { systems: out } };
}

export async function runWikiPush(): Promise<{ status: string; summary: unknown }> {
  // 위키 아웃바운드 — 등록 노션 feed_target 로 정본 지식 투영(카드). connector_push 의 위키판, 검증된 run-wiki-push CLI 서브프로세스.
  //  옵트인: feed_target·category_feed 매핑 없으면 CLI 가 즉시 무동작 종료. 멱등(content_hash skip) — 반복 실행 안전.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileP = promisify(execFile);
  try {
    const r = await execFileP("node", ["--env-file-if-exists=.env", "dist/connectors/run-wiki-push.js"],
      { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
    return { status: "ok", summary: { tail: (r.stdout || "").trim().split("\n").slice(-1)[0] ?? "" } };
  } catch (e) { return { status: "error", summary: { error: (e as Error)?.message ?? String(e) } }; }
}
