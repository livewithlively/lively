// dash/widget-notifications.ts — ⓪ 최신 알림 위젯(#1313 R43 · dashboard-home.ts 에서 verbatim 분리).
//  '나에 관한' 개인 인박스(팀 작업 로그와 별개). 전용 알림 백엔드가 없어(감사) 기존 API 를 **합성**한다:
//  활동(activity/list) · 댓글/멘션/필드변경(프로젝트별 getTaskFeed, 상위 K) · 다가오는 마감 · 나를 초대한 AI 세션.
//  내 행위는 빼고 '남이 한 것·내가 알아야 할 것'만 최신순. 유형별 on/off 는 헤더 '알림 설정'(dashNotifPrefs, 기기별 저장).
//  각 알림은 '누가·무엇을·언제'가 한눈에 — 행위자 아바타 + 유형 뱃지 + 동사형 문장 + 상대시간(#알림 UX).
//  ⚠ 알림 유형 카탈로그(DASH_NOTIF_GROUPS)는 dash/prefs.ts 에 있다 — 그 파일의 기본값 표(DASH_NOTIF_DEFAULTS)가
//   모듈 초기화 시점에 카탈로그를 접는다. 카탈로그를 여기로 올리면 prefs ↔ 이 파일이 **초기화 시점** 순환이 된다
//   (함수 호출 순환과 달리 TDZ 로 실제로 깨진다) → 카탈로그는 prefs 소유로 두고 여기서 읽기만 한다.
//  ⚠ 마감 일수 계산은 dash/widget-tasks-review-log.ts 의 dashDueDays **한 벌**을 쓴다(#1313 R43) — 예전엔 여기에
//   dueInDays 라는 두 번째 구현이 있었다. 라벨 문구는 자리마다 달라(마감 알림 '3일 뒤' vs 할 일 배지 '3일 남음')
//   dueLabel 은 여기 남는다.
import { api, el, errorNote, relTime, state } from '../core.js';
import { DASH_NOTIF_GROUPS, dashFieldPref, dashNotifPrefs, dashNotifReadSet, dashSaveNotifPrefs, dashSaveNotifRead } from './prefs.js';
import { dashClockIcon, dashCommentIcon, dashPersonIcon, dashReviewIcon, dashSessionIcon, dashSparkIcon } from './icons.js';
import { dashCtl, dashEmpty, dashPopover, myDisplayName } from './chrome.js';
import { DASH_ACT_TONE, dashDueDays } from './widget-tasks-review-log.js';

// 최신 알림(⓪) — 프로젝트 필드 변경 이벤트(getTaskFeed event)의 한국어 라벨.
const DASH_FIELD_LABEL = { status: '상태', assignee: '담당', priority: '우선순위', due_date: '마감', start_date: '시작일', name: '이름', description: '내용' };
// 활동 유형 → 알림 동사(주어=사람). 팀 작업 활동을 '~했어요' 문장으로.
const DASH_ACT_VERB = { feature: '기능을 추가했어요', fix: '오류를 고쳤어요', decision: '결정을 남겼어요', docs: '문서를 정리했어요', research: '리서치를 진행했어요', review: '리뷰를 남겼어요', chore: '작업을 처리했어요', other: '작업했어요' };

