// context-map.ts — [맥락 관리] 표지 = 흐름 지도(#762 v5 프로토타입, 2026-08-31 원준 확정).
//
//  원준 결정의 골자 셋:
//   ① **표지는 지도다** — 수집기 → 자료 → [증류기] → 지식 → [전달] → AI 세션. 역·게이트가 전부 눌리고,
//     상단 섹션 탭과 1:1 이라 지도가 곧 목차다. 막힌 곳(붉음)이 지도에서 바로 보인다.
//   ② **역마다 실물 미니어처** — 아이콘·비유 그림이 아니라 그 화면에 실제로 있는 것의 축소판을 담는다:
//     수집기 행 · 최근 지식 카드(승인 배지 포함). "예시가 개념 학습을 대신한다."
//   ③ **사람 몫은 「확인할 것」 하나** — 승인 대기·갈래 제안·점검 발견이 트레이 하나로 모인다(아래 renderContextInbox).
//
//  판정 잣대는 새로 만들지 않는다 — context-pipeline 의 *Health 한 벌(stageHealthLevels)을 그대로 쓴다(#1841 규율).
//  데이터도 새 API 없이 조립한다: /org/pipeline(수치·잡) + /org/collectors(수집기 행) + /knowledge(최근 지식).
//  뒤 둘은 **장식**이라 실패해도 지도는 선다(try/catch — 수치만으로도 그림이 된다).
import { api, el, fmtNum, relTime } from './core.js';
import { skeleton } from './ui-primitives.js';
import { stageHealthLevels } from './context-pipeline.js';
import { renderFindings } from './context-manage.js';

const fmt = (n: any) => (Number.isFinite(Number(n)) ? fmtNum(Number(n)) : '—');

/** 수집기 종류 → 한 글자 표식. 브랜드 로고를 흉내내지 않는다 — 글자 하나가 목록에서 종류를 가른다. */
function kindMark(kind: string): string {
  const k = String(kind || '').toLowerCase();
  if (k.includes('slack')) return '#';
  if (k.includes('notion')) return 'N';
  if (k.includes('github') || k.includes('gitlab') || k.includes('git')) return 'G';
  if (k.includes('google') || k.includes('gmail') || k.includes('drive')) return 'G';
  if (k.includes('local') || k.includes('file')) return '▤';
  if (k.includes('figma')) return 'F';
  if (k.includes('clickup')) return 'C';
  if (k.includes('linear')) return 'L';
  if (k.includes('http') || k.includes('rss')) return '⌁';
  return (k[0] || '?').toUpperCase();
}

