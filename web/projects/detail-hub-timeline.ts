// projects/detail-hub-timeline.ts — 허브 «작업 타임라인» 위젯(#4135, 5판 시안 2026-09-25 원준: «1×1 은 최근 기록만 — 비교하는 자리가 아니다.
//  레인은 2×1 부터. 점에 올리면 누가·무슨 작업, 누르면 2칸 높이에서 아래에 자세히»).
//   1×1  최근 셋(종류 점 · 요약 / 사람 · 시각)          1×N  피드(오늘·어제·M/D 로 묶어 — 전부, 안에서 스크롤)
//   2×1  7일 레인(사람 × 날 · 점 크기 = 건수 · 옅은 열 = 주말) + 범례      3×1  14일 레인
//   2×2+ 7일 레인 + 아래 «그날 그 사람» 기록            3×2+  14일 레인 + 아래 기록 + 범례
//   모달 30일 레인 + 아래 [기록 전부(사람 · 종류 거르기, 점을 누르면 그날 그 사람만) | 고른 기록의 속(제목 · 메모 · AI · 저장소·커밋 · 세션 · 이어진 지식)]
//  위젯의 기록 줄을 누르면 모달(열기). 사람 색은 아바타 해시색(core.avatarColor)과 같다.
import { avatarColor, el, personFace, relTime } from '../core.js';
import { pjvPopover } from './popover.js';
import { type CtxRow, type Fill, SEP, btn, copyRow, emptyNote, footText, hubCtx, hubIcon, openRouteRow } from './detail-hub-kit.js';
import { type LaneDay, actWhen, countOn, countSince, dayKey, dotSize, feedDayHead, feedDayLabel, laneCounts, laneDays, latestLane } from './detail-hub-model.js';

const TYPE_LABEL: Record<string, string> = { feature: '기능', fix: '수정', decision: '결정', docs: '문서', research: '리서치', review: '검토', chore: '운영', other: '기타' };
const REL_LABEL: Record<string, string> = { produced: '산출', references: '참조', decided: '결정' };
// 프로젝트별 «고른 (사람, 날)» — 다시 그려도 남는다.
const PICK: Map<number, { person: string; day: string } | null> = new Map();
// 모달의 거르기·고른 기록 — 페이지 안에서만 산다.
type Tools = { person: string; type: string; sel: string };
const TOOLS: Map<number, Tools> = new Map();
const toolsOf = (pid: number): Tools => { let t = TOOLS.get(pid); if (!t) { t = { person: '', type: '', sel: '' }; TOOLS.set(pid, t); } return t; };

