// v6 스키마 조각 — project-chat(#1757): 새 셸 프로젝트 화면의 **리브 대화**(프로젝트 도우미) 한 벌.
//  왜 별도 표인가: 리브 홈 대화는 org_member.liv_profile.chat(사람당 하나)에 산다. 프로젝트 대화는 (프로젝트 × 사람)마다
//  하나라 그 jsonb 에 맵으로 쌓으면 한 행이 끝없이 커진다(턴 본문 ≤8,000자 × 프로젝트 수). 행 하나 = 대화 하나가 맞다.
//  왜 사람 축이 있나: 대화의 실체는 그 사람의 격리 OS 유저 아래 도는 하네스 세션(--resume)이라 남이 이어받을 수 없다.
//   같은 프로젝트라도 사람마다 자기 대화다(대화가 바꾼 결과 — 본문·태스크 — 는 프로젝트에 남아 전원이 본다).
//  turns 는 되그리기용 목차(사람이 한 말 + 턴 id)만 — 리브의 말은 그 턴의 진행 파일(.lively-task/<id>/stream.jsonl)이 정본.
//  ⚠ tenant_id 는 boot/schemas.ts 의 ensureTenantColumn 이 붙이고 PK 를 (tenant_id, project_id, member_id) 로 다시 쓴다 —
//   그래서 store 의 ON CONFLICT 는 그 세 컬럼을 명시한다(node-session-map·member_side_pref 와 같은 관례).
import type { Pool } from "pg";

export async function initV6ProjectChat(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_chat(
      project_id INT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      turns JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (project_id, member_id));
  `);
}
