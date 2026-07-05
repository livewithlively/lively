// knowledge-doc.ts — #592 지식 문서 캔버스(노션형). 문서 렌더 단일 소스 buildKnowledgeDetail 과
//  지식 칩·라벨·상세 패널 헬퍼(knowledge.ts 에서 이관). 목록(knowledge.ts)·문서 페이지가 공유하고,
//  다음 단계의 피크 패널/카테고리 엔트리 뷰도 같은 함수를 재사용한다.
//  순환 import 금지: 이 모듈은 core/learn 만 import 한다(knowledge.ts → knowledge-doc.ts 단방향).
import { LIFECYCLE_LABEL, absTime, api, el, errorNote, renderInline, renderMarkdown, safeHref, selectFilter, state, toast, withTip } from './core.js';
import { overlayBox, skeleton, skeletonRows } from './learn.js';

// ── 라벨 사전(지식 공용) — knowledge.ts 에서 이관(#592). ──
const SPACE_LABEL = { business: '사업', product: '제품', system: '시스템' };
// injection(주입축) 한글 라벨 — 칩 표기는 짧게(항상 주입 / 검색). 힌트는 비개발자 친화 한 줄 설명.
const KN_INJECTION_LABEL = { always: '항상 주입', recalled: '검색' };
const KN_INJECTION_HINT = {
  always: '규칙·페르소나처럼 모든 세션에 항상 주입됩니다.',
  recalled: '평소엔 주입 안 됨 — AI가 관련될 때 키워드로 검색해 직접 찾아봅니다(자동·시맨틱 아님).',
};
// provenance(출처축) 한글 라벨 — authored=직접 저작, observed=외부 시스템의 살아있는 미러.
const KN_PROVENANCE_LABEL = { authored: '저작', observed: '외부 미러' };
const KN_PROVENANCE_HINT = {
  authored: '이 시스템에 직접 저작한 지식입니다.',
  observed: '외부 시스템에서 가져온 살아있는 미러입니다(진실·편집은 외부에).',
};
// 작성 주체(#449) — 이 지식을 AI 가 썼는지 사람이 썼는지(confidence 파생: mcp→ai, web→human).
const KN_AUTHOR_LABEL = { ai: 'AI 작성', human: '사람 작성', rule: '규칙', observed: '외부 미러' };
const KN_AUTHOR_HINT = {
  ai: 'AI 에이전트가 작성한 지식입니다.',
  human: '사람이 직접 작성한 지식입니다.',
  rule: '시스템 규칙으로 정의됐습니다.',
  observed: '외부 시스템에서 미러됐습니다.',
};
// page-type(#290) 한글 라벨 — 엔터프라이즈 표준(DITA/Diátaxis/ADR/LLM위키) 6종. NULL=미분류(칩 생략).
const KN_TYPE_LABEL = { decision: '결정', concept: '개념', 'how-to': 'How-to', reference: '참조', research: '리서치', entity: '엔티티' };
// 지식↔프로젝트 연결 관계(#255~257) · 지식↔지식 링크 · 자료(source) 라벨.
const KN_REL_LABEL = { required: '필요', produced: '산출' };
const KN_LINK_REL_LABEL = { related: '관련', refines: '구체화', contradicts: '모순', depends_on: '의존' };
const KN_SOURCE_REL_LABEL = { derived_from: '증류', cites: '참조' };
const SOURCE_KIND_LABEL = { transcript: '전사록', minutes: '회의록', email: '이메일', slack: '슬랙', notion_doc: '노션', clickup_doc: '클릭업', other: '기타' };

// memory 권한 보유 여부 — admin.ts hasScope 와 동일 판정(state.me.scopes). admin 을 import 하면
//  admin → knowledge → knowledge-doc 순환이 생겨 여기 로컬로 복제한다(로직 2줄, 드리프트 위험 낮음).
function hasMemoryScope() {
  return !!(state.me && Array.isArray(state.me.scopes) && state.me.scopes.includes('memory'));
}

// ── 칩 생성기(knowledge.ts 에서 이관) ──
function knTypeChip(type) {
  if (!type) return null;
  return el('span', { class: 'kn-chip kn-type kn-type-' + type, title: 'page-type · ' + type, text: KN_TYPE_LABEL[type] || type });
}
function knInjectChip(injection) {
  return el('span', { class: 'kn-chip kn-inject kn-inject-' + (injection || 'na'),
    title: KN_INJECTION_HINT[injection] || '', text: KN_INJECTION_LABEL[injection] || injection || '—' });
}
function knProvChip(provenance) {
  return el('span', { class: 'kn-chip kn-prov kn-prov-' + (provenance || 'na'),
    title: KN_PROVENANCE_HINT[provenance] || '', text: KN_PROVENANCE_LABEL[provenance] || provenance || '—' });
}
// 작성 주체 칩 — AI/사람 구분(#449). confidence 없으면 칩 생략(빈 '—' 노이즈 방지).
function knAuthorChip(confidence) {
  if (!confidence) return null;
  if (confidence === 'observed') return null; // 출처 칩(외부 미러)과 라벨 중복 — 미러 행에선 생략(#551)
  const chip = el('span', { class: 'kn-chip kn-author kn-author-' + confidence,
    text: KN_AUTHOR_LABEL[confidence] || confidence });
  return withTip(chip, KN_AUTHOR_HINT[confidence] || '');
}

// ⓘ 설명 점 — 라벨/값 옆 작은 정보 버튼(hover CSS·포커스·클릭 고정 토글). 바깥 클릭 시 닫힘. hint 없으면 null.
function infoDot(hint) {
  if (!hint) return null;
  const dot = el('button', { type: 'button', class: 'info-dot', 'aria-label': hint }, 'ⓘ',
    el('span', { class: 'info-pop', role: 'tooltip', text: hint }));
  dot.onclick = (e) => {
    e.preventDefault(); e.stopPropagation();
    const open = dot.classList.toggle('open');
    if (open) {
      const onDoc = (ev) => { if (!dot.contains(ev.target)) { dot.classList.remove('open'); document.removeEventListener('click', onDoc, true); } };
      setTimeout(() => document.addEventListener('click', onDoc, true), 0);
    }
  };
  return dot;
}

// 트리 노드 아이콘 — 노션 kind(page/database/db_row) 기준. 일반 지식(트리 부모가 된 저작 지식)은 문서 글리프.
function knTreeIcon(kind) {
  return kind === 'database' ? '🗄' : kind === 'db_row' ? '▪' : '📄';
}

// ════════════════════════════════════════════
// #592 트리 데이터 세션 캐시 — 사이드바 카테고리 트리(knowledge.ts)·이동 피커·폴더 상세가 공유.
//  authored 트리 스켈레톤(knowledge-tree?system=authored)은 세션 1회, 카테고리별 지식 rows 는 카테고리당 1회.
//  폴더 생성/이동/삭제 등 트리 변형 후엔 knInvalidateTreeCaches() 로 무효화(다음 펼침에서 재적재).
// ════════════════════════════════════════════
let knAuthoredTreePromise: Promise<any[]> | null = null;
const knCatRowsCache = new Map<string, Promise<any[]>>();

// 저작 지식 트리 스켈레톤(name/title/parent_name/sort/lifecycle/is_folder) — 폴더 자식 해소용. 실패 시 캐시 비움(재시도 가능).
function knFetchAuthoredTree(): Promise<any[]> {
  if (!knAuthoredTreePromise) {
    knAuthoredTreePromise = api('/api/ui/knowledge-tree?system=authored')
      .then((r) => (r && r.entries) || [])
      .catch((e) => { knAuthoredTreePromise = null; throw e; });
  }
  return knAuthoredTreePromise;
}