async function fillNotifications(zone, projectsP) {
  const meId = (state.me && (state.me.userId || state.me.email)) || '';
  const myName = myDisplayName();
  let projects;
  try { projects = await projectsP; }
  catch (e) { zone.body.replaceChildren(errorNote(e, '알림을 불러오지 못했습니다')); return; }
  const people = await api('/api/ui/dash/people').then((d) => (d && d.people) || []).catch(() => []);
  const nameOf = (pid) => { if (!pid) return ''; const m = people.find((x) => x.author_person === pid); return (m && (m.nickname || m.display_name)) || pid; };
  const projById = new Map<any, any>(projects.map((p) => [p.id, p]));
  const myIds = new Set(projects.map((p) => p.id));

  // 댓글·변경 피드는 최근 갱신 상위 K개 프로젝트만(과다 요청 방지 — 활동은 대개 최근 프로젝트에 몰림).
  const K = 12;
  const topIds = projects.slice()
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .slice(0, K).map((p) => p.id);

  const [acts, feeds, sess, scfg, review] = await Promise.all([
    api('/api/ui/activity/list?limit=100').then((d) => (Array.isArray(d) ? d : (d && d.rows) || [])).catch(() => []),
    Promise.all(topIds.map((id) =>
      api('/api/ui/v6/projects/' + id + '/comments')
        .then((d) => ({ id, feed: (d && d.feed) || [] })).catch(() => ({ id, feed: [] })))),
    api('/api/ui/terminal/sessions').then((d) => (d && d.sessions) || []).catch(() => []), // 세션 초대용
    api('/api/ui/terminal/config').catch(() => null),
    // #802 검토 대기 건수(신규 pending 지식 + 수정 리비전, '내 도메인' 분리). 검토 권한(memory scope)이 없으면 403 →
    //  null → 행 자체를 안 그린다(검토할 수 없는 사람에게 알릴 이유가 없다).
    api('/api/ui/review-queue/summary').catch(() => null),
  ]);
  const memberName = (id) => { const m = ((scfg && scfg.members) || []).find((x) => x.id === id); return (m && m.name) || id || ''; };

  const items: any[] = [];
  // (1) 활동 — 내 프로젝트 + 내가 아닌 사람. 동사형 문장(누가 ~했어요) + 상세는 summary.
  for (const a of acts) {
    if (!myIds.has(a.project_id) || (a.author_person && a.author_person === meId)) continue;
    items.push({ ts: a.committed_at || a.created_at, kind: 'act', pref: a.type === 'chore' ? 'chore' : 'activity', tone: DASH_ACT_TONE[a.type] || 'mut',
      verb: DASH_ACT_VERB[a.type] || '작업했어요', snippet: a.summary || a.title || '',
      actorPerson: a.author_person, agent: a.author_agent, who: nameOf(a.author_person) || a.author_agent || '누군가',
      pid: a.project_id, proj: projById.get(a.project_id)?.name || '' });
  }
  // (2) 프로젝트 피드 — 댓글/멘션/새항목/필드변경. 내가 한 건 제외.
  for (const { id, feed } of feeds) {
    const pname = projById.get(id)?.name || '';
    for (const f of feed) {
      if (f.actor && f.actor === meId) continue;
      const who = f.display_name || nameOf(f.actor) || '누군가';
      const base = { ts: f.ts, actorPerson: f.actor, who, pid: id, proj: pname };
      if (f.kind === 'comment') {
        const body = String(f.body || '').replace(/\s+/g, ' ').trim();
        const mentioned = !!myName && (body.includes('@' + myName) || (!!meId && body.includes('@' + meId)));
        items.push({ ...base, kind: mentioned ? 'mention' : 'comment', pref: mentioned ? 'mention' : 'comment',
          verb: mentioned ? '나를 언급했어요' : '댓글을 남겼어요', snippet: body || '(내용 없음)' });
      } else if (f.kind === 'event' && f.field === 'created') {
        items.push({ ...base, kind: 'created', pref: 'created', verb: '새로 만들었어요', snippet: '' });
      } else if (f.kind === 'event' && f.field) {
        items.push({ ...base, kind: 'update', pref: dashFieldPref(f.field), verb: eventLabel(f), snippet: '' });
      }
    }
  }
  // (3) 세션 초대 — 나를 초대한(내가 소유 아님) AI 세션. created 를 시각으로.
  for (const s of sess) {
    if (s.owned) continue;
    items.push({ ts: s.created ? new Date((Number(s.created) || 0) * 1000).toISOString() : '', kind: 'invite', pref: 'session_invite',
      verb: 'AI 세션에 초대했어요', snippet: s.label || '(이름 없음)', who: memberName(s.owner) || '누군가', actorPerson: s.owner,
      sid: s.id, label: s.label });
  }

  // (4) 다가오는/지난 마감 — 마감일 있는 미완 프로젝트(7일 이내 or 지남).
  const due = projects
    .map((p) => ({ p, n: dashDueDays(p.due_date) }))
    .filter((x) => x.n != null && x.p.status !== 'done' && (x.n as number) <= 7)
    .sort((a, b) => (a.n as number) - (b.n as number));

  items.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  for (const it of items) it.key = it.kind + '|' + (it.pid || it.sid || '') + '|' + (it.ts || '');

  // 헤더 우상단 통일 컨트롤 — ⚙(알림 설정) + →(작업 로그 딥링크). render 는 아래 const 로 정의(클릭 시점엔 초기화 완료).
  dashCtl(zone, { gear: { title: '알림 설정', open: (a) => openNotifPrefs(a, render) }, action: { href: '#/projects2/worklog', title: '작업 로그 탭으로' } });

  // 프리셋으로 걸러 렌더 + 읽음/안읽음(인박스). 설정·모두읽음 변경 시 재렌더(재요청 없이).
  const render = () => {
    const prefs = dashNotifPrefs();
    const read = dashNotifReadSet();
    const feedItems = items.filter((it) => prefs[it.pref]).slice(0, 24);
    const dueShown = prefs.due ? due : [];
    // 검토 대기 — 마감과 같은 '상시 리마인더'(읽음 대상 아님, 처리하면 사라짐). 0건이면 아예 안 뜬다.
    const revShown = (prefs.review && review && Number(review.total) > 0) ? review : null;
    const unread = feedItems.filter((it) => !read.has(it.key));
    // 헤더: 안 읽음 수 뱃지(있으면) + '모두 읽음' 액션.
    zone.countEl.replaceChildren(unread.length
      ? el('span', { class: 'dash-ntf-unreadn', text: String(unread.length) + ' 안 읽음' })
      : (feedItems.length ? el('span', { class: 'dash-ntf-alldone', text: '다 읽음' }) : el('span')));
    if (unread.length) {
      const markBtn = el('button', { class: 'dash-ntf-markall', type: 'button', text: '모두 읽음' });
      markBtn.onclick = () => { const s = dashNotifReadSet(); feedItems.forEach((it) => s.add(it.key)); dashSaveNotifRead(s); render(); };
      zone.chipsEl.replaceChildren(markBtn);
    } else zone.chipsEl.replaceChildren();
    if (!dueShown.length && !feedItems.length && !revShown) {
      zone.body.replaceChildren(dashEmpty(items.length || due.length || (review && Number(review.total) > 0)
        ? '표시할 알림이 없어요. ⚙에서 유형을 켜 보세요.'
        : '새 알림이 없어요. 내 프로젝트에 활동·댓글·멘션이 생기면 여기 모여요.'));
      return;
    }
    const frag: any[] = [];
    if (dueShown.length) {
      frag.push(el('div', { class: 'dash-ghead', text: '다가오는 마감' }));
      for (const { p, n } of dueShown) frag.push(dashDueRow(p, n as number));
    }
    if (revShown) {
      frag.push(el('div', { class: 'dash-ghead', text: '검토 대기' }));
      frag.push(dashReviewRow(revShown));
    }
    if (feedItems.length) {
      if (dueShown.length || revShown) frag.push(el('div', { class: 'dash-ghead', text: '알림' }));
      for (const it of feedItems) frag.push(notifRow(it, !read.has(it.key)));
    }
    zone.body.replaceChildren(...frag);
  };
  render();
}

