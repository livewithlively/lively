// v2/views.ts — 새 셸의 중앙 화면 셋(#1719): 홈(미선택) · 프로젝트 · 세션. 데이터는 main.ts 가 모아 넘긴다(V2Data).
//  홈은 **입력창 하나**(claude.ai 홈처럼 — Enter 로 프로젝트 없는 세션이 열린다, v2/quick-session.ts)이고,
//  프로젝트는 개요+세션, 세션은 그 세션 자체(대화창 — 라이브 또는 중앙 기록)를 실는다. 리브 대화는 #/liv 에 있다.
//  클래식 모듈을 **복제하지 않는다** — 대화·세션 목록·프로젝트 상세는 이미 있는 것을 가져다 붙인다.
import { api, el, errorNote, relTime, state, toast } from '../core.js';
import { isCreatingQuickSession, openQuickSession, takeFirstPrompt } from './quick-session.js';
import { createRunPicker } from './run-picker.js';
import { mountSessionChat, type SessionChatHandle } from '../session-chat.js';
import type { TrailWidget } from '../session-trail.js';
import { sessIsDead, sessLabel, sessStateKey } from '../session-status.js';
import { terminalUrl } from './apps.js';

export interface Proj {
  id: number; name: string; status?: string | null; status_category?: string | null; description?: string | null; list_id?: number | null; updated_at?: string | null;
  // 사이드바 '내 프로젝트만'(side.ts) — 만든 사람 + 팀원 id. 서버 mine=1 과 같은 술어(생성자이거나 팀원)를 프론트에서 그대로 판정한다.
  created_by?: string | null; member_ids?: string[];
}
export interface Sess {
  id: string; label: string; projectId: number | null; node: string | null;
  live: boolean; alive: boolean; owned: boolean; stateKey: string; stateLabel: string; lastSeen: number; raw: any;
  // 중앙 기록 좌표(대화 uuid) — 라이브 행에 접힌 기록(mergeSessions). 기록만 있는 행은 id 자체가 uuid 라 비어 있다.
  logId?: string | null; logNode?: string | null;
}
export interface V2Data { projects: Proj[]; sessions: Sess[]; loadedAt: number; }

const dot = (k: string) => el('span', { class: 'v2-dot ' + dotCls(k), 'aria-hidden': 'true' });
// 상태 key(web/session-status.ts) → 점 색 클래스. 눈에 띄어야 할 셋만 색이다 — 작업 중(파랑·깜빡)·확인 필요(앰버)·작업 완료(민트 링).
//  나머지 살아 있는 것(대기·오프라인·셸)은 회색 계열로 조용히, 끝난 것(중단됨·종료됨·기록)은 빈 점.
export function dotCls(stateKey: string): string {
  if (stateKey === 'busy') return 'busy';
  if (stateKey === 'waiting') return 'wait';
  if (stateKey === 'done') return 'done';
  if (stateKey === 'idle') return 'idle';
  if (stateKey === 'offline') return 'off';
  if (stateKey === 'shell') return 'shell';
  return '';
}
const when = (ms: number) => (ms ? relTime(new Date(ms).toISOString()) : '');

// ── 홈 = 런처 (#1719 재설계) — 입력창이 주인공이고, 입력이 **어디로 가는지**(행선지)가 창 안에 보인다 ──────────
//  · 타이핑하는 동안 프로젝트 이름·번호가 글에 닿으면 행선지가 그 프로젝트로 자동으로 바뀐다(왜 골랐는지도 말한다).
//    직접 고르면(칩 ▾) 자동 매칭은 물러난다. 행선지 없음 = 세션 전용 폴더, 프로젝트는 나중에.
//  · Enter → 세션 생성(+행선지 프로젝트 붙이기) → 세션 대화 화면. 리브 대화는 홈에 두지 않는다(#/liv 가 그 자리).
//  · '지금 도는 세션'은 **답 기다리는 것 먼저**, 세션 이름과 프로젝트가 같으면 한 번만 쓴다(같은 말 두 줄 금지).

interface Dest { p: Proj | null; why: string; manual: boolean }

