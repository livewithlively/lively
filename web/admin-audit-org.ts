// admin-audit-org.ts — #1405 W3: admin-audit.ts 분할 ③.
//  '조직 감사' 패널 — 엔티티·작업·채널 라벨 사전 + 변경 diff 렌더.
import { api, busy, cardHead, el, errorNote, relTime } from './core.js';
import { skeleton } from './ui-primitives.js';
import { audExportBtn, audExportCsv, audField, audPageSize, audPageSizeField, audPager, audPeriodField, audPeriodQs, audSelect } from './admin-audit-common.js';

// ════════ 조직 변경 감사 로그(#549) — 누가(사람/AI)·언제·무엇을·어디서(mcp/web) 바꿨는지 + before→after ════════
//  읽기 전용(admin). 백엔드=/api/ui/org/audit(src/capabilities/delivery.ts org_audit_list → org_content_audit).
//  에이전트가 MCP 로 관리기능을 만지게 열린 뒤(#549) 'AI 가 관리탭을 바꿨다'를 사람이 확인하는 표면. 필터·페이징은 tool-usage 와 동형.
//  period/from/to(#1309) — 이 탭엔 기간 필터가 아예 없어 늘 전체를 봤다. 기본값을 'all' 로 두어 그 동작을 유지한다.
const ORG_AUDIT_STATE: any = { scope: 'admin', entity: '', actor_kind: '', channel: '', op: '', period: 'all', from: '', to: '', page: 1 };

const ORG_AUDIT_PERIODS: Array<[string, string]> = [['all', '전체 기간'], ['1d', '최근 24시간'], ['7d', '최근 7일'], ['30d', '최근 30일'], ['90d', '최근 90일']];

const ORG_AUDIT_PERIOD_DAYS: Record<string, number> = { all: 0, '1d': 1, '7d': 7, '30d': 30, '90d': 90 };

const OA_ENTITY_LABELS: any = {
  org_member: '구성원', auth_token: '토큰', org_profile: '조직 프로필', org_section: '주입 섹션',
  org_runtime_config: '런타임 설정', org_connector: '외부 자료 수집(레거시)', org_collector: '수집기', org_mcp_server: '외부 도구 서버(MCP)',
  org_hook: '커스텀 훅', org_tool: 'AI 도구', org_harness_asset: '스킬·에이전트·커맨드', org_db_source: 'DB 소스',
  org_db_table_policy: '테이블 정책', org_db_column_mask: '컬럼 마스킹',
};

// op=revoke 는 auth_token 만 쓴다(org/store.ts) — 그래서 '접속 해제'로 못박는다. 언마스크 권한 철회는
//  op=update 로 감사되므로 이 라벨과 섞이지 않는다(#859).
const OA_OP_LABELS: any = { insert: '생성', update: '수정', delete: '삭제', revoke: '접속 해제', mint: '발급', reorder: '순서변경' };

const OA_CHANNEL_LABELS: any = { mcp: '에이전트(MCP)', web: '웹 관리탭', connector: '자료 수집기', cli: 'CLI', migration: '마이그레이션', unknown: '미상' };

const OA_KIND_LABELS: any = { human: '사람', ai: 'AI', system: '시스템', connector: '자료 수집기', unknown: '미상' };

// 스타일 1회 주입(테마 토큰). textContent 로만 삽입(보안 불변식).
//  ⚠ 필터바·페이저는 여기 없다 — 3탭 공용 .aud-* (styles.css, #1085). 여긴 이 탭 고유의 행·diff 표현만.
function oaEnsureStyles() {
  if (document.getElementById('oa-styles')) return;
  document.head.appendChild(el('style', { id: 'oa-styles', text: `
.oa-rows{margin-top:4px}
.oa-row{border-bottom:1px solid var(--line);padding:7px 4px}
.oa-row>summary{display:flex;gap:10px;align-items:center;cursor:pointer;list-style:none;flex-wrap:wrap}
.oa-row>summary::-webkit-details-marker{display:none}
.oa-row>summary:hover{background:var(--bg-tint)}
.oa-time{color:var(--muted);font-size:11.5px;min-width:70px}
.oa-ent{font-weight:700;color:var(--ink)}
.oa-key{color:var(--ink-sub);font-size:12px;font-family:ui-monospace,monospace;display:inline-block;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
.oa-badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;border:1px solid var(--line);background:var(--bg-tint);color:var(--ink-sub)}
.oa-badge.oa-op-delete,.oa-badge.oa-op-revoke{color:var(--coral);border-color:var(--coral)}
.oa-badge.oa-op-insert,.oa-badge.oa-op-mint{color:var(--blue);border-color:var(--blue)}
.oa-kind{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700}
.oa-kind-ai{background:var(--blue);color:#fff}
.oa-kind-human{background:var(--bg-tint);color:var(--ink);border:1px solid var(--line)}
.oa-kind-system,.oa-kind-connector,.oa-kind-unknown{background:var(--bg-tint);color:var(--ink-sub);border:1px solid var(--line)}
.oa-actor{color:var(--ink-sub);font-size:12px}
.oa-chan{color:var(--muted);font-size:11.5px;margin-left:auto}
.oa-diff{width:100%;border-collapse:collapse;font-size:12.5px;margin:8px 0 2px}
.oa-diff th{text-align:left;padding:4px 9px;font-size:10.5px;font-weight:700;color:var(--muted);border-bottom:1px solid var(--line)}
.oa-diff td{padding:5px 9px;border-bottom:1px solid var(--line);vertical-align:top;color:var(--ink)}
.oa-diff td.oa-f{font-weight:700;white-space:nowrap;color:var(--ink-sub)}
.oa-v{font-family:ui-monospace,monospace;font-size:11.5px;white-space:pre-wrap;word-break:break-word;max-width:340px;overflow:auto}
.oa-v-was{color:var(--coral)}
.oa-v-now{color:var(--ink)}
.oa-empty{color:var(--muted);font-size:13px;padding:18px 4px}
` }));
}

