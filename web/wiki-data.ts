// wiki-data.ts — WIKI 탭 데이터·엔진 계층(#764 재구축 — 구 knowledge-doc.ts 를 개명·정리).
//  라벨 사전 · 트리/카테고리 세션 캐시 · 속성(메타) 노출 엔진 · 피커/오버레이 · 댓글 위젯 · 대문 문서 컨벤션.
//  표면(화면) 코드는 없다 — 홈/카테고리/문서 캔버스는 wiki-home/wiki-category/wiki-doc 이 이 모듈을 소비한다.
//  순환 import 금지: 이 모듈은 core/learn 만 import 한다(wiki-*.ts → wiki-data.ts 단방향).
import { LIFECYCLE_LABEL, absTime, api, el, errorNote, personFace, relTime, renderInline, renderMarkdown, safeHref, selectFilter, state, toast, withTip } from './core.js';
import { overlayBox, skeletonRows } from './learn.js';

// ── 카테고리 대문 문서 컨벤션(#657 → #764 이관) — 카테고리당 지식 문서 `category-home-<key>` 1건이
//  대문의 전부(본문=body_md, 아이콘/커버=props_ui)를 담는다. 스키마 변경 0. 빈 본문은 ZWSP 1자(HOME_EMPTY —
//  knowledge_save 가 빈 body 를 거부). 이 문서는 모든 목록/트리/검색/멘션 표면에서 숨긴다(isCategoryHomeDoc).
const HOME_PREFIX = 'category-home-';
const HOME_EMPTY = '\u200B';
function homeDocName(cat: any): string { return HOME_PREFIX + (cat.key || cat.id); }
function isCategoryHomeDoc(name: string): boolean { return String(name || '').startsWith(HOME_PREFIX); }

