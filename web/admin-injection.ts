// admin-injection.ts — [세션 주입] 패널 (#1313 R39, admin.ts 에서 분리 · #5159 세부 페이지로 재조판).
//  ⚠ injectionMap 안의 조립 함수 대부분은 지역 rc(runtimeConfig) · hooks · canEdit · data 를 클로저로 캡처한다.
//   그 캡처를 인자로 펴는 일(진짜 승격)은 **별도 항목**이다. 캡처가 하나도 없는 조각만 모듈 최상위에 있다:
//     WORK_EVENTS · HANDLED · EVENT_LABEL · jump · openPreview · guideKey · SECTION_HINT · tokenRow · hookRow · hookOrder · injectionStatus.
//
//  #5159(원준 2026-10-29) — "세로로 쭉 늘어져 있다 · 스크롤 안 해도 되게 · 레이아웃을 다시". 다섯 시점을 한 판에
//   세로로 쌓던 것(실측 1440 폭에서 이 패널만 2,900px)을 **시점 하나 = 세부 페이지 하나**로 갈랐다. 왼쪽 목차는
//   context-deliver.ts 가 그리고, 여기는 `only` 로 받은 시점 하나만 2단으로 그린다. 저장 경로·필드는 그대로다.
import { api, busy, el, errorNote, renderMarkdown, replaceKids, state, toast, uiText } from './core.js';
import { overlay } from './ui-primitives.js';
import { dlvBox, dlvHead, dlvSwitch, dlvTitleN } from './lib/dlv.js';
// 변경 이력(#1562) — 위키 문서 패널을 그대로 쓴다. 섹션은 knowledge 행이라 같은 엔드포인트가 덮고,
//  서버가 org_section 축 감사까지 합쳐 준다(관리탭에서 한 편집과 위키에서 한 편집이 한 타임라인에 온다).
import { openKnHistory } from './wiki-history.js';

// 시점 페이지가 맡는 이벤트 — 세션 시작(SessionStart) · 작업 중(메시지마다 · 도구 직전 · 도구 직후) · 세션 종료(Stop).
//  #5159 후속(원준 2026-10-30) — "커스텀 훅이 엄청 많았는데 왜 4·4·2 개밖에 안 보이나". 종전엔 작업 중이 PostToolUse
//   하나만 맡아, 일하는 동안 도는 UserPromptSubmit(12)·PreToolUse(4)가 「기타 이벤트」로 빠져 있었다. 셋 다 «작업 중»이다.
//   이 목록 밖의 이벤트(SubagentStop · Notification …)만 '기타 이벤트' 페이지로 간다 — 없으면 목차에서 숨는다.
const WORK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'];
const HANDLED = ['SessionStart', ...WORK_EVENTS, 'Stop'];
// 이벤트 → 사람 말. 훅 목록의 묶음 제목이 이걸 쓴다(이벤트 이름은 옆에 그대로 붙인다 — 검색·대조용).
const EVENT_LABEL: Record<string, string> = {
  SessionStart: '세션이 열릴 때', UserPromptSubmit: '메시지를 보낼 때마다', PreToolUse: '도구를 쓰기 직전',
  PostToolUse: '도구를 쓴 직후', Stop: '턴이 끝날 때',
};

/** 세부 페이지 키 — URL `#/context/deliver/<key>` 와 같다. */
export type InjectionMoment = 'start' | 'work' | 'stop' | 'events' | 'kit';

// 딥링크 — 정식 편집 집으로 이동(섹션 / WIKI 탭). tab 을 주면 그 화면의 서브탭까지 맞춘다.
//  (#837 병합 후 필요해졌다: '커스텀 훅 편집 →'이 [스킬·훅] 화면엔 가지만 **스킬 탭**에 떨어지면
//   사용자는 훅을 못 찾는다 — 링크가 가리킨 곳과 도착지가 달라진다.)
const jump = (label, hash, tab?) => el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: label, onclick: () => {
  if (tab) { state.admin.tab = state.admin.tab || {}; state.admin.tab[tab.section] = tab.key; }
  location.hash = hash;
} });
const HOOKS_TAB = { section: 'agent-assets', key: 'hooks' };

