// projects/detail-hub-timeline.ts — 허브 «작업 타임라인» 위젯(#4135, 5판 시안 2026-09-25 원준: «1×1 은 최근 기록만 — 비교하는 자리가 아니다.
//  레인은 2×1 부터. 점에 올리면 누가·무슨 작업, 누르면 2칸 높이에서 아래에 자세히»).
//   1×1  최근 셋(시각 · 얼굴 · 요약 · 종류 · 사람)      1×N  피드(오늘·어제·M/D 로 묶어)
//   2×1  7일 레인(사람 × 날 · 점 크기 = 건수 · 회색 열 = 주말) + 범례      3×1  14일 레인
//   2×2+ 7일 레인 + 아래 «그날 그 사람» 기록            3×2+  14일 레인 + 아래 기록 + 범례
//  기록 줄을 누르면 전체 타임라인(열기). 사람 색은 아바타 해시색(core.avatarColor)과 같다.
import { avatarColor, el, personFace } from '../core.js';
import { type Fill, btn, emptyNote, footText } from './detail-hub-kit.js';
import { type LaneDay, actWhen, countOn, countSince, dayKey, dotSize, feedDayHead, feedDayLabel, laneCounts, laneDays, latestLane, rowsBudget } from './detail-hub-model.js';

const TYPE_LABEL: Record<string, string> = { feature: '기능', fix: '수정', decision: '결정', docs: '문서', research: '리서치', review: '검토', chore: '운영', other: '기타' };
// 프로젝트별 «고른 (사람, 날)» — 다시 그려도 남는다.
const PICK: Map<number, { person: string; day: string } | null> = new Map();

