// delivery ▸ audit — org 관리 변경 감사 조회(#549).
import type { Capability } from "../types.js";
import { z } from "zod";
import { listContentAudit, ADMIN_AUDIT_ENTITIES } from "../../org/store.js";
import { restOnly } from "./shared.js";

export const auditCapabilities: Capability[] = [
  // ── org 관리 변경 감사 조회(#549) — 누가(사람/AI)·언제·무엇을·어디서(mcp/web) 바꿨는지 + before/after. ──
  //  에이전트가 MCP 로 관리기능을 만지게 열렸으므로(restOnly mcp=true), 그 변경 이력을 admin 이 조회하는 표면.
  restOnly("org_audit_list", "조직 변경 감사 조회",
    "org-content 관리 변경(구성원·토큰·런타임·커넥터·DB소스·훅·툴 등)의 감사 로그를 최신순으로 조회한다. " +
    "필터: entity·actor·actor_kind(human/ai/system)·channel(mcp/web/…)·op·기간(since/until ISO8601)·페이징(limit≤500·offset). " +
    "기본은 민감 관리 엔티티만 — scope='all' 이면 지식·프로젝트 등 전체 포함. before/after 는 저장 시 시크릿이 마스킹된 스냅샷.",
    [{ method: "GET", paths: ["/api/ui/org/audit"], parse: (req) => ({
        entity: req.query?.entity, scope: req.query?.scope, entity_key: req.query?.entity_key,
        actor: req.query?.actor, actor_kind: req.query?.actor_kind, channel: req.query?.channel,
        op: req.query?.op, since: req.query?.since, until: req.query?.until,
        limit: req.query?.limit, offset: req.query?.offset,
      }) }],
    async (input: Record<string, unknown>) => {
      const i = input ?? {};
      const s = (v: unknown): string => (v == null ? "" : String(v).trim());
      const entity = s(i.entity);
      const scopeMode = s(i.scope); // ''|'admin'=민감 기본, 'all'=전체
      const entities = entity ? [entity] : (scopeMode === "all" ? null : [...ADMIN_AUDIT_ENTITIES]);
      const offset = Math.min(Math.max(Number(i.offset) || 0, 0), 1_000_000);
      const limN = Number(i.limit);
      const limit = Number.isFinite(limN) && limN > 0 ? Math.min(Math.floor(limN), 500) : 50;
      const opt = (v: unknown): string | null => s(v) || null;
      const { rows, total } = await listContentAudit({
        entities, entity_key: opt(i.entity_key), actor: opt(i.actor), actor_kind: opt(i.actor_kind),
        channel: opt(i.channel), op: opt(i.op), since: opt(i.since), until: opt(i.until), limit, offset,
      });
      return {
        rows, total, limit, offset,
        filters: { entity: entity || null, scope: scopeMode || "admin", actor: opt(i.actor),
                   actor_kind: opt(i.actor_kind), channel: opt(i.channel), op: opt(i.op) },
        // 드롭다운 옵션(고정 어휘) — entity 는 민감 관리 목록, 나머지는 감사 enum.
        entityOptions: [...ADMIN_AUDIT_ENTITIES],
        channelOptions: ["mcp", "web", "connector", "cli", "migration", "unknown"],
        actorKindOptions: ["human", "ai", "connector", "system", "unknown"],
        opOptions: ["insert", "update", "delete", "revoke", "mint", "reorder"],
      };
    }, {
      entity: z.string().optional().describe("특정 엔티티만(org_member|auth_token|org_runtime_config|org_connector|org_db_source|org_hook|org_tool 등)"),
      scope: z.enum(["admin", "all"]).optional().describe("admin(기본, 민감 관리 엔티티만)|all(지식·프로젝트 등 전체)"),
      entity_key: z.string().optional().describe("특정 엔티티 키(예: 멤버 id)"),
      actor: z.string().optional().describe("변경 주체 멤버 id"),
      actor_kind: z.enum(["human", "ai", "connector", "system", "unknown"]).optional().describe("누가(사람/AI/시스템)"),
      channel: z.enum(["mcp", "web", "connector", "cli", "migration", "unknown"]).optional().describe("경로(mcp/web/…)"),
      op: z.string().optional().describe("작업: insert|update|delete|revoke|mint|reorder"),
      since: z.string().optional().describe("시작 시각 ISO8601"),
      until: z.string().optional().describe("끝 시각 ISO8601"),
      limit: z.number().optional().describe("페이지 크기(≤500, 기본 50)"),
      offset: z.number().optional().describe("페이지 오프셋"),
    }),
];