export const fillTimeline: Fill = (ctx, f, body, foot, sub) => {
  const { o, pid } = ctx;
  const w = f.w, h = f.h;
  const modal = !!f.modal;
  const phone = modal && ctx.narrow;   // 좁은 화면의 모달 — 레인은 14일 · 날짜는 하루 걸러(오늘부터 거꾸로)
  const now = Date.now();
  const open = () => ctx.openTool('timeline');
  const memberName = ctx.memberName;
  body.append(el('div', { class: 'pjh-stat', text: '기록을 불러오는 중' }));
  ctx.D.acts().then((acts: any[]) => {
    body.replaceChildren();
    const sorted = acts.slice().sort((a, b) => actWhen(b) - actWhen(a));
    const weekFrom = new Date(now); weekFrom.setHours(0, 0, 0, 0); weekFrom.setTime(weekFrom.getTime() - 6 * 86400000);
    const week = countSince(sorted, weekFrom.getTime()), today = countOn(sorted, dayKey(now));
    sub.textContent = sorted.length ? (modal ? '전체 ' + sorted.length + ' · 이번 주 ' + week : w <= 1 && h <= 1 ? '최근' : '이번 주 ' + week) : '';
    if (!sorted.length) {
      body.append(emptyNote('아직 이 프로젝트의 작업 기록이 없습니다.'));
      foot.append(footText('이 프로젝트에 연결된 작업만'));
      if (!modal) foot.append(btn('전체 보기', 'btn-ghost', open));
      return;
    }
    const hmOf = (t: number): string => t ? String(new Date(t).getHours()).padStart(2, '0') + ':' + String(new Date(t).getMinutes()).padStart(2, '0') : '';
    // 기록 한 줄 — 프로젝트 탭 타임라인 섹션과 같은 결: 종류 점 · «종류 요약» / «사람 · 시각». 하네스 이름은 줄에 안 싣는다(모달의 속 칸에 있다).
    //  mode 'recent' = 1×1(«3시간 전») · 'feed' = 날 머리 아래(«원준 · 20:01») · 'day' = 사람이 정해진 «자세히» 칸(시각만).
    const ev = (a: any, mode: 'feed' | 'recent' | 'day' = 'feed', onPick: () => void = open, on = false): HTMLElement => {
      const t = actWhen(a);
      const when = !t ? '' : mode === 'recent' ? relTime(new Date(t).toISOString()) : hmOf(t);
      const who = mode === 'day' ? '' : (memberName(a.author_person) || 'AI');
      const ty = TYPE_LABEL[a.type] || a.type || '';
      return hubCtx(el('div', { class: 'pjh-ev' + (on ? ' on' : ''), onclick: onPick },
        el('i', { class: 'pjh-ev-dot ' + String(a.type || ''), 'aria-hidden': 'true' }),
        el('div', { class: 'pjh-ev-b' },
          el('div', { class: 'pjh-ev-s' }, ty ? el('b', { class: 'pjh-ev-ty', text: ty }) : null, el('span', { text: a.summary || a.title || '(제목 없음)' })),
          el('div', { class: 'pjh-ev-m', text: [who, when].filter(Boolean).join(' · ') }))) as HTMLElement,
      String(a.summary || a.title || '기록'), '작업 기록' + (ty ? ' · ' + ty : ''), () => actRows(a));
    };
    //  우클릭 — 기록 한 줄: 자세히(모달에서 이 기록) · 그 세션 · 바깥 링크 · 복사.
    const actRows = (a: any): Array<CtxRow | null> => [
      { label: '자세히 보기', icon: 'open', run: () => { toolsOf(pid).sel = String(a.id); PICK.set(pid, null); if (modal) ctx.refreshGrid(); else open(); } },
      a.session_id ? openRouteRow('이 작업을 한 세션 열기', '#/s/' + encodeURIComponent(String(a.session_id)), 'term') : null,
      a.external_url ? { label: '바깥 링크 열기', icon: 'open', run: () => { window.open(String(a.external_url), '_blank', 'noopener'); } } : null,
      SEP,
      copyRow('요약 복사', String(a.summary || a.title || '')),
      a.title && a.title !== a.summary ? copyRow('제목 복사', String(a.title)) : null,
      a.body ? copyRow('메모 복사', String(a.body)) : null,
      a.commit_sha ? copyRow('커밋 복사', String(a.commit_sha)) : null,
      a.session_id ? copyRow('세션 id 복사', String(a.session_id)) : null,
    ];

    if (!modal && w <= 1 && h <= 1) {
      for (const a of sorted.slice(0, 3)) body.append(ev(a, 'recent'));
      foot.append(footText('오늘 ' + today + '건 · 이번 주 ' + week), btn('전체 보기', 'btn-ghost', open));
      return;
    }
    /** 날로 묶은 피드 — 전부 세우고 그 안에서 스크롤(자르지 않는다). */
    const feed = (items: any[], onPick?: (a: any) => void, selId = ''): HTMLElement => {
      const box = el('div', { class: 'pjh-feed', 'data-mscroll': 'feed' });
      let lastDay = '';
      for (const a of items) {
        const d = dayKey(actWhen(a));
        if (d !== lastDay) { box.append(el('div', { class: 'pjh-grp' }, el('b', { text: feedDayHead(actWhen(a), now) }))); lastDay = d; }
        box.append(ev(a, 'feed', onPick ? () => onPick(a) : open, !!selId && String(a.id) === selId));
      }
      return box;
    };
    if (!modal && w <= 1) {
      body.append(feed(sorted));
      foot.append(footText('기록 ' + sorted.length + ' · 이 프로젝트에 연결된 작업만'), btn('전체 보기', 'btn-ghost', open));
      return;
    }

    // ── 레인 — 사람 × 날 ──
    const nDays = phone ? 14 : modal ? 30 : w >= 3 ? 14 : 7;
    const days: LaneDay[] = laneDays(nDays, now);
    const order = [...(o.members || []).map((m) => String(m.member_id)), ...sorted.map((a) => String(a.author_person || ''))].filter((x, i, arr) => x && arr.indexOf(x) === i);
    const counts = laneCounts(sorted, days, []);
    const people = order.filter((p) => counts.has(p));
    // 위젯은 가장 최근 (사람, 날)을 기본으로 고른다. 모달은 고르기 전엔 전부를 보인다(점을 눌러야 좁힌다).
    const pick = PICK.has(pid) ? PICK.get(pid)! : (modal ? null : latestLane(sorted));
    const lane = el('div', { class: 'pjh-lane' + (!modal && h <= 1 ? ' short' : ''), style: '--n:' + nDays });
    lane.append(el('div', { class: 'pjh-lane-h' }, el('span', { class: 'pjh-lane-lab' }), ...days.map((d, i) => el('span', { class: 'pjh-lane-d' + (d.weekend ? ' wk' : '') + (d.today ? ' today' : ''), text: phone && (nDays - 1 - i) % 2 ? '' : d.label }))));
    for (const p of people) {
      const row = counts.get(p)!;
      lane.append(el('div', { class: 'pjh-lane-r' },
        el('span', { class: 'pjh-lane-lab' }, personFace(p, 'pjv-ava', memberName(p)), el('span', { class: 'pjh-lane-nm', text: memberName(p) })),
        ...days.map((d, i) => {
          const n = row[i], s = dotSize(n);
          const cell = el('span', { class: 'pjh-lane-c' + (d.weekend ? ' wk' : '') + (d.today ? ' today' : ''), title: n ? memberName(p) + ' · ' + n + '건 · ' + d.label : '' });
          if (s) {
            const isOn = !!pick && pick.person === p && pick.day === d.key;
            const dot = el('i', { class: 'pjh-lane-dot s' + s + (isOn ? ' on' : ''), style: 'background:' + avatarColor(p) });
            dot.onclick = () => {
              if (!modal && h <= 1) { open(); return; }
              PICK.set(pid, modal && isOn ? null : { person: p, day: d.key });   // 모달: 같은 점을 다시 누르면 풀린다
              ctx.refreshGrid();
            };
            cell.append(dot);
          }
          return cell;
        })));
    }
    body.append(lane);
    const legend = (hint: string): HTMLElement => el('div', { class: 'pjh-legend' }, ...people.map((p) => el('span', {}, el('i', { style: 'background:' + avatarColor(p) }), memberName(p) + ' ' + (counts.get(p) || []).reduce((a2, n) => a2 + n, 0))),
      el('span', { class: 'pjh-legend-h', text: hint }));

    if (!modal) {
      if (h >= 2 && pick) {
        const items = sorted.filter((a) => String(a.author_person || '') === pick.person && actWhen(a) && dayKey(actWhen(a)) === pick.day);
        const dayLabel = feedDayLabel(Date.parse(pick.day + 'T12:00:00'), now);
        const det = el('div', { class: 'pjh-lane-det', 'data-mscroll': 'det' });
        const md = (() => { const d = new Date(pick.day + 'T12:00:00'); return (d.getMonth() + 1) + '/' + d.getDate(); })();
        det.append(el('div', { class: 'pjh-det-h' }, personFace(pick.person, 'pjv-ava', memberName(pick.person)), el('b', { text: memberName(pick.person) + ' · ' + dayLabel + (dayLabel === '오늘' || dayLabel === '어제' ? ' ' + md : '') }), el('span', { text: items.length + '건 — 점을 누르면 여기에' })));
        for (const a of items) det.append(ev(a, 'day'));   // 전부 — 넘치면 이 칸 안에서 스크롤
        if (!items.length) det.append(el('div', { class: 'pjh-stat', text: '이날 기록이 없습니다 — 점을 누르면 그날 그 사람의 기록이 여기 섭니다.' }));
        body.append(det);
      } else {
        body.append(el('div', { style: 'flex:1' }));
      }
      body.append(legend(h <= 1 ? '점 크기 = 그날 건수 · 옅은 열 = 주말 · 점을 누르면 크게 열립니다' : '점 크기 = 그날 건수 · 옅은 열 = 주말 · 점을 누르면 그날 그 사람의 기록'));
      foot.append(footText(nDays + '일 · 이번 주 ' + week + '건'), btn('전체 보기', 'btn-ghost', open));
      return;
    }

    // ── 모달 — 레인 아래: 왼쪽 기록 전부(거르기) · 오른쪽 고른 기록의 속 ──
    const tools = toolsOf(pid);
    const types = [...new Set(sorted.map((a) => String(a.type || 'other')))];
    let items = sorted.filter((a) => (!tools.person || String(a.author_person || '') === tools.person) && (!tools.type || String(a.type || 'other') === tools.type));
    if (pick) items = items.filter((a) => String(a.author_person || '') === pick.person && actWhen(a) && dayKey(actWhen(a)) === pick.day);
    const chip = (k: string, v: string, onclick: (b: HTMLElement) => void) => {
      const c = el('button', { class: 'pjh-chip', type: 'button' }, k + ' ', el('b', { text: v }), hubIcon('chev', 11));
      c.onclick = (e) => { e.stopPropagation(); onclick(c); };
      return c;
    };
    const menuOf = (anchor: HTMLElement, its: Array<[string, string]>, cur: string, pickV: (v: string) => void) => {
      const menu = el('div', { class: 'pjv-menu' });
      const close = pjvPopover(anchor, menu);
      for (const [v, label] of its) menu.append(el('button', { class: 'pjv-menu-item' + (v === cur ? ' sel' : ''), type: 'button', text: label, onclick: (e: Event) => { e.stopPropagation(); close(); pickV(v); } }));
    };
    const toolsRow = el('div', { class: 'pjh-tools' },
      chip('사람', tools.person ? memberName(tools.person) : '전체', (b) => menuOf(b, [['', '전체'], ...people.map((p) => [p, memberName(p)] as [string, string])], tools.person, (v) => { tools.person = v; ctx.refreshGrid(); })),
      chip('종류', tools.type ? (TYPE_LABEL[tools.type] || tools.type) : '전체', (b) => menuOf(b, [['', '전체'], ...types.map((t) => [t, TYPE_LABEL[t] || t] as [string, string])], tools.type, (v) => { tools.type = v; ctx.refreshGrid(); })));
    if (pick) {
      const d = new Date(pick.day + 'T12:00:00');
      toolsRow.append(el('button', { class: 'pjh-chip on', type: 'button', title: '점으로 고른 날 — 누르면 풀립니다', onclick: () => { PICK.set(pid, null); ctx.refreshGrid(); } },
        memberName(pick.person) + ' · ' + (d.getMonth() + 1) + '/' + d.getDate() + ' ', hubIcon('x', 11)));
    }
    toolsRow.append(el('span', { class: 'pjh-tools-n', text: items.length + '건' }));
    const sel = items.find((a) => String(a.id) === tools.sel) || items[0] || null;
    const listBox = items.length ? feed(items, (a) => { tools.sel = String(a.id); ctx.refreshGrid(); }, sel ? String(sel.id) : '')
      : el('div', { class: 'pjh-stat', text: '이 조건에 맞는 기록이 없습니다 — 거르기를 풀어 보세요.' });
    const side = el('div', { class: 'pjh-side', 'data-mscroll': 'tl-side' });
    if (!sel) side.append(el('div', { class: 'pjh-side-l', text: '고른 기록' }), el('div', { class: 'pjh-stat', text: '왼쪽에서 기록을 누르면 속이 여기 섭니다.' }));
    else {
      const t = actWhen(sel); const d = t ? new Date(t) : null;
      const full = d ? d.getFullYear() + '. ' + (d.getMonth() + 1) + '. ' + d.getDate() + '. ' + hmOf(t) + ' · ' + relTime(d.toISOString()) : '';
      const refs: any[] = Array.isArray(sel.refs) ? sel.refs : [];
      side.append(
        el('div', { class: 'pjh-side-l', text: '고른 기록' }),
        el('div', { class: 'pjh-tl-h' }, el('i', { class: 'pjh-ev-dot ' + String(sel.type || '') }), el('b', { class: 'pjh-ev-ty', text: TYPE_LABEL[sel.type] || sel.type || '기타' })),
        el('div', { class: 'pjh-tl-t', text: sel.title || sel.summary || '(제목 없음)' }),
        sel.summary && sel.title && sel.summary !== sel.title ? el('div', { class: 'pjh-tl-s', text: sel.summary }) : null,
        el('div', { class: 'pjh-kv' },
          el('b', { text: '사람' }), el('span', { class: 'pjh-rail-who' }, sel.author_person ? personFace(sel.author_person, 'pjv-ava', memberName(sel.author_person)) : null, memberName(sel.author_person) || '—'),
          ...(sel.author_agent ? [el('b', { text: 'AI' }), el('span', { text: String(sel.author_agent) })] : []),
          el('b', { text: '때' }), el('span', { text: full }),
          ...(sel.repo || sel.commit_sha ? [el('b', { text: '저장소 · 커밋' }), el('span', { class: 'pjh-mono', text: [sel.repo, sel.commit_sha ? String(sel.commit_sha).slice(0, 8) : ''].filter(Boolean).join(' @ ') })] : []),
          ...(sel.session_id ? [el('b', { text: '세션' }), el('span', { class: 'pjh-mono', text: String(sel.session_id) })] : []),
          ...(sel.external_url ? [el('b', { text: '바깥 링크' }), el('a', { class: 'pjh-kr-t', href: String(sel.external_url), target: '_blank', rel: 'noopener', text: String(sel.external_url) })] : [])),
        el('div', { class: 'pjh-side-l', text: '메모' }),
        sel.body ? el('div', { class: 'pjh-stail', text: String(sel.body) }) : el('div', { class: 'pjh-rail-fine', text: '남긴 메모가 없습니다.' }),
        el('div', { class: 'pjh-side-l', text: '이어진 지식 ' + refs.length }),
        ...(refs.length ? refs.map((r) => el('div', { class: 'pjh-kr' }, hubIcon('doc', 13),
          el('a', { class: 'pjh-kr-t', href: '#/k/' + encodeURIComponent(String(r.name || '')), target: '_blank', rel: 'noopener', title: '새 탭에서 지식 열기', text: r.title || r.name }),
          el('span', { class: 'pjh-kn-rel', text: REL_LABEL[r.relation] || r.relation || '' })))
          : [el('div', { class: 'pjh-rail-fine', text: '이 기록에 이어진 지식이 없습니다.' })]));
    }
    body.append(legend(phone ? '점을 누르면 그날 그 사람의 기록만' : '점 크기 = 그날 건수 · 옅은 열 = 주말 · 점을 누르면 아래가 그날 그 사람의 기록으로 좁혀집니다'), toolsRow,
      el('div', { class: 'pjh-mtwo', style: 'grid-template-columns:minmax(0,1fr) 380px' }, el('div', { class: 'pjh-mmain' }, listBox), side));
    foot.append(footText(phone ? '전체 ' + sorted.length + '건 · 이번 주 ' + week + ' · 오늘 ' + today : nDays + '일 레인 · 전체 ' + sorted.length + '건 · 이번 주 ' + week + '건 · 오늘 ' + today + '건 — 이 프로젝트에 연결된 작업만'));
  });
};
