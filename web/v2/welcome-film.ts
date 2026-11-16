// v2/welcome-film.ts — 소개 영상(#5550, 원준 2026-11-16 «리니어는 온보딩하면 맨 처음에 온보딩 영상 띄워 주잖아, 그거 비슷한 거»).
//
//  처음 설정의 첫 장면(인사)이 이 영상으로 열린다 — 무엇을 묻기 전에 «라이블리가 무엇을 하는지» 를 1분 남짓에 보여 준다
//  (AI는 똑똑하지만 내 일을 모른다 → 수집 → 증류 → 전달 → 레일 두 칸과 앱 찾기). 끝까지 봐야 넘어가는 것이 아니다 —
//  장면의 [계속하기]는 처음부터 눌린다. 나중에는 [사용 가이드] 첫 화면의 «소개 영상» 으로 다시 본다(openWelcomeFilm).
//
//  · 영상 파일은 정적 자산이다(public/media/welcome-film.mp4 · 포스터 welcome-film-poster.jpg). 소리가 없다 — 그래서
//    브라우저의 자동 재생 정책(소리 없는 영상만 스스로 튼다)에 걸리지 않고, 사무실에서 열어도 놀라지 않는다.
//  · 원본은 scripts/welcome-film/ (film.html · film.js · engine.js) 이고 `node scripts/welcome-film/render.mjs` 로 다시 굽는다.
//    제품의 아이콘 표 · 서비스 로고 표를 그대로 읽어 그리므로, 화면이 바뀌면 원본의 장면을 고쳐 다시 굽는다.
//  · 조작은 우리가 그린다(브라우저 기본 조작줄은 테마 · 글꼴이 달라 화면에서 뜬다): 누르면 멈춤/재생 · 진행 줄 · 다시 보기 · 전체 화면.
//    «움직임 줄이기» 를 켠 사람에게는 스스로 틀지 않는다(포스터와 재생 단추만 선다).
//  · 못 읽으면(옛 서버 · 끊긴 망) onError 로 알린다 — 인사 장면은 종전의 그림으로 되돌아간다. 영상 때문에 처음 설정이 막히면 안 된다.
//  ⚠ 셸(apps · rail · shell-prefs)을 물지 않는다 — 사용 가이드(클래식 번들)도 이 모듈을 부른다. 무는 것은 잎 모듈(lib/dom)뿐이다.
import { el, reducedMotion, sv } from '../lib/dom.js';

/** 영상 자산 — 주소는 문서 기준 상대경로다(프리뷰 /preview/<id>/ui/ 에서도 같은 자리). */
export const WELCOME_FILM = {
  src: 'media/welcome-film.mp4',
  poster: 'media/welcome-film-poster.jpg',
  label: '라이블리 소개 영상',
} as const;

