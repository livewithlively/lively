// org 스키마 조각 — session-ask(#5713): **세션의 AI 가 사람에게 건 요청**(값 입력 · 고르기 · 파일 올리기 …).
//
//  종전엔 이 요청이 리브 프로필(org_member.liv_profile.secret_ask)에 «사람당 한 칸» 으로 얹혀 있었다 — 리브 세션 하나만
//  묻는다는 전제였다. 이제 어느 세션이든 물을 수 있으므로(여러 세션이 동시에) 행으로 뗀다.
//   · id         — 주소가 된다(`#/ask/<id>` — 로컬 터미널 AI 가 사람에게 주는 링크). 추측 못 하는 임의 값.
//   · member_id  — 요청을 건 사람(= 그 AI 가 쓰는 토큰의 사람). **그 사람만** 보고 답한다 — 같이 보는 세션이어도
//                  값은 요청한 사람의 금고로 가므로 남에게 칸을 보이지 않는다.
//   · session_id — 어느 세션에서 건 요청인가(접속 헤더 x-lively-session). 세션 화면 곁칸의 «요청» 칸이 이걸로 고른다.
//                  세션을 모르는 자리(헤더 없는 MCP 클라이언트)에서 걸면 NULL — 그때는 링크 화면에서만 보인다.
//   · kind       — 종류. **CHECK 를 걸지 않는다** — 종류는 코드 등록부(src/asks/kinds.ts)가 정본이고 계속 는다.
//   · payload    — 무엇을 받을지(사람에게 보일 말 + 넣을 자리). ⚠ **값은 절대 담기지 않는다**(시크릿은 금고로 직행).
//   · result     — 끝난 뒤 AI 가 읽을 요약(무엇을 골랐나 · 저장됐나). 시크릿 값은 여기에도 없다.
//  ⚠ tenant_id 는 boot/schemas.ts 의 ensureTenantColumn 이 붙이고 PK 를 (tenant_id, id) 로 다시 쓴다.
import type { Pool } from "pg";
import { ensureCheck } from "./ddl-util.js";

export async function initSessionAsk(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_session_ask(
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      session_id TEXT,
      kind TEXT NOT NULL,
      slot TEXT NOT NULL DEFAULT '',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'open',
      result JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ);
    ${ensureCheck("org_session_ask", { org_session_ask_status_chk: "status IN ('open','done','dismissed','canceled')" })}
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_session_ask_open_idx ON org_session_ask(member_id, session_id) WHERE status='open';`);
}
