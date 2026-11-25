// 창 숨기기 — macOS 전체화면이면 **먼저 풀고** 숨긴다 (#5791).
//
//  원준 2026-11-25: «앱에서 cmd+w로 앱 닫으면 그냥 까만 창이 되고 제대로 앱이 안닫히는데»
//  앱 창 · 마법사 창은 닫아도 죽지 않고 숨는다(트레이 상주 — main.mjs 의 close 핸들러가 preventDefault 뒤 hide).
//  그런데 전체화면 창은 제 Space 를 가진다. 전체화면을 풀지 않고 hide() 만 하면 창은 사라져도 그 Space 가 남아
//  화면 하나가 통째로 까맣게 남는다 — ⌘W(Electron 기본 메뉴 Window ▸ Close)가 «닫았는데 까만 창» 이 되던 이유다.
//  그래서 전체화면이면 setFullScreen(false) → leave-full-screen 을 받은 뒤 숨긴다. 그 알림이 안 오면(전환 중 · 이미 풀림)
//  시한 뒤에 그냥 숨긴다 — 숨기기를 영영 미루지 않는다.
//
//  Electron 없이 시험한다(desktop-core.test.mjs WH1~WH6) — 창은 isDestroyed · isFullScreen · setFullScreen · hide ·
//  once · removeListener 만 쓴다.

/** leave-full-screen 을 기다리는 시한 — macOS 전체화면 해제 애니메이션(≈0.7초)보다 넉넉히. */
export const LEAVE_FULLSCREEN_TIMEOUT_MS = 1500;

/**
 * 창을 숨긴다. 전체화면이면 먼저 풀고 숨긴다.
 * @returns "gone"(이미 없는 창) | "hidden"(바로 숨김) | "leaving-fullscreen"(풀리는 대로 숨긴다)
 */
export function hideWindow(w, opts = {}) {
  if (!w || w.isDestroyed()) return "gone";                                          // WH5
  if (!w.isFullScreen()) { w.hide(); return "hidden"; }                              // WH1
  const setT = opts.setTimeout ?? setTimeout;
  const clearT = opts.clearTimeout ?? clearTimeout;
  let done = false;
  let timer = null;
  const finish = () => {                                                              // WH2 · WH3 · WH4 한 번만
    if (done) return;
    done = true;
    if (timer != null) clearT(timer);
    w.removeListener("leave-full-screen", finish);
    if (!w.isDestroyed()) w.hide();                                                   // WH5 전환 중에 창이 없어졌다
  };
  w.once("leave-full-screen", finish);
  timer = setT(finish, opts.timeoutMs ?? LEAVE_FULLSCREEN_TIMEOUT_MS);
  w.setFullScreen(false);
  return "leaving-fullscreen";
}
