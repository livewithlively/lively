// context-tools.ts — [수집·증류 ▸ AI 주입기 설정 ▸ MCP 도구] 세 페이지(#5159 후속).
//
//  요구 원문(원준 2026-10-30): "고급 설정의 AI 도구 목록도 수집·증류의 AI 주입 쪽에 합치고 싶다 · 기본 도구나 훅이
//   엄청 많다는 것도 보여 주고 싶다 · 새 분류 축은 더하지 말 것(사이드바 왕복을 좀 하더라도)".
//  그래서 **이미 있는 구분 그대로** 셋으로 편다 — 관리 ▸ AI 도구의 서브탭과 같은 출처 축이다:
//   ① 기본 제공 도구 — 라이블리 MCP 서버가 직접 내는 도구(capability 중 expose.mcp + db 직등록).
//   ② 사내 API 도구 — 게이트웨이가 외부 API 를 대신 불러 주는 도구(org_tool kind=http_proxy).
//   ③ 외부 도구 서버 — 다른 회사가 만든 MCP 서버(org_mcp). 그 안의 도구 목록은 그 서버가 정한다.
//  왜 «주입» 화면에 두나: 세션이 시작될 때 켜 둔 도구의 **목록이 AI 맥락에 들어간다**(처음부터 전문 또는 이름만 —
//   always_load). 켜고 끄기와 주입 방식은 «AI 에게 무엇이 들어가나» 의 일부다. 반면 등록·자격·외부 호출 안전범위
//   (allowlist)는 «바깥과 어떻게 잇고 막나» 라 관리 ▸ AI 도구에 남긴다 — 여기선 「등록 · 편집 →」 으로만 보낸다.
//  저장 경로(API)는 관리 화면과 같다(POST /api/ui/org/tool) — 새 진실 출처를 만들지 않는다.
import { api, el, replaceKids, state, toast, uiText } from './core.js';
import { mcpFieldsEl } from './admin-widgets.js';
import { dlvBox, dlvHead, dlvSwitch, dlvTitleN } from './lib/dlv.js';

export type ToolPage = 'builtin' | 'api' | 'mcp';

// 관리 ▸ AI 도구의 해당 서브탭으로 — 등록·자격·allowlist 는 거기 산다.
const toAdmin = (label: string, tab: string, onBefore?: () => void) => el('button', {
  class: 'btn btn-ghost btn-sm', type: 'button', text: label,
  onclick: () => { onBefore?.(); state.admin.tab = state.admin.tab || {}; state.admin.tab.tools = tab; location.hash = '#/system/tools'; },
});

// ── 사용 횟수(최근 30일) — 감사의 MCP 호출 통계(mcp_call_log)를 그대로 읽는다. 새 집계를 만들지 않는다. ──
//  원준 2026-10-30: "개수가 많아서 ㄱㄴㄷ 순 말고 사용횟수 순으로도 정렬하게". 호출 기록은 관리자만 읽는다(tool_usage_stats
//   scope=admin) — 관리자가 아니면 횟수 없이 이름순만 선다. 앱 화면이 부른 호출(store_* 등)도 같은 기록에 섞여 있다.
//  한 번 받으면 5분 동안 다시 쓴다(목차를 오갈 때마다 집계 쿼리를 다시 돌리지 않게).
type Usage = Map<string, number>;
let usageCache: { at: number; p: Promise<Usage | null> } | null = null;
function usage30d(): Promise<Usage | null> {
  if (!usageCache || Date.now() - usageCache.at > 5 * 60_000) {
    usageCache = {
      at: Date.now(),
      p: api('/api/ui/tool-usage?window=30d&limit=1')
        .then((r) => new Map<string, number>(((r && r.toolOptions) || []).map((o) => [String(o.tool), Number(o.calls) || 0])))
        .catch(() => null),
    };
  }
  return usageCache.p;
}

type ToolRow = { row: HTMLElement; text: string; name: string; uses: HTMLElement };
const usesCell = () => el('span', { class: 'dlv-uses' });

