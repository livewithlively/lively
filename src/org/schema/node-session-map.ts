// org 스키마 조각 — node-session-map(#1752 갭2): **노드 세션**의 box-id ↔ 하네스 대화 uuid 매핑.
//  왜 별도 표인가: org_session_state 는 게이트웨이 박스 세션의 desired-state 미러다(노드 세션은 노드가 DB 없이
//  만들어 행이 없다 — session-state.ts 헤더). 그래서 work-flag 훅의 /claude-uuid 보고가 노드 세션에선 UPDATE 0행으로
//  증발했고, 채팅창이 그 세션의 중앙 기록(session_log — 키가 곧 대화 uuid)에 영영 못 닿았다("대화 id 를 아직 모릅니다").
//  org_session_state 에 노드 세션을 INSERT 하는 길은 기각 — 그 표의 소비자(복원 목록·reaper)가 노드 세션을
//  '박스에서 복원 가능'으로 오판한다. 얇은 전용 표가 안전하다.
//  행 수명: 세션 수명과 무관하게 남는다(매핑은 기록을 읽는 열쇠 — 세션이 죽고 노드가 꺼져도 유효). last-write-wins
//  (한 box 안에서 /clear·resume 으로 uuid 가 바뀌면 최신만). owner 는 첫 보고자 고정 — 남의 세션 오염 차단(upsert 가드).
import type { Pool } from "pg";

export async function initNodeSessionMap(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_node_session_map(
      box_id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      conv_uuid TEXT NOT NULL,
      transcript_path TEXT,
      owner TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
  `);
}