// ── 표지: 흐름 지도 ─────────────────────────────────────────────────────────
export async function renderContextMap(box: HTMLElement): Promise<void> {
  box.replaceChildren(skeleton('맥락 현황을 읽는 중'));
  let d: any = null;
  try { d = await api('/api/ui/org/pipeline'); } catch (e) {
    box.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '현황을 불러오지 못했습니다 — ' + (e as Error).message })));
    return;
  }
  // 장식 데이터(실물 미니어처) — 실패해도 지도는 선다.
  const [colD, knowD] = await Promise.all([
    api('/api/ui/org/collectors').catch(() => null),
    api('/api/ui/knowledge?' + new URLSearchParams({ limit: '3', orderBy: 'updated_at', light: '1', lifecycle: 'active,pending', injection: 'recalled' })).catch(() => null),
  ]);
  const st = (d && d.stages) || {};
  const gates = (d && d.gates) || {};
  const lv = stageHealthLevels(d);
  const collectors: any[] = ((colD && colD.collectors) || []).filter((c: any) => c.enabled).slice(0, 3);
  const recent: any[] = ((knowD && knowD.entries) || []).slice(0, 2);

  const backlog = Number(st.distill?.backlog || 0);
  const pending = Number(gates.knowledge_pending || 0);
  const proposed = Number(gates.classification_proposed || 0);
  const findings = Number(st.manage?.open?.total || 0);
  const inboxN = pending + proposed + findings;

  // ── 역 넷 ──
  const stSources = el('a', { class: 'cxm-st is-' + lv.collect, href: '#/context/sources' },
    el('span', { class: 'cxm-st-t' }, el('b', { text: '수집기' }),
      el('span', { class: 'pill' + (Number(st.collect?.enabled) ? ' pill-ok' : ''), text: fmt(st.collect?.enabled) + '/' + fmt(st.collect?.configured) + ' 켜짐' })),
    el('span', { class: 'cxm-st-def', text: '외부에서 자료를 가져오는 연결' }),
    el('div', { class: 'cxm-stack' },
      ...(collectors.length
        ? collectors.map((c: any) => el('span', { class: 'cxm-mrow' },
            el('i', { class: 'cxm-sic', 'aria-hidden': 'true', text: kindMark(c.kind) }),
            el('span', { class: 'cxm-mrow-tx', text: c.label || c.key || c.kind }),
            c.last_run ? el('span', { class: 'cxm-mrow-w', text: relTime(c.last_run.started_at) }) : null))
        : [el('span', { class: 'cxm-mrow cxm-mrow-empty', text: '연결된 곳이 없습니다 — 눌러서 연결' })])),
    el('span', { class: 'cxm-st-more', text: (st.collect?.recent_24h ? '오늘 +' + fmt(st.collect.recent_24h) : '오늘 새 자료 없음') }));

  const stRaw = el('a', { class: 'cxm-st', href: '#/context/sources' },
    el('span', { class: 'cxm-st-t' }, el('b', { text: '자료' }), el('b', { class: 'cxm-st-n num', text: fmt(st.collect?.output) })),
    el('span', { class: 'cxm-st-def', text: '가져온 원문 그대로 — AI 는 자료를 직접 쓰지 않습니다' }),
    el('div', { class: 'cxm-paperz', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')),
    el('span', { class: 'cxm-st-more', text: backlog ? '증류 대기 ' + fmt(backlog) + '건' : '밀린 자료 없음' }));

  const stKnow = el('a', { class: 'cxm-st is-' + lv.distill + (backlog > 1000 ? ' cxm-jam' : ''), href: '#/context/category' },
    el('span', { class: 'cxm-st-t' }, el('b', { text: '지식' }), el('b', { class: 'cxm-st-n num', text: fmt(st.distill?.output) }),
      backlog > 1000 ? el('span', { class: 'pill pill-warn', text: '대기 ' + fmt(backlog) + ' — 병목' }) : null),
    el('span', { class: 'cxm-st-def', text: '증류를 통과해 남은 것 — 카테고리 ' + fmt(st.classify?.categories) + '칸에 정리' }),
    el('div', { class: 'cxm-stack' },
      ...(recent.length
        ? recent.map((k: any) => el('span', { class: 'cxm-know' },
            el('b', { class: 'cxm-know-t', text: k.title || k.name }),
            el('span', { class: 'cxm-know-s' },
              k.lifecycle === 'pending' ? el('span', { class: 'pill pill-warn', text: '승인 대기' }) : el('span', { class: 'pill', text: relTime(k.updated_at) }))))
        : [el('span', { class: 'cxm-mrow cxm-mrow-empty', text: '아직 지식이 없습니다' })])),
    el('span', { class: 'cxm-st-more', text: '관리기 ' + fmt(st.manage?.configured) + ' · 발견 ' + fmt(findings) + (st.classify?.backlog ? ' · 카테고리 없음 ' + fmt(st.classify.backlog) : '') }));

  const stAI = el('a', { class: 'cxm-st', href: '#/context/deliver' },
    el('span', { class: 'cxm-st-t' }, el('b', { text: 'AI 세션' })),
    el('span', { class: 'cxm-st-def', text: '시작할 때 읽고 · 대화 중 검색해 씁니다' }),
    el('div', { class: 'cxm-sess', 'aria-hidden': 'true' },
      el('span', { class: 'cxm-sess-u', text: '지난 미팅 정리해줘' }),
      el('span', { class: 'cxm-sess-a' }, el('span', { text: '팀이 쌓은 지식으로 답합니다 ' }),
        el('i', { class: 'cxm-sess-ref', text: '지식 참조' }))),
    el('span', { class: 'cxm-st-more', text: '검색 대상 지식 ' + fmt(Math.max(0, Number(st.distill?.output || 0) - Number(st.classify?.backlog || 0))) + '건' }));

  // ── 관(연결선) + 게이트 ──
  const duct = (gate?: HTMLElement | null, leak?: HTMLElement | null) =>
    el('div', { class: 'cxm-duct' }, el('span', { class: 'cxm-wire', 'aria-hidden': 'true' }), gate || null, leak || null);
  const gateDistill = el('a', { class: 'cxm-gate', href: '#/context/distill' },
    el('b', { text: '증류기 ' + fmt(st.distill?.configured) }),
    el('span', { class: 'cxm-gate-s' }, el('span', { text: '켜짐 ' + fmt(st.distill?.enabled) }),
      pending ? el('span', { class: 'cxm-gate-warn', text: ' · 승인 ' + fmt(pending) + ' 대기' }) : null));
  const gateDeliver = el('a', { class: 'cxm-gate', href: '#/context/deliver' },
    el('b', { text: '전달' }), el('span', { class: 'cxm-gate-s', text: '세션 주입 · 검색' }));

  const lane = el('div', { class: 'cxm-lane' },
    stSources, duct(), stRaw, duct(gateDistill, blindspotPill()), stKnow, duct(gateDeliver), stAI);

  // ── 지도 아래 두 줄 — 확인할 것 요약 + 자동 실행 ──
  const inboxLine = el('a', { class: 'cxm-line cxm-line-inbox', href: '#/context/inbox' },
    el('b', { text: '확인할 것 ' + fmt(inboxN) + '건' }),
    el('span', { class: 'cxm-line-s', text: ' — 승인 ' + fmt(pending) + ' · 카테고리 제안 ' + fmt(proposed) + ' · 점검 발견 ' + fmt(findings) }),
    el('span', { class: 'btn btn-sm ' + (pending ? 'btn-primary' : 'btn-ghost'), text: '확인하러 가기' }));
  const jobs = el('div', { class: 'cxm-line cxh-jobs' }, el('span', { class: 'cxh-jobs-t', text: '자동 실행' }),
    jobChip('수집', st.collect?.job), jobChip('증류', st.distill?.job), jobChip('분류', st.classify?.job), jobChip('점검', st.manage?.job));

  box.replaceChildren(el('div', { class: 'cxm' },
    el('p', { class: 'cxm-cap', text: '자료가 지식이 되어 AI 에 닿기까지 — 역이든 게이트든 누르면 그 화면이 열립니다' }),
    lane, inboxLine, jobs));

  // 사각지대 알약은 renderContextMapScreen 이 미리 준비해 둔 blindEl 을 그대로 쓴다.
  function blindspotPill(): HTMLElement | null { return blindEl; }
}

let blindEl: HTMLElement | null = null;
// 사각지대 알약 — renderContextMap 이 그리기 전에 미리 준비한다(호출마다 새로).
async function prepareBlindspot(): Promise<void> {
  blindEl = null;
  try {
    const r: any = await api('/api/ui/org/distillers');
    const n = Number(r?.coverage?.uncovered || 0);
    if (n > 0) blindEl = el('a', { class: 'cxm-leak', href: '#/context/distill', title: '어느 증류기에도 안 걸리는 자료 — 이대로 두면 영영 지식이 되지 않습니다' },
      el('span', { text: '↓ 사각지대 ' + fmtNum(n) }));
  } catch { blindEl = null; }
}
// renderContextMap 을 감싸 사각지대를 먼저 준비한다 — 셸은 이 이름 하나만 부른다.
export async function renderContextMapScreen(box: HTMLElement): Promise<void> {
  await prepareBlindspot();
  await renderContextMap(box);
}

// 자동 실행 칩 — context-home(#1841)의 것을 그대로 승계(그 파일은 이 화면으로 대체됐다).
function jobChip(label: string, job: any): HTMLElement {
  const state = !job ? 'off' : (!job.any_enabled ? 'off' : 'on');
  const txt = !job ? '미등록' : (!job.any_enabled ? '꺼짐' : intervalText(job.interval_sec) + (job.last_run_at ? ' · ' + relTime(job.last_run_at) : ' · 미실행'));
  return el('span', { class: 'cxh-job is-' + state },
    el('i', { class: 'cxh-job-dot', 'aria-hidden': 'true' }), el('b', { text: label }), el('span', { text: txt }));
}
function intervalText(sec: any): string {
  const n = Number(sec) || 0;
  if (!n) return '';
  if (n % 3600 === 0) return n / 3600 + '시간마다';
  if (n % 60 === 0) return n / 60 + '분마다';
  return n + '초마다';
}

// ── 확인할 것 — 사람 손이 필요한 것 전부, 큐 하나 ─────────────────────────────
//  종전엔 세 곳이었다: 지식 검토(#/knowledge/review) · 카테고리 제안(#/knowledge/classifications) ·
//  점검 발견(점검 ▸ 확인할 것). 처리 화면 자체는 그대로 두고(저장 경로 불변, #837), **입구를 하나로** 모은다.
export async function renderContextInbox(box: HTMLElement): Promise<void> {
  box.replaceChildren(skeleton('확인할 것을 세는 중'));
  let d: any = null;
  try { d = await api('/api/ui/org/pipeline'); } catch { d = null; }
  const gates = (d && d.gates) || {};
  const pending = Number(gates.knowledge_pending || 0);
  const proposed = Number(gates.classification_proposed || 0);

  const card = (level: 'warn' | 'note', title: string, line: string, href: string, goLabel: string) =>
    el('div', { class: 'cxh-todo is-' + level },
      el('div', { class: 'cxh-todo-body' }, el('b', { class: 'cxh-todo-t', text: title }), el('p', { class: 'cxh-todo-l', text: line })),
      el('a', { class: 'btn btn-sm ' + (level === 'warn' ? 'btn-primary' : 'btn-ghost'), href, text: goLabel }));

  const tops: HTMLElement[] = [];
  if (pending) tops.push(card('warn', '증류기가 만든 지식 ' + fmtNum(pending) + '건 — 승인 대기',
    'AI 가 쓴 지식이 승인 전이라 검색·세션 전달에서 빠져 있습니다. 승인해야 팀 전체 AI 가 씁니다.', '#/knowledge/review', '승인하기'));
  if (proposed) tops.push(card('note', '카테고리 제안 ' + fmtNum(proposed) + '건',
    'AI 가 카테고리를 제안했지만 확신이 낮아 사람 확인을 기다립니다.', '#/knowledge/classifications', '확인하기'));
  if (!tops.length) tops.push(el('div', { class: 'cxh-allok' },
    el('b', { text: '승인·제안 대기가 없습니다' }), el('span', { text: '아래 점검 발견만 남았습니다.' })));

  const findingsHost = el('div', {});
  box.replaceChildren(el('div', { class: 'cxm-inbox' },
    el('div', { class: 'cxh-todos' }, ...tops),
    el('h2', { class: 'cxh-h', text: '점검이 찾아낸 것' }),
    findingsHost));
  try { await renderFindings(findingsHost); }
  catch (e) { findingsHost.replaceChildren(el('p', { class: 'admin-hint', text: '발견을 불러오지 못했습니다 — ' + (e as Error).message })); }
}

/** 상단 트레이 배지 수 — 셸(context.ts)이 탭 줄 오른쪽 트레이에 붙인다. */
export function inboxCount(d: any): number {
  const st = (d && d.stages) || {}; const g = (d && d.gates) || {};
  return Number(g.knowledge_pending || 0) + Number(g.classification_proposed || 0) + Number(st.manage?.open?.total || 0);
}

