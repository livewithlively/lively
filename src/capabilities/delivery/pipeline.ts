// delivery ▸ pipeline — 맥락 파이프라인 현황 한 번에(#1419 T6).
//
//  요구: "가시적으로 데이터 수집 - 증류 - 분류 - 관리의 파이프라인을 보고 그걸 관리할수있게."
//  화면이 4단계 현황을 그리려면 지금은 6~7군데를 따로 물어야 한다. 그러면 로딩이 계단식으로 들어오고
//  (숫자가 하나씩 튀어 오르고), 무엇보다 **단계 간 비교**가 불가능하다 — 파이프라인의 요점은
//  "어디가 막혔나"인데 그건 단계들을 **같은 시점에** 나란히 놓아야 보인다. 그래서 한 번에 준다.
//
//  scope: restWork(memory) — 읽기 현황이고 증류기·분류기·관리기 설정과 같은 워킹레벨이다.
import type { Capability } from "../types.js";
import { itemsPool, q } from "../../db/client.js";
import { listCollectors } from "../../org/store/collectors.js";
import { classifierCoverage, listClassifiers } from "../../org/store/classifiers.js";
import { managerOverview } from "../../org/store/managers.js";
import { restWork } from "./shared.js";

/** 한 숫자를 세는 작은 헬퍼 — 테이블이 없는 배포(구 스키마)에서도 0 으로 떨어진다. */
async function count(sql: string, params: unknown[] = []): Promise<number> {
  try { return Number((await q(itemsPool, sql, params))[0]?.n ?? 0); } catch { return 0; }
}

/** 한 단계의 실행 잡 — `null` 이면 **잡 자체가 없다**(설정만 하고 아무것도 안 돈다). */
export interface PipelineJob {
  id: string; enabled: boolean; interval_sec: number;
  last_run_at: string | null; last_status: string | null; any_enabled: boolean;
}
export interface PipelineOverview {
  stages: {
    collect: { configured: number; enabled: number; output: number; recent_24h: number; job: PipelineJob | null };
    distill: { configured: number; enabled: number; output: number; backlog: number; job: PipelineJob | null };
    classify: {
      configured: number; enabled: number; categories: number; no_definition: number;
      backlog: number; uncovered: number; pending_review: number; job: PipelineJob | null;
    };
    manage: {
      configured: number; enabled: number;
      open: { total: number; high: number; warn: number; note: number };
      by_kind: unknown[]; job: PipelineJob | null;
    };
  };
  gates: { knowledge_pending: number; classification_proposed: number };
}

/**
 * 4단계 현황을 한 번에 읽는다. **capability 핸들러 밖에서도 부를 수 있어야 해서** 함수로 빼 뒀다(#1631) —
 * 리브 홈이 같은 현황을 읽는데, 여기 쿼리를 복사해 가면 **세 번째 SoT** 가 생기고 두 화면이 다른 답을 한다
 * (#1618 이 잡아낸 실패가 정확히 그 모양이었다: 온보딩 화면과 파이프라인 화면이 서로 모순된 답을 줬다).
 */
