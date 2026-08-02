// 코드유닛→도메인 매핑 capability — 미매핑 인박스 조회(list_unmapped) + 매핑 생성/제안(map_code_unit).
//  LLM 판단주체 모델(2026-06-26): 에이전트(라이블리 시드)가 도메인 should(정의·범위)+DDD 로 판단해 map_code_unit
//  (근거 첨부) 호출 → audit(change_log) → (옵션)2차 verify. 사람도 동일 손잡이. 기존행 confirm/reject/move 는
//  domainmap-curation(REST 전용). scope='context'(domainmap authoring). expose.mcp=true — 에이전트가 MCP 로 호출.
import { z } from "zod";
import type { Capability } from "./types.js";
import type { Actor } from "../domainmap/core/types.js";
import { listUnmappedCodeUnits, setCodeUnitMapping } from "../domainmap/core/mappings.js";

const REPO_DEFAULT = "context-ontology";

const listUnmapped: Capability = {
  name: "list_unmapped",
  title: "미매핑 코드유닛 인박스",
  description: "도메인 매핑이 없는(비-rejected 0건) active 코드유닛 목록 — 분류 대상 인박스. 에이전트/사람이 여기서 드레인한다(map_code_unit).",
  scope: "context",
  input: { repo: z.string().optional() },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/domainmap/unmapped"], parse: (req) => ({ repo: req.query?.repo ? String(req.query.repo) : undefined }) }],
  },
  handler: async (input: any) => ({ unmapped: await listUnmappedCodeUnits(input.repo ?? REPO_DEFAULT) }),
};

const mapCodeUnit: Capability = {
  name: "map_code_unit",
  title: "코드유닛 도메인 매핑(propose/confirm)",
  description:
    "코드유닛을 제품 도메인에 매핑한다(없으면 생성, 있으면 갱신). target=code_unit path(권장) 또는 target_id, " +
    "category=제품 도메인 key(예 'domain-cartography') 또는 category_id. origin 기본 'llm'(에이전트 판단). " +
    "status: proposed(기본·불확실) | confirmed(확신, confidence≥0.8 권장) | rejected(이 인박스 항목은 제품 도메인 대상 아님). " +
    "evidence(근거) 필수 — 도메인 should 의 어느 부분과 코드의 어느 신호로 판단했는지. cross-cutting 이면 가장 가까운 도메인에 proposed + evidence 에 명시.",
  scope: "context",
  input: {
    target: z.string().optional(),
    target_id: z.number().int().positive().optional(),
    category: z.string().optional(),
    category_id: z.number().int().positive().optional(),
    origin: z.string().max(40).optional(),
    confidence: z.number().min(0).max(1).optional(),
    status: z.enum(["proposed", "confirmed", "rejected"]).optional(),
    evidence: z.string().min(1).max(4000),
    repo: z.string().optional(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/domainmap/map-unit"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return {
        target: b.target != null ? String(b.target) : undefined,
        target_id: b.target_id != null ? Number(b.target_id) : undefined,
        category: b.category != null ? String(b.category) : undefined,
        category_id: b.category_id != null ? Number(b.category_id) : undefined,
        origin: b.origin != null ? String(b.origin) : undefined,
        confidence: b.confidence != null ? Number(b.confidence) : undefined,
        status: b.status != null ? String(b.status) : undefined,
        evidence: String(b.evidence ?? ""),
        repo: b.repo != null ? String(b.repo) : undefined,
      };
    } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const isMcp = ctx?.source === "mcp";
    const actor: Actor = { type: isMcp ? "agent" : "human", id: ctx?.actor ?? user?.userId ?? "agent" };
    return setCodeUnitMapping({
      repoName: input.repo ?? REPO_DEFAULT,
      path: input.target, targetId: input.target_id,
      categoryKey: input.category, categoryId: input.category_id,
      origin: input.origin ?? (isMcp ? "llm" : "human"),
      confidence: input.confidence, status: input.status, evidence: input.evidence, actor,
    });
  },
};

export const mappingCapabilities: Capability[] = [listUnmapped, mapCodeUnit];