// before/after → 변경된 최상위 필드만(값은 JSON 비교). insert=신규(after만), delete=삭제(before만), update=바뀐 키.
function oaDiff(before, after) {
  const b = (before && typeof before === 'object') ? before : {};
  const a = (after && typeof after === 'object') ? after : {};
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
  const out: any[] = [];
  for (const k of keys) {
    if (JSON.stringify(b[k]) === JSON.stringify(a[k])) continue;
    out.push({ key: k, before: b[k], after: a[k], hadBefore: k in b, hasAfter: k in a });
  }
  return out;
}

function oaVal(v) {
  if (v === undefined) return '—';
  if (v === null) return '(없음)';   // 감사 before/after 값이 null 이면 문자 'null' 대신 '(없음)'
  if (typeof v === 'string') return v.length > 400 ? v.slice(0, 400) + '…' : v;
  try { const s = JSON.stringify(v, null, 1); return s.length > 600 ? s.slice(0, 600) + '…' : s; } catch { return String(v); }
}

async function orgAuditPanel(detail) {
  oaEnsureStyles();
  const reload = () => orgAuditPanel(detail);
  const PAGE_SIZE = audPageSize('org');   // 개인이 고르는 값 — 기본 10줄(#1085)
  const filterQs = (extra?) => {
    const q = new URLSearchParams();
    if (ORG_AUDIT_STATE.scope) q.set('scope', ORG_AUDIT_STATE.scope);
    if (ORG_AUDIT_STATE.entity) q.set('entity', ORG_AUDIT_STATE.entity);
    if (ORG_AUDIT_STATE.actor_kind) q.set('actor_kind', ORG_AUDIT_STATE.actor_kind);
    if (ORG_AUDIT_STATE.channel) q.set('channel', ORG_AUDIT_STATE.channel);
    if (ORG_AUDIT_STATE.op) q.set('op', ORG_AUDIT_STATE.op);
    // 기간(#1309) — 상대 기간도 여기서 절대시각(ISO)으로 굳혀 보낸다. 서버는 since/until 만 안다.
    const { since, until } = audPeriodQs(ORG_AUDIT_STATE, 'period', ORG_AUDIT_PERIOD_DAYS);
    if (since) q.set('since', since);
    if (until) q.set('until', until);
    for (const k in (extra || {})) q.set(k, String(extra[k]));
    return q.toString();
  };
  busy(detail, el('div', { class: 'card' }, skeleton('변경 이력을 불러오는 중')));

  const page = Math.max(1, ORG_AUDIT_STATE.page || 1);
  let r;
  try { r = await api('/api/ui/org/audit?' + filterQs({ offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE })); }
  catch (e) { detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '변경 이력을 불러오지 못했습니다'))); return; }

  const rows = r.rows || [];
  const total = r.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // ── 필터 컨트롤 — 변경 시 page=1 리셋 ──
  const mkSel = (labelText, stateKey, opts, allLabel) => audField(labelText, audSelect(
    [['', allLabel] as [string, string], ...opts.map((o) => [o.val, o.label] as [string, string])],
    ORG_AUDIT_STATE[stateKey] || '',
    (v) => { ORG_AUDIT_STATE[stateKey] = v; ORG_AUDIT_STATE.page = 1; reload(); }));
  const entityOpts = (r.entityOptions || []).map((e) => ({ val: e, label: OA_ENTITY_LABELS[e] || e }));
  const kindOpts = (r.actorKindOptions || []).map((k) => ({ val: k, label: OA_KIND_LABELS[k] || k }));
  const chanOpts = (r.channelOptions || []).map((c) => ({ val: c, label: OA_CHANNEL_LABELS[c] || c }));
  const opOpts = (r.opOptions || []).map((o) => ({ val: o, label: OA_OP_LABELS[o] || o }));

  const scopeSel = audSelect([['admin', '관리 항목만'], ['all', '전체 · 지식·프로젝트 포함']],
    ORG_AUDIT_STATE.scope || 'admin',
    (v) => { ORG_AUDIT_STATE.scope = v; ORG_AUDIT_STATE.page = 1; reload(); });

  const anyFilter = ORG_AUDIT_STATE.entity || ORG_AUDIT_STATE.actor_kind || ORG_AUDIT_STATE.channel || ORG_AUDIT_STATE.op;
  const controls = el('div', { class: 'aud-filters' },
    audPeriodField(ORG_AUDIT_PERIODS, ORG_AUDIT_STATE, 'period', () => { ORG_AUDIT_STATE.page = 1; reload(); }),
    audField('범위', scopeSel),
    mkSel('종류', 'entity', entityOpts, '모든 종류'),
    mkSel('행위자', 'actor_kind', kindOpts, '사람·AI 전체'),
    mkSel('경로', 'channel', chanOpts, '모든 경로'),
    mkSel('작업', 'op', opOpts, '모든 작업'),
    audPageSizeField('org', () => { ORG_AUDIT_STATE.page = 1; reload(); }),
    el('div', { class: 'aud-right' },
      anyFilter ? el('button', { class: 'btn btn-ghost btn-sm', text: '필터 해제',
        onclick: () => { ORG_AUDIT_STATE.entity = ''; ORG_AUDIT_STATE.actor_kind = ''; ORG_AUDIT_STATE.channel = ''; ORG_AUDIT_STATE.op = ''; ORG_AUDIT_STATE.page = 1; reload(); } }) : null,
      audExportBtn(() => audExportCsv('org', new URLSearchParams(filterQs()))),
      el('button', { class: 'btn btn-ghost btn-sm', text: '새로고침', onclick: reload })));

  // ── 행 리스트(펼치면 필드별 이전→이후) ──
  const list = el('div', { class: 'oa-rows' });
  const renderRow = (c) => {
    const kind = c.actor_kind || 'unknown';
    const diff = oaDiff(c.before, c.after);
    const diffBody = el('tbody');
    for (const d of diff) diffBody.append(el('tr', {},
      el('td', { class: 'oa-f', text: d.key }),
      el('td', {}, el('div', { class: 'oa-v oa-v-was', text: d.hadBefore ? oaVal(d.before) : '—' })),
      el('td', {}, el('div', { class: 'oa-v oa-v-now', text: d.hasAfter ? oaVal(d.after) : '(삭제됨)' }))));
    const diffTable = diff.length
      ? el('table', { class: 'oa-diff' }, el('thead', {}, el('tr', {}, el('th', { text: '필드' }), el('th', { text: '이전' }), el('th', { text: '이후' }))), diffBody)
      : el('div', { class: 'oa-empty', text: '바뀐 내용이 없습니다 — 메타 정보만 갱신됐습니다.' });
    return el('details', { class: 'oa-row' },
      el('summary', {},
        el('span', { class: 'oa-time', text: relTime(c.at) }),
        el('span', { class: 'oa-kind oa-kind-' + kind, text: OA_KIND_LABELS[kind] || kind }),
        el('span', { class: 'oa-actor', text: c.actor_display || c.actor || '—' }),
        el('span', { class: 'oa-ent', text: OA_ENTITY_LABELS[c.entity] || c.entity }),
        c.entity_key ? el('span', { class: 'oa-key', text: c.entity_key, title: c.entity_key }) : null,
        el('span', { class: 'oa-badge oa-op-' + c.op, text: OA_OP_LABELS[c.op] || c.op }),
        el('span', { class: 'oa-chan', text: OA_CHANNEL_LABELS[c.channel] || c.channel || '' })),
      diffTable);
  };
  if (!rows.length) list.append(el('div', { class: 'oa-empty', text: '이 조건의 변경 이력이 없습니다.' }));
  for (const c of rows) list.append(renderRow(c));

  const pagerBox = audPager(page, totalPages, (n) => { ORG_AUDIT_STATE.page = n; reload(); });
  const shown = rows.length
    ? `${total.toLocaleString()}건 중 ${((Math.min(page, totalPages) - 1) * PAGE_SIZE + 1).toLocaleString()}–${((Math.min(page, totalPages) - 1) * PAGE_SIZE + rows.length).toLocaleString()}번째`
    : '';

  const card = el('div', { class: 'card' },
    cardHead('관리 변경 이력', '구성원·접속 토큰·런타임·외부 자료 수집·DB 소스·훅·도구 등 관리 항목이 언제 누구에 의해 어떤 경로로 바뀌었는지 기록합니다. 각 줄을 펼치면 바뀐 필드의 이전과 이후를 볼 수 있습니다. 시크릿 값은 마스킹해 보관합니다. AI에게 물어보거나 MCP 도구 org_audit_list 로도 조회할 수 있습니다.'),
    controls,
    shown ? el('div', { class: 'aud-count', text: shown }) : null,
    list, pagerBox);
  detail.replaceChildren(card);
}

export { orgAuditPanel };
