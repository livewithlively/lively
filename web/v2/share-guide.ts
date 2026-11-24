// v2/share-guide.ts — «누가 무엇을 보나요» 안내 카드(#5598, 상민 2026-11-19~20).
//
//  ── 왜 ──────────────────────────────────────────────────────────────────────
//   고위드 서비스전략실이 «내 AI 사용이 부지불식간에 공유 · 기록된다» 는 불안을 말했다. 첫 지시가 담긴 프로젝트가
//   팀에 보이던 실제 노출은 초대제(#5598 본체)로 막았고, 이 카드는 «무엇이 누구에게 보이나» 를 처음 한 번 그림으로 알린다.
//   2026-11-22 «권한 팝업» 에서 «안내 팝업» 으로 바꿨다 — 권한을 앞세우니 오히려 불안을 키운다는 피드백. 이제 1~4장은
//   AI 세션(대화창) · 프로젝트 · 자료 · 지식이 무엇이고 어떻게 이어지는지를 설명하고, 마지막 장만 «누가 무엇을 볼 수 있나요» 다.
//
//  ── 어디서 뜨나 ─────────────────────────────────────────────────────────────
//   · 처음 설정의 인사 장면(v2/onboarding.ts) — 처음 오는 사람은 여기서 카드 5장을 넘긴다(상민 2026-11-24: 종전엔 이 자리에 온보딩
//     영상이 있었다. 개념 설명은 화면을 보기 전에, 화면 둘러보기 영상은 화면이 뒤에 보일 때가 자연스럽다). 넘기면 확인 표식과
//     «영상 띄울 차례»(welcome_film_due_at)가 남고, 셸에 돌아오면 온보딩 영상(기초)이 창으로 한 번 뜬다(welcomeFilmAutoDue).
//   · 웹 · 앱 첫 진입 — 처음 설정을 지나지 않는 사람(기존 구성원)에게 사람마다 한 번(서버 표식 liv_profile.share_guide_seen_at).
//     처음 설정(#/welcome) · 앱 전체 화면(#/full) · 승인(#/activate) 같은 지나가는 자리에서는 띄우지 않고, 셸로 돌아온 뒤에 띄운다.
//   · 설치 승인 직후(web/activate.ts) — 브라우저 승인 페이지 아래에 그대로 붙인다(CLI · 앱으로 설치하는 사람도 한 번은 보게).
//   · 다시 보기 — 주소 `#/share-guide`(CLI 설치 끝 상자의 링크가 여기로 온다).
//   [확인했어요] 를 누르면 표식을 남긴다. 체크박스 동의는 두지 않는다(체크박스는 읽기를 늘리지 않는다 — 대화 기록의 근거 참조).
//
//  ── 문구의 근거(코드에서 확인한 것만) ─────────────────────────────────────────
//   · 세션은 소유자와 초대받은 사람만(src/terminal/write-cap.ts sessionVisible — 관리자 예외 없음).
//   · 프로젝트 공개 방식은 워크스페이스 설정(/api/ui/v6/project-access) — 초대제면 비공개, 전체 공개면 «결과를 남기면 팀 전원»,
//     프로젝트 공개범위 축이 꺼져 있으면(enforced=false) 처음부터 팀 전원이 본다. 어느 쪽이든 세션 안은 세션 초대가 따로 필요하다.
//   · 읽기전용 · 인코그니토는 홈 «무엇이든 시키세요» 아래 [⚙] → «새 세션 기본값» → 라이블리 모드(v2/run-picker.ts · session-defaults.ts),
//     터미널은 `lively run --readonly | --incognito`(kit/cli/lively.mjs cmdRun — «claude 실행 [readonly]» 를 찍는다).
//   · /lively-disconnect 는 기본이 «이 세션에서만 끄기»(lively off) · 다시 켜기 /lively-connect.
//   · 관리자도 남의 세션 대화는 못 읽는다(chat-routes.ts gateRead — #5598 에서 막음).
//   · 자료: 올린 파일 · AI가 만든 파일은 팀 전원이 찾아본다(초대제 프로젝트 폴더의 파일도 — 자료 열람은 프로젝트 공개범위를 보지 않는다).
//     앱에서 모은 자료는 수집 단위 · 관리자 규칙(org_source_vis_policy)이 정한 범위만큼 — 규칙이 없으면 열려 있다(«원래 보던 사람만» 이 아니다).
//   · 지식은 기본 공개 · 닫힌 자료에서 나온 지식은 그 자료를 볼 수 있는 사람만.
import { api } from '../core.js';
import { SG_MARKUP, SG_SPRITE } from './share-guide-markup.js';
import { I, SG_STEPS, projModeOf, type ProjMode } from '../lib/share-guide-rules.js';
export { SHARE_GUIDE_ROUTE, shareGuideAutoAllowed, welcomeFilmAutoDue } from '../lib/share-guide-rules.js';
import { shareGuideAutoAllowed, welcomeFilmAutoDue, type FilmFacts } from '../lib/share-guide-rules.js';
import { WELCOME_FILM, openWelcomeFilm } from './welcome-film.js';   // 온보딩 영상(기초) — 처음 설정을 지나 셸에 온 사람에게 한 번