// 카테고리 지식 rows(폴더 포함, recalled 전용 — 지식탭과 동일 축) — 사이드바 펼침·이동 피커 공용.
function knFetchCategoryRows(catId): Promise<any[]> {
  const key = String(catId);
  let p = knCatRowsCache.get(key);
  if (!p) {
    p = api('/api/ui/knowledge?' + new URLSearchParams({ category: key, limit: '200', orderBy: 'updated_at', injection: 'recalled' }))
      .then((r) => (r && r.entries) || [])
      .catch((e) => { knCatRowsCache.delete(key); throw e; });
    knCatRowsCache.set(key, p);
  }
  return p;
}

function knInvalidateTreeCaches() { knAuthoredTreePromise = null; knCatRowsCache.clear(); }

// 폴더 우선 → sort → 제목순 — 사이드바 트리·폴더 드릴다운 공용 정렬(§3).
function knFolderFirstSort(a, b) {
  const fa = a.is_folder ? 0 : 1, fb = b.is_folder ? 0 : 1;
  if (fa !== fb) return fa - fb;
  const sa = Number(a.sort) || 0, sb = Number(b.sort) || 0;
  if (sa !== sb) return sa - sb;
  return String(a.title || a.name).localeCompare(String(b.title || b.name));
}

// ════════════════════════════════════════════
// #592 속성(메타데이터) 시스템 — 카탈로그(.design-592.md §1)와 노출 계산.
//  전역 기본 노출 = 카탈로그 − knowledge_view_config.hidden_props.
//  항목 최종 노출 = (전역 노출 ∪ props_ui.show) − props_ui.hide. 빈 값은 자동 생략(노션 동일).
// ════════════════════════════════════════════
const KN_PROP_CATALOG = [
  { key: 'category', label: '카테고리' },
  { key: 'type', label: '유형' },
  { key: 'confidence', label: '작성 주체' },
  { key: 'provenance', label: '출처' },
  { key: 'lifecycle', label: '상태' },
  { key: 'author', label: '작성자' },
  { key: 'injection', label: '주입' },
  { key: 'supersedes', label: '대체함' },
  { key: 'external', label: '외부 링크' },
  { key: 'occurred_at', label: '발생 시각' },
  { key: 'as_of', label: '기준 시점' },
  { key: 'last_synced_at', label: '마지막 동기화' },
  { key: 'version', label: '버전' },
  { key: 'created_at', label: '최초 작성' },
  { key: 'updated_at', label: '마지막 갱신' },
  { key: 'name', label: '파일명' },
  { key: 'summary', label: '요약' },
  { key: 'source_ref', label: '참조' },
];
// 공장 기본 hidden_props 권장(§1) — 서버에 시드하지 않고 팝오버의 '권장 기본값' 버튼으로만 제안.
const KN_PROP_RECOMMENDED_HIDDEN = ['injection', 'supersedes', 'name', 'source_ref', 'as_of', 'occurred_at', 'version', 'summary'];

// 전역 뷰 설정(hidden_props) — 세션 1회 fetch 모듈 캐시. 백엔드 미탑재/실패 시 [](전부 노출)로 graceful.
let knViewConfigCache: Promise<string[]> | null = null;
function fetchKnHiddenProps() {
  if (!knViewConfigCache) {
    knViewConfigCache = api('/api/ui/knowledge-view-config')
      .then((d) => (d && Array.isArray(d.hidden_props)) ? d.hidden_props.map(String) : [])
      .catch(() => []);
  }
  return knViewConfigCache;
}

// 항목 최종 노출 키 집합 — (전역 노출 ∪ props_ui.show) − props_ui.hide.
function knEffectiveVisible(hidden: string[], propsUi: any): Set<string> {
  const show = new Set(((propsUi && propsUi.show) || []).map(String));
  const hide = new Set(((propsUi && propsUi.hide) || []).map(String));
  const out = new Set<string>();
  for (const p of KN_PROP_CATALOG) {
    if ((!hidden.includes(p.key) || show.has(p.key)) && !hide.has(p.key)) out.add(p.key);
  }
  return out;
}

// 속성 키 → 값 렌더 — 빈 값이면 null(행 자동 생략). 값 생성 로직은 구 metaRows(knowledge.ts)에서 이관.
function knPropValue(k, key) {
  switch (key) {
    case 'category': {
      const cats = (Array.isArray(k.categories) ? k.categories : []).filter((c) => c.state !== 'rejected');
      if (!cats.length) return null;
      return { node: el('span', { class: 'kn-cat-list kn-cat-inmeta' }, ...cats.map((c) => el('span', { class: 'kn-chip kn-cat-chip',
        title: (SPACE_LABEL[c.space] || c.space || '') + ' · ' + (c.key || ''), text: c.name || c.key }))) };
    }
    case 'type': return k.type ? { node: KN_TYPE_LABEL[k.type] || k.type } : null;
    case 'confidence':
      // observed 는 '출처' 행과 라벨 중복(#551 관례) — 빈 값 취급으로 생략.
      if (!k.confidence || k.confidence === 'observed') return null;
      return { node: KN_AUTHOR_LABEL[k.confidence] || k.confidence, hint: KN_AUTHOR_HINT[k.confidence] || '' };
    case 'provenance': return k.provenance ? { node: KN_PROVENANCE_LABEL[k.provenance] || k.provenance, hint: KN_PROVENANCE_HINT[k.provenance] || '' } : null;
    case 'lifecycle': return k.lifecycle ? { node: LIFECYCLE_LABEL[k.lifecycle] || k.lifecycle } : null;
    case 'author': return k.author ? { node: k.author } : null;
    case 'injection': return k.injection ? { node: KN_INJECTION_LABEL[k.injection] || k.injection, hint: KN_INJECTION_HINT[k.injection] || '' } : null;
    case 'supersedes': return k.supersedes ? { node: el('span', { class: 'mono', text: k.supersedes }) } : null;
    case 'external': {
      // 합성 속성(§1) — external_system/instance/url 을 한 행으로.
      if (!k.external_system && !k.external_url) return null;
      const parts: any[] = [];
      if (k.external_system) parts.push(el('span', { text: k.external_system + (k.external_instance ? ' · ' + k.external_instance : '') }));
      if (k.external_url) {
        const safe = safeHref(k.external_url);   // P4b: 데이터 href 는 safeHref 경유(위험 스킴 → 평문 폴백)
        parts.push(safe
          ? el('a', { class: 'md-link', href: safe, target: '_blank', rel: 'noopener noreferrer',
              text: (k.external_system === 'notion' ? 'Notion에서 열기' : '원본에서 열기') + ' ↗' })
          : el('span', { text: k.external_url }));
      }
      return { node: el('span', { class: 'kn-prop-ext' }, ...parts) };
    }
    case 'occurred_at': return k.occurred_at ? { node: absTime(k.occurred_at) } : null;
    case 'as_of': return k.as_of ? { node: absTime(k.as_of) } : null;
    case 'last_synced_at': return k.last_synced_at ? { node: absTime(k.last_synced_at) } : null;
    case 'version': return k.version != null ? { node: 'v' + k.version } : null;
    case 'created_at': return k.created_at ? { node: absTime(k.created_at) } : null;
    case 'updated_at': return k.updated_at ? { node: absTime(k.updated_at) + (k.updated_by ? ' · ' + k.updated_by : '') } : null;
    case 'name': return k.name ? { node: el('span', { class: 'mono', text: k.name }) } : null;
    case 'summary': return k.summary ? { node: k.summary } : null;
    case 'source_ref': return k.source_ref ? { node: k.source_ref } : null;
  }
  return null;
}

// 속성 한 행 — 라벨(130px muted) + 값(+힌트 ⓘ). 노션형 세로 리스트.
function knPropRow(label, value, hint?) {
  const v = el('div', { class: 'kn-prop-v' });
  v.append(value && (value as any).nodeType ? value : el('span', { text: String(value) }));
  if (hint) v.append(infoDot(hint));
  return el('div', { class: 'kn-prop' }, el('span', { class: 'kn-prop-k', text: label }), v);
}