// 알림 한 줄 — [유형 타일] [행위자(굵게)+동사 ·시간] / [프로젝트·스니펫] · 안읽음이면 파란 점. 클릭 시 읽음 처리.
function notifRow(it, unread) {
  const time = it.ts ? relTime(it.ts) : '';
  const head = el('span', { class: 'dash-ntf-head' },
    el('b', { class: 'dash-ntf-who', text: it.who + (it.actorPerson ? '님' : '') }),
    el('span', { text: (it.actorPerson ? '이 ' : ' · ') + it.verb }));
  const metaBits = [it.proj, it.snippet].filter(Boolean).join(' · ');
  const main = el('span', { class: 'dash-ntf-main' },
    el('span', { class: 'dash-ntf-line' }, head, el('span', { class: 'dash-ntf-time', text: time })),
    metaBits ? el('span', { class: 'dash-ntf-sub', title: metaBits, text: metaBits }) : null);
  const href = it.kind === 'invite' ? '#/terminal' : '#/projects2/p/' + it.pid;
  const row = el('a', { class: 'dash-ntf' + (unread ? ' unread' : ''), href },
    dashNotifTile(it), main,
    unread ? el('span', { class: 'dash-ntf-udot', title: '안 읽음', 'aria-label': '안 읽음' }) : null);
  row.addEventListener('click', () => { const s = dashNotifReadSet(); s.add(it.key); dashSaveNotifRead(s); });
  return row;
}
// 마감 알림 — 시계 타일(임박=앰버·지남=코럴) + 프로젝트(굵게) + 마감 라벨 + D-뱃지. (마감은 상시 리마인더라 읽음 대상 아님)
function dashDueRow(p, n) {
  const overdue = n < 0;
  const badge = overdue ? '지남' : (n === 0 ? 'D-day' : 'D-' + n);
  return el('a', { class: 'dash-ntf dash-ntf--due', href: '#/projects2/p/' + p.id },
    el('span', { class: 'dash-ntf-tile ' + (overdue ? 't-coral' : 't-amber') }, dashClockIcon()),
    el('span', { class: 'dash-ntf-main' },
      el('span', { class: 'dash-ntf-line' },
        el('b', { class: 'dash-ntf-who', title: p.name, text: p.name }),
        el('span', { class: 'dash-ntf-dbadge' + (overdue ? ' overdue' : ''), text: badge })),
      el('span', { class: 'dash-ntf-sub', text: '마감 ' + dueLabel(n) })));
}
// 검토 대기 알림(#802) — 마감과 같은 상시 리마인더(읽음 대상 아님 — 승인·반려해야 사라진다). 클릭 → 검토 큐.
//  개인화: 내 팀이 오너인 도메인('내 도메인')에 대기 건이 있으면 그 숫자를 앞세운다 — 하루 ~11건이 쌓이면
//  "전부 검토"는 부담이라, 사람이 실제로 판단할 수 있는 자기 도메인이 첫 진입점이다(#783 §9).
function dashReviewRow(r) {
  const total = Number(r.total) || 0, mine = Number(r.mine_total) || 0;
  const primary = mine > 0 ? mine : total;
  const sub = mine > 0
    ? (total > mine ? `전체 ${total}건 중 · 승인해야 검색·주입에 반영돼요` : '승인해야 검색·주입에 반영돼요')
    : `신규 ${Number(r.new) || 0} · 수정 ${Number(r.edit) || 0} · 승인해야 검색·주입에 반영돼요`;
  return el('a', { class: 'dash-ntf dash-ntf--due', href: '#/knowledge/review' },
    el('span', { class: 'dash-ntf-tile t-amber' }, dashReviewIcon()),
    el('span', { class: 'dash-ntf-main' },
      el('span', { class: 'dash-ntf-line' },
        el('b', { class: 'dash-ntf-who', text: `검토 대기 ${primary}건` }),
        el('span', { class: 'dash-ntf-dbadge', text: mine > 0 ? '내 도메인' : '전체' })),
      el('span', { class: 'dash-ntf-sub', text: sub })));
}

