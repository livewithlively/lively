// P-V3-4a 도메인/repo 통제어휘 CRUD — domainmap 쓰기를 게이트웨이 표면이 흡수하는 두 번째 그룹.
// (domainmap-curation 은 '확정/제외/병합/되돌리기'의 큐레이션, 이 그룹은 '어휘 집합 자체'의 생성·개명·폐기.)
// 도메인은 항상 repo>domain 계층 — repo CRUD 가 상위, domain CRUD 가 하위. 전부 expose.mcp=true
// (day-2 authoring — propose_domain 선례). 화이트리스트 원칙: free-form 표면 금지 — 아래 5 op 만 통과하며
// 게이트웨이가 parse 로 선검증하고 모든 쓰기는 audit + actor 위임. 권한(M-마)은 3층:
//   1) 코어 가드: 보호 리포(SYNC_BLOCKED_REPOS) 쓰기 차단 + domain rename 의 agent→human-origin 403.
//   2) capability 가드(이 파일): repo rename/deprecate 는 agent 금지(repo 는 origin 축이 없는 인프라 —
//      사람 큐레이션 전용. 에이전트는 domain authoring 까지만). domain create/rename 은 agent 허용
//      (단 human-소유 도메인 rename 은 코어가 403). actor-type 매핑은 domainmap-curation 과 동일
//      (ctx.source==='mcp' → 'agent', 그 외 'human').
//   3) scope='context' + bearer — domainmap-curation 과 동일 인가 평면.
import { z } from "zod";
import { dmWrite, webActor } from "./domainmap-compat.js";
import {
  createDomain as coreCreateDomain, renameDomain as coreRenameDomain,
  domainDeleteRefs, hardDeleteDomain,
} from "../domainmap/core/domains.js";
import {
  createRepo as coreCreateRepo, renameRepo as coreRenameRepo, setRepoState, hardDeleteRepo,
} from "../domainmap/core/repos.js";
import { domainKnowledgeRefs, clearDomainKnowledgeRefs } from "../org/knowledge.js";
import { logger } from "../log.js";
import { assertNoHardSecrets } from "../org/redact.js";
import type { Capability, CapabilityCtx } from "./types.js";
import { HttpError } from "./rest-util.js";
import type { LivelyUser } from "../context.js";

const REPO_RE = /^[A-Za-z0-9._-]+$/;
const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;
const zid = z.number().int().positive();

function parseRepo(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, "repo 필수 — 레포를 선택하세요");
  const s = v.trim();
  if (s.length > 100 || !REPO_RE.test(s)) throw new HttpError(400, "repo 형식이 잘못되었습니다");
  return s;
}
function parseKey(v: unknown, name = "key"): string {
  if (typeof v !== "string" || !KEY_RE.test(v.trim()) || v.trim().length > 100) {
    throw new HttpError(400, `${name} 는 소문자 슬러그(a-z0-9, -) 1~100자여야 합니다`);
  }
  return v.trim();
}
function parseName(v: unknown, name = "name"): string {
  if (typeof v !== "string" || !v.trim() || v.trim().length > 200) {
    throw new HttpError(400, `${name} 은 1~200자 문자열이어야 합니다`);
  }
  return v.trim();
}