// props_ui 부분 병합 저장 — 응답 {props_ui} 를 로컬 k 에 반영(뷰 설정은 version 안 올림 — 계약 §2).
async function saveKnPropsUi(k, patch) {
  const r = await api('/api/ui/knowledge/' + encodeURIComponent(k.name) + '/props-ui',
    { method: 'POST', body: JSON.stringify(patch) });
  k.props_ui = (r && r.props_ui) || Object.assign({}, k.props_ui || {}, patch);
}

// ⚙ 속성 설정 팝오버 — 카탈로그 전체를 👁 토글 리스트로. 저장 2종: 이 문서에만(props-ui) / 전체 기본값(view-config).
//  저장 성공 시 onChanged() 로 속성 블록 즉시 재렌더(팝오버는 재렌더로 함께 닫힘).
function openKnPropsSettings(foot, gear, k, hidden: string[], onChanged) {
  const existing = foot.querySelector('.kn-props-pop');
  if (existing) { existing.remove(); return; }
  const vis = knEffectiveVisible(hidden, k.props_ui);
  const toggles = new Map(KN_PROP_CATALOG.map((p) => [p.key, vis.has(p.key)]));
  const list = el('div', { class: 'kn-props-pop-list' });
  function paintList() {
    list.replaceChildren(...KN_PROP_CATALOG.map((p) => {
      const on = !!toggles.get(p.key);
      const eye = el('button', { class: 'kn-propopt-eye', type: 'button', 'aria-pressed': String(on),
        title: on ? '숨기기' : '보이기', text: on ? '👁' : '－' });
      eye.onclick = () => { toggles.set(p.key, !toggles.get(p.key)); paintList(); };
      return el('div', { class: 'kn-propopt' + (on ? '' : ' off'), title: p.key },
        el('span', { class: 'kn-propopt-label', text: p.label }), eye);
    }));
  }
  paintList();
  // 권장 기본값(§1 공장 제안) — 서버 시드 없이 토글 상태만 제안(저장은 아래 버튼으로).
  const recBtn = el('button', { class: 'kn-props-rec', type: 'button',
    title: '권장 노출 조합으로 토글을 맞춥니다(아직 저장 안 됨)', text: '권장 기본값' });
  recBtn.onclick = () => { for (const p of KN_PROP_CATALOG) toggles.set(p.key, !KN_PROP_RECOMMENDED_HIDDEN.includes(p.key)); paintList(); };
  const docBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '이 문서에만 저장',
    title: '이 문서의 속성 노출만 바꿉니다(props_ui — 전역 기본값과의 차이만 저장)' });
  const allBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '전체 기본값으로 저장',
    title: '모든 지식 문서의 기본 속성 노출을 이 조합으로 바꿉니다(knowledge_view_config)' });
  const busy = (b) => { (docBtn as any).disabled = b; (allBtn as any).disabled = b; };
  docBtn.onclick = async () => {
    busy(true);
    try {
      // 전역 기본과의 차이만 오버라이드로 — show=전역숨김인데 켬, hide=전역노출인데 끔.
      const show: string[] = [], hide: string[] = [];
      for (const p of KN_PROP_CATALOG) {
        const on = !!toggles.get(p.key);
        const globalOn = !hidden.includes(p.key);
        if (on && !globalOn) show.push(p.key);
        else if (!on && globalOn) hide.push(p.key);
      }
      await saveKnPropsUi(k, { show, hide });
      toast('이 문서의 속성 표시를 저장했습니다');
      onChanged();
    } catch (e) { toast('저장 실패 — ' + e.message, true); busy(false); }
  };
  allBtn.onclick = async () => {
    busy(true);
    try {
      const hidden_props = KN_PROP_CATALOG.filter((p) => !toggles.get(p.key)).map((p) => p.key);
      await api('/api/ui/knowledge-view-config', { method: 'POST', body: JSON.stringify({ hidden_props }) });
      knViewConfigCache = Promise.resolve(hidden_props);   // 캐시 즉시 갱신(재fetch 없이 반영)
      toast('전체 기본 속성 표시를 저장했습니다');
      onChanged();
    } catch (e) { toast('저장 실패 — ' + e.message, true); busy(false); }
  };
  const pop = el('div', { class: 'kn-props-pop' },
    el('div', { class: 'kn-props-pop-head' }, el('span', { text: '속성 표시' }), recBtn),
    list,
    el('div', { class: 'kn-props-pop-actions' }, docBtn, allBtn));
  foot.append(pop);
  // 바깥 클릭/ESC 닫기 — 기어 버튼 자체 클릭은 무시(onclick 토글이 remove/re-open 이중동작 안 하게).
  const close = () => { pop.remove(); document.removeEventListener('click', onDoc, true); document.removeEventListener('keydown', onKey); };
  const onDoc = (ev) => { if (pop.contains(ev.target) || gear.contains(ev.target)) return; close(); };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  setTimeout(() => { document.addEventListener('click', onDoc, true); document.addEventListener('keydown', onKey); }, 0);
}

// 속성 블록(노션형) — 보이는 속성 세로 리스트 + '속성 n개 숨김 ▾'(일시 펼침) + ⚙ 속성 설정.
function buildKnPropsBlock(k, hidden: string[], opts) {
  const vis = knEffectiveVisible(hidden, k.props_ui);
  const rows: any[] = [], hiddenRows: any[] = [];
  for (const p of KN_PROP_CATALOG) {
    const v = knPropValue(k, p.key);
    if (!v) continue;   // 빈 값 자동 생략(노션 동일)
    (vis.has(p.key) ? rows : hiddenRows).push({ p, v });
  }
  const body = el('div', { class: 'kn-props-rows' });
  const foot = el('div', { class: 'kn-props-foot' });
  const gear = opts.canEdit
    ? el('button', { class: 'kn-props-gear', type: 'button', title: '속성 노출을 문서/전체 단위로 설정합니다',
        text: '⚙ 속성 설정', onclick: () => openKnPropsSettings(foot, gear, k, hidden, opts.onChanged) })
    : null;
  let revealed = false;   // '숨김 ▾' 일시 펼침(저장 아님 — 화면에서만)
  const paint = () => {
    body.replaceChildren(
      ...rows.map(({ p, v }) => knPropRow(p.label, v.node, v.hint)),
      ...(revealed ? hiddenRows.map(({ p, v }) => {
        const r = knPropRow(p.label, v.node, v.hint);
        r.classList.add('kn-prop-dim');
        return r;
      }) : []));
    const footKids: any[] = [];
    if (hiddenRows.length) footKids.push(el('button', { class: 'kn-props-more', type: 'button',
      text: revealed ? '숨긴 속성 접기 ▴' : '속성 ' + hiddenRows.length + '개 숨김 ▾',
      onclick: () => { revealed = !revealed; paint(); } }));
    if (gear) footKids.push(gear);
    foot.replaceChildren(...footKids);
  };
  paint();
  return el('div', { class: 'kn-props' }, body, foot);
}

// ════════════════════════════════════════════
// 상세 하위 패널들(knowledge.ts 에서 이관) — 하위 페이지·노션 속성·연결 지식·연결 프로젝트·비슷한 지식.
// ════════════════════════════════════════════

// 상세 '하위 페이지' — parent_name 이 이 지식인 자식들(sort 순). 없으면 렌더 생략(null).
function knChildrenPanel(k) {
  const children = Array.isArray(k.children) ? k.children : [];
  if (!children.length) return null;
  const rows = children.map((c) => el('a', {
    class: 'kn-linkrow' + (c.lifecycle === 'archived' ? ' kn-row-archived' : ''),
    href: '#/k/' + encodeURIComponent(c.name) },
    el('span', { class: 'kn-link-rel kn-link-child', text: knTreeIcon(c.notion_kind) }),
    el('span', { class: 'kn-linkrow-title', text: (c.title || c.name) + (c.lifecycle === 'archived' ? ' (보관됨)' : '') })));
  return el('div', { class: 'kn-links' },
    el('div', { class: 'sec-label sec-label-row' }, el('span', { text: '하위 페이지' }),
      el('span', { class: 'kn-sim-hint', text: children.length + '개' })),
    el('div', { class: 'kn-linkrows' }, ...rows));
}

