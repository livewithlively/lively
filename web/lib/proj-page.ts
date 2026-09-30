// 프로젝트 화면의 주소 한 벌(#3870).
//
//  원준 2026-09-30 신고: "검색 창에서 프로젝트를 골라서 누르면 프로젝트 창으로 들어가게 해줘. 이 텍스트 입력기 있는
//   new=1로 보내지말고".
//  통합검색(⌘K)은 프로젝트 줄을 `#/p/<id>` 로 보냈다. 그 주소는 2026-08-20 부터 '거쳐 가는 문'이다 — 라우터가
//   그 프로젝트의 맨 위 세션으로 갈아 끼우고, 세션이 없으면 새 세션 자리(지시 입력칸 · 주소 `?new=1`)를 연다.
//   즉 검색에서 프로젝트를 골라도 프로젝트 화면은 한 번도 열리지 않았다.
//  프로젝트 화면은 사이드바 카드의 [→] 가 여는 `#/app/projects2/p/<id>` 다(main.ts openProjectPage). 검색도 그 문으로 간다.
//  주소를 만드는 곳과 읽는 곳이 갈리면 한쪽만 바뀌어 다시 어긋나므로 둘 다 여기 둔다.

const PAGE_RE = /^#\/app\/projects2\/p\/(\d+)$/;

/** 프로젝트 화면 주소 — 사이드바 [→] 와 통합검색이 여는 자리. */
export function projectPageHref(id: number | string): string {
  return '#/app/projects2/p/' + Number(id);
}

/** 주소가 프로젝트 화면이면 그 번호, 아니면 0. 도구 화면(`…/p/<id>/board`)·세션 문(`#/p/<id>`)은 0 이다. */
export function projectPageId(href: string): number {
  const m = PAGE_RE.exec(String(href || ''));
  const id = m ? Number(m[1]) : 0;
  return id > 0 ? id : 0;
}

/** 프로젝트 검색 결과의 이동 자리 — **행의 층에 맞는 화면**으로.
 *  ⚠ 응답의 `project_id` 는 비어 있다(실측 2026-08-24: 태스크 행도 null). 그래서 `project_id || id` 로 폴백하면
 *   **태스크 id 를 프로젝트 id 로 착각해** 엉뚱한 프로젝트로 간다(없는 번호면 빈 화면). 층을 보고 갈라 준다:
 *   프로젝트는 프로젝트 화면, 태스크·서브태스크는 제 주소를 가진 클래식 태스크 모달(#/projects2/t/<id>). */
export function projHitHref(p: { id: number | string; level?: string }): string {
  const id = Number(p.id);
  return p.level === 'task' || p.level === 'subtask' ? '#/projects2/t/' + id : projectPageHref(id);
}
