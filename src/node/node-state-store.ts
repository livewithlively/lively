// 노드 세션 스냅샷의 **정본 I/O**(#1834) — org_node_state 읽기/쓰기 + 순수 판정 3종.
//
// 왜 있나: 종전 정본은 게이트웨이 메모리(registry.ts `states`)뿐이라 **재배포 한 번에 노드 세션 목록이 통째로
//  사라졌다**(스키마 근거·사고 경위는 org/schema/node-state.ts 머리말). 이제 정본은 이 표이고, 메모리는 그 캐시다:
//   · 부팅 — loadNodeStates() 로 캐시를 채운다(재배포 직후에도 목록이 그대로 보인다).
//   · 보고 — 노드 state push 마다 캐시를 갱신하고, 아래 shouldPersist 가 참일 때 정본에 쓴다.
//   · 조회 — 캐시(동기)에서 답한다. 조회마다 DB 를 때리지 않으므로 목록 API 비용은 종전과 같다.
//
// 캐시가 정본과 어긋날 수 있나: 쓰기는 이 게이트웨이만 한다(노드는 게이트웨이에만 보고한다). 그래서
//  "정본 ← 캐시" 방향의 지연만 있고(무변경 최대 60초), 값이 갈라지지는 않는다. 여러 게이트웨이가 같은 DB 를
//  보는 배치라도 각자 자기에게 붙은 노드만 쓰므로 행이 겹치지 않는다.
import { itemsPool } from "../db/client.js";
import type { SessionInfo } from "../terminal/terminal-sessions.js";
import type { NodeResources } from "./protocol.js";

/** 스냅샷을 계속 보여 줄 기한. 노드가 이 기간 넘게 조용하면 목록에서 뺀다 —
 *  몇 주 꺼져 있던 PC 의 옛 세션은 그 tmux 가 재부팅으로 이미 사라졌을 값이라, 되살리면 유령 목록이 된다. */
export const STATE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** 세션 목록이 **그대로**일 때 정본을 다시 쓰는 최소 간격. 노드는 3초마다 보고하지만 그걸 그대로 쓰면
 *  노드당 분당 20회 write 다 — 정본의 쓸모(재부팅 복구)에 필요한 신선도는 분 단위면 충분하다. */
export const STATE_WRITE_MIN_MS = 60_000;

/** 변경 감지용 서명 — **세션 목록만** 본다. 리소스(res)는 매 보고마다 흔들려서 넣으면 늘 '바뀜'이 된다. */
export function sessionsDigest(sessions: SessionInfo[] | null | undefined): string {
  return JSON.stringify(sessions ?? []);
}

/** 지금 이 보고를 정본에 쓸까 — 처음이거나, 세션 목록이 바뀌었거나, 무변경이라도 최소 간격이 지났으면 쓴다. */
export function shouldPersist(prev: { digest: string; at: number } | null | undefined, digest: string, now: number): boolean {
  if (!prev) return true;
  if (prev.digest !== digest) return true;
  return now - prev.at >= STATE_WRITE_MIN_MS;
}

/** 이 스냅샷을 아직 보여 줄까(보존 기한 안인가). 시각을 모르면 **보여주지 않는다** —
 *  근거 없는 행을 목록에 올리는 쪽이, 안 올려서 노드 재연결 몇 초를 기다리는 쪽보다 나쁘다. */
export function isFresh(reportedAt: number, now: number): boolean {
  if (!Number.isFinite(reportedAt) || !Number.isFinite(now)) return false;
  return now - reportedAt < STATE_KEEP_MS;
}

export interface StoredNodeState {
  nodeId: string; reportedAt: number; sessions: SessionInfo[]; res: NodeResources | null;
  name: string; kind: string; owner: string;
}

/** 정본 전체를 읽는다(부팅 hydrate). org_node 조인이라 **지워진 노드의 잔재는 애초에 안 나온다**. */
export async function loadNodeStates(now: number = Date.now()): Promise<StoredNodeState[]> {
  const r = await itemsPool.query(
    `SELECT s.node_id, s.reported_at, s.sessions, s.res, n.name, n.kind, n.owner_member
       FROM org_node_state s JOIN org_node n ON n.id = s.node_id`,
  );
  const out: StoredNodeState[] = [];
  for (const row of r.rows as Array<Record<string, unknown>>) {
    const reportedAt = new Date(String(row.reported_at)).getTime();
    if (!isFresh(reportedAt, now)) continue;
    out.push({
      nodeId: String(row.node_id),
      reportedAt,
      sessions: Array.isArray(row.sessions) ? (row.sessions as SessionInfo[]) : [],
      res: (row.res as NodeResources | null) ?? null,
      name: String(row.name || row.node_id),
      kind: String(row.kind || "member"),
      owner: String(row.owner_member || ""),
    });
  }
  return out;
}

/** 이 노드의 스냅샷을 정본에 쓴다(last-write-wins).
 *  ⚠ ON CONFLICT 키에 tenant_id 를 넣는다 — 멀티테넌트 배포에서 자연키 PK 는 `(tenant_id, …)` 복합으로
 *   재생성된다(db/tenant-column.ts). 단일 배포에도 같은 컬럼·제약이 있으므로 SQL 방언은 하나다. */
export async function saveNodeState(
  nodeId: string, sessions: SessionInfo[], res: NodeResources | null, at: number = Date.now(),
): Promise<void> {
  await itemsPool.query(
    `INSERT INTO org_node_state(node_id, reported_at, sessions, res, updated_at)
       VALUES($1, to_timestamp($2::double precision / 1000.0), $3::jsonb, $4::jsonb, now())
     ON CONFLICT (tenant_id, node_id) DO UPDATE SET
       reported_at=EXCLUDED.reported_at, sessions=EXCLUDED.sessions, res=EXCLUDED.res, updated_at=now()`,
    [nodeId, at, JSON.stringify(sessions ?? []), res ? JSON.stringify(res) : null],
  );
}
