// context-claude-runs.ts — [수집 · 증류 ▸ 수집기 설정 ▸ Claude 커넥터 수집](#4213 T11). 수집 실행의 지표 + 수집 세션 크기.
//
//  상민님 2026-10-16: "크기는 일단 추천안으로 가고 이거 대시보드에서 바꿀 수 있게 하고 수집의 실패율 같은 모니터링 지표도
//   확인할 수 있게 해줘 의사결정 돕게". 그래서 **지표와 손잡이를 한 화면**에 둔다 — 실패율·메모리 탓일 수 있는 실패·최고 메모리가
//   상한에 얼마나 붙었나를 보면서, 같은 자리에서 상한·예약을 고친다. 고친 값은 다음 수집 실행부터 쓴다.
//
//  화면:
//   · renderClaudeRunsScreen — 기간(24시간·7일·30일) · 숫자 타일 · 실패 사유 · 메모리 · 크기 설정 · 날짜별 · 최근 실행.
//  데이터: GET /api/ui/collect/claude-run-stats(collect_claude_run_stats — 관리자만) 하나. 저장: POST /api/ui/collect/session-policy
//   {max_mb, request_mb} · 되돌리기 {reset:true}(collect_session_policy_set) — 범위·예약 ≤ 상한은 서버가 400 으로 알린다(여기서 다시 판정하지 않는다).
import { api, el, fmtNum, hasScope, relTime, replaceKids, toast } from './core.js';
import { CTX_APP_NAME, CTX_TAB } from './lib/ctx-names.js';

type Outcome = 'ok' | 'login' | 'quota' | 'no_connector' | 'connector_load' | 'oom' | 'gone' | 'timeout' | 'lost' | 'max_turns' | 'canceled' | 'error';
const OUTCOME_LABEL: Record<Outcome, string> = {
  ok: '성공', login: 'Claude 로그인 끊김', quota: '사용 한도 초과', no_connector: '연결된 커넥터 없음', connector_load: '커넥터를 불러오지 못함',
  oom: '강제 종료(메모리 초과 추정)', gone: '끝 신호 없이 세션이 사라짐', timeout: '시간 상한 초과', lost: '끝 신호를 못 받음',
  max_turns: '턴 상한 도달', canceled: '취소됨', error: '실행 오류',
};
const PERIODS: Array<{ days: number; label: string }> = [{ days: 1, label: '24시간' }, { days: 7, label: '7일' }, { days: 30, label: '30일' }];
const SOURCE_LABEL: Record<string, string> = { db: '이 화면에서 저장한 값', env: '서버 설정 파일(.env) 값', default: '기본값' };

