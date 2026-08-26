// 세션의 '얼굴'(이름·소속) 고르기(#2022) — 화면이 세션 목록에서 그 세션을 못 찾았을 때 쓰는 폴백 규칙.
//  순수 함수로 떼어 둔 이유: 이 규칙이 틀리면 화면이 **거짓말**을 한다(남의 이름·없는 소속). 값으로 검증한다
//  (scripts/sess-face.test.mjs).
//
//  우선순위 — 위가 이긴다:
//   ① subject_label      서버가 지금 desired-state(DB)에서 읽어 실어 준 **정본**(capabilities/app-instances.ts)
//   ② memo.n             이 브라우저가 지난 판에 실제로 그려 본 이름(#2028 sessNames — 아직 ①도 안 왔을 때)
//   ③ title              인스턴스를 연 그 순간의 스냅샷. 늙는다(실측 'claude · resume'·'/status') — 그래서 맨 뒤다.
//  소속(projectId)은 서버 정본이 먼저, 없으면 인스턴스가 기억하는 소속: subject_project_id → project_id.
//  (소속은 로컬 기억을 두지 않는다 — 이름과 달리 탭 저장본에 남는 값이 아니라 지어낼 재료가 없다.)
//
//  ⚠ **id 를 이름으로 쓰지 않는다.** 저장된 title 이 세션 id 그대로인 행이 실제로 있다(실측 2026-08-26:
//   'box-yoon-96519b67'). 그걸 '아는 이름'으로 넘기면 화면은 폴백을 멈추고 id 를 이름 자리에 그린다 —
//   고치려던 그림과 똑같아진다. 이름이 없으면 **빈 문자열**을 돌려주고, 그 판정은 호출부가 한다.
export interface SessFaceSource {
  title?: string | null;
  subject_label?: string | null;
  subject_project_id?: number | null;
  project_id?: number | null;
}
export interface SessFaceMemo { n?: string }

const clean = (v: unknown): string => String(v ?? '').trim();

export function pickSessFace(
  id: string,
  inst?: SessFaceSource | null,
  memo?: SessFaceMemo | null,
): { title: string; projectId: number } {
  const sid = clean(id);
  const named = (v: unknown): string => { const t = clean(v); return t && t !== sid ? t : ''; };
  const title = named(inst?.subject_label) || named(memo?.n) || named(inst?.title);
  const projectId = Number(inst?.subject_project_id || inst?.project_id || 0) || 0;
  return { title, projectId };
}
