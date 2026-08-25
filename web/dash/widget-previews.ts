// dash/widget-previews.ts — 미리보기 위젯 + 오른쪽 곁칸.
//  왜 있나: 미리보기(preview_env)는 지금 **앱 밖**에서만 볼 수 있다 — 주소를 복사해 새 탭에서 열고, 앱으로 돌아오려면
//  탭을 다시 찾아야 한다. 화면을 고치는 동안엔 이 왕복이 계속 일어난다. 그래서 목록을 대시보드에 두고,
//  누르면 **같은 화면 오른쪽 곁칸**에 띄운다 — 앱을 떠나지 않고 본다.
//
//  ⚠ 곁칸은 이 위젯만의 것이 아니다. 다른 화면에서도 부를 수 있도록 openAside/closeAside 를 내보낸다.
//   본문을 밀어내는 방식(오버레이 아님)이라 뒤 화면을 계속 조작할 수 있다 — 미리보기를 보면서 앱을 쓰는 게 목적이라
//   덮으면 의미가 없다.
import { api, el, errorNote, relTime } from '../core.js';
import { dashEmpty } from './chrome.js';

const ASIDE_W_KEY = 'dash-aside-w';          // 곁칸 폭(기기별)
const ASIDE_MIN = 360, ASIDE_MAX_RATIO = 0.72;

let asideEl: HTMLElement | null = null;
let asideFrame: HTMLIFrameElement | null = null;
let asideTitle: HTMLElement | null = null;
let asideOpenBtn: HTMLAnchorElement | null = null;

function asideWidth(): number {
  const saved = Number(localStorage.getItem(ASIDE_W_KEY) || 0);
  const max = Math.round(window.innerWidth * ASIDE_MAX_RATIO);
  if (!saved) return Math.min(Math.max(ASIDE_MIN, Math.round(window.innerWidth * 0.42)), max);
  return Math.min(Math.max(ASIDE_MIN, saved), max);
}
function applyAsideWidth(px: number) {
  document.documentElement.style.setProperty('--dash-aside-w', px + 'px');
}

/** 곁칸을 한 번만 만든다. 다시 열 때는 주소와 제목만 갈아 끼운다. */
function ensureAside(): HTMLElement {
  if (asideEl) return asideEl;
  asideTitle = el('b', { class: 'dash-aside-t', text: '미리보기' });
  asideOpenBtn = el('a', { class: 'dash-aside-btn', target: '_blank', rel: 'noopener', title: '새 탭에서 열기', text: '새 탭' }) as HTMLAnchorElement;
  const reload = el('button', { class: 'dash-aside-btn', type: 'button', title: '다시 불러오기', text: '새로고침' });
  const close = el('button', { class: 'dash-aside-btn dash-aside-x', type: 'button', title: '닫기 (Esc)', 'aria-label': '곁칸 닫기', text: '✕' });
  const grip = el('div', { class: 'dash-aside-grip', title: '드래그해서 폭 조절' });
  asideFrame = el('iframe', { class: 'dash-aside-frame', title: '미리보기 화면' }) as HTMLIFrameElement;
  // 지역 변수로 만들고 마지막에 모듈 변수에 넣는다 — 모듈 변수(null 허용)를 바로 쓰면 이 아래가 전부 null 검사에 걸린다.
  const box: HTMLElement = el('aside', { class: 'dash-aside', 'aria-label': '미리보기 곁칸' },
    grip,
    el('header', { class: 'dash-aside-h' }, asideTitle, el('span', { class: 'dash-aside-sp' }), asideOpenBtn, reload, close),
    asideFrame);

  close.addEventListener('click', () => closeAside());
  reload.addEventListener('click', () => { if (asideFrame) asideFrame.src = asideFrame.src; });
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    // Esc 는 곁칸이 열려 있고, 입력 중이 아닐 때만 — 모달 위에서 Esc 를 뺏지 않는다.
    if (e.key !== 'Escape' || !document.body.classList.contains('has-dash-aside')) return;
    const t = e.target as HTMLElement | null;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (document.querySelector('dialog[open], .modal.open')) return;
    closeAside();
  });

  // 폭 조절 — 왼쪽 모서리를 끌면 곁칸이 넓어진다(오른쪽 고정).
  let dragging = false;
  grip.addEventListener('pointerdown', (e: PointerEvent) => {
    dragging = true; grip.setPointerCapture(e.pointerId); e.preventDefault();
    document.body.classList.add('dash-aside-dragging');
  });
  grip.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging) return;
    const w = Math.min(Math.max(ASIDE_MIN, window.innerWidth - e.clientX), Math.round(window.innerWidth * ASIDE_MAX_RATIO));
    applyAsideWidth(w);
  });
  const stop = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false; try { grip.releasePointerCapture(e.pointerId); } catch { /* 이미 놓임 */ }
    document.body.classList.remove('dash-aside-dragging');
    const cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dash-aside-w')) || asideWidth();
    localStorage.setItem(ASIDE_W_KEY, String(cur));
  };
  grip.addEventListener('pointerup', stop);
  grip.addEventListener('pointercancel', stop);
  window.addEventListener('resize', () => { if (document.body.classList.contains('has-dash-aside')) applyAsideWidth(asideWidth()); });

  document.body.appendChild(box);
  asideEl = box;
  return box;
}

