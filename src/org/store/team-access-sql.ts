// 구성원이 소속 팀에게서 받는 권한을 읽는 SQL 조각 (#5799) — 구성원을 읽는 세 자리(명부 · 웹 세션 · 토큰 인증)가 같은 식을 쓴다.
//  보관되지 않은 소속 팀마다 {team_id, name, role, grants} 한 조각. 아무것도 주지 않는 팀은 읽는 쪽(auth/permissions.ts sanitizeTeamAccess)이 뺀다.
//  팀의 access_role · access_grants 는 칸 이름으로 고르지 않고 행에서 꺼낸다 — 롤 창에 칸이 아직 없어도 인증 쿼리가 깨지지 않게(없으면 NULL = 주는 것 없음).
//  이 파일은 잎이다(import 없음) — 노드 에이전트 번들에 실리는 저장 계층이 그대로 가져다 쓴다.
/** @param memberIdExpr 구성원 id 를 가리키는 SQL 식(예: `org_member.id` · `m.id`) — 코드에 적힌 식만 넣는다(입력값을 넣지 않는다). */
export const teamAccessSql = (memberIdExpr: string): string => `(
  SELECT jsonb_agg(jsonb_build_object('team_id', tt.id, 'name', tt.name,
                                      'role', to_jsonb(tt) -> 'access_role', 'grants', to_jsonb(tt) -> 'access_grants') ORDER BY tt.id)
    FROM team_member tm JOIN team tt ON tt.id = tm.team_id
   WHERE tm.member_id = ${memberIdExpr} AND tt.state <> 'archived')`;
