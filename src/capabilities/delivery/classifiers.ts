// delivery ▸ classifiers — 분류기 CRUD·커버리지·미리보기(#1419 T4). 증류기(delivery/ingest-distillers)의 분류판.
//
//  scope: restWork(memory) — 증류기와 같은 판단이다. 조직 '정책'이 아니라 팀이 일상적으로 굴리는 설정이라
//   admin 을 요구하면 실무자가 자기 도메인 분류 기준 하나 못 고치고 관리자를 기다린다. 파괴 반경도 좁다 —
//   분류기가 만드는 건 **제안**이고 사람 확정([분류 검토 대기])을 거친다.
import type { Capability } from "../types.js";
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import {
  listClassifiers, getClassifier, classifierInbox, classifierCoverage,
  upsertClassifier, removeClassifier,
} from "../../org/store/classifiers.js";
import { actorOf, restWork, str } from "./shared.js";

export const classifiersCapabilities: Capability[] = [
  restWork("org_classifier_list", "분류기 목록",
    "등록된 분류기 + 커버리지(분류기별 잔량 · 어느 분류기에도 안 걸리는 사각지대). 배정 순서는 priority 내림차순 — " +
    "한 지식은 가장 앞선 분류기 하나에만 배정된다(중복 분류 방지). 분류기 0개면 구 전역 동작(전 미분류 지식을 한 프롬프트로).",
    [{ method: "GET", paths: ["/api/ui/org/classifiers"], parse: () => ({}) }],
    async () => ({ classifiers: await listClassifiers(), coverage: await classifierCoverage() })),

  restWork("org_classifier_upsert", "분류기 저장",
    "분류기를 만들거나 고친다. 스코프(대상·space·유형·출처·기간) · 기준(criteria_md·후보 축 제한) · 확신도 문턱 · 실행(배치·모델·의뢰자)을 정한다. " +
    "id 나 key 로 기존 것을 지정하면 수정, 없으면 생성. 기준을 바꿔 이미 판정한 것을 다시 보고 싶으면 reset_seen=true.",
    [{ method: "POST", paths: ["/api/ui/org/classifiers"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const classifier = await upsertClassifier({
        id: input.id === undefined || input.id === null ? undefined : Number(input.id),
        key: input.key === undefined ? undefined : str(input.key, "key", 64),
        label: input.label === undefined ? undefined : (input.label === null || input.label === "" ? null : str(input.label, "label", 200)),
        enabled: input.enabled === undefined ? undefined : Boolean(input.enabled),
        priority: input.priority === undefined ? undefined : Number(input.priority),
        target: input.target === undefined ? undefined : str(input.target, "target", 20),
        confidence_below: input.confidence_below === undefined ? undefined : (input.confidence_below === null ? null : Number(input.confidence_below)),
        match_spaces: input.match_spaces as never, match_types: input.match_types as never,
        match_provenance: input.match_provenance === undefined ? undefined : (input.match_provenance === null || input.match_provenance === "" ? null : str(input.match_provenance, "match_provenance", 20)),
        match_systems: input.match_systems as never, exclude_names: input.exclude_names as never,
        min_chars: input.min_chars === undefined ? undefined : Number(input.min_chars),
        lookback_days: input.lookback_days === undefined ? undefined : (input.lookback_days === null || input.lookback_days === "" ? null : Number(input.lookback_days)),
        criteria_md: input.criteria_md === undefined ? undefined : (input.criteria_md === null || input.criteria_md === "" ? null : String(input.criteria_md).slice(0, 20_000)),
        candidate_categories: input.candidate_categories as never,
        confirm_threshold: input.confirm_threshold === undefined ? undefined : Number(input.confirm_threshold),
        batch_size: input.batch_size === undefined ? undefined : Number(input.batch_size),
        mode: input.mode === undefined ? undefined : str(input.mode, "mode", 20),
        session_ref: input.session_ref === undefined ? undefined : (input.session_ref === null || input.session_ref === "" ? null : str(input.session_ref, "session_ref", 200)),
        model: input.model === undefined ? undefined : (input.model === null || input.model === "" ? null : str(input.model, "model", 40)),
        effort: input.effort === undefined ? undefined : (input.effort === null || input.effort === "" ? null : str(input.effort, "effort", 20)),
        requester: input.requester === undefined ? undefined : (input.requester === null || input.requester === "" ? null : str(input.requester, "requester", 200)),
        note: input.note === undefined ? undefined : (input.note === null || input.note === "" ? null : str(input.note, "note", 2000)),
        reset_seen: input.reset_seen === true,
      }, actorOf(user), "web");
      return { classifier };
    }, {
      id: z.number().int().positive().optional(),
      key: z.string().optional().describe("식별 슬러그(a-z0-9._-)"),
      label: z.string().nullable().optional(),
      enabled: z.boolean().optional(),
      priority: z.number().int().optional().describe("높을수록 먼저 가져간다. 낮은 값 + 넓은 스코프 = 나머지를 받는 기본 라인"),
      target: z.enum(["unmapped", "low_confidence", "both"]).optional().describe("미분류만 | 낮은 확신도 재분류 | 둘 다"),
      confidence_below: z.number().min(0).max(1).nullable().optional().describe("재분류 기준 확신도(기본 0.8 미만)"),
      match_spaces: z.array(z.string()).or(z.string()).nullable().optional().describe("space 로 좁힘(business·product·system)"),
      match_types: z.array(z.string()).or(z.string()).nullable().optional().describe("page-type 으로 좁힘(decision·how-to 등)"),
      match_provenance: z.string().nullable().optional().describe("authored(저작) | observed(미러)"),
      match_systems: z.array(z.string()).or(z.string()).nullable().optional().describe("출처 시스템(notion·slack 등)"),
      exclude_names: z.array(z.string()).or(z.string()).nullable().optional(),
      min_chars: z.number().int().min(0).optional(),
      lookback_days: z.number().int().positive().nullable().optional(),
      criteria_md: z.string().nullable().optional().describe("분류 판단 기준(자유서술) — 프롬프트에 그대로 삽입된다"),
      candidate_categories: z.array(z.string()).or(z.string()).nullable().optional().describe("후보 카테고리 key 제한 — 비우면 전체"),
      confirm_threshold: z.number().min(0).max(1).optional().describe("이 확신도 이상이면 confirmed, 미만이면 proposed(사람 검토). 기본 0.8"),
      batch_size: z.number().int().min(1).max(500).optional(),
      mode: z.enum(["headless", "session"]).optional(),
      session_ref: z.string().nullable().optional(),
      model: z.string().nullable().optional(),
      effort: z.string().nullable().optional(),
      requester: z.string().nullable().optional().describe("이 사람의 AI 계정으로 실행·과금"),
      note: z.string().nullable().optional(),
      reset_seen: z.boolean().optional().describe("'이미 판정함' 기록을 비운다 — 기준을 바꿔 다시 보고 싶을 때"),
    }),

  restWork("org_classifier_preview", "분류기 미리보기",
    "이 분류기가 **지금 맡은 지식**과 AI 에게 나갈 지시문을 보여준다(실행하지 않는다). " +
    "0건이면 스코프가 너무 좁거나, 우선순위 높은 분류기가 먼저 가져갔거나, 이미 판정한 것들이다(reset_seen 으로 되돌릴 수 있다).",
    [{ method: "GET", paths: ["/api/ui/org/classifiers/preview"], parse: (req) => ({
      key: req.query?.key ? String(req.query.key) : undefined,
      id: req.query?.id ? Number(req.query.id) : undefined,
      limit: req.query?.limit ? Number(req.query.limit) : undefined,
    }) }],
    async (input: Record<string, unknown>) => {
      const ref = input.id ? Number(input.id) : (input.key ? String(input.key) : "");
      if (!ref) throw new HttpError(400, "분류기 key 또는 id 가 필요합니다");
      const c = await getClassifier(ref);
      if (!c) throw new HttpError(404, "분류기를 찾을 수 없습니다");
      const limit = Math.min(Math.max(1, Number(input.limit ?? 12)), 100);
      const sample = await classifierInbox(c, limit);
      const cov = (await classifierCoverage()).classifiers.find((x) => x.id === c.id);
      return { classifier: c, sample, backlog: cov?.backlog ?? sample.length, reviewed: cov?.reviewed ?? 0 };
    }, {
      key: z.string().optional(), id: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),

  restWork("org_classifier_remove", "분류기 삭제",
    "분류기를 지운다. 이미 만들어진 분류 제안은 그대로 남는다(지식의 자산이지 분류기의 것이 아니다).",
    [{ method: "POST", paths: ["/api/ui/org/classifiers/remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = Number(input.id);
      if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, "분류기 id 필요");
      await removeClassifier(id, actorOf(user), "web");
      return { ok: true };
    }, {
      id: z.number().int().positive().describe("삭제할 분류기 id — 이미 만들어진 분류 제안은 남는다"),
    }),
];
