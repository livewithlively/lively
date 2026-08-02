// admin-audit.ts — 감사 로그 3탭(AI 도구 호출·관리 변경·DB 조회) (#1313 R37, admin.ts 에서 verbatim 분리).
//  셸을 역호출하지 않는 자족 패널이라 통째로 옮긴다. 3탭 공용 필터/페이저 킷(aud*)과
//  **모듈 뮤터블 상태**(TOOL_USAGE_STATE·ORG_AUDIT_STATE)·localStorage 키('lively_audit_rows_*')는
//  그 상태를 읽고 쓰는 패널과 반드시 같은 모듈에 산다(다른 모듈에서 import 바인딩을 재할당할 수 없다).

// ── 감사 로그 3탭 공용 컨트롤(#1085) ─────────────────────────────────────────
//  세 탭이 각자 필터바·페이저를 복제해 갖고 있었고(oa-* / audit-bar / tu-*), 라벨 유무·컨트롤 높이·
//  모서리·글자 크기가 전부 달랐다. 마크업 생성기를 하나로 모으고 스타일은 styles.css 의 .aud-* 로 통일한다.
import { api, cardHead, el, errorNote, relTime, state, withTip, uiText } from './core.js';
import { audExportBtn, audExportCsv, audField, audPageSize, audPageSizeField, audPager, audPeriodField, audPeriodQs, audSelect } from './admin-audit-common.js';

// ── DB 접근 감사 뷰(#746 P5) — 누가·언제·무엇을 조회했나(위변조 방지). 필터는 드롭다운 위주. admin. ──
const AUDIT_PERIODS: Array<[string, string]> = [['1d', '최근 24시간'], ['7d', '최근 7일'], ['30d', '최근 30일'], ['all', '전체 기간']];

const AUDIT_PERIOD_DAYS: Record<string, number> = { '1d': 1, '7d': 7, '30d': 30, all: 0 };

// 현재 필터 → 쿼리스트링(페이징 제외). 표 조회와 CSV 내보내기가 같은 조건을 보도록 한 곳에서 만든다(#1309).
function dbAuditFilterQs(f): URLSearchParams {
  const qs = new URLSearchParams();
  if (f.source) qs.set('source', f.source);
  if (f.op) qs.set('op', f.op);
  if (f.result === 'errors') qs.set('errors', '1');
  if (f.user) qs.set('user', f.user);
  if (f.table) qs.set('table', String(f.table).toLowerCase());
  const { since, until } = audPeriodQs(f, 'period', AUDIT_PERIOD_DAYS);
  if (since) qs.set('since', since);
  if (until) qs.set('until', until);
  return qs;
}

async function dbAuditEditor(detail, data) {
  // page 는 #1085 에서 추가 — 그 전엔 최근 100건을 한 번에 쏟아내 화면이 끝없이 길었다.
  //  from/to 는 #1309 — 「직접 지정」 기간의 시작·종료 날짜(period==='custom' 일 때만).
  const f = state.admin.dbAuditFilter || (state.admin.dbAuditFilter = { source: '', op: '', result: '', period: '7d', from: '', to: '', user: '', table: '', page: 1 });
  const body = el('div', {});
  const reload = () => { void loadAuditRows(body, f, reload); };
  const sources = (data.dbSources || []).map((s: any) => s.name);
  // 필터가 바뀌면 1페이지로 — 5페이지를 보다 조건을 좁히면 빈 페이지가 뜨던 것 방지.
  const onFilter = (key: string) => (v: string) => { f[key] = v; f.page = 1; reload(); };
  const srcSel = audSelect([['', '모든 소스'], ...sources.map((n: string) => [n, n] as [string, string])], f.source, onFilter('source'));
  const opSel = audSelect([['', '쿼리+스키마'], ['query', '쿼리 db_query'], ['schema', '스키마 db_schema']], f.op, onFilter('op'));
  const resSel = audSelect([['', '성공+차단'], ['errors', '차단만']], f.result, onFilter('result'));
  const perField = audPeriodField(AUDIT_PERIODS, f, 'period', () => { f.page = 1; reload(); });
  const userIn = el('input', { class: 'aud-inp', type: 'text', value: f.user || '', placeholder: '전체' });
  const tableIn = el('input', { class: 'aud-inp', type: 'text', value: f.table || '', placeholder: '전체' });
  const applyText = () => { f.user = userIn.value.trim(); f.table = tableIn.value.trim(); f.page = 1; reload(); };
  for (const inp of [userIn, tableIn]) inp.addEventListener('keydown', (e: any) => { if (e.key === 'Enter') applyText(); });

  const verifyOut = el('span', { class: 'admin-status' });
  const verifyBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '위변조 검증', onclick: async () => {
    verifyOut.textContent = '검증 중…';
    try {
      const r = await api('/api/ui/db-audit/verify');
      verifyOut.replaceChildren(r.ok
        ? el('span', { class: 'audit-ok', text: `✓ 무결 · ${r.checked}건 검증` })
        : el('span', { class: 'audit-bad', text: `⚠ 위변조 의심 — id ${r.broken?.id} · ${r.broken?.reason}` }));
    } catch (e: any) { verifyOut.replaceChildren(el('span', { class: 'audit-bad', text: e.message })); }
  } });

  const bar = el('div', { class: 'aud-filters' },
    perField,
    audField('소스', srcSel),
    audField('종류', opSel),
    audField('결과', resSel),
    audField('조회자', userIn),
    audField('테이블', tableIn),
    audPageSizeField('db', () => { f.page = 1; reload(); }),
    el('div', { class: 'aud-right' },
      // CSV 는 화면에 찍힌 텍스트 필터(조회자·테이블)까지 그대로 반영한다 — 아직 [조회]를 안 눌렀어도 입력값을 먼저 굳힌다.
      audExportBtn(() => { f.user = userIn.value.trim(); f.table = tableIn.value.trim(); void audExportCsv('db', dbAuditFilterQs(f)); }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '조회', onclick: applyText })));

  const card = el('div', { class: 'card' },
    cardHead('DB 조회 기록', "구성원과 그 구성원의 AI가 db_query·db_schema 로 어떤 데이터를 조회했는지 전부 기록합니다 — 조회자·시각·소스·테이블·마스킹 컬럼·원본 열람 컬럼·대상 식별자. 기록은 해시체인으로 위변조를 막으며 신용정보법상 조회 기록 보존에 씁니다. '누구의 정보인지'를 남길 식별자 컬럼은 [데이터 연결 ▸ DB 데이터소스]에서 지정합니다."),
    bar,
    // 위변조 검증은 필터가 아니라 '기록 전체'에 거는 행위라 필터바에서 뺐다 — 결과 문구도 여기 붙는다.
    el('div', { class: 'audit-verify' }, verifyBtn, verifyOut),
    body);
  detail.replaceChildren(card);
  reload();
}