// 상세 '속성(Notion)' — fields.notion.properties({이름:{type,text}}) 를 메타바 그리드로(동적 속성 — #592 카탈로그 밖, 별도 유지).
function knNotionPropsPanel(k) {
  const props = k.fields && k.fields.notion && k.fields.notion.properties;
  const entries = props ? Object.entries(props).filter(([, v]: any) => v && (v.text || v.type)) : [];
  if (!entries.length) return null;
  const bar = el('div', { class: 'unit-metabar' });
  for (const [pname, pv] of entries as any) {
    bar.append(el('div', { class: 'umeta' },
      el('span', { class: 'umeta-k', text: pname }),
      el('span', { class: 'umeta-v' }, pv.text ? renderInline(String(pv.text)) : el('span', { class: 'umeta-empty', text: '—' }))));
  }
  return el('details', { class: 'unit-meta-details', open: '' },
    el('summary', { class: 'unit-meta-summary' }, '속성 (Notion)'), bar);
}

// 연결된 지식 한 줄(리스트, 옵시디언식) — [관계 pill][제목 전체폭·한 줄][✕ hover]. 행 전체 클릭=상세 이동.
//  incoming=true 면 백링크(해제 방향 반전: from=상대, to=이 지식). reload = 부모 문서 재렌더 콜백.
function knLinkRow(e, k, reload, incoming) {
  const row = el('a', { class: 'kn-linkrow', href: '#/k/' + encodeURIComponent(e.name) },
    el('span', { class: 'kn-link-rel kn-link-' + e.relation, text: KN_LINK_REL_LABEL[e.relation] || e.relation }),
    el('span', { class: 'kn-linkrow-title', text: e.title || e.name }));
  if (hasMemoryScope()) {
    const x = el('button', { class: 'kn-linkrow-x', type: 'button', title: '연결 해제', text: '✕' });
    x.onclick = async (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const from = incoming ? e.name : k.name, to = incoming ? k.name : e.name;
      try {
        await api('/api/ui/knowledge/' + encodeURIComponent(from) + '/link', { method: 'POST', body: JSON.stringify({ to, relation: e.relation, unlink: true }) });
        toast('연결을 해제했습니다'); reload();
      } catch (err) { toast('해제 실패 — ' + err.message, true); }
    };
    row.append(x);
  }
  return row;
}

// 상세 '연결된 지식' — 방향(→ 포워드 / ← 백링크) 두 그룹 + 컴팩트 리스트 + 출처 자료.
function knLinksPanel(k, reload) {
  const links = k.links || { outgoing: [], incoming: [] };
  const out = links.outgoing || [], inc = links.incoming || [], sources = k.sources || [];
  const head = el('div', { class: 'sec-label sec-label-row' }, el('span', { text: '연결된 지식' }),
    hasMemoryScope() ? el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 지식 연결',
      title: '교차주제는 카테고리 복수태깅 대신 지식끼리 연결로 잇습니다', onclick: () => openKnowledgeLinkPicker(k, reload) }) : null);
  const bodyEl = el('div', { class: 'kn-links-body' });
  const dirGroup = (label, arr, incoming) => el('div', { class: 'kn-linkdir' },
    el('span', { class: 'kn-linkdir-head', text: label }),
    el('div', { class: 'kn-linkrows' }, ...arr.map((e) => knLinkRow(e, k, reload, incoming))));
  if (!out.length && !inc.length) {
    bodyEl.append(el('div', { class: 'kn-cat-empty', text: '아직 연결된 지식이 없어요. ＋지식 연결로 관련된 지식을 이어보세요.' }));
  } else {
    if (out.length) bodyEl.append(dirGroup('이 지식에서 연결한 글  →', out, false));
    if (inc.length) bodyEl.append(dirGroup('←  이 지식을 연결한 글 (백링크)', inc, true));
  }
  const box = el('div', { class: 'kn-links' }, head, bodyEl);
  if (sources.length) {
    const srcRows = sources.map((s) => {
      const row = el('div', { class: 'kn-linkrow', role: 'button', tabindex: '0', style: 'cursor:pointer' },
        el('span', { class: 'kn-link-rel kn-link-source', title: SOURCE_KIND_LABEL[s.kind] || s.kind, text: KN_SOURCE_REL_LABEL[s.relation] || s.relation }),
        el('span', { class: 'kn-linkrow-title', text: s.title || ('자료 #' + s.source_id) }));
      row.onclick = () => openSourceDetail(s.source_id);
      return row;
    });
    box.append(el('div', { class: 'sec-label', text: '출처 자료' }), el('div', { class: 'kn-linkrows' }, ...srcRows));
  }
  return box;
}

// 지식 링크 추가 — 관계 선택 + 대상 검색(grep) → 클릭 연결. reload = 부모 문서 재렌더 콜백.
function openKnowledgeLinkPicker(k, reload) {
  const relSel = selectFilter([['related', '관련'], ['refines', '구체화'], ['contradicts', '모순'], ['depends_on', '의존']], 'related');
  const qIn = el('input', { type: 'search', placeholder: '연결할 지식 검색(제목·본문)' });
  const results = el('div', { class: 'list-box', style: 'max-height:320px; overflow:auto; margin-top:10px;' });
  const back = overlayBox('지식 링크 추가 · ' + (k.title || k.name),
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '관계' }), relSel),
    el('div', { class: 'field', style: 'margin-top:10px' }, el('label', { class: 'field-label', text: '대상 지식' }), qIn),
    results);
  let t: any = null;
  async function search() {
    const q = qIn.value.trim();
    results.replaceChildren(skeletonRows(2));
    try {
      const url = q ? ('/api/ui/knowledge/search?' + new URLSearchParams({ q, limit: '15' }))
        : ('/api/ui/knowledge?' + new URLSearchParams({ limit: '15', orderBy: 'updated_at' }));
      const r = await api(url);
      const entries = ((r && r.entries) || []).filter((e) => e.name !== k.name);
      if (!entries.length) { results.replaceChildren(el('div', { class: 'empty', text: '결과 없음' })); return; }
      results.replaceChildren(...entries.map((e) => el('div', { class: 'row', role: 'button', tabindex: '0', style: 'cursor:pointer',
        onclick: async () => {
          try {
            await api('/api/ui/knowledge/' + encodeURIComponent(k.name) + '/link',
              { method: 'POST', body: JSON.stringify({ to: e.name, relation: relSel.value }) });
            toast('링크를 추가했습니다'); back.remove(); reload();
          } catch (err) { toast('실패 — ' + err.message, true); }
        } }, el('div', { class: 'row-title', text: e.title || e.name }), el('div', { class: 'row-meta' }, el('span', { class: 'mono', text: e.name })))));
    } catch (err) { results.replaceChildren(errorNote(err, '검색 실패')); }
  }
  qIn.addEventListener('input', () => { clearTimeout(t); t = setTimeout(search, 250); });
  setTimeout(() => { qIn.focus(); search(); }, 0);
}

