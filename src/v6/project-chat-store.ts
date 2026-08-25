// 프로젝트 화면의 리브 대화(#1757) — (프로젝트 × 사람) 하나에 대화 하나. 스키마: v6/schema/project-chat.ts.
//  담는 것은 **되그리기 목차**뿐이다: 이 대화의 하네스 세션 uuid(--resume 열쇠) + 사람이 한 말(턴 id·본문·시각·실행 세션).
//  리브의 말은 그 턴의 진행 파일이 정본이라 여기 없다(홈 리브의 org_member.liv_profile.chat 과 같은 분업 — members.ts).
//  개인 UI 상태 성격(감사 대상 아님) — 남의 대화는 구조상 못 읽는다(호출부가 늘 자기 member_id 로 부른다).
import { itemsPool } from "../db/client.js";

export interface ProjectChatTurn {
  id: string;     // 턴 id(t + hex16 — capability 가 만든다)
  text: string;   // 사람이 한 말
  at: string;     // ISO
  sid?: string;   // 그 턴을 돌린 박스 세션 id(멈추기 열쇠 — 프로필 쓰기가 실패해도 턴 폴더의 session 파일이 백업)
}
export interface ProjectChat {
  session_id: string;   // 하네스 대화 uuid — 첫 턴이 만들고 이후 턴이 --resume 으로 이어받는다
  started_at: string;
  turns: ProjectChatTurn[];
}

/** 되그리기 목차 상한 — 그 이상은 앞부터 버린다(대화 자체는 하네스 세션이 기억한다). 홈 리브(members.ts appendLivTurn cap 30)와 같은 크기 감각. */
const TURN_CAP = 40;

function rowToChat(row: any): ProjectChat | null {
  if (!row) return null;
  const turns = Array.isArray(row.turns) ? row.turns : [];
  return {
    session_id: String(row.session_id),
    started_at: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
    turns: turns.map((t: any) => ({ id: String(t.id), text: String(t.text ?? ""), at: String(t.at ?? ""), sid: t.sid ? String(t.sid) : undefined })),
  };
}

export async function getProjectChat(projectId: number, memberId: string): Promise<ProjectChat | null> {
  const r = await itemsPool.query(
    "SELECT session_id, started_at, turns FROM project_chat WHERE project_id=$1 AND member_id=$2", [projectId, memberId]);
  return rowToChat(r.rows[0]);
}

/** 새 대화 시작(또는 restart) — 세션 uuid 를 새로 걸고 목차를 비운다. */
export async function startProjectChat(projectId: number, memberId: string, sessionId: string): Promise<ProjectChat> {
  const r = await itemsPool.query(
    `INSERT INTO project_chat(project_id, member_id, session_id, started_at, turns, updated_at)
     VALUES($1,$2,$3,now(),'[]'::jsonb,now())
     ON CONFLICT (tenant_id, project_id, member_id) DO UPDATE SET
       session_id=EXCLUDED.session_id, started_at=now(), turns='[]'::jsonb, updated_at=now()
     RETURNING session_id, started_at, turns`,
    [projectId, memberId, sessionId]);
  return rowToChat(r.rows[0])!;
}

/** 턴 하나를 목차에 잇는다(상한 넘으면 앞부터 버림). 대화 행이 없으면 아무것도 안 한다(호출부가 start 를 먼저 한다).
 *  읽고-고쳐-쓰기다 — 같은 사람의 같은 대화는 화면이 한 번에 한 턴만 보내므로(sendWhileBusy=false) 경합이 없다. */
export async function appendProjectChatTurn(projectId: number, memberId: string, turn: ProjectChatTurn): Promise<void> {
  const cur = await getProjectChat(projectId, memberId);
  if (!cur) return;
  const turns = [...cur.turns, turn].slice(-TURN_CAP);
  await itemsPool.query(
    "UPDATE project_chat SET turns=$3::jsonb, updated_at=now() WHERE project_id=$1 AND member_id=$2",
    [projectId, memberId, JSON.stringify(turns)]);
}