// \u2500\u2500 \uB77C\uC6B0\uD2B8 \uC774\uD0C8 \uCCAD\uC18C \u2014 \uD45C\uBA74\uC774 \uB9CC\uB4E0 \uBE14\uB85D \uC5D0\uB514\uD130\u00B7body \uC9C1\uC18D \uD31D\uC624\uBC84\uB97C \uB77C\uC6B0\uD130(main.ts route)\uAC00 \uD55C \uBC88\uC5D0 \uC815\uB9AC. \u2500\u2500
//  \uC5D0\uB514\uD130\uB294 destroy \uBBF8\uD638\uCD9C \uC2DC body \uC758 .be-tools \uC640 document selectionchange \uB9AC\uC2A4\uB108\uAC00 \uB204\uC801\uB41C\uB2E4(\uBE14\uB85D\uC5D0\uB514\uD130 \uACC4\uC57D).
//  \uD45C\uBA74\uC740 wkTrackEditor \uB85C \uAC10\uC2F8 \uB4F1\uB85D\uB9CC \uD558\uBA74 \uB418\uACE0, \uB8E8\uD2B8\uAC00 DOM \uC5D0\uC11C \uBD84\uB9AC\uB41C \uC778\uC2A4\uD134\uC2A4\uB9CC \uC5EC\uAE30\uC11C destroy \uB41C\uB2E4.
const wkLiveEditors = new Set<any>();
//  두 번째 인자 flush: 이 에디터의 '대기 중 저장을 언로드 후에도 보장'하는 동기 최선 저장(keepalive fetch / localStorage 미러).
function wkTrackEditor(ed: any, flush?: () => void) { wkLiveEditors.add(ed); if (flush) ed.__wkFlush = flush; return ed; }
//  비-에디터(카테고리 대문 빌더 등)도 언로드 flush 에 참여할 수 있게 — 등록/해제.
const wkFlushers = new Set<() => void>();
function wkRegisterFlush(fn: () => void) { wkFlushers.add(fn); return () => { wkFlushers.delete(fn); }; }
//  화면이 숨겨지거나(탭 전환·닫기·백그라운드) 언로드·재접속될 때 — 살아있는 에디터/등록 flush 를 모두 실행.
function wkFlushAll() {
  for (const ed of Array.from(wkLiveEditors)) {
    try { if (ed && ed.el && ed.el.isConnected && typeof ed.__wkFlush === 'function') ed.__wkFlush(); }
    catch (_) { /* 최선 저장 — 실패 무시 */ }
  }
  for (const fn of Array.from(wkFlushers)) { try { fn(); } catch (_) { /* 무시 */ } }
}
function wkAnyEditorDirty() {
  for (const ed of Array.from(wkLiveEditors)) {
    try { if (ed && ed.el && ed.el.isConnected && ed.isDirty && ed.isDirty()) return true; } catch (_) { /* 무시 */ }
  }
  return false;
}
//  전역 언로드 가드(모듈 1회 설치) — 이탈 순간 대기 저장을 flush. 오프라인이라 flush 가 실패할 때만 이탈 경고(과잉 경고 방지).
if (typeof window !== 'undefined' && !(window as any).__wkUnloadGuard) {
  (window as any).__wkUnloadGuard = true;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') wkFlushAll(); });
  window.addEventListener('pagehide', () => wkFlushAll());
  window.addEventListener('online', () => wkFlushAll());
  window.addEventListener('beforeunload', (e: any) => {
    if (!navigator.onLine && wkAnyEditorDirty()) { e.preventDefault(); e.returnValue = ''; }
  });
}
function wkRouteCleanup() {
  for (const ed of Array.from(wkLiveEditors)) {
    try { if (!ed.el || !ed.el.isConnected) { ed.destroy(); wkLiveEditors.delete(ed); } }
    catch (_) { wkLiveEditors.delete(ed); }
  }
  document.querySelectorAll('.wk-morepop, .wk-propspop, .kn-metapop').forEach((n: any) => {
    (n._close || (() => n.remove()))();
  });
}

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
const SOURCE_KIND_LABEL = { transcript: '전사록', minutes: '회의록', email: '이메일', slack: '슬랙', discord: '디스코드', notion_doc: '노션', clickup_doc: '클릭업', drive_file: '구글드라이브', other: '기타' };

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
//  #783 lifecycle=active,pending — 검토 대기 지식도 트리엔 띄우되 '검토' 배지로 구분한다(wiki-side knNavDocNode).
//   · 안 띄우면: 폴더 하위 pending 은 보이고(트리 API 는 lifecycle 필터가 없다) 최상위 pending 은 안 보이는 불일치가 난다.
//   · 띄워도 격리는 안 깨진다 — 검색·grep·벡터·similar·recall·항상주입은 여전히 active 전용(거긴 lifecycle 미전달).
function knFetchCategoryRows(catId): Promise<any[]> {
  const key = String(catId);
  let p = knCatRowsCache.get(key);
  if (!p) {
    p = api('/api/ui/knowledge?' + new URLSearchParams({ category: key, limit: '200', orderBy: 'updated_at', injection: 'recalled', lifecycle: 'active,pending' }))
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
      // 전역 기본엔 '이 대화에서 사용자가 바꾼 델타'만 반영한다. 토글 초기값(vis)은 이 문서의
      //  props_ui 오버라이드가 이미 반영된 '효과 노출'이라, 그걸 절대값으로 쓰면 한 문서의 개인화가
      //  전역 기본으로 조용히 샌다(#592). 안 바꾼 속성은 현재 전역(hidden) 그대로 유지.
      const nextHidden = new Set(hidden);
      for (const p of KN_PROP_CATALOG) {
        const on = !!toggles.get(p.key);
        if (on === vis.has(p.key)) continue;   // 초기 토글(효과 노출)에서 안 바뀐 속성 = 전역 불변
        if (on) nextHidden.delete(p.key); else nextHidden.add(p.key);
      }
      const hidden_props = KN_PROP_CATALOG.filter((p) => nextHidden.has(p.key)).map((p) => p.key);
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

// #657t 분류·유형 인라인 피커 — 속성 값 클릭 시 팝오버(노션 속성 편집 동형). save(field, value) 는 호출부 제공.
function openKnMetaPicker(anchor: HTMLElement, field: string, k: any, save: (f: string, v: string) => Promise<void>) {
  const old = document.querySelector('.kn-metapop');
  if (old) { old.remove(); return; }
  const pop = el('div', { class: 'kn-metapop', role: 'menu' });
  const close = () => { pop.remove(); document.removeEventListener('mousedown', onDoc, true); };
  const opt = (label: string, value: string, on: boolean) => {
    const b = el('button', { class: 'kn-metapop-item' + (on ? ' on' : ''), type: 'button' },
      el('span', { text: label }), on ? el('span', { class: 'kn-metapop-check', 'aria-hidden': 'true', text: '✓' }) : null);
    b.onclick = async () => { close(); if (!on) { try { await save(field, value); } catch (e) { toast('저장 실패 — ' + e.message, true); } } };
    return b;
  };
  if (field === 'type') {
    for (const [v, label] of Object.entries(KN_TYPE_LABEL)) pop.append(opt(label as string, v, k.type === v));
  } else {
    pop.append(el('div', { class: 'kn-metapop-note', text: '불러오는 중…' }));
    api('/api/ui/categories').then((d) => {
      const cats = (d && d.categories) || [];
      const cur = new Set((Array.isArray(k.categories) ? k.categories : []).filter((c) => c.state !== 'rejected').map((c) => c.key));
      const parts: any[] = [];
      for (const sp of ['business', 'product', 'system']) {
        const inSp = cats.filter((c) => c.space === sp);
        if (!inSp.length) continue;
        parts.push(el('div', { class: 'kn-metapop-head', text: SPACE_LABEL[sp] }));
        for (const c of inSp) parts.push(opt(c.name || c.key, c.key, cur.has(c.key)));
      }
      pop.replaceChildren(...parts);
    }).catch(() => pop.replaceChildren(el('div', { class: 'kn-metapop-note', text: '목록을 불러오지 못했습니다' })));
  }
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 260)) + 'px';
  pop.style.top = (r.bottom + 4) + 'px';
  const onDoc = (ev: any) => { if (!pop.contains(ev.target)) close(); };
  setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
}