let days = 7;
const tz = (): string => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
const pct = (r: number | null | undefined): string => (r == null ? '—' : (Math.round(r * 1000) / 10) + '%');
const mb = (n: number | null | undefined): string => (n == null ? '—' : fmtNum(n) + 'MB');
const sec = (s: number | null | undefined): string => (s == null ? '—' : s < 60 ? s + '초' : Math.round(s / 6) / 10 + '분');
const usd = (n: number | null | undefined): string => (n == null ? '—' : n === 0 ? '$0' : '$' + (n < 0.1 ? n.toFixed(4) : n.toFixed(2)));
const labelOf = (o: string | null): string => (o ? OUTCOME_LABEL[o as Outcome] || o : '도는 중');
//  실행 종류(#4213 T11 저장 단계) — 점검(커넥터·메모리만 잰다) · 목록(무엇이 있나 → 수집 단위) · 수집(맡은 단위를 읽어 자료로).
const MODE_LABEL: Record<string, string> = { probe: '점검', listing: '목록', collect: '수집' };
/** 저장 단계 한 줄 — 목록은 단위, 수집은 자료. 점검·옛 실행(기록 없음)은 «—». */
function ingestText(r: any): { text: string; title: string; fail: boolean } {
  const g = r.ingest;
  if (!g || !r.mode || r.mode === 'probe') return { text: '—', title: '', fail: false };
  if (g.state === 'running') return { text: '저장 중', title: '', fail: false };
  if (g.state === 'failed') return { text: '저장 못 함', title: g.error || '', fail: true };
  if (r.mode === 'listing') {
    return {
      text: '단위 ' + fmtNum(g.listed ?? 0) + (g.created ? ' (새 ' + fmtNum(g.created) + ')' : '') + (g.refused ? ' · 받지 않음 ' + fmtNum(g.refused) : '')
        + (g.proof_pending ? ' · 확인 대기 ' + fmtNum(g.proof_pending) : ''),
      title: [g.refused ? '받지 않음: 그 사람 것으로 확인되지 않은 단위(예: 라이블리 이메일과 다른 메일함)' : '',
        g.proof_pending ? '확인 대기: 이미 모인 자료가 있는 비공개 단위 — 그 사람 커넥터로 읽은 글이 저장된 글과 같으면(다음 수집 실행의 확인 읽기) 볼 수 있게 됩니다' : '']
        .filter(Boolean).join(' · '), fail: false,
    };
  }
  //  다 못 읽은 단위 · 못 푼 결과 · 저장 실패가 있으면 «확인 필요» — 위치는 그대로라 다음 판이 다시 읽지만, 계속되면 형식이 바뀌었을 수 있다.
  const why = [g.incomplete ? '다 못 읽은 단위 ' + fmtNum(g.incomplete) : '', g.stuck ? '구간을 더 줄일 수 없는 단위 ' + fmtNum(g.stuck) : '',
    g.unread ? '안 읽은 단위 ' + fmtNum(g.unread) : '', g.unparsed ? '풀지 못한 결과 ' + fmtNum(g.unparsed) : '',
    g.failed ? '저장 실패 ' + fmtNum(g.failed) : '', g.proof_passed ? '확인 읽기 통과 ' + fmtNum(g.proof_passed) : '',
    g.proof_failed ? '확인 읽기 실패 ' + fmtNum(g.proof_failed) + '(저장된 글과 다름 — 넣지 않음)' : '',
    g.proof_held ? '확인 대기 ' + fmtNum(g.proof_held) + '(맡은 비공개 단위 — 확인 읽기 뒤에 모음)' : '',
    g.unsearched ? '검색을 못 써 옛 스레드를 못 찾은 단위 ' + fmtNum(g.unsearched) : ''].filter(Boolean).join(' · ');
  return { text: '자료 ' + fmtNum(g.stored ?? 0) + (g.inserted ? ' (새 ' + fmtNum(g.inserted) + ')' : '') + (g.partial ? ' · 확인 필요' : ''), title: why || g.error || '', fail: !!g.stuck };
}

async function fetchStats(d: number, recent: number): Promise<any> {
  const q = new URLSearchParams({ days: String(d), tz: tz(), recent: String(recent) });
  return api('/api/ui/collect/claude-run-stats?' + q);
}

// ── 상세 화면 ────────────────────────────────────────────────────────────────
export async function renderClaudeRunsScreen(host: HTMLElement): Promise<void> {
  const crumb = el('nav', { class: 'cxrp-crumb', 'aria-label': '위치' },
    el('a', { href: '#/context/home', text: CTX_APP_NAME }), el('i', { text: '/' }),
    el('a', { href: '#/context/sources', text: CTX_TAB.sources }), el('i', { text: '/' }), el('b', { text: 'Claude 커넥터 수집' }));
  if (!hasScope('admin')) {
    replaceKids(host, el('div', { class: 'cxcr' }, crumb, el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '관리자만 볼 수 있습니다.' }))));
    return;
  }
  const body = el('div', { class: 'cxcr-body' }, el('p', { class: 'admin-hint', text: '불러오는 중…' }));
  const periodBar = el('div', { class: 'cxcr-periods', role: 'group', 'aria-label': '기간' });
  for (const p of PERIODS) {
    const b = el('button', { type: 'button', class: 'ctx-chip' + (p.days === days ? ' ctx-chip-on' : ''), 'aria-pressed': p.days === days ? 'true' : 'false', text: p.label });
    b.addEventListener('click', () => { days = p.days; void renderClaudeRunsScreen(host); });
    periodBar.append(b);
  }
  const head = el('div', { class: 'cxc-head' },
    el('div', { class: 'cxc-head-main' },
      el('h3', { class: 'cxc-title' }, el('span', { text: 'Claude 커넥터 수집' })),
      el('p', { class: 'cxc-lead', text: '구성원의 Claude 커넥터(Slack · Notion · Gmail …)로 모으는 실행의 기록입니다. 실패율과 메모리를 보고 수집 세션 크기를 정합니다 — 바꾼 크기는 다음 실행부터 씁니다.' })),
    el('div', { class: 'cxc-head-acts' }, periodBar));
  replaceKids(host, el('div', { class: 'cxcr' }, crumb, head, body));

  let v: any;
  try { v = await fetchStats(days, 100); }
  catch (e) {
    replaceKids(body, el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '불러오지 못했습니다 — ' + (e as Error).message })));
    return;
  }
  const s = v.stats || {}, p = v.policy || {};
  const reload = () => { void renderClaudeRunsScreen(host); };
  replaceKids(body, 
    v.truncated ? el('p', { class: 'cxcr-warn', text: '실행이 많아 최근 2만 회만 세었습니다 — 아래 숫자는 그 안의 값입니다. 기간을 줄이면 전부 셉니다.' }) : null,
    tiles(s, p),
    el('div', { class: 'cxcr-grid' }, outcomesCard(s), memoryCard(s, p)),
    sizeCard(p, s.suggestion, reload),
    dailyCard(s),
    recentCard(v.recent || [], v.truncated));
}

