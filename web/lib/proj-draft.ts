// lib/proj-draft.ts — 초안 프로젝트(#4170 · #5522)를 화면이 가려내는 잣대와 그 말 한 자리.
//
//  초안 = 세션 첫 지시로 저절로 생긴 프로젝트. #5522 부터 만든 사람과 팀원만 본다(src/v6/visibility.ts). 무언가를 남기거나
//   제목 · 본문을 정리하면 서버가 초안에서 푼다(src/v6/project-draft.ts · project-store.updateProject). 풀린 뒤 누가 보는지는
//   그 프로젝트의 공개 범위가 정한다(#5598 — 초대제면 초대한 사람만, 아니면 모두. lib/proj-access.ts).
//  화면 여러 곳(프로젝트 표 · 칸반 · 「리스트」 · [프로젝트] 사이드바)이 **같은 잣대**로 가려야 사이드바의 수와 목록이
//   서로 맞는다. 그래서 잣대 · 말 · 「초안 보기」 토글은 여기 한 벌이다.
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

/** 뱃지 · 토글 · 사이드바 줄의 이름. */
export const DRAFT_LABEL = '초안';

/** 사이드바 「초안」 줄에 붙는 한 줄 설명 — 초안이 무엇이고 누가 보는지.
 *  #5598 — «풀리면 공개됩니다» 는 여기서 말하지 않는다. 초대제 프로젝트의 초안은 풀려도 초대한 사람만 보기 때문이다
 *  (프로젝트마다 다르다 — 뱃지에 올렸을 때의 설명은 lib/proj-access.ts draftTipFor 가 그 프로젝트에 맞춰 말한다). */
export const DRAFT_HINT = '세션 첫 지시로 자동 생성된, 아직 정리 전인 프로젝트 · 나와 초대한 사람만 봅니다';

// ── 「초안 보기」 토글(#5522, 상민 2026-11-16) ─────────────────────────────────────
//  «초안만 묶어 놓는 건 말이 안 된다 — 뱃지 하나 두고 프로젝트랑 똑같이 보이게, 위쪽 토글로 초안을 볼지 고르게.»
//  그래서 초안은 목록 어디서든 제 자리(상태 · 시간 · 리스트 묶음)에 서고 «초안» 뱃지만 단다. 토글을 끄면 프로젝트 화면 전체
//   (보드의 모든 뷰 · [프로젝트] 사이드바의 수)에서 빠진다. 「초안」 스코프(사이드바 「초안」 줄)는 토글과 상관없이 초안을 보여 준다.
//  기기마다 기억한다(localStorage) — 보드 액자와 셸 사이드바가 같은 출처라 같은 값을 읽고, 바뀌면 storage 이벤트로 서로 안다.
//  기본은 꺼짐(#5794, 상민 2026-11-25 «스위치 off 가 디폴트» — 11-16 의 «기본은 봄» 을 뒤집었다). 켠 사람만 '1' 을 남긴다.
//   옛 값 '0'(기본이 보임이던 때 끈 사람)은 그대로 숨김으로 읽힌다 — 옮길 것이 없다.

/** 토글 값이 사는 자리. '1' = 보임 · 없음(또는 옛 '0') = 숨김(기본). */
export const DRAFTS_SHOWN_KEY = 'pjv:showDrafts';

/** 초안을 보이나(기본 false). 저장소를 못 읽으면(사생활 보호 창 등) 기본값. */
export function draftsShown(): boolean {
  try { return globalThis.localStorage?.getItem(DRAFTS_SHOWN_KEY) === '1'; } catch { return false; }
}

/** 토글을 바꾼다. 기본(숨김)은 키를 지워 둔다 — 저장소에 남는 것은 «보임» 하나뿐이다. */
export function setDraftsShown(on: boolean): void {
  try {
    if (on) globalThis.localStorage?.setItem(DRAFTS_SHOWN_KEY, '1');
    else globalThis.localStorage?.removeItem(DRAFTS_SHOWN_KEY);
  } catch { /* 못 적어도 이번 화면은 바뀐다 — 다음에 열면 기본(숨김)으로 돌아온다 */ }
}

/** 토글을 따라 거른다 — 보이면 그대로, 숨기면 초안을 뺀다. */
export function withDraftToggle<T>(arr: readonly T[], shown: boolean): T[] {
  return shown ? arr.slice() : arr.filter((p) => !isDraftProj(p as DraftLike | null | undefined));
}

/**
 * 「리스트」 뷰 오른쪽 위 개수 글(#5522).
 *  거르개(기간 · 사람 · 상태 · 검색)가 아무것도 안 걸렀으면(shown === all) «<noun> N개», 걸렀으면 «K개 표시 · 전체 N».
 *  토글로 숨긴 초안이 있으면 끝에 « · 초안 M개 숨김» — 목록에서 빠진 것이 있다는 것을 말한다.
 * @param shown 지금 그린 줄 수 · @param all 이 스코프에서 보이는 전체 수(숨긴 초안 제외) · @param hiddenDrafts 토글로 숨긴 초안 수
 */
export function draftCountText(shown: number, all: number, hiddenDrafts: number, noun: string): string {
  const base = shown === all ? `${noun} ${all}개` : `${shown}개 표시 · 전체 ${all}`;
  return hiddenDrafts > 0 ? `${base} · ${DRAFT_LABEL} ${hiddenDrafts}개 숨김` : base;
}
