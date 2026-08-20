// org 스키마 조각 — node-state(#1834): **노드 세션 스냅샷의 정본(SoT)**.
//
// 왜 DB 인가(상민님 지시 2026-08-20 "근본 해결해. 디비로 남겨야지. SoT 가 디비가 되게 해"):
//  종전 정본은 게이트웨이 메모리(src/node/registry.ts `states`)였다. 그래서 **게이트웨이를 재배포할 때마다
//  노드 세션 목록이 통째로 비었고**, 노드가 다시 붙어 상태를 보고할 때까지(최악 33초 — 재연결 백오프 상한 30초
//  + 상태 push 3초, src/node/agent.ts BACKOFF_MAX_MS·STATE_PUSH_MS) 살아 있는 세션이 화면에서 사라졌다.
//  그 빈 판을 본 화면이 "이 세션은 없어졌다"고 오판해 세션 화면을 다른 세션으로 갈아치우는 사고까지 났다
//  (web/v2/panes-parts.ts sessionsPart.paint 주석).
//  이제 노드 보고가 이 표에 쌓이고, 게이트웨이는 **부팅 때 이 표를 읽어** 캐시를 채운다 — 재배포는 목록에 보이지 않는다.
//
// 행 수명: 노드 1대 = 1행(last-write-wins). 노드를 지우면 store.deleteNode 가 이 행도 지운다.
//  오래된 스냅샷은 **읽는 쪽이 제외한다**(node-state-store.ts STATE_KEEP_MS) — 몇 주 꺼져 있던 PC 의
//  옛 세션 목록까지 되살리지는 않는다(그 tmux 는 재부팅으로 이미 사라졌을 값이다).
// 쓰기 빈도: 노드는 3초마다 보고하지만 이 표는 **세션 목록이 바뀔 때**와 무변경 최소 간격(60초)에만 쓴다
//  (node-state-store.ts shouldPersist) — 정본을 최신으로 두면서 write 를 노드당 분당 1회 수준으로 묶는다.
import type { Pool } from "pg";

export async function initNodeState(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_node_state(
      -- ⚠ org_node 로의 FK 는 **일부러 걸지 않는다**(형제 표 org_node_session_map 과 같은 선택):
      --  멀티테넌트 보장(db/tenant-column.ts)이 자연키 PK 를 (tenant_id, …) 복합으로 다시 만드는데,
      --  참조 FK 가 걸려 있으면 그 재작성이 막혀 **부팅 스키마 체인이 통째로 죽는다**. 대신 지워진 노드의
      --  잔재는 읽는 쪽 JOIN(node-state-store.loadNodeStates)이 걸러 내고, 노드 삭제는 store.deleteNode 가 지운다.
      node_id TEXT PRIMARY KEY,
      -- 게이트웨이가 이 스냅샷을 받은 시각. '노드가 마지막으로 살아 있던 때'로도 읽힌다(신선도 판정의 근거).
      reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      sessions JSONB NOT NULL DEFAULT '[]'::jsonb,
      -- 상시 노출 리소스(§10) — 위탁 스케줄러의 배치 입력. 세션과 달리 계속 흔들리는 값이라 변경 감지에서는 뺀다.
      res JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
  `);
}
