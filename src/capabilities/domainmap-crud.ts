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
// v6: 도메인 CRUD(create/rename/delete)는 category(space='product')로 cutover — 구 domains.ts(domain 테이블) 폐기.
//  '주제 분류' 관리섹션이 이 REST 를 호출(리스트는 이미 category 읽기) → 쓰기도 category 로 일치(단일 DB·FK CASCADE).
import {
  createRepo as coreCreateRepo, renameRepo as coreRenameRepo, setRepoState, hardDeleteRepo,
} from "../domainmap/core/repos.js";
import { makeAudited } from "./audit-log.js";
import type { Capability, CapabilityCtx } from "./types.js";
import { HttpError } from "./rest-util.js";

const REPO_RE = /^[A-Za-z0-9._-]+$/;

function parseRepo(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, "repo 필수 — 레포를 선택하세요");
  const s = v.trim();
  if (s.length > 100 || !REPO_RE.test(s)) throw new HttpError(400, "repo 형식이 잘못되었습니다");
  return s;
}

// audit — domainmap-curation.audited 와 동일 시맨틱(결과 시점 ok/failed, change_id/httpStatus 분리).
const audited = makeAudited("domainmap_crud");

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




// hard-delete(영구삭제)는 비가역 — agent(MCP) 금지, 사람(웹)만. deprecate(가역·숨김)와 권한이 다르다.
function denyAgentHardDelete(ctx: CapabilityCtx | undefined, what: string): void {
  if (ctx?.source === "mcp") {
    throw new HttpError(403, `${what} 영구삭제는 사람(웹)만 가능합니다 — 에이전트는 거부됩니다(비가역). 비활성(deprecate)은 가능합니다`);
  }
}

// ════════ hard-delete(영구삭제) 2종 — deprecate(숨김 보존)와 별개의 비가역 삭제 ════════


const repoDelete: Capability = {
  name: "repo_delete",
  title: "레포 영구삭제(hard-delete)",
  description:
    "레포(repo)와 그 하위 전체(도메인/코드유닛/데이터엔티티/매핑/프로젝트/부채/별칭)를 영구삭제한다(비가역). " +
    "deprecate(숨김 보존)와 다르다. 안전기본: 살아있는 자식(도메인/코드유닛/데이터엔티티)이 있으면 **막고 카운트 반환**(blocked:true). " +
    "force:true 면 cascade 삭제. repo 는 도메인맵 자기완결 엔티티라 cross-DB cascade 없음(v6 knowledge 는 repo 직접참조 없음). " +
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

// v6 은퇴(2026-06-24): domainCreate/Rename/Delete 정의·등록 제거 — '주제 분류' 패널 폐기 +
//  v6 category CRUD(categories.ts/category-store)가 단일 표면. repo CRUD 는 실엔티티라 유지.
export const domainmapCrudCapabilities: Capability[] = [
  repoCreate, repoRename, repoDeprecate, repoDelete,
];