// 자료(source) 상세 오버레이 — 지식 '출처 자료' 행과 자료 탭(knowledge.ts renderSources) 공용.
async function openSourceDetail(id) {
  let s: any;
  try { const r = await api('/api/ui/sources/' + id); s = (r && r.source) || r; }
  catch (e) { toast('자료를 불러오지 못했습니다 — ' + e.message, true); return; }
  const derived = s.knowledge || [];
  overlayBox(s.title || ('자료 #' + id),
    el('div', { class: 'detail-meta', style: 'margin-bottom:10px' },
      el('span', { class: 'kn-chip kn-source-kind', text: SOURCE_KIND_LABEL[s.kind] || s.kind }),
      knProvChip(s.provenance),
      s.occurred_at ? el('span', { class: 'caption', text: '  ' + absTime(s.occurred_at) }) : null),
    derived.length ? el('div', {}, el('div', { class: 'sec-label', text: '여기서 파생된 지식' }),
      el('div', { class: 'list-box' }, ...derived.map((d) => el('a', { class: 'row', href: '#/k/' + encodeURIComponent(d.name),
        style: 'text-decoration:none; display:block', text: (KN_SOURCE_REL_LABEL[d.relation] || d.relation) + ' · ' + (d.title || d.name) })))) : null,
    el('div', { class: 'sec-label', text: '본문' }),
    el('div', { class: 'unit-body md-rendered', style: 'max-height:50vh; overflow:auto' }, renderMarkdown(s.body_md || '(본문 없음)')));
}

// ── 지식↔프로젝트 연결(#255~257 이관) — 피커 + 상세 '연결된 프로젝트' 섹션. ──
// 연결 가능한 프로젝트 목록(보드 앵커 제외, 최신순) — 피커 공용. graceful(실패 시 빈 배열).
async function fetchLinkableProjects(): Promise<any[]> {
  try { const d = await api('/api/ui/v6/projects'); return (d && d.projects) || []; }
  catch (_) { return []; }
}
function knProjStatusText(p) {
  const done = p.status === 'done' || p.status_category === 'done';
  const tc = Number(p.task_count) || 0, dc = Number(p.task_done_count) || 0;
  return (done ? '완료' : '진행 중') + (tc ? ' · 작업 ' + dc + '/' + tc : '');
}

// 프로젝트 선택 피커(오버레이) — 관계(필요/산출) 토글 + 프로젝트 검색 목록. 행 버튼 클릭 = onPick(project, relation).
//  onPick 이 false 를 반환하면 미처리. 이미 처리한 (id:relation) 은 picked 로 '완료' 표시. 오버레이는 열린 채 여러 건 처리 가능.
//  opts: { title, actionLabel='＋ 연결', doneLabel='연결됨', initialPicked?:Iterable<string>, onPick:(p,relation)=>Promise<boolean|void> }
function openProjectChooser(opts) {
  const relSel = el('select', { class: 'kn-projpick-rel' },
    el('option', { value: 'required', text: '필요 지식으로' }),
    el('option', { value: 'produced', text: '산출 지식으로' }));
  const searchIn = el('input', { type: 'search', class: 'proj-file-search', placeholder: '프로젝트 이름으로 검색…' });
  const results = el('div', { class: 'ps-kn-pick-results' }, el('span', { class: 'admin-hint', text: '프로젝트를 불러오는 중…' }));
  overlayBox(opts.title || '프로젝트 선택', el('div', { class: 'ps-kn-pick' },
    el('div', { class: 'kn-projpick-bar' }, el('span', { class: 'admin-hint', text: '연결 관계' }), relSel),
    searchIn, results));
  setTimeout(() => searchIn.focus(), 0);
  let all: any[] = [];
  const picked = new Set(opts.initialPicked || []);
  function paint() {
    if (!all.length) { results.replaceChildren(el('div', { class: 'pjv-kn-empty', text: '연결할 프로젝트가 없습니다.' })); return; }
    const q = searchIn.value.trim().toLowerCase();
    const cand = all.filter((p) => !q || (p.name || '').toLowerCase().includes(q));
    if (!cand.length) { results.replaceChildren(el('div', { class: 'pjv-kn-empty', text: '검색 결과가 없습니다.' })); return; }
    const rel = relSel.value;
    results.replaceChildren(...cand.map((p) => {
      const done = picked.has(p.id + ':' + rel);
      const btn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: done ? (opts.doneLabel || '연결됨') : (opts.actionLabel || '＋ 연결') });
      (btn as any).disabled = done;
      btn.onclick = async () => {
        const relation = relSel.value;
        (btn as any).disabled = true;
        try {
          const ok = await opts.onPick(p, relation);
          if (ok === false) { (btn as any).disabled = false; return; }
          picked.add(p.id + ':' + relation); btn.textContent = opts.doneLabel || '연결됨';
        } catch (e) { (btn as any).disabled = false; toast('실패 — ' + e.message, true); }
      };
      return el('div', { class: 'ps-kn-pick-row' },
        el('div', { class: 'ps-kn-pick-main' },
          el('div', { class: 'row-title', text: p.name }),
          el('div', { class: 'admin-hint', text: knProjStatusText(p) })),
        btn);
    }));
  }
  relSel.addEventListener('change', paint);
  searchIn.addEventListener('input', paint);
  (async () => { all = await fetchLinkableProjects(); paint(); })();
}

// 위키 상세 '연결된 프로젝트' 섹션(#256) — 역방향 조회(GET /api/ui/knowledge/:name/projects) + 필요/산출 칩(해제 ✕) + 연결 버튼.
function knProjectLinks(knowledgeName) {
  const canEdit = hasMemoryScope();
  const list = el('div', { class: 'kn-projlink-list' });
  let cur: any[] = [];
  function linkedKeys() { return cur.map((p) => p.project_id + ':' + p.relation); }
  function projChip(p) {
    const link = el('a', { class: 'kn-projchip-link', href: '#/projects2/p/' + p.project_id, text: p.project_name || ('#' + p.project_id) });
    const x = el('button', { class: 'kn-projchip-x', type: 'button', title: '연결 해제', text: '✕' });
    x.onclick = async (ev) => { ev.preventDefault();
      try { await api('/api/ui/v6/projects/' + p.project_id + '/knowledge', { method: 'POST', body: JSON.stringify({ name: knowledgeName, relation: p.relation, unlink: true }) });
        toast('연결을 해제했습니다'); refresh(); }
      catch (e) { toast('해제 실패 — ' + e.message, true); } };
    return el('span', { class: 'kn-chip kn-projchip' }, link, canEdit ? x : null);
  }
  function paint() {
    if (!cur.length) { list.replaceChildren(el('div', { class: 'kn-cat-empty', text: '연결된 프로젝트가 없습니다.' })); return; }
    const groups: any[] = [];
    for (const rel of ['required', 'produced']) {
      const items = cur.filter((p) => p.relation === rel);
      if (!items.length) continue;
      groups.push(el('div', { class: 'kn-projlink-group' },
        el('span', { class: 'kn-projlink-rel kn-projlink-rel-' + rel, text: KN_REL_LABEL[rel] }),
        ...items.map(projChip)));
    }
    list.replaceChildren(...groups);
  }
  async function refresh() {
    try { const d = await api('/api/ui/knowledge/' + encodeURIComponent(knowledgeName) + '/projects'); cur = (d && d.projects) || []; }
    catch (_) { cur = []; }
    paint();
  }
  const addBtn = canEdit
    ? el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '＋ 프로젝트 연결',
        onclick: () => openProjectChooser({
          title: '프로젝트에 연결', actionLabel: '＋ 연결', doneLabel: '연결됨', initialPicked: linkedKeys(),
          onPick: async (proj, relation) => {
            await api('/api/ui/v6/projects/' + proj.id + '/knowledge', { method: 'POST', body: JSON.stringify({ name: knowledgeName, relation }) });
            toast('연결했습니다'); refresh(); return true;
          } }) })
    : null;
  const box = el('div', { class: 'kn-projlinks' },
    el('div', { class: 'sec-label sec-label-row' }, el('span', { text: '연결된 프로젝트' }), addBtn),
    list);
  refresh();
  return box;
}

// 비슷한 지식 한 항목(벡터 #172, 자동) — [유사도 % pill][제목 한 줄 전체폭]. knowledge_similar 결과.
function knSimilarItem(e) {
  const pct = Math.round((Number(e.similarity) || 0) * 100);
  return el('a', { class: 'kn-linkrow', href: '#/k/' + encodeURIComponent(e.name), title: '의미 유사도(코사인) ' + pct + '%' },
    el('span', { class: 'kn-link-rel kn-link-sim', text: pct + '%' }),
    el('span', { class: 'kn-linkrow-title', text: e.title || e.name }));
}