interface Opts {
  /** 마지막 단추 글 — 승인 페이지는 «확인했어요 · 터미널로». */
  finishLabel?: string;
  /** [확인했어요] 를 눌렀을 때. */
  onFinish?: () => void;
  /** 다시 보기 창이면 닫기(✕ · Esc · 바깥)가 있다. 첫 안내는 끝까지 넘기게 한다(점으로 건너뛸 수는 있다). */
  closable?: boolean;
  onClose?: () => void;
}
export interface ShareGuide { el: HTMLElement; destroy(): void }

const POP = {
  ro: { pick: 1, name: '읽기전용', flag: 'readonly', txt: '<strong>읽기전용</strong> — AI가 회사 자료는 읽지만, 라이블리에 <strong>지식을 저장하지 않아요.</strong>', cap: '이 세션은 회사 자료를 읽되, 지식은 남기지 않아요' },
  ic: { pick: 2, name: '인코그니토', flag: 'incognito', txt: '<strong>인코그니토</strong> — 라이블리를 아예 쓰지 않아요. 회사 자료도 읽지 않고, <strong>아무것도 남지 않아요.</strong>', cap: '라이블리 없이 열려요 · 아무것도 남지 않아요' },
} as const;
const GEAR = '<svg class="sg-ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';

let spriteMounted = false;
function ensureSprite(): void {
  if (spriteMounted && document.getElementById('sg-i-chat')) return;
  const holder = document.createElement('div');
  holder.innerHTML = SG_SPRITE;
  const svg = holder.firstElementChild;
  if (svg) document.body.appendChild(svg);
  spriteMounted = true;
}