// 속성 블록(노션형) — 보이는 속성 세로 리스트 + '속성 n개 숨김 ▾'(일시 펼침) + ⚙ 속성 설정.
//  opts.editMeta(#657t): 분류·유형 값 클릭=인라인 피커.
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
  const mkRow = ({ p, v }, dim?: boolean) => {
    const r = knPropRow(p.label, v.node, v.hint);
    if (dim) r.classList.add('kn-prop-dim');
    if (opts.editMeta && (p.key === 'category' || p.key === 'type')) {
      r.classList.add('kn-prop-editable');
      const val = r.querySelector('.kn-prop-v') as HTMLElement;
      val.setAttribute('role', 'button');
      val.setAttribute('tabindex', '0');
      val.title = '클릭해서 변경';
      const openIt = () => openKnMetaPicker(val, p.key, k, opts.editMeta.save);
      val.addEventListener('click', openIt);
      val.addEventListener('keydown', (ev: any) => { if (ev.key === 'Enter') openIt(); });
    }
    return r;
  };
  let revealed = false;   // '숨김 ▾' 일시 펼침(저장 아님 — 화면에서만)
  const paint = () => {
    body.replaceChildren(
      ...rows.map((rv) => mkRow(rv)),
      ...(revealed ? hiddenRows.map((rv) => mkRow(rv, true)) : []));
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
    el('span', { class: 'kn-link-rel kn-link-child', text: c.icon || (c.is_folder ? '📁' : knTreeIcon(c.notion_kind)) }),
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
  // #907 본문 [[…]] 파생 엣지 — 본문이 SoT라 여기서 뗄 수 없다(서버도 거부). ✕ 대신 '본문' 표식을 달아
  //  진짜 해제 방법을 알려준다. 백링크(incoming)면 [[…]] 는 **상대 문서** 본문에 있다 — 그쪽을 고쳐야 한다.
  const fromBody = e.origin === 'wikilink';
  const row = el('a', { class: 'kn-linkrow', href: '#/k/' + encodeURIComponent(e.name) },
    el('span', { class: 'kn-link-rel kn-link-' + e.relation, text: KN_LINK_REL_LABEL[e.relation] || e.relation }),
    el('span', { class: 'kn-linkrow-title', text: e.title || e.name }));
  if (fromBody) {
    row.append(el('span', {
      class: 'kn-link-rel kn-link-source', text: '본문',
      title: incoming
        ? `'${e.title || e.name}' 본문의 [[${k.name}]] 에서 자동 생성된 연결입니다 — 그 문서의 본문에서 링크를 지우면 사라집니다.`
        : `이 문서 본문의 [[${e.name}]] 에서 자동 생성된 연결입니다 — 본문에서 링크를 지우면 사라집니다.`,
    }));
    return row;
  }
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
      const entries = ((r && r.entries) || []).filter((e) => e.name !== k.name && !isCategoryHomeDoc(e.name));
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
// #735 자료 참조 행(스레드 부모/답글·자식) — 클릭하면 그 자료 상세로 이동.
function srcRefRow(r: any) {
  const f = r.fields || {};
  const sub = (SOURCE_KIND_LABEL[r.kind] || r.kind) + (f.container_name ? ' · #' + f.container_name : '') + (f.author_name ? ' · @' + f.author_name : '');
  const row = el('div', { class: 'row', role: 'button', tabindex: '0', style: 'cursor:pointer' },
    el('div', { text: r.title || ('자료 #' + r.id) }),
    el('span', { class: 'caption', text: sub }));
  const open = () => openSourceDetail(r.id);
  row.addEventListener('click', open);
  row.addEventListener('keydown', (ev: any) => { if (ev.key === 'Enter') open(); });
  return row;
}

async function openSourceDetail(id) {
  let s: any;
  try { const r = await api('/api/ui/sources/' + id); s = (r && r.source) || r; }
  catch (e) { toast('자료를 불러오지 못했습니다 — ' + e.message, true); return; }
  const derived = s.knowledge || [];
  overlayBox(s.title || ('자료 #' + id),
    el('div', { class: 'detail-meta', style: 'margin-bottom:10px' },
      el('span', { class: 'kn-chip kn-source-kind', text: SOURCE_KIND_LABEL[s.kind] || s.kind }),
      // #735 구조화 메타(채널명·작성자) — source.fields 에서 커넥터-불가지 표시(id만으론 유실되던 지식화 맥락).
      (s.fields && s.fields.container_name) ? el('span', { class: 'kn-chip wk-src-chan', text: '#' + s.fields.container_name }) : null,
      (s.fields && s.fields.author_name) ? el('span', { class: 'kn-chip', text: '@' + s.fields.author_name }) : null,
      knProvChip(s.provenance),
      s.occurred_at ? el('span', { class: 'caption', text: '  ' + absTime(s.occurred_at) }) : null),
    derived.length ? el('div', {}, el('div', { class: 'sec-label', text: '여기서 파생된 지식' }),
      el('div', { class: 'list-box' }, ...derived.map((d) => el('a', { class: 'row', href: '#/k/' + encodeURIComponent(d.name),
        style: 'text-decoration:none; display:block', text: (KN_SOURCE_REL_LABEL[d.relation] || d.relation) + ' · ' + (d.title || d.name) })))) : null,
    // #735 스레드/계층 관계 — 부모(스레드 루트·상위 페이지) + 답글/자식(같은 스레드·하위). 자료 간 관계 표면.
    (s.parent || (s.replies && s.replies.length)) ? el('div', {},
      s.parent ? el('div', { class: 'sec-label', text: '상위 (스레드/부모)' }) : null,
      s.parent ? el('div', { class: 'list-box' }, srcRefRow(s.parent)) : null,
      (s.replies && s.replies.length) ? el('div', { class: 'sec-label', text: '답글·자식 ' + s.reply_count + '건' }) : null,
      (s.replies && s.replies.length) ? el('div', { class: 'list-box' }, ...s.replies.map(srcRefRow)) : null) : null,
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

// ── 지식 댓글(#592) — 문서 하단 인라인 섹션. 서버는 task_comment 동형(knowledge_comment). ──
//  프로젝트 코멘트(드로어)와 달리 문서 흐름 안에 인라인으로: 1단계 스레드(답글은 카드 아래 펼침),
//  👍/이모지 반응, Enter 전송(Shift+Enter 줄바꿈, IME 조합 확정 Enter 가드 #505). 미로그인/미지원은 graceful.
const KN_REACT_EMOJIS = ['👍', '❤️', '😄', '🎉', '👀', '🙏'];

function knCommentsSection(name: string) {
  const box = el('div', { class: 'kn-comments' });
  const head = el('div', { class: 'sec-label kn-comments-head', text: '댓글' });
  const feedBox = el('div', { class: 'kn-cmt-feed' }, el('div', { class: 'kn-cmt-loading', text: '불러오는 중…' }));
  let feed: any[] = [];
  const openThreads = new Set<number>();   // 펼쳐진 최상위 댓글 id
  const meName = (state.me && ((state.me as any).display_name || state.me.userId)) || '나';

  const repliesOf = (pid) => feed.filter((f) => f.reply_to != null && Number(f.reply_to) === Number(pid));
  const topLevel = () => feed.filter((f) => f.reply_to == null);

  const react = async (c, emoji) => {
    try {
      const d = await api('/api/ui/knowledge-comments/' + c.id + '/reactions', { method: 'POST', body: JSON.stringify({ emoji }) });
      c.reactions = (d && d.reactions) || [];
      paint();
    } catch (e) { toast('반응 실패 — ' + e.message, true); }
  };

  // 반응 줄 — 👍 좋아요 + 그 외 이모지 칩 + [☺] 미니 팝오버.
  function reactRow(c) {
    const like = (c.reactions || []).filter((r) => r.emoji === '👍')[0];
    const likeBtn = el('button', { class: 'kn-cmt-like' + (like && like.mine ? ' on' : ''), type: 'button', title: '좋아요',
      text: like ? '👍 ' + like.count : '👍' });
    likeBtn.onclick = () => react(c, '👍');
    const chips = (c.reactions || []).filter((r) => r.emoji !== '👍').map((r) => {
      const ch = el('button', { class: 'kn-cmt-chip' + (r.mine ? ' mine' : ''), type: 'button', text: r.emoji + ' ' + r.count });
      ch.onclick = () => react(c, r.emoji); return ch;
    });
    const add = el('button', { class: 'kn-cmt-addr', type: 'button', title: '반응 추가', text: '☺' });
    add.onclick = () => {
      const pop = el('div', { class: 'kn-cmt-emojipop' });
      const closePop = () => { pop.remove(); document.removeEventListener('click', onDoc, true); };
      const onDoc = (ev) => { if (!pop.contains(ev.target) && ev.target !== add) closePop(); };
      KN_REACT_EMOJIS.forEach((em) => {
        const eb = el('button', { class: 'kn-cmt-emojiopt', type: 'button', text: em });
        eb.onclick = () => { closePop(); react(c, em); }; pop.append(eb);
      });
      add.parentElement && add.parentElement.append(pop);
      setTimeout(() => document.addEventListener('click', onDoc, true), 0);
    };
    return el('span', { class: 'kn-cmt-reacts' }, likeBtn, ...chips, add);
  }

  // 댓글 카드 — isReply 면 들여쓰기. 최상위엔 답글 토글.
  function card(c, isReply) {
    const who = c.display_name || c.actor || '?';
    const foot = el('div', { class: 'kn-cmt-foot' }, reactRow(c));
    if (!isReply) {
      const reps = repliesOf(c.id);
      const replyBtn = el('button', { class: 'kn-cmt-replybtn', type: 'button',
        text: reps.length ? (openThreads.has(c.id) ? '답글 접기' : reps.length + '개의 답글') : '답글' });
      replyBtn.onclick = () => {
        if (reps.length && !openThreads.has(c.id)) openThreads.add(c.id);
        else if (reps.length && openThreads.has(c.id)) openThreads.delete(c.id);
        else openThreads.add(c.id);   // 답글 없으면 작성칸만 펼침
        paint();
        if (openThreads.has(c.id)) setTimeout(() => { const t = feedBox.querySelector('[data-reply-for="' + c.id + '"] textarea') as HTMLTextAreaElement; if (t) t.focus(); }, 0);
      };
      foot.append(replyBtn);
    }
    const kids: any[] = [
      el('div', { class: 'kn-cmt-meta' },
        el('span', { class: 'kn-cmt-name', text: who }),
        el('span', { class: 'kn-cmt-time', title: c.ts ? absTime(c.ts) : '', text: c.ts ? relTime(c.ts) : '' })),
      el('div', { class: 'kn-cmt-text md-rendered' }, renderMarkdown(c.body || '')),
      foot,
    ];
    return el('div', { class: 'kn-cmt-card' + (isReply ? ' kn-cmt-reply' : '') },
      personFace(c.actor || who, 'kn-cmt-ava', who),
      el('div', { class: 'kn-cmt-body' }, ...kids));
  }

  // 답글 작성칸(스레드 펼침 시) — parent_id 로 전송.
  function replyComposer(pid) {
    const wrap = el('div', { class: 'kn-cmt-replybox', 'data-reply-for': String(pid) });
    if (!hasMemoryScope()) return wrap;
    const ta = el('textarea', { class: 'kn-cmt-input kn-cmt-input-sm', placeholder: '답글…', rows: '1' }) as HTMLTextAreaElement;
    const send = el('button', { class: 'kn-cmt-send', type: 'button', text: '답글' });
    const go = async () => {
      const text = ta.value.trim(); if (!text) return;
      send.disabled = true; ta.disabled = true;
      try {
        const d = await api('/api/ui/knowledge/' + encodeURIComponent(name) + '/comments',
          { method: 'POST', body: JSON.stringify({ text, parent_id: pid }) });
        feed = (d && d.feed) || []; openThreads.add(pid); paint();
      } catch (e) { toast('답글 실패 — ' + e.message, true); send.disabled = false; ta.disabled = false; }
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !(e as any).isComposing && (e as any).keyCode !== 229) { e.preventDefault(); go(); }
    });
    send.onclick = go;
    wrap.append(ta, send);
    return wrap;
  }

  function paint() {
    head.textContent = '댓글' + (topLevel().length ? ' ' + topLevel().length : '');
    feedBox.replaceChildren();
    const tops = topLevel().slice().sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    if (!tops.length) { feedBox.append(el('div', { class: 'kn-cmt-empty', text: '아직 댓글이 없어요.' })); return; }
    for (const c of tops) {
      feedBox.append(card(c, false));
      if (openThreads.has(c.id)) {
        const reps = repliesOf(c.id).slice().sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
        feedBox.append(el('div', { class: 'kn-cmt-thread' }, ...reps.map((r) => card(r, true)), replyComposer(c.id)));
      }
    }
  }

  // 최상위 작성칸.
  const composer = el('div', { class: 'kn-cmt-composer' });
  if (hasMemoryScope()) {
    const ta = el('textarea', { class: 'kn-cmt-input', placeholder: '댓글을 입력하세요…  (Enter 전송 · Shift+Enter 줄바꿈)', rows: '1' }) as HTMLTextAreaElement;
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(Math.max(ta.scrollHeight, 38), 200) + 'px'; };
    ta.addEventListener('input', grow);
    const send = el('button', { class: 'kn-cmt-send', type: 'button', text: '댓글' });
    const go = async () => {
      const text = ta.value.trim(); if (!text) return;
      send.disabled = true; ta.disabled = true;
      try {
        const d = await api('/api/ui/knowledge/' + encodeURIComponent(name) + '/comments',
          { method: 'POST', body: JSON.stringify({ text }) });
        feed = (d && d.feed) || []; ta.value = ''; grow(); paint();
      } catch (e) { toast('전송 실패 — ' + e.message, true); }
      send.disabled = false; ta.disabled = false; ta.focus();
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !(e as any).isComposing && (e as any).keyCode !== 229) { e.preventDefault(); go(); }
    });
    send.onclick = go;
    composer.append(personFace((state.me && state.me.userId) || 'me', 'kn-cmt-ava', meName),
      el('div', { class: 'kn-cmt-composer-in' }, ta, el('div', { class: 'kn-cmt-composer-foot' }, send)));
  }

  box.append(head, feedBox, composer);
  (async () => {
    try {
      const d = await api('/api/ui/knowledge/' + encodeURIComponent(name) + '/comments');
      feed = (d && d.feed) || []; paint();
    } catch (e) {
      feedBox.replaceChildren(el('div', { class: 'kn-cmt-empty', text: '댓글을 불러오지 못했습니다.' }));
    }
  })();
  return box;
}

