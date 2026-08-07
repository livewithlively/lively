// dash/widget-lively-log.ts — ⑧ 내 라이블리 사용 내역(#1570).
//  요구 원문(윤상민): "감사 기록을 쉬운 말로 보여주든 뭐든, 내가 최근에 작업하면서 **라이블리가 어떤 작업을
//   했는지가 로그로 쭉 보이면** 좋겠다." → 이 위젯의 본체는 통계 요약이 아니라 **사건의 나열**이다.
//   (초안은 '근거 지식 top 8 + 숫자' 요약이었고 "내용이 너무 부족하다"고 반려됐다 — 요약은 로그의 머리 한 줄로
//    줄이고, 자리의 대부분을 시간순 로그에 준다.)
//
//  ── 이 위젯이 지키는 것 ──
//   ① **기록이지 주장이 아니다.** "라이블리가 도왔습니다"는 광고고, "「X」를 읽었다 · 12:04"는 감사 기록이다.
//      그래서 문구는 일어난 일만 말하고, 색은 쓰지 않는다(§0.5 채색 예산).
//   ② **쉬운 말.** mcp_call_log 는 툴 이름(knowledge_get)으로 남는데 그건 사람 말이 아니다. 여기서 번역한다.
//   ③ **읽을 수 있게 접는다.** 7일 2,391건을 그대로 쏟으면 로그가 아니라 벽이다 — 같은 대상 연속 호출은 ×N 로 접고,
//      날짜로 끊는다.
//   ④ **빈 화면에는 이유를 준다.** actor 는 '세션을 만든 사람'이 아니라 접속 토큰의 신원이라, 공용 박스에서 도는
//      세션은 그 박스 계정 하나로 몰린다(실측 2026-08-07: 이 게이트웨이 30일 8,519건 전량 단일 actor). 그래서
//      다른 계정으로 보면 텅 빈다 — 그때 '전체' 범위와 "기록이 있는 사람"을 화면이 직접 알려준다.
//  ⚠ 회수(훅 자동주입)는 REST 라 호출 로그에 안 남는다 — 이 로그의 '읽음'은 모델이 본문을 실제로 연 것뿐이다.
//  ⚠ 기간 단위다. mcp_call_log 에 session_id 가 없어 '이 세션에서'로는 못 묶는다(#1578).
import { api, el, errorNote, state } from '../core.js';
import { dashChips, dashCtl, dashChoicePopover } from './chrome.js';

const LVL_WINDOWS: [string, string][] = [['24h', '24시간'], ['7d', '7일'], ['30d', '30일']];
const PAGE = 120;

function n(v: unknown): string { return Number(v || 0).toLocaleString('ko-KR'); }

// ── 툴 → 사람 말 ────────────────────────────────────────────────────────────────────────────
//  자주 흐르는 것부터 명시 매핑(실측 상위 28종을 덮는다). 모르는 툴은 접미사 규칙으로 떨어뜨린다 —
//  새 툴이 생겨도 로그가 'knowledge_frobnicate' 같은 raw 이름을 뱉지 않게.
const VERB: Record<string, string> = {
  knowledge_get: '지식을 읽었어요',
  knowledge_search: '지식을 찾아봤어요',
  knowledge_grep: '지식을 찾아봤어요',
  knowledge_list: '지식 목록을 봤어요',
  knowledge_save: '지식을 남겼어요',
  knowledge_link_category: '지식을 분류에 연결했어요',
  knowledge_set_lifecycle: '지식 상태를 바꿨어요',
  activity_log: '작업 기록을 남겼어요',
  db_query: '조직 DB 를 조회했어요',
  project_get_v6: '프로젝트 맥락을 불러왔어요',
  project_create_v6: '프로젝트를 만들었어요',
  project_update_v6: '프로젝트를 고쳤어요',
  project_set_status_v6: '프로젝트 상태를 바꿨어요',
  project_set_list_v6: '프로젝트를 분류했어요',
  project_set_repos_v6: '프로젝트에 레포를 연결했어요',
  project_link_knowledge_v6: '프로젝트에 지식을 연결했어요',
  project_list_v6: '프로젝트 목록을 봤어요',
  task_create_v6: '할 일을 만들었어요',
  task_update_v6: '할 일을 고쳤어요',
  task_set_status_v6: '할 일 상태를 바꿨어요',
  source_save: '자료를 남겼어요',
  source_list: '자료를 찾아봤어요',
  category_list: '분류 체계를 봤어요',
  category_update: '분류 정의를 고쳤어요',
  preview_env_ensure: '미리보기 환경을 띄웠어요',
  preview_env_set: '미리보기 환경을 설정했어요',
  preview_env_stop: '미리보기 환경을 내렸어요',
  preview_env_list: '미리보기 목록을 봤어요',
  workspace_reclaim: '작업 공간을 정리했어요',
  map_code_unit: '코드 구조를 기록했어요',
  delegate_run: '무거운 작업을 다른 컴퓨터에 맡겼어요',
};
// 접미/접두 규칙 — 명시 매핑에 없는 툴의 폴백. 라이블리 툴은 동사가 이름 끝에 온다(_get·_create·_set_*).
function verbOf(tool: string): string {
  if (VERB[tool]) return VERB[tool];
  if (/_(get|list|search|grep|read|overview)(_v6)?$/.test(tool)) return '맥락을 조회했어요';
  if (/_(create|save|add|new)(_v6)?$/.test(tool)) return '새로 만들었어요';
  if (/_(update|set|edit|patch|link)(_v6)?$/.test(tool) || /_set_/.test(tool)) return '내용을 바꿨어요';
  if (/_(delete|remove|stop|unlink)(_v6)?$/.test(tool)) return '정리했어요';
  return '작업했어요';
}

