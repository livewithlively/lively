// projects/detail-hub.ts — 프로젝트 상세 = **도구 위젯 허브** (#3916, 2026-09-14 원준 결정: "원안(안 5 허브)이 제일 낫다 ·
//  카드 크기·배치를 설정에서 · 크기에 맞춰 뷰가 완전히 다르게, 휴대폰 위젯처럼").
//
//  화면 = 속성 띠(detail-meta.ts pjvProjFactsStrip, detail.ts 가 세운다) 아래 **3열 격자**에 도구 위젯 여섯(태스크·세션·본문·
//  공유 폴더·연결된 지식·작업 타임라인). 크기(가로 w × 세로 h, #4164)가 곧 뷰다.
//  #4135 5판(2026-09-25 원준): 태스크·세션 위젯은 **모든 크기를 위젯 자신이 그린다**(detail-hub-tasks · detail-hub-sessions —
//   프로젝트 탭 줄 그대로, 크기는 «어느 묶음을 몇 줄 어떤 열로» 만 바꾼다). 나머지 넷은 아직 종전 규칙(1×1 «한눈» · 목록 · «전체»·«띠»
//   는 기존 섹션 카드)이다 — 다음 PR 에서 같은 방식으로 옮긴다.
//  배치(순서·크기·숨김)는 detail-hub-layout.ts 가 저장한다(내 계정 전역 한 벌 · «이 프로젝트에서만» 토글). 편집 모드는 iOS 홈
//  편집 문법 — 손잡이(⋮⋮)를 끌어 순서, 오른쪽 아래 모서리를 끌거나 [w×h] 격자에서 골라 크기, × 로 숨김, 「＋ 위젯」 슬롯으로 되살림.
//
//  ⚠ 의존 방향: 이 모듈은 섹션 렌더러(detail-tasks·detail-terminal·detail-folder·detail-body·detail-sections)를 **직접 물지 않는다** —
//   그것들은 배럴(projects.ts)을 되짚어 새 순환을 만든다(scripts/check-imports.mjs). detail.ts 가 **공장(sections · tasksList · newSession …)** 으로 넣어 준다.
//   여기서 import 하는 것은 리프뿐(core · files-icons · files-format · popover · status · detail-hub-layout · detail-hub-kit · 위젯 채움 모듈).
//  ⚠ 열기(→ 도구 전폭)는 페이지에선 주소(#/projects2/p/:id/<도구>)로, 모달(.pjv-pm) 안에선 제자리 전환으로 — 모달은 자기 주소를
//   소유하므로(#808) 해시를 바꾸면 라우터가 모달을 닫는다.
import { api, el, personFace, relTime, toast } from '../core.js';
import { fileThumb } from './files-icons.js';
import { fmtSize } from './files-format.js';
import { pjvPopover } from './popover.js';
import { pjvFmtDate } from './status.js';
import {
  HUB_COLS, HUB_MAX_H, HUB_PRESETS, HUB_TOOL_LABEL, HUB_TOOLS, HUB_VIEW_LABEL, applyHubPreset, hideHubItem, hubListCap, hubView,
  loadHubLayout, matchHubPreset, moveHubItem, resetHubLayout, resizeHubItem, saveHubLayout, setHubScope, showHubItem,
  type HubLayout, type HubTool, type HubView,
} from './detail-hub-layout.js';
import {
  TOOL_TONE, type Fill, type HubCtx, type HubData, type HubOpts, big, btn, emptyNote, footText, hubIcon, lastHeading, moreNote, row, stat, stripMd,
} from './detail-hub-kit.js';
import { fillTasks } from './detail-hub-tasks.js';
import { fillSessions } from './detail-hub-sessions.js';

export type { HubOpts, HubSectionFactory, HubTasksListOpts } from './detail-hub-kit.js';

