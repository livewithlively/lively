// admin-audit-tools.ts — #1405 W3: admin-audit.ts 분할 ②.
//  '툴 사용량' 패널 — 집계 표·기간 창·전용 스타일.
import { api, busy, cardHead, el, errorNote, relTime, toast, uiText } from './core.js';
import { skeleton } from './ui-primitives.js';
import { AUD_CUSTOM, audDayEnd, audDayStart, audExportBtn, audExportCsv, audField, audPageSize, audPageSizeField, audPager, audPeriodField, audSelect } from './admin-audit-common.js';
// ════════ MCP 호출 통계(#318) — 하네스가 어떤 MCP 툴을 어떤 인자로 어느 빈도로 호출했는지 ════════
//  읽기 전용 대시보드(admin). 백엔드=/api/ui/tool-usage(src/capabilities/tool-usage.ts → mcp_call_log 집계).
//  "직접/LLM 쿼리"는 db_query 로 mcp_call_log 를 SELECT(이 화면=사람용 집계 편의 표면). 새 서브탭일 뿐 기존 도구 화면 불변.
//  from/to(#1309) = 「직접 지정」 기간의 시작·종료 날짜(YYYY-MM-DD, 보는 사람 시간대). window==='custom' 일 때만 쓴다.
const TOOL_USAGE_STATE = { window: '7d', from: '', to: '', harness: '', tool: '', errorsOnly: false, page: 1, allTools: false };
const TU_WINDOW_LABELS = { '1h': '최근 1시간', '24h': '최근 24시간', '7d': '최근 7일', '30d': '최근 30일', '90d': '최근 90일', 'all': '전체 기간' };
// 스타일 1회 주입(테마 토큰 사용). innerHTML 없음 — textContent 로만 CSS 삽입(보안 불변식 준수).
//  ⚠ 필터바·페이저는 여기 없다 — 3탭 공용 .aud-* (styles.css, #1085). 여긴 이 탭 고유의 스탯·차트·표만.
function tuEnsureStyles() {
    if (document.getElementById('tu-styles'))
        return;
    document.head.appendChild(el('style', { id: 'tu-styles', text: `
.tu-stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:6px}
.tu-stat{flex:1 1 120px;min-width:104px;padding:12px 14px;border:1px solid var(--line);border-radius:11px;background:var(--bg-tint)}
.tu-stat b{display:block;font-size:23px;font-weight:800;line-height:1.15;color:var(--ink);font-variant-numeric:tabular-nums}
.tu-stat span{font-size:11.5px;color:var(--ink-sub)}
.tu-stat.tu-bad b{color:var(--coral)}
.tu-sub{font-weight:800;font-size:13px;color:var(--ink);margin:22px 0 9px}
.tu-days{display:flex;gap:4px;height:72px;padding:6px 2px 0;border-bottom:1px solid var(--line)}
.tu-day{flex:1 1 0;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;min-width:6px}
.tu-day i{width:100%;max-width:28px;background:var(--blue);border-radius:3px 3px 0 0;min-height:2px;display:block}
.tu-day i.tu-allerr{background:var(--coral)}
.tu-daylabels{display:flex;gap:4px;margin-top:5px}
.tu-daylabels span{flex:1 1 0;text-align:center;font-size:9.5px;color:var(--muted);min-width:6px;overflow:hidden}
.tu-table{width:100%;border-collapse:collapse;font-size:13px}
.tu-table th{text-align:left;padding:6px 9px;font-size:11px;font-weight:700;color:var(--muted);border-bottom:1px solid var(--line)}
.tu-table th.tu-num{text-align:right}
.tu-table td{padding:6px 9px;border-bottom:1px solid var(--line);color:var(--ink)}
.tu-table td.tu-num{text-align:right;font-variant-numeric:tabular-nums;color:var(--ink-sub);white-space:nowrap}
.tu-table tr:hover td{background:var(--bg-tint)}
.tu-namecell{position:relative;min-width:170px}
.tu-bar{position:absolute;left:0;top:4px;bottom:4px;background:var(--bg-tint-2);border-radius:4px;z-index:0}
.tu-namecell .tu-name{position:relative;z-index:1}
.tu-harness{display:flex;gap:8px;flex-wrap:wrap}
.tu-chip{display:inline-flex;align-items:center;gap:7px;padding:5px 12px;border:1px solid var(--line);border-radius:999px;font-size:12px;color:var(--ink);background:var(--bg-tint)}
.tu-chip b{font-variant-numeric:tabular-nums}
.tu-chip em{color:var(--coral);font-style:normal;font-size:11px}
.tu-calls{margin-top:4px}
.tu-call{border-bottom:1px solid var(--line);padding:7px 4px}
.tu-call>summary{display:flex;gap:11px;align-items:center;cursor:pointer;list-style:none}
.tu-call>summary::-webkit-details-marker{display:none}
.tu-call>summary:hover{background:var(--bg-tint)}
.tu-ctime{color:var(--muted);font-size:11.5px;min-width:64px}
.tu-cactor{color:var(--ink-sub);font-size:12px;margin-left:auto}
.tu-cdur{color:var(--muted);font-size:11.5px;font-variant-numeric:tabular-nums}
.tu-cbad{color:var(--coral);font-size:11px;font-weight:700}
.tu-args{background:var(--bg-tint);border:1px solid var(--line);padding:9px 11px;border-radius:7px;font-size:12px;line-height:1.5;color:var(--ink);overflow:auto;max-height:340px;white-space:pre-wrap;word-break:break-word;margin:7px 0 2px}
.tu-empty{color:var(--muted);font-size:13px;padding:18px 4px}
` }));
}
function tuPretty(v) {
    if (v == null)
        return '{}';
    // #1082 — 외부로 나가는 도구는 인자 값을 저장하지 않는다. 저장된 요약(__omitted)을 날 JSON 으로 보여주면
    //  "왜 값이 없지 / 버그인가" 로 읽히므로, 무엇이 왜 없는지 사람 말로 풀어 준다.
    if (v && typeof v === 'object' && v.__omitted === 'external_tool_args') {
        const keys = Array.isArray(v.keys) ? v.keys : null;
        const parts = ['보낸 내용은 기록하지 않았습니다 — 외부 서비스로 나가는 도구입니다.'];
        if (keys)
            parts.push('전달한 항목: ' + (keys.length ? keys.join(', ') : '없음'));
        else if (typeof v.items === 'number')
            parts.push('전달한 항목: ' + v.items + '개');
        if (typeof v.bytes === 'number')
            parts.push('크기: ' + v.bytes.toLocaleString() + ' bytes');
        parts.push('내용이 필요하면 그 서비스(슬랙·노션 등)에서 확인하세요. 이 서버의 인자 기록은 「연결·데이터」 탭에서 켤 수 있습니다.');
        return parts.join('\n');
    }
    try {
        return JSON.stringify(v, null, 2);
    }
    catch {
        return String(v);
    }
}
// 소요시간 표기 — 큰 밀리초 값은 초/분으로 변환해 한눈에 크기를 읽게 한다(#853 UI 감사 114).
function tuFmtDur(ms) {
    if (ms == null)
        return '';
    if (ms < 1000)
        return ms + 'ms';
    if (ms < 60000)
        return (ms / 1000).toFixed(1) + 's';
    return (ms / 60000).toFixed(1) + '분';
}
async function toolUsagePanel(detail) {
    tuEnsureStyles();
    const reload = () => toolUsagePanel(detail);
    const PAGE_SIZE = audPageSize('tools'); // 개인이 고르는 값 — 기본 10줄(#1085)
    // 현재 필터 → 쿼리스트링(+추가 파라미터). 페이지 이동·CSV·재조회가 공유.
    const filterQs = (extra) => {
        const q = new URLSearchParams();
        // 기간 — 「직접 지정」이면 날짜 범위(since/until), 아니면 상대 window. 서버는 둘 다 알고, 절대범위가 우선한다(#1309).
        if (TOOL_USAGE_STATE.window === AUD_CUSTOM) {
            const s = audDayStart(TOOL_USAGE_STATE.from);
            if (s)
                q.set('since', s);
            const u = audDayEnd(TOOL_USAGE_STATE.to);
            if (u)
                q.set('until', u);
            if (!s && !u)
                q.set('window', 'all'); // 날짜를 아직 안 골랐다 → 전체 기간
        }
        else
            q.set('window', TOOL_USAGE_STATE.window);
        if (TOOL_USAGE_STATE.harness)
            q.set('harness', TOOL_USAGE_STATE.harness);
        if (TOOL_USAGE_STATE.tool)
            q.set('tool', TOOL_USAGE_STATE.tool);
        if (TOOL_USAGE_STATE.errorsOnly)
            q.set('errors', '1');
        for (const k in (extra || {}))
            q.set(k, String(extra[k]));
        return q.toString();
    };
    busy(detail, el('div', { class: 'card' }, skeleton('호출 통계를 불러오는 중')));
    const page = Math.max(1, TOOL_USAGE_STATE.page || 1);
    let r;
    try {
        r = await api('/api/ui/tool-usage?' + filterQs({ offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE }));
    }
    catch (e) {
        detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '호출 통계를 불러오지 못했습니다')));
        return;
    }
    const sum = r.summary || {};
    const byTool = r.byTool || [];
    const byHarness = r.byHarness || [];
    const byDay = (r.byDay || []).slice().reverse(); // 서버는 최신→과거 정렬 → 그래프는 과거→최신으로
    const recent = r.recent || [];
    const total = sum.total || 0;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    // ── 컨트롤(기간·하네스·도구·결과 필터) — 필터 변경 시 page=1 리셋 ──
    //  기간은 3탭 공용 컨트롤(#1309) — 상대 window + 「직접 지정」(날짜·날짜 범위).
    const winField = audPeriodField((r.windows || Object.keys(TU_WINDOW_LABELS)).map((w) => [w, TU_WINDOW_LABELS[w] || w]), TOOL_USAGE_STATE, 'window', () => { TOOL_USAGE_STATE.page = 1; reload(); });
    const harnessVals = byHarness.map((h) => h.harness).filter((h) => h && h !== '(미상)');
    const harnessSel = audSelect([['', '모든 하네스'], ...harnessVals.map((h) => [h, h])], TOOL_USAGE_STATE.harness, (v) => { TOOL_USAGE_STATE.harness = v; TOOL_USAGE_STATE.page = 1; reload(); });
    // 도구 필터 = 드롭다운(현재 기간+하네스 내 실제 도구 목록 + 호출수). 이름 타이핑 대신 선택.
    const toolOpts = r.toolOptions || [];
    const toolSel = audSelect([['', '모든 도구'], ...toolOpts.map((t) => [t.tool, t.tool + ' · ' + (t.calls || 0).toLocaleString() + '회'])], TOOL_USAGE_STATE.tool, (v) => { TOOL_USAGE_STATE.tool = v; TOOL_USAGE_STATE.page = 1; reload(); });
    // 결과 필터(전체/오류만)
    const errSel = audSelect([['', '전체'], ['1', '오류만']], TOOL_USAGE_STATE.errorsOnly ? '1' : '', (v) => { TOOL_USAGE_STATE.errorsOnly = v === '1'; TOOL_USAGE_STATE.page = 1; reload(); });
    // CSV(엑셀) 다운로드 — 현재 필터 그대로, 행수 상한 없이 서버가 흘려보낸다(#1309). 페이징 인자는 뺀다.
    const exportCsv = () => audExportCsv('tools', new URLSearchParams(filterQs()));
    const controls = el('div', { class: 'aud-filters' }, winField, audField('하네스', harnessSel), audField('도구', toolSel), audField('결과', errSel), audPageSizeField('tools', () => { TOOL_USAGE_STATE.page = 1; reload(); }), el('div', { class: 'aud-right' }, (TOOL_USAGE_STATE.harness || TOOL_USAGE_STATE.tool || TOOL_USAGE_STATE.errorsOnly)
        ? el('button', { class: 'btn btn-ghost btn-sm', text: '필터 해제', onclick: () => { TOOL_USAGE_STATE.harness = ''; TOOL_USAGE_STATE.tool = ''; TOOL_USAGE_STATE.errorsOnly = false; TOOL_USAGE_STATE.page = 1; reload(); } })
        : null, audExportBtn(exportCsv), el('button', { class: 'btn btn-ghost btn-sm', text: '새로고침', onclick: reload })));
    // ── 요약 스탯 ──
    const stat = (label, value, bad) => el('div', { class: 'tu-stat' + (bad ? ' tu-bad' : '') }, el('b', { text: String(value) }), el('span', { text: label }));
    const stats = el('div', { class: 'tu-stats' }, stat('총 호출', (sum.total || 0).toLocaleString()), stat('도구 종류', sum.tools || 0), stat('하네스', sum.harnesses || 0), stat('오류', (sum.errors || 0).toLocaleString(), (sum.errors || 0) > 0), stat('마지막 호출', sum.last_at ? relTime(sum.last_at) : '—'));
    // ── 일별 막대(KST) ──
    let daysEl = null;
    if (byDay.length) {
        const maxCalls = Math.max(...byDay.map((d) => d.calls), 1);
        const bars = el('div', { class: 'tu-days' });
        const labels = el('div', { class: 'tu-daylabels' });
        for (const d of byDay) {
            const h = Math.max(2, Math.round((d.calls / maxCalls) * 100));
            const allErr = d.calls > 0 && d.errors >= d.calls;
            bars.append(el('div', { class: 'tu-day' }, el('i', { class: allErr ? 'tu-allerr' : '', style: 'height:' + h + '%', title: d.day + ' · ' + d.calls + '회' + (d.errors ? ' (오류 ' + d.errors + ')' : '') })));
            labels.append(el('span', { text: String(d.day).slice(5) }));
        }
        daysEl = el('div', {}, el('div', { class: 'tu-sub', text: '일별 호출 · KST 기준' }), bars, labels);
    }
    // ── 도구별 표 ── 서버가 최대 200종을 주므로 그대로 그리면 이 표 하나가 화면 몇 개 길이가 된다(#1085).
    //  기본은 [표시 줄 수]만큼만 보여주고 나머지는 접는다 — 상위 몇 개가 대부분을 차지하는 분포라 그것으로 충분하다.
    const maxToolCalls = Math.max(...byTool.map((t) => t.calls), 1);
    const toolShown = TOOL_USAGE_STATE.allTools ? byTool : byTool.slice(0, PAGE_SIZE);
    const toolBody = el('tbody');
    for (const t of toolShown) {
        const frac = Math.round((t.calls / maxToolCalls) * 100);
        toolBody.append(el('tr', {}, el('td', { class: 'tu-namecell' }, el('span', { class: 'tu-bar', style: 'width:' + frac + '%' }), el('span', { class: 'tu-name mono', text: t.tool })), el('td', { class: 'tu-num', text: (t.calls || 0).toLocaleString() }), el('td', { class: 'tu-num', text: t.errors ? String(t.errors) : '–' }), el('td', { class: 'tu-num', text: t.avg_ms != null ? tuFmtDur(t.avg_ms) : '–' }), el('td', { class: 'tu-num', text: t.max_ms != null ? tuFmtDur(t.max_ms) : '–' }), el('td', { class: 'tu-num', text: t.last_at ? relTime(t.last_at) : '–' })));
    }
    const toolTable = byTool.length
        ? el('table', { class: 'tu-table' }, el('thead', {}, el('tr', {}, el('th', { text: '도구' }), el('th', { class: 'tu-num', text: '호출' }), el('th', { class: 'tu-num', text: '오류' }), el('th', { class: 'tu-num', text: '평균' }), el('th', { class: 'tu-num', text: '최대' }), el('th', { class: 'tu-num', text: '마지막' }))), toolBody)
        : el('div', { class: 'tu-empty', text: '이 조건에 기록된 호출이 없습니다.' });
    const toolMore = byTool.length > PAGE_SIZE
        ? el('div', { class: 'aud-pager' }, el('button', { class: 'btn btn-ghost btn-sm',
            text: TOOL_USAGE_STATE.allTools ? '상위 ' + PAGE_SIZE + '개만 보기' : '나머지 ' + (byTool.length - PAGE_SIZE) + '개 도구 더 보기',
            onclick: () => { TOOL_USAGE_STATE.allTools = !TOOL_USAGE_STATE.allTools; reload(); } }))
        : null;
    // ── 하네스별 칩 ──
    const harnessChips = el('div', { class: 'tu-harness' });
    for (const h of byHarness)
        harnessChips.append(el('span', { class: 'tu-chip' }, el('span', { text: h.harness }), el('b', { text: (h.calls || 0).toLocaleString() }), h.errors ? el('em', { text: '오류 ' + h.errors }) : null));
    // ── 최근 호출(인자 펼침) + 번호 페이지네이션 ──
    const calls = el('div', { class: 'tu-calls' });
    const renderCall = (c) => el('details', { class: 'tu-call' }, el('summary', {}, el('span', { class: 'tu-ctime', text: relTime(c.called_at) }), el('span', { class: 'tu-ctool mono', text: c.tool }), el('span', { class: 'dm-tag', text: c.harness || '미상' }), c.ok ? null : el('span', { class: 'tu-cbad', text: '✗ 오류' }), el('span', { class: 'tu-cdur', text: c.duration_ms != null ? tuFmtDur(c.duration_ms) : '' }), el('span', { class: 'tu-cactor', text: c.actor || '' })), el('pre', { class: 'tu-args mono', text: tuPretty(c.args) }), c.error ? el('pre', { class: 'tu-args mono', text: '⚠ ' + c.error }) : null);
    if (!recent.length)
        calls.append(el('div', { class: 'tu-empty', text: TOOL_USAGE_STATE.errorsOnly ? '이 조건의 오류 호출이 없습니다.' : '최근 호출이 없습니다.' }));
    for (const c of recent)
        calls.append(renderCall(c));
    // 번호 페이지네이션 — 페이지 클릭 시 page 갱신 후 reload(필터·집계 유지). ‹ 1 … 4 5 6 … 20 ›
    const pagerBox = audPager(page, totalPages, (n) => { TOOL_USAGE_STATE.page = n; reload(); });
    // ── 보관 기간(#1082) — 이 화면이 곧 이 데이터의 설정 창구다. 0 = 무기한(권장하지 않음).
    const retDays = (r.retention && typeof r.retention.retention_days === 'number') ? r.retention.retention_days : 90;
    const retIn = el('input', { type: 'number', min: '0', max: '3650', step: '1', class: 'aud-inp', style: 'width:90px;min-width:0', value: String(retDays) });
    const retSave = el('button', { class: 'btn btn-ghost btn-sm', text: '저장' });
    const retStatus = el('span', { class: 'admin-status' });
    const RET_SRC = { db: '관리탭에서 설정한 값', env: '설치 시 .env 값', default: '기본값' };
    retSave.addEventListener('click', async () => {
        const n = Number(retIn.value);
        if (!Number.isFinite(n) || n < 0 || n > 3650) {
            toast('0~3650 사이 숫자여야 합니다', true);
            return;
        }
        retSave.disabled = true;
        try {
            await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ call_log_policy: { retention_days: Math.floor(n) } }) });
            toast(n === 0 ? '무기한 보관으로 저장됨' : `${Math.floor(n)}일 보관으로 저장됨`);
            reload();
        }
        catch (e) {
            toast(e.message, true);
            retSave.disabled = false;
        }
    });
    const retBox = el('div', { class: 'admin-subcard', style: 'margin-top:22px' }, el('div', { class: 'admin-subhead', text: '기록 보관 기간' }), el('div', { class: 'admin-hint' }, ...uiText('이 기간이 지난 호출 기록은 자동으로 지워집니다. 누가 언제 무엇을 했는지가 사람 단위로 남는 기록이라, 필요한 기간만 두는 편이 안전합니다. 0 을 넣으면 영구 보관하는데, 권장하지 않습니다.')), el('div', { class: 'admin-actions' }, retIn, el('span', { class: 'caption' }, ...uiText('일')), retSave, retStatus, el('span', { class: 'caption', text: '현재: ' + (RET_SRC[r.retention_source] || r.retention_source || '기본값') })));
    const shown = recent.length
        ? `${total.toLocaleString()}건 중 ${((Math.min(page, totalPages) - 1) * PAGE_SIZE + 1).toLocaleString()}–${((Math.min(page, totalPages) - 1) * PAGE_SIZE + recent.length).toLocaleString()}번째`
        : '';
    const card = el('div', { class: 'card' }, cardHead('AI 도구 호출 기록', 'Claude·Codex 같은 하네스가 어떤 MCP 도구를 얼마나 자주 호출했는지 보여줍니다. 모든 호출이 기록되며 시크릿 값은 마스킹하고 큰 값은 잘라 보관합니다. AI에게 물어보거나 db_query 로 mcp_call_log 를 직접 조회할 수도 있습니다. 슬랙·메일·노션처럼 외부 서비스로 나가는 도구는 보낸 내용을 남기지 않고 호출 사실만 기록합니다. 이 기록은 서버마다 「연결·데이터」 탭에서 켤 수 있습니다.'), controls, stats, daysEl, el('div', { class: 'tu-sub', text: '도구별 호출' }), toolTable, toolMore, byHarness.length ? el('div', { class: 'tu-sub', text: '하네스별' }) : null, byHarness.length ? harnessChips : null, el('div', { class: 'tu-sub', text: '최근 호출' }), shown ? el('div', { class: 'aud-count', text: shown }) : null, calls, pagerBox, retBox);
    detail.replaceChildren(card);
}
export { toolUsagePanel };
