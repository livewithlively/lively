// 매핑 그룹 capability — inbox/후보 읽기 + 단일 쓰기 op(curate_item_mapping).
// LLM 판단(D6/P5)은 이 머신의 인터랙티브 Claude Code 세션이 수행 — programmatic 모델 클라이언트 없음.
// 쓰기는 store.ts 의 propose/confirm/reject 단일 검증 경로만 위임(가드레일 throw — free-form SQL 없음).
import { z } from "zod";
import {
  unmappedItemsUi, mappingKeyCounts,
  proposeItemDomain, proposeItemProject,
  confirmItemDomain, confirmItemProject,
  rejectItemDomain, rejectItemProject,
  type MappedBy,
} from "../items/store.js";
import { loadCandidates } from "../items/mapping-candidates.js";
import { logger } from "../log.js";
import type { Capability } from "./types.js";
import { HttpError, MISSING_VALUES, parseMappingBody, qstr, qint, qiso, qtype } from "./rest-util.js";

// canonical = {count, rows} — 구 MCP 의 bare 배열 폐기. NOT EXISTS 는 state IN
// ('proposed','confirmed') 한정 — rejected-only 아이템은 inbox 복귀(기각 = 미매핑 신호).
const listUnmapped: Capability = {
  name: "list_unmapped",
  title: "미매핑 아이템 inbox",
  description:
    "도메인/프로젝트 매핑이 없는 아이템을 나열(잔여 표면화). 응답 {count, rows}. missing=domain|project|either|both. " +
    "repo 지정 시 '그 repo 기준 미매핑'(다른 repo 에만 매핑된 아이템도 포함) — 멀티 repo 큐레이션은 repo 명시 권장. " +
    "기각(rejected)만 남은 아이템은 미매핑으로 취급되어 여기 복귀한다. 억지 매핑하지 말 것 — 미매핑은 신호.",
  scope: "items",
  input: {
    // 문자열은 qstr(REST) 거동 미러링: trim + 길이 상한 — 같은 논리 입력이 표면별로 갈리지 않게.
    missing: z.enum(["domain", "project", "either", "both"]).default("either"),
    repo: z.string().trim().max(200).optional().describe("이 repo 기준 미매핑으로 스코프(예: productivity). 미지정 시 전 repo 통합 기준"),
    system: z.string().trim().max(100).optional().describe("discord | notion …"),
    type: z.enum(["message", "task", "change", "doc", "note"]).optional(),
    since: z.string().optional().describe("ISO8601 — 이 시각 이후만"),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).max(5000).default(0),
  },
  expose: {
    mcp: true,
    rest: [{
      method: "GET",
      paths: ["/api/ui/inbox"],
      parse: (req) => {
        const missingRaw = qstr(req.query.missing, "missing", 20) ?? "either";
        if (!MISSING_VALUES.has(missingRaw)) throw new HttpError(400, "missing 은 domain|project|either|both 만 허용됩니다");
        return {
          missing: missingRaw,
          repo: qstr(req.query.repo, "repo", 200),
          system: qstr(req.query.system, "system", 100),
          type: qtype(req.query.type),
          since: qiso(req.query.since),
          limit: qint(req.query.limit, "limit", 20, 1, 100),
          offset: qint(req.query.offset, "offset", 0, 0, 5000),
        };
      },
    }],
  },
  handler: async (input: {
    missing?: "domain" | "project" | "either" | "both";
    repo?: string; system?: string; type?: string; since?: string; limit?: number; offset?: number;
  }) => unmappedItemsUi(input),
};

