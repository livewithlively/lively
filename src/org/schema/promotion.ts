// org 스키마 조각 — promotion(#1750): 개인 워크스페이스 → 팀 워크스페이스 **승격 요청 큐**.
//  워크스페이스 1개 = 게이트웨이 1개(현 구조 그대로). 개인 워크스페이스의 사람/AI 가 지식·프로젝트를 "연결한 팀 워크스페이스"로
//  올리려 할 때, 그 요청이 여기 한 행으로 선다. 승인은 **올리는 사람 본인**(개인 워크스페이스는 1인) — 사람이 웹에서 승인/거절하고,
//  연결(org_linked_workspace = member_secret kind 'lively_workspace')에 auto_promote 를 켜 두면 AI 요청도 즉시 실행된다.
//  ⚠ 연결 자체(원격 주소·토큰)는 여기 두지 않는다 — 토큰이 있는 것이라 member_secret(봉투 암호화 vault)에 산다.
//  상태기계: pending → approved → done | failed / pending → rejected. approved 는 실행 중 표식(짧게 머문다).
//  멱등: 같은 (member, link, kind, target) 의 pending 은 하나만(knowledge_revision 의 partial unique 선례) — 에이전트가 두 번 부르면 기존 행을 돌려준다.
//  FK 없음 — 감사·이력 성격(대상 지식이 지워져도 "올리려 했다"는 기록은 남는다, org_content_audit 규약).
import type { Pool } from "pg";
import { ensureCheck } from "./ddl-util.js";

export async function initPromotion(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_promotion_request(
      id BIGSERIAL PRIMARY KEY,
      member_id TEXT NOT NULL,
      link_scope TEXT NOT NULL,
      kind TEXT NOT NULL,
      target_ref TEXT NOT NULL,
      title TEXT,
      note TEXT,
      remote_category TEXT,
      state TEXT NOT NULL DEFAULT 'pending',
      requested_by TEXT,
      requested_via TEXT,
      actor_kind TEXT,
      result JSONB,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      decided_at TIMESTAMPTZ, decided_by TEXT,
      done_at TIMESTAMPTZ);
    ${ensureCheck("org_promotion_request", {
      org_promotion_request_state_chk: "state IN ('pending','approved','rejected','done','failed')",
      org_promotion_request_kind_chk: "kind IN ('knowledge','project')",
    })}
    CREATE UNIQUE INDEX IF NOT EXISTS org_promotion_request_pending_uq
      ON org_promotion_request(member_id, link_scope, kind, target_ref) WHERE state='pending';
    CREATE INDEX IF NOT EXISTS org_promotion_request_member_idx ON org_promotion_request(member_id, state, created_at DESC);
  `);
}