/** 오른쪽 곁칸에 주소를 띄운다. 이미 열려 있으면 내용만 바꾼다. */
function openAside(url: string, title?: string) {
  ensureAside();
  applyAsideWidth(asideWidth());
  if (asideTitle) asideTitle.textContent = title || '미리보기';
  if (asideOpenBtn) asideOpenBtn.href = url;
  if (asideFrame && asideFrame.src !== url) asideFrame.src = url;
  document.body.classList.add('has-dash-aside');
}
function closeAside() {
  document.body.classList.remove('has-dash-aside');
  // 주소를 비워 둔다 — 안 비우면 닫아도 그 화면이 계속 돌아 소리·폴링이 살아 있는다.
  if (asideFrame) asideFrame.src = 'about:blank';
}

// 상태 → 사람 말. 서버가 주는 값 그대로 보여주면 '무슨 뜻인지' 를 사람이 해석해야 한다.
const PREV_STATE: Record<string, { t: string; k: string }> = {
  running: { t: '켜져 있어요', k: 'on' },
  preparing: { t: '준비 중', k: 'busy' },
  stopped: { t: '꺼져 있어요', k: 'off' },
  error: { t: '문제가 생겼어요', k: 'bad' },
};

/** 미리보기 목록 위젯. */
async function fillPreviews(zone: any) {
  const body = zone.body;
  try {
    const res = await api('/api/ui/preview-envs');
    const list: any[] = (Array.isArray(res) ? res : (res && (res.envs || res.items || res.previews))) || [];
    // 켜져 있는 것 먼저, 그다음 최근에 쓴 순 — 지금 볼 수 있는 것이 위로 온다.
    const rank = (s: string) => (s === 'running' ? 0 : s === 'preparing' ? 1 : 2);
    list.sort((a, b) => rank(a.status) - rank(b.status)
      || String(b.last_active_at || b.updated_at || '').localeCompare(String(a.last_active_at || a.updated_at || '')));

    body.textContent = '';
    if (zone.countEl) zone.countEl.textContent = list.length ? String(list.length) : '';
    if (!list.length) { body.append(dashEmpty('띄워 둔 미리보기가 없어요.')); return; }

    for (const p of list) {
      const st = PREV_STATE[String(p.status)] || { t: String(p.status || ''), k: 'off' };
      const name = p.label || p.project_name || p.id;
      const row = el('button', { class: 'dash-prev', type: 'button', title: '오른쪽 곁칸에서 열기' },
        el('span', { class: 'dash-prev-st dash-prev-st--' + st.k, title: st.t }),
        el('span', { class: 'dash-prev-b' },
          el('span', { class: 'dash-prev-t', text: name }),
          el('span', { class: 'dash-prev-m', text: [p.id, p.branch, p.last_active_at ? relTime(p.last_active_at) : ''].filter(Boolean).join(' · ') })),
        el('span', { class: 'dash-prev-go', text: '곁칸에서 보기' }));
      row.addEventListener('click', () => {
        if (!p.url) return;
        openAside(p.url, name);
        // 지금 보고 있는 것을 목록에서도 표시 — 곁칸과 목록이 어긋나 보이지 않게.
        for (const r of Array.from(body.querySelectorAll('.dash-prev'))) (r as HTMLElement).classList.remove('is-open');
        row.classList.add('is-open');
      });
      body.append(row);
    }
  } catch (e) {
    body.textContent = '';
    body.append(errorNote(e, '미리보기 목록을 불러오지 못했어요.'));
  }
}

export { fillPreviews, openAside, closeAside };