/** 글에서 행선지 프로젝트 찾기 — 이름 토큰(한글 2자·영숫자 3자 이상)이나 #번호가 닿은 것 중 점수 최고.
 *  점수 = 닿은 토큰 길이 합(전체 이름이 통째로 들어 있으면 +10, 최근 7일 작업 +2, 내 프로젝트 +1). 4점 미만은 못 믿는다(추측 금지). */
export function matchProject(text: string, projects: Proj[], sessions: Sess[]): { p: Proj; why: string } | null {
  const t = String(text || '').toLowerCase();
  if (t.trim().length < 2) return null;
  const idm = /#(\d{2,})/.exec(t);
  const lastWork = new Map<number, number>();
  for (const s of sessions) if (s.projectId) lastWork.set(s.projectId, Math.max(lastWork.get(s.projectId) || 0, s.lastSeen || 0));
  let best: { p: Proj; score: number; hit: string } | null = null;
  for (const p of projects) {
    if (idm && String(p.id) === idm[1]) return { p, why: `#${p.id} 이 글에 있어요` };
    const name = String(p.name || '');
    let score = 0; let hit = '';
    if (name.length >= 4 && t.includes(name.toLowerCase())) { score += 10 + name.length; hit = name; }
    else {
      for (const tok of name.split(/[^0-9A-Za-z가-힣]+/)) {
        const ok = /[가-힣]/.test(tok) ? tok.length >= 2 : tok.length >= 3;
        if (ok && t.includes(tok.toLowerCase())) { score += tok.length; if (tok.length > hit.length) hit = tok; }
      }
    }
    if (!score) continue;
    const lw = lastWork.get(Number(p.id)) || 0;
    if (lw && Date.now() - lw < 7 * 86400e3) score += 2;
    if (best === null || score > best.score) best = { p, score, hit };
  }
  if (!best || best.score < 4) return null;
  return { p: best.p, why: `이름의 「${best.hit}」가 닿았어요` };
}

