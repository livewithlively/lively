// 노션 페이지 고르기 안내 · 모은 페이지 수 (#1968, 2026-09-15 원준 결정).
//
//  노션 동의 화면의 페이지 선택기는 노션 것이다 — 최근 본 페이지·즐겨찾기만 먼저 보여 주고 나머지는 검색해야 나온다.
//  «전체 선택»도, 팀스페이스를 통째로 고르는 칸도 없다. 대신 상위 페이지를 고르면 하위 페이지 접근이 함께 따라온다
//  (developers.notion.com/docs/authorization). 원준이 처음 설정에서 목록이 다 뜰 줄 알고 들어갔다가 페이지를 하나씩
//  검색해 골랐다. 그래서 처음 설정(onboarding.ts)과 외부 앱 연결(connect.ts)이 **같은 문장**으로 미리 말한다 —
//  두 화면의 말이 갈라지지 않게 문장은 여기 한 벌만 둔다(scripts/notion-pick-guide.test.mjs 가 잠근다).

/** 노션 화면에 들어가기 전에 읽히는 한 문장. */
export const NOTION_PICK_TIP = '노션 화면엔 «전체 선택»이 없어요. 사이드바 맨 위 페이지만 검색해서 고르면 그 아래 페이지는 전부 함께 들어옵니다.';

/**
 * 모은 노션 페이지 수 — 켜진 워크스페이스 중 **첫 수집이 끝난 곳**만 더한다.
 *  끝난 곳이 하나도 없거나 서버가 셀 수 없었으면(pages=null) null 이다. 수집이 끝나기 전의 0 을 «0개»로 말하면 거짓이다.
 */
export function notionCollectedPages(state: any): number | null {
  const done = ((state && state.workspaces) || [])
    .filter((w: any) => w && w.enabled && w.first_sync_done && typeof w.pages === 'number');
  return done.length ? done.reduce((sum: number, w: any) => sum + w.pages, 0) : null;
}

/** 모은 페이지 수를 말하는 문장 — 더 고르는 자리는 화면마다 달라서 뒷말은 각 화면이 붙인다. */
export function notionCollectedLine(n: number): string {
  return n > 0 ? `노션 페이지 ${n.toLocaleString('ko-KR')}개를 모았어요.` : '노션 페이지를 아직 하나도 모으지 못했어요.';
}
