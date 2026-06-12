// domainmap 큐레이션 그룹 capability — 게이트웨이가 domainmap 쓰기를 흡수하는 단일 표면(Stage②+⑤).
// propose_domain·domain_deprecate 만 MCP 노출(도메인 authoring — Phase C ⑤ 의도적 확장), 나머지 REST 전용.
// (현 MCP 표면 = 21툴: 기존 13 + pm 6 + domainmap authoring 2.)
// 화이트리스트 원칙: free-form 프록시 금지 — 아래 14개 op(읽기 3 + 쓰기 11)만 통과하며
// 게이트웨이가 zod/parse 로 입력을 선검증하고, 모든 쓰기는 audit 로그 + x-actor(user.userId)로 위임한다.
// domainmap 측 검증·change_log 기록은 store-core 가 단일 경로로 수행(이중 감사 = 의도된 설계).
// actor-type 매핑: ctx.source==='mcp' → x-actor-type:'agent'(에이전트 쓰기는 도메인 단에서 가드),
// 웹/기타 → 헤더 생략(human 기본, 기존 거동 무변경).
import { z } from "zod";
import { dmGet, dmPost, dmPatch, DmUpstreamError } from "../domainmap/client.js";
import { logger } from "../log.js";
import type { Capability, CapabilityCtx } from "./types.js";
import { HttpError } from "./rest-util.js";
import type { LivelyUser } from "../context.js";

const enc = encodeURIComponent;