export function renderHome(host: HTMLElement, data: V2Data): void {
  const me = state.me || {};
  const name = String(me.display_name || me.email || me.userId || '');
  const live = data.sessions.filter((s) => s.live && s.alive);
  const busy = live.filter((s) => s.stateKey === 'busy').length;
  const waiting = live.filter((s) => s.stateKey === 'waiting').length;
  const h = new Date().getHours(); const tod = h < 12 ? '좋은 아침이에요' : h < 18 ? '좋은 오후예요' : '좋은 저녁이에요';
  const d = new Date(); const KO_DAY = ['일', '월', '화', '수', '목', '금', '토'];

  const dest: Dest = { p: null, why: '', manual: false };
  const ta = el('textarea', { class: 'v2-launch-in', rows: '2', placeholder: '무엇이든 시키세요 — 프로젝트 이름이 글에 있으면 알아서 그리로 열려요', 'aria-label': '무엇이든 시키기' }) as HTMLTextAreaElement;
  const send = el('button', { class: 'btn btn-primary v2-launch-send', type: 'button' }, el('span', { text: '시키기' }), el('kbd', { text: '⏎' })) as HTMLButtonElement;
  const destBtn = el('button', { class: 'v2-dest-chip', type: 'button', 'aria-haspopup': 'listbox' }) as HTMLButtonElement;
  const destWhy = el('span', { class: 'v2-dest-why' });
  const destRow = el('div', { class: 'v2-dest' }, destBtn, destWhy);   // '여는 곳' 라벨은 뺐다 — 칩의 폴더 아이콘·이름이 그 말을 한다
  const pop = el('div', { class: 'v2-dest-pop', hidden: true });
  // [시키기] 왼쪽 세 칸 — 제공자(어느 회사 모델)·모델·추론강도(#1758). 행선지 칩과 한 줄에 서서 '어디로 · 무엇에게'가
  //  나란히 읽힌다. 기본은 내가 지난번에 고른 값이고, 여기서 바꾸면 그게 다음 기본이 된다(v2/run-picker.ts —
  //  '새 AI 세션' 폼과 같은 기억을 쓴다).
  const runPicker = createRunPicker();
  const card = el('div', { class: 'v2-launch' }, ta,
    el('div', { class: 'v2-launch-row' }, el('div', { class: 'v2-launch-ctl' }, destRow, runPicker.el), send), pop);

  const paintDest = (): void => {
    destBtn.replaceChildren(
      dest.p ? el('span', { class: 'v2-dest-dot on', 'aria-hidden': 'true' }) : el('span', { class: 'v2-dest-dot', 'aria-hidden': 'true' }),
      el('b', { text: dest.p ? dest.p.name : '프로젝트 없이' }),
      el('span', { class: 'car', text: '▾', 'aria-hidden': 'true' }));
    destBtn.title = dest.p ? `새 세션이 「${dest.p.name}」 프로젝트에 붙습니다 — 눌러서 바꿀 수 있어요` : '세션 전용 폴더로 열립니다 — 눌러서 프로젝트를 고를 수 있어요';
    // 부연은 **자동 매칭이 일어났을 때만** — 기본 상태의 '나중에 언제든…'은 매번 읽히는 소음이었다(툴팁으로).
    destWhy.textContent = dest.p && !dest.manual ? dest.why : '';
  };
  const autoMatch = (): void => {
    if (dest.manual) return;
    const m = matchProject(ta.value, data.projects, data.sessions);
    const next = m ? m.p : null;
    if ((next && next.id) !== (dest.p && dest.p.id)) { dest.p = next; dest.why = m ? m.why : ''; paintDest(); }
    else if (m && dest.why !== m.why) { dest.why = m.why; paintDest(); }
  };

  // 행선지 고르기 — 최근 일한 프로젝트가 위, 찾기 한 칸. '자동으로 되돌리기'가 수동 잠금을 푼다.
  const openPop = (): void => {
    const byWork = new Map<number, number>();
    for (const s of data.sessions) if (s.projectId) byWork.set(s.projectId, Math.max(byWork.get(s.projectId) || 0, s.lastSeen || 0));
    const sorted = [...data.projects].sort((a, b) => (byWork.get(Number(b.id)) || 0) - (byWork.get(Number(a.id)) || 0) || String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    const q = el('input', { class: 'v2-dest-q', type: 'search', placeholder: '프로젝트 찾기', 'aria-label': '프로젝트 찾기' }) as HTMLInputElement;
    const list = el('div', { class: 'v2-dest-list', role: 'listbox' });
    const row = (label: string, sub: string, on: boolean, pick: () => void): HTMLElement =>
      el('button', { class: 'v2-dest-opt' + (on ? ' on' : ''), type: 'button', role: 'option', onclick: pick },
        el('span', { class: 'n', text: label }), sub ? el('span', { class: 's', text: sub }) : null, on ? el('span', { class: 'ck', text: '✓' }) : null);
    const paintList = (): void => {
      const f = q.value.trim().toLowerCase();
      const shown = sorted.filter((p) => !f || p.name.toLowerCase().includes(f) || String(p.id) === f).slice(0, 12);
      list.replaceChildren(
        row('프로젝트 없이', '세션 전용 폴더 · 나중에 붙이기', !dest.p, () => { dest.p = null; dest.manual = true; close(); }),
        ...shown.map((p) => row(p.name, byWork.get(Number(p.id)) ? '최근 작업 ' + when(byWork.get(Number(p.id)) || 0) : '', !!dest.p && dest.p.id === p.id,
          () => { dest.p = p; dest.manual = true; close(); })),
        dest.manual ? el('button', { class: 'v2-dest-opt auto', type: 'button', onclick: () => { dest.manual = false; close(); autoMatch(); } },
          el('span', { class: 'n', text: '자동으로 되돌리기 — 글에서 찾아요' })) : null);
    };
    const close = (): void => { pop.hidden = true; paintDest(); ta.focus(); };
    q.addEventListener('input', paintList);
    pop.replaceChildren(q, list); paintList();
    pop.hidden = false; q.focus();
    const off = (e: MouseEvent): void => { if (!(e.target as HTMLElement | null)?.closest?.('.v2-dest-pop, .v2-dest-chip')) { pop.hidden = true; document.removeEventListener('click', off); } };
    window.setTimeout(() => document.addEventListener('click', off), 0);
  };
  destBtn.onclick = (e) => { e.stopPropagation(); if (pop.hidden) openPop(); else pop.hidden = true; };

  const grow = (): void => { ta.style.height = 'auto'; ta.style.height = Math.min(220, ta.scrollHeight) + 'px'; };
  const submit = async (): Promise<void> => {
    const text = ta.value.trim();
    if (!text || isCreatingQuickSession()) return;
    send.disabled = true; ta.disabled = true; runPicker.disable(true);
    send.replaceChildren(el('span', { text: dest.p ? `「${dest.p.name.slice(0, 14)}${dest.p.name.length > 14 ? '…' : ''}」에 여는 중…` : '여는 중…' }));
    const ok = await openQuickSession(text, { projectId: dest.p ? Number(dest.p.id) : null, projectName: dest.p?.name, run: runPicker.value() });
    if (!ok) { send.disabled = false; ta.disabled = false; runPicker.disable(false); send.replaceChildren(el('span', { text: '시키기' }), el('kbd', { text: '⏎' })); ta.focus(); }
  };
  send.onclick = () => { void submit(); };
  ta.addEventListener('input', () => { grow(); autoMatch(); });
  ta.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void submit(); }
  });

  // 이어서 하기 칩 — 최근 일한 프로젝트 상위 2개. 누르면 행선지만 그리로 잠그고 입력에 포커스(글은 사람이 쓴다).
  const byWork = new Map<number, number>();
  for (const s of data.sessions) if (s.projectId) byWork.set(s.projectId, Math.max(byWork.get(s.projectId) || 0, s.lastSeen || 0));
  const recent = [...data.projects].filter((p) => byWork.get(Number(p.id))).sort((a, b) => (byWork.get(Number(b.id)) || 0) - (byWork.get(Number(a.id)) || 0)).slice(0, 2);
  const sugs = recent.length ? el('div', { class: 'v2-launch-sugs' }, el('span', { class: 'v2-k', text: '이어서' }),
    ...recent.map((p) => el('button', { class: 'chip', type: 'button', text: p.name, title: `행선지를 「${p.name}」로 두고 입력으로 갑니다`,
      onclick: () => { dest.p = p; dest.manual = true; paintDest(); ta.focus(); } }))) : null;

  host.replaceChildren(
    el('section', { class: 'v2-home v2-home-launch' },
      el('div', { class: 'v2-home-eyebrow' },
        el('span', { text: `${d.getMonth() + 1}월 ${d.getDate()}일 ${KO_DAY[d.getDay()]}요일` }),
        // 세션이 하나도 안 돌면 그 말 자체를 안 한다 — '도는 세션 없음'은 정보가 아니라 빈자리 채우기다.
        busy ? [el('span', { class: 'sep', text: '·' }), el('span', { class: 'st busy' }, dot('busy'), `작업 중 ${busy}`)] : null,
        waiting ? [el('span', { class: 'sep', text: '·' }), el('span', { class: 'st wait' }, dot('waiting'), `답 기다림 ${waiting}`)] : null),
      el('h1', { class: 'v2-h1', text: `${tod}${name ? ', ' + name + '님' : ''}.` }),
      el('p', { class: 'v2-home-sub', text: '무엇을 할까요?' }),
      card,
      sugs,
      nowList(data)));
  paintDest();
  window.setTimeout(() => { grow(); ta.focus(); }, 30);
}