// 지식 삭제(휴지통) — 활성 목록·검색·주입에서 제거하되 감사 스냅샷으로 보존(#/trash 에서 복원). 연결은 cascade 정리.
//  after(#592): 피크/인라인 모드의 후처리(패널 닫기+목록 새로고침) — 없으면 기존처럼 목록으로 이동.
async function knDelete(name, after?) {
  if (!confirm("'" + name + "' 지식을 삭제할까요?\n\n활성 목록·검색·주입에서 사라집니다. 연결된 카테고리·프로젝트·활동 링크는 함께 정리됩니다.\n휴지통(#/trash)에서 본체를 복원할 수 있습니다.")) return;
  try {
    await api('/api/ui/knowledge/' + encodeURIComponent(name) + '/delete', { method: 'POST' });
    knInvalidateTreeCaches();   // 사이드바 트리/폴더 캐시에 죽은 행이 남지 않게(#592)
    toast('삭제했습니다 — 휴지통에서 복원할 수 있습니다');
    if (after) after(); else location.hash = '#/knowledge';
  } catch (e) {
    toast('삭제 실패 — ' + e.message, true);
  }
}

// #592 '이동' 피커 — 같은 카테고리의 폴더 목록 + (최상위) → POST /api/ui/knowledge/:name/move.
//  observed(외부 미러)는 호출부가 미노출(서버도 400 — 원본이 진실). 순환 등은 서버 가드 메시지를 그대로 보여준다.
function openKnowledgeMoveTo(k, reload) {
  const cats = (Array.isArray(k.categories) ? k.categories : []).filter((c) => c.state !== 'rejected');
  const catId = cats.length ? cats[0].category_id : null;
  const list = el('div', { class: 'list-box', style: 'max-height:320px; overflow:auto;' }, skeletonRows(2));
  const back = overlayBox('이동 · ' + (k.title || k.name),
    el('p', { class: 'admin-hint', text: '옮길 폴더를 고르세요. (최상위)는 폴더 밖(트리 루트)으로 꺼냅니다.' }), list);
  const pick = (parentName, label) => el('div', { class: 'row', role: 'button', tabindex: '0', style: 'cursor:pointer',
    onclick: async () => {
      try {
        await api('/api/ui/knowledge/' + encodeURIComponent(k.name) + '/move',
          { method: 'POST', body: JSON.stringify({ parent_name: parentName }) });
        knInvalidateTreeCaches();
        toast("'" + label + "'(으)로 이동했습니다");
        back.remove();
        reload();
      } catch (e) { toast('이동 실패 — ' + e.message, true); }
    } },
    el('div', { class: 'row-title', text: (parentName ? '📁 ' : '⌂ ') + label }));
  (async () => {
    let folders: any[] = [];
    if (catId != null) {
      try { folders = (await knFetchCategoryRows(catId)).filter((r) => r.is_folder && r.name !== k.name); }
      catch (_) { /* 폴더 목록 실패 — (최상위)만 제공 */ }
    }
    folders.sort(knFolderFirstSort);
    list.replaceChildren(pick(null, '(최상위)'), ...folders.map((fd) => pick(fd.name, fd.title || fd.name)));
  })();
}