// audit — domainmap-curation.audited 와 동일 시맨틱(결과 시점 ok/failed, change_id/httpStatus 분리).
async function audited<T>(
  action: string, user: LivelyUser, ctx: CapabilityCtx | undefined,
  extra: Record<string, unknown>, fn: () => Promise<T>,
): Promise<T> {
  const base = { audit: "domainmap_crud", action, by: user.userId, source: ctx?.source ?? "unknown", ...extra };
  try {
    const result = await fn();
    const changeId = (result as { change_id?: unknown } | null)?.change_id;
    logger.info({ ...base, outcome: "ok", ...(changeId !== undefined ? { changeId } : {}) });
    return result;
  } catch (err) {
    const httpStatus = err instanceof HttpError ? err.status : undefined;
    logger.info({ ...base, outcome: "failed", ...(httpStatus !== undefined ? { httpStatus } : {}),
      error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

// repo rename/deprecate 의 agent 금지 가드(M-마 capability 층). repo 는 인프라 엔티티 —
//  에이전트가 day-2 로 만드는 것(create)까지는 허용하되, 기존 repo 의 개명·폐기는 사람 큐레이션 전용.
function denyAgentRepoCuration(ctx: CapabilityCtx | undefined, op: string): void {
  if (ctx?.source === "mcp") {
    throw new HttpError(403, `repo ${op} 은 사람(웹)만 가능합니다 — 에이전트는 거부됩니다`);
  }
}
const actorType = (ctx: CapabilityCtx | undefined): "agent" | "human" => (ctx?.source === "mcp" ? "agent" : "human");

// ════════ repo CRUD 3종 ════════

const repoCreate: Capability = {
  name: "repo_create",
  title: "레포 생성",
  description:
    "새 레포(repo)를 도메인맵에 만든다 — 도메인의 상위 통제 계층. 이름 형식(A-Za-z0-9._-)·중복 검증, " +
    "예약된 리포 이름은 403. 신뢰우선(곧바로 active). 반환 {id,name,change_id}.",
  scope: "context",
  input: { name: z.string().trim().min(1).max(100).regex(REPO_RE).describe("레포 이름") },
  expose: {
    mcp: true,
    rest: [{
      method: "POST",
      paths: ["/api/ui/domainmap/repo/create"],
      parse: (req) => ({ name: parseRepo((req.body ?? {}).name) }),
    }],
  },
  handler: async (input: { name: string }, user, ctx) =>
    audited("repo_create", user, ctx, { name: input.name }, () =>
      dmWrite(() => coreCreateRepo(input.name, webActor(user.userId, actorType(ctx))))),
};

const repoRename: Capability = {
  name: "repo_rename",
  title: "레포 이름변경",
  description:
    "레포 이름을 바꾼다(repo 는 도메인맵 자기완결 엔티티라 물리 이름변경 안전 — 도메인/매핑 보존). " +
    "보호 리포는 403, 대상/예약 이름 중복 409. ⚠ 사람(웹)만 가능 — 에이전트(MCP)는 403. 반환 {id,old_name,new_name,change_id}.",
  scope: "context",
  input: {
    name: z.string().trim().min(1).max(100).regex(REPO_RE),
    newName: z.string().trim().min(1).max(100).regex(REPO_RE),
  },
  expose: {
    mcp: true,
    rest: [{
      method: "POST",
      paths: ["/api/ui/domainmap/repo/rename"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return { name: parseRepo(b.name), newName: parseRepo(b.newName) };
      },
    }],
  },
  handler: async (input: { name: string; newName: string }, user, ctx) => {
    denyAgentRepoCuration(ctx, "이름변경");
    return audited("repo_rename", user, ctx, { name: input.name, newName: input.newName }, () =>
      dmWrite(() => coreRenameRepo(input.name, input.newName, webActor(user.userId, actorType(ctx)))));
  },
};

const repoDeprecate: Capability = {
  name: "repo_deprecate",
  title: "레포 폐기(deprecate)",
  description:
    "레포 state 를 deprecated 로 전환(undo:true 면 active 복귀). 삭제가 아니라 숨김 신호 — 도메인/매핑 보존. " +
    "보호 리포는 403. ⚠ 사람(웹)만 가능 — 에이전트(MCP)는 403. 반환 {id,name,change_id,state}.",
  scope: "context",
  input: { name: z.string().trim().min(1).max(100).regex(REPO_RE), undo: z.boolean().optional() },
  expose: {
    mcp: true,
    rest: [{
      method: "POST",
      paths: ["/api/ui/domainmap/repo/deprecate"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const out: Record<string, unknown> = { name: parseRepo(b.name) };
        if (b.undo !== undefined) {
          if (typeof b.undo !== "boolean") throw new HttpError(400, "undo 는 boolean 이어야 합니다");
          out.undo = b.undo;
        }
        return out;
      },
    }],
  },
  handler: async (input: { name: string; undo?: boolean }, user, ctx) => {
    denyAgentRepoCuration(ctx, "폐기");
    return audited("repo_deprecate", user, ctx, { name: input.name, ...(input.undo ? { undo: true } : {}) }, () =>
      dmWrite(() => setRepoState(input.name, input.undo ? "active" : "deprecated", webActor(user.userId, actorType(ctx)))));
  },
};

// ════════ domain CRUD 2종(create·rename) — edit(설명)·deprecate 는 domainmap-curation 그룹에 기존 존재 ════════

const domainCreate: Capability = {
  name: "domain_create",
  title: "도메인 생성",
  description:
    "repo 하위에 도메인(통제어휘 1개)을 만든다. propose_domain 과 달리 evidence 게이트 없는 어휘 추가 경로. " +
    "key(소문자 슬러그)·name·repo 필수, 중복/형식·rename 별칭 충돌 검증, 보호 리포 403. 신뢰우선(confirmed). " +
    "space='product'(코드앵커 도메인, 기본)|'business'(코드매핑 없는 비즈니스 기능). 반환 {repo,id,key,status,change_id}.",
  scope: "context",
  input: {
    repo: z.string().regex(REPO_RE).max(100),
    key: z.string().trim().min(1).max(100).regex(KEY_RE).describe("소문자 슬러그 (a-z0-9, -)"),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(4000).optional(),
    crossCutting: z.boolean().optional(),
    space: z.enum(["product", "business"]).optional().describe("product(코드앵커 도메인, 기본)|business(비즈니스 기능)"),
  },
  expose: {
    mcp: true,
    rest: [{
      method: "POST",
      paths: ["/api/ui/domainmap/domain/create"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const out: Record<string, unknown> = { repo: parseRepo(b.repo), key: parseKey(b.key), name: parseName(b.name) };
        if (b.description !== undefined) {
          if (typeof b.description !== "string" || b.description.length > 4000) throw new HttpError(400, "description 은 4000자 이하 문자열이어야 합니다");
          out.description = b.description;
        }
        if (b.crossCutting !== undefined) {
          if (typeof b.crossCutting !== "boolean") throw new HttpError(400, "crossCutting 은 boolean 이어야 합니다");
          out.crossCutting = b.crossCutting;
        }
        if (b.space !== undefined) {
          if (b.space !== "product" && b.space !== "business") throw new HttpError(400, "space 는 product|business 여야 합니다");
          out.space = b.space;
        }
        return out;
      },
    }],
  },
  handler: async (
    input: { repo: string; key: string; name: string; description?: string; crossCutting?: boolean; space?: "product" | "business" }, user, ctx,
  ) => {
    if (input.description !== undefined) assertNoHardSecrets(input.description, "description"); // P8 평문 시크릿 hard-block
    return audited("domain_create", user, ctx, { repo: input.repo, key: input.key }, () =>
      dmWrite(() => coreCreateDomain(input.repo, {
        key: input.key, name: input.name, description: input.description, cross_cutting: input.crossCutting, space: input.space,
      }, webActor(user.userId, actorType(ctx)))));
  },
};

const domainRename: Capability = {
  name: "domain_rename",
  title: "도메인 이름변경(soft-alias)",
  description:
    "도메인의 표시명(newName)·슬러그(newKey)를 바꾼다. ⚠ soft-alias(H3): 물리 key 는 불변이고 " +
    "(물리key→newKey) 별칭만 적재 — items DB 와 domainmap DB 가 별 DB라 cross-DB 트랜잭션이 불가하기 때문. " +
    "옛/새 슬러그 모두 같은 도메인으로 해소된다. merged 도메인 400, 슬러그 충돌 409, 보호 리포 403, " +
    "agent 가 human-소유 도메인 rename 시 403. newKey/newName 중 1개 이상 필수. 반환 {repo,id,key,old_key,new_key,aliased,after,change_id}.",
  scope: "context",
  input: {
    id: zid,
    newKey: z.string().trim().min(1).max(100).regex(KEY_RE).optional().describe("새 슬러그(선택) — 물리 key 가 아니라 별칭으로 적재"),
    newName: z.string().trim().min(1).max(200).optional().describe("새 표시명(선택)"),
  },
  expose: {
    mcp: true,
    rest: [{
      method: "POST",
      paths: ["/api/ui/domainmap/domain/:id/rename"],
      parse: (req) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "domain id 는 양의 정수여야 합니다");
        const b = (req.body ?? {}) as Record<string, unknown>;
        const out: Record<string, unknown> = { id };
        if (b.newKey !== undefined) out.newKey = parseKey(b.newKey, "newKey");
        if (b.newName !== undefined) out.newName = parseName(b.newName, "newName");
        if (out.newKey === undefined && out.newName === undefined) {
          throw new HttpError(400, "변경할 필드가 필수입니다 — newKey/newName 중 1개 이상");
        }
        return out;
      },
    }],
  },
  handler: async (input: { id: number; newKey?: string; newName?: string }, user, ctx) => {
    // cross-layer 가드(다른 어댑터 경유에도 동일 검증).
    if (input.newKey === undefined && input.newName === undefined) {
      throw new HttpError(400, "변경할 필드가 필수입니다 — newKey/newName 중 1개 이상");
    }
    return audited("domain_rename", user, ctx,
      { id: input.id, ...(input.newKey ? { newKey: input.newKey } : {}), ...(input.newName ? { renamed: true } : {}) },
      () => dmWrite(() => coreRenameDomain(input.id, { newKey: input.newKey, newName: input.newName }, webActor(user.userId, actorType(ctx)))));
  },
};

// hard-delete(영구삭제)는 비가역 — agent(MCP) 금지, 사람(웹)만. deprecate(가역·숨김)와 권한이 다르다.
function denyAgentHardDelete(ctx: CapabilityCtx | undefined, what: string): void {
  if (ctx?.source === "mcp") {
    throw new HttpError(403, `${what} 영구삭제는 사람(웹)만 가능합니다 — 에이전트는 거부됩니다(비가역). 비활성(deprecate)은 가능합니다`);
  }
}

// ════════ hard-delete(영구삭제) 2종 — deprecate(숨김 보존)와 별개의 비가역 삭제 ════════

const domainDelete: Capability = {
  name: "domain_delete",
  title: "도메인 영구삭제(hard-delete)",
  description:
    "도메인(통제어휘 1개)을 영구삭제한다 — deprecate(숨김 보존)와 달리 행 자체를 지운다(비가역). " +
    "비즈니스 기능(space='business')도 동일 경로로 삭제(id 로 지정). 안전기본: 연결된 지식(ku domain_key·다중귀속 kud) 또는 " +
    "도메인맵 매핑이 있으면 **막고 카운트를 반환**한다(blocked:true). force:true 면 cascade — 도메인맵 매핑/별칭/도메인 행 삭제 + " +
    "items DB 의 ku domain_key 클리어(단위 자체는 보존)·kud 매핑 행 삭제. ⚠ 사람(웹)만 가능 — 에이전트(MCP)는 403. " +
    "merged 도메인은 400, 보호 리포는 403. 반환(삭제): {deleted,id,key,repo,removed:{mappings,aliases,ku_cleared,kud_deleted}}.",
  scope: "context",
  input: { id: zid, force: z.boolean().optional().describe("연결이 있어도 cascade 삭제(기본 false — 연결 있으면 막고 카운트)") },
  expose: {
    mcp: true,
    rest: [{
      method: "POST",
      paths: ["/api/ui/domainmap/domain/:id/delete"],
      parse: (req) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "domain id 는 양의 정수여야 합니다");
        const b = (req.body ?? {}) as Record<string, unknown>;
        const out: Record<string, unknown> = { id };
        if (b.force !== undefined) {
          if (typeof b.force !== "boolean") throw new HttpError(400, "force 는 boolean 이어야 합니다");
          out.force = b.force;
        }
        return out;
      },
    }],
  },
  handler: async (input: { id: number; force?: boolean }, user, ctx) => {
    denyAgentHardDelete(ctx, "도메인");
    return audited("domain_delete", user, ctx, { id: input.id, ...(input.force ? { force: true } : {}) }, async () => {
      // ① 사전조회(삭제 없음): 도메인 key/repo + 도메인맵 살아있는 매핑 카운트. merged/보호리포/없음은 throw.
      const refs = await dmWrite(() => domainDeleteRefs(input.id));
      // ② cross-DB(items): 이 key 에 귀속된 ku(단일 domain_key + 다중귀속 kud) 카운트.
      const ku = await domainKnowledgeRefs(refs.key);
      const totalLinks = refs.liveMappings + ku.total;
      // ③ 가드: force 아니고 연결 있으면 막고 카운트 안내(삭제 0).
      if (!input.force && totalLinks > 0) {
        return {
          blocked: true, id: refs.id, key: refs.key, repo: refs.repo,
          refs: {
            mappings: refs.liveMappings, ku_active: ku.ku_active, ku_total: ku.ku_total, kud_rows: ku.kud_rows,
            total: totalLinks,
          },
          hint: "연결을 끊거나 force:true 로 cascade 삭제하세요(ku 단위는 보존되고 domain_key 만 클리어됩니다)",
        };
      }
      // ④ cascade: 도메인맵 쪽(매핑/별칭/도메인) 삭제 + items 쪽(ku domain_key 클리어·kud 삭제).
      const dm = await dmWrite(() => hardDeleteDomain(input.id, webActor(user.userId, actorType(ctx))));
      const cleared = await clearDomainKnowledgeRefs(refs.key);
      // dm 은 deleted shape — removed 에 cross-DB 카운트를 합쳐 단일 결과로.
      return {
        ...dm,
        removed: { ...(dm as { removed: Record<string, number> }).removed, ku_cleared: cleared.ku_cleared, kud_deleted: cleared.kud_deleted },
      };
    });
  },
};