function nowList(data: V2Data): HTMLElement {
  // 홈의 두 번째 존재 — 상태별 두 결(#1756): **답을 기다리는 것**은 내가 움직여야 풀리는 일이라 앰버 카드로
  //  도드라지고, 나머지는 조용한 목록이다. 종전엔 일곱 행이 같은 무게로 나열돼 급한 것이 안 보였다.
  const rank = (s: Sess): number => (s.stateKey === 'waiting' ? 0 : s.stateKey === 'busy' ? 1 : 2);
  const live = data.sessions.filter((s) => s.live && s.alive).sort((a, b) => rank(a) - rank(b) || b.lastSeen - a.lastSeen);
  if (!live.length) return el('div', {});
  const waits = live.filter((s) => s.stateKey === 'waiting');
  const rest = live.filter((s) => s.stateKey !== 'waiting').slice(0, 7 - Math.min(waits.length, 4));
  const rowOf = (s: Sess): HTMLElement => {
    const pn = projName(data, s.projectId);
    const raw = (s.raw || {}) as any;
    const title = s.label === pn && raw.title && String(raw.title) !== s.label ? String(raw.title) : s.label;
    const showProj = !!s.projectId && title !== pn;
    return el('a', { class: 'v2-now-row' + (s.stateKey === 'waiting' ? ' wait' : ''), href: '#/s/' + encodeURIComponent(s.id) },
      dot(s.stateKey),
      el('span', { class: 'tw' }, el('span', { class: 't', text: title }), showProj ? el('span', { class: 'p', text: pn }) : null),
      el('span', { class: 'st', text: s.stateKey === 'waiting' ? when(s.lastSeen) : `${s.stateLabel} · ${when(s.lastSeen)}` }),
      s.stateKey === 'waiting' ? el('span', { class: 'go btn btn-sm', text: '답하기' }) : null);
  };
  return el('div', { class: 'v2-now' },
    waits.length ? el('section', { class: 'v2-now-wait' },
      el('div', { class: 'v2-now-h' }, el('span', { class: 'v2-k wait', text: `답을 기다려요 · ${waits.length}` })),
      ...waits.slice(0, 4).map(rowOf)) : null,
    rest.length ? el('section', {},
      el('div', { class: 'v2-now-h' }, el('span', { class: 'v2-k', text: `돌고 있어요 · ${rest.length}` }),
        el('a', { class: 'btn-text', href: '#/app/terminal', text: '전체 →' })),
      ...rest.map(rowOf)) : null);
}