// ── 공용 파서 ──
// repo 는 path 세그먼트/쿼리로 받아 domainmap URL 에 삽입되므로 형식 화이트리스트로 잠근다.
const REPO_RE = /^[A-Za-z0-9._-]+$/;
function parseRepo(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, "repo 필수 — 레포를 선택하세요");
  const s = v.trim();
  if (s.length > 100 || !REPO_RE.test(s)) throw new HttpError(400, "repo 형식이 잘못되었습니다");
  return s;
}
function parseId(v: unknown, name = "id"): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${name} 는 양의 정수여야 합니다`);
  return n;
}

// 쓰기 공통 audit — mapping.ts 의 curate audit 패턴과 동일 필드(by/source) + 식별 페이로드.
// '시도' 시점이 아니라 결과 시점에 기록한다: 성공 = outcome:'ok' + changeId(있으면),
// 실패 = outcome:'failed' + status — 거부된 시도가 실행된 것처럼 읽히는 포렌식 혼동 방지.
// (권위 감사는 domainmap change_log(x-actor)가 담당 — 이중 감사는 의도된 설계.)
async function audited<T>(
  action: string, user: LivelyUser, ctx: CapabilityCtx | undefined,
  extra: Record<string, unknown>, fn: () => Promise<T>,
): Promise<T> {
  const base = { audit: "domainmap_curate", action, by: user.userId, source: ctx?.source ?? "unknown", ...extra };
  try {
    const result = await fn();
    const changeId = (result as { change_id?: unknown } | null)?.change_id;
    logger.info({ ...base, outcome: "ok", ...(changeId !== undefined ? { changeId } : {}) });
    return result;
  } catch (err) {
    // 키 충돌 주의: extra 에 status(debt 목표 상태 등)가 있을 수 있어 HTTP 코드는 httpStatus 로.
    const httpStatus = err instanceof HttpError ? err.status
      : err instanceof DmUpstreamError ? err.upstreamStatus : undefined;
    logger.info({ ...base, outcome: "failed", ...(httpStatus !== undefined ? { httpStatus } : {}),
      error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

const zid = z.number().int().positive();

// ════════ 읽기 3종 ════════
// 경로 설계(충돌 회피): 기존 proxy = GET /api/ui/domainmap/:repo/:kind (2세그·DM_KINDS 동결).
// 신규 읽기는 1세그(debts/history — repo 는 쿼리파람)와 3세그(:repo/domain/:id)만 사용해
// 등록 순서와 무관하게 비충돌. unknown repo 는 dmGet 특성상 502 로 표면화(기존 proxy 와 동일 거동).

const dmDomainDetail: Capability = {
  name: "dm_domain_detail",
  title: "domainmap 영역 상세",
  description: "한 영역의 상세 — code_units/data_entities(매핑 status/origin/confidence 중첩, soft-removed 포함) + 관련 debts. 웹 큐레이션 전용(REST only).",
  scope: "context",
  input: { repo: z.string().regex(REPO_RE).max(100), id: zid },
  expose: {
    mcp: false,
    rest: [{
      method: "GET",
      paths: ["/api/ui/domainmap/:repo/domain/:id"],
      parse: (req) => ({ repo: parseRepo(req.params.repo), id: parseId(req.params.id, "domain id") }),
    }],
  },
  handler: async (input: { repo: string; id: number }) =>
    dmGet(`/api/repo/${enc(input.repo)}/domain/${input.id}`),
};

const dmDebtList: Capability = {
  name: "dm_debt_list",
  title: "domainmap 이슈 목록",
  description: "레포 전체 debt(이슈) 목록 — 웹 큐레이션 전용(REST only). DM_KINDS 동결 준수를 위해 proxy 와 별도 경로.",
  scope: "context",
  input: { repo: z.string().regex(REPO_RE).max(100) },
  expose: {
    mcp: false,
    rest: [{
      method: "GET",
      paths: ["/api/ui/domainmap/debts"],
      parse: (req) => ({ repo: parseRepo(req.query.repo) }),
    }],
  },
  handler: async (input: { repo: string }) => dmGet(`/api/repo/${enc(input.repo)}/debts`),
};

const dmHistory: Capability = {
  name: "dm_history",
  title: "domainmap 변경 이력",
  description: "change_log 스트림(최신순, limit 1..500 기본 80 — 구 UI 동일) — 웹 큐레이션 전용(REST only).",
  scope: "context",
  input: { repo: z.string().regex(REPO_RE).max(100), limit: z.number().int().min(1).max(500).default(80) },
  expose: {
    mcp: false,
    rest: [{
      method: "GET",
      paths: ["/api/ui/domainmap/history"],
      parse: (req) => {
        const repo = parseRepo(req.query.repo);
        const raw = req.query.limit;
        let limit = 80;
        if (raw !== undefined && raw !== "") {
          const n = Number(raw);
          if (!Number.isInteger(n) || n < 1 || n > 500) throw new HttpError(400, "limit 은(는) 1~500 사이 정수여야 합니다");
          limit = n;
        }
        return { repo, limit };
      },
    }],
  },
  handler: async (input: { repo: string; limit: number }) =>
    dmGet(`/api/repo/${enc(input.repo)}/history?limit=${input.limit}`),
};

// ════════ 쓰기 9종 — 전부 POST(게이트웨이 표면에서 PATCH 는 POST 로 모델링, RestMount 유니온 유지) ════════

const dmDomainConfirm: Capability = {
  name: "dm_domain_confirm",
  title: "domainmap 영역 확인",
  description: "영역 확정(status='confirmed', origin='human'). 반환 {id, change_id} — undo 토스트용.",
  scope: "context",
  input: { id: zid },
  expose: {
    mcp: false,
    rest: [{
      method: "POST",
      paths: ["/api/ui/domainmap/domain/:id/confirm"],
      parse: (req) => ({ id: parseId(req.params.id, "domain id") }),
    }],
  },
  handler: async (input: { id: number }, user, ctx) =>
    audited("domain_confirm", user, ctx, { id: input.id },
      () => dmPost(`/api/domain/${input.id}/confirm`, {}, user.userId)),
};

const dmDomainEdit: Capability = {
  name: "dm_domain_edit",
  title: "domainmap 영역 수정",
  description: "영역 수정 {name?, description?, crossCutting?} — ⚠ human(웹) 경로만 저장 시 자동 확정(auto-confirm) 전이. agent(MCP) 경로는 confirmed 행 403·proposed 행만 수정 가능(status 유지). UI 는 '저장하면 확정 처리됩니다' 를 명시할 것.",
  scope: "context",
  // REST 는 mount.parse 가 검증(이 shape 는 expose.mcp=false 라 미실행 — 문서/드리프트 가드용).
  // '최소 1개 필드' cross-field 규칙은 ZodRawShape 로 표현 불가 → handler 가드로 두 계층 일치.
  input: {
    id: zid,
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(4000).optional(),
    crossCutting: z.boolean().optional(),
  },
  expose: {
    mcp: false,
    rest: [{
      method: "POST",
      paths: ["/api/ui/domainmap/domain/:id/edit"],
      parse: (req) => {
        const id = parseId(req.params.id, "domain id");
        const b = (req.body ?? {}) as Record<string, unknown>;
        const out: Record<string, unknown> = { id };
        if (b.name !== undefined) {
          if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 200) throw new HttpError(400, "name 은 1~200자 문자열이어야 합니다");
          out.name = b.name.trim();
        }
        if (b.description !== undefined) {
          if (typeof b.description !== "string" || b.description.length > 4000) throw new HttpError(400, "description 은 4000자 이하 문자열이어야 합니다");
          out.description = b.description;
        }
        if (b.crossCutting !== undefined) {
          if (typeof b.crossCutting !== "boolean") throw new HttpError(400, "crossCutting 은 boolean 이어야 합니다");
          out.crossCutting = b.crossCutting;
        }
        if (out.name === undefined && out.description === undefined && out.crossCutting === undefined) {
          throw new HttpError(400, "수정할 필드가 필수입니다 — name/description/crossCutting 중 1개 이상");
        }
        return out;
      },
    }],
  },
  handler: async (input: { id: number; name?: string; description?: string; crossCutting?: boolean }, user, ctx) => {
    // cross-field 규칙(최소 1개 필드)은 ZodRawShape 로 표현 불가 — REST 는 parse 가 막지만,
    // expose.mcp 전환 등 다른 어댑터 경유 시에도 동일 검증이 되도록 handler 에서 한 번 더 가드.
    if (input.name === undefined && input.description === undefined && input.crossCutting === undefined) {
      throw new HttpError(400, "수정할 필드가 필수입니다 — name/description/crossCutting 중 1개 이상");
    }
    return audited("domain_edit", user, ctx, { id: input.id, fields: Object.keys(input).filter((k) => k !== "id") }, () => {
      const body: Record<string, unknown> = {};
      if (input.name !== undefined) body.name = input.name;
      if (input.description !== undefined) body.description = input.description;
      if (input.crossCutting !== undefined) body.cross_cutting = input.crossCutting;
      return dmPatch(`/api/domain/${input.id}`, body, user.userId);
    });
  },
};

const dmDomainMerge: Capability = {
  name: "dm_domain_merge",
  title: "domainmap 영역 병합",
  description: "fromId 영역을 intoId 영역에 합친다(트랜잭션, 중복 타깃은 fold). 반환에 change_id 포함.",
  scope: "context",
  input: { fromId: zid, intoId: zid },
  expose: {
    mcp: false,
    rest: [{
      method: "POST",
      paths: ["/api/ui/domainmap/domain/merge"], // 2세그 — :id/confirm·:id/edit(3세그)와 비충돌
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const fromId = parseId(b.fromId, "fromId");
        const intoId = parseId(b.intoId, "intoId");
        if (fromId === intoId) throw new HttpError(400, "같은 영역으로는 합칠 수 없습니다 — from/into 검증 실패");
        return { fromId, intoId };
      },
    }],
  },
  handler: async (input: { fromId: number; intoId: number }, user, ctx) =>
    audited("domain_merge", user, ctx, { fromId: input.fromId, intoId: input.intoId },
      () => dmPost("/api/domain/merge", { from_id: input.fromId, into_id: input.intoId }, user.userId)),
};

const dmMappingConfirm: Capability = {
  name: "dm_mapping_confirm",
  title: "domainmap 매핑 확인",
  description: "코드 유닛/데이터 엔티티 매핑 확정(rejected 행의 '다시 확인'도 같은 op). 반환 {id, change_id}.",
  scope: "context",
  input: { id: zid },
  expose: {
    mcp: false,
    rest: [{
      method: "POST",
      paths: ["/api/ui/domainmap/mapping/:id/confirm"],
      parse: (req) => ({ id: parseId(req.params.id, "mapping id") }),
    }],
  },
  handler: async (input: { id: number }, user, ctx) =>
    audited("mapping_confirm", user, ctx, { id: input.id },
      () => dmPost(`/api/mapping/${input.id}/confirm`, {}, user.userId)),
};

const dmMappingReject: Capability = {
  name: "dm_mapping_reject",
  title: "domainmap 매핑 제외",
  description: "매핑 제외(status='rejected'). 반환 {id, change_id}.",
  scope: "context",
  input: { id: zid },
  expose: {
    mcp: false,
    rest: [{
      method: "POST",
      paths: ["/api/ui/domainmap/mapping/:id/reject"],
      parse: (req) => ({ id: parseId(req.params.id, "mapping id") }),
    }],
  },
  handler: async (input: { id: number }, user, ctx) =>
    audited("mapping_reject", user, ctx, { id: input.id },
      () => dmPost(`/api/mapping/${input.id}/reject`, {}, user.userId)),
};

const dmMappingMove: Capability = {
  name: "dm_mapping_move",
  title: "domainmap 매핑 영역 이동",
  description: "매핑을 다른 영역으로 이동 {domainId} — ⚠ 이동=확정 전이(domainmap reassign 의미). UNIQUE 충돌은 409 로 번역.",
  scope: "context",
  input: { id: zid, domainId: zid },
  expose: {
    mcp: false,
    rest: [{
      method: "POST",
      paths: ["/api/ui/domainmap/mapping/:id/move"],
      parse: (req) => ({
        id: parseId(req.params.id, "mapping id"),
        domainId: parseId(((req.body ?? {}) as Record<string, unknown>).domainId, "domainId"),
      }),
    }],
  },
  handler: async (input: { id: number; domainId: number }, user, ctx) =>
    audited("mapping_move", user, ctx, { id: input.id, domainId: input.domainId }, async () => {
      try {
        return await dmPatch(`/api/mapping/${input.id}`, { domain_id: input.domainId }, user.userId);
      } catch (err) {
        // store-core.reassignMapping 은 UNIQUE(repo,target,domain) 미가드 — 같은 타깃이 이미 대상 영역에
        // 매핑돼 있으면 raw pg 500('duplicate key …'). 사용자에게 영어 pg 에러 대신 409 한국어로.
        // 본문은 클라이언트행 메시지에서 제외됐으므로 DmUpstreamError.upstreamBody 로 분기.
        // 주의: 문자열 매칭이라 pg 메시지 포맷이 바뀌면 깨질 수 있음(그땐 502 로 강등될 뿐 — 안전측).
        if (err instanceof DmUpstreamError && err.upstreamBody.includes("duplicate key")) {
          throw new HttpError(409, "대상 영역에 같은 코드/데이터 매핑이 이미 있습니다 — 이동 대신 이 행을 제외하세요");
        }
        throw err;
      }
    }),
};

const DEBT_STATUSES = ["open", "ack", "resolved", "dismissed"] as const;

const dmDebtStatus: Capability = {
  name: "dm_debt_status",
  title: "domainmap 이슈 상태 전환",
  description: "debt 상태 전환 {status ∈ open|ack|resolved|dismissed}. 반환 {id, change_id}.",
  scope: "context",
  input: { id: zid, status: z.enum(DEBT_STATUSES) },
  expose: {
    mcp: false,
    rest: [{
      method: "POST",
      paths: ["/api/ui/domainmap/debt/:id/status"],
      parse: (req) => {
        const id = parseId(req.params.id, "debt id");
        const status = ((req.body ?? {}) as Record<string, unknown>).status;
        if (typeof status !== "string" || !(DEBT_STATUSES as readonly string[]).includes(status)) {
          throw new HttpError(400, "status 는 open|ack|resolved|dismissed 만 허용됩니다");
        }
        return { id, status };
      },
    }],
  },
  handler: async (input: { id: number; status: string }, user, ctx) =>
    audited("debt_status", user, ctx, { id: input.id, status: input.status },
      () => dmPatch(`/api/debt/${input.id}`, { status: input.status }, user.userId)),
};

const dmProjectConfirm: Capability = {
  name: "dm_project_confirm",
  title: "domainmap 프로젝트 확인",
  description: "프로젝트 확정(status='confirmed', origin='human') — domainmap 신규 엔드포인트 wrap. 반환 {id, change_id}.",
  scope: "context",
  input: { id: zid },
  expose: {
    mcp: false,
    rest: [{
      method: "POST",
      paths: ["/api/ui/domainmap/project/:id/confirm"],
      parse: (req) => ({ id: parseId(req.params.id, "project id") }),
    }],
  },
  handler: async (input: { id: number }, user, ctx) =>
    audited("project_confirm", user, ctx, { id: input.id },
      () => dmPost(`/api/project/${input.id}/confirm`, {}, user.userId)),
};

const dmRestore: Capability = {
  name: "dm_restore",
  title: "domainmap 변경 되돌리기",
  description: "change_log 항목의 before 스냅샷으로 되돌린다(undo 토스트의 단일 경로). domainmap 400(dependent rows)/404 는 상태·메시지 그대로 보존.",
  scope: "context",
  input: { changeId: zid },
  expose: {
    mcp: false,
    rest: [{
      method: "POST",
      paths: ["/api/ui/domainmap/restore/:changeId"],
      parse: (req) => ({ changeId: parseId(req.params.changeId, "change id") }),
    }],
  },
  handler: async (input: { changeId: number }, user, ctx) =>
    // restoreOf = 되돌린 대상 change id(입력) — 성공 라인의 changeId(restore 가 만든 새 change)와 키 분리.
    audited("restore", user, ctx, { restoreOf: input.changeId },
      () => dmPost(`/api/restore/${input.changeId}`, {}, user.userId)),
};

// ════════ 도메인 authoring 2종 — 이 그룹 최초의 expose.mcp=true(Phase C ⑤) ════════
// MCP 등록은 tools/context.ts 의 registerMcpCapabilities 배열에서(미등록/비노출 불일치 = 부팅 throw).

const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

const proposeDomain: Capability = {
  name: "propose_domain",
  title: "도메인 제안",
  description:
    "새 도메인을 status='proposed' 로 제안한다(day-2 authoring). evidence 필수 — 이 도메인이 왜 필요한지의 근거(change_log 에 영속). " +
    "사람이 확정(confirm)하기 전까지 proposed 로 유지되며, 보호 리포(lively)는 403 으로 차단된다. 반환 {repo,id,key,status,change_id}.",
  scope: "context",
  input: {
    repo: z.string().regex(REPO_RE).max(100),
    key: z.string().trim().min(1).max(100).regex(KEY_RE).describe("소문자 슬러그 (a-z0-9, -)"),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(4000).optional(),
    evidence: z.string().trim().min(1).max(4000).describe("필수 — 이 도메인이 필요한 근거"),
    crossCutting: z.boolean().optional(),
  },
  expose: {
    mcp: true,
    rest: [{
      method: "POST",
      paths: ["/api/ui/domainmap/domain/propose"], // 2세그 — /domain/merge 선례(:id/confirm 3세그와 비충돌)
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const out: Record<string, unknown> = { repo: parseRepo(b.repo) };
        if (typeof b.key !== "string" || !KEY_RE.test(b.key.trim()) || b.key.trim().length > 100) {
          throw new HttpError(400, "key 는 소문자 슬러그(a-z0-9, -) 형식이어야 합니다");
        }
        out.key = b.key.trim();
        if (typeof b.name !== "string" || !b.name.trim() || b.name.trim().length > 200) {
          throw new HttpError(400, "name 은 1~200자 문자열이어야 합니다");
        }
        out.name = b.name.trim();
        if (typeof b.evidence !== "string" || !b.evidence.trim()) {
          throw new HttpError(400, "evidence 필수 — 이 도메인이 필요한 근거를 적어주세요");
        }
        if (b.evidence.length > 4000) throw new HttpError(400, "evidence 는 4000자 이하 문자열이어야 합니다");
        out.evidence = b.evidence.trim();
        if (b.description !== undefined) {
          if (typeof b.description !== "string" || b.description.length > 4000) {
            throw new HttpError(400, "description 은 4000자 이하 문자열이어야 합니다");
          }
          out.description = b.description;
        }
        if (b.crossCutting !== undefined) {
          if (typeof b.crossCutting !== "boolean") throw new HttpError(400, "crossCutting 은 boolean 이어야 합니다");
          out.crossCutting = b.crossCutting;
        }
        return out;
      },
    }],
  },
  handler: async (
    input: { repo: string; key: string; name: string; description?: string; evidence: string; crossCutting?: boolean },
    user, ctx,
  ) => {
    // cross-layer 가드: zod(.trim().min(1))/parse 가 막지만, 다른 어댑터 경유에도 동일 검증.
    if (typeof input.evidence !== "string" || !input.evidence.trim()) {
      throw new HttpError(400, "evidence 필수 — 이 도메인이 필요한 근거를 적어주세요");
    }
    return audited("domain_propose", user, ctx, { repo: input.repo, key: input.key }, () =>
      dmPost(`/api/repo/${enc(input.repo)}/domain/propose`, {
        key: input.key, name: input.name, description: input.description,
        evidence: input.evidence, cross_cutting: input.crossCutting,
      }, user.userId, ctx?.source === "mcp" ? { actorType: "agent" } : undefined));
  },
};

const domainDeprecate: Capability = {
  name: "domain_deprecate",
  title: "도메인 비활성(deprecate)",
  description:
    "도메인 state 를 deprecated 로 전환(undo:true 면 active 로 복귀). 기존 매핑은 유지되며 목록에서 숨기지 않는다(큐레이션 신호). " +
    "merged 도메인은 400. 반환 {id,change_id,state}.",
  scope: "context",
  input: { id: zid, undo: z.boolean().optional() },
  expose: {
    mcp: true,
    rest: [{
      method: "POST",
      paths: ["/api/ui/domainmap/domain/:id/deprecate"], // 3세그 — :id/confirm 선례
      parse: (req) => {
        const id = parseId(req.params.id, "domain id");
        const undo = ((req.body ?? {}) as Record<string, unknown>).undo;
        if (undo !== undefined && typeof undo !== "boolean") throw new HttpError(400, "undo 는 boolean 이어야 합니다");
        return undo === undefined ? { id } : { id, undo };
      },
    }],
  },
  handler: async (input: { id: number; undo?: boolean }, user, ctx) =>
    audited("domain_deprecate", user, ctx, { id: input.id, ...(input.undo ? { undo: true } : {}) }, () =>
      dmPost(`/api/domain/${input.id}/${input.undo ? "undeprecate" : "deprecate"}`, {},
        user.userId, ctx?.source === "mcp" ? { actorType: "agent" } : undefined)),
};

export const domainmapCurationCapabilities: Capability[] = [
  dmDomainDetail, dmDebtList, dmHistory,
  dmDomainConfirm, dmDomainEdit, dmDomainMerge,
  dmMappingConfirm, dmMappingReject, dmMappingMove,
  dmDebtStatus, dmProjectConfirm, dmRestore,
  proposeDomain, domainDeprecate, // expose.mcp=true — 도메인 authoring(⑤)
];
