// context-map.ts — [맥락 관리] 표지 = 흐름 지도(#762 v5 프로토타입 → #3830 고도화, 2026-09-09 원준 확정 안 1).
//
//  원준 결정의 골자 셋(#762)은 그대로다:
//   ① **표지는 지도다** — 역·기계가 전부 눌리고 상단 탭과 1:1 이라 지도가 곧 목차다.
//   ② **역마다 실물 미니어처** — 아이콘·비유 그림이 아니라 그 화면에 실제로 있는 것의 축소판.
//   ③ **사람 몫은 「확인할 것」 하나**(아래 renderContextInbox).
//
//  #3830 에서 바뀐 것 — 원준: "순서가 [외부앱] -수집기-> [자료] -증류기-> [지식] -주입규칙-> [AI 세션] 이거라는게
//   잘 드러나게 고도화 … 사이즈감·덩어리감·진행되는 느낌은 좋은데 산만하다 … 슬랙이랑 노션 아이콘은 어디 갔어".
//   · **장소 넷과 기계 셋을 재질로 가른다** — 장소(외부 앱·자료·지식·AI 세션)는 흰 카드, 기계(수집기·증류기·주입규칙)는
//     선로 위 어두운 칩(--chip-dark). 종전엔 수집기가 역(장소)이어서 사용자 모델과 어긋났다.
//   · **역마다 유리 앱 아이콘 문패** — 런치패드·홈과 같은 그림(appGlassIcon)이라 "이 역이 곧 그 앱"으로 읽힌다.
//   · **외부 앱의 실물은 공식 서비스 로고**(svc-icons svcTile) — 글자 한 자(#·N·G)로 흉내내지 않는다.
//   · **자료의 실물은 출처별 원문 수**(자료 앱 나무와 같은 숫자) — 종이 더미 그림은 장식이었다.
//   · **선로는 기계가 도는 구간만 흐른다**(CSS 파선 이동) — 진행감이 사실에만 붙는다. 꺼진 구간은 멎어 있다.
//   · 상태는 테두리 색이 아니라 **말 배지**(꺼짐 · 승인 n 대기 · 켜짐)로만.
//  판정 잣대는 새로 만들지 않는다 — context-pipeline 의 *Health 한 벌(stageHealthLevels)을 그대로 쓴다(#1841 규율).
//  데이터도 새 API 없이 조립한다: /org/pipeline(수치·잡) + /org/collectors + /sources/tree + /knowledge + /org/sections
//   + /terminal/sessions. 뒤 다섯은 **장식**이라 실패해도 지도는 선다(try/catch — 수치만으로도 그림이 된다).
import { api, el, fmtNum, relTime } from './core.js';
import { skeleton } from './ui-primitives.js';
import { stageHealthLevels } from './context-pipeline.js';
import { renderFindings } from './context-manage.js';
import { presetSvcKey, svcTile } from './svc-icons.js';
import { svcLogo } from './svc-logos.js';
import { appGlassIcon } from './v2/glass-icon.js';   // 리프 모듈(#3830) — 셸 레지스트리를 물지 않는다
import { icon as lineIcon } from './v2/icons.js';

const fmt = (n: any) => (Number.isFinite(Number(n)) ? fmtNum(Number(n)) : '—');

/** 서비스 키 → 사람 말. 로고가 그림을 맡으므로 이름은 발치·툴팁에만 쓴다. */
const SVC_LABEL: Record<string, string> = {
  slack: '슬랙', notion: '노션', github: '깃허브', gitlab: '깃랩', 'google-drive': '드라이브', 'google-gmail': 'Gmail', 'google-calendar': '캘린더',
  google: '구글', figma: '피그마', linear: '리니어', clickup: '클릭업', discord: '디스코드', prometheus: '프로메테우스', 'claude-headless': 'Claude',
};
const svcLabel = (key: string, fallback?: string) => SVC_LABEL[key] || fallback || key;

/** 자료 출처(system) → 이름 · 로고 키 · (로고가 없을 때) 선 글리프.
 *  ⚠ 로고 없는 출처에 **이름 첫 글자**를 타일로 쓰지 않는다 — 실측에서 「디 디스코드 · 회의」처럼 같은 글자가
 *   두 번 읽혔다. 브랜드가 아니라 **종류**를 말하는 자리이므로 우리 선 글리프로 떨어진다(대화·문서·파일). */