// ── 훅 주입 미리보기(V4-P5 J절) — 세션 시작 훅이 실제로 주입하는 최종 메시지. ──
//  데이터 출처: GET /api/ui/org/hooks/preview (scope null = 인증만, REST 전용). 읽기 전용.
//  보안: 모든 데이터 텍스트는 textContent(el text:)/renderMarkdown(createElement+textContent) 로만 — innerHTML 데이터주입 0.
//  #5159 — 펼침(본문 안 340px 상자)에서 창으로 옮겼다. 펼치면 페이지가 그만큼 길어지는데, 이 전문은 «가끔 확인»하는 것이다.
function openPreview() {
  const box = el('div', { class: 'md-rendered admin-md-box dlv-preview' });
  busy(box, el('p', { class: 'admin-hint' }, ...uiText('주입 전문을 불러오는 중…')));
  overlay('세션 시작에 주입되는 전문', el('div', { class: 'mem-modal' },
    el('p', { class: 'admin-hint' }, ...uiText('게이트웨이가 지금 조립하는 내용 그대로입니다. 구성원 다음 세션에 이 글이 들어갑니다.')), box));
  void (async () => {
    try {
      const r = await api('/api/ui/org/hooks/preview');
      const sp = ((r && r.hooks) || []).find((h) => h.id === 'session-preload');
      replaceKids(box, sp && sp.message ? renderMarkdown(sp.message) : el('p', { class: 'admin-hint' }, ...uiText('미리볼 내용이 없습니다.')));
    } catch (e) { replaceKids(box, errorNote(e, '미리보기를 불러오지 못했습니다(서버 재시작 후 제공)')); }
  })();
}

// 세션 시작 문서(#335) — 항상-주입 '섹션 문서'(injection='always' 행)를 N개 관리(추가/편집/삭제/재정렬). sort 순으로 조립.
//  실제 순서(publish.ts): 조직 헤더(자동) → [섹션들 sort 순]. 각 섹션 본문의 ${team}/${categories}/${wiki} 는 매 세션 실데이터로 치환.
const guideKey = 'context-ontology-guide';
const SECTION_HINT = {
  'org-defaults': '회사 배경 + 항상 지킬 규칙 + AI 말투 (회사 소개·규칙·성격)',
  // #1245 — 제품 소유(잠금): 본문은 코드 단일 출처라 편집 불가, 릴리스마다 자동 갱신. org 는 주입 여부만 정한다.
  'context-ontology-guide': 'AI 가 라이블리(맥락·카테고리·프로젝트·지식) 쓰는 법을 익히는 문서 — 제품이 관리하며 업데이트마다 자동 갱신됩니다.',
};
const tokenRow = (token, label, sub, btn?) => el('div', { class: 'dlv-token' },
  el('code', { class: 'dlv-token-k', text: token }),
  el('div', { class: 'dlv-token-b' }, el('b', { text: label }), el('span', { text: sub })),
  btn || null);

// 커스텀 훅 한 줄 — 이름(모노) · 하는 일 한 줄 · 조건(매처·하네스) · 출처 배지(제품 기본/조직 정의) · 켜짐/꺼짐.
//  locked = 제품이 시딩한 훅(코드가 단일 출처 — lockedHookIds). withEvent 면 이벤트 이름을 조건 앞에 단다(기타 이벤트 페이지).
function hookRow(h, locked: Set<string>, withEvent = false) {
  const off = h.enabled === false;
  const what = h.summary || (h.label && h.label !== h.id ? h.label : '');
  const cond = [withEvent ? h.event : null, h.matcher ? '도구 ' + h.matcher : null, h.harness && h.harness !== 'all' ? h.harness + ' 전용' : null]
    .filter(Boolean).join(' · ');
  return el('div', { class: 'dlv-hook' + (off ? ' off' : '') },
    el('div', { class: 'dlv-hook-b' },
      el('div', { class: 'dlv-hook-t' },
        el('code', { class: 'dlv-hook-id', text: h.id }),
        cond ? el('span', { class: 'dlv-hook-m', text: cond, title: cond }) : null),
      what ? el('div', { class: 'dlv-hook-s' }, ...uiText(what)) : null),
    el('div', { class: 'dlv-hook-a' },
      el('span', { class: 'dlv-tag', text: locked.has(h.id) ? '제품 기본' : '조직 정의',
        title: locked.has(h.id) ? '라이블리가 넣은 훅 — 본문은 코드가 관리합니다(켜고 끄기만 가능)' : '이 조직이 직접 정의한 훅' }),
      el('span', { class: 'dlv-hook-st' + (off ? ' off' : ''), text: off ? '꺼짐' : '켜짐' })));
}
// 목록 순서 — 켜진 것 먼저, 그다음 정의 순(sort) · 이름순.
const hookOrder = (a, b) => (a.enabled === false ? 1 : 0) - (b.enabled === false ? 1 : 0)
  || (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.id).localeCompare(String(b.id));

/** 세 시점 밖 이벤트의 훅 수 — 0 이면 목차가 「기타 이벤트」를 숨긴다(빈 페이지로 안내하지 않는다). */
export function otherHookCount(data): number {
  return (data.orgHooks || []).filter((h) => !HANDLED.includes(h.event)).length;
}