// 폴더 상세의 본문 대체 — 자식 목록(서버 children, sort 순)을 크게. 자식 폴더 아이콘은 authored 트리로 보강
//  (children 응답엔 is_folder 가 없어서 — 실패 시 문서 아이콘 폴백, graceful).
async function knFolderChildrenBlock(k) {
  const children = Array.isArray(k.children) ? k.children : [];
  if (!children.length) {
    return el('div', { class: 'wk-empty',
      text: '폴더가 비어 있습니다 — 문서 상세의 ‘이동’으로 이 폴더에 담을 수 있습니다.' });
  }
  const rows = children.map((c) => el('a', {
    class: 'kn-linkrow' + (c.lifecycle === 'archived' ? ' kn-row-archived' : ''),
    href: '#/k/' + encodeURIComponent(c.name) },
    el('span', { class: 'kn-link-rel kn-link-child', text: c.icon || (c.is_folder ? '📁' : knTreeIcon(c.notion_kind)) }),
    el('span', { class: 'kn-linkrow-title', text: (c.title || c.name) + (c.lifecycle === 'archived' ? ' (보관됨)' : '') })));
  return el('div', { class: 'kn-links kn-folder-children' },
    el('div', { class: 'sec-label sec-label-row' }, el('span', { text: '폴더 항목' }),
      el('span', { class: 'kn-sim-hint', text: (k.children_total || children.length) + '개' })),
    el('div', { class: 'kn-linkrows' }, ...rows));
}

