// lib/proj-draft.ts — 초안 프로젝트(#4170 · #5522)를 화면이 가려내는 잣대와 그 말 한 자리.
//
//  초안 = 세션 첫 지시로 저절로 생긴 프로젝트. #5522 부터 만든 사람과 팀원만 본다(src/v6/visibility.ts). 무언가를 남기거나
//   제목 · 본문을 정리하면 서버가 풀어 모두에게 보인다(src/v6/project-draft.ts · project-store.updateProject).
//  화면 여러 곳(프로젝트 표 · 칸반 · 「리스트」 · [프로젝트] 사이드바 · 홈 사이드바 카드)이 **같은 잣대**로 가려야 사이드바의
//   수와 목록의 묶음이 서로 맞는다. 그래서 잣대와 말은 여기 한 벌이다.
//  잎 모듈(import 0) — proj-none.ts 와 같은 까닭이다(화면 코드 안에 있으면 시험할 데가 없다).

/** 이 판정이 프로젝트 행(서버 목록 응답 그대로)에게 묻는 것. */
export interface DraftLike {
  draft?: boolean | null;
  status?: string | null;
}

/**
 * 초안인가. 완료한 것은 초안으로 세지 않는다 — 서버는 완료할 때 초안을 내리지만(updateProject), 옛 행이 남아 있어도
 *  완료 묶음 · 완료 보기에 제대로 서야 한다(#4170 부터의 규칙).
 */
export function isDraftProj(p: DraftLike | null | undefined): boolean {
  return !!p && p.draft === true && p.status !== 'done';
}

/** 초안 묶음 · 표시 · 사이드바 줄의 이름. */
export const DRAFT_LABEL = '초안';

/** 묶음 머리 · 사이드바 줄에 붙는 한 줄 설명 — 누가 보고 언제 풀리는지. */
export const DRAFT_HINT = '나와 초대한 사람만 봅니다 · 작업을 남기거나 제목 · 본문을 정리하면 공개됩니다';

/** 표시에 올렸을 때의 긴 설명(title). */
export const DRAFT_TIP = '세션 첫 지시로 자동 생성된 프로젝트입니다. 나와 초대한 사람에게만 보이고, 작업을 남기거나 제목 · 본문을 정리하면 모두에게 공개됩니다.';