function tile(label: string, value: string, sub: string, cls = ''): HTMLElement {
  return el('div', { class: 'cxcr-tile' + (cls ? ' ' + cls : '') },
    el('span', { class: 'cxcr-tile-l', text: label }), el('b', { class: 'cxcr-tile-v num', text: value }), el('span', { class: 'cxcr-tile-s', text: sub }));
}

function tiles(s: any, p: any): HTMLElement {
  const m = s.memory || {};
  const suspect = Number(m.suspect_failures || 0);
  //  비율은 «그 실행이 돈 한도» 대비다(크기를 바꾸기 전 실행은 옛 상한에서 돌았다) — 지금 상한과 섞어 쓰지 않는다.
  const ratio = m.max_ratio != null ? '실행 한도의 최대 ' + pct(m.max_ratio) + ' · ' : '';
  return el('div', { class: 'cxcr-tiles' },
    tile('실행', fmtNum(s.runs || 0) + '회', s.running ? '지금 도는 중 ' + fmtNum(s.running) : '끝난 실행 ' + fmtNum(s.finished || 0)),
    tile('실패율', pct(s.failure_rate), s.finished ? '실패 ' + fmtNum(s.failed || 0) + ' / 끝난 ' + fmtNum(s.finished) : '끝난 실행이 없습니다', (s.failure_rate || 0) > 0 ? 'is-warn' : ''),
    tile('메모리 탓일 수 있는 실패', fmtNum(suspect) + '회', '강제 종료 · 끝 신호 없이 사라짐', suspect ? 'is-warn' : ''),
    tile('최고 메모리', mb(m.max_mb), ratio + '지금 상한 ' + mb(p.max_mb), (m.max_ratio || 0) >= 0.9 ? 'is-warn' : ''),
    tile('걸린 시간', sec(s.duration?.p50_sec), '중앙값 · 상위 5% ' + sec(s.duration?.p95_sec)),
    tile('비용', usd(s.cost?.total_usd ?? 0), '평균 ' + usd(s.cost?.avg_usd)));
}

function outcomesCard(s: any): HTMLElement {
  const card = el('section', { class: 'card cxcr-card' }, el('h4', { class: 'cxcr-h', text: '실패 사유' }));
  const list: any[] = s.outcomes || [];
  if (!list.length) {
    card.append(el('p', { class: 'admin-hint', text: s.finished ? '이 기간에 실패한 실행이 없습니다.' : '이 기간에 끝난 실행이 없습니다.' }));
    return card;
  }
  const max = Math.max(...list.map((o) => o.count));
  for (const o of list) {
    card.append(el('div', { class: 'cxcr-bar' + (o.memory_suspect ? ' is-mem' : '') },
      el('span', { class: 'cxcr-bar-l', text: o.label || labelOf(o.outcome) }),
      el('span', { class: 'cxcr-bar-track' }, el('i', { style: 'width:' + Math.max(4, Math.round((o.count / max) * 100)) + '%' })),
      el('b', { class: 'num', text: fmtNum(o.count) }),
      el('span', { class: 'cxcr-bar-p num', text: s.finished ? pct(o.count / s.finished) : '' })));
  }
  if (s.tools?.calls) card.append(el('p', { class: 'admin-hint', text: '도구 호출 ' + fmtNum(s.tools.calls) + '번 중 오류 ' + fmtNum(s.tools.errors || 0) + '번(실행은 성공했어도 앱이 오류를 돌려준 호출).' }));
  if (s.load_retried) card.append(el('p', { class: 'admin-hint', text: '커넥터가 늦게 붙어 Claude 를 다시 띄운 실행 ' + fmtNum(s.load_retried) + '회(세 번 다 안 붙으면 «커넥터를 불러오지 못함» 으로 셉니다).' }));
  return card;
}