// 행 글리프 단일 소스 — 페이지 아이콘(props_ui.icon) > 폴더 > 문서.
function knPageIcon(e) {
  return (e && e.icon) || (e && e.is_folder ? '📁' : '📄');
}


export {
  HOME_EMPTY,
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
  KN_PROP_CATALOG,
  SOURCE_KIND_LABEL,
  buildKnPropsBlock,
  fetchKnHiddenProps,
  hasMemoryScope,
  homeDocName,
  infoDot,
  isCategoryHomeDoc,
  knAuthorChip,
  knChildrenPanel,
  knCommentsSection,
  knDelete,
  knEffectiveVisible,
  knFetchAuthoredTree,
  knFetchCategoryRows,
  knFolderChildrenBlock,
  knFolderFirstSort,
  knInjectChip,
  knInvalidateTreeCaches,
  knLinksPanel,
  knNotionPropsPanel,
  knPageIcon,
  knProjectLinks,
  knPropValue,
  knProvChip,
  knSimilarItem,
  knTreeIcon,
  knTypeChip,
  openKnMetaPicker,
  openKnowledgeLinkPicker,
  openKnowledgeMoveTo,
  openProjectChooser,
  openSourceDetail,
  saveKnPropsUi,
  wkRegisterFlush,
  wkRouteCleanup,
  wkTrackEditor,
};