function sourceFace(system: string, container: string | null): { label: string; svc: string | null; glyph: string } {
  const s = String(system || '').toLowerCase();
  if (s === 'authored') return { label: container === 'transcript' ? '회의 전사록' : '직접 적은 것', svc: null, glyph: 'doc' };
  if (s === 'local' || s === 'local_file' || s === 'file') return { label: '올린 파일', svc: null, glyph: 'src' };
  const svc = presetSvcKey(s);
  const short = container ? String(container).split('/').pop() || '' : '';
  const name = svcLabel(svc, s.replace(/[_-]/g, ' '));
  const chatty = ['discord', 'slack', 'teams', 'telegram'].includes(s);
  return { label: short && short !== name ? name + ' · ' + short : name, svc: svcLogo(svc) ? svc : null, glyph: chatty ? 'chat' : 'doc' };
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
  const [colD, treeD, knowD, secD, sessD] = await Promise.all([
    api('/api/ui/org/collectors').catch(() => null),
    api('/api/ui/sources/tree').catch(() => null),
    api('/api/ui/knowledge?' + new URLSearchParams({ limit: '3', orderBy: 'updated_at', light: '1', lifecycle: 'active,pending', injection: 'recalled' })).catch(() => null),
    api('/api/ui/org/sections').catch(() => null),
    api('/api/ui/terminal/sessions?includeProjects=1').catch(() => null),
  ]);
  const st = (d && d.stages) || {};
  const gates = (d && d.gates) || {};
  const lv = stageHealthLevels(d);

  const backlog = Number(st.distill?.backlog || 0);
  const pending = Number(gates.knowledge_pending || 0);
  const proposed = Number(gates.classification_proposed || 0);
  const findings = Number(st.manage?.open?.total || 0);
  const inboxN = pending + proposed + findings;

  // 외부 앱 — 수집기가 연결된 서비스 종류(preset_key). 켜짐 여부는 기계(수집기)가 말하므로 여기선 로고가 제 색으로 선다.
  const collectors: any[] = (colD && colD.collectors) || [];
  const bySvc = new Map<string, { n: number; label: string }>();
  for (const c of collectors) {
    const raw = String(c.preset_key || c.key || '').toLowerCase();
    if (!raw) continue;
    const svc = presetSvcKey(raw);
    const cur = bySvc.get(svc) || { n: 0, label: svcLabel(svc, String(c.preset_label || raw)) };
    cur.n += 1; bySvc.set(svc, cur);
  }
  const svcs = Array.from(bySvc.entries()).sort((a, b) => b[1].n - a[1].n);

  // 자료 — 출처별 원문 수(자료 앱의 나무와 같은 숫자). system 단위로 합쳐 큰 것 넷.
  const nodes: any[] = (treeD && treeD.nodes) || [];
  const bySys = new Map<string, { n: number; container: string | null }>();
  for (const nd of nodes) {
    const key = String(nd.system || 'authored');
    const cur = bySys.get(key) || { n: 0, container: nd.container ?? null };
    cur.n += Number(nd.n || 0);
    if (cur.container !== (nd.container ?? null)) cur.container = null;   // 컨테이너가 여럿이면 이름만
    bySys.set(key, cur);
  }
  const topSys = Array.from(bySys.entries()).sort((a, b) => b[1].n - a[1].n).slice(0, 4);

  const recent: any[] = ((knowD && knowD.entries) || []).slice(0, 3);
  const startDocs = secD && secD.sections ? Object.keys(secD.sections).length : null;
  const sessions: any[] = (sessD && sessD.sessions) || [];
  const busy = sessions.filter((s) => s && (s.agentState === 'busy' || s.agentState === 'waiting')).length;
  const searchable = Math.max(0, Number(st.distill?.output || 0) - Number(st.classify?.backlog || 0));

  // ── 역 넷(장소 = 흰 카드) — 같은 해부 4칸: 문패(유리 아이콘 · 이름 · 수) / 정의 / 실물 / 발치 ──
  //  #3830(2026-09-10 원준): 장소 카드는 **그 장소로** 간다 — 외부 앱→[외부 앱 연결] · 자료→[자료] 앱 · 지식→레일 [위키] ·
  //   AI 세션→레일 [AI 세션]. 이 화면은 새 셸의 액자(iframe) 안에서 살므로 셸에 한 줄 올려 보낸다(goShell). 기계 셋은 이 앱 안의 탭.
  const station = (o: { href: string; go?: ShellDest; icon: string; name: string; v: string; unit: string; def: string; x: HTMLElement; foot: string; lv?: string }) =>
    el('a', { class: 'cxm-st' + (o.lv ? ' is-' + o.lv : ''), href: o.href,
      ...(o.go ? { onclick: (ev: MouseEvent) => { ev.preventDefault(); goShell(o.go!); } } : {}) },
      el('span', { class: 'cxm-st-h' },
        appGlassIcon(o.icon, 'cxm-st-gi'),
        el('b', { class: 'cxm-st-t', text: o.name }),
        el('b', { class: 'cxm-st-n num' }, el('span', { text: o.v }), el('small', { text: o.unit }))),
      el('span', { class: 'cxm-st-def', text: o.def }),
      el('span', { class: 'cxm-st-x' }, o.x),
      el('span', { class: 'cxm-st-more', text: o.foot }));

  const extX = el('span', { class: 'cxm-svts' },
    ...(svcs.length
      ? svcs.slice(0, 6).map(([svc, v]) => { const t = svcTile(svc, v.label, true); t.title = v.label + (v.n > 1 ? ' · 수집기 ' + v.n : ''); return t; })
      : [el('span', { class: 'cxm-empty', text: '연결된 앱이 없습니다 — 눌러서 연결' })]));
  const extFoot = collectors.length
    ? '수집 연결 ' + fmt(collectors.length) + '개' + svcs.filter(([, v]) => v.n > 1).slice(0, 2).map(([, v]) => ' · ' + v.label + ' ' + v.n).join('')
    : '외부 서비스를 연결하면 그 내용이 자료로 들어옵니다';
  const stExt = station({ href: '#/connect', go: { route: '#/connect' }, icon: 'apps', name: '외부 앱', v: fmt(svcs.length), unit: '종', def: '슬랙·노션·깃허브처럼 자료가 생기는 곳입니다', x: extX, foot: extFoot, lv: lv.collect });

  const rawX = el('span', { class: 'cxm-srcs' },
    ...(topSys.length
      ? topSys.map(([sys, v]) => {
          const f = sourceFace(sys, v.container);
          //  data-svc — 다크에서 단색-검정 마크(GitHub·Linear)를 밝은 잉크로 되칠하는 CSS 훅(#2247). 이걸 빼면
          //   다크에서 깃허브 마크가 **검은 사각**으로 남는다(실측).
          const mk = f.svc
            ? el('i', { class: 'cxm-src-mk cxm-src-mk--logo', 'data-svc': f.svc }, svcLogo(f.svc)!)
            : el('i', { class: 'cxm-src-mk' }, lineIcon(f.glyph, 'cxm-src-gl'));
          return el('span', { class: 'cxm-src-row', title: f.label + ' ' + fmt(v.n) + '건' }, mk, el('span', { class: 'cxm-src-t', text: f.label }), el('b', { class: 'num', text: fmt(v.n) }));
        })
      : [el('span', { class: 'cxm-empty', text: '아직 들어온 자료가 없습니다' })]));
  const stRaw = station({ href: '#/sources', go: { route: '#/sources' }, icon: 'src', name: '자료', v: fmt(st.collect?.output), unit: '건', def: '가져온 원문 그대로 둡니다. AI 는 자료를 직접 쓰지 않습니다', x: rawX,
    foot: (st.collect?.recent_24h ? '오늘 +' + fmt(st.collect.recent_24h) : '오늘 새 자료 없음') + (backlog ? ' · 증류 대기 ' + fmt(backlog) + '건' : ' · 밀린 자료 없음') });

  const knowX = el('span', { class: 'cxm-kns' },
    ...(recent.length
      ? recent.map((k: any) => el('span', { class: 'cxm-kn-row', title: k.title || k.name },
          el('b', { class: 'cxm-kn-t', text: k.title || k.name }),
          k.lifecycle === 'pending' ? el('span', { class: 'pill pill-warn', text: '승인 대기' }) : el('span', { class: 'cxm-kn-m', text: relTime(k.updated_at) })))
      : [el('span', { class: 'cxm-empty', text: '아직 지식이 없습니다' })]));
  const classifyEvery = st.classify?.job?.any_enabled ? '자동 분류 ' + intervalText(st.classify.job.interval_sec) : '자동 분류 꺼짐';
  const stKnow = station({ href: '#/knowledge', go: { section: 'wiki', route: '#/knowledge' }, icon: 'wiki', name: '지식', v: fmt(st.distill?.output), unit: '건',
    def: '증류를 통과해 남은 것입니다. 카테고리 ' + fmt(st.classify?.categories) + '칸에 정리됩니다', x: knowX,
    foot: classifyEvery + ' · 점검 발견 ' + fmt(findings), lv: lv.distill });

  const aiX = el('span', { class: 'cxm-sess' },
    el('span', { class: 'cxm-sess-u', text: '지난 미팅 정리해줘' }),
    el('span', { class: 'cxm-sess-row' },
      el('i', { class: 'cxm-sess-ai', 'aria-hidden': 'true' }, svcLogo('claude-headless') || el('span', { text: 'AI' })),
      el('span', { class: 'cxm-sess-a' }, el('span', { text: '팀이 쌓은 지식으로 답합니다 ' }), el('i', { class: 'cxm-sess-ref', text: '지식 참조' }))));
  const stAI = station({ href: '#/terminal', go: { section: 'sess', route: '#/terminal' }, icon: 'chat', name: 'AI 세션', v: sessD ? fmt(busy) : '—', unit: '작업 중', def: '시작할 때 읽고, 대화 중에 검색해 씁니다', x: aiX,
    foot: '검색 대상 ' + fmt(searchable) + '건' + (startDocs !== null ? ' · 항상 읽는 것 ' + fmt(startDocs) : '') });

  // ── 기계 셋(선로 위 어두운 칩) — 이름 · 수 · 상태 배지 · 살아 있는 점 + 주기 ──
  const machine = (o: { href: string; name: string; s: string; pill: string; k: 'ok' | 'warn' | 'dn'; live: boolean; sched: string; extra?: HTMLElement | null }) =>
    el('a', { class: 'cxm-mc', href: o.href },
      el('span', { class: 'cxm-mc-n' }, lineIcon('gear', 'cxm-mc-ic'), el('span', { text: o.name })),
      el('span', { class: 'cxm-mc-s', text: o.s }),
      el('span', { class: 'cxm-mc-p is-' + o.k, text: o.pill }),
      el('span', { class: 'cxm-mc-e' }, el('i', { class: 'cxm-dot' + (o.live ? ' is-live' : ' is-off'), 'aria-hidden': 'true' }), el('span', { text: o.sched })),
      o.extra || null);
  const jobLine = (job: any) => !job ? '자동 실행 없음' : (!job.any_enabled ? '자동 실행 꺼짐' : intervalText(job.interval_sec) + (job.last_run_at ? ' · ' + relTime(job.last_run_at) : ' · 미실행'));
  const collectOn = Number(st.collect?.enabled || 0) > 0 && !!st.collect?.job?.any_enabled;
  const mcCollect = machine({ href: '#/context/sources', name: '수집기', s: fmt(st.collect?.configured) + ' · 켜짐 ' + fmt(st.collect?.enabled),
    pill: collectOn ? '켜짐' : '꺼짐', k: collectOn ? 'ok' : 'dn', live: collectOn, sched: jobLine(st.collect?.job) });
  const distillOn = Number(st.distill?.enabled || 0) > 0 && !!st.distill?.job?.any_enabled;
  const mcDistill = machine({ href: '#/context/distill', name: '증류기', s: fmt(st.distill?.configured) + ' · 켜짐 ' + fmt(st.distill?.enabled),
    pill: pending ? '승인 ' + fmt(pending) + ' 대기' : (distillOn ? '켜짐' : '꺼짐'), k: pending ? 'warn' : (distillOn ? 'ok' : 'dn'), live: distillOn, sched: jobLine(st.distill?.job),
    extra: blindEl });
  const mcInject = machine({ href: '#/context/deliver', name: '주입규칙', s: (startDocs !== null ? '시작 문서 ' + fmt(startDocs) + ' · ' : '') + '검색', pill: '켜짐', k: 'ok', live: true, sched: '세션 시작마다' });

  // ── 관(선로) — 기계가 도는 구간만 흐른다 ──
  const duct = (mc: HTMLElement, flowing: boolean) =>
    el('div', { class: 'cxm-duct' },
      el('span', { class: 'cxm-wire' + (flowing ? ' is-flow' : ' is-still'), 'aria-hidden': 'true' }),
      lineIcon('chevR', 'cxm-arr'),
      el('span', { class: 'cxm-duct-c' }, mc));

  const lane = el('div', { class: 'cxm-floor' }, el('div', { class: 'cxm-lane' },
    stExt, duct(mcCollect, collectOn), stRaw, duct(mcDistill, distillOn), stKnow, duct(mcInject, true), stAI));

  // ── 지도 아래 한 줄 — 같은 재질의 셀 둘: 확인할 것 요약 · 자동 실행 ──
  const inboxCell = el('a', { class: 'cxm-cell cxm-cell-inbox', href: '#/context/inbox' },
    el('b', { text: '확인할 것 ' + fmt(inboxN) + '건' }),
    el('span', { class: 'cxm-cell-s', text: '승인 ' + fmt(pending) + ' · 카테고리 제안 ' + fmt(proposed) + ' · 점검 발견 ' + fmt(findings) }),
    el('span', { class: 'btn btn-sm ' + (pending ? 'btn-primary' : 'btn-ghost'), text: '확인하러 가기' }));
  const jobsCell = el('div', { class: 'cxm-cell cxh-jobs' }, el('span', { class: 'cxh-jobs-t', text: '자동 실행' }),
    jobChip('수집', st.collect?.job), jobChip('증류', st.distill?.job), jobChip('분류', st.classify?.job), jobChip('점검', st.manage?.job));

  box.replaceChildren(el('div', { class: 'cxm' },
    el('p', { class: 'cxm-cap' }, el('b', { text: '흐름 지도' }),
      el('span', { text: '자료가 지식이 되어 AI 에 닿기까지 — 흰 카드는 장소, 어두운 칩은 그 사이에서 도는 기계입니다. 선이 흐르면 그 기계가 돌고 있는 것이고, 누르면 그 화면이 열립니다' })),
    lane,
    el('div', { class: 'cxm-strip' }, inboxCell, jobsCell)));
}

