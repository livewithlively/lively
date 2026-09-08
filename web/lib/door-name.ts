// 판 문패가 보여 줄 **프로젝트 이름**을 고르는 한 자리 (#2579).
//
//  왜 판단이 필요한가 — 이름의 사본이 둘이다.
//   · 판(v2/panes.ts)이 마운트 때 한 번 읽은 `detail.project.name`
//   · 셸이 8초마다 다시 읽고 rename 이 즉시 손보는 `data.projects`
//  종전에는 앞의 것만 봤다. 그래서 다른 화면(프로젝트 탭 상세·사이드바 줄 더블클릭)에서 이름을 바꾸면
//  **그 탭을 닫았다 열기 전까지** 문패만 옛 이름을 들고 있었다(원준 2026-09-03 신고).
//
//  ⚠ 「목록이 늘 이긴다」가 아니다 — 목록에 그 프로젝트가 **없을 수도** 있다(막 만든 것, 필터 밖, 아직 안 온 첫 판).
//   그때 목록을 믿으면 이름이 '프로젝트 #123' 같은 자리표시자로 **퇴보한다**. 모르면 쥐고 있던 것을 지킨다.

export interface DoorProjectRow { id: number | string; name?: string | null }

/**
 * 문패에 쓸 이름.
 *  @param projects 셸이 들고 있는 프로젝트 목록(가장 신선한 이름의 출처)
 *  @param id 이 판의 프로젝트 id
 *  @param cached 판이 들고 있던 이름(detail 사본) — 목록이 모를 때 쓰는 바탕
 */
export function doorProjectName(projects: ReadonlyArray<DoorProjectRow> | null | undefined, id: number, cached: string): string {
  if (!Array.isArray(projects) || !(Number(id) > 0)) return cached;
  const row = projects.find((x) => Number(x?.id) === Number(id));
  const fresh = String(row?.name ?? "").trim();
  return fresh || cached;
}