// ════════════════════════════════════════════
// #592 문서 캔버스 — buildKnowledgeDetail(container, name, opts). 문서 렌더 단일 소스.
//  opts.mode: 'page'(#/k 전체 페이지) | 'peek'(우측 슬라이드 오버 — 다음 단계) | 'inline'(카테고리 엔트리 — 다음 단계).
//  구조(§3 문서 페이지): 브레드크럼+액션 → h1 제목 → 속성 블록 → hr → 본문(820px 중앙, ⤢ 전폭) → 하위 패널들.
// ════════════════════════════════════════════
async function buildKnowledgeDetail(container, name, opts?) {
  const mode = (opts && opts.mode) || 'page';
  container.classList.add('kn-doc', 'kn-doc-' + mode);
  container.replaceChildren(skeleton('지식을 불러오는 중'));
  let k: any; let hidden: string[] = [];
  try {
    [k, hidden] = await Promise.all([
      api('/api/ui/knowledge/' + encodeURIComponent(name)).then((d) => (d && d.knowledge) || d),
      fetchKnHiddenProps(),
    ]);
  } catch (e) {
    if (e.status === 404) {
      container.replaceChildren(
        el('div', { class: 'page-head' }, el('h1', { text: '없는 지식' })),
        el('div', { class: 'note', text: "'" + name + "' 을(를) 찾을 수 없습니다." }),
        el('a', { class: 'btn btn-ghost btn-sm', href: '#/knowledge', text: '← 지식으로' }));
      return;
    }
    container.replaceChildren(errorNote(e, '지식을 불러오지 못했습니다'));
    return;
  }
  if (!k) { container.replaceChildren(el('div', { class: 'note', text: '지식을 찾을 수 없습니다.' })); return; }
  const reload = () => buildKnowledgeDetail(container, name, opts);
  const canEdit = hasMemoryScope();

  // 전폭(⤢) — props_ui.full_width. 화면 즉시 반영 + (권한자) props-ui 저장.
  let full = !!(k.props_ui && k.props_ui.full_width);
  container.classList.toggle('full', full);

  // 브레드크럼 — 페이지 트리 조상 체인(#551, 서버 ancestors: 루트→직계부모 순). 미러 트리가 없으면 기존 2단.
  const crumbs = el('div', { class: 'crumbs' },
    el('a', { class: 'crumb-link', href: '#/knowledge', text: '지식' }));
  const ancestors = Array.isArray(k.ancestors) ? k.ancestors : [];
  for (const a of ancestors) {
    crumbs.append(el('span', { class: 'crumb-sep', text: ' / ' }),
      el('a', { class: 'crumb-link', href: '#/k/' + encodeURIComponent(a.name), text: a.title || a.name }));
  }
  crumbs.append(el('span', { class: 'crumb-sep', text: ' / ' }),
    ancestors.length
      ? el('span', { class: 'crumb-cur', text: k.title || k.name })
      : el('span', { class: 'mono', text: k.name }));

  // 우측 액션 — 편집·핀(memory 권한자)·삭제 + ⤢ 전폭 토글.
  const actions = el('div', { class: 'kn-doc-actions' });
  if (canEdit) {
    // (#335 ①) 항상-주입 섹션은 관리탭 '세션 주입'에서만 편집/순서/삭제 — 지식 편집페이지로 보내지 않는다.
    actions.append(k.injection === 'always'
      ? el('button', { class: 'btn btn-ghost btn-sm', text: '관리 ▸ 세션 주입에서 편집',
          title: '이 문서는 항상-주입 섹션입니다 — 관리 탭에서 편집·순서·삭제합니다.',
          onclick: () => { location.hash = '#/system/injection-map'; } })
      : el('button', { class: 'btn btn-ghost btn-sm', text: '편집',
          onclick: () => { location.hash = '#/k-edit/' + encodeURIComponent(k.name); } }));
    const pinBtn = el('button', { class: 'btn btn-ghost btn-sm',
      text: k.is_wiki ? '📌 핀 해제' : '📍 인덱스에 핀',
      title: '핀하면 제목·분류가 매 대화 첫머리(WIKI 인덱스)에 항상 깔립니다(본문 제외, 필요할 때 AI가 찾아봄).',
      onclick: async () => {
        pinBtn.disabled = true;
        try {
          await api('/api/ui/knowledge/' + encodeURIComponent(k.name) + '/wiki',
            { method: 'POST', body: JSON.stringify({ is_wiki: !k.is_wiki }) });
          toast(k.is_wiki ? '핀을 해제했습니다' : '인덱스에 핀했습니다');
          reload();
        } catch (e) { toast('핀 변경 실패 — ' + e.message, true); pinBtn.disabled = false; }
      } });
    actions.append(pinBtn);
    // #592 '이동' — 저작 지식만(observed 는 원본이 진실 — 서버도 400). 같은 카테고리 폴더/최상위로 트리 이동.
    if (k.provenance !== 'observed') {
      actions.append(el('button', { class: 'btn btn-ghost btn-sm', text: '이동',
        title: '이 문서를 같은 카테고리의 폴더(또는 최상위)로 옮깁니다',
        onclick: () => openKnowledgeMoveTo(k, reload) }));
    }
  }
  actions.append(el('button', { class: 'btn btn-ghost btn-sm btn-danger', text: '삭제',
    onclick: () => knDelete(k.name, opts && opts.onDeleted) }));
  const fullBtn = el('button', { class: 'btn btn-ghost btn-sm kn-doc-fullbtn', type: 'button',
    title: '전폭 토글 — 본문 폭 제한(820px)을 켜고 끕니다', 'aria-pressed': String(full), text: full ? '⤡' : '⤢' });
  fullBtn.onclick = async () => {
    full = !full;
    container.classList.toggle('full', full);
    fullBtn.textContent = full ? '⤡' : '⤢';
    fullBtn.setAttribute('aria-pressed', String(full));
    if (!canEdit) return;   // 읽기전용 — 화면에서만 토글(저장 생략)
    try { await saveKnPropsUi(k, { full_width: full }); }
    catch (e) { toast('전폭 설정 저장 실패 — ' + e.message, true); }
  };
  actions.append(fullBtn);

  // 상태 배지(제목 위 얇은 줄) — 핀/보관은 §1 카탈로그 속성이 아닌 상태 표식이라 배지로 유지.
  const badges: any[] = [];
  if (k.lifecycle === 'archived') badges.push(el('span', { class: 'kn-chip kn-archived',
    title: '원본(외부 시스템)에서 보관/삭제되어 미러만 남았습니다 — 내용은 보존됩니다.', text: '📦 보관됨' }));
  if (k.is_wiki) badges.push(el('span', { class: 'kn-chip kn-pin',
    title: 'WIKI 인덱스에 핀됨 — 제목·분류가 매 대화 첫머리에 항상 깔립니다(본문 제외).', text: '📌 인덱스' }));

  // 속성 블록 — 저장(props-ui/view-config) 후 블록만 즉시 재렌더(본문 리페치 없음).
  const propsSlot = el('div', { class: 'kn-props-slot' });
  const paintProps = () => {
    fetchKnHiddenProps().then((h) => {
      propsSlot.replaceChildren(buildKnPropsBlock(k, h, { canEdit, onChanged: paintProps }));
    });
  };
  propsSlot.replaceChildren(buildKnPropsBlock(k, hidden, { canEdit, onChanged: paintProps }));

  // 본문 — 렌더러가 <br>/블록을 직접 처리하므로 pre-wrap(.unit-body) 불필요 — 새 .kn-doc-md 클래스.
  //  폴더(is_folder, #592)는 본문 대신 자식 목록이 중심 — 원문 토글도 생략.
  let body;
  if (k.is_folder) {
    body = el('div', { class: 'kn-doc-body' }, await knFolderChildrenBlock(k));
  } else {
    const rawText = k.body_md || '';
    const rendered = rawText
      ? el('div', { class: 'kn-doc-md md-rendered' }, renderMarkdown(rawText))
      : el('div', { class: 'kn-doc-md kn-doc-md-empty', text: '(본문 없음)' });
    const rawView = el('pre', { class: 'kn-doc-raw', text: rawText });
    rawView.hidden = true;
    let showingRaw = false;
    const rawToggle = rawText
      ? el('button', { class: 'btn btn-ghost btn-sm md-raw-toggle', text: '원문 보기',
          onclick: () => { showingRaw = !showingRaw; rendered.hidden = showingRaw; rawView.hidden = !showingRaw;
            rawToggle.textContent = showingRaw ? '서식 보기' : '원문 보기'; } })
      : null;
    body = el('div', { class: 'kn-doc-body' }, rendered, rawView,
      rawToggle ? el('div', { class: 'kn-doc-rawrow' }, rawToggle) : null);
  }

  // 하위 패널들 — 전부 본문 아래(#592 §3): 하위 페이지 → 노션 속성(동적) → 연결 지식 → 연결 프로젝트 → 비슷한 지식.
  //  폴더는 자식 목록을 본문 영역에 이미 크게 그렸으니 '하위 페이지' 패널은 중복이라 생략.
  const relatedBox = el('div', { class: 'kn-related', hidden: true });
  const panels = el('div', { class: 'kn-doc-panels' },
    k.is_folder ? null : knChildrenPanel(k),
    knNotionPropsPanel(k),
    knLinksPanel(k, reload),
    knProjectLinks(k.name),
    relatedBox);

  const parts = [
    el('div', { class: 'kn-doc-top' }, crumbs, actions),
    el('h1', { class: 'kn-doc-title', text: (k.is_folder ? '📁 ' : '') + (k.title || k.name) }),
    badges.length ? el('div', { class: 'kn-doc-badges' }, ...badges) : null,
    propsSlot,
    el('hr', { class: 'kn-doc-hr' }),
    body,
    panels,
  ].filter(Boolean);
  container.replaceChildren(...parts);

  // 비슷한 지식 비동기 로드(주 렌더를 막지 않음). graceful — 임베딩 off/유사 없음/실패면 섹션 숨김 유지.
  (async () => {
    try {
      const r = await api('/api/ui/knowledge/similar?' + new URLSearchParams({ name: k.name, limit: '6', min_score: '0.45' }));
      const rel = (r && r.entries) || [];
      if (!rel.length) return;
      relatedBox.replaceChildren(
        el('div', { class: 'sec-label sec-label-row' },
          el('span', { text: '비슷한 지식' }),
          el('span', { class: 'kn-sim-hint', title: '벡터 임베딩 코사인 유사도로 자동 추천 — 직접 맺은 ‘연결된 지식’과는 다릅니다', text: '자동 · 의미 유사도' })),
        el('div', { class: 'kn-linkrows' }, ...rel.map(knSimilarItem)),
      );
      relatedBox.hidden = false;
    } catch (_) { /* 임베딩 off 등 → 숨김 유지 */ }
  })();
}

// 폴더 상세의 본문 대체 — 자식 목록(서버 children, sort 순)을 크게. 자식 폴더 아이콘은 authored 트리로 보강
//  (children 응답엔 is_folder 가 없어서 — 실패 시 문서 아이콘 폴백, graceful).
async function knFolderChildrenBlock(k) {
  const children = Array.isArray(k.children) ? k.children : [];
  if (!children.length) {
    return el('div', { class: 'kn-doc-md kn-doc-md-empty',
      text: '폴더가 비어 있습니다 — 문서 상세의 ‘이동’으로 이 폴더에 담을 수 있습니다.' });
  }
  let folderSet = new Set();
  try { folderSet = new Set((await knFetchAuthoredTree()).filter((t) => t.is_folder).map((t) => t.name)); }
  catch (_) { /* 아이콘 보강 실패 — 📄 폴백 */ }
  const rows = children.map((c) => el('a', {
    class: 'kn-linkrow' + (c.lifecycle === 'archived' ? ' kn-row-archived' : ''),
    href: '#/k/' + encodeURIComponent(c.name) },
    el('span', { class: 'kn-link-rel kn-link-child', text: folderSet.has(c.name) ? '📁' : knTreeIcon(c.notion_kind) }),
    el('span', { class: 'kn-linkrow-title', text: (c.title || c.name) + (c.lifecycle === 'archived' ? ' (보관됨)' : '') })));
  return el('div', { class: 'kn-links kn-folder-children' },
    el('div', { class: 'sec-label sec-label-row' }, el('span', { text: '폴더 항목' }),
      el('span', { class: 'kn-sim-hint', text: (k.children_total || children.length) + '개' })),
    el('div', { class: 'kn-linkrows' }, ...rows));
}