const ICON = {
  play: 'M8 5.5v13l11-6.5z',
  pause: 'M8 5h3v14H8z M13 5h3v14h-3z',
  replay: 'M4 12a8 8 0 1 0 2.6-5.9 M4 4v4.5h4.5',
  full: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
};
const ico = (d: string, cls: string): SVGElement => sv('svg', { class: cls, viewBox: '0 0 24 24', 'aria-hidden': 'true' }, sv('path', { d }));
const clock = (s: number): string => { const n = Math.max(0, Math.floor(s || 0)); return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0'); };

export interface WelcomeFilmOpts {
  /** 스스로 틀까 — 기본은 «움직임 줄이기» 가 꺼져 있으면 튼다. */
  autoplay?: boolean;
  /** 영상을 못 읽었다(파일 없음 · 망) — 부르는 쪽이 다른 그림으로 바꾼다. */
  onError?: () => void;
  /** 끝까지 봤다. */
  onEnded?: () => void;
}
export interface WelcomeFilm { root: HTMLElement; destroy(): void }

/** 재생기 하나를 만든다. 붙이는 것은 부르는 쪽이 한다(root). 떼어 낼 때는 destroy() — 재생을 멈추고 듣던 것을 걷는다. */
export function mountWelcomeFilm(opts: WelcomeFilmOpts = {}): WelcomeFilm {
  const video = el('video', { class: 'wf-v', preload: 'auto', poster: WELCOME_FILM.poster, 'aria-label': WELCOME_FILM.label, tabindex: '-1' }) as HTMLVideoElement;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  video.disablePictureInPicture = true;
  video.src = WELCOME_FILM.src;

  const bigIc = ico(ICON.play, 'wf-big-ic');
  const big = el('button', { class: 'wf-big', type: 'button', 'aria-label': '소개 영상 재생' }, bigIc) as HTMLButtonElement;
  const ppIc = ico(ICON.pause, 'wf-ic');
  const pp = el('button', { class: 'wf-btn', type: 'button', 'aria-label': '일시정지' }, ppIc) as HTMLButtonElement;
  const fill = el('i', { class: 'wf-fill' }) as HTMLElement;
  const track = el('div', { class: 'wf-track', role: 'slider', tabindex: '0', 'aria-label': '재생 위치', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, fill) as HTMLElement;
  const time = el('span', { class: 'wf-time', text: '0:00' }) as HTMLElement;
  const fs = el('button', { class: 'wf-btn', type: 'button', 'aria-label': '전체 화면' }, ico(ICON.full, 'wf-ic')) as HTMLButtonElement;
  const bar = el('div', { class: 'wf-bar' }, pp, track, time, fs) as HTMLElement;
  const root = el('div', { class: 'wf is-idle', role: 'group', 'aria-label': WELCOME_FILM.label }, video, big, bar) as HTMLElement;

  let raf = 0, dead = false, failed = false;
  const setPath = (svg: SVGElement, d: string): void => { svg.querySelector('path')?.setAttribute('d', d); };
  /** 화면의 얼굴을 영상의 상태에 맞춘다 — 멈춤/끝이면 가운데 단추, 도는 중이면 조작줄만. */
  const sync = (): void => {
    const ended = video.ended, paused = video.paused;
    root.classList.toggle('is-playing', !paused && !ended);
    root.classList.toggle('is-ended', ended);
    root.classList.toggle('is-idle', paused && !ended && video.currentTime < 0.05);
    setPath(bigIc, ended ? ICON.replay : ICON.play);
    big.setAttribute('aria-label', ended ? '소개 영상 다시 보기' : '소개 영상 재생');
    setPath(ppIc, paused || ended ? ICON.play : ICON.pause);
    pp.setAttribute('aria-label', paused || ended ? '재생' : '일시정지');
  };
  const paint = (): void => {
    const d = video.duration || 0, t = video.currentTime || 0;
    const p = d > 0 ? Math.min(1, t / d) : 0;
    fill.style.transform = `scaleX(${p.toFixed(4)})`;
    track.setAttribute('aria-valuenow', String(Math.round(p * 100)));
    time.textContent = d > 0 ? clock(t) + ' / ' + clock(d) : clock(t);
  };
  const tick = (): void => { raf = 0; if (dead) return; paint(); if (!video.paused && !video.ended) raf = requestAnimationFrame(tick); };
  const run = (): void => { if (!raf) raf = requestAnimationFrame(tick); };
  const play = (): void => {
    if (failed) return;
    if (video.ended) video.currentTime = 0;
    //  play() 는 거절될 수 있다(자동 재생을 막은 브라우저 · 절전) — 그러면 가운데 단추가 남아 사람이 누른다.
    const p = video.play();
    if (p && typeof p.catch === 'function') p.catch(() => { sync(); });
  };
  const toggle = (): void => { if (video.paused || video.ended) play(); else video.pause(); };
  const seekTo = (ratio: number): void => {
    const d = video.duration || 0; if (!d) return;
    video.currentTime = Math.max(0, Math.min(d - 0.05, ratio * d));
    paint(); sync();
  };
  const seekAt = (clientX: number): void => { const r = track.getBoundingClientRect(); if (r.width > 0) seekTo((clientX - r.left) / r.width); };

  video.addEventListener('play', () => { sync(); run(); });
  video.addEventListener('pause', () => { sync(); paint(); });
  video.addEventListener('ended', () => { sync(); paint(); opts.onEnded?.(); });
  video.addEventListener('loadedmetadata', paint);
  video.addEventListener('error', () => { if (failed || dead) return; failed = true; root.classList.add('is-failed'); opts.onError?.(); });
  video.addEventListener('click', toggle);
  big.addEventListener('click', play);
  pp.addEventListener('click', toggle);
  //  진행 줄 — 누른 자리로 가고, 누른 채 끌면 따라간다.
  track.addEventListener('pointerdown', (e: PointerEvent) => {
    e.preventDefault();
    try { track.setPointerCapture(e.pointerId); } catch (_) { /* 옛 브라우저 */ }
    seekAt(e.clientX);
    const move = (m: PointerEvent): void => seekAt(m.clientX);
    const up = (): void => { track.removeEventListener('pointermove', move); track.removeEventListener('pointerup', up); track.removeEventListener('pointercancel', up); };
    track.addEventListener('pointermove', move); track.addEventListener('pointerup', up); track.addEventListener('pointercancel', up);
  });
  const onKey = (e: KeyboardEvent): void => {
    const d = video.duration || 0;
    if (e.key === 'ArrowRight' && d) { e.preventDefault(); seekTo((video.currentTime + 5) / d); }
    else if (e.key === 'ArrowLeft' && d) { e.preventDefault(); seekTo((video.currentTime - 5) / d); }
    else if ((e.key === ' ' || e.key === 'k') && e.target === track) { e.preventDefault(); toggle(); }
  };
  root.addEventListener('keydown', onKey);
  fs.addEventListener('click', () => {
    const doc = document as Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
    const node = root as HTMLElement & { webkitRequestFullscreen?: () => void };
    if (doc.fullscreenElement || doc.webkitFullscreenElement) { (doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc); return; }
    const req = node.requestFullscreen || node.webkitRequestFullscreen;
    //  아이폰 사파리는 영상 요소만 전체 화면이 된다.
    if (req) { try { void (req.call(node) as unknown as Promise<void> | undefined)?.catch?.(() => { /* 거절 — 그대로 둔다 */ }); } catch (_) { /* noop */ } }
    else (video as HTMLVideoElement & { webkitEnterFullscreen?: () => void }).webkitEnterFullscreen?.();
  });

  sync(); paint();
  const auto = opts.autoplay ?? !reducedMotion();
  if (auto) play();

  return {
    root,
    destroy(): void {
      dead = true;
      if (raf) cancelAnimationFrame(raf);
      try { video.pause(); video.removeAttribute('src'); video.load(); } catch (_) { /* 이미 떼어진 요소 */ }
    },
  };
}

/** 영상을 창으로 띄워 다시 본다([사용 가이드] 첫 화면). Esc · 바깥 누르기 · [닫기]로 닫는다. */
export function openWelcomeFilm(): void {
  if (document.querySelector('.wf-modal')) return;
  const back = document.activeElement as HTMLElement | null;
  const close = el('button', { class: 'wf-close', type: 'button', 'aria-label': '닫기' },
    sv('svg', { class: 'wf-ic', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, sv('path', { d: 'M6 6l12 12 M18 6 6 18' }))) as HTMLButtonElement;
  const note = el('p', { class: 'wf-note', hidden: true, text: '영상을 불러오지 못했어요. 잠시 뒤에 다시 열어 주세요.' }) as HTMLElement;
  const film = mountWelcomeFilm({ autoplay: true, onError: () => { film.root.hidden = true; note.hidden = false; } });
  const box = el('div', { class: 'wf-modal-box' }, film.root, note, close) as HTMLElement;
  const modal = el('div', { class: 'wf-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': WELCOME_FILM.label }, box) as HTMLElement;
  const shut = (): void => {
    film.destroy();
    modal.remove();
    document.removeEventListener('keydown', onKey, true);
    try { back?.focus(); } catch (_) { /* 사라진 요소 */ }
  };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !document.fullscreenElement) { e.stopPropagation(); shut(); } };
  modal.addEventListener('click', (e) => { if (e.target === modal) shut(); });
  close.addEventListener('click', shut);
  document.addEventListener('keydown', onKey, true);
  document.body.append(modal);
  close.focus();
}