export async function pipelineOverview(): Promise<PipelineOverview> {
  // ── ① 수집 ──
  const collectors = await listCollectors().catch(() => []);
  const sourcesTotal = await count(`SELECT count(*)::int AS n FROM source`);
  const last24 = await count(`SELECT count(*)::int AS n FROM source WHERE created_at >= now() - interval '24 hours'`);

  // ── ② 증류 — 미증류 자료(어느 지식에도 안 쓰인 원문)가 이 단계의 잔량. ──
  const undistilled = await count(
    `SELECT count(*)::int AS n FROM source s
      WHERE NOT EXISTS (SELECT 1 FROM knowledge_source ks WHERE ks.source_id = s.id)`);
  const distillers = await q(itemsPool, `SELECT id, key, label, enabled FROM org_distiller ORDER BY priority DESC, id`)
    .catch(() => [] as Array<Record<string, unknown>>);

  // ── ③ 분류 ──
  const classifiers = await listClassifiers().catch(() => []);
  const clsCov = await classifierCoverage().catch(() => ({ total_unclassified: 0, uncovered: 0, classifiers: [] }));
  const knowledgeTotal = await count(`SELECT count(*)::int AS n FROM knowledge WHERE lifecycle='active'`);
  const proposed = await count(
    `SELECT count(*)::int AS n FROM knowledge_category WHERE state='proposed'`);
  const categories = await count(`SELECT count(*)::int AS n FROM category`);
  const noDefinition = await count(`SELECT count(*)::int AS n FROM category WHERE COALESCE(should,'')=''`);

  // ── ④ 관리 ──
  const mgr = await managerOverview().catch(() => ({
    managers: 0, enabled: 0, open: { total: 0, high: 0, warn: 0, note: 0 }, by_kind: [],
  }));

  // ── 검토 대기(파이프라인 밖 큐지만 '막힘'으로 보여야 한다) ──
  const pendingReview = await count(`SELECT count(*)::int AS n FROM knowledge WHERE lifecycle='pending'`);

  // ── 크론 상태 — 각 단계가 **실제로 도는지**. 설정만 하고 잡을 안 켜서 아무것도 안 도는 것이
  //  이 제품의 대표적 실패 모드였다(#1289 실측: 슬랙 10,900건 중 증류 13건 — 원인은 크론 미등록). ──
  const jobs = await q(itemsPool,
    `SELECT id, action, enabled, interval_sec, last_run_at, last_status FROM org_cron`)
    .catch(() => [] as Array<Record<string, unknown>>);
  const jobFor = (actions: string[]) => {
    const found = jobs.filter((j) => actions.includes(String(j.action)));
    if (!found.length) return null;
    const on = found.find((j) => j.enabled === true) ?? found[0];
    return {
      id: String(on.id), enabled: on.enabled === true,
      interval_sec: Number(on.interval_sec ?? 0),
      last_run_at: on.last_run_at ? String(on.last_run_at) : null,
      last_status: on.last_status ? String(on.last_status) : null,
      any_enabled: found.some((j) => j.enabled === true),
    };
  };

  return {
    stages: {
      collect: {
        configured: collectors.length,
        enabled: collectors.filter((c) => c.enabled).length,
        output: sourcesTotal,
        recent_24h: last24,
        job: jobFor(["connector_sync"]),
      },
      distill: {
        configured: distillers.length,
        enabled: distillers.filter((d) => d.enabled === true).length,
        output: knowledgeTotal,
        backlog: undistilled,
        job: jobFor(["distill_sources_headless", "distill_sources"]),
      },
      classify: {
        configured: classifiers.length,
        enabled: classifiers.filter((c) => c.enabled).length,
        categories, no_definition: noDefinition,
        backlog: clsCov.total_unclassified,
        uncovered: clsCov.uncovered,
        pending_review: proposed,
        job: jobFor(["classify_knowledge_headless", "classify_knowledge"]),
      },
      manage: {
        configured: mgr.managers,
        enabled: mgr.enabled,
        open: mgr.open,
        by_kind: mgr.by_kind,
        job: jobFor(["run_managers"]),
      },
    },
    // 파이프라인 밖이지만 흐름을 막는 것 — 화면이 '검토 대기'로 표시한다.
    gates: { knowledge_pending: pendingReview, classification_proposed: proposed },
  };
}

export const pipelineCapabilities: Capability[] = [
  restWork("org_pipeline_overview", "맥락 파이프라인 현황",
    "수집 → 증류 → 분류 → 관리 4단계의 처리량·잔량·막힘을 한 번에 반환한다. 맥락 관리 탭의 파이프라인 화면이 읽는다. " +
    "각 단계는 { 설정된 것 수 · 켜진 것 수 · 산출물 수 · 잔량(아직 다음 단계로 못 간 것) · 막힘 사유 }.",
    [{ method: "GET", paths: ["/api/ui/org/pipeline"], parse: () => ({}) }],
    async () => pipelineOverview()),
];