function memoryCard(s: any, p: any): HTMLElement {
  const m = s.memory || {};
  const card = el('section', { class: 'card cxcr-card' }, el('h4', { class: 'cxcr-h', text: '메모리' }));
  if (!m.samples) {
    card.append(el('p', { class: 'admin-hint', text: '메모리를 잰 실행이 아직 없습니다. 실행이 쌓이면 최고 메모리가 여기 나옵니다.' }));
    return card;
  }
  //  눈금 — 0 ~ max(상한, 최대) 위에 중앙값·상위 5%·최대 점과 예약·상한 선
  const top = Math.max(p.max_mb || 0, m.max_mb || 0, 1);
  const at = (n: number | null | undefined): string => 'left:' + Math.min(100, Math.max(0, ((n || 0) / top) * 100)) + '%';
  card.append(el('div', { class: 'cxcr-scale', 'aria-hidden': 'true' },
    el('i', { class: 'cxcr-scale-band', style: 'left:0;width:' + Math.min(100, ((m.max_mb || 0) / top) * 100) + '%' }),
    el('i', { class: 'cxcr-scale-req', style: at(p.request_mb), title: '예약 ' + mb(p.request_mb) }),
    el('i', { class: 'cxcr-scale-cap', style: at(p.max_mb), title: '상한 ' + mb(p.max_mb) }),
    el('i', { class: 'cxcr-scale-dot', style: at(m.p50_mb), title: '중앙값 ' + mb(m.p50_mb) }),
    el('i', { class: 'cxcr-scale-dot is-hi', style: at(m.p95_mb), title: '상위 5% ' + mb(m.p95_mb) })));
  card.append(el('div', { class: 'cxcr-legend' },
    el('span', {}, el('i', { class: 'cxcr-lg-band' }), '0 ~ 최대'),
    el('span', {}, el('i', { class: 'cxcr-lg-dot' }), '중앙값'),
    el('span', {}, el('i', { class: 'cxcr-lg-dot is-hi' }), '상위 5%'),
    el('span', {}, el('i', { class: 'cxcr-lg-req' }), '예약 ' + mb(p.request_mb)),
    el('span', {}, el('i', { class: 'cxcr-lg-cap' }), '지금 상한 ' + mb(p.max_mb))));
  card.append(el('dl', { class: 'cxcr-dl' },
    el('dt', { text: '중앙값' }), el('dd', { class: 'num', text: mb(m.p50_mb) }),
    el('dt', { text: '상위 25%' }), el('dd', { class: 'num', text: mb(m.p75_mb) }),
    el('dt', { text: '상위 5%' }), el('dd', { class: 'num', text: mb(m.p95_mb) }),
    el('dt', { text: '최대' }), el('dd', { class: 'num', text: mb(m.max_mb) }),
    el('dt', { text: '한도의 90% 넘은 실행' }), el('dd', { class: 'num' + (m.near_cap ? ' is-fail' : ''), text: fmtNum(m.near_cap || 0) + '회' }),
    el('dt', { text: '표본' }), el('dd', { class: 'num', text: fmtNum(m.samples) + '회' })));
  card.append(el('p', { class: 'admin-hint', text: '메모리는 수집 세션 컨테이너 전체 사용량입니다(시작할 때 이미 약 120MB). 예약은 보통 쓰는 양, 상한은 가장 무거운 실행보다 여유 있게 둡니다.' }));
  if (m.excluded) card.append(el('p', { class: 'admin-hint', text: '잰 값이 그 실행의 상한과 맞지 않는 실행 ' + fmtNum(m.excluded) + '회(서버 전체 메모리를 잰 경우 등)는 위 숫자에서 뺐습니다.' }));
  return card;
}