export function projName(data: V2Data, id: number | null): string {
  if (!id) return '프로젝트 없음';
  const p = data.projects.find((x) => Number(x.id) === Number(id));
  return p ? p.name : `프로젝트 #${id}`;
}

// ── 프로젝트 — 개요 + 세션 + 여는 길 ────────────────────────────────────────
export async function renderProject(host: HTMLElement, data: V2Data, id: number, detailIn?: any): Promise<void> {
  const p = data.projects.find((x) => Number(x.id) === id);
  let detail: any = detailIn ?? null;
  if (!detail) {
    host.replaceChildren(el('div', { class: 'v2-center' }, el('p', { class: 'v2-muted', text: '불러오는 중…' })));
    try { detail = await api('/api/ui/v6/projects/' + id); } catch (e) { host.replaceChildren(el('div', { class: 'v2-center' }, errorNote(e, '프로젝트를 불러오지 못했습니다'))); return; }
  }
  const pj = (detail && detail.project) || p || { id, name: `프로젝트 #${id}` };
  const tasks: any[] = Array.isArray(detail?.project?.tasks) ? detail.project.tasks : (Array.isArray(detail?.tasks) ? detail.tasks : []);
  const done = tasks.filter((t) => t.status_category === 'done' || t.status === 'done').length;
  const sess = data.sessions.filter((s) => Number(s.projectId) === id).sort((a, b) => Number(b.live) - Number(a.live) || b.lastSeen - a.lastSeen);
  const st = pj.status_category === 'done' ? '끝남' : pj.status_category === 'unstarted' ? '시작 전' : '진행 중';
  host.replaceChildren(el('div', { class: 'v2-center' },
    el('div', { class: 'v2-eyebrow' }, el('span', { class: 'mono', text: '#' + pj.id }), el('span', { text: '·' }), el('span', { class: 'state ' + (pj.status_category === 'done' ? 'done' : 'busy'), text: st }),
      pj.list && pj.list.name ? [el('span', { text: '·' }), el('span', { text: pj.list.name })] : null),
    el('h1', { class: 'v2-title', text: pj.name }),
    pj.description ? el('p', { class: 'v2-desc', text: String(pj.description).slice(0, 600) }) : null,
    el('div', { class: 'v2-actrow' },
      el('a', { class: 'btn btn-primary btn-sm', href: '#/app/terminal', text: '새 AI 세션' }),
      el('a', { class: 'btn btn-ghost btn-sm', href: '#/projects2/p/' + pj.id, text: '프로젝트 앱에서 열기(보드·태스크)' }),
      el('span', { class: 'v2-muted', text: tasks.length ? `태스크 ${tasks.length} · 끝남 ${done}` : '태스크 없음' })),
    el('section', { class: 'v2-sec' },
      el('div', { class: 'v2-sec-h' }, el('span', { class: 'v2-k', text: `세션 · ${sess.length}` })),
      sess.length ? el('div', { class: 'v2-list' }, ...sess.map((s) => el('a', { class: 'v2-row', href: '#/s/' + encodeURIComponent(s.id) },
        dot(s.stateKey), el('div', { class: 'v2-row-main' }, el('div', { class: 't', text: s.label }), el('div', { class: 'm', text: `${s.stateLabel}${s.live ? '' : ' · 기록만'} · ${when(s.lastSeen)}` })),
        el('span', { class: 'v2-row-r', text: '›' }))))
        : el('p', { class: 'v2-empty', text: '이 프로젝트에 붙은 세션이 아직 없어요. [새 AI 세션] 으로 시작하면 여기에 쌓입니다.' })),
    tasks.length ? el('section', { class: 'v2-sec' },
      el('div', { class: 'v2-sec-h' }, el('span', { class: 'v2-k', text: `태스크 · ${tasks.length}` })),
      el('div', { class: 'v2-list' }, ...tasks.slice(0, 8).map((t) => el('a', { class: 'v2-row', href: '#/projects2/t/' + t.id },
        el('span', { class: 'v2-dot ' + (t.status_category === 'done' ? 'done' : t.status_category === 'started' ? 'busy' : '') }),
        el('div', { class: 'v2-row-main' }, el('div', { class: 't', text: t.name }), el('div', { class: 'm', text: t.status || t.status_category || '' })),
        el('span', { class: 'v2-row-r', text: '›' }))),
        tasks.length > 8 ? el('a', { class: 'v2-more', href: '#/projects2/p/' + pj.id, text: `외 ${tasks.length - 8}개 — 프로젝트 앱에서` }) : null)) : null,
  ));
}