const repoDelete: Capability = {
  name: "repo_delete",
  title: "레포 영구삭제(hard-delete)",
  description:
    "레포(repo)와 그 하위 전체(도메인/코드유닛/데이터엔티티/매핑/프로젝트/부채/별칭)를 영구삭제한다(비가역). " +
    "deprecate(숨김 보존)와 다르다. 안전기본: 살아있는 자식(도메인/코드유닛/데이터엔티티)이 있으면 **막고 카운트 반환**(blocked:true). " +
    "force:true 면 cascade 삭제. repo 는 도메인맵 자기완결 엔티티라 cross-DB cascade 없음(knowledge_unit 은 repo 직접참조 없음). " +
    "⚠ 사람(웹)만 가능 — 에이전트(MCP)는 403. 보호 리포는 403. 반환(삭제): {deleted,id,name,removed:{...}}.",
  scope: "context",
  input: {
    name: z.string().trim().min(1).max(100).regex(REPO_RE),
    force: z.boolean().optional().describe("자식이 있어도 cascade 삭제(기본 false — 있으면 막고 카운트)"),
  },
  expose: {
    mcp: true,
    rest: [{
      method: "POST",
      paths: ["/api/ui/domainmap/repo/delete"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const out: Record<string, unknown> = { name: parseRepo(b.name) };
        if (b.force !== undefined) {
          if (typeof b.force !== "boolean") throw new HttpError(400, "force 는 boolean 이어야 합니다");
          out.force = b.force;
        }
        return out;
      },
    }],
  },
  handler: async (input: { name: string; force?: boolean }, user, ctx) => {
    denyAgentHardDelete(ctx, "레포");
    return audited("repo_delete", user, ctx, { name: input.name, ...(input.force ? { force: true } : {}) }, () =>
      dmWrite(() => hardDeleteRepo(input.name, !!input.force, webActor(user.userId, actorType(ctx)))));
  },
};

export const domainmapCrudCapabilities: Capability[] = [
  repoCreate, repoRename, repoDeprecate, domainCreate, domainRename,
  domainDelete, repoDelete,
];
