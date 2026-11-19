// v2/welcome-film.ts — 영상 재생기(#5550, 원준 2026-11-16 «리니어는 온보딩하면 맨 처음에 온보딩 영상 띄워 주잖아, 그거 비슷한 거»).
//
//  영상은 둘이다(원준 2026-11-19 «앞으로 사용 가이드 같은 거 영상으로 하는 거 좋은 것 같아»).
//   · 온보딩 영상(기초) WELCOME_FILM — 처음 설정의 첫 장면(인사)이 이 영상으로 열린다. 맞이 인사 → 사이드바(워크스페이스 · 고정 앱 둘 ·
//     최근 연 앱 · 앱 · 내 프로필) → 홈(프로젝트 · 선행 · 시키기) → 세션 → 곁칸(프로젝트 태스크 · 자료 · 웹) → 앱 찾기. 1분 50초 남짓.
//   · 사용 가이드(라이블리 동작원리) GUIDE_FILM — 모으기 · 정리하기 · 건네기 · 다시 쌓기를 원리 그림과 실제 화면(수집기 · 증류기 ·
//     실시간 현황 · WIKI · AI 주입기 · 세션 터미널)으로 보여 준다. 3분 40초 남짓.
//  ★ 홍보 장면 없이 **제품 화면 그대로**, 밝은 바탕(원준 2026-11-17). 끝까지 봐야 넘어가는 것이 아니다 — 인사 장면의 [계속하기]는
//  처음부터 눌린다. 둘 다 [사용 가이드] 첫 화면에서 다시 본다(openWelcomeFilm(film)).
//
//  · 영상 파일은 정적 자산이다(public/media/welcome-film.mp4 · welcome-guide.mp4 와 각 포스터 *-poster.jpg).
//  · 소리: 영상마다 sound 로 정한다. 내레이션이 있는 영상은 **음소거로 시작한다** — 브라우저의 자동 재생 정책(소리 없는 영상만
//    스스로 튼다)에 걸리지 않고, 사무실에서 열어도 놀라지 않는다. 사람이 [소리 켜기](영상 오른쪽 위 · 조작줄의 스피커)를 누를 때만
//    들린다(원준 2026-11-17). 내레이션이 없는 영상(sound: false)에는 소리 단추를 세우지 않는다 — 눌러도 아무 소리가 없는 단추는 고장으로 보인다.
//  · 원본은 scripts/welcome-film/ (tour.* · guide.* · gen-tour.mjs · gen-guide.mjs · gen-common.mjs · engine.js) 이고
//    `render.mjs --page tour|guide` 로 굽는다(내레이션은 `narrate.mjs`).
//    제품의 스타일시트 · 아이콘 표 · 서비스 로고 표를 그대로 읽어 그리므로, 화면이 바뀌면 원본의 장면을 고쳐 다시 굽는다.
//  · 조작은 우리가 그린다(브라우저 기본 조작줄은 테마 · 글꼴이 달라 화면에서 뜬다): 누르면 멈춤/재생 · 진행 줄 · 다시 보기 · 전체 화면.
//    «움직임 줄이기» 를 켠 사람에게는 스스로 틀지 않는다(포스터와 재생 단추만 선다).
//  · 못 읽으면(옛 서버 · 끊긴 망) onError 로 알린다 — 인사 장면은 종전의 그림으로 되돌아간다. 영상 때문에 처음 설정이 막히면 안 된다.
//  ⚠ 셸(apps · rail · shell-prefs)을 물지 않는다 — 사용 가이드(클래식 번들)도 이 모듈을 부른다. 무는 것은 잎 모듈(lib/dom)뿐이다.
import { el, reducedMotion, sv } from '../lib/dom.js';

/** 영상 한 편. 주소는 문서 기준 상대경로다(프리뷰 /preview/<id>/ui/ 에서도 같은 자리). */
export interface FilmSpec {
  src: string;
  poster: string;
  /** 제목 — 단추 · 창 · 읽기 도구가 부르는 이름. */
  label: string;
  /** 한 줄 소개(사용 가이드 첫 화면의 단추). */
  blurb: string;
  /** 내레이션이 있나 — 없으면 소리 단추를 세우지 않는다. */
  sound: boolean;
}
export const WELCOME_FILM: FilmSpec = {
  src: 'media/welcome-film.mp4',
  poster: 'media/welcome-film-poster.jpg',
  label: '온보딩 영상(기초)',
  blurb: '사이드바와 홈, 세션, 우측 사이드바를 2분 남짓 영상으로 둘러봅니다. 소리는 없습니다.',
  sound: false,
};
export const GUIDE_FILM: FilmSpec = {
  src: 'media/welcome-guide.mp4',
  poster: 'media/welcome-guide-poster.jpg',
  label: '사용 가이드(라이블리 동작원리)',
  blurb: '자료를 모아 지식으로 정리하고 AI에게 건네는 원리를, 실제 화면에서 어디서 보이는지와 함께 4분 남짓 영상으로 설명합니다. 소리는 없습니다.',
  sound: false,
};
/** 사용 가이드 첫 화면에 늘어놓는 순서. */
export const FILMS: readonly FilmSpec[] = [WELCOME_FILM, GUIDE_FILM];

