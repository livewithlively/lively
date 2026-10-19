// 클래식 라우트 첫 세그먼트 → 앱 키(순수 표). 새 셸에서 옛 딥링크(#/knowledge/…, #/projects2/p/12 …)가 들어오면
//  이 표로 '어느 앱 프레임에 실을지'를 정한다 — 북마크·공유 링크가 새 셸에서도 그대로 산다.
//  #4632 — v2/apps.ts 에서 옮겼다(그쪽은 다시 내보낸다). 활성 키(lib/side-owner activeKeyOfRoute)가 같은 표를 읽어야 사이드바 주인 판정이 라우터와 어긋나지 않는다.
export const CLASSIC_PAGES: Record<string, string> = {
  dashboard: 'dashboard', terminal: 'terminal', projects2: 'projects2', projects: 'projects2',
  knowledge: 'knowledge', k: 'knowledge', 'k-edit': 'knowledge', trash: 'knowledge',
  context: 'context',
  system: 'system', start: 'learn', onboarding: 'learn', install: 'learn',   // #/learn 은 셸이 직접 그린다(#4179). 여기 두면 클래식 액자가 먼저 선다
  sessions: 'sessions', activate: 'system',
  //  'f'(파일 링크 #/f?root=&path=)는 여기 없다 — 셸이 자료 앱의 한 화면(자료 보기 #4672)으로 직접 그린다(main.ts 의 'f' 갈래).
};