// 유형 타일 — 라운드 스퀘어(앱 아이콘 톤) + 유형색 글리프. 피드의 둥근 점과 명확히 구분되는 '알림' 시그니처.
function dashNotifTile(it) {
  const kind = it.kind;
  let cls, glyph;
  if (kind === 'mention') { cls = 't-blue'; glyph = el('span', { class: 'dash-ntf-glyph', text: '@' }); }
  else if (kind === 'comment') { cls = 't-teal'; glyph = dashCommentIcon(); }
  else if (kind === 'invite') { cls = 't-indigo'; glyph = dashSessionIcon(); }
  else if (kind === 'created') { cls = 't-mint'; glyph = el('span', { class: 'dash-ntf-glyph', text: '＋' }); }
  else if (kind === 'act') { cls = 'tn-' + (it.tone || 'mut'); glyph = dashSparkIcon(); }
  else if (it.pref === 'assign') { cls = 't-violet'; glyph = dashPersonIcon(); } // 담당자 변경
  else { cls = 't-slate'; glyph = el('span', { class: 'dash-ntf-glyph', text: '✎' }); } // 상태·이름·필드 변경
  return el('span', { class: 'dash-ntf-tile ' + cls }, glyph);
}

// ── 알림 사용자화 팝업 — 유형 체크박스(그룹별), 기기별 저장, 변경 즉시 재렌더 ──
function openNotifPrefs(anchor, onChange) {
  const prefs = dashNotifPrefs();
  const panel = el('div', { class: 'dash-pop-panel' });
  panel.append(el('div', { class: 'dash-pop-head' },
    el('strong', { text: '표시할 알림' }),
    el('span', { class: 'dash-pop-sub', text: '이 기기에 저장돼요' })));
  for (const g of DASH_NOTIF_GROUPS) {
    panel.append(el('div', { class: 'dash-pop-gh', text: g.title }));
    for (const it of g.items) {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !!prefs[it.key];
      cb.onchange = () => { prefs[it.key] = cb.checked; dashSaveNotifPrefs(prefs); onChange(); };
      panel.append(el('label', { class: 'dash-pop-row' }, cb,
        el('span', { class: 'dash-pop-txt' },
          el('span', { class: 'dash-pop-name', text: it.label }),
          el('span', { class: 'dash-pop-desc', text: it.desc }))));
    }
  }
  dashPopover(anchor, panel);
}
// 필드 변경 이벤트 → 한국어 한 줄.
function eventLabel(f) {
  const lbl = DASH_FIELD_LABEL[f.field] || f.label || f.field || '항목';
  if (f.field === 'status' && f.to) return `상태를 '${f.to}'(으)로 변경`;
  if (f.field === 'name') return '이름을 바꿨어요';
  if (f.field === 'description') return '내용을 수정했어요';
  if (f.field === 'assignee') return '담당자를 바꿨어요';
  if (f.to) return `${lbl} 변경 → ${f.to}`;
  return `${lbl} 변경`;
}
// 마감 알림의 라벨. ⚠ 할 일 위젯의 dashDueLabel 과 **문구가 다르다**(여기 '3일 뒤' / 저기 '3일 남음', '내일' 없음) —
//  같은 계산(dashDueDays)을 쓰되 라벨은 자리마다 그대로 둔다. 합치면 화면 문구가 바뀐다.
function dueLabel(n) { return n < 0 ? Math.abs(n) + '일 지남' : (n === 0 ? '오늘' : n + '일 뒤'); }

export {
  DASH_ACT_VERB,
  DASH_FIELD_LABEL,
  dashDueRow,
  dashNotifTile,
  dashReviewRow,
  dueLabel,
  eventLabel,
  fillNotifications,
  notifRow,
  openNotifPrefs,
};