/** 왼쪽 목차의 상태 — 시점마다 켜짐 여부와 개수. 저장이 일어나면 context-deliver 가 다시 부른다. */
export function injectionStatus(data): Record<InjectionMoment, { on: boolean | null; meta: string }> {
  const rc = data.runtimeConfig || data.injectionConfig;
  const hooks = (rc && rc.hooks) || {};
  const orgHooks = data.orgHooks || [];
  const n = (...evs) => orgHooks.filter((h) => evs.includes(h.event)).length;
  const hk = (k) => (k ? ' · 훅 ' + k : '');
  return {
    start: { on: hooks.session_preload !== false, meta: '문서 ' + Object.keys(data.sections || {}).length + hk(n('SessionStart')) },
    work: { on: hooks.work_flag !== false, meta: hk(n(...WORK_EVENTS)).slice(3) },
    stop: { on: hooks.stop_writeback_gate !== false, meta: hk(n('Stop')).slice(3) },
    events: { on: null, meta: '훅 ' + otherHookCount(data) },
    kit: { on: hooks.self_update !== false, meta: '' },
  };
}

// ════════════════════════════════════════════════════════════════════
// 세션 주입(2026-06-26) — 구 '훅' 그룹(개요·런타임 토글·주입 미리보기)을 흡수한 단일 허브.
//  AI가 매 세션 자동으로 [무엇을·언제] 받고 수행하나를 주입 시점(SessionStart·PostToolUse·Stop·기타)별로 모은다.
//  맥락 조각의 편집은 정식 집(규칙·소개 섹션 / WIKI 탭)으로 딥링크 — 새 진실 출처를 만들지 않는다(맥락의 집은 그대로).
//  여기서 인라인 편집하는 건 '전달' 설정뿐: 시점 ON/OFF · writeback 너지 · work-roots · 기록인정 툴.
//  allowlist(SSRF) 는 'AI 도구'·'DB 데이터소스' 화면 안(allowlistCard)으로, 임의 코드 훅은 '커스텀 훅'으로 분리.
//
//  only 를 주면 그 시점 하나만 그린다(#5159 세부 페이지). 안 주면 다섯 시점을 차례로 쌓는다(옛 관리탭 자리 호환).
//  onChange 는 켜고 끄기가 저장된 뒤 불린다 — 목차의 켜짐 점을 맞추는 데 쓴다.
// ════════════════════════════════════════════════════════════════════
function injectionMap(detail, data, opts: { only?: InjectionMoment; onChange?: () => void } = {}) {
  //  #4135(원준 2026-09-25) — 워크스페이스 안에서는 모두 같은 권한. 주입 설정은 구성원 누구나(org_injection_update · injectionConfig),
  //   관리자 몫은 구성원 컴퓨터에 닿는 둘뿐이다: 키트 자동 업데이트(self_update) · work_roots(디렉터리 경로).
  const isAdmin = !!data.canEdit;                // org_overview: canEdit = admin
  const rc = data.runtimeConfig || data.injectionConfig;   // admin 은 전량, 구성원은 주입 축만. 둘 다 없으면 보기 전용.
  const canEdit = !!(data.canManage ?? data.canEdit) && !!rc;
  const hooks = (rc && rc.hooks) || {};
  const orgHooks = data.orgHooks || [];
  const locked = new Set<string>(data.lockedHookIds || []);

  // 런타임 설정 부분 저장 — 서버가 patch 병합(제공 필드만 갱신)하므로 바뀐 것만 보낸다.
  async function saveRuntime(patch, okMsg?) {
    //  관리자는 종전 그대로 runtime-config(전량). 구성원은 주입 축 전용 저장 — self_update 는 서버가 «지금 값 그대로» 일 때만 넘긴다.
    const r = await api(isAdmin ? '/api/ui/org/runtime-config' : '/api/ui/org/injection-config', { method: 'POST', body: JSON.stringify(patch) });
    if (r && r.runtimeConfig) data.runtimeConfig = r.runtimeConfig;
    if (r && r.injection) data.injectionConfig = r.injection;
    toast(okMsg || '저장됨 — 구성원 다음 세션부터 반영');
  }

  // 시점 ON/OFF — hooks JSON 전체를 보내 다른 시점 값 보존. what = 스위치가 켜고 끄는 것(스크린리더 이름).
  function momentToggle(hookKey, what, onMsg, offMsg) {
    const sw = dlvSwitch(hooks[hookKey] !== false, what, !canEdit || (hookKey === 'self_update' && !isAdmin));
    sw.input.addEventListener('change', async () => {
      const on = sw.input.checked;
      try {
        await saveRuntime({ hooks: { ...hooks, [hookKey]: on } }, on ? onMsg : offMsg);
        hooks[hookKey] = on;
        // 구성원 저장은 injectionConfig 만 새로 오므로, 목차가 읽는 hooks 도 같은 객체로 맞춰 둔다.
        if (rc && rc.hooks !== hooks) rc.hooks = hooks;
        opts.onChange?.();
      } catch (e) { toast(e.message, true); sw.set(hooks[hookKey] !== false); }
    });
    return sw.wrap;
  }

  // #1245 — 제품 소유 가이드(context-ontology-guide) 주입 토글. 본문은 코드 단일 출처(편집 불가)라 org 는 이것만 정한다.
  //  상태 소스: runtimeConfig(admin) 우선, 없으면 org_sections 의 injectOntologyGuide(read-only 표시용).
  function guideInjectToggle() {
    const cur = (rc ? rc.inject_ontology_guide : data.injectOntologyGuide) !== false;
    const sw = dlvSwitch(cur, '라이블리 사용 가이드 주입', !canEdit);
    sw.input.addEventListener('change', async () => {
      const on = sw.input.checked;
      try {
        await saveRuntime({ inject_ontology_guide: on },
          on ? '가이드 주입 켜짐 — 구성원 다음 세션부터' : '가이드 주입 꺼짐 — AI 가 라이블리 사용법(맥락·카테고리·지식 기록) 안내를 받지 못합니다');
        if (rc) rc.inject_ontology_guide = on;
        data.injectOntologyGuide = on;
      } catch (e) { toast(e.message, true); sw.set(!on); }
    });
    return sw.wrap;
  }

  // 커스텀 훅(읽기 전용) + 편집 딥링크 — 시점 페이지 맨 아래, 전체 폭으로 끝까지 편다.
  //  #5159 후속(원준 2026-10-30) — "왼쪽에 조그맣게 보여주지 말고 1열 아래쪽 카드에 이어 붙여서 아래까지 쭉".
  //  이벤트가 둘 이상이면(작업 중) 이벤트마다 묶음 제목을 단다. 분류 규칙(어느 이벤트의 훅인가)을 상자 머리에 적어 둔다.
  function hookBox(events: string[]) {
    const list = orgHooks.filter((h) => events.includes(h.event));
    const groups = events.map((ev) => ({ ev, hs: list.filter((h) => h.event === ev).sort(hookOrder) })).filter((g) => g.hs.length);
    const multi = events.length > 1;
    return dlvBox(dlvTitleN('커스텀 훅', list.length),
      '하네스가 이 시점에 자동으로 실행하는 훅입니다 — AI 가 고르지 않습니다. 이벤트 ' + events.join(' · ') + ' 에 걸린 훅을 모두 보여 줍니다.',
      list.length
        ? el('div', { class: 'dlv-hooks' }, ...groups.flatMap((g) => [
          multi ? el('h5', { class: 'dlv-hooks-g' },
            el('span', { text: EVENT_LABEL[g.ev] || g.ev }), el('code', { class: 'dlv-ev', text: g.ev }), el('span', { class: 'dlv-n', text: String(g.hs.length) })) : null,
          ...g.hs.map((h) => hookRow(h, locked))]))
        : el('p', { class: 'dlv-empty', text: '이 시점의 커스텀 훅은 없습니다.' }),
      el('div', { class: 'dlv-box-acts' }, jump(list.length ? '훅 편집 →' : '+ 훅 추가', '#/system/agent-assets', HOOKS_TAB)));
  }

  // 저장 버튼 줄 — 상태 글자 + [저장]. canEdit 가 아니면 안 그린다.
  function saveRow(onSave, ...extra) {
    const btn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '저장' });
    const st = el('span', { class: 'admin-status' });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { st.textContent = (await onSave()) || '저장됨'; }
      catch (e) { toast(e.message, true); }
      btn.disabled = false;
    });
    return { row: el('div', { class: 'dlv-box-acts' }, st, ...extra, btn), st };
  }
  const lines = (ta) => ta.value.split('\n').map((l) => l.trim()).filter(Boolean);

  // 줄 단위 텍스트리스트 인라인 편집(work-roots / write_tools).
  function listEditor(title, hint, initial, fieldKey, ph) {
    const ta = el('textarea', { rows: '4', placeholder: ph || '', 'aria-label': title }); ta.value = (initial || []).join('\n'); ta.disabled = !canEdit;
    return dlvBox(title, hint, ta, canEdit ? saveRow(async () => { await saveRuntime({ [fieldKey]: lines(ta) }); }).row : null);
  }

  // #906/#959 pull_tools 전용 편집기 — 게이트웨이 프록시 MCP는 '+추가' 칩(org_mcp tools_snapshot에서 발견)으로,
  //  자체설치 MCP는 그 툴이름 prefix(예: mcp__notion__)를 textarea에 직접. session-preload 가 비-lively prefix로
  //  work-flag matcher를 세션마다 동적 배선(#959)하므로 자체설치도 커버된다 — 게이트웨이 강제 설치 불필요.
  //  textarea = 전체 pull_tools 의 편집 가능한 단일 소스. 칩은 prefix 를 '추가'만(제거는 textarea에서).
  function pullToolsEditor() {
    const proxyServers = (data.mcpServers || []).filter((s) => s.mode === 'proxy' && s.enabled !== false);
    const ta = el('textarea', { rows: '3', placeholder: 'mcp__lively__ext__   (비우면 이 기능 꺼짐)', 'aria-label': '외부 맥락 툴 접두어' });
    ta.value = ((rc && rc.pull_tools) || []).join('\n'); ta.disabled = !canEdit;
    const addPrefix = (p) => {
      const cur = lines(ta);
      if (cur.includes(p)) { toast(p + ' 는 이미 있습니다'); return; }
      cur.push(p); ta.value = cur.join('\n'); toast(p + ' 추가됨 — [저장]으로 확정');
    };
    const chip = (text, p) => el('button', { class: 'dlv-chip', type: 'button', text, onclick: () => addPrefix(p) });
    const chips = el('div', { class: 'dlv-chips' },
      chip('+ 전체 프록시', 'mcp__lively__ext__'),
      ...proxyServers.map((s) => {
        const n = (s.tools_snapshot || []).length;
        return chip('+ ' + s.name + (n ? ' ' + n : ''), 'mcp__lively__ext__' + s.name + '__');
      }));
    // #906 — write_tools 와 시맨틱이 반대(비우면 끔)라 힌트에 명시. 값이 곧 on/off + 범위다.
    return dlvBox('외부 맥락 툴', '이 접두어로 시작하는 MCP 툴을 쓰고 기록 없이 끝내면 기록을 권합니다. 비우면 꺼집니다.',
      canEdit ? chips : null, ta,
      canEdit ? el('p', { class: 'dlv-note' }, ...uiText('게이트웨이 밖에서 직접 붙인 MCP 는 그 툴 접두어(예: mcp__notion__)를 그대로 적습니다 — 세션 시작 훅이 알아서 배선합니다(#959).')) : null,
      canEdit ? saveRow(async () => { await saveRuntime({ pull_tools: lines(ta) }); }).row : null);
  }

  // 세션종료 너지 문구 — 기본값(서버 단일소스 data.writebackNoticeDefault)을 실제로 보여준다(숨은 파일 기본값 X).
  //  비우거나 기본값과 같게 저장하면 null(=기본값 사용)로 저장 → DB 는 'override 있음/없음'만 들고, 화면엔 항상 effective 값이 보임.
  function writebackEditor() {
    const def = (data.writebackNoticeDefault || '').trim();
    const cur = (rc && rc.writeback_notice) || '';
    const ta = el('textarea', { class: 'dlv-ta-tall', rows: '14', placeholder: def, 'aria-label': '기록을 권하는 문구' }); ta.value = cur || def; ta.disabled = !canEdit;
    const tag = el('span', { class: 'dlv-n', text: cur ? '직접 쓴 문구' : '기본 문구' });
    let row: any = null;
    if (canEdit) {
      const resetBtn = el('button', { class: 'btn btn-text', type: 'button', text: '기본 문구로 되돌리기' });
      const sr = saveRow(async () => {
        const v = ta.value.trim();
        const payload = (!v || v === def) ? null : v; // 비었거나 기본값과 동일 → null(기본값 사용)
        await saveRuntime({ writeback_notice: payload });
        if (rc) rc.writeback_notice = payload;
        tag.textContent = payload ? '직접 쓴 문구' : '기본 문구';
        return '저장됨';
      }, resetBtn);
      resetBtn.addEventListener('click', () => { ta.value = def; sr.st.replaceChildren(...uiText('기본 문구를 불러왔습니다 — [저장]으로 확정')); });
      row = sr.row;
    }
    return dlvBox([el('span', { text: '기록을 권하는 문구' }), tag], '비우거나 기본 문구와 같게 저장하면 기본 문구를 씁니다.', ta, row);
  }

  // ── 세션 시작 문서 목록 ── (상수·순수 조립기 guideKey·SECTION_HINT·tokenRow 는 모듈 최상위)
  // #1245 — 제품 소유 가이드 읽기 전용 뷰어. 본문은 sectionsPayload 가 항상 코드 기본값으로 채워 보낸다(실주입과 동일).
  function openGuideViewer(name) {
    const cur = (data.sections && data.sections[name]) || { body_md: '' };
    overlay('제품 가이드 · ' + name + ' (읽기 전용)', el('div', { class: 'mem-modal' },
      el('p', { class: 'admin-hint' }, ...uiText('제품이 소유하는 가이드입니다 — 본문은 코드가 단일 출처라 편집할 수 없고, 라이블리 업데이트(릴리스)마다 자동으로 최신이 됩니다. 주입 여부만 목록의 토글로 선택하세요.')),
      el('div', { class: 'md-rendered admin-md-box', style: 'max-height:420px; overflow:auto' }, renderMarkdown(cur.body_md || '')),
      // 잠금 섹션도 **이력은 연다** — 편집이 막혀 있다고 '어떻게 변해왔나'까지 가릴 이유는 없다(실측: 이 문서에도
      //  9건의 변경이 쌓여 있다). 되돌리기는 canEdit=false 로 버튼을 안 띄우고, 서버도 409 로 막는다.
      el('div', { class: 'admin-actions' }, historyBtn(name, cur, false))));
  }

  // '변경 이력' 버튼 — 위키 문서의 이력 패널을 그대로 연다(#1562).
  //  섹션은 편집 경로가 둘이라(관리탭 모달 · 위키 문서 페이지) 감사가 두 축으로 갈라져 있었는데, 서버가 그
  //  둘을 합쳐 주므로 어느 화면에서 열든 같은 전체 타임라인이 나온다.
  function historyBtn(name, cur, canRevert) {
    return el('button', {
      class: 'btn btn-ghost btn-sm', type: 'button', text: '↺ 변경 이력',
      onclick: () => openKnHistory(name, {
        canEdit: canRevert,
        currentVersion: Number(cur.version) || null,
        onReverted: () => { reloadSections(); },
      }),
    });
  }

  // 섹션 본문 편집/생성 모달 — overlay + textarea. 저장 → POST /api/ui/org/section.
  function openSectionEditor(name, sopts) {
    sopts = sopts || {};
    const isNew = !!sopts.isNew;
    if (!isNew && name === guideKey) { openGuideViewer(name); return; } // #1245 — 잠금 섹션은 편집기 대신 뷰어(서버도 409 로 차단)
    const cur = (data.sections && data.sections[name]) || { body_md: '' };
    const nameIn = el('input', { type: 'text', value: name || '', placeholder: '문서 키 (소문자·숫자·하이픈, 예: company-policy)' });
    if (!isNew) nameIn.disabled = true;
    const ta = el('textarea', { class: 'mem-edit-ta', rows: '18', placeholder: 'markdown 본문 — ${team}/${categories}/${wiki} 치환 가능' });
    ta.value = cur.body_md || '';
    const st = el('span', { class: 'admin-status' });
    const saveBtn = el('button', { class: 'btn btn-primary', type: 'button', text: isNew ? '추가' : '저장' });
    const label = (t) => el('label', { class: 'field-label', text: t });
    const root = el('div', { class: 'mem-modal' },
      isNew ? el('div', { class: 'field' }, label('문서 키'), nameIn) : null,
      el('div', { class: 'field' }, label('본문 (markdown)'), ta),
      // 기존 섹션에만 이력 — 아직 만들지 않은 문서에는 되돌아갈 버전이 없다.
      el('div', { class: 'admin-actions' }, saveBtn, isNew ? null : historyBtn(name, cur, canEdit), st));
    const back = overlay(isNew ? '주입 문서 추가' : ('주입 문서 편집 · ' + name), root);
    saveBtn.onclick = async () => {
      const section = (isNew ? nameIn.value : name).trim().toLowerCase();
      if (!section) { toast('문서 키를 입력하세요', true); return; }
      saveBtn.disabled = true; st.textContent = '저장 중…';
      try {
        await api('/api/ui/org/section', { method: 'POST', body: JSON.stringify({ section, body_md: ta.value }) });
        toast('저장됨 — 구성원 다음 세션부터 반영'); back.remove(); await reloadSections();
      } catch (e) { toast('저장 실패 — ' + e.message, true); saveBtn.disabled = false; st.textContent = ''; }
    };
  }
  async function reloadSections() {
    try { const r = await api('/api/ui/org'); if (r && r.sections) data.sections = r.sections; } catch (_) { /* 유지 */ }
    paintSections();
    opts.onChange?.();
  }
  function orderedSections() {
    return Object.entries(data.sections || {}).map(([name, s]) => ({ name, ...(s as any) }))
      .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || a.name.localeCompare(b.name));
  }
  async function moveSection(i, dir) {
    const entries = orderedSections(); const j = i + dir;
    if (j < 0 || j >= entries.length) return;
    const order = entries.map((e) => e.name);
    [order[i], order[j]] = [order[j], order[i]];
    try { await api('/api/ui/org/sections/order', { method: 'POST', body: JSON.stringify({ order }) }); await reloadSections(); }
    catch (e) { toast(e.message, true); }
  }
  async function deleteSectionUi(s) {
    // #1245 — 가이드 행 삭제는 이제 무영향(본문은 코드 소유·행 무시)이라 특수 경고 불요. 가이드 행엔 삭제 버튼 자체를 안 그린다.
    //  #3778 — 이 말이 이제 참이다: 서버가 지식과 같은 길로 지워 휴지통 ▸ 지식 탭에 선다(종전엔 말만 하고 휴지통에 안 섰다).
    if (!confirm("'" + s.name + "' 문서를 삭제할까요?\n\n매 세션 주입에서 사라집니다. 휴지통 ▸ 지식 탭에서 되살릴 수 있어요(되살리면 다시 주입됩니다).")) return;
    try { await api('/api/ui/org/section/delete', { method: 'POST', body: JSON.stringify({ section: s.name }) }); toast('삭제됨'); await reloadSections(); }
    catch (e) { toast(e.message, true); }
  }
  const ib = (text, title, onclick, disabled = false) => {
    const b = el('button', { class: 'dlv-ib', type: 'button', text, title, 'aria-label': title, onclick });
    b.disabled = disabled; return b;
  };
  const sectionsWrap = el('div', { class: 'dlv-list' });
  const docCount = el('span', { class: 'dlv-n' });
  function paintSections() {
    const entries = orderedSections();
    docCount.textContent = String(entries.length);   // 조직 헤더(자동)는 세지 않는다 — 목차의 「문서 n」과 같은 수
    const rows = entries.map((s, i) => {
      const isGuide = s.name === guideKey;
      const acts: any[] = [];
      //  재정렬(▲▼) — 가이드는 실제 DB 행이 있을 때만 의미가 있다(행 없으면 말미 렌더라 sort 대상이 없다).
      if (canEdit && (!isGuide || (s.version || 0) > 0)) {
        acts.push(ib('↑', '위로', () => moveSection(i, -1), i === 0), ib('↓', '아래로', () => moveSection(i, +1), i === entries.length - 1));
      }
      if (isGuide) {
        // #1245 — 제품 소유(잠금): 편집·삭제 없음. [보기] + 주입 토글만.
        acts.push(el('button', { class: 'btn btn-text', type: 'button', text: '보기', onclick: () => openGuideViewer(s.name) }), guideInjectToggle());
      } else if (canEdit) {
        acts.push(el('button', { class: 'btn btn-text', type: 'button', text: '편집', onclick: () => openSectionEditor(s.name, {}) }),
          el('button', { class: 'btn btn-text btn-text-danger', type: 'button', text: '삭제', onclick: () => deleteSectionUi(s) }));
      }
      return el('div', { class: 'dlv-row' },
        el('span', { class: 'dlv-row-n', text: String(i + 1) }),
        el('div', { class: 'dlv-row-b' },
          el('div', { class: 'dlv-row-t' }, el('span', { text: s.name }), isGuide ? el('span', { class: 'pill', title: '제품 소유 — 코드 단일 출처, 업데이트마다 자동 갱신 (편집 불가)', text: '제품 소유' }) : null),
          el('div', { class: 'dlv-row-s', text: SECTION_HINT[s.name] || ('v' + (s.version || 1) + ' · 갱신 ' + (s.updated_by || '—')) })),
        el('div', { class: 'dlv-row-a' }, ...acts));
    });
    replaceKids(sectionsWrap,
      el('div', { class: 'dlv-row dlv-row-auto' },
        el('span', { class: 'dlv-row-n', text: '0' }),
        el('div', { class: 'dlv-row-b' }, el('div', { class: 'dlv-row-t', text: '조직 헤더' }), el('div', { class: 'dlv-row-s', text: '조직 이름 · 지금 접속한 사람 — 자동으로 맨 앞에 붙습니다.' }))),
      ...rows);
  }
  paintSections();

  // ── 시점별 세부 페이지 ──
  const pages: Record<InjectionMoment, () => HTMLElement> = {
    start: () => el('div', { class: 'dlv-page' },
      dlvHead('세션 시작', '세션이 열릴 때 조직 헤더 다음에 아래 문서들을 순서대로 넣습니다.', {
        event: 'SessionStart',
        right: momentToggle('session_preload', '세션 시작 주입', '주입 켜짐', '주입 꺼짐 — 구성원 세션이 조직 맥락 없이 시작합니다'),
      }),
      el('div', { class: 'dlv-col' },
          dlvBox([el('span', { text: '주입 문서' }), docCount], null, sectionsWrap,
            el('div', { class: 'dlv-box-acts' },
              el('button', { class: 'btn btn-text', type: 'button', text: '실제 주입 전문 보기', onclick: openPreview }),
              canEdit ? el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '＋ 문서 추가', onclick: () => openSectionEditor('', { isNew: true }) }) : null)),
          dlvBox('자동으로 채워지는 값', '문서 본문의 ${ } 자리에 매 세션 실제 데이터가 들어갑니다.',
            el('div', { class: 'dlv-tokens' },
              tokenRow('${team}', '우리 팀', '보는 사람이 속한 팀 이름'),
              tokenRow('${categories}', '카테고리 지도', '전 카테고리(주제) 목록'),
              tokenRow('${wiki}', 'WIKI 인덱스', '핀 꽂은 지식의 제목·소환키(본문 제외)',
                el('a', { class: 'dlv-link', href: '#/knowledge?indexed=1', text: '핀 보기 →' })))),
          hookBox(['SessionStart']))),

    work: () => el('div', { class: 'dlv-page' },
      dlvHead('작업 중', '메시지를 받고 도구를 쓰는 동안 도는 것들입니다. 스위치는 작업 감지 — 도구를 쓸 때마다 라이블리 작업 세션인지 표시해 두고, 세션 종료 때 기록을 권할지 판단합니다.', {
        event: 'PostToolUse',
        right: momentToggle('work_flag', '작업 감지', '감지 켜짐', '감지 꺼짐'),
      }),
      el('div', { class: 'dlv-col' },
        el('div', { class: 'dlv-grid dlv-grid-2' },
          canEdit && isAdmin ? listEditor('작업 폴더 (work-roots)', '이 폴더에서 켠 세션을 라이블리 작업으로 봅니다. 한 줄에 절대경로 하나.', rc.work_roots, 'work_roots', '/Users/you/repo') : null,
          canEdit ? listEditor('기록으로 치는 툴 (write_tools)', '이 lively 툴을 쓴 세션에는 종료 때 기록을 권하지 않습니다. 비우면 기본 목록을 씁니다.', rc.write_tools, 'write_tools', 'knowledge_save') : null,
          pullToolsEditor()),
        hookBox(WORK_EVENTS))),

    stop: () => el('div', { class: 'dlv-page' },
      dlvHead('세션 종료', '작업했는데 라이블리에 남긴 기록이 없으면, 끝날 때 한 번 기록을 권합니다.', {
        event: 'Stop',
        right: momentToggle('stop_writeback_gate', '기록 권유', '기록 권유 켜짐', '기록 권유 꺼짐'),
      }),
      el('div', { class: 'dlv-col' },
        dlvBox('언제 뜨나', null, el('ol', { class: 'dlv-steps dlv-steps-row' },
          el('li', { text: '[작업 중] 감지가 이 세션을 라이블리 작업으로 표시했고' }),
          el('li', { text: '기록으로 치는 툴을 한 번도 쓰지 않았으면' }),
          el('li', { text: '세션이 끝날 때 아래 문구를 한 번 보여 줍니다.' }))),
        writebackEditor(),
        hookBox(['Stop']))),

    // 키트 자동 업데이트(#858) — 주입이 아니라 '전달' 축이지만, 발화 시점이 세션 시작이라 같은 목차에 둔다.
    //  켜져 있으면 구성원은 업데이트 명령을 손으로 돌릴 필요가 없다(새 훅·배선까지 자동으로 따라온다).
    kit: () => el('div', { class: 'dlv-page' },
      dlvHead('키트 자동 업데이트', '구성원 컴퓨터의 라이블리 키트(훅 코드·연결 설정)를 게이트웨이 최신본에 맞춥니다.', {
        event: 'SessionStart · 백그라운드',
        right: momentToggle('self_update', '키트 자동 업데이트', '자동 업데이트 켜짐 — 구성원 다음 세션부터', '자동 업데이트 꺼짐 — 구성원이 직접 업데이트 명령을 실행해야 합니다'),
      }),
      el('div', { class: 'dlv-grid dlv-grid-2' },
        dlvBox('켜 두면', null, el('ol', { class: 'dlv-steps' },
          el('li', { text: '세션이 시작될 때 키트 버전만 비교합니다.' }),
          el('li', { text: '다르면 백그라운드로 내려받아 다시 설치합니다 — 지금 세션은 방해하지 않습니다.' }),
          el('li', { text: '다음 세션부터 새 훅·연결 설정이 적용됩니다.' }))),
        dlvBox('꺼 두면', null,
          el('p', { class: 'dlv-p' }, ...uiText('훅 코드·연결 설정 변경이 구성원에게 전달되지 않습니다. 구성원이 [내 AI 세션 생성] 화면의 업데이트 명령을 직접 실행해야 합니다.')),
          el('p', { class: 'dlv-note' }, ...uiText('회사 맥락·스킬은 이 스위치와 무관하게 매 세션 적용됩니다. 구성원 한 사람만 끄려면 환경변수 LIVELY_NO_AUTO_UPDATE=1 을 씁니다.')),
          isAdmin ? null : el('p', { class: 'dlv-note' }, ...uiText('구성원 컴퓨터의 키트를 바꾸는 설정이라 관리자만 바꿉니다.'))))),

    // 기타 이벤트 — 위 3시점 외 커스텀 훅. 이벤트 순으로 한 줄씩.
    events: () => {
      const other = orgHooks.filter((h) => !HANDLED.includes(h.event))
        .slice().sort((a, b) => String(a.event).localeCompare(String(b.event)) || String(a.id).localeCompare(String(b.id)));
      return el('div', { class: 'dlv-page' },
        dlvHead('기타 이벤트', 'SubagentStop · Notification 처럼 세 시점 밖에서 도는, 코드로 정의한 훅입니다.', {
          right: jump(orgHooks.length ? '커스텀 훅 관리 →' : '+ 커스텀 훅 정의', '#/system/agent-assets', HOOKS_TAB),
        }),
        other.length
          ? el('div', { class: 'dlv-box dlv-hooks' }, ...other.map((h) => hookRow(h, locked, true)))
          : el('div', { class: 'dlv-box' }, el('p', { class: 'dlv-empty', text: '세 시점 밖의 커스텀 훅은 없습니다. 필요하면 [스킬 · 훅]에서 정의합니다.' })));
    },
  };

  const order: InjectionMoment[] = ['start', 'work', 'stop', 'kit', 'events'];
  replaceKids(detail,
    !rc ? el('p', { class: 'admin-warn' }, ...uiText('주입 설정을 불러오지 못해 보기 전용입니다. 편집 위치로의 이동만 동작합니다.')) : null,
    ...(opts.only ? [pages[opts.only]()] : order.map((k) => pages[k]())));
}

export {
  injectionMap,
};
