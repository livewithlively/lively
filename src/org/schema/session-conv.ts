// org 스키마 조각 — session-conv(#2233): 한 세션(박스)이 **살면서 돌린 대화 전부**의 기록.
//
//  ── 왜 별도 표인가 ──
//  org_session_state.claude_session_id 는 last-write-wins 다("지금 붙어 있는 대화"). 그런데 한 박스는 살면서
//  대화를 여러 번 갈아탄다 — /clear · resume · 포크(claude 가 «제목 (2)» 로 새 파일을 연다) · 맥락 압축 롤오버.
//  갈아탈 때마다 옛 uuid 가 덮여 사라지니, 그 대화에서 사람이 던진 질문은 **세션 화면에서 영영 안 보인다**.
//  실측(2026-08-27, box-jang-ebdb3a82): 한 박스의 폴더에 대화 파일 5개 · 질문 43개인데 타임라인엔 1개만 떴다(2.3%).
//  그래서 보고를 덮지 말고 **쌓는다** — (박스, 대화) 한 쌍이 한 행이다.
//
//  ── 무엇을 보장하나 ──
//  · 박스 세션(org_session_state)·노드 세션(org_node_session_map) 어느 쪽이든 같은 표에 쌓인다(둘 다 같은 훅 보고).
//  · owner 는 첫 보고자 고정 — 남의 box_id 를 가로채 남의 대화를 이 박스에 매다는 오염을 막는다(다른 두 표와 같은 가드).
//  · 행은 세션이 죽어도 남는다(기록을 읽는 열쇠). 세션 완전삭제(purge)가 지운다.
import type { Pool } from "pg";

export async function initSessionConvLog(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_session_conv(
      box_id TEXT NOT NULL,
      conv_uuid TEXT NOT NULL,
      transcript_path TEXT,
      owner TEXT NOT NULL,
      node_id TEXT,
      first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (box_id, conv_uuid));
  `);
  // 목록 조회는 늘 '이 박스의 것, 오래된 순' 이다.
  await pool.query(`CREATE INDEX IF NOT EXISTS org_session_conv_box_idx ON org_session_conv(box_id, first_seen);`);
}