export const fillTimeline: Fill = (ctx, f, body, foot, sub) => {
  const { o, pid } = ctx;
  const w = f.w, h = f.h;
  const now = Date.now();
  const open = () => ctx.openTool('timeline');
  const memberName = ctx.memberName;
  body.append(el('div', { class: 'pjh-stat', text: '기록을 불러오는 중' }));
  ctx.D.acts().then((acts: any[]) => {
    body.replaceChildren();
    const sorted = acts.slice().sort((a, b) => actWhen(b) - actWhen(a));
    const weekFrom = new Date(now); weekFrom.setHours(0, 0, 0, 0); weekFrom.setTime(weekFrom.getTime() - 6 * 86400000);
    const week = countSince(sorted, weekFrom.getTime()), today = countOn(sorted, dayKey(now));
    sub.textContent = sorted.length ? (w <= 1 && h <= 1 ? '최근' : '이번 주 ' + week) : '';
    if (!sorted.length) {
      body.append(emptyNote('아직 이 프로젝트의 작업 기록이 없습니다.'));
      foot.append(footText('이 프로젝트에 연결된 작업만'), btn('전체 보기', 'btn-ghost', open));
      return;
    }
    // 기록 한 줄 — 시각 · 얼굴 · 요약 / 종류 · 사람. 시안: 하네스 이름은 안 싣는다(줄마다 «claude-code» 가 반복되면 소음).
    //  mode 'recent' = 1×1(오늘이면 시각만, 아니면 어제·M/D) · 'day' = 사람이 정해진 «자세히» 칸(얼굴·사람 없이 종류만).
    const ev = (a: any, mode: 'feed' | 'recent' | 'day' = 'feed'): HTMLElement => {
      const t = actWhen(a);
      const hm = t ? String(new Date(t).getHours()).padStart(2, '0') + ':' + String(new Date(t).getMinutes()).padStart(2, '0') : '';
      const when = !t ? '' : mode === 'recent' ? (feedDayLabel(t, now) === '오늘' ? hm : feedDayLabel(t, now)) : hm;
      const who = mode === 'day' ? '' : memberName(a.author_person);
      return el('div', { class: 'pjh-ev', onclick: open },
        el('span', { class: 'pjh-ev-t', text: when }),
        mode === 'day' ? null : a.author_person ? personFace(a.author_person, 'pjv-ava', memberName(a.author_person)) : el('span', { class: 'pjv-ava pjh-ev-agent', text: 'AI' }),
        el('div', { class: 'pjh-ev-b' },
          el('div', { class: 'pjh-ev-s', text: a.summary || a.title || '(제목 없음)' }),
          el('div', { class: 'pjh-ev-m' }, el('span', { class: 'pjh-ev-ty', text: TYPE_LABEL[a.type] || a.type || '' }), who ? el('span', { text: who }) : null)));
    };

    if (w <= 1 && h <= 1) {
      for (const a of sorted.slice(0, 3)) body.append(ev(a, 'recent'));
      foot.append(footText('오늘 ' + today + '건 · 이번 주 ' + week), btn('전체 보기', 'btn-ghost', open));
      return;
    }
    if (w <= 1) {
      // 피드 — 날로 묶어. 줄 하나 ≈ 44px.
      const cap = Math.max(3, Math.floor((h * 276 - 16 - 114 - 3 * 24) / 46));   // 줄 ≈46px · 날 머리 셋 몫을 뺀다
      let lastDay = '';
      for (const a of sorted.slice(0, cap)) {
        const d = feedDayLabel(actWhen(a), now);
        if (d !== lastDay) { body.append(el('div', { class: 'pjh-grp' }, el('b', { text: feedDayHead(actWhen(a), now) }))); lastDay = d; }
        body.append(ev(a));
      }
      if (sorted.length > cap) body.append(el('button', { class: 'pjv-more-row', type: 'button', text: '… ' + (sorted.length - cap) + '개 더', onclick: open }));
      foot.append(footText('이 프로젝트에 연결된 작업만'), btn('전체 보기', 'btn-ghost', open));
      return;
    }

    // ── 레인 — 사람 × 날 ──
    const nDays = w >= 3 ? 14 : 7;
    const days: LaneDay[] = laneDays(nDays, now);
    const order = [...(o.members || []).map((m) => String(m.member_id)), ...sorted.map((a) => String(a.author_person || ''))].filter((x, i, arr) => x && arr.indexOf(x) === i);
    const counts = laneCounts(sorted, days, []);
    const people = order.filter((p) => counts.has(p));
    const pick = PICK.has(pid) ? PICK.get(pid)! : latestLane(sorted);
    const lane = el('div', { class: 'pjh-lane' + (h <= 1 ? ' short' : ''), style: '--n:' + nDays });
    lane.append(el('div', { class: 'pjh-lane-h' }, el('span', { class: 'pjh-lane-lab' }), ...days.map((d) => el('span', { class: 'pjh-lane-d' + (d.weekend ? ' wk' : '') + (d.today ? ' today' : ''), text: d.label }))));
    for (const p of people) {
      const row = counts.get(p)!;
      lane.append(el('div', { class: 'pjh-lane-r' },
        el('span', { class: 'pjh-lane-lab' }, personFace(p, 'pjv-ava', memberName(p)), el('span', { class: 'pjh-lane-nm', text: memberName(p) })),
        ...days.map((d, i) => {
          const n = row[i], s = dotSize(n);
          const cell = el('span', { class: 'pjh-lane-c' + (d.weekend ? ' wk' : '') + (d.today ? ' today' : ''), title: n ? memberName(p) + ' · ' + n + '건 · ' + d.label : '' });
          if (s) {
            const dot = el('i', { class: 'pjh-lane-dot s' + s + (pick && pick.person === p && pick.day === d.key ? ' on' : ''), style: 'background:' + avatarColor(p) });
            dot.onclick = () => { if (h <= 1) { open(); return; } PICK.set(pid, { person: p, day: d.key }); ctx.refreshGrid(); };
            cell.append(dot);
          }
          return cell;
        })));
    }
    body.append(lane);
    if (h >= 2 && pick) {
      const items = sorted.filter((a) => String(a.author_person || '') === pick.person && actWhen(a) && dayKey(actWhen(a)) === pick.day);
      const dayLabel = feedDayLabel(Date.parse(pick.day + 'T12:00:00'), now);
      const det = el('div', { class: 'pjh-lane-det' });
      const md = (() => { const d = new Date(pick.day + 'T12:00:00'); return (d.getMonth() + 1) + '/' + d.getDate(); })();
      det.append(el('div', { class: 'pjh-det-h' }, personFace(pick.person, 'pjv-ava', memberName(pick.person)), el('b', { text: memberName(pick.person) + ' · ' + dayLabel + (dayLabel === '오늘' || dayLabel === '어제' ? ' ' + md : '') }), el('span', { text: items.length + '건 — 점을 누르면 여기에' })));
      const cap = Math.max(1, rowsBudget(h, 0, 30 * (people.length + 1) + 40) - 2);
      for (const a of items.slice(0, Math.max(1, Math.floor(cap * 31 / 44)))) det.append(ev(a, 'day'));
      if (!items.length) det.append(el('div', { class: 'pjh-stat', text: '이날 기록이 없습니다 — 점을 누르면 그날 그 사람의 기록이 여기 섭니다.' }));
      body.append(det);
    }
    const legend = el('div', { class: 'pjh-legend' }, ...people.map((p) => el('span', {}, el('i', { style: 'background:' + avatarColor(p) }), memberName(p) + ' ' + (counts.get(p) || []).reduce((a2, n) => a2 + n, 0))),
      el('span', { class: 'pjh-legend-h', text: h <= 1 ? '점 크기 = 그날 건수 · 회색 열 = 주말 · 점에 올리면 누가·무슨 작업' : '점 크기 = 그날 건수 · 회색 열 = 주말 · 점을 누르면 그날 그 사람의 기록' }));
    body.append(el('div', { style: 'flex:1' }), legend);
    foot.append(footText(nDays + '일 · 이번 주 ' + week + '건'), btn('전체 보기', 'btn-ghost', open));
  });
};