function sizeCard(p: any, sug: any, reload: () => void): HTMLElement {
  const b = p.bounds || { max_mb_min: 256, request_mb_min: 128, max: 8192 };
  const maxIn = el('input', { type: 'number', class: 'cxcr-in num', min: String(b.max_mb_min), max: String(b.max), step: '64', value: String(p.max_mb ?? ''), 'aria-label': '상한(MB)' }) as HTMLInputElement;
  const reqIn = el('input', { type: 'number', class: 'cxcr-in num', min: String(b.request_mb_min), max: String(b.max), step: '64', value: String(p.request_mb ?? ''), 'aria-label': '예약(MB)' }) as HTMLInputElement;
  const saveBtn = el('button', { type: 'button', class: 'btn btn-primary', text: '저장' }) as HTMLButtonElement;
  //  되돌리기 = 저장값을 비운다(reset) — 기본값을 손으로 넣어 저장하면 그 숫자가 굳어 나중에 기본값이 바뀌어도 따라가지 않는다.
  //   되돌린 뒤의 값은 서버가 알려 준다(reset_to — 서버 설정 파일에 값이 있으면 그 값, 없으면 기본값).
  const back = p.reset_to || p.defaults || { max_mb: 1024, request_mb: 640 };
  const resetBtn = p.source === 'db'
    ? el('button', { type: 'button', class: 'btn btn-ghost', text: '저장값 지우기(' + fmtNum(back.max_mb) + ' / ' + fmtNum(back.request_mb) + 'MB 로)' })
    : null;
  const dirty = (): boolean => Number(maxIn.value) !== p.max_mb || Number(reqIn.value) !== p.request_mb;
  const sync = (): void => { saveBtn.disabled = !dirty(); };
  maxIn.addEventListener('input', sync); reqIn.addEventListener('input', sync);
  //  저장 요청만 try 로 감싼다 — 뒤따르는 알림·다시 그리기가 실패해도 «저장하지 못했습니다» 로 읽히지 않게.
  const post = async (body: unknown, done: string): Promise<void> => {
    saveBtn.disabled = true;
    let err: Error | null = null;
    try {
      await api('/api/ui/collect/session-policy', { method: 'POST', body: JSON.stringify(body) });
    } catch (e) { err = e as Error; }
    if (err) { toast('저장하지 못했습니다 — ' + err.message, true); sync(); return; }
    toast(done);
    reload();
  };
  saveBtn.addEventListener('click', () => { void post({ max_mb: Number(maxIn.value), request_mb: Number(reqIn.value) }, '수집 세션 크기를 저장했습니다 — 다음 수집 실행부터 씁니다'); });
  resetBtn?.addEventListener('click', () => { void post({ reset: true }, '저장값을 지웠습니다 — 다음 수집 실행부터 ' + fmtNum(back.max_mb) + ' / ' + fmtNum(back.request_mb) + 'MB 로 뜹니다'); });
  sync();
  const card = el('section', { class: 'card cxcr-card cxcr-size' },
    el('h4', { class: 'cxcr-h', text: '수집 세션 크기' }),
    el('p', { class: 'admin-hint', text: '수집은 실행마다 작은 세션을 따로 띄웁니다. 상한을 넘으면 그 실행은 메모리 초과로 끝나고, 예약은 노드에 자리를 잡는 양이라 클수록 한 노드에 동시에 덜 들어갑니다.' }),
    el('div', { class: 'cxcr-size-row' },
      el('label', { class: 'cxcr-field' }, el('span', { text: '상한' }), maxIn, el('span', { class: 'cxcr-unit', text: 'MB' })),
      el('label', { class: 'cxcr-field' }, el('span', { text: '예약' }), reqIn, el('span', { class: 'cxcr-unit', text: 'MB' })),
      saveBtn, resetBtn),
    el('p', { class: 'cxcr-src', text: '지금 값: 상한 ' + mb(p.max_mb) + ' · 예약 ' + mb(p.request_mb) + ' — ' + (SOURCE_LABEL[p.source] || p.source || '') +
      ' · 범위 상한 ' + fmtNum(b.max_mb_min) + '~' + fmtNum(b.max) + 'MB, 예약 ' + fmtNum(b.request_mb_min) + 'MB 이상(상한 이하)' }));
  if (sug) {
    const use = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '이 값으로 채우기' });
    use.addEventListener('click', () => { maxIn.value = String(sug.max_mb); reqIn.value = String(sug.request_mb); sync(); });
    card.append(el('div', { class: 'cxcr-sug' },
      el('b', { text: '참고 추천 — 상한 ' + mb(sug.max_mb) + ' · 예약 ' + mb(sug.request_mb) }),
      el('span', { text: '최근 ' + fmtNum(sug.samples) + '회 실측 기준: ' + sug.rule }), use));
  } else {
    card.append(el('p', { class: 'admin-hint', text: '메모리를 잰 실행이 10회 이상 쌓이면 실측으로 계산한 추천값이 여기 나옵니다.' }));
  }
  return card;
}