// 목록 머리 — 찾기 + 정렬(사용 많은 순 · 이름순). 걸러진 수는 count 에, 줄 순서는 list 안에서 바꾼다.
function listBar(placeholder: string, rows: ToolRow[], list: HTMLElement, count: HTMLElement, isAdmin: boolean): HTMLElement {
  const input = el('input', { type: 'search', class: 'dlv-search', placeholder, 'aria-label': placeholder }) as HTMLInputElement;
  const filter = () => {
    const q = input.value.trim().toLowerCase();
    let n = 0;
    for (const r of rows) { const hit = !q || r.text.includes(q); r.row.hidden = !hit; if (hit) n++; }
    count.textContent = q ? n + ' / ' + rows.length : String(rows.length);
  };
  input.addEventListener('input', filter);
  filter();
  if (!isAdmin) return el('div', { class: 'dlv-lbar' }, input);

  let usage: Usage | null = null;
  let mode: 'uses' | 'name' = 'uses';
  const seg = (key: 'uses' | 'name', label: string) => {
    const b = el('button', { class: 'dlv-seg-b', type: 'button', text: label, 'aria-pressed': String(key === mode) });
    b.addEventListener('click', () => { mode = key; paint(); });
    return b;
  };
  const bUses = seg('uses', '사용 많은 순'); const bName = seg('name', '이름순');
  const calls = (r: ToolRow) => (usage ? usage.get(r.name) || 0 : 0);
  function paint() {
    bUses.setAttribute('aria-pressed', String(mode === 'uses')); bName.setAttribute('aria-pressed', String(mode === 'name'));
    const sorted = rows.slice().sort((a, b) => (mode === 'uses' ? calls(b) - calls(a) : 0) || a.name.localeCompare(b.name));
    list.append(...sorted.map((r) => r.row));   // 같은 노드를 다시 붙이면 자리만 옮긴다(펼침·입력 상태 유지)
  }
  void usage30d().then((u) => {
    usage = u;
    for (const r of rows) {
      const n = u ? u.get(r.name) || 0 : null;
      r.uses.textContent = n == null ? '' : n ? n.toLocaleString('ko-KR') + '회' : '—';
      r.uses.title = n == null ? '' : '최근 30일 호출 수';
    }
    if (!u) { mode = 'name'; bUses.disabled = true; bUses.title = '호출 기록을 불러오지 못했습니다'; }
    paint();
  });
  return el('div', { class: 'dlv-lbar' }, input,
    el('div', { class: 'dlv-seg', role: 'group', 'aria-label': '정렬' }, bUses, bName),
    el('span', { class: 'dlv-lbar-n', text: '횟수 = 최근 30일 호출' }));
}

// 설명의 첫 줄 — 한 줄 요약 자리라 마크다운 강조(**)는 벗긴다(글자 그대로 보이면 지저분하다).
const firstLine = (s: string) => (String(s || '').split('\n').map((l) => l.trim()).find(Boolean) || '').replace(/\*\*/g, '');

/** 목차 상태 — 페이지마다 개수(켜짐 기준). context-deliver 가 부른다. */
export function toolsStatus(data): Record<ToolPage, { on: boolean | null; meta: string }> {
  const over = new Map<string, any>();
  for (const t of (data.tools || [])) if (t.kind === 'builtin') over.set(t.name, t);
  const cands = data.builtins || [];
  const exposed = cands.filter((c) => { const o = over.get(c.name); return o ? o.enabled !== false : c.defaultExposed !== false; }).length;
  const proxy = (data.tools || []).filter((t) => t.kind === 'http_proxy');
  const servers = data.mcpServers || [];
  return {
    builtin: { on: null, meta: cands.length ? (exposed === cands.length ? String(cands.length) : exposed + ' / ' + cands.length) : '' },
    api: { on: null, meta: proxy.length ? String(proxy.filter((t) => t.enabled !== false).length) : '' },
    mcp: { on: null, meta: servers.length ? '켜짐 ' + servers.filter((s) => s.enabled !== false).length : '' },
  };
}