/** 카드를 host 안에 세운다(모달 · 승인 페이지 공용). */
export function mountShareGuide(host: HTMLElement, opts: Opts = {}): ShareGuide {
  ensureSprite();
  const root = document.createElement('div');
  root.className = 'sg-root';
  root.innerHTML = SG_MARKUP;
  host.appendChild(root);
  const q = <T extends HTMLElement = HTMLElement>(k: string): T => root.querySelector(`[data-sg="${k}"]`) as T;
  const card = q('card');
  const titleId = 'sg-title-' + Math.random().toString(36).slice(2, 8);
  q('title').id = titleId;
  card.setAttribute('aria-labelledby', titleId);
  if (!opts.closable) { card.removeAttribute('role'); card.removeAttribute('aria-modal'); }
  let mode: ProjMode = 'invite';
  let step = 0; let popMode: keyof typeof POP = 'ro'; let popWhere: 'app' | 'term' = 'app';

  const play = (node: HTMLElement): void => { node.classList.remove('sg-play'); void node.offsetWidth; node.classList.add('sg-play'); };
  const showScene = (id: string): void => {
    root.querySelectorAll<HTMLElement>('.sg-scene').forEach((s) => { s.hidden = s.dataset.sg !== id; s.classList.remove('sg-play'); });
    play(q(id));
  };
  const recap = (): void => {
    const inv = mode === 'invite';
    q('r-proj').innerHTML = `<span class="sg-bd sg-what">${I('folder')}프로젝트</span>` + (inv
      ? `<span class="sg-bd sg-priv">${I('lock')}비공개</span><p>나와 <strong>초대한 사람</strong>만 봐요<br><span class="sg-sub">초대받아도 남의 세션 안은 못 봐요</span></p>`
      : `<span class="sg-bd sg-pub">${I('globe')}전체 공개</span><p>${mode === 'open' ? '결과를 남기면 <strong>팀 전원</strong>이 봐요' : '<strong>팀 전원</strong>이 봐요'}<br><span class="sg-sub">그래도 남의 세션 안은 못 봐요</span></p>`);
  };

  const pop = q('pop');
  const renderPop = (): void => {
    const P = POP[popMode];
    const mini = q('mini');
    if (popWhere === 'term') {
      mini.innerHTML = `
        <div class="sg-mterm"><div class="sg-mterm-h"><i></i><i></i><i></i><span style="margin-left:1cqw">터미널</span></div>
          <div class="sg-mterm-b">
            <div><span class="sg-pr">~/work $ </span><span class="sg-cmd sg-i-type" style="--d:.5s">lively run <em>--${P.flag}</em></span></div>
            <div class="sg-dim sg-i-fade" style="--d:1.9s">claude 실행 [${P.flag}]</div>
            <div class="sg-cc sg-i-fade" style="--d:2.5s">✻ Welcome to Claude Code</div>
            <div class="sg-i-fade" style="--d:3.1s">&gt; 법인카드 한도 정리해 줘</div>
          </div></div>
        <div class="sg-mcap${popMode === 'ic' ? ' sg-ic-mode' : ''}" style="--d:3.7s">${P.cap}</div>`;
    } else {
      const opts3 = [['일반', '라이블리를 읽고 씀'], ['읽기전용', '읽되 기록하지 않음'], ['인코그니토', '라이블리를 전혀 안 씀']]
        .map(([t, d], i) => `<span class="${i === 0 ? 'sg-was' : i === P.pick ? 'sg-sel sg-on' : ''}">${t}<small>${d}</small></span>`).join('');
      mini.innerHTML = `
        <div class="sg-cmp"><div class="sg-cmp-in">무엇이든 시키세요<br><span>@이름 을 적으면 그 사람을 이 세션에 초대해요</span></div>
          <div class="sg-cmp-row"><span class="sg-cmp-ctl">중앙 컴퓨터 · Claude · Opus</span><span class="sg-sp"></span><span class="sg-cmp-gear">${GEAR}</span><span class="sg-cmp-plus">＋</span><span class="sg-cmp-send">시키기</span></div></div>
        <div class="sg-cmp-tip">새 세션 기본값 — ${P.name}</div>
        <div class="sg-mdl"><div class="sg-mdl-h">새 세션 기본값<span>✕</span></div>
          <div class="sg-mdl-l">라이블리 모드 <i>?</i></div><div class="sg-mdl-seg">${opts3}</div>
          <div class="sg-mdl-l sg-mdl-dim">실행 승인</div>
          <div class="sg-mdl-seg sg-mdl-dim"><span>확인 후 실행</span><span class="sg-sel">오토모드</span><span>자동 승인</span></div>
          <div class="sg-mdl-f"><span class="sg-mdl-save">저장</span></div></div>
        <svg class="sg-cursor2" style="--gx:66cqw;--gy:35.4cqw;--ox:${P.pick === 1 ? '50cqw' : '76cqw'};--oy:25cqw;--sx:81cqw;--sy:47cqw"><use href="#sg-i-cursor"/></svg>`;
    }
    q('pop-txt').innerHTML = P.txt;
    root.querySelectorAll<HTMLElement>('.sg-mini-switch button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.where === popWhere)));
    root.querySelectorAll<HTMLElement>('.sg-ptabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === popMode)));
    play(mini);
  };
  const closePop = (): void => {
    root.querySelector('.sg-content')?.prepend(pop);
    pop.hidden = true;
    q('more')?.setAttribute('aria-expanded', 'false');
  };
  const openPop = (): void => {
    q('more-wrap').appendChild(pop);
    pop.hidden = false;
    q('more').setAttribute('aria-expanded', 'true');
    renderPop();
  };

  const render = (): void => {
    const S = SG_STEPS[step];
    recap();
    closePop();
    q('title').textContent = S.title(mode);
    const lead = S.lead(mode);
    q('lead').innerHTML = lead; q('lead').hidden = !lead;
    q('extra').innerHTML = S.extra ? S.extra() : '';
    // extra 를 innerHTML 로 새로 세웠으니 단추도 새것이다 — 매번 붙여도 겹치지 않는다.
    q('more')?.addEventListener('click', () => (pop.hidden ? openPop() : closePop()));
    showScene(S.scene);
    q('prev').style.visibility = step === 0 ? 'hidden' : 'visible';
    const last = step === SG_STEPS.length - 1;
    q('next').textContent = last ? (opts.finishLabel || '확인했어요') : '다음';
    q('dots').innerHTML = SG_STEPS.map((_, i) => `<button type="button" role="tab" aria-label="${i + 1}단계" aria-selected="${i === step}" ${i === step ? 'aria-current="step"' : ''} data-i="${i}"></button>`).join('');
  };
  const go = (i: number): void => { if (i < 0 || i >= SG_STEPS.length) return; step = i; render(); q('title').focus({ preventScroll: true }); };

  q('prev').addEventListener('click', () => go(step - 1));
  q('next').addEventListener('click', () => { if (step < SG_STEPS.length - 1) go(step + 1); else opts.onFinish?.(); });
  q('dots').addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-i]'); if (b) go(Number(b.dataset.i)); });
  q('replay').addEventListener('click', () => showScene(SG_STEPS[step].scene));
  root.querySelector('.sg-ptabs')?.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-mode]'); if (b) { popMode = b.dataset.mode as keyof typeof POP; renderPop(); } });
  root.querySelector('.sg-mini-switch')?.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-where]'); if (b) { popWhere = b.dataset.where as 'app' | 'term'; renderPop(); } });
  q('pop-x').addEventListener('click', closePop);
  const onDocClick = (e: MouseEvent): void => { if (!pop.hidden && !(e.target as HTMLElement).closest('[data-sg="pop"], [data-sg="more"]')) closePop(); };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { if (!pop.hidden) { closePop(); return; } if (opts.closable) opts.onClose?.(); return; }
    if ((e.target as HTMLElement).closest('input, textarea, .sg-ptabs, .sg-mini-switch')) return;
    if (e.key === 'ArrowRight') go(step + 1);
    if (e.key === 'ArrowLeft') go(step - 1);
  };
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKey);
  if (opts.closable) {
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'sg-close'; x.setAttribute('aria-label', '닫기'); x.textContent = '×';
    x.addEventListener('click', () => opts.onClose?.());
    q('stage').appendChild(x);
  }

  render();
  // 프로젝트 공개 방식은 워크스페이스마다 다르다 — 받는 대로 마지막 장을 다시 그린다(못 받으면 초대제 그대로).
  void api('/api/ui/v6/project-access').then((a: any) => { mode = projModeOf(a); render(); }).catch(() => { /* 옛 서버 — 초대제로 둔다 */ });

  return {
    el: root,
    destroy(): void {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
      root.remove();
    },
  };
}