function dailyCard(s: any): HTMLElement {
  const card = el('section', { class: 'card cxcr-card' }, el('h4', { class: 'cxcr-h', text: '날짜별' }));
  const days: any[] = s.daily || [];
  if (!days.length) { card.append(el('p', { class: 'admin-hint', text: '이 기간에 실행이 없습니다.' })); return card; }
  const max = Math.max(...days.map((d) => d.runs), 1);
  const table = el('div', { class: 'cxcr-days' });
  for (const d of days.slice().reverse()) {
    table.append(el('div', { class: 'cxcr-day' },
      el('span', { class: 'num', text: d.day.slice(5).replace('-', '/') }),
      el('span', { class: 'cxcr-bar-track' },
        el('i', { style: 'width:' + Math.max(3, Math.round(((d.runs - d.failed) / max) * 100)) + '%' }),
        d.failed ? el('i', { class: 'is-fail', style: 'width:' + Math.max(3, Math.round((d.failed / max) * 100)) + '%' }) : null),
      el('span', { class: 'num', text: fmtNum(d.runs) + '회' + (d.failed ? ' · 실패 ' + fmtNum(d.failed) : '') }),
      el('span', { class: 'num cxcr-muted', text: d.peak_max_mb != null ? '최고 ' + mb(d.peak_max_mb) : '' })));
  }
  card.append(table);
  return card;
}

function recentCard(rows: any[], truncated: boolean): HTMLElement {
  const card = el('section', { class: 'card cxcr-card' }, el('h4', { class: 'cxcr-h', text: '최근 실행' }));
  if (!rows.length) { card.append(el('p', { class: 'admin-hint', text: '이 기간에 실행이 없습니다.' })); return card; }
  const wrap = el('div', { class: 'cxcr-tablewrap' });
  const table = el('table', { class: 'cxcr-table' },
    el('thead', {}, el('tr', {}, ...['시작', '구성원', '종류', '앱', '결과', '저장', '메모리(최고 / 한도)', '시간', '비용'].map((h) => el('th', { text: h })))));
  const tbody = el('tbody', {});
  for (const r of rows) {
    const fail = r.outcome && r.outcome !== 'ok';
    const ing = ingestText(r);
    const retried = (r.attempts || 0) > 1 ? ' · 다시 띄움 ' + fmtNum(r.attempts - 1) + '번' : '';
    tbody.append(el('tr', { class: fail || ing.fail ? 'is-fail' : '' },
      el('td', { title: new Date(r.started_at).toLocaleString('ko-KR'), text: relTime(r.started_at) }),
      el('td', { text: r.member_name || r.member_id }),
      //  #4744 기본 주기 틱이 띄운 판은 «· 주기» 를 붙인다(사람·리브가 직접 띄운 판과 가른다).
      el('td', { text: (MODE_LABEL[r.mode] || '점검') + (r.trigger === 'schedule' ? ' · 주기' : '') }),
      el('td', { text: (r.apps || []).join(', ') || '전부' }),
      el('td', { title: r.error || '', text: labelOf(r.outcome) + retried }),
      el('td', { title: ing.title, text: ing.text }),
      el('td', { class: 'num', text: r.mem_peak_mb != null ? mb(r.mem_peak_mb) + ' / ' + mb(r.mem_limit_mb ?? r.cap_mb) : '— / ' + mb(r.cap_mb) }),
      el('td', { class: 'num', text: r.duration_ms != null ? sec(Math.round(r.duration_ms / 1000)) : '—' }),
      el('td', { class: 'num', text: usd(r.cost_usd) })));
  }
  table.append(tbody);
  wrap.append(table);
  card.append(wrap);
  if (truncated) card.append(el('p', { class: 'admin-hint', text: '실행이 많아 최근 것부터 일부만 세었습니다.' }));
  return card;
}