// ── ① 기본 제공 도구 — 노출 · 자동승인 · 주입 방식(always_load). 관리 화면의 builtinToggles 를 옮겨 왔다. ──
function builtinPage(data, onChange: () => void): HTMLElement {
  const over = new Map<string, any>();
  for (const t of (data.tools || [])) if (t.kind === 'builtin') over.set(t.name, t);
  // 정렬은 목록 머리(listBar)가 맡는다 — 사용 많은 순(관리자 기본) · 이름순.
  const alwaysOf = (c) => { const o = over.get(c.name); return o && o.always_load != null ? !!o.always_load : c.alwaysLoadDefault === true; };
  const cands = (data.builtins || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const rows: ToolRow[] = cands.map((c) => {
    const name = c.name;
    const uses = usesCell();
    const def = c.defaultExposed !== false;
    const defAlways = c.alwaysLoadDefault === true;
    const cur = () => over.get(name);
    const exposedNow = () => { const o = cur(); return o ? o.enabled !== false : def; };
    const sw = dlvSwitch(exposedNow(), name + ' 노출');
    const aa = el('input', { type: 'checkbox', 'aria-label': name + ' 자동승인' }) as HTMLInputElement;
    aa.checked = cur() ? !!cur().auto_approve : true;
    const al = el('select', { class: 'dlv-sel', 'aria-label': name + ' 주입 방식' },
      el('option', { value: '', text: '기본 · ' + (defAlways ? '처음부터 전문' : '검색하면 로드') }),
      el('option', { value: 'always', text: '처음부터 전문' }),
      el('option', { value: 'deferred', text: '검색하면 로드' })) as HTMLSelectElement;
    al.value = cur() && cur().always_load != null ? (cur().always_load ? 'always' : 'deferred') : '';
    const save = async () => {
      const always_load = al.value === '' ? null : al.value === 'always';
      const body = { name, kind: 'builtin', enabled: sw.input.checked, auto_approve: aa.checked, always_load };
      try {
        await api('/api/ui/org/tool', { method: 'POST', body: JSON.stringify(body) });
        // 관리 데이터(state.admin.data)는 같은 객체다 — 다시 받지 않고 그 자리에서 맞춘다(470행 응답을 매번 받지 않게).
        const o = cur();
        if (o) Object.assign(o, body); else { const row = { ...body }; (data.tools = data.tools || []).push(row); over.set(name, row); }
        toast('저장됨 — 구성원 다음 대화부터');
        onChange();
      } catch (e) {
        toast((e as Error).message, true);
        sw.set(exposedNow()); aa.checked = cur() ? !!cur().auto_approve : true;
      }
    };
    sw.input.addEventListener('change', save); aa.addEventListener('change', save); al.addEventListener('change', save);

    // 상세(AI 가 보는 설명 전문 + 입력 필드) — 이름을 누르면 펼친다.
    const more = el('div', { class: 'dlv-tool-more', hidden: '' },
      c.description ? el('p', { class: 'dlv-tool-desc' }, ...uiText(c.description)) : null,
      el('div', { class: 'dlv-f-l', text: '입력 필드' }),
      mcpFieldsEl(c.inputSchema));
    const nameBtn = el('button', { class: 'dlv-tool-n', type: 'button', 'aria-expanded': 'false' },
      el('code', { text: name }), c.title ? el('span', { text: c.title }) : null);
    nameBtn.addEventListener('click', () => {
      const open = more.hidden; more.hidden = !open; nameBtn.setAttribute('aria-expanded', String(open));
    });
    const row = el('div', { class: 'dlv-tool' },
      el('div', { class: 'dlv-tool-main' },
        el('div', { class: 'dlv-tool-b' },
          nameBtn,
          c.description ? el('div', { class: 'dlv-tool-s', text: firstLine(c.description) }) : null),
        el('div', { class: 'dlv-tool-a' },
          !def ? el('span', { class: 'dlv-tag', text: '기본 미노출', title: '코드 기본값은 꺼짐 — 여기서 켤 수 있습니다' }) : null,
          uses,
          al,
          el('label', { class: 'dlv-chk' }, aa, '자동승인'),
          sw.wrap)),
      more);
    return { row, name, uses, text: [name, c.title || '', c.description || ''].join(' ').toLowerCase() };
  });

  const total = el('span', { class: 'dlv-n' });
  const list = el('div', { class: 'dlv-tools' }, ...rows.map((r) => r.row));
  const alwaysN = cands.filter(alwaysOf).length;
  return el('div', { class: 'dlv-page' },
    dlvHead('기본 제공 도구', '라이블리 MCP 서버가 AI 에게 주는 도구입니다. 켜 둔 도구는 세션이 시작될 때 목록이 AI 에게 들어가고, AI 가 필요할 때 골라 부릅니다.'),
    dlvBox([el('span', { text: '도구' }), total],
      '주입 방식 — 「처음부터 전문」은 세션 시작 때 설명 전문까지 넣고(지금 ' + alwaysN + '개), 「검색하면 로드」는 이름만 넣었다가 AI 가 찾을 때 설명을 불러옵니다(Claude Code 기준 · Codex 는 모두 처음부터). 자동승인을 켜면 구성원 확인 없이 바로 실행합니다.',
      listBar('도구 이름·설명으로 찾기', rows, list, total, !!data.canEdit),
      list));
}

// ── ② 사내 API 도구 — 목록 · 켜고 끄기. 등록·편집(URL·인증·등급)은 관리 화면. ──
function apiPage(data, onChange: () => void): HTMLElement {
  const proxy = (data.tools || []).filter((t) => t.kind === 'http_proxy').slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const authWord = (t) => (t.auth_kind ? '구성원 개인 자격' : t.auth_env ? '조직 공용 자격' : '인증 없음');
  const rows: ToolRow[] = proxy.map((t) => {
    const uses = usesCell();
    const sw = dlvSwitch(t.enabled !== false, t.name + ' 활성');
    sw.input.addEventListener('change', async () => {
      //  관리 화면의 저장(toolForm)과 같은 필드를 그대로 다시 보낸다 — 바뀌는 건 enabled 하나.
      const payload = {
        name: t.name, kind: 'http_proxy', enabled: sw.input.checked, auto_approve: !!t.auto_approve,
        title: t.title || null, description: t.description || '', scope: t.scope || 'items',
        method: t.method || 'GET', url: t.url || '', input_schema: t.input_schema || undefined,
        level: t.level || 'L0', pii_scrub: !!t.pii_scrub, log_args: !!t.log_args,
        auth_env: t.auth_env || null, auth_kind: t.auth_kind || null, auth_scope_key: t.auth_scope_key || null,
      };
      try {
        await api('/api/ui/org/tool', { method: 'POST', body: JSON.stringify(payload) });
        t.enabled = sw.input.checked; toast('저장됨 — 구성원 다음 대화부터'); onChange();
      } catch (e) { toast((e as Error).message, true); sw.set(t.enabled !== false); }
    });
    const meta = [(t.method || 'GET'), t.level || 'L0', authWord(t)].join(' · ');
    const row = el('div', { class: 'dlv-tool' + (t.enabled === false ? ' off' : '') },
      el('div', { class: 'dlv-tool-main' },
        el('div', { class: 'dlv-tool-b' },
          el('div', { class: 'dlv-tool-n is-static' }, el('code', { text: t.name }), t.title ? el('span', { text: t.title }) : null),
          t.description ? el('div', { class: 'dlv-tool-s', text: firstLine(t.description) }) : null),
        el('div', { class: 'dlv-tool-a' },
          el('span', { class: 'dlv-tool-m', text: meta }),
          t.auto_approve ? el('span', { class: 'dlv-tag is-warn', text: '자동승인' }) : null,
          uses,
          toAdmin('편집', 'proxy', () => { state.admin.toolSel = t.name; }),
          sw.wrap)));
    return { row, name: t.name, uses, text: [t.name, t.title || '', t.description || '', t.url || ''].join(' ').toLowerCase() };
  });
  const total = el('span', { class: 'dlv-n' });
  const list = el('div', { class: 'dlv-tools' }, ...rows.map((r) => r.row));
  return el('div', { class: 'dlv-page' },
    dlvHead('사내 API 도구', '게이트웨이가 외부 서비스의 API 를 대신 불러 주는 도구입니다. 켜 두면 기본 제공 도구와 같은 방식으로 AI 에게 주어집니다.',
      { right: toAdmin('＋ 도구 등록', 'proxy', () => { state.admin.toolSel = '__new__'; }) }),
    dlvBox([el('span', { text: '도구' }), total],
      '등록·인증 방식·외부 호출 안전범위(allowlist)는 관리 ▸ AI 도구에서 정합니다 — 바깥과 잇는 설정이라 거기 둡니다.',
      proxy.length ? listBar('도구 이름·설명·주소로 찾기', rows, list, total, !!data.canEdit) : null,
      proxy.length ? list : el('p', { class: 'dlv-empty', text: '등록된 사내 API 도구가 없습니다.' })));
}

// ── ③ 외부 도구 서버(MCP) — 목록(읽기). 등록·연결은 관리 화면(admin). ──
function mcpPage(data): HTMLElement {
  const servers = (data.mcpServers || []).slice().sort((a, b) => Number(b.enabled !== false) - Number(a.enabled !== false) || String(a.name).localeCompare(String(b.name)));
  const way = (s) => (s.mode === 'client' ? '구성원 PC 에 직접 연결' : '게이트웨이 경유');
  const rows = servers.map((s) => {
    const n = (s.tools_snapshot || []).length;
    const meta = [way(s), s.auth_mode === 'oauth' ? '구성원이 각자 로그인' : s.auth_env ? '조직 공용 자격' : null, n ? '도구 ' + n : null].filter(Boolean).join(' · ');
    return el('div', { class: 'dlv-tool' + (s.enabled === false ? ' off' : '') },
      el('div', { class: 'dlv-tool-main' },
        el('div', { class: 'dlv-tool-b' },
          el('div', { class: 'dlv-tool-n is-static' }, el('code', { text: s.name }), el('span', { text: s.transport === 'stdio' ? (s.command || '') : (s.url || '') })),
          s.note ? el('div', { class: 'dlv-tool-s', text: firstLine(s.note) }) : null),
        el('div', { class: 'dlv-tool-a' },
          el('span', { class: 'dlv-tool-m', text: meta }),
          el('span', { class: 'dlv-hook-st' + (s.enabled === false ? ' off' : ''), text: s.enabled === false ? '꺼짐' : '켜짐' }))));
  });
  return el('div', { class: 'dlv-page' },
    dlvHead('외부 도구 서버', '다른 회사가 만든 MCP 서버를 통째로 연결한 것입니다. 그 안의 도구 목록은 그 서버가 정하고, 구성원이 연결(로그인)한 뒤부터 AI 가 씁니다.',
      { right: toAdmin('등록 · 편집 →', 'mcp') }),
    dlvBox(dlvTitleN('서버', servers.length), null,
      servers.length ? el('div', { class: 'dlv-tools' }, ...rows) : el('p', { class: 'dlv-empty', text: '연결된 외부 도구 서버가 없습니다.' })));
}

/** 페이지 하나를 그린다 — context-deliver 의 패널 자리에. */
export function renderToolPage(host: HTMLElement, page: ToolPage, data, onChange: () => void): void {
  replaceKids(host, page === 'builtin' ? builtinPage(data, onChange) : page === 'api' ? apiPage(data, onChange) : mcpPage(data));
}