let blindEl: HTMLElement | null = null;
// 사각지대 — 어느 증류기에도 안 걸리는 자료. 있으면 증류기 칩 발치에 한 줄(renderContextMap 이 그리기 전에 준비).
async function prepareBlindspot(): Promise<void> {
  blindEl = null;
  try {
    const r: any = await api('/api/ui/org/distillers');
    const n = Number(r?.coverage?.uncovered || 0);
    if (n > 0) blindEl = el('span', { class: 'cxm-mc-x', title: '어느 증류기에도 안 걸리는 자료 — 이대로 두면 영영 지식이 되지 않습니다', text: '사각지대 ' + fmtNum(n) });
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

// ── 셸로 가는 길(#3830) ─────────────────────────────────────────────────────
//  이 화면은 새 셸의 앱 액자(iframe) 안에서 산다. 다른 앱·구역은 액자 밖이라 location.hash 로는 못 간다 — 셸이 듣는
//  postMessage 로 한 줄 올린다(main.ts: `lively:open-route` 는 그 주소의 탭을 열고, `lively:open-section` 은 레일
//  구역을 고른 뒤 그 구역이 두고 간 자리로 간다). 액자 밖(클래식 셸)이면 그냥 주소로 간다.
type ShellDest = { route: string; section?: 'wiki' | 'sess' };
function goShell(d: ShellDest): void {
  const framed = (() => { try { return window.parent && window.parent !== window; } catch { return false; } })();
  if (framed) {
    try {
      window.parent.postMessage(d.section ? { type: 'lively:open-section', section: d.section } : { type: 'lively:open-route', href: d.route }, location.origin);
      return;
    } catch { /* 부모가 안 받으면 아래 폴백 */ }
  }
  location.hash = d.route;
}