// ── 세션 — 그 세션 자체를 가운데에: **대화창**(web/session-chat.ts, 리브와 같은 컴포넌트)으로. 터미널은 헤더에서 토글 ─────────
//  라이브면 박스의 대화 파일을 창으로 읽어 라이브로 따라가고 입력칸으로 보낸다(프롬프트 주입). 끝난 세션이면 기록 + [이어서 대화하기].
let sessChat: SessionChatHandle | null = null;
//  trail = 우패널 '발자취' 위젯(main.ts 가 aside 에 만들어 넘긴다) — 대화 파일에서 읽는 도구 사용이 거기로 흘러든다.
//  onPickProject = 상단바 [프로젝트 연결] 드롭다운(#1749) — main.ts 가 목록·실행·갱신을 쥔다.
export function renderSession(host: HTMLElement, data: V2Data, id: string, trail?: TrailWidget | null, onPickProject?: (anchor: HTMLElement) => void): void {
  // 기록(uuid) 링크로 들어왔는데 그 대화를 도는 박스가 있으면 그 박스가 정본이다(mergeSessions 가 기록을 박스에 접었다) — 옛 링크가 산다.
  const s = data.sessions.find((x) => x.id === id) || data.sessions.find((x) => x.logId === id);
  if (sessChat) { sessChat.destroy(); sessChat = null; }
  if (!s) { host.replaceChildren(el('div', { class: 'v2-center' }, el('p', { class: 'v2-muted', text: '세션을 찾을 수 없어요. 목록을 새로고침해 주세요.' }))); return; }
  const termSrc = s.live ? terminalUrl(s.id, s.label, s.node) : null;
  sessChat = mountSessionChat(host, { ...s, projectName: projName(data, s.projectId) }, {
    terminalSrc: termSrc,
    openHref: s.live ? termSrc : (location.pathname + '?ui=classic#/sessions/' + encodeURIComponent(s.id) + (s.node ? '?node=' + encodeURIComponent(s.node) : '')),
    // 홈 입력창이 방금 연 세션이면 그 첫 지시를 낙관적으로 먼저 그린다(서버가 하네스 입력창이 뜬 뒤 실제로 넣는다).
    firstPrompt: takeFirstPrompt(s.id),
    trail: trail || null,
    onPickProject,   // 상단바 [프로젝트 연결] 드롭다운(#1749) — main.ts 가 목록·실행·갱신을 쥔다
  });
}
/** 목록이 새로 왔을 때(20초 폴링) 열려 있는 세션 화면의 상태 표시를 갱신한다. 본문은 화면 자신이 대화 파일을 폴링한다. */
export function refreshSession(data: V2Data, id: string): void {
  if (!sessChat) return;
  const s = data.sessions.find((x) => x.id === id) || data.sessions.find((x) => x.logId === id);
  if (s) sessChat.update({ ...s, projectName: projName(data, s.projectId) });
}
export function unmountSession(): void { if (sessChat) { sessChat.destroy(); sessChat = null; } }

