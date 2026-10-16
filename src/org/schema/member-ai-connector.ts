// org 스키마 조각 — member-ai-connector(#4213 T6 #4427): **구성원이 자기 AI 계정(Claude)에 연결해 둔 앱**의 기록.
//
// 왜 DB 인가: 연결·수집 To-Be(지식 connect-collect-tobe-claude-connector-4213 §1-4)에서 기본 연결은 구성원의 Claude
//  커넥터다. 리브의 연결 제안(«팀이 쓰는 앱 중 ○○님 Claude 에 빠진 것»)·수집 단위 표의 «구성원 AI 계정» 경로(T10)·
//  [외부 앱 연결] 현황판(T13)이 모두 «누가 무엇을 연결했나» 를 묻는데, 그 사실은 그 사람의 Claude 계정에만 있다.
//  재는 길은 그 사람 홈에서 공식 CLI 를 돌리는 것뿐이다(`claude mcp list` · 수집 실행 init 의 mcp_servers) —
//  잴 때마다 남겨 두지 않으면 다음 질문 때 다시 컨테이너를 띄워야 한다.
//
// 두 표:
//  · member_ai_connector      — 사람 × 제공자 × 앱 한 줄(상태·처음 본 시각·마지막으로 본 시각·상태가 바뀐 시각).
//  · member_ai_connector_scan — 사람 × 제공자의 **마지막 확인**(언제·어디서·성공했나). 행이 0 인 사람을
//     «연결한 앱이 없다» 와 «아직 안 재 봤다» 로 가르려면 이 표가 있어야 한다(커넥터 줄만으로는 둘이 같아 보인다).
//
// ⚠ org_member 로의 FK 는 걸지 않는다 — 형제 표(org_node_link_log 등)와 같은 선택이다. 멀티테넌트 보장
//  (db/tenant-column.ts)이 자연키 PK 를 (tenant_id, …) 로 재작성하는데, 참조 FK 가 있으면 그 재작성이 막힌다.
//  그래서 저장 쪽 ON CONFLICT 는 (tenant_id, …) 를 중재자로 쓴다(org/member-ai-connectors.ts — session-apps 와 같은 규약).
import type { Pool } from "pg";
import { ensureCheck } from "./ddl-util.js";

export async function initMemberAiConnector(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_ai_connector(
      member_id TEXT NOT NULL,
      -- 어느 AI 계정의 커넥터인가. 지금은 'claude'(claude.ai 커넥터) 하나다 — 다른 제공자가 생기면 같은 표에 선다.
      provider TEXT NOT NULL DEFAULT 'claude',
      -- 앱 이름 = 하네스가 보여 주는 이름에서 «claude.ai » 를 뗀 것(Slack · Notion · Google Drive …). 우리 앱 키로 바꾸지 않는다 —
      --  그 매핑은 읽는 쪽(현황판·수집 단위 표)의 몫이고, 원래 이름을 남겨야 수집 실행이 그대로 다시 부를 수 있다.
      app TEXT NOT NULL,
      -- connected · needs-auth · failed · pending · unknown · removed(마지막 확인에서 목록에 없었다).
      status TEXT NOT NULL,
      -- 마지막으로 이 줄을 쓴 확인이 어디서 왔나 — probe(게이트웨이가 그 사람 자리에서 잼) · collect(수집 실행 시작).
      origin TEXT NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (member_id, provider, app));
    ${ensureCheck("member_ai_connector", {
      member_ai_connector_status_chk: "status IN ('connected','needs-auth','failed','pending','unknown','removed')",
      member_ai_connector_origin_chk: "origin IN ('probe','collect')",
    })}
    CREATE TABLE IF NOT EXISTS member_ai_connector_scan(
      member_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'claude',
      scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      origin TEXT NOT NULL,
      -- false = 목록을 못 얻었다(로그인 안 됨 · CLI 없음 · 시간 초과 …). 그때 커넥터 줄은 **지난 값 그대로** 둔다.
      ok BOOLEAN NOT NULL,
      error TEXT,
      connected INT NOT NULL DEFAULT 0,
      PRIMARY KEY (member_id, provider));
    ${ensureCheck("member_ai_connector_scan", { member_ai_connector_scan_origin_chk: "origin IN ('probe','collect')" })}
  `);
}