// 같은 대상을 연달아 부른 사건을 한 줄로 접는다(×N). 접지 않으면 로그가 같은 줄로 도배된다 —
//  실측: knowledge_get 이 같은 런북을 19번 연속 부른 구간이 있었다.
function fold(events: any[]): any[] {
  const out: any[] = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    if (prev && prev.tool === e.tool && prev.label === e.label && prev.ok === e.ok) { prev.count++; continue; }
    out.push({ ...e, count: 1 });
  }
  return out;
}

const dayKey = (iso: string) => { const d = new Date(iso); return d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' }); };
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

async function fillLivelyLog(zone) {
  let win = '7d';
  let scope = 'me';
  let shown = PAGE;

  const people = await api('/api/ui/dash/people').then((d: any) => (d && d.people) || []).catch(() => []);
  const meId = (state.me && (state.me.userId || state.me.email)) || '';
  const nameOf = (pid: string) => {
    if (!pid) return '';
    const m = people.find((x: any) => x.author_person === pid);
    return (m && (m.nickname || m.display_name)) || pid;
  };

  const draw = async () => {
    let d: any;
    try { d = await api(`/api/ui/me/lively-log?window=${encodeURIComponent(win)}&scope=${scope}&limit=${shown}`); }
    catch (e) { zone.body.replaceChildren(errorNote(e, '사용 내역을 불러오지 못했습니다')); return; }

    const s = d.summary || {};
    const events = d.events || [];
    const total = Number(d.event_total || 0);
    zone.countEl.textContent = n(total);
    dashChips(zone.chipsEl, LVL_WINDOWS, win, (k) => { win = k; shown = PAGE; draw(); });

    const box = el('div', { class: 'dash-lvl' });

    // ── 머리 한 줄 — 이 기간을 한 문장으로. 로그가 본체이므로 요약은 여기서 끝낸다. ──
    const lead: string[] = [];
    if (s.knowledge_reads) lead.push(`조직 지식 ${n(s.knowledge_titles)}건을 근거로 썼어요`);
    if (s.knowledge_saved) lead.push(`지식 ${n(s.knowledge_saved)}건을 남겼어요`);
    if (d.dbAccess && d.dbAccess.length) lead.push(`조직 DB 를 ${n(d.dbAccess.reduce((a: number, r: any) => a + Number(r.queries || 0), 0))}번 봤어요`);
    if (lead.length) box.append(el('div', { class: 'dash-lvl-lead', text: lead.join(' · ') }));

    // ── 범위 전환 — '내 것만'이 기본. 공용 박스 조직에선 이게 비므로 '전체'로 넘어갈 길을 항상 준다. ──
    box.append(el('div', { class: 'dash-lvl-scope' },
      ...([['me', '내 작업'], ['all', '팀 전체']] as [string, string][]).map(([k, label]) => {
        const b = el('button', { class: 'dash-chip' + (k === scope ? ' on' : ''), type: 'button', text: label });
        b.onclick = () => { if (k !== scope) { scope = k; shown = PAGE; draw(); } };
        return b;
      })));

    if (!events.length) {
      // 빈 화면에 이유를 준다 — 기록이 있는 사람을 알려주면 "왜 내 화면만 비지"가 풀린다.
      const others = (d.actors || []).filter((a: any) => a.actor !== meId);
      const why = others.length
        ? `이 계정(${nameOf(meId) || meId})으로 남은 기록이 없어요. 이 기간 기록은 ${others.map((a: any) => `${nameOf(a.actor)} ${n(a.calls)}건`).join(' · ')} 입니다 — AI 세션은 그 세션이 도는 계정으로 기록돼요. [팀 전체]로 보세요.`
        : '이 기간에는 라이블리가 관여한 기록이 없어요.';
      box.append(el('div', { class: 'dash-lvl-why', text: why }));
      zone.body.replaceChildren(box);
      return;
    }

    // ── ★ 본체: 시간순 로그 ── 날짜로 끊고, 같은 대상 연속 호출은 접는다.
    let lastDay = '';
    for (const e of fold(events)) {
      const day = dayKey(e.at);
      if (day !== lastDay) { lastDay = day; box.append(el('div', { class: 'dash-task-gh' }, el('span', { text: day }))); }
      const who = scope === 'all' && e.actor && e.actor !== meId ? nameOf(e.actor) : '';
      const main = el('span', { class: 'dash-lvl-main' },
        el('span', { class: 'dash-lvl-verb' + (e.ok ? '' : ' fail'), text: verbOf(e.tool) }),
        e.label ? el('span', { class: 'dash-lvl-title', text: e.label }) : null,
        e.count > 1 ? el('span', { class: 'dash-lvl-x', text: '×' + e.count }) : null,
        who ? el('span', { class: 'dash-lvl-by', text: who }) : null);
      box.append(el('div', { class: 'dash-row dash-lvl-row', title: `${e.tool}${e.harness ? ' · ' + e.harness : ''}` },
        main, el('span', { class: 'dash-lvl-when', text: hhmm(e.at) })));
    }

    // ── 세션 밖 — 내가 없는 동안 돈 것. 사람 축이 아니라 조직 축이라 로그와 분리해 꼬리에 둔다. ──
    const bg = d.background;
    if (bg) {
      const bgAll: [string, number][] = [
        ['자료를 새로 수집했어요', Number(bg.sources_ingested || 0)],
        ['자료를 지식으로 증류했어요', Number(bg.distilled || 0)],
        ['새 지식을 자동 분류했어요', Number(bg.classified || 0)],
      ];
      const bgLines = bgAll.filter((row) => row[1] > 0);
      if (bgLines.length) {
        box.append(el('div', { class: 'dash-task-gh' }, el('span', { text: '내가 없는 동안 (자동)' })));
        for (const [label, v] of bgLines) {
          box.append(el('div', { class: 'dash-row dash-lvl-row' },
            el('span', { class: 'dash-lvl-main' }, el('span', { class: 'dash-lvl-verb', text: label })),
            el('span', { class: 'dash-lvl-when', text: `${n(v)}건` })));
        }
      }
    }

    if (events.length < total) {
      const more = el('button', { class: 'dash-lvl-more', type: 'button', text: `더 보기 (${n(total - events.length)}건 남음)` });
      more.onclick = () => { shown += PAGE; draw(); };
      box.append(more);
    } else if (d.retention_days) {
      box.append(el('div', { class: 'dash-lvl-foot', text: `호출 기록은 ${d.retention_days}일간 보관돼요` }));
    }

    zone.body.replaceChildren(box);
  };

  dashCtl(zone, {
    gear: { title: '사용 내역 설정', open: (a) => dashChoicePopover(a, '기본 범위', [['me', '내 작업'], ['all', '팀 전체']], scope, (k) => { scope = k; shown = PAGE; draw(); }) },
    action: { href: '#/knowledge', title: '지식 탭으로' },
  });
  await draw();
}

export { fillLivelyLog };