// ── 데이터 정규화 — 라이브(terminal/sessions) + 기록(v6/sessions) 를 한 목록으로 ─────────
//  같은 세션이 두 목록에 있으면 한 장으로: 라이브 행의 claudeSessionId(박스가 도는 대화 uuid) == 기록 행의 session_id 면
//  기록 행을 라이브 행에 접는다(logId·logNode). 종전엔 '박스 1장 + 그 대화의 기록 1장'이 나란히 떠 같은 세션이 둘로 보였다.
export function mergeSessions(liveRows: any[], logRows: any[]): Sess[] {
  const now = Date.now();
  const out = new Map<string, Sess>();
  const byUuid = new Map<string, Sess>();
  for (const r of liveRows || []) {
    const k = sessStateKey(r, now);
    const s: Sess = {
      id: String(r.id), label: String(r.label || r.title || r.id), projectId: r.projectId ? Number(r.projectId) : null,
      // 노드 세션의 node 는 {id,name,online} 객체다 — id 만 든다(터미널 URL·중앙 기록 좌표에 문자열로 쓴다).
      node: r.node && typeof r.node === 'object' ? (String(r.node.id || '') || null) : (r.node ? String(r.node) : null),
      live: true, alive: !sessIsDead(r, now), owned: !!r.owned, stateKey: k, stateLabel: sessLabel(r, now),
      lastSeen: Number(r.lastActive || r.created || 0) * (String(r.lastActive || r.created || 0).length > 11 ? 1 : 1000) || 0, raw: r,
    };
    out.set(s.id, s);
    if (r.claudeSessionId && !byUuid.has(String(r.claudeSessionId))) byUuid.set(String(r.claudeSessionId), s);
  }
  for (const r of logRows || []) {
    const id = String(r.session_id);
    if (out.has(id)) continue;
    const owner = byUuid.get(id);
    if (owner) {                                   // 라이브(또는 복원 가능) 박스가 이 대화를 돌린다 — 그 카드에 접는다
      owner.logId = id; owner.logNode = r.node_id || '';
      if (!owner.projectId && r.project_id != null) owner.projectId = Number(r.project_id);
      continue;
    }
    out.set(id, {
      id, label: String(r.title || id), projectId: r.project_id != null ? Number(r.project_id) : null, node: r.node_id || null,
      live: false, alive: false, owned: true, stateKey: 'log', stateLabel: '기록', lastSeen: r.last_seen ? new Date(r.last_seen).getTime() : 0, raw: r,
    });
  }
  return [...out.values()];
}

export function toastOnce(msg: string): void { toast(msg); }