const ICON = {
  play: 'M8 5.5v13l11-6.5z',
  pause: 'M8 5h3v14H8z M13 5h3v14h-3z',
  replay: 'M4 12a8 8 0 1 0 2.6-5.9 M4 4v4.5h4.5',
  full: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
  soundOn: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4z M15.5 9a4 4 0 0 1 0 6 M18 6.5a7.5 7.5 0 0 1 0 11',
  soundOff: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4z M16 9.5l5 5 M21 9.5l-5 5',
};
const ico = (d: string, cls: string): SVGElement => sv('svg', { class: cls, viewBox: '0 0 24 24', 'aria-hidden': 'true' }, sv('path', { d }));
const clock = (s: number): string => { const n = Math.max(0, Math.floor(s || 0)); return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0'); };

export interface WelcomeFilmOpts {
  /** 틀 영상 — 기본은 온보딩 영상(기초). */
  film?: FilmSpec;
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
  const film = opts.film ?? WELCOME_FILM;
  const video = el('video', { class: 'wf-v', preload: 'auto', poster: film.poster, 'aria-label': film.label, tabindex: '-1' }) as HTMLVideoElement;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  video.disablePictureInPicture = true;
  video.src = film.src;

  const bigIc = ico(ICON.play, 'wf-big-ic');
  const big = el('button', { class: 'wf-big', type: 'button', 'aria-label': film.label + ' 재생' }, bigIc) as HTMLButtonElement;
  const ppIc = ico(ICON.pause, 'wf-ic');
  const pp = el('button', { class: 'wf-btn', type: 'button', 'aria-label': '일시정지' }, ppIc) as HTMLButtonElement;
  const fill = el('i', { class: 'wf-fill' }) as HTMLElement;
  const track = el('div', { class: 'wf-track', role: 'slider', tabindex: '0', 'aria-label': '재생 위치', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, fill) as HTMLElement;
  const time = el('span', { class: 'wf-time', text: '0:00' }) as HTMLElement;
  const fs = el('button', { class: 'wf-btn', type: 'button', 'aria-label': '전체 화면' }, ico(ICON.full, 'wf-ic')) as HTMLButtonElement;
  //  소리 — 조작줄의 스피커(켜고 끄기)와, 음소거인 동안 오른쪽 위에 뜨는 [소리 켜기]. 둘 다 video.muted 하나를 바꾼다.
  //  내레이션이 없는 영상에는 둘 다 세우지 않는다(아래 bar · root 에 붙이지 않는다).
  const sndIc = ico(ICON.soundOff, 'wf-ic');
  const snd = el('button', { class: 'wf-btn wf-snd', type: 'button', 'aria-label': '소리 켜기', 'aria-pressed': 'false' }, sndIc) as HTMLButtonElement;
  const unmute = el('button', { class: 'wf-unmute', type: 'button', 'aria-label': '소리 켜기' }, ico(ICON.soundOn, 'wf-ic'), el('span', { text: '소리 켜기' })) as HTMLButtonElement;
  const bar = el('div', { class: 'wf-bar' }, pp, track, time, ...(film.sound ? [snd] : []), fs) as HTMLElement;
  const root = el('div', { class: 'wf is-idle' + (film.sound ? ' is-muted' : ''), role: 'group', 'aria-label': film.label }, video, big, ...(film.sound ? [unmute] : []), bar) as HTMLElement;

  let raf = 0, dead = false, failed = false;
  const setPath = (svg: SVGElement, d: string): void => { svg.querySelector('path')?.setAttribute('d', d); };
  /** 화면의 얼굴을 영상의 상태에 맞춘다 — 멈춤/끝이면 가운데 단추, 도는 중이면 조작줄만. */
  const sync = (): void => {
    const ended = video.ended, paused = video.paused;
    root.classList.toggle('is-playing', !paused && !ended);
    root.classList.toggle('is-ended', ended);
    root.classList.toggle('is-idle', paused && !ended && video.currentTime < 0.05);
    setPath(bigIc, ended ? ICON.replay : ICON.play);
    big.setAttribute('aria-label', film.label + (ended ? ' 다시 보기' : ' 재생'));
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
  const syncSound = (): void => {
    if (!film.sound) return;
    const m = video.muted;
    root.classList.toggle('is-muted', m);
    setPath(sndIc, m ? ICON.soundOff : ICON.soundOn);
    snd.setAttribute('aria-label', m ? '소리 켜기' : '소리 끄기');
    snd.setAttribute('aria-pressed', String(!m));
  };
  const setMuted = (m: boolean): void => {
    video.muted = m;
    if (m) video.setAttribute('muted', ''); else video.removeAttribute('muted');
    syncSound();
    //  멈춰 있던 영상에서 소리를 켰다 — 들으려는 것이니 튼다(사람이 누른 동작이라 브라우저가 소리째 틀어 준다).
    if (!m && (video.paused || video.ended)) play();
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
  snd.addEventListener('click', () => setMuted(!video.muted));
  unmute.addEventListener('click', () => setMuted(false));
  video.addEventListener('volumechange', syncSound);
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

  sync(); paint(); syncSound();
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

/** 영상을 창으로 띄워 다시 본다([사용 가이드] 첫 화면). Esc · 바깥 누르기 · [닫기]로 닫는다. 창은 한 번에 하나다. */
export function openWelcomeFilm(film: FilmSpec = WELCOME_FILM): void {
  if (document.querySelector('.wf-modal')) return;
  const back = document.activeElement as HTMLElement | null;
  const close = el('button', { class: 'wf-close', type: 'button', 'aria-label': '닫기' },
    sv('svg', { class: 'wf-ic', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, sv('path', { d: 'M6 6l12 12 M18 6 6 18' }))) as HTMLButtonElement;
  const note = el('p', { class: 'wf-note', hidden: true, text: '영상을 불러오지 못했어요. 잠시 뒤에 다시 열어 주세요.' }) as HTMLElement;
  const player = mountWelcomeFilm({ film, autoplay: true, onError: () => { player.root.hidden = true; note.hidden = false; } });
  const box = el('div', { class: 'wf-modal-box' }, player.root, note, close) as HTMLElement;
  const modal = el('div', { class: 'wf-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': film.label }, box) as HTMLElement;
  const shut = (): void => {
    player.destroy();
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