// ══ 허브 ══════════════════════════════════════════════════════════════════════
export function mountProjectHub(host: HTMLElement, o: HubOpts): void {
  const pid = o.id;
  const P = o.p || {};
  const tasks: any[] = P.tasks || [];
  const kn = P.knowledge || { required: [], produced: [] };

  // 데이터 — 위젯마다 따로 부르지 않고 허브가 한 번 받아 나눠 준다(같은 화면에서 같은 것을 두 번 묻지 않는다). invalidate 로 한 키만 다시.
  const lazyOf = <T,>(fn: () => Promise<T>): { get: () => Promise<T>; drop: () => void } => { let p: Promise<T> | null = null; return { get: () => (p ||= fn()), drop: () => { p = null; } }; };
  const L = {
    sessions: lazyOf(() => api(o.base + pid + '/sessions').then((d: any) => (d && d.sessions) || []).catch(() => [] as any[])),
    files: lazyOf(() => api(o.base + pid + '/files?path=').then((d: any) => (d && d.items) || []).catch(() => [] as any[])),
    acts: lazyOf(() => api(o.base + pid + '/activity').then((d: any) => (d && d.activities) || []).catch(() => [] as any[])),
    comments: lazyOf(() => api('/api/ui/v6/projects/' + pid + '/comments').then((d: any) => ((d && d.feed) || []).filter((f: any) => f && f.kind === 'comment')).catch(() => [] as any[])),
    recs: lazyOf(() => api('/api/ui/v6/projects/' + pid + '/recommend-knowledge?limit=2').then((d: any) => (d && d.entries) || []).catch(() => [] as any[])),
  };
  const D: HubData = {
    sessions: () => L.sessions.get(), files: () => L.files.get(), acts: () => L.acts.get(), comments: () => L.comments.get(), recs: () => L.recs.get(),
    invalidate: (key) => L[key].drop(),
  };
  const memberName = (mid: string): string => { const m = (o.members || []).find((x) => x.member_id === mid); return (m && m.display_name) || mid || ''; };

  // 배치 상태
  let { layout, scope } = loadHubLayout(pid);
  let editing = false;
  let focus: HubTool | null = o.focus;
  const mq = window.matchMedia('(max-width: 900px)');
  let narrow = mq.matches;

  const commit = (next: HubLayout): void => { layout = next; saveHubLayout(pid, layout, scope); renderGrid(); };
  const openTool = (tool: HubTool | null): void => {
    if (o.inModal) { focus = tool; render(); return; }
    location.hash = '#/projects2/p/' + pid + (tool ? '/' + tool : '');
  };
  const ctx: HubCtx = {
    pid, P, o, D, meId: String(o.meId || ''), narrow, openTool, memberName,
    refreshGrid: () => renderGrid(),
  };

  // 5판 위젯(모든 크기를 스스로 그린다) — 나머지는 아래 FILL(한눈·목록) + embedSection(전체·띠).
  const FILL5: Partial<Record<HubTool, Fill>> = { tasks: fillTasks, sessions: fillSessions };

  // ── 위젯 한 장 ── 격자 칸 수는 CSS 변수(--w·--h)로 — 좁은 폭(한 열)에선 CSS 가 그 변수를 버린다(37-projects-hub.css).
  function widget(tool: HubTool, w: number, h: number): HTMLElement {
    const view = hubView(w, h, narrow);
    const card = el('div', { class: 'pjh-w v-' + view + (w === 1 ? ' col' : ''), 'data-tool': tool, style: '--w:' + w + ';--h:' + h });
    const sub = el('span', { class: 'pjh-wh-sub' });
    const acts = el('span', { class: 'pjh-wh-acts' });
    const openBtn = el('button', { class: 'pjh-open', type: 'button', title: HUB_TOOL_LABEL[tool] + ' 전폭으로 열기', onclick: () => openTool(tool) }, '열기 ', hubIcon('right', 13));
    acts.append(openBtn);
    const head = el('div', { class: 'pjh-wh' },
      el('span', { class: 'pjh-wh-ic ' + TOOL_TONE[tool] }, hubIcon(tool, 16)),
      el('span', { class: 'pjh-wh-name', text: HUB_TOOL_LABEL[tool] }), sub, acts);
    const body = el('div', { class: 'pjh-wb' });
    const foot = el('div', { class: 'pjh-wf' });
    card.append(head, body, foot);
    const fit = { view, w: narrow ? 1 : w, h, cap: hubListCap(h) };
    const f5 = FILL5[tool];
    if (f5) {
      ctx.narrow = narrow;
      f5(ctx, fit, body, foot, sub, acts);
    } else if (view === 'full' || view === 'band') {
      embedSection(tool, body, foot, sub);
    } else {
      FILL[tool]!(fit, body, foot, sub);
    }
    if (editing) decorateEdit(card, tool, w, h);
    return card;
  }

  // «전체»·«띠» — 기존 섹션 카드를 그대로 앉힌다. 카드 크롬은 CSS(.pjh-wb > .card)가 벗기고, 머리의 동작 단추는 위젯 바닥 줄로 옮긴다.
  function embedSection(tool: HubTool, body: HTMLElement, foot: HTMLElement, sub: HTMLElement): void {
    const sec = o.sections[tool]();
    body.append(sec);
    const head = sec.querySelector(':scope > .card-head');
    if (head) {
      const left = head.querySelector('.pjv-tasks-head-left');
      const moved: Element[] = [];
      if (left) for (const kid of Array.from(left.children)) if (kid.tagName !== 'H2' && kid.tagName !== 'H3') moved.push(kid);
      const actsBox = head.querySelector('.card-head-actions');
      if (actsBox) for (const kid of Array.from(actsBox.children)) moved.push(kid);
      const hint = head.querySelector('.pjk-head-hint');
      if (hint) foot.append(el('span', { class: 'pjh-wf-txt', text: hint.textContent || '' }));
      const box = el('span', { class: 'pjh-wf-acts', style: 'margin-left:auto;display:inline-flex;align-items:center;gap:6px;flex:none' });
      for (const kid of moved) box.append(kid);
      foot.append(box);
    }
    const txt = el('span', { class: 'pjh-wf-txt', text: subFor(tool) || FOOT_NOTE[tool] });
    foot.prepend(txt);
    sub.textContent = subFor(tool);
    if (tool === 'folder') D.files().then((items: any[]) => { const dirs = items.filter((i) => i.type === 'dir').length; sub.textContent = items.length ? String(items.length - dirs) + (dirs ? ' · 폴더 ' + dirs : '') : ''; });
    else if (tool === 'timeline') D.acts().then((acts: any[]) => { sub.textContent = acts.length ? String(acts.length) : ''; });
  }
  const FOOT_NOTE: Record<HubTool, string> = { tasks: '할 일', sessions: '세션', body: '본문 · 코멘트', folder: '루트', knowledge: '필요 → 산출', timeline: '이 프로젝트에 연결된 작업만' };
  function subFor(tool: HubTool): string {
    if (tool === 'tasks') { const t = tasks.length, d = tasks.filter((x) => x.status === 'done').length; return t ? d + ' / ' + t + ' 완료' : ''; }
    if (tool === 'body') return P.updated_at ? '갱신 ' + relTime(P.updated_at) : '';
    if (tool === 'knowledge') return '필요 ' + (kn.required || []).length + ' → 산출 ' + (kn.produced || []).length;
    return '';
  }

  // ── «한눈»·«목록» 뷰(아직 5판으로 안 옮긴 도구: 본문·폴더·지식·타임라인) — f.cap = 세로 칸(h)이 담는 줄 수, f.w = 가로 칸(좁은 폭은 1). ──
  type Fit = { view: HubView; w: number; h: number; cap: number };
  type FillOld = (f: Fit, body: HTMLElement, foot: HTMLElement, sub: HTMLElement) => void;
  const FILL: Partial<Record<HubTool, FillOld>> = {
    body(f, body, foot, sub) {
      const md = String(P.description || '');
      sub.textContent = subFor('body');
      const h = lastHeading(md);
      const text = stripMd(md);
      if (f.view === 'glance') {
        body.append(el('div', { class: 'pjh-stat-t', text: h || text.slice(0, 80) || '본문이 비어 있습니다.' }));
        body.append(stat((md.split('\n').filter((l) => /^#{1,6}\s+\S/.test(l)).length || 1) + '절' + (P.updated_at ? ' · 갱신 ' + relTime(P.updated_at) : '')));
      } else {
        // 세로로 길면 발췌도 그만큼 — 한 칸(260px)에 석 줄, 칸이 늘 때마다 아홉 줄씩.
        const lines = f.h <= 1 ? 3 : f.h * 9;
        body.append(el('div', { class: 'pjh-excerpt', style: '-webkit-line-clamp:' + lines }, h ? el('b', { text: h + ' — ' }) : null,
          text.slice(0, 110 * lines) || '본문이 비어 있습니다. 열어서 적으세요.'));
      }
      const tail = el('div', { class: 'pjh-tail' });
      body.append(tail);
      const cnt = el('span', { class: 'pjh-wf-txt' }, hubIcon('comment', 13), '코멘트');
      foot.append(cnt, btn('본문', 'btn-ghost', () => openTool('body')));
      D.comments().then((cs: any[]) => {
        cnt.append(' ' + cs.length);
        const last = cs[cs.length - 1];
        if (!last) return;
        if (f.view === 'glance') tail.append(row(personFace(last.actor, 'pjv-ava', last.display_name), el('span', { class: 'pjh-row-n', style: 'font-weight:500;color:var(--ink-sub)', text: stripMd(last.body || '') })));
        else tail.append(el('div', { class: 'pjh-cmt' }, personFace(last.actor, 'pjv-cmt-mini-ava', last.display_name),
          el('div', { class: 'pjh-cmt-b' }, el('div', { class: 'pjh-cmt-h' }, el('b', { text: last.display_name || last.actor || '' }), el('span', { text: last.ts ? relTime(last.ts) : '' })),
            el('div', { class: 'pjh-cmt-t', text: stripMd(last.body || '') }))));
      });
    },
    folder(f, body, foot, sub) {
      body.append(el('div', { class: 'pjh-stat', text: '파일을 불러오는 중' }));
      D.files().then((items: any[]) => {
        body.replaceChildren();
        const files = items.filter((i) => i.type !== 'dir'), dirs = items.filter((i) => i.type === 'dir');
        sub.textContent = items.length ? String(files.length) + (dirs.length ? ' · 폴더 ' + dirs.length : '') : '';
        if (!items.length) {
          body.append(emptyNote('아직 올린 파일이 없습니다. 열어서 끌어다 놓거나 업로드하세요.'));
          foot.append(el('span', { class: 'pjh-wf-txt', text: '루트' }), btn('폴더', 'btn-ghost', () => openTool('folder')));
          return;
        }
        const latest = [...files].sort((a, b) => (b.mtime || 0) - (a.mtime || 0))[0];
        if (f.view === 'glance') {
          body.append(big(files.length, '파일'));
          if (latest) body.append(stat(el('b', { text: '최근 ' + (latest.mtime ? relTime(new Date(latest.mtime).toISOString()) : '') }), el('br'), latest.name + (latest.size != null ? ' · ' + fmtSize(latest.size) : '')));
        } else if (f.w === 1) {
          // 1칸 폭 긴 목록 — 낱장 카드 대신 줄(아이콘 · 이름 · 크기). 폴더 먼저.
          for (const it of [...dirs, ...files].slice(0, f.cap)) {
            body.append(el('div', { class: 'pjh-row pjh-file-row', title: it.name, onclick: () => openTool('folder') },
              el('span', { class: 'pjh-file-ic' }, fileThumb(pid, it, it.name, o.base)),
              el('span', { class: 'pjh-row-n', text: it.name }),
              it.type === 'dir' ? null : el('span', { class: 'pjh-row-m', text: fmtSize(it.size || 0) })));
          }
        } else {
          const grid = el('div', { class: 'pjh-files' });
          for (const it of [...dirs, ...files].slice(0, 6)) {
            grid.append(el('div', { class: 'proj-file-card', title: it.name, onclick: () => openTool('folder') },
              el('div', { class: 'proj-file-card-ic' }, fileThumb(pid, it, it.name, o.base)),
              el('div', { class: 'proj-file-card-nm', text: it.name }),
              it.type === 'dir' ? null : el('div', { class: 'proj-file-sz', text: fmtSize(it.size || 0) })));
          }
          body.append(grid);
        }
        foot.append(el('span', { class: 'pjh-wf-txt', text: '루트' + (items.length > 6 ? ' · ' + items.length + '개' : '') }), btn('폴더', 'btn-ghost', () => openTool('folder')));
      });
    },
    knowledge(f, body, foot, sub) {
      const req: any[] = kn.required || [], prod: any[] = kn.produced || [];
      sub.textContent = subFor('knowledge');
      const recBox = el('div', {});
      if (f.view === 'glance') {
        body.append(el('div', { class: 'pjh-big' }, String(req.length), el('span', { class: 'pjh-arrow', text: '→' }), String(prod.length), el('small', { text: '필요 → 산출' })));
        const st = stat('연결하면 AI 가 그 문서를 읽은 상태로 시작합니다');
        body.append(st, recBox);
        const first = prod[0] || req[0];
        if (first) body.append(row(hubIcon('doc', 14), el('span', { class: 'pjh-row-n', style: 'font-weight:500;color:var(--ink-sub)', text: first.title || first.name }),
          el('span', { class: 'pjh-kn-rel', text: prod[0] ? '산출' : '필요' })));
        D.recs().then((rs: any[]) => { if (rs.length) st.replaceChildren(el('b', { text: '추천 ' + rs.length }), ' — 연결하면 AI 가 읽고 시작합니다'); });
      } else {
        for (const k of [...prod.map((k) => ({ ...k, rel: '산출' })), ...req.map((k) => ({ ...k, rel: '필요' }))].slice(0, Math.max(4, f.cap - 2))) {
          body.append(row(hubIcon('doc', 14), el('a', { class: 'pjh-row-n pjh-row-link', href: '#/knowledge/' + encodeURIComponent(k.name), text: k.title || k.name }),
            el('span', { class: 'pjh-kn-rel', text: k.rel })));
        }
        body.append(recBox);
        D.recs().then((rs: any[]) => {
          for (const r of rs) {
            const link = el('button', { class: 'pjh-kn-link', type: 'button', text: '연결' });
            link.onclick = async () => {
              link.disabled = true;
              try { await api('/api/ui/v6/projects/' + pid + '/knowledge', { method: 'POST', body: JSON.stringify({ name: r.name, relation: 'required' }) }); toast('필요 지식으로 연결했습니다'); o.reload(); }
              catch (e: any) { toast('연결 실패 — ' + e.message, true); link.disabled = false; }
            };
            recBox.append(row(hubIcon('doc', 14), el('span', { class: 'pjh-row-n', style: 'font-weight:500;color:var(--ink-sub)', text: r.title || r.name }),
              el('span', { class: 'pjh-kn-pct', text: r.similarity != null ? Math.round(r.similarity * 100) + '%' : '' }), link));
          }
          if (!prod.length && !req.length && !rs.length) body.append(emptyNote('연결된 지식이 없습니다. 열어서 ＋ 지식 연결로 시작하세요.'));
        });
      }
      foot.append(el('span', { class: 'pjh-wf-txt', text: '필요 ' + req.length + ' · 산출 ' + prod.length }), btn('지식 연결', 'btn-ghost', () => openTool('knowledge')));
    },
    timeline(f, body, foot, sub) {
      body.append(el('div', { class: 'pjh-stat', text: '기록을 불러오는 중' }));
      D.acts().then((acts: any[]) => {
        body.replaceChildren();
        sub.textContent = acts.length ? String(acts.length) : '';
        if (!acts.length) {
          body.append(emptyNote('아직 이 프로젝트의 작업 기록이 없습니다.'));
          foot.append(el('span', { class: 'pjh-wf-txt', text: '이 프로젝트에 연결된 작업만' }), btn('전체 보기', 'btn-ghost', () => openTool('timeline')));
          return;
        }
        const when = (a: any) => a.committed_at || a.created_at || '';
        if (f.view === 'glance') {
          const a = acts[0];
          body.append(big(acts.length, '기록'));
          body.append(stat(el('b', { text: '마지막 ' + (when(a) ? relTime(when(a)) : '') }), el('br'), (a.summary || a.title || '') + (a.author_person ? ' · ' + memberName(a.author_person) : '')));
        } else {
          // 원장 행은 ≈46px — 한 칸엔 셋, 세로로 늘면 그만큼.
          for (const a of acts.slice(0, f.h <= 1 ? 3 : Math.floor((f.h * 276 - 130) / 46))) {
            const d = when(a) ? new Date(when(a)) : null;
            body.append(el('a', { class: 'pjh-lg', href: '#', onclick: (e: Event) => { e.preventDefault(); openTool('timeline'); } },
              el('span', { class: 'pjh-lg-t' }, d ? (d.getMonth() + 1) + '/' + d.getDate() : '', el('br'), d ? String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') : ''),
              el('span', { class: 'pjh-lg-b' }, el('span', { class: 'pjh-lg-title', text: a.summary || a.title || '(제목 없음)' }),
                el('span', { class: 'pjh-lg-meta', text: [a.type, memberName(a.author_person), a.author_agent].filter(Boolean).join(' · ') })),
              el('span', { class: 'pjh-lg-r' }, hubIcon('chevr', 14))));
          }
        }
        foot.append(el('span', { class: 'pjh-wf-txt', text: '이 프로젝트에 연결된 작업만' }), btn('전체 보기', 'btn-ghost', () => openTool('timeline')));
      });
    },
  };
  void moreNote; void footText; void pjvFmtDate;   // 아직 5판으로 안 옮긴 도구가 다음 PR 에서 쓴다 — 부품은 kit 에 있다

  // ── 편집 모드 크롬 ──
  const sizeText = (w: number, h: number): string => w + '×' + h + ' · ' + HUB_VIEW_LABEL[hubView(w, h)];
  // 크기 고르기 — 표 삽입 격자처럼 가로 HUB_COLS × 세로 HUB_MAX_H 칸에 올려 미리 보고 눌러 정한다(모서리 끌기의 정밀판).
  function openSizePicker(anchor: HTMLElement, tool: HubTool, w0: number, h0: number): void {
    const cells = el('div', { class: 'pjh-szg', style: 'grid-template-columns:repeat(' + HUB_COLS + ',1fr)' });
    const label = el('div', { class: 'pjh-szg-l', text: sizeText(w0, h0) });
    const paint = (w: number, h: number): void => {
      for (const c of Array.from(cells.children) as HTMLElement[]) c.classList.toggle('on', Number(c.dataset.w) <= w && Number(c.dataset.h) <= h);
      label.textContent = sizeText(w, h);
    };
    const menu = el('div', { class: 'pjv-menu pjh-szg-pop' }, cells, label);
    const close = pjvPopover(anchor, menu);
    for (let h = 1; h <= HUB_MAX_H; h++) for (let w = 1; w <= HUB_COLS; w++) {
      cells.append(el('button', { type: 'button', 'data-w': String(w), 'data-h': String(h), 'aria-label': w + '×' + h,
        onmouseenter: () => paint(w, h), onfocus: () => paint(w, h),
        onclick: (e: Event) => { e.stopPropagation(); close(); if (w !== w0 || h !== h0) commit(resizeHubItem(layout, tool, w, h)); } }));
    }
    cells.addEventListener('mouseleave', () => paint(w0, h0));
    paint(w0, h0);
  }
  // 오른쪽 아래 모서리 끌기 — 칸 단위로 끊어 그 자리에서 크기를 바꿔 보여 준다(격자가 dense 라 옆 위젯이 따라 흐른다).
  //  기준은 **누른 자리에서의 이동량**이다: 카드가 넓어지며 다음 줄로 흘러도 그 새 위치로 다시 재지 않는다(재면 크기가 튄다).
  function resizeGrip(card: HTMLElement, tool: HubTool, w0: number, h0: number): HTMLElement {
    const grip = el('span', { class: 'pjh-rsz', title: '끌어서 크기 바꾸기', 'aria-hidden': 'true' });
    grip.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      card.draggable = false;   // 순서 끌기(HTML5 DnD)가 같은 몸짓을 가로채지 않게 — 놓으면 다시 켠다
      const cs = getComputedStyle(grid);
      const gapX = parseFloat(cs.columnGap) || 16, gapY = parseFloat(cs.rowGap) || 16;
      const colW = (grid.getBoundingClientRect().width - gapX * (HUB_COLS - 1)) / HUB_COLS;
      const rowH = parseFloat(cs.gridAutoRows) || 260;
      const x0 = e.clientX, y0 = e.clientY;
      let w = w0, h = h0;
      const tip = el('span', { class: 'pjh-rsz-tip', text: sizeText(w, h) });
      card.append(tip); card.classList.add('resizing');
      try { grip.setPointerCapture(e.pointerId); } catch (_) { /* 옛 브라우저 — move 는 grip 위에서만 */ }
      const move = (ev: PointerEvent): void => {
        const nw = Math.max(1, Math.min(HUB_COLS, w0 + Math.round((ev.clientX - x0) / (colW + gapX))));
        const nh = Math.max(1, Math.min(HUB_MAX_H, h0 + Math.round((ev.clientY - y0) / (rowH + gapY))));
        if (nw === w && nh === h) return;
        w = nw; h = nh;
        card.style.setProperty('--w', String(w)); card.style.setProperty('--h', String(h));
        tip.textContent = sizeText(w, h);
      };
      const up = (): void => {
        grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
        card.draggable = true; card.classList.remove('resizing'); tip.remove();
        if (w !== w0 || h !== h0) commit(resizeHubItem(layout, tool, w, h));   // 커밋이 그 크기의 뷰로 다시 그린다
      };
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
    });
    return grip;
  }
  function decorateEdit(card: HTMLElement, tool: HubTool, w: number, h: number): void {
    const sizeBtn = el('button', { class: 'pjh-szbtn', type: 'button', title: '크기 고르기 — 가로 × 세로 칸', 'aria-haspopup': 'dialog', text: w + '×' + h,
      onclick: (e: Event) => { e.stopPropagation(); openSizePicker(sizeBtn, tool, w, h); } });
    const hide = el('button', { class: 'pjh-hide', type: 'button', title: '숨기기', 'aria-label': HUB_TOOL_LABEL[tool] + ' 숨기기', onclick: (e: Event) => { e.stopPropagation(); commit(hideHubItem(layout, tool)); } }, hubIcon('x', 13));
    card.prepend(el('div', { class: 'pjh-edtools' }, el('span', { class: 'pjh-grip', title: '끌어서 순서 바꾸기' }), el('span', { class: 'pjh-edtools-sp' }), hide, sizeBtn));
    card.append(resizeGrip(card, tool, w, h));
    card.draggable = true;
    card.addEventListener('dragstart', (e: DragEvent) => { e.dataTransfer?.setData('text/plain', tool); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; card.classList.add('dragging'); });
    card.addEventListener('dragend', () => { card.classList.remove('dragging'); grid.querySelectorAll('.over').forEach((x) => x.classList.remove('over')); });
    card.addEventListener('dragover', (e: DragEvent) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; card.classList.add('over'); });
    card.addEventListener('dragleave', () => card.classList.remove('over'));
    card.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault(); card.classList.remove('over');
      const src = e.dataTransfer?.getData('text/plain') as HubTool;
      if (src && src !== tool && (HUB_TOOLS as string[]).includes(src)) commit(moveHubItem(layout, src, tool));
    });
  }
  function editBar(): HTMLElement {
    const presetBtn = el('button', { class: 'pjh-preset', type: 'button' }, hubIcon('grid', 13), '프리셋' + (matchHubPreset(layout) ? ' · ' + (HUB_PRESETS.find((p) => p.id === matchHubPreset(layout)) || HUB_PRESETS[0]).label : ''), hubIcon('chev', 12));
    presetBtn.onclick = (e) => {
      e.stopPropagation();
      const menu = el('div', { class: 'pjv-menu pjh-preset-pop' });
      const close = pjvPopover(presetBtn, menu);
      const cur = matchHubPreset(layout);
      for (const p of HUB_PRESETS) {
        const mini = el('span', { class: 'pjh-pm' });
        for (const it of p.items) mini.append(el('i', { class: it.tool === 'tasks' ? 'a' : '', style: 'grid-column:span ' + it.w + ';grid-row:span ' + it.h }));
        menu.append(el('button', { class: 'pjh-preset-row' + (cur === p.id ? ' on' : ''), type: 'button', onclick: () => { close(); commit(applyHubPreset(p.id)); } }, mini, el('span', { text: p.label })));
      }
    };
    const sw = el('button', { class: 'pjh-sw', type: 'button', role: 'switch', 'aria-checked': String(scope === 'project'),
      onclick: () => { const r = setHubScope(pid, scope === 'project' ? 'global' : 'project', layout); layout = r.layout; scope = r.scope; render(); } },
      el('i'), '이 프로젝트에서만');
    return el('div', { class: 'pjh-edbar' }, hubIcon('grid', 15),
      el('span', {}, el('b', { text: '배치 편집' }), ' — 손잡이(⋮⋮)를 끌어 순서를 바꾸고, 오른쪽 아래 모서리를 끌거나 [가로×세로] 를 눌러 크기를 고르면 그 자리에서 뷰가 바뀝니다. 격자는 빈틈 없이 다시 채워집니다.'),
      el('span', { class: 'pjh-edbar-r' }, presetBtn, sw,
        btn('기본으로', 'btn-ghost', () => { layout = resetHubLayout(pid, scope); renderGrid(); }),
        btn('완료', 'btn-primary', () => { editing = false; render(); })));
  }
  function slot(): HTMLElement {
    const s = el('div', { class: 'pjh-slot' });
    if (!layout.hidden.length) s.append(el('span', { text: '숨긴 도구 없음 — 카드의 × 로 숨기면 여기서 되살립니다' }));
    else {
      s.append(hubIcon('plus', 15), el('span', { text: '위젯 추가' }));
      for (const t of layout.hidden) s.append(btn(HUB_TOOL_LABEL[t], 'btn-ghost', () => commit(showHubItem(layout, t))));
    }
    // 슬롯에 놓으면 맨 뒤로
    s.addEventListener('dragover', (e: DragEvent) => { e.preventDefault(); s.classList.add('over'); });
    s.addEventListener('dragleave', () => s.classList.remove('over'));
    s.addEventListener('drop', (e: DragEvent) => { e.preventDefault(); s.classList.remove('over'); const src = e.dataTransfer?.getData('text/plain') as HubTool; if (src && (HUB_TOOLS as string[]).includes(src)) commit(moveHubItem(layout, src, null)); });
    return s;
  }

  // ── 조립 ──
  const grid = el('div', { class: 'pjh-grid' });
  const top = el('div', {});
  const editBtn = btn('배치 편집', 'btn-ghost', () => { editing = !editing; render(); }, { class: 'btn btn-sm btn-ghost pjh-edit-btn' });
  editBtn.prepend(hubIcon('grid', 13));
  function renderGrid(): void {
    grid.classList.toggle('edit', editing);
    grid.replaceChildren(...layout.items.map((it) => widget(it.tool, it.w, it.h)));
  }
  function render(): void {
    host.replaceChildren();
    if (focus) {
      const tool = focus;
      host.append(el('div', { class: 'pjh-focus-bar' }, btn('허브', 'btn-ghost', () => openTool(null)), el('b', { text: HUB_TOOL_LABEL[tool] }),
        el('span', { class: 'muted', style: 'font-size:12.5px;color:var(--muted-2)', text: '전폭 보기 — 가장 큰 위젯의 확장' })));
      host.append(el('div', { class: 'pjh-focus' }, o.sections[tool]()));
      if (o.actionsHost) o.actionsHost.replaceChildren();
      return;
    }
    if (o.actionsHost) { o.actionsHost.replaceChildren(editBtn); editBtn.classList.toggle('active', editing); }
    top.replaceChildren();
    if (editing) top.append(editBar());
    host.append(top, grid);
    renderGrid();
    if (editing) host.append(slot());
  }
  const onMq = (): void => { const n = mq.matches; if (n !== narrow) { narrow = n; renderGrid(); } };
  try { mq.addEventListener('change', onMq); } catch (_) { /* 옛 사파리 */ }
  render();
}