async function loadAuditRows(body, f, reload) {
  body.replaceChildren(el('p', { class: 'admin-hint' }, ...uiText('불러오는 중…')));
  const pageSize = audPageSize('db');
  const page = Math.max(1, f.page || 1);
  const qs = dbAuditFilterQs(f);
  qs.set('limit', String(pageSize));
  qs.set('offset', String((page - 1) * pageSize));
  let r;
  try { r = await api('/api/ui/db-audit?' + qs.toString()); }
  catch (e: any) { body.replaceChildren(errorNote(e, '감사 기록을 불러오지 못했습니다')); return; }
  const rows = r.rows || [];
  const total = r.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // 필터를 좁혀 페이지 수가 줄면 현재 페이지가 범위를 벗어난다 — 마지막 페이지로 당겨 다시 부른다.
  if (!rows.length && page > totalPages) { f.page = totalPages; reload(); return; }
  if (!rows.length) { body.replaceChildren(el('p', { class: 'admin-hint' }, ...uiText('해당 조건의 조회 기록이 없습니다.'))); return; }
  const tbl = el('table', { class: 'audit-table' });
  tbl.append(el('tr', {}, ...['시각', '조회자', '구분', '소스', '테이블', '마스킹', '원본 열람', '행', '결과'].map((h) => el('th', { text: h }))));
  for (const row of rows) {
    const unmasked = (row.unmasked_columns || []);
    const masked = (row.masked_columns || []);
    const subj = row.subject_keys ? Object.keys(row.subject_keys).length : 0;
    tbl.append(el('tr', { class: row.ok ? '' : 'audit-row-bad' },
      el('td', { class: 'audit-time', text: relTime(row.at) }),
      el('td', {}, row.user_id || '-', row.harness ? el('span', { class: 'mini-meta', text: ' · ' + row.harness }) : null),
      el('td', { text: row.op === 'schema' ? '스키마' : '쿼리' }),
      el('td', { text: row.source || '-' }),
      el('td', { class: 'audit-tables' }, (row.tables || []).join(', ') || '-', subj ? el('span', { class: 'mini-meta', text: ` · 대상 ${subj}` }) : null),
      el('td', { text: masked.length ? String(masked.length) : '-' }),
      el('td', {}, unmasked.length ? el('span', { class: 'pill pill-warn', text: unmasked.join(', ') }) : el('span', { class: 'mini-meta' }, ...uiText('-'))),
      el('td', { class: 'audit-num', text: row.ok ? String(row.row_count) : '-' }),
      el('td', {}, row.ok ? el('span', { class: 'audit-ok', text: '성공' }) : withTip(el('span', { class: 'audit-bad', text: '차단' }), row.error || '차단됨'))));
  }
  body.replaceChildren(
    el('div', { class: 'aud-count', text: `${total.toLocaleString()}건 중 ${((page - 1) * pageSize + 1).toLocaleString()}–${((page - 1) * pageSize + rows.length).toLocaleString()}번째` }),
    el('div', { class: 'audit-scroll' }, tbl),
    el('p', { class: 'admin-hint', style: 'margin:6px 0 0' }, ...uiText("'원본 열람' 열은 마스킹을 우회해 원본 값을 조회한 컬럼입니다. 붉은 행은 차단된 조회입니다.")),
    audPager(page, totalPages, (n) => { f.page = n; reload(); }));
}


export {
  dbAuditEditor,
};
export { tuPageNumbers } from './admin-audit-common.js';
export { toolUsagePanel } from './admin-audit-tools.js';
export { orgAuditPanel } from './admin-audit-org.js';
