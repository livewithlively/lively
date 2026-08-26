// org 스키마 조각 — node-link-log(#1849): **노드가 붙고 끊긴 시각의 기록**.
//
// 왜 DB 인가: "이 노드가 왜 자꾸 끊기나"는 **한 시점의 상태로는 절대 답할 수 없다** — 이력의 모양이 곧 원인이다.
//  실측(2026-08-23 `haruui-macbookair`): 연결 유지 56~64초 · 재연결 간격 3583~3591초(≈1시간)의 반복이
//  잠자기(dark wake 창에서만 잠깐 붙음)의 지문이었다. 그 판정을 하려면 최근 몇 시간의 up/down 이 있어야 한다.
//  종전엔 이 정보가 **게이트웨이 로그 파일에만** 있었다 — 사람이 ssh 로 들어가 grep 해야 보였고(그래서 사용자는
//  "이 노드가 연결돼 있지 않습니다" 한 줄만 보고 원인도 조치도 알 수 없었다), 게이트웨이를 재배포하면 흩어졌다.
//
// 행 수명: 노드당 최근 LINK_LOG_KEEP 개만 남긴다(store.appendNodeLinkEvent 가 삽입 때 잘라낸다).
//  진단은 최근 24시간만 보므로(sleep-pattern.ts) 그 이상은 저장할 이유가 없다. 노드 삭제 시 함께 지운다.
// 쓰기 빈도: 연결/해제 때만 — 정상 노드는 하루 몇 건, 병든 노드도 하루 수십 건이다(상태 push 와 달리 저빈도).
import type { Pool } from "pg";

/** 노드당 보관하는 최근 이벤트 수 — 24시간 진단에 넉넉하고(병든 노드 하루 ~50건), 무한 증식을 막는다. */
export const LINK_LOG_KEEP = 60;

export async function initNodeLinkLog(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_node_link_log(
      -- ⚠ org_node 로의 FK 는 **일부러 걸지 않는다** — 형제 표(org_node_state·org_node_session_map)와 같은 선택이다:
      --  멀티테넌트 보장(db/tenant-column.ts)이 PK 를 (tenant_id, …) 복합으로 재작성하는데, 참조 FK 가 있으면
      --  그 재작성이 막혀 부팅 스키마 체인이 통째로 죽는다. 지워진 노드의 잔재는 store.deleteNode 가 지운다.
      id BIGSERIAL PRIMARY KEY,
      node_id TEXT NOT NULL,
      -- 'up' = 노드 WSS 가 붙음 · 'down' = 끊김. 그 둘뿐이다(재연결 교체도 down→up 두 줄로 남는다).
      ev TEXT NOT NULL CHECK (ev IN ('up','down')),
      at TIMESTAMPTZ NOT NULL DEFAULT now());

    -- 진단은 항상 "이 노드의 최근 N개"를 본다 — 그 접근을 그대로 인덱스로 만든다.
    CREATE INDEX IF NOT EXISTS org_node_link_log_node_at ON org_node_link_log(node_id, at DESC);
  `);
}
