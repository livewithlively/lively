// lib/liv-entry.ts — 리브 화면(#/liv)으로 들어가는 문을 보일지(#4970). 한 곳에서 켜고 끈다.
//
//  처음 설정이 «리브 대화» 로 끝나던 길을 걷으면서(외부 앱 연결은 보통 세션의 연결 스킬이 한다) 리브 탭은 드나드는 문이 아니게 됐다.
//  1차는 **진입점만 숨긴다** — 화면·라우트·리브 기억(liv_profile)·점검 스킬(liv)은 그대로다. 되살리려면 이 값만 true 로 바꾼다.
//  숨기는 자리: 레일 링크(rail.ts) · 사이드바 바로 가기(side.ts) · 모바일 시트(mobile.ts) · [나] 창의 «리브와 이야기하기»(me-modal.ts).
export const LIV_ENTRY_VISIBLE: boolean = false;
