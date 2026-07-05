// 공유 쓰기 레이어 — org_content_audit 단일 INSERT 헬퍼 + 쓰기 컨텍스트 타입.
//  v6 컷오버 전 knowledge/category/project/connector 스토어 5곳에 복붙돼 있던 audit INSERT + actor_kind 도출을
//  중앙화한다(드리프트 방지 — entity 만 호출자가 지정). org/store 의 사람-쓰기 audit(tokenHashPrefix/req_ip)은
//  컬럼 셋이 달라 별도 유지.
import { itemsPool } from "../items/store.js";
import { one } from "../domainmap/db.js";

// 쓰기 호출 맥락 — actor(누가)·source(어느 채널). v6 스토어 공통(구 5곳 중복 정의 통합).
export type WriteCtx = { actor?: string | null; source?: string };

// 삭제 스냅샷(org_content_audit before)으로부터 행 재적재 — knowledge/category/project 복원 공통 골격.
//  keyCol 로 존재검사(이미 있으면 거부=복원 대상 아님), cols 순서로 placeholder INSERT, RETURNING 으로 after 반환.
//  감사(entity_key 도출이 엔티티마다 다름)는 호출자가 after 로 수행. 구 restoreKnowledge/Category/Project 동형 추출.
export async function restoreSnapshot<T>(
  table: string, cols: string, keyCol: string, before: Record<string, unknown>,
): Promise<T> {
  const keyVal = before[keyCol];
  if (keyVal == null) throw new Error(`복원 스냅샷에 ${keyCol} 이(가) 없습니다`);
  if (await one(itemsPool, `SELECT 1 FROM ${table} WHERE ${keyCol}=$1`, [keyVal])) {
    throw new Error(`${table} ${keyCol}=${String(keyVal)} 은(는) 이미 존재합니다(삭제 상태가 아님)`);
  }
  // 스냅샷에 **있는 키만** INSERT — cols 가 나중에 늘어나면(예: #592 knowledge.is_folder, category.view_mode)
  //  구 스냅샷엔 그 키가 없다. 이를 NULL 로 밀어넣으면 NOT NULL DEFAULT 컬럼 복원이 깨지므로,
  //  부재 키는 생략해 DB DEFAULT 가 적용되게 한다(스냅샷에 명시된 null 은 그대로 복원).
  const colList = cols.split(",").map((c) => c.trim()).filter((c) => c in before);
  const placeholders = colList.map((_, i) => `$${i + 1}`).join(", ");
  const values = colList.map((c) => before[c] ?? null);
  return one(itemsPool,
    `INSERT INTO ${table}(${colList.join(", ")}) VALUES(${placeholders}) RETURNING ${cols}`, values) as Promise<T>;
}

// 쓰기 출처(source)로 actor_kind 서버강제 — mcp(에이전트)=ai, web(사람)=human, 그 외=null(레거시/cli/미상).
//  진실원천은 채널이 아니라 신원이지만(org_member.kind), 채널 기반 도출이 기본 폴백.
export function actorKindOf(source?: string | null): string | null {
  return source === "mcp" ? "ai" : source === "web" ? "human" : null;
}

// org_content_audit.channel CHECK 제약(org_content_audit_channel_chk)이 허용하는 값 — 이 set 또는 NULL 만 INSERT 가능.
const AUDIT_CHANNELS = new Set(["mcp", "web", "connector", "cli", "migration", "unknown"]);
// channel 정규화 — 허용 set 밖이면 'unknown'(catch-all)으로 강제. 호출자가 예상 밖 source 를 넘겨도 audit INSERT 가
//  제약에 걸려 거부되고 그를 부른 상위 작업(예: regenAgents→ensureAgentsMd)이 함께 깨지는 걸 막는다. NULL 은 허용이라 보존.
export function normalizeAuditChannel(raw?: string | null): string | null {
  if (raw == null) return null;
  return AUDIT_CHANNELS.has(raw) ? raw : "unknown";
}

// org_content_audit append-only INSERT(단일 진실). channel=source(어댑터가 결정적 주입). before/after 는 JSONB 직렬화.
//  channelOverride 로 channel 을 source 와 분리(커넥터 미러처럼 source≠channel 인 경우).
//  raw source 는 source 컬럼에 그대로 보존(포렌식) — 정규화는 channel 에만(normalizeAuditChannel).
export async function auditOrgContent(
  entity: string, entityKey: string, op: string, before: unknown, after: unknown,
  ctx?: WriteCtx, channelOverride?: string,
): Promise<void> {
  const source = ctx?.source ?? null;
  const channel = normalizeAuditChannel(channelOverride ?? source);
  await itemsPool.query(
    `INSERT INTO org_content_audit(entity, entity_key, op, before, after, actor, source, channel, actor_kind)
     VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9)`,
    [entity, entityKey, op,
     before == null ? null : JSON.stringify(before),
     after == null ? null : JSON.stringify(after),
     ctx?.actor ?? null, source, channel, actorKindOf(source)]);
}