// ════════════════════════════════════════════
// #592 피크 패널 — 목록/테이블/사이드바 트리 항목 클릭 시 우측 슬라이드 오버(코멘트 드로어 패턴, 폭 min(860px,92vw)).
//  내용 = buildKnowledgeDetail(mode:'peek') 단일 소스. ESC/배경 클릭/✕ 닫기.
//  URL 동기화: 열 때 현 해시에 &peek=<name> 을 pushState — 뒤로가기=닫힘, peek 있는 URL 직접 진입=자동 오픈
//  (renderKnowledgeSpace 진입부). 피크 개폐만의 히스토리 이동은 knPeekNavGuard 로 라우터(main.ts route)의
//  본문 전체 재렌더를 1회 생략한다(스크롤·목록 상태 보존).
// ════════════════════════════════════════════
let knPeekCur: any = null;        // { back, name, pushed, baseHash, onPop, onKey, onRefresh }
let knPeekNavGuard = false;

// 라우터가 hashchange 마다 소비 — true 면 이번 이동은 피크 개폐뿐(패널이 이미 동기화됨)이라 재렌더 생략.
function consumeKnPeekNavGuard() { const v = knPeekNavGuard; knPeekNavGuard = false; return v; }

// 현 해시에서 peek 파라미터만 추가/제거한 해시 문자열 — 경로·다른 필터 파라미터는 그대로.
function knHashWithPeek(name: string | null) {
  const h = location.hash.replace(/^#\/?/, '');
  const qIdx = h.indexOf('?');
  const path = qIdx >= 0 ? h.slice(0, qIdx) : h;
  const p = new URLSearchParams(qIdx >= 0 ? h.slice(qIdx + 1) : '');
  if (name) p.set('peek', name); else p.delete('peek');
  const qs = p.toString();
  return '#/' + path + (qs ? '?' + qs : '');
}

// 히스토리 조작 없이 패널만 제거 — 라우트 전환(전체화면·다른 탭)·패널 교체 정리용. 열려 있지 않으면 no-op.
function dismissKnowledgePeek() {
  const cur = knPeekCur;
  if (!cur) return;
  knPeekCur = null;
  window.removeEventListener('popstate', cur.onPop);
  document.removeEventListener('keydown', cur.onKey);
  cur.back.classList.remove('open');
  setTimeout(() => cur.back.remove(), 220);
}

// 피크 열기 — opts: { fromUrl?: true(URL 직접 진입 — pushState 생략), onRefresh?: 삭제 등 변경 후 뒤 목록 새로고침 }.
function openKnowledgePeek(name, opts?) {
  dismissKnowledgePeek();   // 패널은 항상 1개 — 열려 있으면 교체
  const fromUrl = !!(opts && opts.fromUrl);
  const onRefresh = opts && opts.onRefresh;
  const baseHash = knHashWithPeek(null);   // 닫혔을 때로 돌아갈 기준 해시(push 전에 계산)

  const body = el('div', { class: 'kn-peek-scroll' });
  const fullBtn = el('button', { class: 'kn-peek-btn', type: 'button',
    title: '이 문서를 전체 페이지로 엽니다', text: '⤢ 전체화면' });
  const tabBtn = el('button', { class: 'kn-peek-btn', type: 'button',
    title: '이 문서를 새 탭에서 엽니다', text: '↗ 새 탭' });
  const xBtn = el('button', { class: 'kn-peek-btn kn-peek-x', type: 'button',
    'aria-label': '닫기', title: '닫기 (Esc)', text: '✕' });
  const panel = el('aside', { class: 'kn-peek', role: 'dialog', 'aria-label': '지식 미리보기' },
    el('div', { class: 'kn-peek-head' }, fullBtn, tabBtn, xBtn), body);
  const back = el('div', { class: 'kn-peek-backdrop' }, panel);

  // 닫기 요청(✕/ESC/배경) — 우리가 push 한 엔트리면 back(뒤로가기와 같은 경로 — onPop 이 정리),
  //  URL 직접 진입이면 이전 엔트리가 밖(외부/다른 페이지)일 수 있어 peek 파라미터만 제거(replaceState).
  const requestClose = () => {
    const cur = knPeekCur;
    if (!cur || cur.back !== back) return;
    if (cur.pushed) { history.back(); return; }
    history.replaceState(null, '', knHashWithPeek(null));
    dismissKnowledgePeek();
  };
  // 뒤/앞으로가기 — peek 파라미터만의 변화면 패널만 개폐(가드로 라우터 재렌더 생략), 그 밖의 이동은 라우터에 맡긴다.
  const onPop = () => {
    const cur = knPeekCur;
    if (!cur || cur.back !== back) return;
    if (knHashWithPeek(null) !== cur.baseHash) { dismissKnowledgePeek(); return; }   // 필터/경로까지 변함 — route 가 재렌더
    const h = location.hash.replace(/^#\/?/, '');
    const qIdx = h.indexOf('?');
    const nowPeek = new URLSearchParams(qIdx >= 0 ? h.slice(qIdx + 1) : '').get('peek');
    if (!nowPeek) { knPeekNavGuard = true; dismissKnowledgePeek(); return; }         // 뒤로가기 = 닫힘
    if (nowPeek !== cur.name) {                                                      // 다른 피크로 이동 — 내용 교체
      knPeekNavGuard = true;
      openKnowledgePeek(nowPeek, { fromUrl: true, onRefresh: cur.onRefresh });
    }
  };
  const onKey = (ev) => { if (ev.key === 'Escape') requestClose(); };
  back.addEventListener('mousedown', (ev) => { if (ev.target === back) requestClose(); });
  xBtn.onclick = requestClose;
  fullBtn.onclick = () => {
    dismissKnowledgePeek();   // 히스토리는 그대로(피크 URL 유지) — #/k 에서 뒤로가면 피크 상태로 복원
    location.hash = '#/k/' + encodeURIComponent(name);
  };
  tabBtn.onclick = () => { window.open(location.href.split('#')[0] + '#/k/' + encodeURIComponent(name)); };

  document.body.append(back);
  requestAnimationFrame(() => back.classList.add('open'));
  knPeekCur = { back, name, pushed: false, baseHash, onPop, onKey, onRefresh };
  if (!fromUrl) { history.pushState(null, '', knHashWithPeek(name)); knPeekCur.pushed = true; }
  window.addEventListener('popstate', onPop);
  document.addEventListener('keydown', onKey);

  buildKnowledgeDetail(body, name, { mode: 'peek',
    onDeleted: () => { requestClose(); if (onRefresh) onRefresh(); } });
}

export {
  SPACE_LABEL,
  KN_INJECTION_LABEL,
  KN_INJECTION_HINT,
  KN_PROVENANCE_LABEL,
  KN_PROVENANCE_HINT,
  KN_AUTHOR_LABEL,
  KN_AUTHOR_HINT,
  KN_TYPE_LABEL,
  KN_REL_LABEL,
  KN_LINK_REL_LABEL,
  KN_SOURCE_REL_LABEL,
  SOURCE_KIND_LABEL,
  buildKnowledgeDetail,
  consumeKnPeekNavGuard,
  dismissKnowledgePeek,
  infoDot,
  knAuthorChip,
  knChildrenPanel,
  knFetchAuthoredTree,
  knFetchCategoryRows,
  knFolderFirstSort,
  knInjectChip,
  knInvalidateTreeCaches,
  knLinksPanel,
  knNotionPropsPanel,
  knProjectLinks,
  knProvChip,
  knSimilarItem,
  knTreeIcon,
  knTypeChip,
  openKnowledgePeek,
  openProjectChooser,
  openSourceDetail,
};
