// org/store 공용 감사 seam — append-only org_content_audit 기록 + 조회(#549).
//  (#1313 R18) 구 org/store.ts(갓 모듈)에서 verbatim 분리. audit()/sha256 은 store/ 형제 모듈 전용
//  공유 헬퍼라 여기서만 export 하고 배럴(org/store.ts)은 재수출하지 않는다(분할 전 private 유지).
import crypto from "node:crypto";
import type pg from "pg";
import { itemsPool } from "../../db/client.js";
import { SINGLE_TENANT_ID } from "../../db/tenant-column.js";
import { redactDeep } from "../ingest/redact.js";

// 쓰기 호출 맥락 — 감사 보강(누가/어느 토큰/어디서). delivery 핸들러가 web.ts 의 ctx 에서 구성해 전달.
export interface WriteCtx { actor?: string; source?: string; tokenHashPrefix?: string | null; ip?: string | null }

export const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

// 감사 채널(#549) — source 리터럴을 org_content_audit.channel enum(mcp|web|connector|cli|migration|unknown)으로 정규화.
//  '어떤 경로로 이 변경이 일어났나'. mcp=에이전트 MCP, web=웹 관리탭(web-self 포함), connector=커넥터 미러, migration=마이그레이션.
function sourceToChannel(source: string | undefined): string | null {
  if (!source) return null;
  if (source === "mcp") return "mcp";
  if (source === "web" || source === "web-self") return "web";
  if (source === "connector") return "connector";
  if (source === "cli") return "cli";
  if (source === "migrate" || source === "migration") return "migration";
  return "unknown";
}

// ── 감사 (append-only) ──
export async function audit(
  entity: string,
  key: string | null,
  op: string,
  before: unknown,
  after: unknown,
  actor: string | undefined,
  source: string | undefined,
  meta?: { tokenHashPrefix?: string | null; ip?: string | null } | pg.PoolClient,
): Promise<void> {
  // #880: 마지막 인자로 PoolClient 를 주면 그 트랜잭션에서 INSERT(호출부의 BEGIN/COMMIT 원자성). 그 외는 meta.
  const client = (meta && typeof (meta as pg.PoolClient).query === "function") ? (meta as pg.PoolClient) : undefined;
  const m = client ? undefined : (meta as { tokenHashPrefix?: string | null; ip?: string | null } | undefined);
  const exec = client ?? itemsPool;
  // B20: before/after 를 굳히기 전 시크릿 redaction — 감사 로그가 평문 토큰/키의 사본이 되지 않게.
  const b = before == null ? null : JSON.stringify(redactDeep(before));
  const a = after == null ? null : JSON.stringify(redactDeep(after));
  // #549(윤상민 요구 "누가 사람/AI·어떤 경로·언제·내용"): actor_kind = 누가 바꿨나(사람/AI/시스템). 진실원천은
  //  org_member.kind(신원)지 채널이 아니다(yoon 이 mcp 로 써도 human) → actor(=member id)로 조인 파생(agent→ai).
  //  actor 지정됐는데 멤버 아님=unknown, 미지정=NULL. channel(어떤 경로)은 source 에서 정규화. 에이전트가 MCP 로
  //  관리기능을 만지게 열렸으므로(#549) 이 두 컬럼이 'AI 가 관리탭을 바꿨다'를 감사에 드러낸다.
  //  ⚠ 이 서브쿼리는 **스칼라**다 — 2행이 오면 그 자리에서 오류이고, 그 오류는 위 INSERT 뒤에 나므로
  //   엔티티 쓰기는 이미 커밋된 채 응답만 500 이 된다. org_member 는 신원 전역 표라 tenant 조건이
  //   없었는데, 계정행이 워크스페이스마다 갈라지면(#1879) 정확히 그 조합이 났다. 갈라짐 자체는
  //   db/tenant-column.ts 의 pinIdentityGlobalTenant 가 막지만, **읽는 쪽도 못박아 둔다** —
  //   접지 못하고 남은 옛 행 하나가 감사 걸린 모든 org 쓰기를 다시 500 으로 만들지 않도록.
  await exec.query(
    `INSERT INTO org_content_audit(entity, entity_key, op, before, after, actor, source, token_hash_prefix, req_ip, actor_kind, channel)
     VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,
       CASE WHEN $6::text IS NULL THEN NULL
            ELSE COALESCE((SELECT CASE m.kind WHEN 'agent' THEN 'ai' WHEN 'system' THEN 'system' WHEN 'human' THEN 'human' ELSE 'unknown' END
                             FROM org_member m WHERE m.id = $6 AND m.tenant_id = '${SINGLE_TENANT_ID}'::uuid), 'unknown') END,
       $10)`,
    [entity, key, op, b, a, actor ?? null, source ?? null,
     m?.tokenHashPrefix ?? null, m?.ip ?? null, sourceToChannel(source)],
  );
}

