// web/lib/local-owner.ts — **이 브라우저에 남은 기억은 누구 것인가**(#2460).
//
// ── 왜 필요한가 ─────────────────────────────────────────────────────────────
//  #1875 는 브라우저 기억을 **워크스페이스**로 갈랐다(net.ts wsKey). 그런데 축이 하나 더 있었다 — **사람**.
//   로그아웃은 토큰만 지운다(core.ts logout). `lively_v2_*` 는 전부 남는다. 그래서 같은 브라우저에서
//   계정을 바꾸면 앞사람의 **열린 창 행이 그대로 서고**(sideInstances ③ 은 force=true 라 서버를 안 본다),
//   `lively_v2_sess_names` 에 캐시된 **세션 제목까지** 보인다. 눌러 봐야 서버가 막지만, 목록에는 뜬다.
//   워크스페이스 누수보다 나쁘다 — 그건 내 다른 워크스페이스지만 이건 **남의 것**이다.
//
// ── 방식: 도장을 찍고, 주인이 바뀌면 지운다 ─────────────────────────────────
//  로그인한 사람의 id 를 한 자리(OWNER_KEY)에 적어 둔다. 다음 부팅에 그 값이 다르면 **이 브라우저의
//   기억을 비우고 새로고침**한다. 새로고침이 필요한 이유: 워크스페이스별 키(wsKey)는 모듈이 실릴 때
//   한 번 계산되므로, 지우기만 하고 그대로 가면 이미 계산된 옛 키로 이번 판을 마저 돈다.
//   (워크스페이스 전환이 location.reload() 를 거치는 것과 같은 사정 — net.ts wsKey 머리말.)
//
// ── ★ 폴라리티: **남길 것만 적는다**(모르면 지운다) ─────────────────────────
//  «지울 것 목록»으로 짜면 나중에 누가 저장소를 하나 늘렸을 때 **그게 곧 누수**다. 반대로 «남길 것
//   목록»이면 늘어난 저장소는 자동으로 지워진다 — 새 사람이 앞사람 취향을 한 번 잃을 뿐, 남의 내용을
//   보지는 않는다. 지키려는 것이 프라이버시라면 그 방향이 맞다.
//  남기는 것은 **«이 창이 어떻게 보이나»** 뿐이다(테마·글꼴·폭·셸 모드). 누가 보든 같은 값이고,
//   지우면 새 사람이 이유 없이 낯선 화면을 받는다.
import { TOKEN_KEY } from './net.js';

/** 로그인한 사람을 적어 두는 자리 — 이 값 자체는 지우지 않는다(지우면 매 부팅이 '주인이 바뀌었다'가 된다). */
export const OWNER_KEY = 'lv:owner';

/** 사람이 바뀌어도 남기는 것 — 이 창의 겉모습. 값에 남의 세션·프로젝트가 들어갈 수 없는 것만 둔다. */
const KEEP_EXACT: ReadonlySet<string> = new Set([
  TOKEN_KEY,             // 방금 로그인한 사람의 토큰 — 지우면 그 사람이 그 자리에서 튕긴다
  OWNER_KEY,
  'lv:theme', 'lv:theme-harness', 'lv:theme-open-tabs',   // 테마(#1683)
  'lively_chat_fontsize',                                  // 대화 글꼴 크기
  'lively_ui_mode', 'lively_ui_mode_swept',                // 어느 셸로 보나(새/클래식)
  'dash-aside-w', 'pjv:sideW', 'pjv:tmSideW',              // 곁칸·사이드바 폭
]);

/** 폭 손잡이가 쓰는 자리(split.ts) — 전부 폭 숫자다. */
const KEEP_PREFIX: readonly string[] = ['lively_v2_split_'];

/** 이 키를 사람이 바뀌어도 남기나 — 순수 판정(테스트가 이 함수를 직접 잠근다). */
export function keepAcrossOwner(key: string): boolean {
  if (KEEP_EXACT.has(key)) return true;
  return KEEP_PREFIX.some((p) => key.startsWith(p));
}

/**
 * 이 브라우저의 주인을 `userId` 로 주장한다.
 * @returns **지웠나** — true 면 호출부가 곧바로 새로고침해야 한다(위 머리말).
 *
 * 첫 로그인(도장 없음)은 지우지 않는다 — 지금까지 쓰던 사람의 기억이고, 그게 #1875 가 지킨 무회귀다.
 */
export function claimLocalOwner(userId: string): boolean {
  const me = String(userId || '').trim();
  if (!me) return false;
  let prev = '';
  try { prev = localStorage.getItem(OWNER_KEY) || ''; } catch (_) { return false; }   // 프라이빗 모드 — 애초에 남는 게 없다
  if (prev === me) return false;
  const changed = !!prev && prev !== me;
  try {
    if (changed) {
      for (const k of Object.keys(localStorage)) { if (!keepAcrossOwner(k)) localStorage.removeItem(k); }
    }
    localStorage.setItem(OWNER_KEY, me);
  } catch (_) { /* 못 지웠으면 이번엔 종전대로 — 다음 부팅에 다시 시도한다 */ }
  return changed;
}