/** 확인 표식 — 실패해도 삼킨다(표식을 못 남겼다고 화면이 막히면 안 된다). */
export function markShareGuideSeen(): void {
  void api('/api/ui/me/liv-profile', { method: 'POST', body: JSON.stringify({ share_guide_seen: true }) }).catch(() => { /* 비치명 */ });
}

let openNow: ShareGuide | null = null;
/** 모달로 연다 — 첫 안내(closable:false)와 다시 보기(closable:true). */
export function openShareGuide(o: { again?: boolean; onClose?: () => void } = {}): void {
  if (openNow) return;
  const back = document.createElement('div');
  back.className = 'sg-back';
  document.body.appendChild(back);
  const close = (): void => { openNow?.destroy(); openNow = null; back.remove(); o.onClose?.(); };
  openNow = mountShareGuide(back, {
    closable: !!o.again,
    onClose: close,
    onFinish: () => { markShareGuideSeen(); close(); },
  });
  if (o.again) back.addEventListener('click', (e) => { if (e.target === back) close(); });
  (openNow.el.querySelector('[data-sg="next"]') as HTMLElement | null)?.focus({ preventScroll: true });
}

let checked = false;
/** 셸이 선 뒤 한 번 — 이 사람이 아직 안내를 확인하지 않았으면 띄운다. 지나가는 자리면 셸로 돌아올 때까지 미룬다. */
export async function maybeShowShareGuide(): Promise<void> {
  if (checked) return;
  if (!shareGuideAutoAllowed(location.hash)) {
    const retry = (): void => { if (shareGuideAutoAllowed(location.hash)) { window.removeEventListener('hashchange', retry); void maybeShowShareGuide(); } };
    window.addEventListener('hashchange', retry);
    return;
  }
  checked = true;
  let p: FilmFacts | null = null;
  try { p = (await api('/api/ui/me/liv-profile')) as FilmFacts | null; }
  catch (_) { return; }   // 못 읽었으면 띄우지 않는다(다음 접속에 다시 본다) — 확인한 사람에게 또 뜨는 쪽이 더 나쁘다
  if (!p?.share_guide_seen_at) { openShareGuide(); return; }
  //  안내 카드는 이미 확인했다 — 처음 설정의 인사 장면에서 넘긴 사람이면 온보딩 영상(기초)을 창으로 한 번 띄운다(welcomeFilmAutoDue).
  if (welcomeFilmAutoDue(p, location.hash)) { markWelcomeFilmSeen(); openWelcomeFilm(WELCOME_FILM, FIRST_FILM_HEAD); }
}

/** 처음 뜨는 영상 창의 머리말 — 무엇인지와, 닫아도 다시 볼 곳이 있다는 것. */
export const FIRST_FILM_HEAD = { title: '라이블리 화면은 이렇게 생겼어요', note: '1분 40초 · 소리 없음 · 닫아도 [사용 가이드]에서 다시 볼 수 있어요' };
/** 처음 설정 인사 장면의 안내 카드를 끝까지 넘겼다 → 셸에서 영상을 띄울 차례(서버 표식). 실패해도 삼킨다 — 영상은 [사용 가이드] 에 있다. */
export function markWelcomeFilmDue(): void {
  void api('/api/ui/me/liv-profile', { method: 'POST', body: JSON.stringify({ welcome_film_due: true }) }).catch(() => { /* 비치명 */ });
}
/** 영상 창을 띄웠다(서버 표식) — 자동으로 뜨는 것은 한 번이다. */
export function markWelcomeFilmSeen(): void {
  void api('/api/ui/me/liv-profile', { method: 'POST', body: JSON.stringify({ welcome_film_seen: true }) }).catch(() => { /* 비치명 */ });
}
