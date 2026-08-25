// v2/aside-slot.ts — 오른쪽 곁칸(우패널)에 **손님 화면**(같은 오리진 iframe)을 끼우는 창구.
//  쓰는 데: 미리보기(#1036) — 종전엔 [화면 열기 ↗] 가 새 창을 띄웠다. 새 창은 작업하던 자리를 떠나게 하고
//  (탭이 하나 늘고, 돌아오면 어디였는지 다시 찾는다), 화면을 고치며 확인하는 일에는 **옆에 띄워 두는 것**이 맞다
//  (원준님 2026-08-20).
//
//  ⭐ 이 모듈이 따로 있는 이유는 크기가 아니라 **순환**이다. 손님을 부르는 쪽은 잎(projects/detail-preview ·
//   admin-preview)이고 실제로 끼우는 쪽은 껍데기(v2/main)다. 잎이 껍데기를 import 하면 껍데기 → 잎 → 껍데기가
//   된다(#1313 §1). 그래서 둘 다 이 잎을 본다: 껍데기가 setAsideGuestOpener 로 채우고, 잎은 openInAside 로 부른다.
//
//  ⚠ 부르는 잎은 대개 **앱 프레임 안**에 있다 — 미리보기 버튼이 사는 관리탭·클래식 프로젝트 상세는 둘 다 껍데기가
//   iframe 으로 싣는 화면이라, 그 안의 이 모듈은 껍데기와 **다른 창**이다(setAsideGuestOpener 가 안 불린다).
//   그래서 프레임 안에서는 postMessage 로 부모에게 부탁한다(세션 화면 ↔ 터미널 프레임의 다리와 같은 수법).
//   악수(ping/pong)는 **미리** 해 둔다 — 누를 때 물으면 답을 기다리는 사이 사용자 제스처가 풀려, 곁칸이 없을 때의
//   새 창 폴백이 팝업 차단에 걸린다. canOpenInAside() 가 그 악수 결과를 동기로 돌려준다.

export interface AsideGuest {
  /** 같은 손님인지 가리는 키(예: 'preview:<환경 id>') — 이미 그 손님이 떠 있으면 다시 만들지 않는다(iframe 리로드 방지). */
  key: string;
  /** 곁칸 머리에 적을 이름. */
  title: string;
  /** 곁칸에 실을 주소(같은 오리진). */
  url: string;
}

export const ASIDE_MSG = { ping: 'lively-aside-ping', pong: 'lively-aside-pong', open: 'lively-aside-open' } as const;

type Opener = (g: AsideGuest) => boolean;
let opener: Opener | null = null;
let parentReady = false;                       // 부모(껍데기)가 '곁칸 내줄 수 있다'고 답했다

/** 껍데기(v2/main)가 자기 우패널을 내주며 한 번 채운다. */
export function setAsideGuestOpener(fn: Opener | null): void { opener = fn; }

/** 지금 이 화면에서 곁칸을 쓸 수 있나 — 버튼을 그릴 때 문구·동작을 고르는 데 쓴다(막다른 버튼 금지). */
export function canOpenInAside(): boolean { return !!opener || parentReady; }

/** 열었으면 true. 곁칸을 못 쓰면 false — 부르는 쪽이 그 자리에서(제스처가 살아 있을 때) 새 창으로 폴백한다. */
export function openInAside(g: AsideGuest): boolean {
  if (opener) return opener(g);
  if (!parentReady) return false;
  try { window.parent.postMessage({ type: ASIDE_MSG.open, guest: g }, location.origin); return true; }
  catch { return false; }
}

// ── 프레임 안이면 부모와 미리 악수해 둔다 ──────────────────────────────────────────────
//  껍데기가 프레임을 만들기 전에 listener 를 달아 두지만, 프레임이 먼저 뜨는 경합도 있으므로 몇 번 더 부른다.
//  껍데기가 아닌 부모(다른 사이트에 끼워진 경우)는 답하지 않으므로 parentReady 가 false 로 남는다 — 그게 안전한 기본값이다.
if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.origin !== location.origin || ev.source !== window.parent) return;
    if (ev.data && ev.data.type === ASIDE_MSG.pong) parentReady = true;
  });
  const ping = (): void => { try { window.parent.postMessage({ type: ASIDE_MSG.ping }, location.origin); } catch { /* 부모가 닫혔다 */ } };
  ping();
  window.setTimeout(ping, 400);
  window.setTimeout(ping, 1500);
}
