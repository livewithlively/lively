// 프로젝트 세션 목록(GET /v6/projects/:id/sessions)의 «이 세션이 이 프로젝트 것인가» 판정 — 한 자리.
//
//  ★ 2026-10-04(#4135, 원준 신고): 프로젝트 허브 «터미널 세션» 위젯이 «아직 이 프로젝트의 세션이 없습니다»
//   라고 했는데 그 프로젝트에 만든 세션이 분명히 있었다(#4528 「아이콘 세션 찾기」, 중단됨).
//   원인 — 노드 좌표가 없는 복원 가능 세션을 **게이트웨이 자신의 프로젝트 폴더 경로 아래인가** 로만 가렸다.
//   중앙 세션 호스트에서 돈 세션의 폴더는 `/work/shared/project/<id>` 라 게이트웨이 경로와 달라 **전부 빠졌다**
//   (그 계정에서만 같은 모양 220개). AI 세션 목록은 같은 행을 projectId 로 실어 보여 주고 있었다 — 두 목록이 갈렸다.
//  규칙: 세션 행이 아는 projectId(DB `project_id`)가 이 프로젝트면 이 프로젝트 것이다. 경로는 projectId 가
//   없는 옛 행을 위한 보조다. 중단된 세션도 언제든 다시 살릴 수 있으므로 «지금 안 돈다» 는 빼는 이유가 아니다.

export interface ScopeRow { dir?: string; projectId?: number | null; node?: unknown }

/** base = 게이트웨이의 이 프로젝트 폴더(절대 경로). sep = 경로 구분자. */
export function projectSessionBelongs(s: ScopeRow, pid: number, base: string, sep = "/"): boolean {
  if (Number(s.projectId) > 0) return Number(s.projectId) === pid;
  //  projectId 를 모르는 행만 경로로 판정한다. 노드 행은 노드의 경로라 이 박스의 base 와 견줄 수 없다.
  if (s.node) return false;
  return !!s.dir && (s.dir === base || s.dir.startsWith(base + sep));
}
