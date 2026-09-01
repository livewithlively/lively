// org ▸ 맥락 파이프라인 현황 계산 — 수집→증류→분류→관리 4단계의 처리량·잔량·막힘.
//
//  ⚠ 왜 capabilities/ 가 아니라 여기인가(R9): 이 계산을 **온보딩(org/delivery/onboarding.ts)도** 읽어야
//   하는데, 스토어 계층(org/·v6/)은 MCP 표면(capabilities/)을 상향 import 할 수 없다(check-imports 게이트).
//   계산을 표면에 두면 온보딩이 같은 것을 다시 세게 되고 그 순간 **세 번째 진실**이 생긴다 — 화면·REST·
//   온보딩이 서로 다른 숫자를 말하는 상태. 감사에서 나온 실제 사고가 그 모양이었다(온보딩 "5/5 완료" vs
//   파이프라인 화면 "3단계 확인 필요"). 그래서 계산은 스토어에 두고, 표면(capability)은 내려와서 부른다.
import { itemsPool, q } from "../../db/client.js";
import { listCollectors } from "./collectors.js";
import { classifierCoverage, listClassifiers } from "./classifiers.js";
import { managerOverview } from "./managers.js";
import { PLACEHOLDER_MARK } from "../liv/lane-skeleton.js";

/** 한 숫자를 세는 작은 헬퍼 — 테이블이 없는 배포(구 스키마)에서도 0 으로 떨어진다. */
async function count(sql: string, params: unknown[] = []): Promise<number> {
  try { return Number((await q(itemsPool, sql, params))[0]?.n ?? 0); } catch { return 0; }
}

/** 잡 상태 한 조각 — 이 단계가 **실제로 도는가**. any_enabled 가 그 판정의 핵심이다. */
export interface PipelineJob {
  id: string; enabled: boolean; interval_sec: number;
  last_run_at: string | null; last_status: string | null; any_enabled: boolean;
}
export interface PipelineOverview {
  stages: {
    collect: { configured: number; enabled: number; output: number; recent_24h: number; job: PipelineJob | null };
    distill: { configured: number; draft: number; total: number; enabled: number; output: number; backlog: number; job: PipelineJob | null };
    classify: { configured: number; enabled: number; categories: number; no_definition: number;
      backlog: number; uncovered: number; pending_review: number; job: PipelineJob | null };
    manage: { configured: number; enabled: number; open: any; by_kind: any; job: PipelineJob | null };
  };
  gates: { knowledge_pending: number; classification_proposed: number };
}

/**
 * 4단계 현황 계산 — 이 파일이 그 **단일 출처**다.
 *
 * ⚠ capability 핸들러 안에 인라인으로 두지 않는다(#1618 후속): 온보딩도 "파이프라인이 돌고 있나"를
 *  물어야 하는데, 그쪽이 같은 것을 다시 세면 **세 번째 진실**이 생긴다(화면·REST·온보딩이 서로 다른
 *  숫자를 말하는 상태). 감사에서 나온 실제 사고가 정확히 그 모양이었다 — 온보딩은 "5/5 완료"라 하고
 *  파이프라인 화면은 "3단계 확인 필요"라 했다. 계산은 여기 한 번, 소비는 여러 곳.
 */
export async function computePipelineOverview(): Promise<PipelineOverview> {
      // ── ① 수집 ──
      const collectors = await listCollectors().catch(() => []);
      const sourcesTotal = await count(`SELECT count(*)::int AS n FROM source`);
      const last24 = await count(`SELECT count(*)::int AS n FROM source WHERE created_at >= now() - interval '24 hours'`);

      // ── ② 증류 — 미증류 자료(어느 지식에도 안 쓰인 원문)가 이 단계의 잔량. ──
      const undistilled = await count(
        `SELECT count(*)::int AS n FROM source s
          WHERE NOT EXISTS (SELECT 1 FROM knowledge_source ks WHERE ks.source_id = s.id)`);
      //  ⚠ criteria_md 도 읽는다 — 처음 설정이 만든 **뼈대**는 기준이 자리표뿐이라 켜도 쓸 수 없다.
      //   그걸 «설정됨» 으로 세면 화면이 «7개 다 있고 2개만 꺼둠» 으로 보이는데, 실제로는 5개가 미완성이다
      //   (실측 2026-08-31: 자료 12건이 그 5개 몫이라 아무도 안 집었다). 세는 축을 갈라 사실대로 말한다.
      const distillers = await q(itemsPool, `SELECT id, key, label, enabled, criteria_md FROM org_distiller ORDER BY priority DESC, id`)
        .catch(() => [] as Array<Record<string, unknown>>);
      const isDraft = (d: Record<string, unknown>): boolean => String(d.criteria_md ?? "").includes(PLACEHOLDER_MARK);
      const draftCount = distillers.filter(isDraft).length;

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
            //  configured 는 «쓸 수 있는 것» 만 센다 — 기준이 자리표뿐인 뼈대는 켜도 증류를 못 한다.
            //  draft 를 따로 내보내 화면이 «미완성 N» 을 말할 수 있게 한다(#1631).
            configured: distillers.length - draftCount,
            draft: draftCount,
            total: distillers.length,
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

/**
 * '지금 막힌 단계' 이름만 — **셋업이 끝났는지 판정**하는 표면(온보딩)이 쓴다.
 *
 * ⚠ 화면(web/context-pipeline.ts)의 단계별 상태 문장과 **같은 값이 아니다.** 그쪽은 "지금 어디가
 *  막혔나"를 사람에게 설명하는 자리라 참고(note)·주의(warn)까지 등급을 나눠 말한다. 여기는
 *  "이 조직은 아직 셋업 중인가"만 묻는 좁은 질문이라, **되돌릴 수 없이 멈춘 것만** 센다.
 *  두 판정이 다른 건 버그가 아니라 질문이 다르기 때문이다 — 합치려 들면 한쪽이 반드시 거짓말한다.
 *
 * 판정은 **필요하다는 증거가 있을 때만** 한다: 자료가 하나도 없는 조직에 "증류가 멈췄다"고 하지 않는다.
 */
export function stuckStages(o: PipelineOverview): string[] {
  const s = o.stages;
  const running = (j: PipelineJob | null) => !!j && j.any_enabled;
  const hasKnowledge = s.distill.output > 0;
  const stuck: string[] = [];
  // 수집기를 만들어 놓고 전부 꺼 둔 상태만 '멈춤'이다. 아예 안 만든 건 '안 쓰는 것'이라 묻지 않는다.
  if (s.collect.configured > 0 && s.collect.enabled === 0) stuck.push("수집");
  // 자료가 있는데 증류가 안 돈다 = 그 자료는 영원히 지식이 되지 않는다(고객사 A: 10,900건 중 13건).
  if (s.collect.output > 0 && !running(s.distill.job)) stuck.push("증류");
  // 지식이 있는데 분류가 안 돈다 = 미분류는 recall 의 INNER JOIN 에서 소환되지 않는다.
  if (hasKnowledge && !running(s.classify.job)) stuck.push("분류");
  // 지식이 있는데 관리가 없다/안 돈다 = 낡음·어긋남을 아무도 안 본다(dev 실측: 8일 정지).
  if (hasKnowledge && (s.manage.configured === 0 || !running(s.manage.job))) stuck.push("관리");
  return stuck;
}