// 직렬화(Map→배열)는 핸들러 소속 — REST/MCP byte-identical.
// 입력 정책 분기: MCP 는 repo optional(resolveRepo env 기본), REST 는 repo 명시 필수
// (멀티레포 셀렉터가 진실 — DOMAINMAP_DEFAULT_REPO 의존 금지).
const mappingCandidates: Capability = {
  name: "mapping_candidates",
  title: "매핑 후보 vocab",
  description:
    "한 repo 의 도메인(key+description)·프로젝트(key+기간)·엔티티(name→domain)를 한 번에 반환. propose 전 후보를 grounding 하는 용도.",
  scope: "items",
  input: { repo: z.string().trim().max(200).optional() },
  expose: {
    mcp: true,
    rest: [{
      method: "GET",
      paths: ["/api/ui/candidates"],
      parse: (req) => {
        const repo = qstr(req.query.repo, "repo", 200);
        if (!repo) throw new HttpError(400, "repo 필수 — 레포를 선택하세요");
        return { repo };
      },
    }],
  },
  handler: async (input: { repo?: string }) => {
    const c = await loadCandidates(input.repo);
    return {
      repo: c.repo,
      domains: [...c.domainsByKey.values()].map((d) => ({ key: d.key, name: d.name, description: d.description })),
      projects: [...c.projectsByKey.values()].map((p) => ({
        key: p.key, name: p.name, description: p.description, started_at: p.started_at, ended_at: p.ended_at,
      })),
      entities: [...c.entityToDomainKey.entries()].map(([name, domainKey]) => ({ name, domainKey })),
    };
  },
};

// 키별 매핑 카운트 — 도메인 페이지 grounding(REST 전용). count 는 rejected 제외.
const mappingCounts: Capability = {
  name: "mapping_counts",
  title: "키별 매핑 카운트",
  description: "repo 의 도메인/프로젝트 키별 아이템 수(+confirmed 수) — 웹 도메인 페이지 grounding 용(REST 전용).",
  scope: "items",
  input: { repo: z.string() },
  expose: {
    mcp: false,
    rest: [{
      method: "GET",
      paths: ["/api/ui/mapping-counts"],
      parse: (req) => {
        const repo = qstr(req.query.repo, "repo", 200);
        if (!repo) throw new HttpError(400, "repo 필수 — 레포를 선택하세요");
        return { repo };
      },
    }],
  },
  handler: async (input: { repo: string }) => mappingKeyCounts(input.repo),
};

interface CurateInput {
  action: "propose" | "confirm" | "reject";
  kind: "domain" | "project";
  itemId: number;
  key: string;
  repo?: string;
  evidence?: string;
  confidence?: number;
  mappedBy?: MappedBy;
}

