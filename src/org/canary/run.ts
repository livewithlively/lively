// 카나리 실행 엔진 (#1657) — 프로브를 **실제 어댑터 경로 그대로** 태우고, 판정 결과를 남기고, 전이 시 경보한다.
//
//  ⚠ 왜 어댑터 경로를 그대로 타나: 우리가 알고 싶은 건 '구글이 살아 있나'가 아니라 **'우리 프록시를 통과해
//   고객이 쓰는 그 길이 살아 있나'** 다. 별도 HTTP 클라이언트로 상류를 직접 찌르면 자격 주입·SSRF·스크럽·
//   scope 게이트를 전부 건너뛰어, 정작 우리 쪽이 깨졌을 때 초록불이 된다.
import { callProxyTool } from "../../mcp/mcp-proxy.js";
import { runHttpProxyTool } from "../../mcp/dynamic-tools.js";
import { getTool } from "../store.js";
import { itemsPool } from "../../db/client.js";
import { logger } from "../../log.js";
import { sendBoxAlert } from "../../ops/alerts.js";
import { CANARY_PROBES, type CanaryProbe } from "./probes.js";
import { judgeProbe, evaluateStreak, alertTransition, type CanaryState } from "./judge.js";

/** 연속 실패 임계 — 이 횟수만큼 이어서 실패해야 경보한다. */
export const FAIL_THRESHOLD = 3;
/** 상태 판정에 보는 최근 결과 수. */
const RECENT_WINDOW = 10;

export interface ProbeRun { key: string; ok: boolean; reason: string | null; durationMs: number }

/** 프로브 1개 실행 — 어댑터 경로를 그대로 태워 {isError, text} 로 정규화한 뒤 판정에 넘긴다. */
export async function runProbe(probe: CanaryProbe, callerId: string): Promise<ProbeRun> {
  const started = Date.now();
  let raw: { isError: boolean; text: string };
  try {
    if (probe.adapter === "mcp_proxy") {
      const r = await callProxyTool(probe.target.server as string, probe.target.tool, probe.args, callerId);
      raw = { isError: r.isError, text: textOf(r.content) };
    } else {
      const tool = await getTool(probe.target.tool);
      if (!tool) raw = { isError: true, text: `org_tool '${probe.target.tool}' 이 없습니다(프리셋 미적용?)` };
      else if (!tool.enabled) raw = { isError: true, text: `org_tool '${probe.target.tool}' 이 꺼져 있습니다` };
      else {
        const r = await runHttpProxyTool(tool, probe.args, callerId);
        raw = { isError: !r.ok, text: r.body };
      }
    }
  } catch (err) {
    // 던진 실패도 실패다 — 판정을 거치지 않고 바로 사유로 남긴다(자격 없음·SSRF 차단·타임아웃 등).
    raw = { isError: true, text: (err as Error).message };
  }
  const v = judgeProbe(raw, probe.expect);
  return { key: probe.key, ok: v.ok, reason: v.reason, durationMs: Date.now() - started };
}

function textOf(content: unknown[]): string {
  return (content ?? [])
    .map((b) => {
      const blk = b as { type?: unknown; text?: unknown };
      return blk && blk.type === "text" && typeof blk.text === "string" ? blk.text : "";
    })
    .filter(Boolean).join("\n");
}

/** 최근 결과(최신 앞) — 상태 판정용. */
async function recentResults(key: string, limit = RECENT_WINDOW): Promise<boolean[]> {
  const r = await itemsPool.query("SELECT ok FROM canary_result WHERE probe_key=$1 ORDER BY ran_at DESC LIMIT $2", [key, limit]);
  return r.rows.map((row) => row.ok === true);
}

export interface CanaryRunSummary {
  ran: number; failed: number;
  probes: Array<{ key: string; label: string; adapter: string; tier: string; ok: boolean; reason: string | null; state: CanaryState; alerted: "raise" | "clear" | null }>;
}

/**
 * 전체(또는 지정) 프로브 1회전. 크론이 부르고, 관리자가 수동으로도 부른다.
 *  ⚠ 한 프로브가 터져도 나머지는 돈다 — 카나리가 자기 실패로 전체를 멈추면 그게 가장 나쁜 침묵이다.
 */
export async function runCanary(opts: { callerId: string; keys?: string[]; probes?: CanaryProbe[] }): Promise<CanaryRunSummary> {
  const list = (opts.probes ?? CANARY_PROBES).filter((p) => !opts.keys?.length || opts.keys.includes(p.key));
  const out: CanaryRunSummary = { ran: 0, failed: 0, probes: [] };
  for (const probe of list) {
    const before = evaluateStreak(await recentResults(probe.key).catch(() => []), FAIL_THRESHOLD).state;
    const run = await runProbe(probe, opts.callerId);
    out.ran++;
    if (!run.ok) out.failed++;
    try {
      await itemsPool.query(
        `INSERT INTO canary_result(probe_key, adapter, tier, ok, reason, duration_ms) VALUES($1,$2,$3,$4,$5,$6)`,
        [probe.key, probe.adapter, probe.tier, run.ok, run.reason, run.durationMs],
      );
    } catch (err) {
      logger.warn({ err, probe: probe.key }, "카나리 결과 저장 실패(판정은 유효)");
    }
    const after = evaluateStreak(await recentResults(probe.key).catch(() => [run.ok]), FAIL_THRESHOLD);
    const transition = alertTransition(before, after.state);
    if (transition) await notify(probe, run, after.state, after.failStreak, transition).catch((err) => logger.warn({ err }, "카나리 경보 전송 실패"));
    out.probes.push({ key: probe.key, label: probe.label, adapter: probe.adapter, tier: probe.tier, ok: run.ok, reason: run.reason, state: after.state, alerted: transition });
  }
  return out;
}

async function notify(probe: CanaryProbe, run: ProbeRun, state: CanaryState, failStreak: number, kind: "raise" | "clear"): Promise<void> {
  const raise = kind === "raise";
  await sendBoxAlert({
    severity: raise ? "critical" : "ok",
    title: raise ? `상류 커넥터 회귀: ${probe.label}` : `상류 커넥터 복구: ${probe.label}`,
    text: raise
      ? `${probe.label} 이(가) ${failStreak}회 연속 실패했습니다. ${probe.why}\n사유: ${run.reason ?? "(미상)"}`
      : `${probe.label} 이(가) 다시 정상입니다.`,
    detail: { probe: probe.key, adapter: probe.adapter, tier: probe.tier, state, fail_streak: failStreak, reason: run.reason },
  });
}

/** 프로브별 현재 상태 — 관리탭·에이전트 조회용. */
export async function canaryStatus(): Promise<Array<{ key: string; label: string; adapter: string; tier: string; state: CanaryState; failStreak: number; lastReason: string | null; lastRunAt: string | null }>> {
  const r = await itemsPool.query(
    `SELECT DISTINCT ON (probe_key) probe_key, ran_at, reason FROM canary_result ORDER BY probe_key, ran_at DESC`);
  const last = new Map(r.rows.map((row) => [row.probe_key as string, row]));
  const out = [];
  for (const p of CANARY_PROBES) {
    const s = evaluateStreak(await recentResults(p.key).catch(() => []), FAIL_THRESHOLD);
    const row = last.get(p.key);
    out.push({
      key: p.key, label: p.label, adapter: p.adapter, tier: p.tier,
      state: s.state, failStreak: s.failStreak,
      lastReason: (row?.reason as string) ?? null,
      lastRunAt: row?.ran_at ? new Date(row.ran_at as string).toISOString() : null,
    });
  }
  return out;
}