// ── org 관리 변경 감사 조회(#549) — org_content_audit(append-only 단일 소스)를 필터·페이징으로 읽는다. ──
//  '민감한' 관리 엔티티(멤버·권한·런타임·데이터소스·훅·툴 등)가 기본 스코프. knowledge/project/category 등 일반
//  콘텐츠 변경은 각 화면에 전용 이력(도메인 should·태스크 피드)이 있어 기본 제외(entity 지정 시엔 조회 가능).
//  before/after 는 저장 시 이미 redactDeep(시크릿 마스킹)된 스냅샷 — 조회는 admin 전용(delivery.ts org_audit_list).
export const ADMIN_AUDIT_ENTITIES = [
  "org_member", "auth_token", "org_profile", "org_section",
  "org_runtime_config", "org_connector", "org_collector", "org_collector_preset", "org_classifier", "org_manager", "org_mcp_server", "org_hook", "org_tool", "org_harness_asset", "org_asset_pref",
  "org_db_source", "org_db_table_policy", "org_db_column_mask",
] as const;

export interface ContentAuditRow {
  id: number; at: string; entity: string; entity_key: string | null; op: string;
  before: unknown; after: unknown;
  actor: string | null; actor_kind: string | null; actor_display: string | null;
  source: string | null; channel: string | null; token_hash_prefix: string | null; req_ip: string | null;
}
export interface ContentAuditFilter {
  entities?: string[] | null;   // null/빈 = 엔티티 제약 없음(전체)
  entity_key?: string | null;
  actor?: string | null;
  actor_kind?: string | null;
  channel?: string | null;
  op?: string | null;
  since?: string | null;        // ISO(inclusive)
  until?: string | null;
  limit?: number;
  offset?: number;
}

// 필터 = 파라미터화(엔티티 배열은 ANY, 나머지는 'null=제약없음'). rows(before/after 포함) + total(같은 WHERE count).
//  actor 는 org_member 조인으로 표시이름(actor_display) 파생 — 목록에서 'yoon' 대신 '윤상민'.
export async function listContentAudit(f: ContentAuditFilter): Promise<{ rows: ContentAuditRow[]; total: number }> {
  const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 500);
  const offset = Math.min(Math.max(Number(f.offset) || 0, 0), 1_000_000);
  const entities = f.entities && f.entities.length ? f.entities : null;
  // ⚠ 이 필터는 CSV 내보내기(audit-export-routes.ts, kind=org)가 같은 의미로 복제한다 — 화면과 CSV 가 다르면
  //  감사 자료로 못 쓴다. 여기를 고치면 거기도 같이 고칠 것.
  const where = `WHERE ($1::text[] IS NULL OR a.entity = ANY($1))
                   AND ($2::text IS NULL OR a.entity_key = $2)
                   AND ($3::text IS NULL OR a.actor = $3)
                   AND ($4::text IS NULL OR a.actor_kind = $4)
                   AND ($5::text IS NULL OR a.channel = $5)
                   AND ($6::text IS NULL OR a.op = $6)
                   AND ($7::timestamptz IS NULL OR a.at >= $7::timestamptz)
                   AND ($8::timestamptz IS NULL OR a.at <= $8::timestamptz)`;
  const params: unknown[] = [
    entities, f.entity_key || null, f.actor || null, f.actor_kind || null,
    f.channel || null, f.op || null, f.since || null, f.until || null,
  ];
  const [rowsRes, countRes] = await Promise.all([
    itemsPool.query(
      `SELECT a.id, a.at, a.entity, a.entity_key, a.op, a.before, a.after,
              a.actor, a.actor_kind, a.source, a.channel, a.token_hash_prefix, a.req_ip,
              m.display_name AS actor_display
         FROM org_content_audit a
         LEFT JOIN org_member m ON m.id = a.actor
         ${where}
        ORDER BY a.at DESC, a.id DESC
        LIMIT $9 OFFSET $10`,
      [...params, limit, offset],
    ),
    itemsPool.query(`SELECT count(*)::int AS total FROM org_content_audit a ${where}`, params),
  ]);
  return {
    rows: rowsRes.rows as ContentAuditRow[],
    total: (countRes.rows[0] as { total: number } | undefined)?.total ?? 0,
  };
}