// 단일 쓰기 op — 구 propose_item_domain/propose_item_project 툴을 대체(다이어트).
// store fn 위임만: propose→proposeItem*, confirm→confirmItem*, reject→rejectItem*.
// MCP propose 는 mappedBy='llm' 고정(기본값이자 유일 허용 — evidence 필수): 'rule' 자칭은
// evidence 가드 우회, 'manual' 자칭은 보호행(rank 3) 주조라 핸들러가 throw 로 차단한다.
// rule 행은 mapping-run, manual 행은 웹/CLI(사람이 구동하는 경로)에서만 생성된다.
// REST propose 는 parse 가 mappedBy='manual' 을 서버 강제(위조 불가).
// confirm/reject 는 mappedBy 무시(사람 진실). 보호 경로는 양쪽 다 성공 + action='skipped-*'.
const curateItemMapping: Capability = {
  name: "curate_item_mapping",
  title: "item 매핑 큐레이션(제안/확정/기각)",
  description:
    "item→domain/project 매핑의 단일 쓰기 op. action=propose: state='proposed' 제안 — 이 툴에서는 mappedBy='llm' 만 허용(기본값, evidence 근거 인용 필수·영속; " +
    "'rule'/'manual' 은 거부 — rule 행은 mapping-run, manual 행은 웹/CLI 의 사람 경로 전용), " +
    "confirmed/manual/rejected 행은 보호되어 action='skipped-*' 로 보고(덮어쓰기 없음), provenance 강등 금지, 멀티도메인 허용. " +
    "action=confirm: state='confirmed'+mapped_by='manual' 로 못박음(기각된 행의 부활 경로이기도 함). " +
    "action=reject: state='rejected' 로 기각 — 이후 rule/llm 재제안 영구 차단(skipped-rejected), evidence 는 기각 사유로 audit 에 기록. " +
    "⚠ confirm/reject 는 사람 큐레이션의 명시 행위 — 세션 내 사람의 명시적 지시가 있을 때만 호출할 것. " +
    "per-user bearer 가 audit(source='mcp', actor=userId)에 누가 했는지 기록한다.",
  scope: "items",
  input: {
    action: z.enum(["propose", "confirm", "reject"]),
    kind: z.enum(["domain", "project"]),
    itemId: z.number().int().positive(),
    key: z.string().trim().min(1).max(200), // REST parseMappingBody 의 trim 과 거동 일치(어댑터 경계 파리티)
    repo: z.string().trim().max(200).optional(),
    evidence: z.string().max(4000).optional().describe("propose(llm): 본문 인용+매치 근거(필수) · reject: 기각 사유(audit 기록)"),
    confidence: z.number().min(0).max(1).optional(),
    mappedBy: z.enum(["rule", "llm", "manual"]).optional().describe("propose 전용 — MCP 에서는 'llm' 만 허용(기본값, evidence 필수). confirm/reject 는 무시"),
  },
  expose: {
    mcp: true,
    rest: [
      // REST 3쌍은 기존 경로가 곧 어댑터(/api/ui/curate 신설 안 함 — 표면 최소화).
      // propose 의 mappedBy 는 서버 강제 'manual'(클라이언트가 llm/rule 행 위조 불가).
      { method: "POST", paths: ["/api/ui/propose", "/api/ui/mappings/propose"],
        parse: (req) => ({ ...parseMappingBody(req.body), action: "propose", mappedBy: "manual" }) },
      { method: "POST", paths: ["/api/ui/confirm", "/api/ui/mappings/confirm"],
        parse: (req) => ({ ...parseMappingBody(req.body), action: "confirm" }) },
      { method: "POST", paths: ["/api/ui/reject", "/api/ui/mappings/reject"],
        parse: (req) => ({ ...parseMappingBody(req.body), action: "reject" }) },
    ],
  },
  handler: async (input: CurateInput, user, ctx) => {
    const audit = { source: ctx?.source ?? "unknown", actor: user.userId ?? "unknown" };
    logger.info({
      audit: `curate_${input.action}`, by: user.userId, source: audit.source,
      kind: input.kind, itemId: input.itemId, key: input.key, repo: input.repo,
    });
    const base = { itemId: input.itemId, repo: input.repo, confidence: input.confidence, evidence: input.evidence };
    if (input.action === "propose") {
      const mappedBy: MappedBy = input.mappedBy ?? "llm"; // MCP 기본 llm — evidence 필수(store 가드레일)
      // MCP propose 는 llm 만: 'rule' 자칭은 evidence 가드(validateProposeBase 의 llm-only 검사) 우회,
      // 'manual' 자칭은 보호행(rank 3, ON CONFLICT mapped_by<>'manual' 면제) 주조 — 하네스 금지.
      // REST 는 비대상(parse 가 mappedBy='manual' 서버 강제 + source='web').
      if (ctx?.source === "mcp" && mappedBy !== "llm") {
        throw new Error(
          `MCP propose 는 mappedBy='llm' 만 허용됩니다(받은 값: ${mappedBy}) — rule 행은 mapping-run, manual 행은 웹/CLI 경로`,
        );
      }
      return input.kind === "domain"
        ? proposeItemDomain({ ...base, domainKey: input.key, mappedBy }, { audit })
        : proposeItemProject({ ...base, projectKey: input.key, mappedBy }, { audit });
    }
    if (input.action === "confirm") {
      return input.kind === "domain"
        ? confirmItemDomain({ ...base, domainKey: input.key }, { audit })
        : confirmItemProject({ ...base, projectKey: input.key }, { audit });
    }
    // reject — evidence 는 기각 사유(reason)로 audit.evidence 에 영속.
    return input.kind === "domain"
      ? rejectItemDomain({ itemId: input.itemId, domainKey: input.key, repo: input.repo, reason: input.evidence }, { audit })
      : rejectItemProject({ itemId: input.itemId, projectKey: input.key, repo: input.repo, reason: input.evidence }, { audit });
  },
};

export const mappingCapabilities: Capability[] = [
  listUnmapped, mappingCandidates, mappingCounts, curateItemMapping,
];
