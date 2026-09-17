// v2/banner-text.ts — 브라우저 알림 배너의 문구(#4054). 우리 모듈 import 0 인 leaf — 시험이 컴파일 산출물을 그대로 싣는다.
//
// 신고(상민님 2026-09-17): "모든 알림에 대해 상단에 슬랙처럼 어느 워크스페이스의 알림인지 명시해야 할 것 같다."
//  데스크톱 앱 배너(desktop/main/notify.mjs bannerFor)와 같은 규칙이다 — 워크스페이스 이름을 알면 **윗줄(제목)이
//  워크스페이스**이고, 알림 제목과 본문은 그 아래 한 줄로 내린다. 이름을 모르면 종전 모양(제목 = 알림 제목).
//  브라우저 Notification 엔 부제가 없어서 본문 앞에 붙인다(데스크톱 앱의 macOS 외 모양과 같다).

/** 윗줄에 적을 워크스페이스 이름의 상한 — 데스크톱 앱(WS_NAME_MAX)과 같은 값이다. */
export const BANNER_WS_NAME_MAX = 60;

export function browserBannerText(title: string, body: string | null | undefined, wsName?: string | null): { title: string; body?: string } {
  const t = String(title || '').trim() || '라이블리';
  const b = String(body || '').trim();
  const ws = String(wsName || '').replace(/\s+/g, ' ').trim().slice(0, BANNER_WS_NAME_MAX);
  if (!ws) return b ? { title: t, body: b } : { title: t };
  return { title: ws, body: b ? `${t} — ${b}` : t };
}
