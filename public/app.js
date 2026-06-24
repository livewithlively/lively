// Lively Context 웹 UI — 프레임워크 없는 해시 라우팅 SPA-lite.
// 보안 규칙: 모든 데이터 텍스트는 textContent/createElement 만 사용(innerHTML 에 데이터 주입 금지 —
// discord/notion 본문 XSS 방어). 토큰은 localStorage 에만, 절대 로그/URL 에 싣지 않는다.
//
// IA(v4 2026-06-18): 4 질적유형(kind R/K/H/W; S/G=domainmap federated) × area(space product|business)로 분류된 지식을 비개발자가 조회·CRUD.
//  파일탐색기 메타포 — 폴더=kind/domain, 파일=지식단위(unit). 5 화면:
//   1) 지식 지도(#/map)   — ctx_overview. kind 카드 + 시스템 건강. 오리엔테이션.
//   2) 탐색(#/browse)      — ctx_ls/ctx_grep. 좌 kind 트리 + grep 검색 + 필터 목록.
//   3) 유닛 상세(#/u/<name>) — ctx_cat 전문 + 메타 패널 + 편집(ctx_save)/반려(set-lifecycle).
//   4) 검토(#/review)      — confidence=ai·active 피드(에이전트 생산물) → reject/edit.
//   5) 관리(#/system)      — 3 중분류(기본 설정·회사·조직·AI 동작/연결 고급) 가로 탭으로 묶은 조직 관리(연결/멤버/토큰·규칙/맥락/메모리/용어·훅/툴/MCP/DB).
//   +  가이드(#/learn)      — 비개발자용: 서비스 목적 + 지식종류/용어 + 내 컴퓨터 설치(관리에서 '지식종류 레지스트리'·'설치'를 이리로 이관).
'use strict';

const TOKEN_KEY = 'lively_ui_token';
const SVG_NS = 'http://www.w3.org/2000/svg';

// kind 메타데이터(V4: 본질 4종만 — R·K·H·W). injection_mode 는 서버 overview 가 권위.
//  여기 라벨/한글설명은 표시 보강용(서버 label 우선, 없으면 이 표를 폴백 — overview label 권위 정책 유지).
//  V4-P2a 에서 A/D/F/M/L/Z→K 흡수, S/G→domainmap federated(ku kind 아님). 그래서 ku 데이터는 R/K/H/W 만.
//  S/G 는 ku 종류가 아니라 domainmap 파생(구조/용어집) — 새 분류 선택지에서 제외하되, 혹시 옛 데이터가
//  남아 서버 overview 에 등장하면 federated 라벨로 graceful 표시한다(아래 FEDERATED_META + isFederatedKind).
const KIND_META = {
  R: { label: 'Rule/Policy/Persona', ko: '규칙 · 정책 · 페르소나' },
  K: { label: 'Knowledge', ko: '지식' },
  H: { label: 'How-to/Runbook', ko: '절차 · 런북' },
  W: { label: 'Work/Task', ko: '작업' },
};
// federated 종류(domainmap 파생 — ku kind 아님). overview/검색에 옛 행이 남으면 read-only 로만 표시.
//  S/G 외에 흡수된 legacy(D/F/A/M/L/Z)도 혹시 잔존 시 graceful 라벨을 위해 넣어둔다(분류 선택지엔 미노출).
const FEDERATED_META = {
  S: { label: 'Structure (federated)', ko: '구조 (domainmap 파생)' },
  G: { label: 'Glossary (federated)', ko: '용어집 (domainmap 파생)' },
};
const LEGACY_META = {
  D: { label: 'Domain (→K)', ko: '도메인 (통합됨)' },
  F: { label: 'Fact (→K)', ko: '사실 (통합됨)' },
  A: { label: 'Artifact (→K)', ko: '산출물 (통합됨)' },
  M: { label: 'Memo (→K)', ko: '메모 (통합됨)' },
  L: { label: 'Link (→K)', ko: '링크 (통합됨)' },
  Z: { label: 'Misc (→K)', ko: '기타 (통합됨)' },
};
// 새 분류(ctx_save)에서 고를 수 있는 본질 종류 — R·K·H·W 만(legacy/federated 는 신규 선택 불가).
const CORE_KIND_KEYS = ['R', 'K', 'H', 'W'];
const isFederatedKind = (k) => Object.prototype.hasOwnProperty.call(FEDERATED_META, k);
const isCoreKind = (k) => Object.prototype.hasOwnProperty.call(KIND_META, k);
// 표시용 종류 메타 해소 — core → federated → legacy 순. 못 찾으면 빈 객체.
function kindMeta(k) {
  return KIND_META[k] || FEDERATED_META[k] || LEGACY_META[k] || {};
}
// 주입 모드 한글 라벨 + 한 줄 설명(비개발자 친화 — '어떻게 멤버에게 노출되나').
const INJECTION_LABEL = {
  enforced: '강제 주입',
  always:   '항상 주입',
  recalled: '검색 회상',
  digest:   '다이제스트',
  query:    '질의 시',
  manual:   '수동',
};
const INJECTION_HINT = {
  enforced: '모든 세션 컨텍스트 최상단에 강제로 들어갑니다(규칙·정책).',
  always:   '항상 컨텍스트에 포함됩니다.',
  recalled: '관련될 때 의미검색으로 회상됩니다.',
  digest:   '요약(다이제스트) 형태로 노출됩니다.',
  query:    '에이전트가 필요로 질의할 때만 조회됩니다.',
  manual:   '사람이 직접 참조할 때만 쓰입니다.',
};
// 출처(provenance) 라벨 — ai=AI 에이전트 생성, human=사람 저작/승인, rule=시스템 결정론 파생, observed=외부 시스템 미러(커넥터 원천).
//  V4-C: 'confidence' 컬럼/enum 은 물리적으로 불변 — UI 라벨만 '출처(provenance)'로 의미를 명확히 한다(출처는 채널이
//  기계로 박는 사실이지 신뢰도·가치가 아니다). observed 는 외부 *살아있는 미러* — 진실·편집은 외부에 있다.
const CONFIDENCE_LABEL = { ai: 'AI', human: '사람', rule: '규칙', observed: '외부 미러' };
// 수정이력(작성자/리비전) 라벨 — actor_kind=누가(사람/AI/커넥터/시스템), channel=어떤 경로(에이전트/웹/커넥터싱크/이관).
const ACTOR_KIND_LABEL = { human: '사람', ai: 'AI', connector: '커넥터', system: '시스템', unknown: '미상' };
const CHANNEL_LABEL = { mcp: '에이전트(MCP)', web: '웹', connector: '커넥터싱크', cli: 'CLI', migration: '이관', unknown: '경로 미상' };
// 리비전 op(작업) 라벨 — 본문 수정(insert/update)과 상태변경(set_lifecycle)/삭제(delete) 구분.
const REV_OP_LABEL = { insert: '생성', update: '수정', set_lifecycle: '상태 변경', delete: '삭제' };
// 정렬 옵션(탐색·검토 공용) — 백엔드 orderBy 화이트리스트(updated_at|name|sort)와 1:1.
const SORT_OPTS = [['updated_at', '최신순'], ['name', '이름순'], ['sort', '수동 정렬순']];
// lifecycle(상태) 라벨 — active=유효, rejected=반려, superseded=대체됨.
const LIFECYCLE_LABEL = { active: '유효', rejected: '반려', superseded: '대체됨' };
// 작업(activity) 유형 라벨 — 백엔드 activity.type(commit/comment/decision/status_change/review)과 1:1. 작업 현황 대시보드 유형분포 표시용.
const ACTIVITY_TYPE_LABEL = { commit: '커밋', comment: '코멘트', decision: '결정', status_change: '상태 변경', review: '검토' };
const ACTIVITY_TYPE_ORDER = ['commit', 'comment', 'decision', 'status_change', 'review'];
// 작업↔지식 연결 관계 라벨(activity_knowledge.relation) — produced=산출, references=참조, decided=결정 근거.
const REF_REL_LABEL = { produced: '산출', references: '참조', decided: '결정' };
// should/is 점검 결과 라벨(activity.should_review/is_review) — 도메인 의도(should)·코드구조(is) 점검 3-state.
const REVIEW_LABEL = { na: '해당 없음', checked_no_change: '점검함(변화 없음)', changed: '변경됨' };

const state = {
  me: null,
  overview: null,        // /api/ui/ctx/overview 캐시(지도 + 검토 배지 + 탐색 kind 트리 공유)
  browse: { filters: { kind: '', space: '', domain: '', lifecycle: 'active', confidence: '', q: '', orderBy: 'updated_at' }, entries: [], loaded: false },
  knowledge: { space: 'business', category: '', injection: '', provenance: '', q: '' }, // 지식 탭(#/knowledge) 필터 상태(2분할 뷰)
  reviewOrderBy: 'updated_at', // 검토 피드 정렬(기본 최신순)
  admin: { data: null, sel: 'kinds', memberSel: null, memberEditing: false, memberAddPreselect: null, memorySel: null, repoSel: null, navCollapsed: false }, // 관리(전달) 페이지 상태
  start: { mode: 'web', os: 'mac', token: null }, // '시작하기 > 설치' 온보딩 상태(쓰는곳 web|local + 선택 OS + 자가발급 토큰 1회 캐시)
  domains: {},           // P-V3-4a: repo별 도메인 통제어휘 캐시 { [repo]: {list, repos, loaded, error} }
  allDomains: null,      // V5 탈-repo: 전 repo + business 통합 통제어휘 캐시(저장/필터 드롭다운) {list, loaded, error}
};
// V5 탈-repo: 도메인 귀속은 repo-비의존(business=조직평면). 저장/필터 드롭다운은 통합 목록(loadAllDomains)을
//  쓰고, 어휘CRUD 화면만 repo별 product 도메인(loadDomains)을 유지한다(코드앵커·debt 가 repo 스코프).
const VOCAB_CRUD_DEFAULT_REPO = 'productivity'; // 어휘관리 화면 repo 셀렉터 폴백 기본(product 도메인 CRUD 전용)
let revealUsed = false; // 입장 리빌은 첫 부팅 렌더 1회만(§6)
let uid = 0;            // datalist 등 고유 id 카운터

// ── DOM 헬퍼 ──
// 불리언 HTML 속성 — 존재만으로 참이라 setAttribute(k, false) 로는 끌 수 없다(값 'false' 여도 켜진 상태).
//  el 에서 이들만 특수처리: 불리언 false → 미설정(끔), 그 외(true·'' 등) → 빈 속성으로 존재(켬).
const EL_BOOL_ATTRS = new Set(['disabled', 'hidden', 'checked', 'selected', 'readonly', 'required', 'multiple', 'open', 'autofocus']);
function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (EL_BOOL_ATTRS.has(k)) { if (v !== false) n.setAttribute(k, ''); } // false 만 끔('' / true 는 켬)
      else n.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}
function sv(name, attrs, ...children) {
  const n = document.createElementNS(SVG_NS, name);
  if (attrs) for (const [k, v] of Object.entries(attrs)) { if (v != null) n.setAttribute(k, v); }
  for (const c of children.flat(Infinity)) { if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return n;
}
const $view = () => document.getElementById('view');
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function applyReveal(nodes) {
  if (revealUsed || reducedMotion()) { revealUsed = true; return; }
  nodes.forEach((n, i) => { n.classList.add('reveal'); n.style.animationDelay = (i * 70) + 'ms'; });
  revealUsed = true;
}

// ── 안전 마크다운 렌더러 ──
// 비개발자 친화: body_md(raw 마크다운)을 실제 서식으로 보여준다. 의존성 0 — 작은 서브셋을
// 직접 파싱한다. 보안 불변식(P4b): **모든 텍스트는 textContent/createTextNode 만** 거치고
// DOM 은 createElement(el 헬퍼)로만 구성한다 — innerHTML 류 절대 미사용이라 HTML 주입 불가능.
// 파싱 못 하는 줄/토큰은 평문 텍스트로 안전 폴백(raw HTML 노출·렌더 깨짐 없음).

// 링크 href 안전 스킴만 허용(javascript:/data:/vbscript: 등은 거부 → 링크 대신 평문 표시).
// 상대경로·앵커(#)·프로토콜상대(//)·http/https/mailto 만 통과.
function safeHref(raw) {
  const url = String(raw).trim();
  if (!url) return null;
  // 앵커/상대경로/프로토콜상대는 안전.
  if (url.startsWith('#') || url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) return url;
  if (url.startsWith('//')) return url;
  // 스킴이 있으면 화이트리스트만. 스킴 추출 전 제어문자(개행/탭) 제거 — `java\nscript:` 우회 차단.
  const stripped = url.replace(/[\x00-\x1f\x7f]/g, '');
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(stripped);
  if (m) {
    const scheme = m[1].toLowerCase();
    if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return url;
    return null; // 알 수 없거나 위험한 스킴 → 거부
  }
  // 스킴 없는 일반 토큰(예: example.com) — 상대 취급(절대 스크립트 실행 불가).
  return url;
}

// 인라인 파싱 → 텍스트 노드/엘리먼트 배열. 코드(`)·굵게(**)·기울임(*)·링크([..](..)) 지원.
// 모든 미매칭 문자는 텍스트 노드로 누적되어 createTextNode 로만 들어간다.
function renderInline(text) {
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(document.createTextNode(buf)); buf = ''; } };
  const s = text;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    // 인라인 코드 `...`
    if (ch === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push(el('code', { class: 'md-code', text: s.slice(i + 1, end) }));
        i = end + 1;
        continue;
      }
    }
    // 굵게 **...**
    if (ch === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2);
      if (end > i + 1) {
        flush();
        out.push(el('strong', {}, ...renderInline(s.slice(i + 2, end))));
        i = end + 2;
        continue;
      }
    }
    // 기울임 *...*(공백으로 시작/끝나지 않는 단일 별표)
    if (ch === '*' && s[i + 1] !== '*' && s[i + 1] !== ' ' && s[i + 1] !== undefined) {
      const end = s.indexOf('*', i + 1);
      if (end > i && s[end - 1] !== ' ') {
        flush();
        out.push(el('em', {}, ...renderInline(s.slice(i + 1, end))));
        i = end + 1;
        continue;
      }
    }
    // 링크 [텍스트](url)
    if (ch === '[') {
      const close = s.indexOf(']', i + 1);
      if (close > i && s[close + 1] === '(') {
        const paren = s.indexOf(')', close + 2);
        if (paren > close) {
          const label = s.slice(i + 1, close);
          const href = safeHref(s.slice(close + 2, paren));
          flush();
          if (href) {
            out.push(el('a', { class: 'md-link', href, rel: 'noopener noreferrer nofollow' }, ...renderInline(label)));
          } else {
            // 위험 스킴 → 링크 무력화. 라벨만 평문으로(href 비노출).
            out.push(...renderInline(label));
          }
          i = paren + 1;
          continue;
        }
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

// 블록 파서 — 줄 단위로 블록을 구성한다. 모든 텍스트는 renderInline 경유(textContent).
function renderMarkdown(md) {
  const root = el('div', { class: 'md' });
  const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
  let i = 0;

  // 표 후보: | 로 시작/구분되는 2줄 이상 + 두번째 줄이 구분행(---|---).
  const isTableSep = (l) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.indexOf('-') >= 0;
  const splitRow = (l) => {
    let t = l.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|')) t = t.slice(0, -1);
    return t.split('|').map((c) => c.trim());
  };

  while (i < lines.length) {
    let line = lines[i];

    // 빈 줄 — 스킵.
    if (line.trim() === '') { i++; continue; }

    // 코드블록 ``` ... ```
    const fence = /^(```|~~~)(.*)$/.exec(line);
    if (fence) {
      const marker = fence[1];
      const code = [];
      i++;
      while (i < lines.length && lines[i].trimEnd() !== marker && !lines[i].startsWith(marker)) {
        code.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // 닫는 펜스 소비
      root.append(el('pre', { class: 'md-pre' }, el('code', { text: code.join('\n') })));
      continue;
    }

    // 구분선 --- *** ___
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { root.append(el('hr', { class: 'md-hr' })); i++; continue; }

    // 제목 #~######
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      root.append(el('h' + lvl, { class: 'md-h md-h' + lvl }, ...renderInline(h[2].trim())));
      i++;
      continue;
    }

    // 인용 > ...
    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      // 인용 안의 내용도 마크다운으로(중첩 렌더).
      const inner = renderMarkdown(quote.join('\n'));
      const bq = el('blockquote', { class: 'md-quote' });
      while (inner.firstChild) bq.append(inner.firstChild);
      root.append(bq);
      continue;
    }

    // 표: 헤더줄(| 포함) + 다음 줄이 구분행.
    if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(line);
      i += 2; // 헤더 + 구분행 소비
      const rows = [];
      while (i < lines.length && lines[i].trim() !== '' && lines[i].indexOf('|') >= 0) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const table = el('table', { class: 'md-table' });
      const thead = el('thead');
      const htr = el('tr');
      for (const c of header) htr.append(el('th', {}, ...renderInline(c)));
      thead.append(htr);
      table.append(thead);
      const tbody = el('tbody');
      for (const r of rows) {
        const tr = el('tr');
        for (let c = 0; c < header.length; c++) tr.append(el('td', {}, ...renderInline(r[c] || '')));
        tbody.append(tr);
      }
      table.append(tbody);
      root.append(table);
      continue;
    }

    // 리스트 — 순서/비순서 연속 블록. 들여쓰기 중첩은 한 단계만 단순 지원.
    const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(line);
    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      const isOrdered = !!ordered;
      const listTag = isOrdered ? 'ol' : 'ul';
      const list = el(listTag, { class: 'md-list' });
      const itemRe = isOrdered ? /^(\s*)(\d+)[.)]\s+(.*)$/ : /^(\s*)([-*+])\s+(.*)$/;
      while (i < lines.length) {
        const m = itemRe.exec(lines[i]);
        if (!m) {
          // 같은 리스트의 이어지는(들여쓴, 마커 없는) 줄은 직전 항목에 합친다.
          if (lines[i].trim() !== '' && /^\s+/.test(lines[i]) && list.lastChild) {
            list.lastChild.append(document.createTextNode(' '));
            for (const n of renderInline(lines[i].trim())) list.lastChild.append(n);
            i++;
            continue;
          }
          break;
        }
        list.append(el('li', {}, ...renderInline(m[3])));
        i++;
      }
      root.append(list);
      continue;
    }

    // 단락 — 빈 줄/블록 경계 전까지 모은다. 줄바꿈은 <br> 로 보존.
    const para = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') break;
      // 다음 블록 시작이면 단락 종료.
      if (/^(#{1,6})\s+/.test(l) || /^(```|~~~)/.test(l) || /^\s*>\s?/.test(l) ||
          /^(-{3,}|\*{3,}|_{3,})\s*$/.test(l) || /^(\s*)([-*+])\s+/.test(l) ||
          /^(\s*)(\d+)[.)]\s+/.test(l) || (l.indexOf('|') >= 0 && lines[i + 1] != null && isTableSep(lines[i + 1]))) break;
      para.push(l);
      i++;
    }
    const p = el('p', { class: 'md-p' });
    para.forEach((l, idx) => {
      if (idx > 0) p.append(el('br'));
      for (const n of renderInline(l)) p.append(n);
    });
    root.append(p);
  }
  return root;
}

// ── fetch 헬퍼 — 401 은 토큰 게이트, 그 외 비정상은 {error} 메시지로 throw ──
async function api(path, opts = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = Object.assign({}, opts.headers);
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    showGate('토큰이 무효화되었습니다. 다시 입력하세요.');
    const e = new Error('인증이 필요합니다'); e.status = 401; throw e;
  }
  let data = null;
  try { data = await res.json(); } catch (_) { /* 빈 바디 허용 */ }
  if (!res.ok) {
    const e = new Error((data && data.error) || ('요청 실패 (' + res.status + ')'));
    e.status = res.status;
    throw e;
  }
  return data;
}

// ── 시간/숫자 ──
// 마지막 갱신이 며칠 전일 수 있음 — 분/시간/일 폴백('분' 가정 금지).
function relTime(iso) {
  if (!iso) return '갱신 기록 없음';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '갱신 기록 없음';
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return '방금 전';
  if (m < 60) return m + '분 전';
  const h = Math.floor(m / 60);
  if (h < 24) return h + '시간 전';
  const d = Math.floor(h / 24);
  if (d < 30) return d + '일 전';
  return new Date(iso).toLocaleDateString('ko-KR');
}
function absTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ko-KR');
}
const fmtNum = (n) => Number(n || 0).toLocaleString('ko-KR');
const kindLabel = (k) => { const m = kindMeta(k); return m.ko || m.label || k; };

// ── 토스트 ──
function toast(msg, isError) {
  const box = document.getElementById('toasts');
  const t = el('div', { class: 'toast' + (isError ? ' coral' : ''), text: msg });
  box.append(t);
  setTimeout(() => t.remove(), 3600);
}

// ── 스킵 링크 — href 를 따라가면 해시 라우터가 오작동하므로 JS 로 포커스만 이동(§8) ──
document.getElementById('skip-link').addEventListener('click', (ev) => {
  ev.preventDefault();
  const v = $view();
  if (v) { v.setAttribute('tabindex', '-1'); v.focus(); }
});

// ── 캐시 로더 ──
function getOverview(force) {
  if (!force && state.overview) return Promise.resolve(state.overview);
  return api('/api/ui/ctx/overview').then((o) => { state.overview = o; updateSyncChip(); updateReviewBadge(); return o; });
}

function updateSyncChip() {
  const chip = document.getElementById('sync-chip');
  const label = document.getElementById('sync-label');
  if (!state.overview || !state.overview.kinds) return;
  // 전 kind 중 가장 최근 갱신시각을 '살아있음' 신호로(§7 — 마지막 갱신 노출).
  let latest = null;
  for (const k of state.overview.kinds) {
    if (k.latest_updated_at && (!latest || k.latest_updated_at > latest)) latest = k.latest_updated_at;
  }
  if (latest) { label.textContent = relTime(latest) + ' 갱신'; chip.hidden = false; }
}
function updateReviewBadge() {
  const badge = document.getElementById('review-count');
  if (!badge) return;
  const n = state.overview ? state.overview.review_pending : 0;
  if (n > 0) { badge.textContent = String(n); badge.hidden = false; }
  else badge.hidden = true;
}

// ── 토큰 게이트 ──
function showGate(message) {
  document.getElementById('app').hidden = true;
  const gate = document.getElementById('gate');
  gate.hidden = false;
  const err = document.getElementById('gate-error');
  if (message) { err.textContent = message; err.hidden = false; }
  document.getElementById('gate-input').focus();
}
function hideGate() {
  document.getElementById('gate').hidden = true;
  document.getElementById('app').hidden = false;
}
document.getElementById('gate-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const input = document.getElementById('gate-input');
  const err = document.getElementById('gate-error');
  const v = input.value.trim();
  if (!v) return;
  try {
    const res = await fetch('/api/ui/me', { headers: { Authorization: 'Bearer ' + v } });
    if (res.ok) {
      localStorage.setItem(TOKEN_KEY, v);
      input.value = '';
      err.hidden = true;
      hideGate();
      boot();
    } else {
      err.textContent = '토큰이 유효하지 않습니다.';
      err.hidden = false;
    }
  } catch (_) {
    err.textContent = '서버에 연결하지 못했습니다.';
    err.hidden = false;
  }
});

// ── 에러 표시 헬퍼 ──
function errorNote(e, prefix) {
  if (e && e.status === 403) {
    return el('div', { class: 'note', text: '이 토큰에 필요한 권한(memory)이 없습니다.' });
  }
  return el('div', { class: 'note', text: (prefix || '불러오지 못했습니다') + ' — ' + (e && e.message ? e.message : '알 수 없는 오류') });
}

// ── 공용: 상태 점 + 라벨(§0.5 — 채운 필 금지, 6px 점 + 무채 텍스트) ──
function lifecycleDot(lifecycle) {
  const cls = lifecycle === 'active' ? 'st ok' : (lifecycle === 'rejected' ? 'st dim' : 'st');
  return el('span', { class: cls, text: LIFECYCLE_LABEL[lifecycle] || lifecycle });
}
function confidenceDot(confidence) {
  // 출처(provenance) 점: ai=점만(중립), human=민트(사람 저작/승인), rule=연회색, observed=연회색(외부 미러 — 큐레이션 아님).
  const cls = confidence === 'human' ? 'st ok'
    : (confidence === 'rule' || confidence === 'observed') ? 'st dim' : 'st';
  return el('span', { class: cls, text: CONFIDENCE_LABEL[confidence] || confidence });
}

// ════════════════════════════════════════════
// 1) 지식 지도 #/map — ctx_overview. kind 카드 + 시스템 건강.
// ════════════════════════════════════════════
// '회사 맥락' 상위 탭의 가로 중분류(지도·탐색·검토) — 관리 탭 .admin-cats 와 같은 패턴.
//  세 하위뷰(renderMap/Browse/Review) 맨 위에 동일하게 깔아 한 탭처럼 묶는다. 검토 대기 배지는 상위 탭(updateReviewBadge).

// '시작하기' 상위 탭의 가로 중분류(설치·사용설명서) — 같은 sub-cats 패턴. 가이드는 top 탭에서 빼 여기로(한 번 읽는 온보딩).
const START_SUBS = [
  { key: 'install', label: '설치', href: '#/install' },
  { key: 'learn', label: '사용설명서', href: '#/learn' },
];
function stat(num, label, unit) {
  return el('div', { class: 'stat' },
    el('div', { class: 'num' }, num, unit ? el('small', {}, ' ' + unit) : null),
    el('div', { class: 'lbl', text: label }));
}
// 검토 대기 — 0 이면 무채(건강), >0 이면 클릭 가능(검토로 이동).
function selectFilter(opts, sel) {
  const s = el('select');
  for (const [v, t] of opts) s.append(el('option', { value: v, text: t }));
  s.value = sel || '';
  return s;
}

// ── P-V3-4a 도메인 통제어휘 select ──
// 도메인은 자유 키워드가 아니라 repo 하위 통제 어휘. 드롭다운은 domain_list(=/api/ui/domainmap/:repo/domains)로
// 채운다. 도메인맵이 죽거나 repo 미존재면 graceful: 캐시에 error 를 남기고 호출부가 자유입력 폴백을 쓴다.
// V5 탈-repo 통합 도메인 캐시 — 전 repo + business(조직평면) 통제어휘. 저장/필터 드롭다운의 단일 소스.
//  /api/ui/domains(listAllDomains)는 (space,key) 평면 — repo 컬럼 없음. 도메인맵 down 이면 error 로 graceful.
async function loadAllDomains(force) {
  const cached = state.allDomains;
  if (cached && cached.loaded && !force) return cached;
  const slot = { list: [], loaded: false, error: null };
  state.allDomains = slot;
  try {
    const rows = await api('/api/ui/domains');
    slot.list = (rows || []).map((d) => ({ key: d.key, name: d.name, state: d.state, cross_cutting: d.cross_cutting, space: d.space || 'product', active_count: d.active_count }));
    slot.loaded = true;
  } catch (e) { slot.error = e.message || '도메인 목록을 불러오지 못했습니다'; slot.loaded = true; }
  return slot;
}

async function loadDomains(repo, force) {
  const key = repo || VOCAB_CRUD_DEFAULT_REPO;
  const cached = state.domains[key];
  if (cached && cached.loaded && !force) return cached;
  const slot = { list: [], loaded: false, error: null };
  state.domains[key] = slot;
  try {
    const rows = await api('/api/ui/domainmap/' + encodeURIComponent(key) + '/domains');
    // merged 제외는 서버가 이미 함. deprecated 는 표시하되 라벨에 표기(기존 매핑 유효 — 큐레이션 신호).
    //  V4-P5: space(product|business) — 서버 listDomainsApi 가 항상 방출(?? 'product'). area 1차 필터에 쓴다.
    slot.list = (rows || []).map((d) => ({ key: d.key, name: d.name, state: d.state, cross_cutting: d.cross_cutting, space: d.space || 'product' }));
    slot.loaded = true;
  } catch (e) { slot.error = e.message || '도메인 목록을 불러오지 못했습니다'; slot.loaded = true; }
  return slot;
}

// repo 셀렉터 — repo_list union 의 repos[] 로 채운다(domainmap ∪ 매핑테이블). 단일 repo 면 라벨만.
async function loadRepos() {
  if (state.domains.__repos__) return state.domains.__repos__;
  let repos = [VOCAB_CRUD_DEFAULT_REPO];
  try { const r = await api('/api/ui/repos'); if (r && Array.isArray(r.repos) && r.repos.length) repos = r.repos; }
  catch (_) { /* graceful: 기본 repo 만 */ }
  state.domains.__repos__ = repos;
  return repos;
}

// 통제어휘 <select> 빌드. current 가 목록에 없으면(옛 별칭·도메인맵 down) 그 값을 보존 옵션으로 추가해
// 무심코 도메인이 비워지지 않게 한다. 빈 선택('도메인 없음') 항상 포함.
//  space 인자(product|business)가 주어지면 그 space 의 도메인만 노출(area 2단 — 1차 space → 2차 domain).
//  단, current 가 다른 space 라도 보존(끊김 방지). emptyLabel 로 빈 옵션 라벨 커스터마이즈.
function buildDomainSelect(slot, current, space, emptyLabel) {
  const s = el('select', { class: 'flt-domain' });
  s.append(el('option', { value: '', text: emptyLabel || '— 도메인 없음 —' }));
  const have = new Set();
  for (const d of slot.list) {
    if (space && (d.space || 'product') !== space) continue; // area 1차(space) 필터
    have.add(d.key);
    const label = d.key + (d.name && d.name !== d.key ? ' · ' + d.name : '') + (d.state === 'deprecated' ? ' (폐기)' : '');
    s.append(el('option', { value: d.key, text: label }));
  }
  if (current && !have.has(current)) {
    // 옛 별칭/미존재/다른 space — 보존 옵션(서버가 alias 해소 또는 graceful 통과). 비표준임을 표기.
    s.append(el('option', { value: current, text: current + ' (현재 값 · 목록 외)' }));
  }
  s.value = current || '';
  return s;
}
// space(area 1차) <select> — 전체/제품/비즈니스. 도메인 드롭다운을 1차로 좁힌다.
function interleave(arr, sep) {
  const out = [];
  arr.forEach((n, i) => { if (i) out.push(sep); out.push(n); });
  return out;
}

// ════════════════════════════════════════════
// 3) 유닛 상세 #/u/<name> — ctx_cat 전문 + 메타 패널 + 편집/반려.
// ════════════════════════════════════════════
async function renderDomainmap(view, params) {
  view.replaceChildren(skeleton('도메인 맵을 불러오는 중'));
  const repos = await loadRepos();
  let repo = (params && params.get('repo')) || state.dmRepo
    || (repos.includes(VOCAB_CRUD_DEFAULT_REPO) ? VOCAB_CRUD_DEFAULT_REPO : repos[0]);
  if (!repos.includes(repo)) repo = repos[0];
  state.dmRepo = repo;

  const head = el('div', { class: 'page-head' },
    el('h1', {}, '도메인-코드 ', el('span', { class: 'accent', text: '의존성' })),
    el('p', { class: 'sub', text: '도메인마다 의도(should)와 코드 구조(is)를 나란히 두고, 둘의 괴리(debt)를 드러냅니다. 아래에서 의도가 어떻게 바뀌어 왔는지, 어떤 커밋이 구조를 바꿨는지도 볼 수 있습니다.' }),
  );

  // repo 셀렉터 — 복수일 때만(단일이면 라벨 생략, 작업현황/어휘관리와 동일 패턴).
  let repoBar = null;
  if (repos.length > 1) {
    const sel = el('select', { class: 'flt-domain' });
    for (const r of repos) sel.append(el('option', { value: r, text: r }));
    sel.value = repo;
    sel.addEventListener('change', () => { state.dmRepo = sel.value; location.hash = '#/domainmap?repo=' + encodeURIComponent(sel.value); });
    repoBar = el('div', { class: 'filter-bar' }, el('span', { class: 'field-label', text: '레포' }), sel);
  }

  let data;
  try {
    data = await api('/api/ui/domainmap/map?' + new URLSearchParams({ repo, limit: '150' }));
  } catch (e) {
    view.replaceChildren(...[head, repoBar, errorNote(e, '도메인 맵을 불러오지 못했습니다')].filter(Boolean));
    return;
  }
  const nodes = [head, repoBar,
    ...domainmapBody(data, repos.length > 1 ? repo : null)].filter(Boolean);
  view.replaceChildren(...nodes);
}

// 도메인맵 본문 빌더 — fetched data(/api/ui/domainmap/map)에서 통계 카드 + 도메인/괴리/이력 섹션 노드 배열을 만든다.
//  renderDomainmap(#/domainmap)과 카테고리 제품(space=product) 화면이 공유(동작 동일, 표면만 다름).
//  firstSectionHint: 첫 섹션(도메인 목록) 헤더 옆 보조 라벨(예: 복수 레포일 때 레포명) — 없으면 생략.
function domainmapBody(data, firstSectionHint) {
  const domains = data.domains || [];
  const debts = (data.debts || []).filter((d) => d.status !== 'resolved' && d.status !== 'dismissed');
  const shoulds = data.should_changes || [];
  const isChanges = data.is_commit_changes || [];

  // ── 요약 스탯 ──
  const withShould = domains.filter((d) => d.should && d.should.trim()).length;
  const gapCount = debts.filter((d) => DM_SEV_OF(d.title) === 'should_no_is').length;
  const statCard = el('div', { class: 'card' }, el('div', { class: 'stat-row' },
    stat(fmtNum(domains.length), '도메인', '개'),
    stat(fmtNum(withShould), '의도(should) 설정됨', '/ ' + domains.length),
    stat(fmtNum(debts.length), '괴리·이슈(debt)', gapCount ? ('· 괴리 ' + gapCount) : '건'),
  ));

  // ── 도메인별 should | is | debt ──
  const tone = (d) => (d.debts > 0 ? ' has-debt' : '');
  function domainRow(d) {
    const hasShould = !!(d.should && d.should.trim());
    return el('div', { class: 'dm-dom' + tone(d) },
      el('div', { class: 'dm-dom-head' },
        el('span', { class: 'mono dm-dom-key', text: d.key }),
        d.name && d.name !== d.key ? el('span', { class: 'dm-dom-name', text: d.name }) : null,
        d.cross_cutting ? el('span', { class: 'dm-tag', text: '횡단' }) : null,
        d.space === 'business' ? el('span', { class: 'dm-tag', text: '비즈니스' }) : null,
        d.debts > 0 ? el('span', { class: 'dm-debt-chip', text: '괴리 ' + fmtNum(d.debts) }) : null,
      ),
      el('div', { class: 'dm-axes' },
        el('div', { class: 'dm-axis dm-should' },
          el('span', { class: 'dm-axis-label', text: '의도 · should' }),
          hasShould
            ? el('span', { class: 'dm-axis-val', text: d.should })
            : el('span', { class: 'dm-axis-empty', text: '아직 설정 안 됨' })),
        el('div', { class: 'dm-axis dm-is' },
          el('span', { class: 'dm-axis-label', text: '구조 · is' }),
          el('span', { class: 'dm-axis-val' },
            el('strong', { text: fmtNum(d.units) }), ' 코드',
            d.entities ? el('span', {}, ' · ', el('strong', { text: fmtNum(d.entities) }), ' 엔티티') : null,
            d.proposed ? el('span', { class: 'dm-prop', text: ' · 제안 ' + fmtNum(d.proposed) }) : null,
            (!d.units && !d.entities) ? el('span', { class: 'dm-axis-empty', text: '  매핑된 코드 없음' }) : null)),
      ),
    );
  }

  // ── 괴리(debt) — should↔is 괴리 먼저, 그다음 구조 신호 ──
  const debtSorted = [...debts].sort((a, b) => DM_SEV_RANK[DM_SEV_OF(a.title)] - DM_SEV_RANK[DM_SEV_OF(b.title)]);
  function debtRow(dt) {
    const sev = DM_SEV_OF(dt.title);
    return el('div', { class: 'dm-debt dm-sev-' + sev },
      el('div', { class: 'dm-debt-top' },
        el('span', { class: 'dm-sev-tag', text: DM_SEV_LABEL[sev] }),
        el('span', { class: 'dm-debt-title', text: dt.title }),
        dt.status && dt.status !== 'open' ? el('span', { class: 'dm-debt-status', text: dt.status }) : null),
      dt.detail ? el('div', { class: 'dm-debt-detail', text: dt.detail }) : null,
    );
  }

  // ── 의도(should) 변경 이력 — 누가·어떤 작업으로 의도를 어떻게 바꿨나(before→after) ──
  const valOr = (s, fallback) => (s && s.trim() ? s : fallback);
  function shouldChangeRow(c) {
    return el('div', { class: 'dm-change' },
      el('div', { class: 'dm-change-top' },
        el('span', { class: 'mono', text: c.domain_key || ('#' + c.domain_id) }),
        c.domain_name ? el('span', { class: 'dm-change-dom', text: c.domain_name }) : null,
        el('span', { class: 'dm-change-when', text: relTime(c.at) })),
      el('div', { class: 'dm-diff' },
        el('div', { class: 'dm-diff-side dm-before' },
          el('span', { class: 'dm-diff-label', text: '이전' }),
          el('span', { class: 'dm-diff-val', text: valOr(c.should_before, '(없음)') })),
        el('span', { class: 'dm-diff-arrow', 'aria-hidden': 'true', text: '→' }),
        el('div', { class: 'dm-diff-side dm-after' },
          el('span', { class: 'dm-diff-label', text: '이후' }),
          el('span', { class: 'dm-diff-val', text: valOr(c.should_after, '(없음)') }))),
      el('div', { class: 'dm-change-by' },
        c.activity_id
          ? el('span', { class: 'dm-by-act' }, actTypeTag(c.activity_type), el('span', { class: 'dm-act-title', text: c.activity_title || '' }))
          : el('span', { class: 'dm-change-noact', text: '작업 귀속 없음' }),
        el('span', { class: 'dm-change-who', text: (c.author_person || c.actor_id || '미상') + (c.author_agent ? ' · ' + c.author_agent : '') })),
    );
  }

  // ── 커밋 → 구조(is) 변경 이력 — 어떤 커밋이 code_unit/매핑을 어떻게 바꿨나 ──
  function isChangeRow(c) {
    const label = c.entity_type === 'code_unit' ? (c.code_path || c.code_label || ('code_unit #' + c.entity_id))
      : c.entity_type === 'mapping' ? ('매핑' + (c.domain_key ? ' → ' + c.domain_key : ''))
        : (c.entity_type + ' #' + c.entity_id);
    return el('div', { class: 'dm-change' },
      el('div', { class: 'dm-change-top' },
        el('span', { class: 'dm-op-tag', text: DM_OP_LABEL[c.op] || c.op }),
        el('span', { class: 'mono dm-is-ent', text: label }),
        el('span', { class: 'dm-change-when', text: relTime(c.at) })),
      el('div', { class: 'dm-change-by' },
        el('span', { class: 'dm-by-act' }, actTypeTag('commit'), el('span', { class: 'dm-act-title', text: c.activity_title || '' })),
        c.commit_sha ? el('span', { class: 'mono dm-commit', text: c.commit_sha.slice(0, 8) }) : null,
        el('span', { class: 'dm-change-who', text: (c.author_person || c.actor_id || '미상') + (c.author_agent ? ' · ' + c.author_agent : '') })),
    );
  }

  function section(title, hint, rows, emptyText) {
    const box = el('div', { class: 'card dm-section' },
      el('div', { class: 'card-head' }, el('h2', { text: title }),
        hint ? el('span', { class: 'dm-section-hint', text: hint }) : null));
    box.append(rows.length
      ? el('div', { class: 'dm-list' }, ...rows)
      : el('div', { class: 'empty', text: emptyText }));
    return box;
  }

  return [
    statCard,
    section('도메인별 의도(should) · 구조(is) · 괴리(debt)', firstSectionHint || null,
      domains.map(domainRow), '이 레포에 도메인이 없습니다.'),
    section('괴리(debt) — 의도와 구조의 간극', gapCount ? ('should↔is 괴리 ' + fmtNum(gapCount) + '건 포함') : null,
      debtSorted.map(debtRow), '표면화된 괴리·이슈가 없습니다.'),
    section('의도(should) 변경 이력', '누가 · 어떤 작업으로 의도를 바꿨나',
      shoulds.map(shouldChangeRow), '아직 의도(should) 변경 기록이 없습니다. 의도를 설정·수정하면 여기 쌓입니다.'),
    section('커밋 → 구조(is) 변경 이력', '어떤 커밋이 코드 구조를 바꿨나',
      isChanges.map(isChangeRow), '아직 커밋이 구조(is)를 바꾼 기록이 없습니다. commit 작업이 코드를 건드리면 여기 쌓입니다.'),
  ].filter(Boolean);
}

// ════════════════════════════════════════════
// 카테고리 #/categories — 맥락의 분류축(Category). space ∈ {사업·제품·시스템}별 하위 카테고리 CRUD.
//  맥락 = Category(분류축) + Knowledge(기록) + Project(변화). 이 탭은 Category 트리를 관리한다.
//  제품(product) space 의 하위 카테고리는 '도메인(domain)' — 목록 아래에 도메인맵(should/is/debt) +
//  도메인↔도메인 의존 관계(category-edges) 섹션을 함께 보여준다. 사업·시스템은 카테고리 목록만.
//  데이터: GET/POST /api/ui/categories(?space=) · POST /api/ui/categories/:id(/delete) ·
//          GET/POST /api/ui/category-edges(/:id/delete) · GET /api/ui/domainmap/map(제품 도메인맵).
// ════════════════════════════════════════════
// space 하위 탭(사업·제품·시스템) — ctxSubBar 와 같은 .sub-cats 패턴. prefix 를 받아 다른 상위 탭(지식 등)이
//  재사용할 수 있게 한다(예: spaceSubBar('#/knowledge', space)). active = business|product|system.
const SPACE_SUBS = [
  { key: 'business', label: '사업', href: '#/categories/business' },
  { key: 'product', label: '제품', href: '#/categories/product' },
  { key: 'system', label: '시스템', href: '#/categories/system' },
];
const SPACE_LABEL = { business: '사업', product: '제품', system: '시스템' };
function spaceSubBar(prefix, active) {
  const bar = el('div', { class: 'sub-cats', role: 'tablist', 'aria-label': '분류축' });
  for (const s of SPACE_SUBS) {
    const on = s.key === active;
    // prefix 가 주어지면 href 를 prefix/<key> 로(재사용), 없으면 SPACE_SUBS 기본 href(#/categories/...).
    const href = prefix ? (prefix.replace(/\/$/, '') + '/' + s.key) : s.href;
    bar.append(el('a', { class: 'sub-cat' + (on ? ' active' : ''), href,
      role: 'tab', 'aria-selected': on ? 'true' : 'false', text: s.label }));
  }
  return bar;
}

// 이름 → 슬러그 키(소문자 a-z0-9-). 한글 등 비-ASCII 는 제거되므로, 결과가 비면 사용자가 키를 직접 입력해야 한다.
function slugifyKey(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9\s_-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function openCategoryForm(space, existing, reload) {
  const editing = !!existing;
  const nameIn = el('input', { type: 'text', placeholder: '카테고리 이름', maxlength: '200',
    value: editing ? (existing.name || '') : '' });
  const keyIn = el('input', { type: 'text', placeholder: '키 (소문자 영문·숫자·-, 비우면 이름에서 자동)', maxlength: '120',
    value: editing ? (existing.key || '') : '' });
  if (editing) keyIn.disabled = true; // 키는 생성 후 불변(엔드포인트가 수정 지원 안 함)
  const shouldIn = el('textarea', { rows: '4', placeholder: '정의 · 범위 · 규칙 (should)', maxlength: '8000',
    value: editing ? (existing.should || '') : '' });
  const descIn = el('textarea', { rows: '2', placeholder: '한 줄 설명 (선택)', maxlength: '2000',
    value: editing ? (existing.description || '') : '' });
  const saveBtn = el('button', { class: 'btn btn-primary', text: editing ? '저장' : '만들기' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  const back = overlayBox(editing ? '카테고리 수정' : ('새 카테고리 · ' + (SPACE_LABEL[space] || space)),
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '키' }), keyIn),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '정의 · 범위 · 규칙 (should)' }), shouldIn),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '설명 (선택)' }), descIn),
    el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
  setTimeout(() => nameIn.focus(), 0);

  const go = async () => {
    const name = nameIn.value.trim();
    if (!name) { nameIn.focus(); toast('이름을 입력하세요', true); return; }
    saveBtn.disabled = true;
    try {
      if (editing) {
        await api('/api/ui/categories/' + existing.id, { method: 'POST', body: JSON.stringify({
          name, should: shouldIn.value.trim() || undefined, description: descIn.value.trim() || undefined,
        }) });
        toast('저장했습니다');
      } else {
        const key = (keyIn.value.trim() || slugifyKey(name));
        if (!key) { saveBtn.disabled = false; keyIn.focus(); toast('키를 입력하세요(이름에 영문이 없으면 자동 생성이 안 됩니다)', true); return; }
        await api('/api/ui/categories', { method: 'POST', body: JSON.stringify({
          space, key, name, should: shouldIn.value.trim() || undefined, description: descIn.value.trim() || undefined,
        }) });
        toast('카테고리를 만들었습니다');
      }
      back.remove();
      reload();
    } catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
  saveBtn.onclick = go;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

// 도메인 의존 관계(category-edges) — should(사람 작성·편집/삭제 가능) + is(스캔 소유·읽기전용)를 한 섹션에.
//  domains = 제품 카테고리 목록(셀렉터 옵션). 자체 fetch → 행 렌더 + should-edge 추가 폼.
function knowledgeSubBar(active) {
  // space 하위 탭(사업·제품·시스템)만. 도메인-코드 의존성(코드구조)은 독립 탭으로 분리(2026-06-24).
  return spaceSubBar('#/knowledge', SPACE_LABEL[active] ? active : '');
}

// injection(주입축) 한글 라벨 — 칩 표기는 짧게(항상 주입 / 검색). 힌트는 비개발자 친화 한 줄 설명.
const KN_INJECTION_LABEL = { always: '항상 주입', recalled: '검색' };
const KN_INJECTION_HINT = {
  always: '규칙·페르소나처럼 모든 세션에 항상 주입됩니다.',
  recalled: '관련될 때 의미검색으로 소환됩니다.',
};
// provenance(출처축) 한글 라벨 — authored=직접 저작, observed=외부 시스템의 살아있는 미러.
const KN_PROVENANCE_LABEL = { authored: '저작', observed: '외부 미러' };
const KN_PROVENANCE_HINT = {
  authored: '이 시스템에 직접 저작한 지식입니다.',
  observed: '외부 시스템에서 가져온 살아있는 미러입니다(진실·편집은 외부에).',
};

// injection/provenance 칩 — 종류 뱃지(kindBadge)와 같은 작은 인라인 표식. title 로 한 줄 설명 노출.
function knInjectChip(injection) {
  return el('span', { class: 'kn-chip kn-inject kn-inject-' + (injection || 'na'),
    title: KN_INJECTION_HINT[injection] || '', text: KN_INJECTION_LABEL[injection] || injection || '—' });
}
function knProvChip(provenance) {
  return el('span', { class: 'kn-chip kn-prov kn-prov-' + (provenance || 'na'),
    title: KN_PROVENANCE_HINT[provenance] || '', text: KN_PROVENANCE_LABEL[provenance] || provenance || '—' });
}

// 지식 한 행 — 제목(상세 링크) + injection 칩 + provenance 칩 + lifecycle 점 + 갱신시각.
//  select={names:Set, onToggle} 가 오면 선택(체크) 모드 — 클릭=상세이동 대신 선택 토글, .row.sel 로 표시.
function knRow(e, select) {
  const titleEl = el('div', { class: 'row-title', text: e.title || e.name });
  const metaEl = el('div', { class: 'row-meta' },
    knInjectChip(e.injection), ' ', knProvChip(e.provenance),
    e.lifecycle ? el('span', {}, '  ', lifecycleDot(e.lifecycle)) : null,
    '  ', relTime(e.updated_at));
  if (!select) {
    const row = el('div', { class: 'row', role: 'link', tabindex: '0' }, titleEl, metaEl);
    const go = () => { location.hash = '#/k/' + encodeURIComponent(e.name); };
    row.addEventListener('click', go);
    row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
    return row;
  }
  // 선택 모드 — 행 전체가 토글(체크박스는 pointer-events:none 표시용).
  const on0 = select.names.has(e.name);
  const cb = el('input', { type: 'checkbox', class: 'row-check', tabindex: '-1', 'aria-hidden': 'true' });
  cb.checked = on0;
  const row = el('div', { class: 'row row-pick' + (on0 ? ' sel' : ''), role: 'button', tabindex: '0', 'aria-pressed': String(on0) },
    cb, el('div', { class: 'row-pick-body' }, titleEl, metaEl));
  const toggle = () => {
    const on = !select.names.has(e.name);
    if (on) select.names.add(e.name); else select.names.delete(e.name);
    row.classList.toggle('sel', on); cb.checked = on; row.setAttribute('aria-pressed', String(on));
    select.onToggle();
  };
  row.addEventListener('click', toggle);
  row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
  return row;
}

// 지식 탭 진입 — sub ∈ {business, product, system, stats, review}. space 셋이면 2분할 뷰, 그 외 통계/검토.
async function renderKnowledge(view, sub, params) {
  if (sub === 'stats') return renderKnowledgeStats(view);
  if (sub === 'review') return renderKnowledgeReview(view);
  const space = SPACE_LABEL[sub] ? sub : 'business';
  return renderKnowledgeSpace(view, space, params);
}

// space 뷰(사업·제품·시스템) — 좌측 카테고리 사이드바(필터) + 우측 지식 목록(검색·injection·provenance 필터).
async function renderKnowledgeSpace(view, space, params) {
  const f = (state.knowledge = state.knowledge || { space, category: '', injection: '', provenance: '', q: '' });
  // space 가 바뀌면 카테고리 필터는 초기화(다른 space 의 카테고리 id 는 무의미).
  if (f.space !== space) { f.space = space; f.category = ''; }
  if (params) {
    if (params.has('category')) f.category = params.get('category') || '';
    if (params.has('injection')) f.injection = params.get('injection') || '';
    if (params.has('provenance')) f.provenance = params.get('provenance') || '';
    if (params.has('q')) f.q = params.get('q') || '';
  }

  view.replaceChildren(knowledgeSubBar(space), skeleton('지식을 불러오는 중'));

  // 선택(일괄삭제) 상태 — 리페치 없이 로컬 재페인트. names = 선택된 지식 name 집합.
  const sel = { mode: false, names: new Set() };
  let lastEntries = [];
  const bulkBar = el('div', { class: 'bulk-bar', hidden: true });
  const selectBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '선택', title: '여러 지식을 골라 한 번에 삭제',
    onclick: () => { sel.mode = !sel.mode; if (!sel.mode) sel.names.clear(); paintList(); repaintBulk(); } });

  const head = el('div', { class: 'page-head' },
    el('div', { class: 'page-head-row' },
      el('h1', {}, '지', el('span', { class: 'accent', text: '식' })),
      el('div', { style: 'display:flex; gap:8px; align-items:center;' }, selectBtn,
        el('a', { class: 'btn btn-ghost btn-sm', href: '#/trash', text: '🗑 휴지통' }))),
    el('p', { class: 'sub', text: '맥락의 기록 — ' + SPACE_LABEL[space] + ' 영역의 지식. 왼쪽에서 카테고리로 좁히고, 위에서 검색·주입·출처로 거릅니다. 주입(항상/검색)과 출처(저작/외부 미러)는 직교 두 축입니다.' }),
  );

  // 좌측 카테고리 사이드바(이 space 의 카테고리 + '전체'). 클릭 = 필터(category_id).
  const side = el('aside', { class: 'browse-side' });
  let cats = [];
  try {
    cats = await api('/api/ui/categories?' + new URLSearchParams({ space })).then((d) => (d && d.categories) || []);
  } catch (_) { /* graceful: 사이드바 카테고리 생략(목록은 계속) */ }
  function buildSide() {
    const nav = el('nav', { class: 'browse-tree', 'aria-label': '카테고리' });
    nav.append(knSideItem('전체', '', f.category === ''));
    for (const c of cats) nav.append(knSideItem(c.name || c.key, String(c.id), String(f.category) === String(c.id)));
    side.replaceChildren(el('div', { class: 'eyebrow', text: '카테고리' }), nav);
  }
  buildSide();

  // 상단 필터 — 검색(q) + injection select + provenance select.
  const qInput = el('input', { type: 'search', placeholder: '제목·본문 검색', value: f.q, 'aria-label': '검색어' });
  const injSel = selectFilter([['', '전체 주입'], ['always', '항상 주입'], ['recalled', '검색']], f.injection);
  injSel.setAttribute('aria-label', '주입');
  const provSel = selectFilter([['', '전체 출처'], ['authored', '저작'], ['observed', '외부 미러']], f.provenance);
  provSel.setAttribute('aria-label', '출처');

  const listBox = el('div', { class: 'list-box browse-list' });
  const foot = el('div', { class: 'list-foot' });

  function syncHash() {
    const p = new URLSearchParams();
    if (f.category) p.set('category', f.category);
    if (f.injection) p.set('injection', f.injection);
    if (f.provenance) p.set('provenance', f.provenance);
    if (f.q) p.set('q', f.q);
    const qs = p.toString();
    history.replaceState(null, '', '#/knowledge/' + space + (qs ? '?' + qs : ''));
  }

  // 목록 페인트(서버 페치 분리) — 선택 모드면 행을 체크 가능하게 렌더.
  function paintList() {
    if (!lastEntries.length) {
      listBox.replaceChildren(el('div', { class: 'empty', text: '조건에 맞는 지식이 없습니다. 필터를 넓혀 보세요.' }));
      return;
    }
    const select = sel.mode ? { names: sel.names, onToggle: repaintBulk } : null;
    listBox.replaceChildren(...lastEntries.map((e) => knRow(e, select)));
  }

  // 선택 바 — 선택 모드일 때만. 전체선택/해제 + 선택 삭제(휴지통). 선택 버튼은 선택↔취소 토글.
  function repaintBulk() {
    selectBtn.textContent = sel.mode ? '취소' : '선택';
    if (!sel.mode) { bulkBar.hidden = true; bulkBar.replaceChildren(); return; }
    const n = sel.names.size;
    const allOn = lastEntries.length > 0 && lastEntries.every((e) => sel.names.has(e.name));
    const allBtn = el('button', { class: 'btn btn-ghost btn-sm', text: allOn ? '전체 해제' : '전체 선택',
      onclick: () => { if (allOn) sel.names.clear(); else lastEntries.forEach((e) => sel.names.add(e.name)); paintList(); repaintBulk(); } });
    const delBtn = el('button', { class: 'btn btn-sm btn-danger', text: '선택 삭제',
      onclick: () => bulkDelete(delBtn) });
    delBtn.disabled = n === 0; // el 은 setAttribute('disabled', false) 라 여전히 비활 — 프로퍼티로 설정해야 해제됨
    bulkBar.hidden = false;
    bulkBar.replaceChildren(
      el('span', { class: 'bulk-bar-count', text: n ? n + '개 선택됨' : '삭제할 지식을 고르세요' }),
      el('div', { class: 'bulk-bar-actions' }, allBtn, delBtn));
  }

  async function bulkDelete(btn) {
    const names = [...sel.names];
    if (!names.length) return;
    if (!confirm(names.length + '개 지식을 삭제할까요?\n\n활성 목록·검색·주입에서 사라집니다. 휴지통(#/trash)에서 복원할 수 있습니다.')) return;
    btn.disabled = true;
    // 병렬 삭제 — 일부 실패해도 나머지 진행(성공/실패 건수 보고). 서버가 사람전용 403 재검증.
    const results = await Promise.allSettled(
      names.map((nm) => api('/api/ui/knowledge/' + encodeURIComponent(nm) + '/delete', { method: 'POST' })));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const fail = results.length - ok;
    toast(fail ? (ok + '개 삭제 · ' + fail + '개 실패') : (ok + '개 지식을 삭제했습니다 — 휴지통에서 복원 가능'), fail > 0);
    sel.mode = false; sel.names.clear();
    refetch();
  }

  async function refetch() {
    listBox.replaceChildren(skeletonRows(4));
    foot.replaceChildren();
    try {
      const p = new URLSearchParams({ space, limit: '200', orderBy: 'updated_at' });
      if (f.category) p.set('category', f.category);
      if (f.injection) p.set('injection', f.injection);
      if (f.provenance) p.set('provenance', f.provenance);
      if (f.q.trim()) p.set('q', f.q.trim());
      const r = await api('/api/ui/knowledge?' + p.toString());
      const entries = (r && r.entries) || [];
      lastEntries = entries;
      // 필터로 사라진 선택 정리(이후 화면에 없는 name 은 선택 해제).
      const present = new Set(entries.map((e) => e.name));
      sel.names.forEach((nm) => { if (!present.has(nm)) sel.names.delete(nm); });
      paintList();
      repaintBulk();
      foot.replaceChildren(el('span', { class: 'caption', text: entries.length + '건' }));
    } catch (e) {
      listBox.replaceChildren(errorNote(e, '지식을 불러오지 못했습니다'));
    }
  }

  let qTimer = null;
  qInput.addEventListener('input', () => { f.q = qInput.value; clearTimeout(qTimer); qTimer = setTimeout(() => { syncHash(); refetch(); }, 280); });
  injSel.addEventListener('change', () => { f.injection = injSel.value; syncHash(); refetch(); });
  provSel.addEventListener('change', () => { f.provenance = provSel.value; syncHash(); refetch(); });
  // 좌측 클릭 위임(side 컨테이너 — buildSide 가 내부를 교체해도 핸들러 유지).
  side.addEventListener('click', (ev) => {
    const item = ev.target.closest('[data-cat-val]');
    if (!item) return;
    ev.preventDefault();
    f.category = item.dataset.catVal || '';
    buildSide(); syncHash(); refetch();
  });

  const filterBar = el('div', { class: 'filter-bar browse-filter' }, qInput, injSel, provSel);
  const layout = el('div', { class: 'browse-layout' },
    side,
    el('section', { class: 'browse-main' }, filterBar, bulkBar, listBox, foot),
  );
  view.replaceChildren(head, knowledgeSubBar(space), layout);
  applyReveal([layout]);
  refetch();
}

// 카테고리 사이드바 행 — tree-item 패턴. data-cat-val 로 클릭 위임(빈 문자열=전체).
function knSideItem(label, catVal, on) {
  return el('a', { class: 'tree-item' + (on ? ' on' : ''), href: '#', 'data-cat-val': catVal, role: 'button', tabindex: '0' },
    el('span', { class: 'tree-glyph all', 'aria-hidden': 'true', text: catVal ? '·' : '∗' }),
    el('span', { class: 'tree-label', text: label }));
}

// 통계 뷰 — 전 지식을 한 번 가져와 injection/provenance/space 별 집계 카드로.
async function renderKnowledgeStats(view) {
  view.replaceChildren(knowledgeSubBar('stats'), skeleton('통계를 집계하는 중'));
  const head = el('div', { class: 'page-head' },
    el('h1', {}, '지식 ', el('span', { class: 'accent', text: '통계' })),
    el('p', { class: 'sub', text: '맥락 기록의 두 직교축(주입·출처)과 영역(space)별 분포. 전체 활성 지식 기준.' }),
  );
  let entries;
  try {
    entries = await api('/api/ui/knowledge?' + new URLSearchParams({ limit: '500', orderBy: 'updated_at' })).then((d) => (d && d.entries) || []);
  } catch (e) {
    view.replaceChildren(head, knowledgeSubBar('stats'), errorNote(e, '통계를 불러오지 못했습니다'));
    return;
  }
  const byInj = { always: 0, recalled: 0 };
  const byProv = { authored: 0, observed: 0 };
  for (const e of entries) {
    if (e.injection in byInj) byInj[e.injection]++;
    if (e.provenance in byProv) byProv[e.provenance]++;
  }
  const injCard = el('div', { class: 'card' },
    el('h2', { text: '주입축 (injection)' }),
    el('div', { class: 'stat-row' },
      stat(fmtNum(byInj.always), '항상 주입', '건'),
      stat(fmtNum(byInj.recalled), '검색 소환', '건')));
  const provCard = el('div', { class: 'card' },
    el('h2', { text: '출처축 (provenance)' }),
    el('div', { class: 'stat-row' },
      stat(fmtNum(byProv.authored), '저작', '건'),
      stat(fmtNum(byProv.observed), '외부 미러', '건')));
  const totalCard = el('div', { class: 'card' },
    el('h2', { text: '전체' }),
    el('div', { class: 'stat-row' }, stat(fmtNum(entries.length), '활성 지식', '건')));
  view.replaceChildren(head, knowledgeSubBar('stats'), totalCard, injCard, provCard);
  applyReveal([totalCard, injCard, provCard]);
}

// 검토 뷰 — 외부 미러(provenance=observed) 또는 AI 산출(confidence=ai) 지식을 사후 검토. 반려(lifecycle=rejected).
async function renderKnowledgeReview(view) {
  view.replaceChildren(knowledgeSubBar('review'), skeleton('검토 대상을 불러오는 중'));
  const head = el('div', { class: 'page-head' },
    el('h1', {}, '지식 ', el('span', { class: 'accent', text: '검토' })),
    el('p', { class: 'sub', text: 'AI 가 생성했거나(출처=AI) 외부에서 미러된(출처=외부 미러) 지식을 사후 검토합니다. 보고 내려둘지(반려) 결정하세요.' }),
  );
  const listBox = el('div', { class: 'list-box' });
  view.replaceChildren(head, knowledgeSubBar('review'), listBox);

  async function load() {
    listBox.replaceChildren(skeletonRows(4));
    let entries;
    try {
      entries = await api('/api/ui/knowledge?' + new URLSearchParams({ lifecycle: 'active', limit: '500', orderBy: 'updated_at' })).then((d) => (d && d.entries) || []);
    } catch (e) {
      listBox.replaceChildren(errorNote(e, '검토 목록을 불러오지 못했습니다'));
      return;
    }
    // 검토 대상 = 외부 미러(observed) 또는 AI 산출(confidence=ai). 사람 저작은 무게이트 신뢰.
    const targets = entries.filter((e) => e.provenance === 'observed' || e.confidence === 'ai');
    if (!targets.length) {
      listBox.replaceChildren(el('div', { class: 'empty', text: '검토 대기 중인 지식이 없습니다. 모두 확인되었습니다.' }));
      return;
    }
    listBox.replaceChildren();
    for (const e of targets) {
      const row = el('div', { class: 'review-row' },
        el('div', { class: 'review-main' },
          el('a', { class: 'review-title', href: '#/k/' + encodeURIComponent(e.name), text: e.title || e.name }),
          el('div', { class: 'row-meta' }, knInjectChip(e.injection), ' ', knProvChip(e.provenance),
            e.confidence === 'ai' ? el('span', {}, '  ', confidenceDot(e.confidence)) : null,
            '  ', relTime(e.updated_at))),
        el('div', { class: 'review-acts' },
          el('a', { class: 'btn btn-ghost btn-sm', href: '#/k/' + encodeURIComponent(e.name), text: '보기' }),
          el('button', { class: 'btn btn-ghost btn-sm btn-danger', text: '삭제', onclick: async (ev) => {
            ev.preventDefault();
            if (!confirm("'" + (e.title || e.name) + "' 지식을 삭제할까요? 휴지통(#/trash)에서 복원할 수 있습니다.")) return;
            try {
              await api('/api/ui/knowledge/' + encodeURIComponent(e.name) + '/delete', { method: 'POST' });
              row.classList.add('flash');
              setTimeout(() => { row.remove(); if (!listBox.querySelector('.review-row')) listBox.replaceChildren(el('div', { class: 'empty', text: '검토 대기 중인 지식이 없습니다.' })); }, reducedMotion() ? 0 : 350);
              toast('삭제했습니다 — 휴지통에서 복원 가능');
            } catch (err) { toast('삭제 실패 — ' + err.message, true); }
          } })),
      );
      listBox.append(row);
    }
  }
  load();
}

// 지식 상세 #/k/<name> — 전문(body_md, 마크다운) + 메타(injection/provenance/lifecycle/source) + 연결 카테고리.
async function renderKnowledgeDetail(view, name) {
  view.replaceChildren(skeleton('지식을 불러오는 중'));
  let k;
  try {
    k = await api('/api/ui/knowledge/' + encodeURIComponent(name)).then((d) => (d && d.knowledge) || d);
  } catch (e) {
    if (e.status === 404) {
      view.replaceChildren(el('div', { class: 'page-head' }, el('h1', { text: '없는 지식' })),
        el('div', { class: 'note', text: "'" + name + "' 을(를) 찾을 수 없습니다." }),
        el('a', { class: 'btn btn-ghost btn-sm', href: '#/knowledge', text: '← 지식으로' }));
      return;
    }
    view.replaceChildren(errorNote(e, '지식을 불러오지 못했습니다'));
    return;
  }
  if (!k) { view.replaceChildren(el('div', { class: 'note', text: '지식을 찾을 수 없습니다.' })); return; }

  const backRow = el('div', { class: 'crumbs' },
    el('a', { class: 'crumb-link', href: '#/knowledge', text: '지식' }),
    el('span', { class: 'crumb-sep', text: ' / ' }),
    el('span', { class: 'mono', text: k.name }));

  // 본문(전문) — body_md 안전 마크다운 렌더(renderMarkdown: createElement+textContent, HTML 주입 불가) + 원문 토글.
  const rawText = k.body_md || '';
  const rendered = rawText
    ? el('div', { class: 'unit-body md-rendered' }, renderMarkdown(rawText))
    : el('div', { class: 'body-text unit-body', text: '(본문 없음)' });
  const rawView = el('pre', { class: 'body-text unit-body unit-body-raw', text: rawText });
  rawView.hidden = true;
  let showingRaw = false;
  const rawToggle = rawText
    ? el('button', { class: 'btn btn-ghost btn-sm md-raw-toggle', text: '원문 보기',
        onclick: () => { showingRaw = !showingRaw; rendered.hidden = showingRaw; rawView.hidden = !showingRaw;
          rawToggle.textContent = showingRaw ? '서식 보기' : '원문 보기'; } })
    : null;

  // 메타 — injection/provenance/lifecycle/source + 출처(provenance 라벨)/버전/갱신.
  const metaRows = [
    ['주입(injection)', (KN_INJECTION_LABEL[k.injection] || k.injection || '—') + (k.injection ? ' · ' + (KN_INJECTION_HINT[k.injection] || '') : '')],
    ['출처(provenance)', (KN_PROVENANCE_LABEL[k.provenance] || k.provenance || '—') + (k.provenance ? ' · ' + (KN_PROVENANCE_HINT[k.provenance] || '') : '')],
    ['상태(lifecycle)', LIFECYCLE_LABEL[k.lifecycle] || k.lifecycle || '—'],
    ['출처 채널(source)', k.source || '—'],
    ['신뢰(confidence)', CONFIDENCE_LABEL[k.confidence] || k.confidence || '—'],
    k.supersedes ? ['supersedes', k.supersedes] : null,
    k.source_ref ? ['출처(source_ref)', k.source_ref] : null,
    k.external_url ? ['외부 링크', k.external_url] : null,
    ['버전', 'v' + (k.version != null ? k.version : '—')],
    ['마지막 갱신', (k.updated_at ? absTime(k.updated_at) : '—') + (k.updated_by ? ' · ' + k.updated_by : '')],
  ].filter(Boolean);
  const metaBar = el('div', { class: 'unit-metabar' });
  for (const [kk, vv] of metaRows) metaBar.append(el('div', { class: 'umeta' }, el('span', { class: 'umeta-k', text: kk }), el('span', { class: 'umeta-v', text: vv })));

  // 연결 카테고리(n:n) — rejected 매핑 제외. space·이름 칩으로.
  const cats = (Array.isArray(k.categories) ? k.categories : []).filter((c) => c.state !== 'rejected');
  const catSection = cats.length
    ? el('div', { class: 'kn-cat-list' }, ...cats.map((c) => el('span', { class: 'kn-chip kn-cat-chip',
        title: (SPACE_LABEL[c.space] || c.space || '') + ' · ' + (c.key || ''), text: c.name || c.key })))
    : el('div', { class: 'kn-cat-empty', text: '연결된 카테고리가 없습니다.' });

  // 상태 액션 — 삭제(휴지통)만, 우측 정렬. 반려(가역 숨김)는 폐기 — 제거는 삭제로 통일(감사 스냅샷으로 #/trash 에서 복원).
  //  사람 전용(서버가 403 재검증).
  const actions = el('div', { class: 'unit-actions unit-actions-end' });
  actions.append(el('button', { class: 'btn btn-ghost btn-sm btn-danger', text: '삭제',
    onclick: () => knDelete(k.name, view) }));

  const metaWrap = el('details', { class: 'unit-meta-details', open: '' },
    el('summary', { class: 'unit-meta-summary' }, '메타데이터'), metaBar);

  const main = el('div', { class: 'detail-card unit-card' },
    el('div', { class: 'unit-title-row' },
      el('h1', { class: 'detail-title', text: k.title || k.name }),
      lifecycleDot(k.lifecycle)),
    el('div', { class: 'detail-meta' }, el('span', { class: 'mono', text: k.name }),
      knInjectChip(k.injection), knProvChip(k.provenance)),
    actions.childNodes.length ? actions : null,
    metaWrap,
    el('div', { class: 'sec-label', text: '카테고리' }), catSection,
    el('div', { class: 'sec-label sec-label-row' }, el('span', { text: '본문' }), rawToggle),
    el('div', { class: 'unit-body-wrap' }, rendered, rawView),
  );
  view.replaceChildren(el('div', { class: 'page-head unit-head' }, backRow), main);
  applyReveal([main]);
}

async function knChangeLifecycle(name, lifecycle, view) {
  try {
    await api('/api/ui/knowledge/' + encodeURIComponent(name) + '/lifecycle', { method: 'POST', body: JSON.stringify({ lifecycle }) });
    toast(lifecycle === 'rejected' ? '반려했습니다' : (lifecycle === 'active' ? '복원했습니다' : '상태를 바꿨습니다'));
    renderKnowledgeDetail(view, name);
  } catch (e) {
    toast('상태 변경 실패 — ' + e.message, true);
  }
}

// 지식 삭제(휴지통) — 활성 목록·검색·주입에서 제거하되 감사 스냅샷으로 보존(#/trash 에서 복원). 연결은 cascade 정리.
async function knDelete(name, view) {
  if (!confirm("'" + name + "' 지식을 삭제할까요?\n\n활성 목록·검색·주입에서 사라집니다. 연결된 카테고리·프로젝트·활동 링크는 함께 정리됩니다.\n휴지통(#/trash)에서 본체를 복원할 수 있습니다.")) return;
  try {
    await api('/api/ui/knowledge/' + encodeURIComponent(name) + '/delete', { method: 'POST' });
    toast('삭제했습니다 — 휴지통에서 복원할 수 있습니다');
    location.hash = '#/knowledge';
  } catch (e) {
    toast('삭제 실패 — ' + e.message, true);
  }
}

// ════════════════════════════════════════════
// 휴지통 #/trash — 삭제된 지식·프로젝트·카테고리를 한곳에서 보고 복원(공통 경로). 감사로그(deleted_list) 기반.
//  복원은 본체만 — 삭제 시 cascade 된 연결(카테고리/프로젝트/활동 링크)은 돌아오지 않는다. 사람 전용(서버 403 재검증).
// ════════════════════════════════════════════
const TRASH_ENTITY_LABEL = { knowledge: '지식', project: '프로젝트', category: '카테고리' };

async function renderTrash(view) {
  view.replaceChildren(skeleton('삭제된 항목을 불러오는 중'));
  let entries = [];
  try {
    entries = await api('/api/ui/deleted').then((d) => (d && d.entries) || []);
  } catch (e) {
    view.replaceChildren(errorNote(e, '휴지통을 불러오지 못했습니다'));
    return;
  }
  const head = el('div', { class: 'page-head' },
    el('h1', {}, '휴지', el('span', { class: 'accent', text: '통' })),
    el('p', { class: 'sub', text: '삭제된 지식·프로젝트·카테고리입니다. 감사 스냅샷으로 보존되어 복원할 수 있습니다(본체만 — 삭제 시 정리된 연결은 복원되지 않습니다).' }),
  );
  const list = el('div', { class: 'list' });
  if (!entries.length) {
    list.append(el('div', { class: 'note', text: '삭제된 항목이 없습니다.' }));
  } else {
    for (const e of entries) list.append(trashRow(e, view));
  }
  view.replaceChildren(head, list);
  applyReveal([list]);
}

function trashRow(e, view) {
  const restoreBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '복원',
    onclick: async () => {
      restoreBtn.disabled = true;
      try {
        await api('/api/ui/deleted/restore', { method: 'POST', body: JSON.stringify({ entity: e.entity, key: e.key }) });
        toast('복원했습니다');
        renderTrash(view);
      } catch (err) {
        restoreBtn.disabled = false;
        toast('복원 실패 — ' + err.message, true);
      }
    } });
  const who = (e.actor ? '  · ' + e.actor : '') + (e.actor_kind ? ' (' + (e.actor_kind === 'ai' ? 'AI' : '사람') + ')' : '');
  const left = el('div', {},
    el('div', { class: 'row-title' },
      el('span', { class: 'kn-chip', text: TRASH_ENTITY_LABEL[e.entity] || e.entity }), '  ',
      el('span', { text: e.label || e.key })),
    el('div', { class: 'row-meta' }, el('span', { class: 'mono', text: e.key }), '  삭제: ', relTime(e.at), who),
  );
  return el('div', { class: 'row', style: 'display:flex; align-items:center; justify-content:space-between; gap:12px;' }, left, restoreBtn);
}

// ════════════════════════════════════════════
// 프로젝트(v2) #/projects2 — 맥락 = 카테고리 + 지식 + 프로젝트 중 '프로젝트'(= 맥락의 *변화*).
//  지식 탭과 대칭인 하위 탭: [대시보드 · 작업 현황 · 사업 · 제품 · 시스템].
//   · 대시보드 = 프로젝트 보드(level='project' 카드, 진행중/완료)
//   · 작업 현황 = 기존 #/dash(사람×AI 작업현황)를 하위 탭으로 흡수(renderDashboard 재사용)
//   · 사업·제품·시스템 = 카테고리(space)로 프로젝트를 훑는 2분할(지식 탭의 renderKnowledgeSpace 패턴 재사용)
//  데이터: GET /api/ui/v6/projects(보드·space목록)·/:id(상세) + POST .../status,/tasks,/members,/category,/knowledge,
//   POST /api/ui/v6/tasks/:id/status, GET /api/ui/categories(사이드바). (백엔드 projects-v6 — 이미 구현됨.)
// ════════════════════════════════════════════
const PJV_STATUS_LABEL = { active: '진행 중', done: '완료' };

// 프로젝트 하위 탭 바 — spaceSubBar(#/projects2)로 사업·제품·시스템 칩을 만들고, 앞에 대시보드·작업 현황을 끼운다.
//  지식 탭의 knowledgeSubBar 와 같은 짜임(.sub-cats/.sub-cat). active ∈ {dashboard,activity,business,product,system}.
function projectSubBar(active) {
  const bar = spaceSubBar('#/projects2', SPACE_LABEL[active] ? active : '');
  // 앞쪽에 대시보드·작업 현황 칩을 끼워 넣는다(space 칩보다 먼저).
  const lead = [['dashboard', '대시보드', '#/projects2/dashboard'], ['activity', '작업 현황', '#/projects2/activity']];
  const refNode = bar.firstChild;
  for (const [key, label, href] of lead) {
    const on = key === active;
    bar.insertBefore(el('a', { class: 'sub-cat' + (on ? ' active' : ''), href,
      role: 'tab', 'aria-selected': on ? 'true' : 'false', text: label }), refNode);
  }
  return bar;
}

// 프로젝트(v2) 진입 — sub ∈ {dashboard, activity, business, product, system}.
async function renderProjectsV2(view, sub, params) {
  if (sub === 'activity') {
    // 작업 현황 — 기존 대시보드를 그대로 재사용. 하위 호스트에 렌더(renderDashboard 가 호스트 children 을 교체).
    const host = el('div', {});
    view.replaceChildren(projectSubBar('activity'), host);
    return renderDashboard(host, params);
  }
  if (SPACE_LABEL[sub]) return renderProjectV2Space(view, sub, params);
  return renderProjectV2Board(view);
}

// 대시보드 — 프로젝트 보드(level='project'). 진행 중/완료 두 섹션 + [+ 새 프로젝트] + [선택→일괄삭제].
//  선택 모드: 내가 만든(created_by==나) 프로젝트만 체크 가능 — 진행 중·완료에 걸쳐 여러 개를 골라 한 번에 삭제.
async function renderProjectV2Board(view) {
  view.replaceChildren(projectSubBar('dashboard'), skeleton('프로젝트를 불러오는 중'));
  const head = el('div', { class: 'page-head' },
    el('h1', {}, '프로', el('span', { class: 'accent', text: '젝트' })),
  );

  let projects;
  try {
    projects = await api('/api/ui/v6/projects?mine=1').then((d) => (d && d.projects) || []);
  } catch (e) {
    view.replaceChildren(head, projectSubBar('dashboard'), errorNote(e, '프로젝트를 불러오지 못했습니다'));
    return;
  }

  const reload = () => renderProjectV2Board(view);
  const meId = (state.me && (state.me.userId || state.me.email)) || '';
  // 삭제 가능 = 내가 만든 것(서버 actor=userId||email 파생과 동일 규칙). 서버도 403 으로 재검증.
  const canDelete = (p) => !!meId && p.created_by != null && String(p.created_by) === String(meId);
  const deletable = projects.filter(canDelete);
  const active = projects.filter((p) => p.status !== 'done');
  const done = projects.filter((p) => p.status === 'done');
  const OPTS_BASE = { statusBase: '/api/ui/v6/projects/', detailBase: '#/projects2/p/' };

  // 선택(일괄삭제) 상태 — 리페치 없이 로컬 재페인트. ids = 선택된 프로젝트 id 집합.
  const sel = { mode: false, ids: new Set() };
  const headActions = el('div', { class: 'card-head-actions' });
  const bulkBar = el('div', { class: 'bulk-bar', hidden: true });
  const sectionsBox = el('div', {});

  function repaintBulk() {
    if (!sel.mode) { bulkBar.hidden = true; bulkBar.replaceChildren(); return; }
    const n = sel.ids.size;
    const allOn = deletable.length > 0 && deletable.every((p) => sel.ids.has(p.id));
    const allBtn = el('button', { class: 'btn btn-ghost btn-sm', text: allOn ? '전체 해제' : '전체 선택',
      onclick: () => { if (allOn) sel.ids.clear(); else deletable.forEach((p) => sel.ids.add(p.id)); repaint(); } });
    const delBtn = el('button', { class: 'btn btn-sm btn-danger', text: '선택 삭제', disabled: n === 0,
      onclick: () => bulkDelete(delBtn) });
    bulkBar.hidden = false;
    bulkBar.replaceChildren(
      el('span', { class: 'bulk-bar-count', text: n ? n + '개 선택됨' : '삭제할 프로젝트를 고르세요' }),
      el('div', { class: 'bulk-bar-actions' }, allBtn, delBtn));
  }

  function repaint() {
    // 헤더 우측 — 선택모드 토글(삭제 가능한 프로젝트가 있을 때만) + 새 프로젝트.
    const newBtn = el('button', { class: 'btn btn-primary', text: '+ 새 프로젝트', onclick: () => openProjectV2Form(reload) });
    if (sel.mode) {
      const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => { sel.mode = false; sel.ids.clear(); repaint(); } });
      headActions.replaceChildren(cancelBtn, newBtn);
    } else {
      const selectBtn = deletable.length
        ? el('button', { class: 'btn btn-ghost', text: '선택', title: '여러 프로젝트를 골라 한 번에 삭제', onclick: () => { sel.mode = true; repaint(); } })
        : null;
      headActions.replaceChildren(selectBtn, newBtn);
    }
    const opts = Object.assign({}, OPTS_BASE,
      { select: sel.mode ? { ids: sel.ids, canSelect: canDelete, onToggle: repaintBulk } : null });
    sectionsBox.replaceChildren(
      projectSection('진행 중', active, '아직 진행 중인 프로젝트가 없습니다. ‘+ 새 프로젝트’로 시작하세요.', reload, false, opts),
      projectSection('완료', done, '완료한 프로젝트가 아직 없습니다.', reload, true, opts),
    );
    repaintBulk();
  }

  async function bulkDelete(btn) {
    const ids = [...sel.ids];
    if (!ids.length) return;
    if (!confirm(ids.length + '개 프로젝트를 삭제할까요?\n\n각 프로젝트와 그 작업(태스크·하위)이 함께 사라집니다(되돌릴 수 없음). 연결된 지식은 보존됩니다.')) return;
    btn.disabled = true;
    // 병렬 삭제 — 일부 실패해도 나머지는 진행(성공/실패 건수 보고). 서버가 비소유분은 403.
    const results = await Promise.allSettled(
      ids.map((pid) => api('/api/ui/v6/projects/' + pid + '/delete', { method: 'POST' })));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const fail = results.length - ok;
    toast(fail ? (ok + '개 삭제 · ' + fail + '개 실패') : (ok + '개 프로젝트를 삭제했습니다'), fail > 0);
    sel.mode = false; sel.ids.clear();
    reload();
  }

  view.replaceChildren(
    head,
    projectSubBar('dashboard'),
    el('div', { class: 'card-head', style: 'margin: 6px 0 14px' },
      el('div', {},
        el('span', { class: 'eyebrow', text: '내 프로젝트' }),
        el('p', { class: 'sub', style: 'margin: 5px 0 0', text: '내가 속한 프로젝트 — 진행 중과 완료.' })),
      headActions),
    bulkBar,
    sectionsBox,
    el('div', { class: 'card-head', style: 'margin: 24px 0 14px' },
      el('div', {},
        el('span', { class: 'eyebrow', text: '회사 전체' }),
        el('p', { class: 'sub', style: 'margin: 5px 0 0', text: '회사에서 지금 진행 중인 모든 작업.' }))),
    companyTimelineSection(),
  );
  repaint();
}

// 보드 한 섹션(진행 중 / 완료) — 카드 + 개수 배지 + 타일 그리드. renderProjects 의 projectSection 짜임 재사용.
function pjvBoardTile(p) {
  const isDone = p.status === 'done';
  const tile = el('div', { class: 'project-tile' + (isDone ? ' done' : ''),
    role: 'link', tabindex: '0', onclick: () => { location.hash = '#/projects2/p/' + p.id; } });
  tile.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') location.hash = '#/projects2/p/' + p.id; });
  tile.append(el('div', { class: 'project-tile-name', text: p.name }));
  if (p.description) tile.append(el('div', { class: 'project-tile-desc', text: p.description }));
  const mc = Number(p.member_count != null ? p.member_count : (p.members ? p.members.length : 0)) || 0;
  const when = isDone ? (p.completed_at || p.updated_at) : (p.updated_at || p.created_at);
  tile.append(el('div', { class: 'project-tile-foot' },
    el('span', { class: 'project-tile-meta', text: (isDone ? '완료 ' : '갱신 ') + (when ? relTime(when) : '') }),
    el('span', { class: 'pjv-tile-badge' },
      el('span', { class: 'pill-state' + (isDone ? '' : ' confirmed'), text: PJV_STATUS_LABEL[p.status] || p.status }),
      mc ? el('span', { class: 'pjv-tile-members', text: '👤 ' + mc }) : null)));
  return tile;
}

// space 뷰(사업·제품·시스템) — 좌(카테고리 사이드바)/우(프로젝트 목록) 2분할. renderKnowledgeSpace 와 같은 패턴.
async function renderProjectV2Space(view, space, params) {
  const f = (state.projects2 = state.projects2 || { space, category: '', status: '' });
  if (f.space !== space) { f.space = space; f.category = ''; }
  if (params && params.has('category')) f.category = params.get('category') || '';
  if (params && params.has('status')) f.status = params.get('status') || '';

  view.replaceChildren(projectSubBar(space), skeleton('프로젝트를 불러오는 중'));
  const head = el('div', { class: 'page-head' },
    el('h1', {}, '프로', el('span', { class: 'accent', text: '젝트' })),
    el('p', { class: 'sub', text: '맥락의 변화 — ' + SPACE_LABEL[space] + ' 영역의 프로젝트. 왼쪽에서 카테고리로 좁히고, 위에서 상태로 거릅니다.' }),
  );

  // 좌측 카테고리 사이드바(이 space 의 카테고리 + '전체'). 지식 탭의 knSideItem 재사용.
  const side = el('aside', { class: 'browse-side' });
  let cats = [];
  try {
    cats = await api('/api/ui/categories?' + new URLSearchParams({ space })).then((d) => (d && d.categories) || []);
  } catch (_) { /* graceful: 사이드바 생략(목록은 계속) */ }
  function buildSide() {
    const nav = el('nav', { class: 'browse-tree', 'aria-label': '카테고리' });
    nav.append(knSideItem('전체', '', f.category === ''));
    for (const c of cats) nav.append(knSideItem(c.name || c.key, String(c.id), String(f.category) === String(c.id)));
    side.replaceChildren(el('div', { class: 'eyebrow', text: '카테고리' }), nav);
  }
  buildSide();

  // 상단 필터 — 상태 select(전체/진행 중/완료).
  const statusSel = selectFilter([['', '전체 상태'], ['active', '진행 중'], ['done', '완료']], f.status);
  statusSel.setAttribute('aria-label', '상태');
  const listBox = el('div', { class: 'list-box browse-list' });
  const foot = el('div', { class: 'list-foot' });

  function syncHash() {
    const p = new URLSearchParams();
    if (f.category) p.set('category', f.category);
    if (f.status) p.set('status', f.status);
    const qs = p.toString();
    history.replaceState(null, '', '#/projects2/' + space + (qs ? '?' + qs : ''));
  }
  async function refetch() {
    listBox.replaceChildren(skeletonRows(4));
    foot.replaceChildren();
    try {
      const p = new URLSearchParams({ space });
      if (f.category) p.set('category', f.category);
      if (f.status) p.set('status', f.status);
      const projects = await api('/api/ui/v6/projects?' + p.toString()).then((d) => (d && d.projects) || []);
      if (!projects.length) {
        listBox.replaceChildren(el('div', { class: 'empty', text: '조건에 맞는 프로젝트가 없습니다. 필터를 넓혀 보세요.' }));
      } else {
        listBox.replaceChildren(...projects.map(pjvProjectRow));
      }
      foot.replaceChildren(el('span', { class: 'caption', text: projects.length + '건' }));
    } catch (e) {
      listBox.replaceChildren(errorNote(e, '프로젝트를 불러오지 못했습니다'));
    }
  }

  statusSel.addEventListener('change', () => { f.status = statusSel.value; syncHash(); refetch(); });
  side.addEventListener('click', (ev) => {
    const item = ev.target.closest('[data-cat-val]');
    if (!item) return;
    ev.preventDefault();
    f.category = item.dataset.catVal || '';
    buildSide(); syncHash(); refetch();
  });

  const filterBar = el('div', { class: 'filter-bar browse-filter' }, statusSel);
  const layout = el('div', { class: 'browse-layout' },
    side,
    el('section', { class: 'browse-main' }, filterBar, listBox, foot),
  );
  view.replaceChildren(head, projectSubBar(space), layout);
  applyReveal([layout]);
  refetch();
}

// 프로젝트 한 행(목록) — 이름(상세 링크) + 상태 칩 + 갱신시각. 지식 탭 knRow 와 같은 .row 짜임.
function pjvProjectRow(p) {
  const isDone = p.status === 'done';
  const when = isDone ? (p.completed_at || p.updated_at) : (p.updated_at || p.created_at);
  const row = el('div', { class: 'row', role: 'link', tabindex: '0' },
    el('div', { class: 'row-title', text: p.name }),
    el('div', { class: 'row-meta' },
      el('span', { class: 'pill-state' + (isDone ? '' : ' confirmed'), text: PJV_STATUS_LABEL[p.status] || p.status }),
      '  ', relTime(when)),
  );
  const go = () => { location.hash = '#/projects2/p/' + p.id; };
  row.addEventListener('click', go);
  row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
  return row;
}

// 새 프로젝트(v2) 폼 — 이름(필수)·설명(선택)·팀원. 생성 후 상세로 이동. memberPicker 재사용.
function openProjectV2Form(reload) {
  const nameIn = el('input', { type: 'text', placeholder: '프로젝트 이름 (예: 6월 데모데이 준비)', maxlength: '200' });
  const descIn = el('textarea', { rows: '3', placeholder: '간단한 설명 (선택)', maxlength: '5000' });
  const picker = memberPicker([], { includeMe: true });
  const saveBtn = el('button', { class: 'btn btn-primary', text: '만들기' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  const back = overlayBox('새 프로젝트',
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '설명 (선택)' }), descIn),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '함께하는 팀원' }), picker.box),
    el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
  setTimeout(() => nameIn.focus(), 0);
  const go = async () => {
    const name = nameIn.value.trim();
    if (!name) { nameIn.focus(); toast('이름을 입력하세요', true); return; }
    saveBtn.disabled = true;
    try {
      const r = await api('/api/ui/v6/projects', { method: 'POST', body: JSON.stringify({
        name, description: descIn.value.trim() || undefined, members: picker.getSelected(),
      }) });
      back.remove();
      toast('프로젝트를 만들었습니다');
      const np = r && (r.project || r);
      if (np && np.id) location.hash = '#/projects2/p/' + np.id;
      else if (reload) reload();
    } catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
  saveBtn.onclick = go;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

// 프로젝트 상세(v2) #/projects2/p/:id — 헤더(이름·상태 토글·팀원) + 태스크▸하위 트리 + 필요/산출 지식.
//  renderProjectDetail 의 헤더 결을 따르되, 본문은 태스크 계층 + 지식 두 섹션(GET /api/ui/v6/projects/:id).
async function renderProjectV2Detail(view, idStr) {
  const id = Number(idStr);
  const V6_BASE = '/api/ui/v6/projects/'; // 파일/세션/타임라인/팀원 섹션이 v6 라우트로 연결되도록 base 주입
  const backLink = el('a', { class: 'btn btn-ghost btn-sm', href: '#/projects2', text: '← 프로젝트' });
  view.replaceChildren(skeleton('프로젝트를 불러오는 중'));
  let data;
  try { data = await api('/api/ui/v6/projects/' + id).then((d) => d && (d.project || d)); }
  catch (e) {
    view.replaceChildren(el('div', { class: 'page-head' }, backLink), errorNote(e, '프로젝트를 불러오지 못했습니다'));
    return;
  }
  if (!data) { view.replaceChildren(el('div', { class: 'page-head' }, backLink), el('div', { class: 'note', text: '프로젝트를 찾을 수 없습니다.' })); return; }
  const p = data;
  const members = p.members || [];
  const isDone = p.status === 'done';
  const reload = () => renderProjectV2Detail(view, idStr);

  // 헤더 — 제목(이름+상태칩) 좌 / 액션(완료토글·삭제) 우 한 줄, 설명, 팀원 칩(아래 별도 행). 박스 높이·세로정렬 통일.
  const head = el('div', { class: 'page-head' },
    el('div', { class: 'proj-detail-back' }, backLink));
  // 상태 토글(완료/재개)은 '프로젝트 세부 설정' 팝업으로 이관 — 헤더엔 상태칩만 둔다.
  // 프로젝트 세부 설정 — 우측 액션 슬롯. 상태(완료된 프로젝트로/재개)·규칙(터미널 AI 주입)·연결된 지식 팝업.
  const meId = (state.me && (state.me.userId || state.me.email)) || '';
  // 삭제·팀원 수정은 '프로젝트 세부 설정' 팝업으로 이관 — 헤더 우측 액션은 설정 버튼만(권한 경계는 백엔드 403).
  const settingsBtn = el('button', { class: 'btn btn-sm btn-ghost', text: '⚙ 프로젝트 세부 설정',
    onclick: () => openProjectSettings(id, p, reload, meId, V6_BASE) });
  // 제목줄 — 이름+상태칩(좌), 세부설정(우).
  head.append(el('div', { class: 'proj-detail-titlebar' },
    el('div', { class: 'proj-detail-titlebox' },
      el('h1', { class: 'proj-detail-title' }, p.name),
      el('span', { class: 'pill-state' + (isDone ? '' : ' confirmed'), text: PJV_STATUS_LABEL[p.status] || p.status })),
    el('div', { class: 'proj-detail-actions' }, settingsBtn)));
  if (p.description) head.append(el('p', { class: 'sub proj-detail-desc', text: p.description }));
  // 팀원 — 칩 행(액션과 분리) + 팀원 수정 버튼. 없으면 흐린 안내.
  const teamRow = el('div', { class: 'proj-team-row' });
  if (members.length) {
    for (const m of members) teamRow.append(el('span', { class: 'proj-team-chip' },
      el('span', { class: 'proj-team-ava', style: 'background:' + avatarColor(m.member_id), text: initials(m.display_name || m.member_id) }),
      el('span', { text: m.display_name || (m.member_id + (m.role ? ' · ' + m.role : '')) })));
  } else {
    teamRow.append(el('span', { class: 'admin-hint', text: '아직 팀원이 없어요' }));
  }
  head.append(teamRow);

  // 상세 본문 — 태스크(작업 위계)를 헤더 바로 아래 맨 위에 둔다(프로젝트의 핵심). 이어 공유 폴더 ·
  //  터미널 세션 · 작업 타임라인(org #/projects 템플릿과 동형, v6 데이터·라우트). 모든 섹션 v6 API base 연결.
  //  '연결된 지식'은 헤더의 '프로젝트 세부 설정' 팝업으로 이동(규칙과 함께). 페이지 본문에선 제외.
  view.replaceChildren(head,
    pjvTasksSection(id, p.tasks || [], members, reload),
    projectFolderSection(id, V6_BASE),
    projectTerminalSection(id, members, meId, V6_BASE),
    projectTimelineSection(id, members, V6_BASE));
  applyReveal(Array.from(view.children).slice(1));
}

// ── 프로젝트 세부 설정 팝업 — 상태 · 팀원 · 터미널 규칙 · 연결 지식 · 삭제. 헤더 '⚙ 프로젝트 세부 설정'에서 연다. ──
//  (삭제·팀원 수정을 헤더에서 여기로 이관 — 헤더는 제목/상태칩/설정 버튼만.)
function openProjectSettings(id, p, reload, meId, base) {
  const B = base || '/api/ui/v6/projects/';
  const back = overlayBox('프로젝트 세부 설정', el('div', { class: 'proj-settings' }));
  const box = back.querySelector('.ov-box'); if (box) box.classList.add('ov-box-wide');
  const closeAndReload = () => { back.remove(); reload(); };  // 변경하면 팝업 닫고 상세 재렌더
  back.querySelector('.proj-settings').append(
    projectStatusBlock(id, p, closeAndReload),
    projectMembersBlock(id, p, closeAndReload, B),
    projectRulesBlock(id),
    projectRefsBlock(id, B),
    projectKnowledgeBlock(id, p.knowledge || { required: [], produced: [] }),
    projectDangerBlock(id, p, meId, back));
}

// 팀원 블록 — 현재 팀원 칩 + '팀원 수정'(멀티선택 오버레이). 저장 시 설정 팝업 닫고 상세 재렌더.
function projectMembersBlock(id, p, closeAndReload, base) {
  const members = p.members || [];
  const chips = el('div', { class: 'proj-team-row' });
  if (members.length) {
    for (const m of members) chips.append(el('span', { class: 'proj-team-chip' },
      el('span', { class: 'proj-team-ava', style: 'background:' + avatarColor(m.member_id), text: initials(m.display_name || m.member_id) }),
      el('span', { text: m.display_name || (m.member_id + (m.role ? ' · ' + m.role : '')) })));
  } else {
    chips.append(el('span', { class: 'admin-hint', text: '아직 팀원이 없어요' }));
  }
  return el('section', { class: 'ps-block' },
    el('h3', { class: 'ps-block-title', text: '팀원' }),
    el('p', { class: 'ps-block-hint', text: '이 프로젝트를 함께 보고 작업할 팀원이에요.' }),
    chips,
    el('div', { class: 'ps-rules-actions' },
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '팀원 수정',
        onclick: () => openMembersEdit(id, members.map((m) => m.member_id), closeAndReload, base) })));
}

// 삭제 블록 — 작성자 본인만 노출(서버도 403 재검증). 확인 후 삭제 → 팝업 닫고 목록으로.
function projectDangerBlock(id, p, meId, back) {
  const isMine = !!meId && p.created_by != null && String(p.created_by) === String(meId);
  if (!isMine) {
    return el('section', { class: 'ps-block' },
      el('h3', { class: 'ps-block-title', text: '프로젝트 삭제' }),
      el('p', { class: 'ps-block-hint', text: '프로젝트는 작성자만 삭제할 수 있어요.' }));
  }
  const delBtn = el('button', { class: 'btn btn-sm btn-danger', type: 'button', text: '프로젝트 삭제' });
  delBtn.onclick = async () => {
    if (!confirm('프로젝트 ‘' + p.name + '’을(를) 삭제할까요?\n\n프로젝트와 그 작업(태스크·하위)이 함께 사라집니다(되돌릴 수 없음). 연결된 지식은 보존됩니다.')) return;
    delBtn.disabled = true;
    try {
      await api('/api/ui/v6/projects/' + id + '/delete', { method: 'POST' });
      toast('프로젝트를 삭제했습니다');
      back.remove();
      location.hash = '#/projects2';
    } catch (e) { toast('실패 — ' + e.message, true); delBtn.disabled = false; }
  };
  return el('section', { class: 'ps-block' },
    el('h3', { class: 'ps-block-title', text: '프로젝트 삭제' }),
    el('p', { class: 'ps-block-hint', text: '프로젝트와 그 안의 모든 태스크가 영구 삭제됩니다(되돌릴 수 없음). 연결된 지식은 보존돼요.' }),
    el('div', { class: 'ps-rules-actions' }, delBtn));
}

// 상태 블록 — 진행 중 ↔ 완료 토글. (구 헤더 '완료로 표시' 버튼을 여기로 이관, 라벨 '완료된 프로젝트로'.)
function projectStatusBlock(id, p, afterStatus) {
  const isDone = p.status === 'done';
  const btn = el('button', { class: 'btn btn-sm btn-ghost', text: isDone ? '진행 중으로' : '완료된 프로젝트로' });
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await api('/api/ui/v6/projects/' + id + '/status', { method: 'POST', body: JSON.stringify({ status: isDone ? 'active' : 'done' }) });
      toast(isDone ? '진행 중으로 옮겼습니다' : '완료된 프로젝트로 옮겼습니다');
      afterStatus();
    } catch (e) { toast('실패 — ' + e.message, true); btn.disabled = false; }
  };
  return el('section', { class: 'ps-block' },
    el('h3', { class: 'ps-block-title', text: '프로젝트 상태' }),
    el('p', { class: 'ps-block-hint', text: isDone ? '지금 완료된 프로젝트입니다. 다시 진행 중으로 되돌릴 수 있어요.' : '지금 진행 중입니다. 끝났으면 완료된 프로젝트로 옮기세요.' }),
    btn);
}

// 규칙 블록 — 프로젝트 폴더의 CLAUDE.md 를 읽어 편집·저장. 이 프로젝트 터미널 세션의 Claude 가 그 파일을 자동 로드(강제주입).
function projectRulesBlock(id) {
  const url = '/api/ui/v6/projects/' + id + '/file?path=' + encodeURIComponent('CLAUDE.md');
  const ta = el('textarea', { class: 'ps-rules-ta', rows: '8', disabled: '',
    placeholder: '이 프로젝트에서 AI가 지켰으면 하는 걸 편하게 적으세요. 예)\n· 새로 만들기 전에 비슷한 게 이미 있는지 먼저 찾아본다.\n· 큰 변경이나 삭제는 진행하기 전에 꼭 먼저 물어본다.\n· 자료를 만들 땐 근거와 출처를 같이 적는다.\n· 안 되는 건 안 된다고 솔직히 말한다.' });
  const status = el('span', { class: 'ps-save-status admin-hint', text: '불러오는 중…' });
  const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: '규칙 저장', disabled: '' });
  (async () => {
    const token = localStorage.getItem(TOKEN_KEY);
    try { const res = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} }); ta.value = splitClaudeMd(res.ok ? await res.text() : '').manual; }
    catch (_) { ta.value = ''; }
    ta.disabled = false; saveBtn.disabled = false; status.textContent = '';
  })();
  saveBtn.onclick = async () => {
    saveBtn.disabled = true; status.textContent = '저장 중…';
    try {
      // 참고 파일 자동 블록(LIVELY:REFS)은 보존 — 현재 CLAUDE.md 를 다시 읽어 관리 블록만 떼어 재결합한다.
      const token = localStorage.getItem(TOKEN_KEY);
      let cur = '';
      try { const r = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} }); cur = r.ok ? await r.text() : ''; } catch (_) { /* */ }
      await authUpload(url, new Blob([joinClaudeMd(ta.value, splitClaudeMd(cur).managed)]));
      status.textContent = '저장됨 · 다음 세션부터 적용'; toast('프로젝트 규칙을 저장했습니다');
    }
    catch (e) { status.textContent = ''; toast('저장 실패 — ' + e.message, true); }
    saveBtn.disabled = false;
  };
  return el('section', { class: 'ps-block' },
    el('h3', { class: 'ps-block-title', text: '프로젝트 규칙' }),
    el('p', { class: 'ps-block-hint', text: '이 프로젝트에서 터미널 세션을 열면, 여기 적은 규칙이 그 AI(Claude)에게 자동으로 주입됩니다. (프로젝트 폴더의 CLAUDE.md 로 저장)' }),
    ta,
    el('div', { class: 'ps-rules-actions' }, saveBtn, status));
}

// ── 참고 파일(CLAUDE.md 자동 등록) — 수동 규칙과 한 파일에서 공존하되 영역을 분리(마커로 구분, 서로 보존). ──
const PS_REF_DIR = '참고자료';
const PS_REF_START = '<!-- LIVELY:REFS:START (자동 관리 — 직접 수정하지 마세요) -->';
const PS_REF_END = '<!-- LIVELY:REFS:END -->';
// CLAUDE.md 를 (사람이 쓴 수동 규칙) / (참고 파일 자동 블록)으로 분리.
function splitClaudeMd(text) {
  const t = String(text || '');
  const s = t.indexOf(PS_REF_START), e = t.indexOf(PS_REF_END);
  if (s >= 0 && e > s) {
    const manual = (t.slice(0, s) + t.slice(e + PS_REF_END.length)).replace(/\n{3,}/g, '\n\n').trim();
    return { manual, managed: t.slice(s, e + PS_REF_END.length) };
  }
  return { manual: t.trim(), managed: '' };
}
// 참고 파일 목록 → CLAUDE.md 관리 블록(없으면 빈 문자열).
function buildRefsBlock(files) {
  if (!files || !files.length) return '';
  const lines = files.map((f) => '- `' + PS_REF_DIR + '/' + f.name + '`').join('\n');
  return PS_REF_START + '\n## 📎 참고 파일 (필수)\n'
    + '작업을 시작하기 전에 아래 파일들을 **반드시 먼저 읽고** 그 내용을 따르세요. 작업 내내 이 자료를 기준으로 삼습니다.\n'
    + lines + '\n' + PS_REF_END;
}
// 수동 규칙 + 관리 블록 결합(규칙 먼저, 참고 블록 끝).
function joinClaudeMd(manual, managed) {
  const m = String(manual || '').trim();
  if (!managed) return m ? m + '\n' : '';
  return (m ? m + '\n\n' : '') + managed + '\n';
}

// 참고 파일 블록 — 프로젝트 폴더 참고자료/ 에 파일 업로드 → CLAUDE.md 관리 블록에 자동 등록되어,
//  이 프로젝트 터미널 세션 AI 가 매번 작업 전 반드시 읽도록 강제(수동 규칙과 공존, 영역 보존).
function projectRefsBlock(id, base) {
  const B = base || '/api/ui/v6/projects/';
  const claudeUrl = B + id + '/file?path=' + encodeURIComponent('CLAUDE.md');
  const listsUrl = B + id + '/files?path=' + encodeURIComponent(PS_REF_DIR);
  const refPath = (name) => B + id + '/file?path=' + encodeURIComponent(PS_REF_DIR + '/' + name);
  const listEl = el('div', { class: 'ps-refs-list' });
  const status = el('span', { class: 'ps-save-status admin-hint' });
  const fileInput = el('input', { type: 'file', multiple: true, style: 'display:none' });
  const uploadBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '＋ 파일 올리기', onclick: () => fileInput.click() });

  async function fetchFiles() {
    try { const d = await api(listsUrl); return ((d && d.items) || []).filter((x) => x.type === 'file'); }
    catch (_) { return []; } // 폴더 없음 = 아직 파일 없음
  }
  function paint(files) {
    if (!files.length) { listEl.replaceChildren(el('div', { class: 'pjv-kn-empty', text: '아직 참고 파일이 없어요. 올리면 매 터미널 세션에서 AI가 작업 전 반드시 읽습니다.' })); return; }
    listEl.replaceChildren(...files.map((f) => el('div', { class: 'ps-refs-row' },
      el('span', { class: 'ps-refs-ic' }, fileIconSvg(f.name, false)),
      el('span', { class: 'ps-refs-nm', text: f.name, title: f.name }),
      el('span', { class: 'ps-refs-sz', text: fmtSize(f.size) }),
      el('button', { class: 'proj-file-iconbtn danger', type: 'button', title: '삭제', text: '✕', onclick: () => removeRef(f.name) }))));
  }
  async function reload() { paint(await fetchFiles()); }
  // 참고자료/ 현재 목록을 CLAUDE.md 관리 블록으로 재생성(수동 규칙 보존).
  async function sync() {
    const files = await fetchFiles();
    const token = localStorage.getItem(TOKEN_KEY);
    let cur = '';
    try { const r = await fetch(claudeUrl, { headers: token ? { Authorization: 'Bearer ' + token } : {} }); cur = r.ok ? await r.text() : ''; } catch (_) { /* */ }
    await authUpload(claudeUrl, new Blob([joinClaudeMd(splitClaudeMd(cur).manual, buildRefsBlock(files))]));
  }
  fileInput.onchange = async () => {
    const files = Array.from(fileInput.files || []); fileInput.value = '';
    if (!files.length) return;
    status.textContent = '올리는 중…';
    try {
      for (const f of files) await authUpload(refPath(f.name), f);
      await sync();
      status.textContent = '올림 · 다음 세션부터 적용'; toast('참고 파일을 추가했습니다');
    } catch (e) { status.textContent = ''; toast('업로드 실패 — ' + e.message, true); }
    reload();
  };
  async function removeRef(name) {
    if (!confirm('참고 파일 ‘' + name + '’을(를) 삭제할까요?')) return;
    try { await api(refPath(name), { method: 'DELETE' }); await sync(); toast('삭제했습니다'); }
    catch (e) { toast('삭제 실패 — ' + e.message, true); }
    reload();
  }
  reload();
  return el('section', { class: 'ps-block' },
    el('h3', { class: 'ps-block-title', text: '참고 파일' }),
    el('p', { class: 'ps-block-hint', text: '여기 올린 파일은 이 프로젝트에서 터미널 세션을 열 때마다 AI가 작업 전 반드시 읽도록 강제됩니다. (프로젝트 폴더의 참고자료/ 에 저장 · CLAUDE.md 에 자동 등록)' }),
    listEl, fileInput,
    el('div', { class: 'ps-rules-actions' }, uploadBtn, status));
}

// 지식 블록 — 필요 지식(고르기/자동/해제 가능) + 산출 지식(표시). 변경 후 v6 상세 GET 으로 재조회해 재페인트.
function projectKnowledgeBlock(id, knowledge) {
  const knName = (k) => k.name || k.knowledge_name;
  let cur = { required: knowledge.required || [], produced: knowledge.produced || [] };
  const reqBox = el('div', { class: 'ps-kn-list' });
  const prodBox = el('div', { class: 'ps-kn-list' });

  function paintList(boxEl, list, emptyText, removable) {
    if (!list.length) { boxEl.replaceChildren(el('div', { class: 'pjv-kn-empty', text: emptyText })); return; }
    boxEl.replaceChildren(...list.map((k) => {
      const name = knName(k);
      const row = el('div', { class: 'row pjv-kn-row ps-kn-row' },
        el('a', { class: 'row-title', href: '#/k/' + encodeURIComponent(name), text: k.title || name }),
        el('div', { class: 'row-meta' },
          k.injection ? knInjectChip(k.injection) : null,
          k.provenance ? el('span', {}, ' ', knProvChip(k.provenance)) : null,
          k.lifecycle ? el('span', {}, '  ', lifecycleDot(k.lifecycle)) : null));
      if (removable) row.append(el('button', { class: 'proj-file-iconbtn danger', type: 'button', title: '연결 해제', text: '✕',
        onclick: async (ev) => { ev.preventDefault();
          try { await api('/api/ui/v6/projects/' + id + '/knowledge', { method: 'POST', body: JSON.stringify({ name, relation: 'required', unlink: true }) }); toast('연결을 해제했습니다'); refresh(); }
          catch (e) { toast('해제 실패 — ' + e.message, true); } } }));
      return row;
    }));
  }
  async function refresh() {
    try { const d = await api('/api/ui/v6/projects/' + id).then((r) => r && (r.project || r));
      cur = { required: (d.knowledge || {}).required || [], produced: (d.knowledge || {}).produced || [] }; } catch (_) { /* keep */ }
    paintList(reqBox, cur.required, '이 프로젝트가 참고할 지식을 골라 연결하세요.', true);
    paintList(prodBox, cur.produced, '이 프로젝트가 만들어 낸 지식이 아직 없습니다.', false);
  }
  const reqHead = el('div', { class: 'ps-kn-head' },
    el('div', { class: 'sec-label', text: '필요 지식' }),
    el('div', { class: 'ps-kn-acts' },
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '＋ 필요 지식 고르기',
        onclick: () => openKnowledgePicker(id, 'required', cur.required.map(knName), refresh) }),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '✨ 자동으로 고르기', title: '곧 제공됩니다',
        onclick: () => toast('자동 고르기는 곧 제공됩니다', false) })));
  paintList(reqBox, cur.required, '이 프로젝트가 참고할 지식을 골라 연결하세요.', true);
  paintList(prodBox, cur.produced, '이 프로젝트가 만들어 낸 지식이 아직 없습니다.', false);
  return el('section', { class: 'ps-block' },
    el('h3', { class: 'ps-block-title', text: '연결된 지식' }),
    el('div', { class: 'ps-kn-group' }, reqHead, reqBox),
    el('div', { class: 'ps-kn-group' }, el('div', { class: 'sec-label', text: '산출 지식' }), prodBox));
}

// 필요 지식 고르기 — ctx_grep 검색 → '연결'로 POST :id/knowledge. 이미 연결된 건 후보에서 제외.
function openKnowledgePicker(id, relation, linkedNames, onLinked) {
  const linked = new Set(linkedNames || []);
  const searchIn = el('input', { type: 'search', class: 'proj-file-search', placeholder: '지식 제목·내용으로 검색…' });
  const results = el('div', { class: 'ps-kn-pick-results' }, el('span', { class: 'admin-hint', text: '검색어를 입력하세요.' }));
  overlayBox('필요 지식 고르기', el('div', { class: 'ps-kn-pick' }, searchIn, results));
  setTimeout(() => searchIn.focus(), 0);
  const run = debounce(async () => {
    const q = searchIn.value.trim();
    if (!q) { results.replaceChildren(el('span', { class: 'admin-hint', text: '검색어를 입력하세요.' })); return; }
    results.replaceChildren(el('span', { class: 'admin-hint', text: '검색 중…' }));
    let matches;
    try { matches = await api('/api/ui/ctx/grep?query=' + encodeURIComponent(q) + '&limit=20').then((d) => (d && d.matches) || []); }
    catch (e) { results.replaceChildren(errorNote(e, '검색하지 못했습니다')); return; }
    const cand = matches.filter((m) => !linked.has(m.name));
    if (!cand.length) { results.replaceChildren(el('div', { class: 'pjv-kn-empty', text: '결과가 없거나 모두 이미 연결됨.' })); return; }
    results.replaceChildren(...cand.map((m) => {
      const addBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '＋ 연결' });
      addBtn.onclick = async () => {
        addBtn.disabled = true;
        try { await api('/api/ui/v6/projects/' + id + '/knowledge', { method: 'POST', body: JSON.stringify({ name: m.name, relation }) });
          linked.add(m.name); addBtn.textContent = '연결됨'; toast('연결했습니다'); if (onLinked) onLinked(); }
        catch (e) { addBtn.disabled = false; toast('연결 실패 — ' + e.message, true); }
      };
      return el('div', { class: 'ps-kn-pick-row' },
        el('div', { class: 'ps-kn-pick-main' },
          el('div', { class: 'row-title', text: m.title || m.name }),
          el('div', { class: 'admin-hint ps-kn-pick-snip', text: (m.snippet || '').slice(0, 90) })),
        addBtn);
    }));
  }, 300);
  searchIn.addEventListener('input', run);
}

// ════════════════════════════════════════════
// 태스크(클릭업형 리스트뷰) — 상태 그룹(할 일/진행 중/완료) + 컬럼(담당자·마감일·우선순위) + 인라인 편집.
//  상위 태스크만 상태로 그룹핑하고, 하위는 부모 아래 중첩(자기 상태는 점으로 표시하되 재그룹 안 함 — 클릭업 동형).
//  모든 필드 편집은 POST /api/ui/v6/tasks/:id(task_update_v6) 패치 — 변경 후 reload()로 재페인트(기존 토글과 동일).
// ════════════════════════════════════════════
const PJV_TASK_STATUS = {
  todo:        { label: '할 일',   bucket: 'todo',        glyph: '',  cls: 'todo' },
  in_progress: { label: '진행 중', bucket: 'in_progress', glyph: '◐', cls: 'inprog' },
  done:        { label: '완료',    bucket: 'done',        glyph: '✓', cls: 'done' },
};
const PJV_STATUS_ORDER = ['todo', 'in_progress', 'done'];
// 레거시 'active'(구 토글)·클릭업 미러 적재값을 'todo' 버킷으로 흡수. 그 외 미지정도 todo.
function pjvStatusMeta(s) {
  if (s === 'done') return PJV_TASK_STATUS.done;
  if (s === 'in_progress') return PJV_TASK_STATUS.in_progress;
  return PJV_TASK_STATUS.todo;
}
const PJV_PRIORITY = {
  urgent: { label: '긴급', cls: 'urgent' },
  high:   { label: '높음', cls: 'high' },
  normal: { label: '보통', cls: 'normal' },
  low:    { label: '낮음', cls: 'low' },
};
const PJV_PRIORITY_ORDER = ['urgent', 'high', 'normal', 'low'];

function pjvFmtDate(d) {
  if (!d) return '';
  const p = String(d).split('-');
  return p.length === 3 ? (Number(p[1]) + '/' + Number(p[2])) : String(d);
}
function pjvTodayStr() {
  const n = new Date(); const z = (x) => String(x).padStart(2, '0');
  return n.getFullYear() + '-' + z(n.getMonth() + 1) + '-' + z(n.getDate());
}
function pjvIsOverdue(t) { return t.due_date && t.status !== 'done' && t.due_date < pjvTodayStr(); }

// 인라인 편집용 경량 팝오버 — 앵커 아래 위치, 바깥클릭/ESC 로 닫힘. body 에 1개만(기존 것 제거). 닫기함수 반환.
function pjvPopover(anchor, content) {
  document.querySelectorAll('.pjv-pop').forEach((n) => n.remove());
  const pop = el('div', { class: 'pjv-pop' }, content);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  pop.style.top = (r.bottom + window.scrollY + 4) + 'px';
  const left = Math.min(r.left + window.scrollX, window.scrollX + vw - pop.offsetWidth - 10);
  pop.style.left = Math.max(8, left) + 'px';
  const close = () => {
    pop.remove();
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onDoc = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  setTimeout(() => {
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
  return close;
}

// 필드 패치 — task_update_v6 호출 후 전체 재페인트. 실패 시 토스트.
async function pjvPatchTask(taskId, patch, reload) {
  try {
    await api('/api/ui/v6/tasks/' + taskId, { method: 'POST', body: JSON.stringify(patch) });
    reload();
  } catch (e) { toast('수정 실패 — ' + e.message, true); }
}

// 상태 점(클릭→메뉴: 할 일/진행 중/완료).
function pjvStatusControl(t, reload) {
  const meta = pjvStatusMeta(t.status);
  const btn = el('button', { class: 'pjv-status-dot ' + meta.cls, type: 'button',
    title: '상태: ' + meta.label, 'aria-label': '상태 ' + meta.label },
    meta.glyph ? el('span', { class: 'pjv-status-glyph', text: meta.glyph }) : null);
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(btn, menu);
    for (const key of PJV_STATUS_ORDER) {
      const m = PJV_TASK_STATUS[key];
      const sel = meta.bucket === key;
      const item = el('button', { class: 'pjv-menu-item' + (sel ? ' sel' : ''), type: 'button' },
        el('span', { class: 'pjv-status-dot sm ' + m.cls }, m.glyph ? el('span', { class: 'pjv-status-glyph', text: m.glyph }) : null),
        el('span', { text: m.label }));
      item.onclick = () => { close(); if (!sel) pjvPatchTask(t.id, { status: key }, reload); };
      menu.append(item);
    }
  };
  return btn;
}

// 담당자(아바타/이니셜, 클릭→프로젝트 팀원 선택 + '담당 없음').
function pjvAssigneeControl(t, members, reload) {
  const cur = t.assignee ? (members.find((m) => m.member_id === t.assignee) || null) : null;
  const btn = el('button', { class: 'pjv-cell-btn' + (t.assignee ? '' : ' empty'), type: 'button', title: '담당자' });
  if (t.assignee) {
    const name = cur ? (cur.display_name || cur.member_id) : t.assignee;
    btn.append(el('span', { class: 'pjv-ava', style: 'background:' + avatarColor(t.assignee), text: initials(name) }));
  } else {
    btn.append(el('span', { class: 'pjv-cell-ph', text: '＋' }));
  }
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(btn, menu);
    const none = el('button', { class: 'pjv-menu-item' + (!t.assignee ? ' sel' : ''), type: 'button' },
      el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '담당 없음' }));
    none.onclick = () => { close(); if (t.assignee) pjvPatchTask(t.id, { assignee: null }, reload); };
    menu.append(none);
    for (const m of members) {
      const sel = t.assignee === m.member_id;
      const item = el('button', { class: 'pjv-menu-item' + (sel ? ' sel' : ''), type: 'button' },
        el('span', { class: 'pjv-ava', style: 'background:' + avatarColor(m.member_id), text: initials(m.display_name || m.member_id) }),
        el('span', { text: m.display_name || m.member_id }));
      item.onclick = () => { close(); if (!sel) pjvPatchTask(t.id, { assignee: m.member_id }, reload); };
      menu.append(item);
    }
    if (!members.length) menu.append(el('div', { class: 'pjv-menu-empty', text: '팀원을 먼저 추가하세요' }));
  };
  return btn;
}

// 마감일(YYYY-MM-DD, 표시는 m/d). 클릭→날짜입력 + 지우기.
function pjvDueControl(t, reload) {
  const overdue = pjvIsOverdue(t);
  const btn = el('button', { class: 'pjv-cell-btn' + (t.due_date ? '' : ' empty'), type: 'button', title: '마감일' });
  btn.append(t.due_date
    ? el('span', { class: 'pjv-due-text' + (overdue ? ' overdue' : ''), text: pjvFmtDate(t.due_date) })
    : el('span', { class: 'pjv-cell-ph', text: '＋' }));
  btn.onclick = (e) => {
    e.stopPropagation();
    const input = el('input', { type: 'date', class: 'pjv-date-input', value: t.due_date || '' });
    const wrap = el('div', { class: 'pjv-menu pjv-date-pop' }, input,
      t.due_date ? el('button', { class: 'pjv-menu-item danger', type: 'button', text: '마감일 지우기',
        onclick: () => { close(); pjvPatchTask(t.id, { due_date: null }, reload); } }) : null);
    const close = pjvPopover(btn, wrap);
    setTimeout(() => { input.focus(); if (input.showPicker) { try { input.showPicker(); } catch (_) { /* noop */ } } }, 0);
    input.onchange = () => { const v = input.value || null; close(); pjvPatchTask(t.id, { due_date: v }, reload); };
  };
  return btn;
}

// 우선순위(깃발, 색상). 클릭→긴급/높음/보통/낮음/없음.
function pjvPriorityControl(t, reload) {
  const m = t.priority ? PJV_PRIORITY[t.priority] : null;
  const btn = el('button', { class: 'pjv-cell-btn' + (m ? '' : ' empty'), type: 'button', title: '우선순위' });
  btn.append(m
    ? el('span', { class: 'pjv-flag ' + m.cls }, el('span', { class: 'pjv-flag-glyph', text: '⚑' }), el('span', { class: 'pjv-flag-label', text: m.label }))
    : el('span', { class: 'pjv-cell-ph', text: '⚑' }));
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(btn, menu);
    for (const key of PJV_PRIORITY_ORDER) {
      const pm = PJV_PRIORITY[key];
      const sel = t.priority === key;
      const item = el('button', { class: 'pjv-menu-item' + (sel ? ' sel' : ''), type: 'button' },
        el('span', { class: 'pjv-flag ' + pm.cls }, el('span', { class: 'pjv-flag-glyph', text: '⚑' })),
        el('span', { text: pm.label }));
      item.onclick = () => { close(); if (!sel) pjvPatchTask(t.id, { priority: key }, reload); };
      menu.append(item);
    }
    const none = el('button', { class: 'pjv-menu-item' + (!t.priority ? ' sel' : ''), type: 'button' },
      el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '없음' }));
    none.onclick = () => { close(); if (t.priority) pjvPatchTask(t.id, { priority: null }, reload); };
    menu.append(none);
  };
  return btn;
}

// 태스크 섹션 — 컬럼 헤더 + 상태 그룹(할 일/진행 중/완료) + 클릭업식 인라인 추가.
//  할 일·진행 중 그룹은 비어도 항상 표시(추가행 노출 → 빈 프로젝트에서도 바로 추가). 완료는 항목 있을 때만.
function pjvTasksSection(projectId, tasks, members, reload) {
  const card = el('div', { class: 'card pjv-tasks-card', style: 'margin-bottom:18px' });
  card.append(el('div', { class: 'card-head' },
    el('h2', { text: '태스크' }),
    el('div', { class: 'card-head-actions' },
      el('span', { class: 'pjv-task-total', text: tasks.length ? tasks.length + '개' : '' }))));

  if (!tasks.length) {
    card.append(el('div', { class: 'pjv-empty-hint' },
      el('b', { text: '아직 태스크가 없어요.' }),
      ' 아래 ', el('span', { class: 'pjv-empty-chip', text: '＋ 태스크' }),
      ' 를 눌러 이름을 적고 Enter — 첫 할 일을 추가하세요.'));
  }

  card.append(el('div', { class: 'pjv-trow pjv-thead' },
    el('div', { class: 'pjv-trow-title-cell', text: '이름' }),
    el('div', { class: 'pjv-tcell', text: '담당자' }),
    el('div', { class: 'pjv-tcell', text: '마감일' }),
    el('div', { class: 'pjv-tcell', text: '우선순위' }),
    el('div', { class: 'pjv-tcell pjv-tcell-add' })));

  const buckets = { todo: [], in_progress: [], done: [] };
  for (const t of tasks) buckets[pjvStatusMeta(t.status).bucket].push(t);

  for (const key of PJV_STATUS_ORDER) {
    const list = buckets[key];
    if (key === 'done' && !list.length) continue; // 완료는 항목 있을 때만(추가행 없음)
    card.append(pjvStatusGroup(projectId, key, list, members, reload));
  }
  return card;
}

// 상태 그룹 — head(캐럿·점·라벨·개수) + body(행들 + 인라인 추가행). 완료 그룹엔 추가행 없음.
function pjvStatusGroup(projectId, key, list, members, reload) {
  const m = PJV_TASK_STATUS[key];
  const body = el('div', { class: 'pjv-tgroup-body' });
  for (const t of list) body.append(pjvTaskRow(projectId, t, members, reload, 0));
  const countEl = el('span', { class: 'pjv-tgroup-count', text: String(list.length) });
  if (key !== 'done') body.append(pjvAddRow(projectId, key, members, reload, body, countEl));

  let gopen = true;
  const gcaret = el('button', { class: 'pjv-tgroup-caret', type: 'button', text: '▾', 'aria-expanded': 'true' });
  gcaret.onclick = () => {
    gopen = !gopen; gcaret.textContent = gopen ? '▾' : '▸';
    gcaret.setAttribute('aria-expanded', gopen ? 'true' : 'false'); body.hidden = !gopen;
  };
  return el('div', { class: 'pjv-tgroup' },
    el('div', { class: 'pjv-tgroup-head ' + m.cls },
      el('span', { class: 'pjv-status-dot sm ' + m.cls }, m.glyph ? el('span', { class: 'pjv-status-glyph', text: m.glyph }) : null),
      el('span', { class: 'pjv-tgroup-label', text: m.label }), countEl, gcaret),
    body);
}

// 인라인 추가행(클릭업식) — 클릭→입력칸, Enter=생성(연속 추가 위해 입력 유지·낙관적 삽입), Esc/빈 blur=접기.
//  생성은 그 그룹 상태로(todo 외엔 생성 후 status 패치). 모달 없이 그 자리에서 바로.
function pjvAddRow(projectId, status, members, reload, body, countEl) {
  const row = el('div', { class: 'pjv-addrow' });
  const trigger = el('button', { class: 'pjv-addrow-trigger', type: 'button' },
    el('span', { class: 'pjv-addrow-plus', text: '＋' }), el('span', { text: '태스크' }));
  const input = el('input', { type: 'text', class: 'pjv-addrow-input', placeholder: '태스크 이름 입력 후 Enter (Esc 취소)', maxlength: '200' });
  const collapse = () => { row.classList.remove('editing'); row.replaceChildren(trigger); };
  // 펼침: 태스크 행과 동일한 그리드 — 입력은 '이름' 컬럼에만 두고 담당자·마감·우선순위 셀은 자리를 유지한다
  //  (클릭업 + Add Task 처럼 컬럼을 안 가림). 비-이름 셀은 생성 전이라 비활성 자리표시만.
  const expand = () => {
    row.classList.add('editing');
    row.replaceChildren(
      el('div', { class: 'pjv-trow-title-cell' }, input),
      el('div', { class: 'pjv-tcell' }),
      el('div', { class: 'pjv-tcell' }),
      el('div', { class: 'pjv-tcell' }),
      el('div', { class: 'pjv-tcell pjv-tcell-add' }));
    input.focus();
  };
  trigger.onclick = expand;
  input.addEventListener('blur', () => { if (!input.value.trim()) collapse(); });
  let busy = false;
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { input.value = ''; collapse(); return; }
    if (e.key !== 'Enter') return;
    const name = input.value.trim();
    if (!name || busy) return;
    busy = true; input.disabled = true;
    try {
      const created = await api('/api/ui/v6/projects/' + projectId + '/tasks', { method: 'POST', body: JSON.stringify({ name }) }).then((d) => d && d.task);
      if (created && status !== 'todo') {
        await api('/api/ui/v6/tasks/' + created.id, { method: 'POST', body: JSON.stringify({ status }) }).catch(() => { /* 상태만 실패해도 생성은 유지 */ });
      }
      const t = Object.assign({ priority: null, assignee: null, due_date: null }, created, { status, subtasks: [] });
      body.insertBefore(pjvTaskRow(projectId, t, members, reload, 0), row); // 추가행 위에 삽입(연속 추가)
      if (countEl) countEl.textContent = String((parseInt(countEl.textContent, 10) || 0) + 1);
      const card = row.closest('.pjv-tasks-card');
      const hint = card && card.querySelector('.pjv-empty-hint');
      if (hint) hint.remove(); // 빈 상태 안내 제거
      input.value = ''; input.disabled = false; busy = false; input.focus();
    } catch (err) { toast('추가 실패 — ' + err.message, true); input.disabled = false; busy = false; }
  });
  collapse();
  return row;
}

// 행 오른쪽 끝 ⋯ 더보기 메뉴(클릭업식) — 하위 태스크 추가(상위만)·이름 변경·삭제.
function pjvRowMore(projectId, t, depth, reload) {
  const btn = el('button', { class: 'pjv-trow-more', type: 'button', title: '더보기', 'aria-label': '태스크 작업' , text: '⋯' });
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(btn, menu);
    const mkItem = (label, onPick, danger) => {
      const b = el('button', { class: 'pjv-menu-item' + (danger ? ' danger' : ''), type: 'button' }, el('span', { text: label }));
      b.onclick = () => { close(); onPick(); };
      return b;
    };
    if (depth === 0) menu.append(mkItem('하위 태스크 추가', () => pjvAddTask(projectId, t.id, reload)));
    menu.append(mkItem('이름 변경', () => pjvRenameTask(btn, t, reload)));
    menu.append(mkItem('삭제', () => pjvDeleteTask(t, reload), true));
  };
  return btn;
}

// 이름 변경 — 앵커 아래 인라인 입력 팝오버. Enter 저장 / Esc·바깥클릭 취소.
function pjvRenameTask(anchor, t, reload) {
  const cur = t.name || t.title || '';
  const input = el('input', { type: 'text', class: 'pjv-rename-input', value: cur, maxlength: '200' });
  const close = pjvPopover(anchor, el('div', { class: 'pjv-menu pjv-rename-pop' }, input));
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const v = input.value.trim(); close(); if (v && v !== cur) pjvPatchTask(t.id, { name: v }, reload); }
  };
  setTimeout(() => { input.focus(); input.select(); }, 0);
}

// 삭제 — 확인 후 task_delete_v6. 하위 동반 삭제 경고. #/trash 복원 가능.
function pjvDeleteTask(t, reload) {
  const nm = t.name || t.title || '이 태스크';
  const nSub = (t.subtasks || []).length;
  const msg = "'" + nm + "' 태스크를 삭제할까요?" + (nSub ? '\n\n하위 ' + nSub + '개도 함께 삭제됩니다.' : '') + '\n\n#/trash 에서 복원할 수 있습니다.';
  if (!confirm(msg)) return;
  (async () => {
    try {
      await api('/api/ui/v6/tasks/' + t.id + '/delete', { method: 'POST', body: JSON.stringify({}) });
      toast('삭제했습니다 — #/trash 에서 복원 가능');
      reload();
    } catch (e) { toast('삭제 실패 — ' + e.message, true); }
  })();
}

// 태스크 한 행 — [캐럿][상태점] 제목 [하위수] | 담당자 | 마감일 | 우선순위 | [⋯]. 하위는 중첩(상위만 하위 추가 가능).
function pjvTaskRow(projectId, t, members, reload, depth) {
  depth = depth || 0;
  const subs = t.subtasks || [];
  const isDone = t.status === 'done';
  const wrap = el('div', { class: 'pjv-trow-wrap' });

  let open = false;
  const caret = subs.length
    ? el('button', { class: 'pjv-trow-caret', type: 'button', 'aria-expanded': 'false', text: '▸' })
    : el('span', { class: 'pjv-trow-caret empty', 'aria-hidden': 'true' });

  // el() 로 구성 — null 자식을 건너뛴다(네이티브 .append(null) 은 "null" 텍스트를 삽입하므로 금지).
  const titleCell = el('div', { class: 'pjv-trow-title-cell' },
    caret, pjvStatusControl(t, reload),
    el('span', { class: 'pjv-trow-title' + (isDone ? ' done' : ''), text: t.name || t.title || '(제목 없음)' }),
    subs.length ? el('span', { class: 'pjv-trow-subcount', title: subs.length + '개 하위', text: String(subs.length) }) : null);
  if (depth) titleCell.style.paddingLeft = (depth * 22) + 'px';

  const moreBtn = pjvRowMore(projectId, t, depth, reload);

  wrap.append(el('div', { class: 'pjv-trow' },
    titleCell,
    el('div', { class: 'pjv-tcell' }, pjvAssigneeControl(t, members, reload)),
    el('div', { class: 'pjv-tcell' }, pjvDueControl(t, reload)),
    el('div', { class: 'pjv-tcell' }, pjvPriorityControl(t, reload)),
    el('div', { class: 'pjv-tcell pjv-tcell-add' }, moreBtn)));

  const subBox = el('div', { class: 'pjv-trow-subs' });
  subBox.hidden = true;
  if (subs.length && depth < 4) {
    for (const s of subs) subBox.append(pjvTaskRow(projectId, s, members, reload, depth + 1));
    caret.onclick = () => {
      open = !open; caret.textContent = open ? '▾' : '▸';
      caret.setAttribute('aria-expanded', open ? 'true' : 'false'); subBox.hidden = !open;
    };
  }
  wrap.append(subBox);
  return wrap;
}

// 태스크/하위 추가 폼 — 이름(필수)·설명(선택). parentTaskId 있으면 하위로 생성(parent_task_id).
function pjvAddTask(projectId, parentTaskId, reload) {
  const nameIn = el('input', { type: 'text', placeholder: parentTaskId ? '하위 태스크 이름' : '태스크 이름', maxlength: '200' });
  const descIn = el('textarea', { rows: '2', placeholder: '설명 (선택)', maxlength: '4000' });
  const saveBtn = el('button', { class: 'btn btn-primary', text: '추가' });
  const back = overlayBox(parentTaskId ? '하위 태스크 추가' : '새 태스크',
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '설명 (선택)' }), descIn),
    el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
  setTimeout(() => nameIn.focus(), 0);
  const go = async () => {
    const name = nameIn.value.trim();
    if (!name) { nameIn.focus(); toast('이름을 입력하세요', true); return; }
    saveBtn.disabled = true;
    try {
      await api('/api/ui/v6/projects/' + projectId + '/tasks', { method: 'POST', body: JSON.stringify({
        name, description: descIn.value.trim() || undefined,
        parent_task_id: parentTaskId != null ? parentTaskId : undefined,
      }) });
      back.remove();
      toast(parentTaskId ? '하위 태스크를 추가했습니다' : '태스크를 추가했습니다');
      reload();
    } catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
  saveBtn.onclick = go;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

// 필요 지식 / 산출 지식 — 두 섹션. 각 행은 지식 상세(#/k/:name)로 링크.
function companyTimelineSection() {
  const card = el('div', { class: 'card', style: 'margin-bottom:18px' });
  const body = el('div', {});
  const st = { type: '' };
  let members = [];
  let acts = [];
  let shown = 6;
  const nameOf = (pid) => { const m = members.find((x) => x.id === pid); return (m && m.display_name) || pid || '—'; };
  const TYPES = [['', '전체'], ['commit', '커밋'], ['comment', '코멘트'], ['decision', '결정'], ['status_change', '상태 변경'], ['review', '검토']];
  const chipsBar = el('div', { class: 'proj-tl-filter' });
  const paintChips = () => chipsBar.replaceChildren(...TYPES.map(([v, label]) =>
    el('button', { class: 'proj-tl-chip' + (st.type === v ? ' active' : ''), text: label, onclick: () => { st.type = v; paintChips(); load(); } })));
  paintChips();
  card.append(chipsBar, body);
  api('/api/ui/dash/members').then((d) => { members = (d && d.members) || []; if (acts.length) render(); }).catch(() => {});
  load();
  return card;

  async function load() {
    body.replaceChildren(skeletonRows(4));
    try {
      const qs = '?limit=200' + (st.type ? '&type=' + encodeURIComponent(st.type) : '');
      acts = await api('/api/ui/activity/list' + qs).then((d) => (Array.isArray(d) ? d : (d && d.rows) || []));
    } catch (e) { body.replaceChildren(errorNote(e, '작업을 불러오지 못했습니다')); return; }
    shown = 6;
    render();
  }
  function render() {
    if (!acts.length) { body.replaceChildren(el('div', { class: 'empty', text: '아직 기록된 작업이 없습니다.' })); return; }
    const list = el('div', { class: 'proj-tl-list' }, ...acts.slice(0, shown).map(actRow));
    body.replaceChildren(list);
    if (acts.length > shown) {
      body.append(el('button', { class: 'btn btn-ghost btn-sm proj-tl-more',
        text: '＋ ' + (acts.length - shown) + '개 더 보기', onclick: () => { shown += 10; render(); } }));
    }
  }
  function actRow(a) { return activityTimelineRow(a, nameOf); }
}

// 한 섹션(진행 중 / 완료) — 카드 + 개수 배지 + 행 리스트(비었으면 안내).
function projectSection(label, list, emptyText, reload, done, opts) {
  const card = el('div', { class: 'card', style: 'margin-bottom:18px' },
    el('div', { class: 'card-head' },
      el('h3', { class: 'project-sec-title' }, label,
        el('span', { class: 'project-count', text: String(list.length) }))));
  if (!list.length) { card.append(el('div', { class: 'empty', text: emptyText })); return card; }
  card.append(el('div', { class: 'project-grid' + (done ? ' done' : '') }, ...list.map((p) => projectTile(p, reload, opts))));
  return card;
}

// 프로젝트 타일 카드 — 이름·설명·팀원 아바타(facepile)·메타 + 상태 토글. 카드 클릭=상세.
//  opts.statusBase / opts.detailBase 로 v1(/api/ui/projects, #/projects)·v6(/api/ui/v6/projects, #/projects2/p) 공용.
function projectTile(p, reload, opts) {
  const statusBase = (opts && opts.statusBase) || '/api/ui/projects/';
  const detailBase = (opts && opts.detailBase) || '#/projects/';
  const select = opts && opts.select;             // 선택(일괄삭제) 모드 — 있으면 클릭=체크 토글, 상태 토글 숨김.
  const selectable = !!select && select.canSelect(p); // 내가 만든 것만 선택 가능.
  const isDone = p.status === 'done';
  const tile = el('div', { class: 'project-tile' + (isDone ? ' done' : '') + (select ? ' select-mode' : '') });

  if (select && selectable) {
    tile.classList.add('selectable');
    const cb = el('span', { class: 'project-tile-check', 'aria-hidden': 'true' });
    const apply = (on) => { tile.classList.toggle('selected', on); cb.textContent = on ? '✓' : ''; tile.setAttribute('aria-checked', on ? 'true' : 'false'); };
    apply(select.ids.has(p.id));
    tile.append(cb);
    tile.setAttribute('role', 'checkbox');
    tile.setAttribute('tabindex', '0');
    const toggle = () => { const on = !select.ids.has(p.id); if (on) select.ids.add(p.id); else select.ids.delete(p.id); apply(on); select.onToggle(); };
    tile.addEventListener('click', toggle);
    tile.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
  } else if (select) {
    // 선택 모드지만 내 프로젝트 아님 — 선택 불가(흐리게), 클릭은 상세로.
    tile.classList.add('not-selectable');
    tile.addEventListener('click', () => { location.hash = detailBase + p.id; });
  } else {
    // 완료 카드는 비활성 느낌 — 전체클릭 대신 아래 '보기' 버튼으로 접근. 활성 카드만 전체클릭=상세.
    if (!isDone) tile.addEventListener('click', () => { location.hash = detailBase + p.id; });
  }

  tile.append(el('div', { class: 'project-tile-name', text: p.name }));
  if (p.description) tile.append(el('div', { class: 'project-tile-desc', text: p.description }));

  const members = p.members || [];
  if (members.length) {
    const faces = el('div', { class: 'project-tile-faces' });
    for (const m of members.slice(0, 5)) {
      faces.append(el('span', { class: 'project-face', style: 'background:' + avatarColor(m.member_id), title: m.display_name || m.member_id, text: initials(m.display_name || m.member_id) }));
    }
    if (members.length > 5) faces.append(el('span', { class: 'project-face more', text: '+' + (members.length - 5) }));
    tile.append(faces);
  }

  const when = isDone ? (p.completed_at || p.updated_at) : (p.updated_at || p.created_at);
  const meta = el('div', { class: 'project-tile-meta', text: (isDone ? '완료 ' : '갱신 ') + (when ? relTime(when) : '') });
  const foot = el('div', { class: 'project-tile-foot' }, meta);
  if (!select) {
    // 비선택 모드만 상태 토글 노출 — 선택 모드에선 카드 클릭(=체크)과 충돌 방지 위해 숨김.
    const changeStatus = async (ev, status, okMsg) => {
      ev.stopPropagation();
      const btn = ev.currentTarget; btn.disabled = true;
      try {
        await api(statusBase + p.id + '/status', { method: 'POST', body: JSON.stringify({ status }) });
        toast(okMsg); reload();
      } catch (e) { toast('실패 — ' + e.message, true); btn.disabled = false; }
    };
    if (isDone) {
      // 완료 카드 — '보기'(상세 접근) + '진행 중으로'(재개). 둘 다 ghost(파란 강조 없음, 비활성 톤 유지).
      const viewBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '보기',
        onclick: (ev) => { ev.stopPropagation(); location.hash = detailBase + p.id; } });
      const reBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '진행 중으로',
        onclick: (ev) => changeStatus(ev, 'active', '진행 중으로 옮겼습니다') });
      foot.append(el('div', { class: 'project-tile-acts' }, viewBtn, reBtn));
    } else {
      const toggle = el('button', { class: 'btn btn-sm btn-primary', text: '완료',
        onclick: (ev) => changeStatus(ev, 'done', '완료로 표시했습니다') });
      foot.append(toggle);
    }
  } else if (!selectable) {
    foot.append(el('span', { class: 'project-tile-mine-no', text: '내 프로젝트 아님' }));
  }
  tile.append(foot);
  return tile;
}

// 팀원 선택 위젯 — 이름 검색으로 하나씩 추가(클릭), 선택된 사람은 칩으로(× 제거). 생성·수정 공용.
//  동기 반환(즉시 로딩표시) + 비동기 채움. getSelected() 가 현재 선택 id 배열.
function memberPicker(preselected, opts) {
  const selected = new Set(preselected || []);
  let all = [];
  const chips = el('div', { class: 'proj-mp-chips' });
  const searchIn = el('input', { type: 'text', class: 'proj-mp-search', placeholder: '이름으로 검색해 추가…' });
  const results = el('div', { class: 'proj-mp-results' }, el('span', { class: 'admin-hint', text: '불러오는 중…' }));
  const box = el('div', { class: 'proj-mp' }, chips, searchIn, results);

  function paintChips() {
    const sel = all.filter((m) => selected.has(m.id));
    if (!sel.length) { chips.replaceChildren(el('span', { class: 'admin-hint', text: '아직 선택된 팀원이 없어요.' })); return; }
    chips.replaceChildren(...sel.map((m) => el('span', { class: 'proj-mp-chip' },
      el('span', { text: m.display_name || m.id }),
      el('button', { class: 'proj-mp-chip-x', type: 'button', text: '×', onclick: () => { selected.delete(m.id); paintChips(); paintResults(); } }))));
  }
  function paintResults() {
    if (!all.length) { results.replaceChildren(el('span', { class: 'admin-hint', text: '등록된 사람 구성원이 없습니다.' })); return; }
    const q = searchIn.value.trim().toLowerCase();
    const cand = all.filter((m) => !selected.has(m.id) && (!q || (m.display_name || m.id).toLowerCase().includes(q)));
    if (!cand.length) { results.replaceChildren(el('div', { class: 'proj-mp-empty', text: q ? '일치하는 사람이 없어요.' : '추가할 수 있는 사람을 모두 골랐어요.' })); return; }
    results.replaceChildren(...cand.map((m) => el('div', { class: 'proj-mp-row', onclick: () => { selected.add(m.id); searchIn.value = ''; paintChips(); paintResults(); searchIn.focus(); } },
      el('span', { class: 'proj-mp-ava', style: 'background:' + avatarColor(m.id), text: initials(m.display_name || m.id) }),
      el('span', { class: 'proj-mp-name', text: m.display_name || m.id }),
      el('span', { class: 'proj-mp-add', text: '＋ 추가' }))));
  }
  searchIn.addEventListener('input', paintResults);
  api('/api/ui/dash/members').then((d) => {
    all = (d && d.members) || [];
    // 생성 폼 기본값: 나(생성자)를 디폴트 선택 — 활성 구성원 목록에 실제 있을 때만(유령 id 방지). ×로 해제 가능.
    if (opts && opts.includeMe) {
      const meId = state.me && state.me.userId;
      if (meId && all.some((m) => m.id === meId)) selected.add(meId);
    }
    paintChips(); paintResults();
  })
    .catch(() => results.replaceChildren(el('span', { class: 'admin-hint', text: '팀원 목록을 불러오지 못했습니다.' })));
  return { box, getSelected: () => [...selected] };
}

// 새 프로젝트 오버레이 폼 — 이름(필수)·설명(선택)·팀원. 생성 시 폴더 자동 생성 + 새 전용 페이지로 이동.
async function authDownload(url, filename) {
  const token = localStorage.getItem(TOKEN_KEY);
  let res;
  try { res = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} }); }
  catch (e) { toast('다운로드 실패 — ' + e.message, true); return; }
  if (!res.ok) { toast('다운로드 실패 (' + res.status + ')', true); return; }
  const blob = await res.blob();
  const a = el('a', { href: URL.createObjectURL(blob), download: filename || 'download' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
// 인증 fetch 업로드(PUT raw 스트림). 파일 본문 그대로 — Content-Type 비워 서버가 스트림으로 받음.
async function authUpload(url, file) {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(url, { method: 'PUT', headers: token ? { Authorization: 'Bearer ' + token } : {}, body: file });
  if (!res.ok) { let m = ''; try { m = (await res.json()).error; } catch (_) { /* */ } throw new Error(m || ('업로드 실패 (' + res.status + ')')); }
}
// 진행률 콜백 업로드 — fetch 는 업로드 progress 가 없어 XHR 사용. onProgress(pct 0~100).
function authUploadProgress(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const token = localStorage.getItem(TOKEN_KEY);
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable && onProgress) onProgress((ev.loaded / ev.total) * 100); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else { let m = ''; try { m = JSON.parse(xhr.responseText).error; } catch (_) { /* */ } reject(new Error(m || ('업로드 실패 (' + xhr.status + ')'))); }
    };
    xhr.onerror = () => reject(new Error('네트워크 오류'));
    xhr.send(file);
  });
}
function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}
function fileExt(name) { const i = String(name || '').lastIndexOf('.'); return i >= 0 ? name.slice(i + 1).toLowerCase() : ''; }
// 클립보드 붙여넣기 이미지 → 업로드용 File(고유 이름). File.name 은 read-only 라 새 File 로 감싼다.
//  같은 시각 다중 붙여넣기 충돌 방지로 날짜-시각(+ms 2자리, 다중이면 순번). 공유폴더는 유니코드 보존이라 한글 이름 OK.
function pastedImageFile(blob, seq) {
  const extMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/tiff': 'tiff' };
  const ext = extMap[blob.type] || (String(blob.type).split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const ts = '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + p(d.getMilliseconds()).slice(0, 2);
  const name = '붙여넣기-' + ts + (seq ? '-' + (seq + 1) : '') + '.' + ext;
  try { return new File([blob], name, { type: blob.type }); }
  catch (_) { try { blob.name = name; } catch (_2) { /* File.name read-only */ } return blob; }
}

// 붙여넣기 전 이름 지정 + 동작 안내 팝업 — 클립보드 이미지를 공유 폴더로 올리기 전에 띄운다.
//  단일: [이름][.확장자(고정 태그)]. 다중: 공통 베이스명 + 각 파일에 -1,-2…와 원래 확장자. 확인 시 onConfirm(files).
//  확장자를 입력칸 밖 고정 태그로 둬, 타이핑 중 확장자가 지워지는 것을 구조적으로 막는다.
function openPasteDialog(imgs, destLabel, onConfirm) {
  const multi = imgs.length > 1;
  const defName = pastedImageFile(imgs[0], 0).name;            // 기존 자동이름 규칙 재사용
  const ext0 = fileExt(defName);
  const stem0 = ext0 ? defName.slice(0, defName.length - ext0.length - 1) : defName;
  const nameIn = el('input', { type: 'text', value: stem0, maxlength: '120', placeholder: '파일 이름' });

  const action = el('p', { class: 'paste-action' },
    '클립보드의 ', el('b', { text: '이미지 ' + imgs.length + '개' }),
    ' 를 ', el('b', { text: destLabel }), ' 에 업로드합니다.');

  const nameRow = el('div', { class: 'paste-name-row' }, nameIn,
    multi ? null : el('span', { class: 'paste-ext', text: '.' + (ext0 || 'png') }));
  const hint = multi
    ? el('p', { class: 'admin-hint', text: '각 파일 이름 뒤에 -1, -2 … 와 원래 확장자가 붙습니다.' })
    : null;

  const saveBtn = el('button', { class: 'btn btn-primary', text: multi ? (imgs.length + '개 올리기') : '올리기' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  const back = overlayBox('붙여넣기',
    action,
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameRow, hint),
    el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
  setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0); // 확장자는 입력칸 밖이라 전체선택해도 안전

  const go = () => {
    let stem = nameIn.value.trim().replace(/[/\\]/g, '-').replace(/^\.+/, '').replace(/\s+/g, ' ').trim();
    if (!stem) stem = stem0;
    const files = imgs.map((b, i) => {
      const ext = fileExt(pastedImageFile(b, 0).name) || 'png';
      const nm = (multi ? stem + '-' + (i + 1) : stem) + '.' + ext;
      try { return new File([b], nm, { type: b.type }); }
      catch (_) { try { b.name = nm; } catch (_2) { /* read-only */ } return b; }
    });
    back.remove();
    onConfirm(files);
  };
  saveBtn.onclick = go;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}
const IMG_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
function iconFor(name) {
  const e = fileExt(name);
  if (IMG_EXTS.includes(e)) return '🖼️';
  if (['md', 'txt', 'rtf', 'csv'].includes(e)) return '📝';
  if (e === 'pdf') return '📕';
  if (['zip', 'tar', 'gz', 'tgz', 'rar', '7z'].includes(e)) return '🗜️';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(e)) return '🎬';
  if (['mp3', 'wav', 'flac', 'm4a'].includes(e)) return '🎵';
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'sh', 'json', 'html', 'css', 'java', 'go', 'rs', 'c', 'cpp', 'rb', 'php', 'yml', 'yaml', 'toml'].includes(e)) return '📄';
  return '📄';
}

// 공유 폴더 단색 라인 아이콘 — 컬러 이모지 대신(calm 예산: 색이 아니라 형태로 구분).
//  currentColor 를 상속하므로 색·획굵기는 CSS(.fic)에서 통제. 확장자→형태만 매핑(타입은 파일명 확장자가 이미 말해줌).
function fileKind(name) {
  const e = fileExt(name);
  if (IMG_EXTS.includes(e)) return 'image';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(e)) return 'video';
  if (['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg'].includes(e)) return 'audio';
  if (['zip', 'tar', 'gz', 'tgz', 'rar', '7z'].includes(e)) return 'archive';
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'sh', 'json', 'html', 'css', 'java', 'go', 'rs', 'c', 'cpp', 'rb', 'php', 'yml', 'yaml', 'toml'].includes(e)) return 'code';
  return 'file';
}
const FILE_ICON_GLYPHS = {
  dir:     [['path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }]],
  file:    [['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }], ['polyline', { points: '14 3 14 8 19 8' }], ['line', { x1: 9, y1: 13, x2: 15, y2: 13 }], ['line', { x1: 9, y1: 16.5, x2: 15, y2: 16.5 }]],
  image:   [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['circle', { cx: 8.5, cy: 9.5, r: 1.5 }], ['polyline', { points: '21 16 15.5 11 5 20' }]],
  video:   [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['polygon', { points: '10 8.5 16 12 10 15.5 10 8.5' }]],
  audio:   [['path', { d: 'M9 17V5l10-2v12' }], ['circle', { cx: 6, cy: 17, r: 3 }], ['circle', { cx: 16, cy: 15, r: 3 }]],
  archive: [['rect', { x: 4, y: 4, width: 16, height: 4, rx: 1 }], ['path', { d: 'M5.5 8v10a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V8' }], ['line', { x1: 10.5, y1: 12, x2: 13.5, y2: 12 }]],
  code:    [['polyline', { points: '15 7 20 12 15 17' }], ['polyline', { points: '9 7 4 12 9 17' }]],
};
function fileThumb(id, it, rel, base) {
  if (it.type === 'dir') return folderThumb();
  const ext = fileExt(it.name);
  if (IMG_EXTS.includes(ext)) return imageThumb(id, rel, base, it.name);
  return docIcon(ext);
}
// 폴더 — 맥 느낌 소프트 블루(두 톤).
function folderThumb() {
  const n = sv('svg', { class: 'ft ft-folder', viewBox: '0 0 48 40', fill: 'none', 'aria-hidden': 'true' });
  n.append(sv('path', { class: 'ft-folder-tab', d: 'M4 9a3 3 0 0 1 3-3h10.5l4 4H4z' }));
  n.append(sv('path', { class: 'ft-folder-body', d: 'M4 12a3 3 0 0 1 3-3h34a3 3 0 0 1 3 3v19a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z' }));
  return n;
}
// 타입별 색 문서 아이콘 — 흰 페이지 + 접힌 모서리 + 색 띠 + 라벨(PDF/DOC/PPT/XLS …).
function docIcon(ext) {
  const meta = FILE_TYPE_META[ext] || { label: (String(ext || '').toUpperCase().slice(0, 4) || 'FILE'), cls: 'ft-generic' };
  const n = sv('svg', { class: 'ft ft-file ' + meta.cls, viewBox: '0 0 40 48', fill: 'none', 'aria-hidden': 'true' });
  n.append(sv('path', { class: 'ft-page', d: 'M6 2.5h17.5L34 13v30.5a2.5 2.5 0 0 1-2.5 2.5h-25A2.5 2.5 0 0 1 4 43.5V5A2.5 2.5 0 0 1 6 2.5z' }));
  n.append(sv('path', { class: 'ft-fold', d: 'M23.5 2.5V11a2 2 0 0 0 2 2H34z' }));
  n.append(sv('rect', { class: 'ft-band', x: 4, y: 29, width: 30, height: 12, rx: 2.5 }));
  const t = sv('text', { class: 'ft-label', x: 19, y: 37.8, 'text-anchor': 'middle' }); t.textContent = meta.label;
  n.append(t);
  return n;
}
// 이미지 — 실제 썸네일. 파일 API 가 Bearer 인증이라 <img src> 직접 불가 → blob fetch 후 objectURL. 보일 때 지연 로드.
function imageThumb(id, rel, base, name) {
  const wrap = el('div', { class: 'ft ft-img' });
  const img = el('img', { alt: name });
  wrap.append(img);
  wrap._loadThumb = async () => {
    const token = localStorage.getItem(TOKEN_KEY);
    const url = (base || '/api/ui/projects/') + id + '/file?path=' + encodeURIComponent(rel);
    try {
      const res = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
      if (!res.ok) { wrap.classList.add('ft-img-err'); return; }
      img.src = URL.createObjectURL(await res.blob());
      wrap.classList.add('loaded');
    } catch (_) { wrap.classList.add('ft-img-err'); }
  };
  thumbObserve(wrap);
  return wrap;
}
// 지연 로드 — 화면(+여유 200px)에 들어올 때 _loadThumb() 1회. IntersectionObserver 없으면 즉시.
let _thumbObserver = null;
function thumbObserve(wrap) {
  if (typeof IntersectionObserver === 'undefined') { if (wrap._loadThumb) wrap._loadThumb(); return; }
  if (!_thumbObserver) {
    _thumbObserver = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { _thumbObserver.unobserve(e.target); if (e.target._loadThumb) e.target._loadThumb(); }
    }, { rootMargin: '200px' });
  }
  _thumbObserver.observe(wrap);
}

// 텍스트로 열어 편집 가능한 확장자(화이트리스트). 그 외 바이너리(docx/xlsx/zip 등)는 textarea 로 열면 깨지므로 다운로드.
const TEXT_EXTS = ['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs',
  'py', 'sh', 'bash', 'zsh', 'rb', 'go', 'rs', 'c', 'cc', 'cpp', 'h', 'hpp', 'java', 'kt', 'swift', 'php',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'xml', 'svg', 'yml', 'yaml', 'toml', 'ini', 'conf', 'env',
  'sql', 'vue', 'svelte', 'r', 'lua', 'pl', 'dart', 'gradle', 'properties', 'gitignore', 'dockerfile'];

// 파일 뷰어 — 이미지=미리보기, PDF=내장 뷰어(iframe), 텍스트=편집·저장, 그 외 바이너리=다운로드 안내.
async function openFileViewer(id, rel, name, reload, base) {
  const B = base || '/api/ui/projects/';
  const token = localStorage.getItem(TOKEN_KEY);
  const url = B + id + '/file?path=' + encodeURIComponent(rel);
  const ext = fileExt(name);
  const isImg = IMG_EXTS.includes(ext);
  const isPdf = ext === 'pdf';
  const isText = TEXT_EXTS.includes(ext);
  const footer = (back, extra) => el('div', { class: 'ov-actions' },
    ...(extra || []),
    el('button', { class: 'btn btn-ghost', text: '다운로드', onclick: () => authDownload(url + '&download=1', name) }),
    el('button', { class: 'btn btn-ghost', text: '닫기', onclick: () => back.remove() }));

  // 미리보기 미지원 바이너리 — 다운로드만(fetch 생략).
  if (!isImg && !isPdf && !isText) {
    const back = overlayBox(name, el('p', { class: 'admin-hint', text: '미리보기를 지원하지 않는 형식이에요. 다운로드해서 확인하세요.' }));
    back.querySelector('.ov-box').append(footer(back));
    return;
  }
  let res;
  try { res = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} }); }
  catch (_) { toast('파일을 열지 못했습니다', true); return; }
  if (res.status === 413) {
    const back = overlayBox(name, el('p', { class: 'admin-hint', text: '미리보기엔 너무 큰 파일이에요. 다운로드해서 확인하세요.' }));
    back.querySelector('.ov-box').append(footer(back));
    return;
  }
  if (!res.ok) { toast('파일을 열지 못했습니다 (' + res.status + ')', true); return; }
  const blob = await res.blob();

  if (isImg) {
    const back = overlayBox(name, el('img', { class: 'proj-file-img', src: URL.createObjectURL(blob), alt: name }));
    back.querySelector('.ov-box').append(footer(back));
    return;
  }
  if (isPdf) {
    // blob 에 MIME 이 없으면 iframe 이 PDF 를 텍스트로 표시(원시 %PDF 바이트 노출) — application/pdf 로 강제 후 네이티브 뷰어 렌더.
    const pdfBlob = blob.type === 'application/pdf' ? blob : new Blob([await blob.arrayBuffer()], { type: 'application/pdf' });
    const back = overlayBox(name, el('iframe', { class: 'proj-file-pdf', src: URL.createObjectURL(pdfBlob) }));
    const box = back.querySelector('.ov-box'); box.classList.add('ov-box-wide'); box.append(footer(back));
    return;
  }
  // 텍스트 — 편집/저장
  const ta = el('textarea', { class: 'proj-file-edit' }); ta.value = await blob.text();
  const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
  const back = overlayBox(name, ta);
  back.querySelector('.ov-box').append(footer(back, [saveBtn]));
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try { await authUpload(url, new Blob([ta.value])); toast('저장했습니다'); back.remove(); if (reload) reload(); }
    catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  };
}

// 공유 폴더 아이콘 카드(맥 데스크탑 느낌) — 폴더는 onDir(rel), 파일은 뷰어 팝업. 섹션·전체보기 팝업 공용.
function projFileCardEl(id, it, rel, onDir, reload, base, select) {
  const isDir = it.type === 'dir';
  const c = el('div', { class: 'proj-file-card' + (select ? ' select-mode' : ''), title: it.name },
    el('div', { class: 'proj-file-card-ic' }, fileThumb(id, it, rel, base)),
    el('div', { class: 'proj-file-card-nm', text: it.name }),
    el('div', { class: 'proj-file-card-sz', text: isDir ? '폴더' : fmtSize(it.size) }));
  if (select) {
    // 선택 모드 — 카드 클릭 = 체크 토글(열기/진입 대신). 파일·폴더 모두 골라 일괄 삭제 가능.
    const ids = select.ids;
    const on0 = ids.has(rel);
    if (on0) c.classList.add('selected');
    const cb = el('span', { class: 'proj-file-check', 'aria-hidden': 'true', text: on0 ? '✓' : '' });
    c.append(cb);
    c.setAttribute('role', 'checkbox'); c.setAttribute('tabindex', '0'); c.setAttribute('aria-checked', on0 ? 'true' : 'false');
    const toggle = () => { const v = !ids.has(rel); if (v) ids.add(rel); else ids.delete(rel); c.classList.toggle('selected', v); cb.textContent = v ? '✓' : ''; c.setAttribute('aria-checked', v ? 'true' : 'false'); select.onToggle(); };
    c.onclick = toggle;
    c.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
  } else {
    c.onclick = isDir ? () => onDir(rel) : () => openFileViewer(id, rel, it.name, reload, base);
  }
  return c;
}
function projUpCardEl(onClick) {
  return el('div', { class: 'proj-file-card', onclick: onClick },
    el('div', { class: 'proj-file-card-ic', text: '↩' }), el('div', { class: 'proj-file-card-nm', text: '상위 폴더' }));
}

// 전체 보기 목록의 한 행 — [아이콘][이름][크기][호버 시 액션 아이콘]. 폴더는 진입, 파일은 뷰어.
function projFileRowEl(id, it, rel, onDir, reload, base) {
  const B = base || '/api/ui/projects/';
  const isDir = it.type === 'dir';
  const acts = el('div', { class: 'proj-file-lacts' },
    fileIconBtn('✎', '이름변경', (ev) => { ev.stopPropagation(); renameEntry(id, rel, it.name, isDir, reload, B); }),
    isDir ? null : fileIconBtn('↓', '다운로드', (ev) => { ev.stopPropagation(); authDownload(B + id + '/file?download=1&path=' + encodeURIComponent(rel), it.name); }),
    fileIconBtn('✕', '삭제', (ev) => { ev.stopPropagation(); deleteEntry(id, rel, it.name, isDir, reload, B); }, true));
  const row = el('div', { class: 'proj-file-lrow' },
    el('span', { class: 'proj-file-lic' }, fileThumb(id, it, rel, B)),
    el('span', { class: 'proj-file-lnm' + (isDir ? ' is-dir' : ''), text: it.name, title: it.name }),
    el('span', { class: 'proj-file-lsz', text: isDir ? '' : fmtSize(it.size) }),
    acts);
  row.onclick = isDir ? () => onDir(rel) : () => openFileViewer(id, rel, it.name, reload, B);
  return row;
}
function fileIconBtn(glyph, title, onclick, danger) {
  return el('button', { class: 'proj-file-iconbtn' + (danger ? ' danger' : ''), title, type: 'button', text: glyph, onclick });
}
// 파일/폴더 이름 변경(같은 폴더 안).
function renameEntry(id, rel, name, isDir, reload, base) {
  const B = base || '/api/ui/projects/';
  const nameIn = el('input', { type: 'text', value: name, maxlength: '120' });
  const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
  const back = overlayBox('이름 변경',
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '새 이름' }), nameIn),
    el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
  setTimeout(() => {
    nameIn.focus();
    // 파일은 확장자(.png 등)를 뺀 본문만 선택 — 타이핑 시 확장자가 통째로 지워지는 것 방지(Finder/VS Code 동작).
    const dot = name.lastIndexOf('.');
    if (!isDir && dot > 0) nameIn.setSelectionRange(0, dot);
    else nameIn.select();
  }, 0);
  const go = async () => {
    const nm = nameIn.value.trim();
    if (!nm || nm === name) { back.remove(); return; }
    saveBtn.disabled = true;
    try { await api(B + id + '/rename', { method: 'POST', body: JSON.stringify({ path: rel, name: nm }) }); back.remove(); toast('이름을 변경했습니다'); reload(); }
    catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
  saveBtn.onclick = go;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}
// 파일/폴더 삭제(폴더는 내용까지). 확인 후.
async function deleteEntry(id, rel, name, isDir, reload, base) {
  const B = base || '/api/ui/projects/';
  if (!confirm((isDir ? '폴더' : '파일') + ' ‘' + name + '’을(를) 삭제할까요?' + (isDir ? '\n\n폴더 안 내용도 함께 삭제됩니다(되돌릴 수 없음).' : '\n\n되돌릴 수 없습니다.'))) return;
  try { await api(B + id + '/file?path=' + encodeURIComponent(rel), { method: 'DELETE' }); toast('삭제했습니다'); reload(); }
  catch (e) { toast('실패 — ' + e.message, true); }
}

// 공유 폴더 '전체 보기' — 넓은 팝업에 일반 파일 목록(행 단위)으로 전부 표시. 폴더 탐색·파일 열기 가능.
function openFolderGrid(id, startPath, base) {
  const B = base || '/api/ui/projects/';
  const st = { path: startPath || '', q: '' };
  const searchIn = el('input', { type: 'search', class: 'proj-file-search', placeholder: '파일 검색…' });
  searchIn.addEventListener('input', debounce(() => { st.q = searchIn.value.trim(); load(); }, 300));
  const fileInput = el('input', { type: 'file', multiple: '', style: 'display:none' });
  fileInput.addEventListener('change', async () => { await uploadHere(fileInput.files); fileInput.value = ''; });
  const mkdirBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 새 폴더', onclick: () => mkdirHere() });
  const uploadBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 업로드', onclick: () => fileInput.click() });
  const crumb = el('div', { class: 'proj-file-crumb' });
  const listBox = el('div', { class: 'proj-file-llist' });
  const back = overlayBox('공유 폴더 — 전체 보기',
    el('div', { class: 'proj-fg-head' }, searchIn, el('div', { class: 'proj-fg-actions' }, mkdirBtn, uploadBtn, fileInput)),
    crumb, listBox);
  const box = back.querySelector('.ov-box'); if (box) box.classList.add('ov-box-wide');
  const join = (a, b) => (a ? a + '/' + b : b);
  load();

  async function uploadHere(files) {
    const arr = Array.from(files || []); if (!arr.length) return;
    if (arr.length > 1) toast(arr.length + '개 업로드 중…');
    let ok = 0;
    for (const f of arr) {
      try { await authUpload(B + id + '/file?path=' + encodeURIComponent((st.path ? st.path + '/' : '') + f.name), f); ok += 1; }
      catch (e) { toast(f.name + ' 실패 — ' + e.message, true); }
    }
    if (ok) toast(ok + '개 업로드 완료'); st.q = ''; searchIn.value = ''; load();
  }
  function mkdirHere() {
    const nameIn = el('input', { type: 'text', placeholder: '폴더 이름', maxlength: '80' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: '만들기' });
    const b2 = overlayBox('새 폴더',
      el('p', { class: 'admin-hint', text: (st.path ? '“' + st.path + '” 안에' : '루트에') + ' 새 폴더를 만듭니다.' }),
      el('div', { class: 'field' }, el('label', { class: 'field-label', text: '폴더 이름' }), nameIn),
      el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => b2.remove() })));
    setTimeout(() => nameIn.focus(), 0);
    const go = async () => {
      const nm = nameIn.value.trim(); if (!nm) { nameIn.focus(); return; }
      saveBtn.disabled = true;
      try { await api(B + id + '/folder?path=' + encodeURIComponent((st.path ? st.path + '/' : '') + nm), { method: 'POST' }); b2.remove(); toast('폴더를 만들었습니다'); load(); }
      catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
    };
    saveBtn.onclick = go; nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }
  async function load() {
    listBox.replaceChildren(skeletonRows(5));
    const qs = st.q ? ('?q=' + encodeURIComponent(st.q)) : ('?path=' + encodeURIComponent(st.path));
    let data;
    try { data = await api(B + id + '/files' + qs); }
    catch (e) { listBox.replaceChildren(errorNote(e, '폴더를 불러오지 못했습니다')); return; }
    if (data.search !== undefined) {
      crumb.replaceChildren(el('span', { text: '“' + data.search + '” 검색 — ' + data.items.length + '건' }));
      const rows = (data.items || []).map((it) => projFileRowEl(id, it, it.path, (t) => { st.q = ''; searchIn.value = ''; st.path = t; load(); }, load, B));
      listBox.replaceChildren(...(rows.length ? rows : [el('div', { class: 'empty', text: '일치하는 파일이 없어요.' })]));
      return;
    }
    crumb.replaceChildren(
      el('span', { class: 'proj-crumb-link', text: '⌂ 루트', onclick: () => { st.path = ''; load(); } }),
      data.path ? el('span', { text: ' / ' + data.path }) : null);
    const rows = [];
    if (data.path) rows.push(el('div', { class: 'proj-file-lrow', onclick: () => { st.path = data.parent || ''; load(); } },
      el('span', { class: 'proj-file-lic', text: '↩' }), el('span', { class: 'proj-file-lnm', text: '상위 폴더' }),
      el('span', { class: 'proj-file-lsz' }), el('span', { class: 'proj-file-lacts' })));
    for (const it of (data.items || [])) rows.push(projFileRowEl(id, it, join(st.path, it.name), (t) => { st.path = t; load(); }, load, B));
    listBox.replaceChildren(...(rows.length ? rows : [el('div', { class: 'empty', text: '빈 폴더입니다.' })]));
  }
}
function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }
// 타임라인용 날짜시간 — '몇 시간 전' 대신 절대 날짜·시각(연도는 올해가 아니면만 표기).
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  const yr = d.getFullYear() !== new Date().getFullYear() ? (d.getFullYear() + '. ') : '';
  return yr + (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// ── 상세 ① 공유 폴더 — 프로젝트 폴더 탐색 + 업로드/다운로드 + 검색. ──
function projectFolderSection(id, base) {
  const B = base || '/api/ui/projects/';
  const card = el('div', { class: 'card', style: 'margin-bottom:18px' });
  const body = el('div', {});
  const st = { path: '', q: '' };
  let lastData = null;   // 마지막 서버 응답(업로드 중 그리드 즉시 재구성용)
  const uploading = [];  // 업로드 중 파일 [{ name, pct, pctEl, fill }]
  const searchIn = el('input', { type: 'search', placeholder: '파일 검색…', class: 'proj-file-search' });
  searchIn.addEventListener('input', debounce(() => { st.q = searchIn.value.trim(); load(); }, 300));
  const fileInput = el('input', { type: 'file', multiple: '', style: 'display:none' });
  fileInput.addEventListener('change', () => { uploadFiles(fileInput.files); fileInput.value = ''; });
  const uploadBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 업로드', onclick: () => fileInput.click() });
  const allBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '전체 보기', onclick: () => openFolderGrid(id, st.path, B) });
  const mkdirBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 새 폴더', onclick: () => openMkdir() });
  // 선택(일괄삭제) 모드 — 카드 뷰에서 여러 항목을 골라 한 번에 삭제. ids = 선택된 rel(상대경로) 집합.
  const sel = { mode: false, ids: new Set() };
  let lastPairs = [];
  const selectBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '선택', title: '여러 항목을 골라 한 번에 삭제', onclick: () => toggleSelMode() });
  const selBar = el('div', { class: 'bulk-bar', hidden: true });
  card.append(el('div', { class: 'card-head' }, el('h3', { text: '공유 폴더' }),
    el('div', { class: 'card-head-actions' }, searchIn, allBtn, mkdirBtn, uploadBtn, selectBtn, fileInput)));
  card.append(selBar);
  card.append(body);
  // 드래그앤드롭 업로드 — 카드 위로 파일을 끌어다 놓으면 현재 폴더에 올림(여러 개 동시 가능).
  let dragDepth = 0;
  const hasFiles = (ev) => ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files');
  card.addEventListener('dragenter', (ev) => { if (hasFiles(ev)) { ev.preventDefault(); dragDepth++; card.classList.add('drop-active'); } });
  card.addEventListener('dragover', (ev) => { if (hasFiles(ev)) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; } });
  card.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) card.classList.remove('drop-active'); });
  card.addEventListener('drop', (ev) => { ev.preventDefault(); dragDepth = 0; card.classList.remove('drop-active'); if (ev.dataTransfer.files && ev.dataTransfer.files.length) uploadFiles(ev.dataTransfer.files); });
  // 클립보드 이미지 붙여넣기 — 프로젝트 상세에서 (텍스트 입력칸이 아닌 곳에) 붙여넣으면 현재 공유 폴더로 업로드.
  //  card 가 DOM 에서 사라지면(다른 화면 이동) 다음 paste 때 스스로 해제(언마운트 훅이 없어 누수 방지용 self-clean).
  const onPaste = (ev) => {
    if (!document.body.contains(card)) { document.removeEventListener('paste', onPaste); return; }
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return; // 텍스트 편집 중 붙여넣기는 방해 않음
    const items = (ev.clipboardData && ev.clipboardData.items) || [];
    const imgs = [];
    for (const it of items) { if (it.kind === 'file' && String(it.type || '').startsWith('image/')) { const b = it.getAsFile(); if (b) imgs.push(b); } }
    if (!imgs.length) return; // 이미지가 없으면 평소 붙여넣기 동작 유지
    ev.preventDefault();
    const dest = '공유 폴더' + (st.path ? ' / ' + st.path : '');
    openPasteDialog(imgs, dest, (files) => uploadFiles(files));
  };
  document.addEventListener('paste', onPaste);
  load();
  return card;

  // 선택 모드 토글 — 켜면 카드가 체크박스로, 끄면 선택 해제 + 헤드 버튼 라벨 전환.
  function toggleSelMode(on) {
    sel.mode = on != null ? on : !sel.mode;
    if (!sel.mode) sel.ids.clear();
    selectBtn.classList.toggle('active', sel.mode);
    selectBtn.textContent = sel.mode ? '선택 취소' : '선택';
    paintSelBar();
    if (lastData) render(lastData);
  }
  function paintSelBar() {
    if (!sel.mode) { selBar.hidden = true; selBar.replaceChildren(); return; }
    const n = sel.ids.size, total = lastPairs.length;
    const allOn = total > 0 && n >= total;
    const allBtn2 = el('button', { class: 'btn btn-ghost btn-sm', text: allOn ? '전체 해제' : '전체 선택',
      onclick: () => { if (allOn) sel.ids.clear(); else lastPairs.forEach((p) => sel.ids.add(p.rel)); paintSelBar(); if (lastData) render(lastData); } });
    const delB = el('button', { class: 'btn btn-sm btn-danger', text: '선택 삭제', disabled: n === 0, onclick: () => bulkDeleteSel() });
    selBar.hidden = false;
    selBar.replaceChildren(
      el('span', { class: 'bulk-bar-count', text: n ? n + '개 선택됨' : '삭제할 항목을 고르세요' }),
      el('div', { class: 'bulk-bar-actions' }, allBtn2, delB));
  }
  async function bulkDeleteSel() {
    const rels = [...sel.ids];
    if (!rels.length) return;
    if (!confirm(rels.length + '개 항목을 삭제할까요?\n\n폴더는 안의 내용까지 함께 삭제됩니다(되돌릴 수 없음).')) return;
    // 병렬 삭제 — 일부 실패해도 나머지 진행(성공/실패 집계).
    const results = await Promise.allSettled(rels.map((rel) =>
      api(B + id + '/file?path=' + encodeURIComponent(rel), { method: 'DELETE' })));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const fail = results.length - ok;
    toast(fail ? (ok + '개 삭제 · ' + fail + '개 실패') : (ok + '개 삭제했습니다'), fail > 0);
    toggleSelMode(false);
    load();
  }

  // 여러 파일 업로드 — 그리드에 '업로드 중 카드'(비활성 아이콘 + 실시간 %) 띄우고 순차 전송.
  async function uploadFiles(files) {
    const arr = Array.from(files || []);
    if (!arr.length) return;
    const items = arr.map((f) => ({ name: f.name, pct: 0 }));
    uploading.push(...items);
    if (lastData) render(lastData); // 업로드 카드 즉시 표시(load 기다리지 않음)
    let ok = 0, fail = 0;
    for (let i = 0; i < arr.length; i++) {
      const f = arr[i], u = items[i];
      const target = (st.path ? st.path + '/' : '') + f.name;
      try {
        await authUploadProgress(B + id + '/file?path=' + encodeURIComponent(target), f,
          (pct) => { u.pct = pct; updateUpCard(u); });
        u.pct = 100; updateUpCard(u); ok += 1;
      } catch (e) { fail += 1; toast(f.name + ' 실패 — ' + e.message, true); }
    }
    uploading.length = 0;
    if (ok) toast(ok + '개 업로드 완료' + (fail ? (' · ' + fail + '개 실패') : ''));
    st.q = ''; searchIn.value = '';
    load();
  }
  function uploadingCard(u) {
    const pctEl = el('div', { class: 'proj-up-pct', text: Math.round(u.pct) + '%' });
    const fill = el('div', { class: 'proj-up-bar-fill', style: 'width:' + u.pct + '%' });
    u.pctEl = pctEl; u.fill = fill;
    return el('div', { class: 'proj-file-card uploading', title: u.name },
      el('div', { class: 'proj-up-icwrap' },
        el('div', { class: 'proj-file-card-ic', text: iconFor(u.name) }),
        el('div', { class: 'proj-up-overlay' }, pctEl)),
      el('div', { class: 'proj-file-card-nm', text: u.name }),
      el('div', { class: 'proj-up-bar' }, fill));
  }
  function updateUpCard(u) {
    if (u.pctEl) u.pctEl.textContent = Math.round(u.pct) + '%';
    if (u.fill) u.fill.style.width = u.pct + '%';
  }
  // 현재 폴더 안에 하위 폴더 생성.
  function openMkdir() {
    const nameIn = el('input', { type: 'text', placeholder: '폴더 이름', maxlength: '80' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: '만들기' });
    const back = overlayBox('새 폴더',
      el('p', { class: 'admin-hint', text: (st.path ? '“' + st.path + '” 안에' : '루트에') + ' 새 폴더를 만듭니다.' }),
      el('div', { class: 'field' }, el('label', { class: 'field-label', text: '폴더 이름' }), nameIn),
      el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
    setTimeout(() => nameIn.focus(), 0);
    const go = async () => {
      const nm = nameIn.value.trim();
      if (!nm) { nameIn.focus(); toast('폴더 이름을 입력하세요', true); return; }
      const target = (st.path ? st.path + '/' : '') + nm;
      saveBtn.disabled = true;
      try { await api(B + id + '/folder?path=' + encodeURIComponent(target), { method: 'POST' }); back.remove(); toast('폴더를 만들었습니다'); st.q = ''; searchIn.value = ''; load(); }
      catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
    };
    saveBtn.onclick = go;
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }

  async function load() {
    body.replaceChildren(skeletonRows(3));
    try {
      const qs = st.q ? ('?q=' + encodeURIComponent(st.q)) : ('?path=' + encodeURIComponent(st.path));
      render(await api(B + id + '/files' + qs));
    } catch (e) { body.replaceChildren(errorNote(e, '폴더를 불러오지 못했습니다')); }
  }
  function render(data) {
    lastData = data;
    const frag = [];
    let pairs; // { it, rel }
    if (data.search !== undefined) {
      frag.push(el('div', { class: 'proj-file-crumb', text: '“' + data.search + '” 검색 — ' + data.items.length + '건' }));
      pairs = data.items.map((it) => ({ it, rel: it.path }));
      if (!data.items.length) frag.push(el('div', { class: 'empty', text: '일치하는 파일이 없습니다.' }));
    } else {
      const crumb = el('div', { class: 'proj-file-crumb' },
        el('span', { class: 'proj-crumb-link', text: '⌂ 루트', onclick: () => { st.path = ''; load(); } }));
      if (data.path) crumb.append(el('span', { text: ' / ' + data.path }));
      frag.push(crumb);
      pairs = data.items.map((it) => ({ it, rel: join(st.path, it.name) }));
      if (!data.items.length && !data.path) frag.push(el('div', { class: 'empty', text: '빈 폴더입니다. ‘＋ 업로드’로 파일을 올려 보세요.' }));
    }
    const cards = [];
    for (const u of uploading) cards.push(uploadingCard(u)); // 업로드 중 카드 먼저(비활성 + 실시간 %)
    lastPairs = pairs;
    const enterDir = (t) => { sel.ids.clear(); st.q = ''; searchIn.value = ''; st.path = t; load(); };
    if (data.search === undefined && data.path) cards.push(projUpCardEl(() => enterDir(data.parent || '')));
    const selCtl = sel.mode ? { ids: sel.ids, onToggle: paintSelBar } : null;
    for (const { it, rel } of pairs) cards.push(projFileCardEl(id, it, rel, enterDir, load, B, selCtl));
    if (cards.length) frag.push(el('div', { class: 'proj-file-grid' }, ...cards));
    body.replaceChildren(...frag);
    if (sel.mode) paintSelBar();
  }
  function join(a, b) { return a ? a + '/' + b : b; }
}

// 이니셜 아바타 — 이름 첫 글자(한글 1자 / 영문 1~2자). 이름 기반 파스텔 배경.
function initials(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  if (/[가-힣]/.test(s[0])) return s.slice(0, 1);
  const parts = s.split(/\s+/);
  if (parts.length >= 2 && parts[1][0]) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}
function avatarColor(seed) {
  const s = String(seed || ''); let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return 'hsl(' + h + ', 50%, 60%)';
}

// ── 상세 ② 터미널 세션 — 팀원 프로필(아바타) 그리드 → 클릭 시 그 사람 세션 펼침(페이지 내). 본인은 상태메시지 공유. ──
function projectTerminalSection(id, members, meId, base) {
  const B = base || '/api/ui/projects/';
  const card = el('div', { class: 'card proj-term-card', style: 'margin-bottom:18px' });
  const body = el('div', {});
  const newBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 새 세션', onclick: () => openProjectSessionForm(id, load, B) });
  card.append(el('div', { class: 'card-head' }, el('h3', { text: '터미널 세션' }), el('div', { class: 'card-head-actions' }, newBtn)));
  card.append(body);
  let sessions = [];
  let selected = null;
  let dragId = null;
  const ppl = () => (members && members.length ? members : []);
  const ownerName = (oid) => { const m = ppl().find((x) => x.member_id === oid); return (m && m.display_name) || oid; };
  load();
  return card;

  async function load() {
    body.replaceChildren(skeletonRows(2));
    try { sessions = await api(B + id + '/sessions').then((d) => (d && d.sessions) || []); }
    catch (e) { body.replaceChildren(errorNote(e, '세션을 불러오지 못했습니다')); return; }
    render();
  }
  function render() {
    if (!ppl().length) { body.replaceChildren(el('div', { class: 'empty', text: '팀원이 없습니다. 위 ‘팀원 수정’으로 추가하면 여기에 프로필이 생깁니다.' })); return; }
    const grid = el('div', { class: 'proj-people-grid' }, ...ppl().map(personCircle));
    const panel = el('div', { class: 'proj-people-panel' });
    if (selected) renderPanel(panel);
    body.replaceChildren(grid, panel);
  }
  function personCircle(m) {
    const isMe = m.member_id === meId;
    const cnt = sessions.filter((s) => s.owner === m.member_id).length;
    const avatar = el('div', { class: 'proj-avatar', style: 'background:' + avatarColor(m.member_id) },
      el('span', { text: initials(m.display_name || m.member_id) }));
    if (cnt) avatar.append(el('span', { class: 'proj-avatar-badge', text: String(cnt) }));
    const hasStatus = !!m.status_message;
    const status = el('div', { class: 'proj-person-status' + (isMe ? ' me' : '') + (hasStatus ? ' filled' : ' empty'),
      text: hasStatus ? m.status_message : (isMe ? '✎ 상태 남기기' : '') });
    if (isMe && hasStatus) status.append(el('span', { class: 'proj-status-pen', text: ' ✎' }));
    if (isMe) { status.title = '클릭해서 상태 메시지 수정'; status.onclick = (ev) => { ev.stopPropagation(); editStatus(m); }; }
    const wrap = el('div', { class: 'proj-person' + (selected === m.member_id ? ' active' : '') },
      avatar, el('div', { class: 'proj-person-name', text: m.display_name || m.member_id }), status);
    wrap.onclick = () => { selected = (selected === m.member_id ? null : m.member_id); render(); };
    // 드래그앤드롭으로 진열 순서 조절(짧게 누르면 선택, 끌면 재배치).
    wrap.draggable = true;
    wrap.addEventListener('dragstart', (ev) => { dragId = m.member_id; wrap.classList.add('dragging'); ev.dataTransfer.effectAllowed = 'move'; try { ev.dataTransfer.setData('text/plain', m.member_id); } catch (_) { /* */ } });
    wrap.addEventListener('dragend', () => { dragId = null; wrap.classList.remove('dragging'); });
    wrap.addEventListener('dragover', (ev) => { if (dragId && dragId !== m.member_id) { ev.preventDefault(); wrap.classList.add('drop-target'); } });
    wrap.addEventListener('dragleave', () => wrap.classList.remove('drop-target'));
    wrap.addEventListener('drop', (ev) => { ev.preventDefault(); wrap.classList.remove('drop-target'); if (dragId && dragId !== m.member_id) reorder(dragId, m.member_id); });
    return wrap;
  }
  function reorder(fromId, toId) {
    const list = ppl();
    const fromIdx = list.findIndex((x) => x.member_id === fromId);
    const toIdx = list.findIndex((x) => x.member_id === toId);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
    const [moved] = list.splice(fromIdx, 1);
    list.splice(toIdx, 0, moved);
    render();
    api(B + id + '/members', { method: 'POST', body: JSON.stringify({ members: list.map((x) => x.member_id) }) })
      .then(() => toast('순서를 저장했습니다'))
      .catch((e) => toast('순서 저장 실패 — ' + e.message, true));
  }
  function renderPanel(panel) {
    const m = ppl().find((x) => x.member_id === selected);
    const mine = sessions.filter((s) => s.owner === selected);
    const head = el('div', { class: 'proj-panel-head' },
      el('b', { text: (m && m.display_name) || selected }), ' 의 세션 ',
      el('span', { class: 'proj-panel-cnt', text: String(mine.length) }));
    // ＋ 새 세션 버튼은 카드 헤더 우상단에 항상 있으므로 패널에선 중복 제거(같은 동작).
    panel.append(head);
    if (!mine.length) { panel.append(el('div', { class: 'empty', text: selected === meId ? '아직 만든 세션이 없어요. ‘＋ 새 세션’으로 시작하세요.' : '아직 만든 세션이 없습니다.' })); return; }
    panel.append(el('div', { class: 'proj-sess-list' }, ...mine.map(sessRow)));
  }
  function sessRow(s) {
    const acts = [];
    if (s.owned) acts.push(
      el('button', { class: 'btn btn-ghost btn-sm', text: '이름변경', onclick: () => openSessionRename(s, load) }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '삭제', onclick: () => removeSession(s, load) }));
    acts.push(el('button', { class: 'btn btn-primary btn-sm', text: '입장', onclick: () => window.open('/ui/terminal.html?session=' + encodeURIComponent(s.id) + '&label=' + encodeURIComponent(s.label || ''), '_blank') }));
    return el('div', { class: 'proj-sess-row' },
      el('div', { class: 'proj-sess-main' },
        el('div', { class: 'proj-sess-name' }, (s.label || s.id),
          s.attached ? el('span', { class: 'proj-sess-live', text: '● 사용 중' }) : null),
        el('div', { class: 'proj-sess-meta', text: (s.harness || 'shell') + ' · 만든이 ' + ownerName(s.owner) })),
      el('div', { class: 'proj-sess-acts' }, ...acts));
  }
  function editStatus(m) {
    const input = el('input', { type: 'text', value: m.status_message || '', placeholder: '현재 상태 (예: 결제 모듈 작업 중)', maxlength: '200' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
    const back = overlayBox('내 상태 메시지',
      el('p', { class: 'admin-hint', text: '프로필 밑에 보이는 ‘현재 상태’예요 — 팀원에게 지금 무엇을 하는지 공유됩니다.' }),
      el('div', { class: 'field' }, input),
      el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
    setTimeout(() => input.focus(), 0);
    const go = async () => {
      saveBtn.disabled = true;
      try {
        const r = await api('/api/ui/me/status', { method: 'POST', body: JSON.stringify({ message: input.value.trim() }) });
        m.status_message = r.status_message;
        back.remove(); toast('상태를 저장했습니다'); render();
      } catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
    };
    saveBtn.onclick = go;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }
}

// 새 프로젝트 세션 오버레이 — 터미널 탭과 같은 정보(실행기·모델 등 플래그·자동승인). 폴더는 프로젝트 폴더 고정,
//  공개범위는 '팀원 공동'(별도 입력 없음). 생성 후 새 탭 입장.
async function openProjectSessionForm(id, reload, base) {
  const B = base || '/api/ui/projects/';
  let cfg;
  try { cfg = await api('/api/ui/terminal/config'); }
  catch (e) { toast('세션 설정을 불러오지 못했습니다 — ' + e.message, true); return; }
  const harnesses = cfg.harnesses || [];
  const nameIn = el('input', { type: 'text', placeholder: '세션 이름 (예: 개발, 빌드)', maxlength: '80' });
  const harnessSel = el('select', {}, ...harnesses.map((h) => el('option', { value: h.key, text: h.label })));
  const flagsBox = el('div', {});
  const autoCb = el('input', { type: 'checkbox' });
  const autoRow = el('label', { class: 'proj-sess-auto' }, autoCb, el('span', { text: ' 자동 승인 — 매번 권한 확인 없이 실행' }));
  function renderFlags() {
    const h = harnesses.find((x) => x.key === harnessSel.value) || {};
    flagsBox.replaceChildren();
    for (const f of (h.flags || [])) {
      let ctrl;
      if (f.type === 'select') ctrl = el('select', { 'data-flag': f.name }, ...(f.choices || []).map((c) => el('option', { value: c, text: c || '(기본)' })));
      else if (f.type === 'bool') ctrl = el('input', { type: 'checkbox', 'data-flag': f.name });
      else ctrl = el('input', { type: 'text', 'data-flag': f.name });
      flagsBox.append(el('div', { class: 'field', style: 'margin-top:12px' },
        el('label', { class: 'field-label', text: f.label }), ctrl, f.desc ? el('div', { class: 'caption', text: f.desc }) : null));
    }
    autoRow.style.display = h.hasAutoApprove ? '' : 'none';
  }
  harnessSel.addEventListener('change', renderFlags);
  renderFlags();
  const saveBtn = el('button', { class: 'btn btn-primary', text: '만들고 입장' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  const back = overlayBox('새 터미널 세션',
    el('p', { class: 'admin-hint', text: '이 프로젝트 폴더에서 시작하는 공동 세션입니다 — 프로젝트 팀원만 보고 입장할 수 있어요.' }),
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '실행' }), harnessSel),
    flagsBox,
    el('div', { style: 'margin-top:10px' }, autoRow),
    el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
  setTimeout(() => nameIn.focus(), 0);
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    const flags = {};
    for (const ctrl of flagsBox.querySelectorAll('[data-flag]')) {
      const k = ctrl.getAttribute('data-flag');
      const v = ctrl.type === 'checkbox' ? (ctrl.checked ? 'true' : '') : ctrl.value;
      if (v) flags[k] = v;
    }
    try {
      const r = await api(B + id + '/sessions', { method: 'POST', body: JSON.stringify({
        label: nameIn.value.trim(), harness: harnessSel.value, flags, autoApprove: autoCb.checked,
      }) });
      back.remove();
      toast('세션을 만들었습니다');
      if (r && r.session && r.session.id) window.open('/ui/terminal.html?session=' + encodeURIComponent(r.session.id) + '&label=' + encodeURIComponent(r.session.label || ''), '_blank');
      reload();
    } catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
}

// 세션 이름 변경 오버레이 — 기존 터미널 세션 API 재사용(소유자만, 서버가 강제).
function openSessionRename(s, reload) {
  const nameIn = el('input', { type: 'text', value: s.label || '', placeholder: '세션 이름', maxlength: '80' });
  const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  const back = overlayBox('세션 이름 변경',
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn),
    el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
  setTimeout(() => nameIn.focus(), 0);
  const go = async () => {
    const label = nameIn.value.trim();
    if (!label) { nameIn.focus(); toast('이름을 입력하세요', true); return; }
    saveBtn.disabled = true;
    try {
      await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id), { method: 'POST', body: JSON.stringify({ label }) });
      back.remove(); toast('이름을 변경했습니다'); reload();
    } catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
  saveBtn.onclick = go;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}
// 세션 삭제 — 확인 후 tmux 세션 종료(소유자만). 실행 중 작업도 종료됨.
async function removeSession(s, reload) {
  if (!confirm('세션 ‘' + (s.label || s.id) + '’을(를) 삭제할까요?\n\n실행 중인 작업이 함께 종료됩니다(되돌릴 수 없음).')) return;
  try {
    await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id), { method: 'DELETE' });
    toast('세션을 삭제했습니다'); reload();
  } catch (e) { toast('실패 — ' + e.message, true); }
}

// ── 상세 ③ 작업 타임라인 — 팀원 activity + 사람별 필터(전체/팀원 칩). ──
function projectTimelineSection(id, members, base) {
  const B = base || '/api/ui/projects/';
  const card = el('div', { class: 'card', style: 'margin-bottom:18px' });
  const body = el('div', {});
  const st = { person: '' };
  const nameOf = (pid) => { const m = (members || []).find((x) => x.member_id === pid); return (m && m.display_name) || pid || '—'; };
  const chipsBar = el('div', { class: 'proj-tl-filter' });
  function paintChips() {
    const mk = (label, person) => el('button',
      { class: 'proj-tl-chip' + (st.person === person ? ' active' : ''), text: label,
        onclick: () => { st.person = person; paintChips(); load(); } });
    chipsBar.replaceChildren(mk('전체', ''), ...(members || []).map((m) => mk(m.display_name || m.member_id, m.member_id)));
  }
  paintChips();
  card.append(
    el('div', { class: 'card-head' }, el('h3', { text: '작업 타임라인' })),
    el('p', { class: 'proj-tl-note' },
      el('span', { class: 'proj-tl-note-ic', text: 'ⓘ' }),
      el('span', {}, '여기엔 ', el('b', { text: 'AI와 함께 남긴 작업' }),
        '이 자동으로 모여요 (AI 밖에서 진행한 모든 작업은 빠질 수 있어요). ',
        el('b', { text: '확실하게 진행이 된 일을 위주로' }),
        ' 회사 업무 진행의 큰 맥락을 확인하는 용도로 사용해주세요.')),
    chipsBar, body);
  load();
  return card;

  async function load() {
    body.replaceChildren(skeletonRows(3));
    try {
      const qs = st.person ? ('?author_person=' + encodeURIComponent(st.person)) : '';
      const acts = await api(B + id + '/activity' + qs).then((d) => (d && d.activities) || []);
      if (!acts.length) { body.replaceChildren(el('div', { class: 'empty', text: st.person ? '이 팀원의 작업 기록이 없습니다.' : '아직 이 프로젝트 팀원의 작업 기록이 없습니다.' })); return; }
      renderActs(acts);
    } catch (e) { body.replaceChildren(errorNote(e, '타임라인을 불러오지 못했습니다')); }
  }
  // 5개까지 보이고 나머지는 '더 보기'로 펼침(끝없이 길어지지 않게).
  function renderActs(acts) {
    const LIMIT = 5;
    const list = el('div', { class: 'proj-tl-list' });
    for (const a of acts.slice(0, LIMIT)) list.append(actRow(a));
    body.replaceChildren(list);
    if (acts.length > LIMIT) {
      const rest = acts.slice(LIMIT);
      const moreBtn = el('button', { class: 'btn btn-ghost btn-sm proj-tl-more', text: '＋ ' + rest.length + '개 더 보기' });
      moreBtn.onclick = () => { for (const a of rest) list.append(actRow(a)); moreBtn.remove(); };
      body.append(moreBtn);
    }
  }
  function actRow(a) { return activityTimelineRow(a, nameOf); }
}

// 팀원 수정 오버레이 — 현재 팀원 미리 체크된 멀티선택 → 통째 교체 저장.
function openMembersEdit(projectId, current, reload, base) {
  const B = base || '/api/ui/projects/';
  const picker = memberPicker(current || []);
  const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  const back = overlayBox('팀원 수정',
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '함께하는 팀원' }), picker.box),
    el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      await api(B + projectId + '/members', { method: 'POST', body: JSON.stringify({ members: picker.getSelected() }) });
      back.remove();
      toast('팀원을 저장했습니다');
      reload();
    } catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
}

// 작업 현황 #/dash — PM/PO 가 "전 구성원이 무엇을 했고 지금 무엇을 하는지" 파악하는 화면.
//  세 층: ① 구성원 요약(사람별 AI·작업수·마지막활동 + 최근 작업 제목 한 줄) ② 필터(구성원·유형 칩)
//  ③ 작업 타임라인(실제 작업 — 펼치면 본문·연결 과업·산출/참조 지식·바뀐 것). 클릭=펼침이 핵심(드릴인).
//  요약 집계는 GET /api/ui/dash/people, 타임라인은 GET /api/ui/activity/list(연결 곁들임). 고유명 하드코딩 없음.
// ════════════════════════════════════════════
// 유형별 점 색(스캔용 — §0.5: 채운 필 금지, 6px 점 + 무채 라벨). commit=민트, decision=파랑, review=코랄, 나머지=중립.
const ACT_TYPE_TONE = { commit: 'mint', decision: 'blue', review: 'coral', comment: 'muted', status_change: 'teal' };
function actTypeTag(type) {
  return el('span', { class: 'act-type tone-' + (ACT_TYPE_TONE[type] || 'muted') },
    el('span', { class: 'act-type-dot', 'aria-hidden': 'true' }),
    ACTIVITY_TYPE_LABEL[type] || type);
}

// 작업(activity) 한 줄 — 회사 전체 타임라인(#/projects2)·작업 현황(#/dash) 공용.
//  접힘: 캐럿 + 유형칩 + 요약(굵게) / 사람·AI·상대시간(+ 구조·의도 변경 태그).
//  펼침(클릭): 기술 제목·메모 + 연결 과업(W) + 산출/참조/결정 지식 + 변경(커밋·should/is 점검) + 정확 시각.
//  펼침 데이터는 activity/list 가 곁들여 주는 a.body/a.tasks/a.refs/a.commit_sha/a.touchCount/a.*_review 를 그대로 쓴다.
function activityTimelineRow(a, nameOf) {
  const when = a.committed_at || a.created_at;
  const techTitle = a.title && a.title !== (a.summary || '') ? a.title : '';
  const hasDetail = !!(techTitle || a.body || (a.tasks && a.tasks.length) || (a.refs && a.refs.length)
    || a.commit_sha || a.touchCount || a.external_url
    || (a.is_review && a.is_review !== 'na') || (a.should_review && a.should_review !== 'na'));

  const caret = el('span', { class: 'act-row-caret' + (hasDetail ? '' : ' act-row-caret-empty'), 'aria-hidden': 'true', text: hasDetail ? '▸' : '' });

  // 변경 태그 — 이번 작업이 코드구조(is)/도메인 의도(should)를 바꾼 경우만 작게 표기.
  const tags = [];
  if (a.is_review === 'changed') tags.push(el('span', { class: 'act-row-tag', text: '구조 변경' }));
  if (a.should_review === 'changed') tags.push(el('span', { class: 'act-row-tag', text: '의도 변경' }));

  const head = el('div', { class: 'act-row-head',
    role: hasDetail ? 'button' : null, tabindex: hasDetail ? '0' : null, 'aria-expanded': hasDetail ? 'false' : null },
    caret,
    actTypeTag(a.type),
    el('div', { class: 'act-row-body' },
      el('div', { class: 'act-row-title', text: a.summary || a.title || '(제목 없음)' }),
      el('div', { class: 'act-row-meta' },
        el('span', { class: 'act-row-who', text: nameOf(a.author_person) }),
        a.author_agent ? el('span', { class: 'act-row-agent', text: ' · ' + a.author_agent }) : null,
        el('span', { class: 'act-row-time', text: ' · ' + relTime(when) }),
        ...tags)));

  const row = el('div', { class: 'act-row' + (hasDetail ? ' act-row-expandable' : '') }, head);
  if (!hasDetail) return row;

  const detail = el('div', { class: 'act-row-detail', hidden: true });
  if (techTitle) detail.append(el('div', { class: 'act-row-tech', text: techTitle }));
  if (a.body) detail.append(el('div', { class: 'act-row-note', text: a.body }));

  const linkList = (items) => el('span', { class: 'act-row-links' }, ...items.map((it) =>
    el('a', { class: 'act-row-link', href: '#/k/' + encodeURIComponent(it.name), text: it.title || it.name })));
  // v6: 과업 = 진척시킨 프로젝트(task) — #/projects2/p/:id 로 링크(지식 refs 는 #/k/:name 유지).
  if (a.tasks && a.tasks.length) {
    detail.append(el('div', { class: 'act-row-sec' },
      el('span', { class: 'act-row-sec-label', text: '과업' }),
      el('span', { class: 'act-row-links' }, ...a.tasks.map((t) =>
        el('a', { class: 'act-row-link', href: '#/projects2/p/' + t.id, text: t.title || ('#' + t.id) })))));
  }
  if (a.refs && a.refs.length) {
    const byRel = {};
    for (const rf of a.refs) (byRel[rf.relation] = byRel[rf.relation] || []).push(rf);
    for (const rel of ['produced', 'references', 'decided']) {
      if (!byRel[rel]) continue;
      detail.append(el('div', { class: 'act-row-sec' },
        el('span', { class: 'act-row-sec-label', text: REF_REL_LABEL[rel] || rel }), linkList(byRel[rel])));
    }
  }
  // 변경 — 커밋 좌표(sha·repo·코드 N곳) + should/is 점검 결과(변화 없음/변경됨까지 명시).
  const chg = [];
  if (a.commit_sha) chg.push(a.commit_sha.slice(0, 7) + (a.repo ? ' · ' + a.repo : '') + (a.touchCount ? ' · 코드 ' + a.touchCount + '곳' : ''));
  if (a.is_review && a.is_review !== 'na') chg.push('코드구조 ' + (REVIEW_LABEL[a.is_review] || a.is_review));
  if (a.should_review && a.should_review !== 'na') chg.push('도메인 의도 ' + (REVIEW_LABEL[a.should_review] || a.should_review));
  if (chg.length || a.external_url) {
    const sec = el('div', { class: 'act-row-sec' }, el('span', { class: 'act-row-sec-label', text: '변경' }));
    if (chg.length) sec.append(el('span', { class: 'act-row-chg', text: chg.join('  ·  ') }));
    if (a.external_url) sec.append(el('a', { class: 'act-row-link', href: a.external_url, target: '_blank', rel: 'noopener', text: '↗ 원본' }));
    detail.append(sec);
  }
  detail.append(el('div', { class: 'act-row-exact', text: fmtDateTime(when) }));

  let open = false;
  const toggle = () => {
    open = !open; detail.hidden = !open; row.classList.toggle('open', open);
    caret.textContent = open ? '▾' : '▸';
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
  row.append(detail);
  return row;
}

async function renderDashboard(view, params) {
  if (!state.dash) state.dash = { expanded: new Set(), filter: { person: '', agent: '', type: '' } };
  // 딥링크(#/dash?person=..&type=..)면 그 필터로 시작. 그 외 일반 진입은 필터 초기화 — 디폴트로 아무도 선택 안 됨
  //  (모듈 state 가 재방문 간 유지되어 이전 클릭이 '눌린 채' 남던 것 방지).
  if (params && (params.get('person') || params.get('type') || params.get('agent'))) {
    state.dash.filter = { person: params.get('person') || '', agent: params.get('agent') || '', type: params.get('type') || '' };
  } else {
    state.dash.filter = { person: '', agent: '', type: '' };
  }
  const f = state.dash.filter;

  view.replaceChildren(skeleton('작업 현황을 불러오는 중'));
  const head = el('div', { class: 'page-head' },
    el('h1', {}, '작업 ', el('span', { class: 'accent', text: '현황' })),
    el('p', { class: 'sub', text: '구성원이 어떤 작업을 했고 지금 무엇을 하고 있는지 한눈에. 작업을 누르면 — 무엇을 했고 어떤 과업·지식과 연결됐는지 — 상세가 펼쳐집니다.' }),
  );

  let people = [];
  let feed = [];
  try {
    const [pp, ff] = await Promise.all([
      api('/api/ui/dash/people').then((d) => (d && d.people) || []),
      api('/api/ui/activity/list?limit=200').then((d) => (Array.isArray(d) ? d : (d && d.rows) || [])),
    ]);
    people = pp; feed = ff;
  } catch (e) {
    view.replaceChildren(head, errorNote(e, '작업 현황을 불러오지 못했습니다'));
    return;
  }

  if (!feed.length && !people.length) {
    view.replaceChildren(head, el('div', { class: 'empty', text: '아직 기록된 작업이 없습니다. AI가 작업(activity)을 남기면 여기 구성원·AI별로 쌓입니다.' }));
    return;
  }

  // 사람별 '가장 최근 작업'(피드는 최신순 → 사람별 첫 등장이 최신). 요약 한 줄 + 마지막 활동 시각 보강.
  const latestByPerson = new Map();
  for (const a of feed) { const k = a.author_person || ''; if (!latestByPerson.has(k)) latestByPerson.set(k, a); }
  // 작성자 표시명(명부) — 피드 카드도 id 대신 표시명으로(요약·칩과 일관). people 에 display_name 동봉.
  const displayName = (pid) => { if (!pid) return ''; const m = people.find((p) => p.author_person === pid); return (m && m.display_name) || pid; };
  // 내 목록(people) 사람 id 집합 — 타임라인도 '내 사람들'로 스코프(구성원 섹션과 일관).
  const myIds = new Set(people.map((p) => p.author_person).filter(Boolean));

  // ── 필터 갱신: state 만 바꾸고 in-place 재도색(요약 active·칩 active·피드). 해시 라우팅 왕복 없음. ──
  const setFilter = (patch) => { Object.assign(f, patch); paint(); };

  // ── 층 ② 필터 바(구성원 + 유형) ──
  const filterBar = el('div', { class: 'dash-filters' });
  function chip(label, on, onClick, extraCls) {
    return el('button', { class: 'dash-chip' + (on ? ' active' : '') + (extraCls ? ' ' + extraCls : ''), type: 'button', onclick: onClick }, label);
  }
  function paintFilters() {
    const personChips = el('div', { class: 'dash-chip-group' },
      el('span', { class: 'dash-chip-label', text: '구성원' }),
      chip('전체', !f.person, () => setFilter({ person: '', agent: '' })),
      ...people.filter((p) => p.author_person).map((p) =>
        chip(p.display_name || p.author_person, f.person === p.author_person, () => setFilter({ person: f.person === p.author_person ? '' : p.author_person, agent: '' }))),
    );
    const typeChips = el('div', { class: 'dash-chip-group' },
      el('span', { class: 'dash-chip-label', text: '유형' }),
      chip('전체', !f.type, () => setFilter({ type: '' })),
      ...ACTIVITY_TYPE_ORDER.filter((t) => feed.some((a) => a.type === t)).map((t) =>
        chip(ACTIVITY_TYPE_LABEL[t], f.type === t, () => setFilter({ type: f.type === t ? '' : t }))),
    );
    filterBar.replaceChildren(personChips, typeChips);
  }

  // ── 층 ① 구성원 요약 ──
  const summaryBox = el('div', { class: 'list-box dash-summary' });
  function summaryRow(p) {
    const key = p.author_person || '';
    const name = p.display_name || p.author_person;
    const selectable = !!p.author_person;
    const on = selectable && f.person === key;
    const totalTasks = (p.agents || []).reduce((s, a) => s + (a.tasks || 0), 0);
    const last = (p.agents || []).reduce((mx, a) => (a.lastActiveAt && (!mx || a.lastActiveAt > mx) ? a.lastActiveAt : mx), null);
    const aiChips = (p.agents || []).map((a) => el('span', { class: 'dash-ai' },
      el('span', { class: 'dash-ai-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'dash-ai-name', text: a.author_agent || '직접' }),
      el('span', { class: 'dash-ai-n', text: fmtNum(a.count) })));
    const latest = latestByPerson.get(key);
    const row = el('div', { class: 'dash-person' + (on ? ' active' : '') + (selectable ? '' : ' static'),
      role: selectable ? 'button' : null, tabindex: selectable ? '0' : null,
      'aria-pressed': selectable ? (on ? 'true' : 'false') : null },
      el('div', { class: 'dash-person-top' },
        el('span', { class: 'dash-person-name', text: name || '미상' }),
        el('span', { class: 'dash-person-meta' },
          el('strong', { text: fmtNum(p.total) }), ' 작업 · ', fmtNum(totalTasks) + ' 과업 · ',
          last ? relTime(last) : '활동 없음'),
      ),
      aiChips.length ? el('div', { class: 'dash-ai-row' }, ...aiChips) : null,
      latest ? el('div', { class: 'dash-latest' },
        el('span', { class: 'dash-latest-label', text: '최근' }), actTypeTag(latest.type),
        el('span', { class: 'dash-latest-title', text: latest.summary || latest.title })) : null,
    );
    if (selectable) {
      const go = () => setFilter({ person: on ? '' : key, agent: '' });
      row.addEventListener('click', go);
      row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
    }
    return row;
  }

  // ── 층 ③ 작업 타임라인(펼침형) ──
  const feedBox = el('div', { class: 'list-box dash-feed' });
  function activityDetail(a, when) {
    const box = el('div', { class: 'act-detail' });
    // 겉(접힘)엔 쉬운 summary 를 보였으니, 펼치면 AI가 기록한 기술 상세 제목을 먼저 드러낸다(summary 와 다를 때만).
    if (a.summary && a.title && a.summary !== a.title) {
      box.append(el('div', { class: 'act-techtitle' },
        el('span', { class: 'act-techtitle-label', text: '상세 제목' }),
        el('span', { class: 'act-techtitle-text', text: a.title })));
    }
    if (a.body) box.append(renderMarkdown(a.body));
    if ((a.tasks || []).length) {
      box.append(el('div', { class: 'act-group' },
        el('div', { class: 'act-group-label', text: '연결된 과업' }),
        el('div', { class: 'act-links' }, ...a.tasks.map((t) => el('a', { class: 'act-link', href: '#/u/' + encodeURIComponent(t.name) },
          el('span', { class: 'kb-glyph', text: 'W' }),
          el('span', { class: 'act-link-title', text: t.title || t.name }),
          (t.lifecycle && t.lifecycle !== 'active') ? lifecycleDot(t.lifecycle) : null)))));
    }
    if ((a.refs || []).length) {
      box.append(el('div', { class: 'act-group' },
        el('div', { class: 'act-group-label', text: '산출·참조 지식' }),
        el('div', { class: 'act-links' }, ...a.refs.map((r) => el('a', { class: 'act-link', href: '#/u/' + encodeURIComponent(r.name) },
          el('span', { class: 'act-rel', text: REF_REL_LABEL[r.relation] || r.relation }),
          el('span', { class: 'act-link-title', text: r.title || r.name }))))));
    }
    const facts = [];
    if (a.touchCount) facts.push(['건드린 코드', fmtNum(a.touchCount) + '곳']);
    if (a.commit_sha) facts.push(['커밋', a.commit_sha.slice(0, 10)]);
    facts.push(['도메인 의도(should) 점검', REVIEW_LABEL[a.should_review] || a.should_review || '—']);
    facts.push(['코드 구조(is) 점검', REVIEW_LABEL[a.is_review] || a.is_review || '—']);
    if (a.external_system) facts.push(['외부 출처', a.external_system]);
    if (a.session_id) facts.push(['세션', String(a.session_id).slice(0, 8)]);
    facts.push(['기록 시각', absTime(when) || '—']);
    box.append(el('div', { class: 'act-facts' }, ...facts.map(([k, v]) =>
      el('div', { class: 'act-fact' }, el('span', { class: 'act-fact-k', text: k }), el('span', { class: 'act-fact-v', text: String(v) })))));
    return box;
  }
  function activityCard(a) {
    const open = state.dash.expanded.has(a.id);
    const when = a.committed_at || a.created_at;
    const meta = [
      el('span', { class: 'act-who', text: displayName(a.author_person) || '미상' }),
      el('span', { class: 'act-ai', text: a.author_agent || '직접' }),
      el('span', { text: relTime(when) }),
    ];
    if (a.repo) meta.push(el('span', { class: 'mono', text: a.repo }));
    if ((a.tasks || []).length) meta.push(el('span', { text: fmtNum(a.tasks.length) + ' 과업' }));
    const sigs = [];
    if (a.should_review === 'changed') sigs.push(el('span', { class: 'act-sig sig-should', text: '의도 변경' }));
    if (a.is_review === 'changed') sigs.push(el('span', { class: 'act-sig sig-is', text: '구조 변경' }));
    const headRow = el('div', { class: 'act-head', role: 'button', tabindex: '0', 'aria-expanded': open ? 'true' : 'false' },
      el('span', { class: 'act-caret', 'aria-hidden': 'true', text: open ? '▾' : '▸' }),
      el('div', { class: 'act-head-main' },
        el('div', { class: 'act-titleline' }, actTypeTag(a.type), el('span', { class: 'act-title', text: a.summary || a.title })),
        el('div', { class: 'row-meta act-meta' }, ...interleave(meta, el('span', { class: 'act-sep', 'aria-hidden': 'true', text: '·' })), ...sigs),
      ),
    );
    const toggle = () => { if (open) state.dash.expanded.delete(a.id); else state.dash.expanded.add(a.id); renderFeed(); };
    headRow.addEventListener('click', toggle);
    headRow.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
    const card = el('div', { class: 'act-card' + (open ? ' open' : '') }, headRow);
    if (open) card.append(activityDetail(a, when));
    return card;
  }
  function renderFeed() {
    const filtered = feed.filter((a) =>
      myIds.has(a.author_person)
      && (!f.person || (a.author_person || '') === f.person)
      && (!f.agent || (a.author_agent || '') === f.agent)
      && (!f.type || a.type === f.type));
    if (!filtered.length) {
      feedBox.replaceChildren(el('div', { class: 'empty', text: '내 목록 구성원의 작업이 없습니다. 「목록 편집」으로 사람을 추가하거나 위 필터를 넓혀 보세요.' }));
      return;
    }
    feedBox.replaceChildren(...filtered.map(activityCard));
  }

  function paint() {
    paintFilters();
    summaryBox.replaceChildren(...people.map(summaryRow));
    renderFeed();
  }

  const sec = (title, hint, ...extra) => el('div', { class: 'dash-sec-head' },
    el('h2', { class: 'dash-sec-title', text: title }), hint ? el('span', { class: 'dash-sec-hint', text: hint }) : null, ...extra);

  // ── 내 목록 편집 팝업 — 전체 활성 구성원 검색 + 체크/언체크로 내 목록 구성(나는 항상 표시). ──
  async function openWatchEditor() {
    let allMembers = [], watched = new Set(), me = null;
    try {
      const [mm, ww] = await Promise.all([
        api('/api/ui/dash/members').then((d) => (d && d.members) || []),
        api('/api/ui/dash/watch').then((d) => d || {}),
      ]);
      allMembers = mm; watched = new Set((ww && ww.member_ids) || []); me = (ww && ww.me) || null;
    } catch (e) { alert('구성원 목록을 불러오지 못했습니다: ' + (e.message || e)); return; }

    const search = el('input', { type: 'text', class: 'inp dash-watch-search', placeholder: '이름으로 검색…', 'aria-label': '구성원 검색' });
    const listBox = el('div', { class: 'dash-watch-list' });
    // 행을 한 번만 만들고(체크 상태 보존), 검색은 표시/숨김만 토글한다.
    const rows = allMembers.map((m) => {
      const isMe = me && m.id === me;
      const cb = el('input', { type: 'checkbox', 'data-mid': m.id });
      if (isMe) { cb.checked = true; cb.disabled = true; }
      else if (watched.has(m.id)) cb.checked = true;
      const label = el('label', { class: 'dash-watch-row' }, cb,
        el('span', { class: 'dash-watch-name', text: m.display_name || m.id }),
        isMe ? el('span', { class: 'dash-watch-tag', text: '나 · 항상 표시' }) : null);
      return { m, isMe, cb, label };
    });
    const applySearch = () => {
      const term = search.value.trim().toLowerCase();
      let shown = 0;
      for (const r of rows) {
        const hay = ((r.m.display_name || '') + ' ' + r.m.id).toLowerCase();
        const ok = !term || hay.includes(term);
        r.label.style.display = ok ? '' : 'none';
        if (ok) shown++;
      }
      emptyNote.style.display = shown ? 'none' : '';
    };
    const emptyNote = el('div', { class: 'dash-watch-empty', text: '검색 결과가 없습니다.' });
    search.addEventListener('input', applySearch);
    listBox.replaceChildren(...rows.map((r) => r.label), emptyNote);
    applySearch();

    const saveBtn = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '저장' });
    const back = overlay('내 목록 편집',
      el('p', { class: 'dash-watch-help', text: '작업 현황 「구성원」에 보일 사람만 고르세요 — 나와 관계있는 사람 위주로. 나는 항상 표시됩니다.' }),
      search, listBox,
      el('div', { class: 'dash-watch-actions' }, saveBtn));
    saveBtn.addEventListener('click', async () => {
      const picked = rows.filter((r) => !r.isMe && r.cb.checked).map((r) => r.m.id);
      saveBtn.disabled = true; saveBtn.textContent = '저장 중…';
      try {
        await api('/api/ui/dash/watch', { method: 'POST', body: JSON.stringify({ member_ids: picked }) });
        back.remove();
        renderDashboard(view, params);
      } catch (e) { alert('저장 실패: ' + (e.message || e)); saveBtn.disabled = false; saveBtn.textContent = '저장'; }
    });
  }

  const editBtn = el('button', { class: 'btn btn-ghost btn-sm dash-edit-btn', type: 'button', text: '목록 편집', onclick: openWatchEditor });

  view.replaceChildren(
    head,
    sec('구성원', '내 목록 — 나와 관계있는 사람만. 눌러서 그 사람 작업만 보기', editBtn),
    summaryBox,
    sec('작업 타임라인', '내 목록 사람들의 최근 작업부터 — 작업을 눌러 상세를 펼칩니다'),
    filterBar,
    feedBox,
  );
  paint();
  applyReveal([summaryBox, feedBox]);
  document.getElementById('view').focus?.();
}

// ════════════════════════════════════════════
// 안내(#/learn) — 지식유형/수집 ground-truth(GET /api/ui/learn = kind_registry + data_source) 렌더.
//  비개발자 대상: V4 본질 종류 4종(R·K·H·W) 중심 + 통합 예정 legacy 종류는 graceful 표시 + 데이터소스별 수집방식. 읽기 전용.
//  V4: 종류(kind)·주제(area=space+domain)·출처(provenance)는 별개 축 — 종류는 본질, 주제는 도메인, 출처는 채널 사실.
//  non-stale: 서버가 DB 를 그대로 반환하므로 정의를 DB 에서 고치면 이 화면도 즉시 반영(런북과 동일 데이터).
//  §0.5 절제: 무채색 카드 + 작은 상태 점만, 채운 배지 금지. 자유텍스트는 안전 마크다운 렌더 재사용.
// ════════════════════════════════════════════
async function renderLearn(view) {
  // 가이드 — 비개발자용 '개념·용어'만. 핵심: '여기 담기는 지식 하나가 실제로 뭔지'를 예시로 와닿게.
  //  설치는 별도 [설치] 탭, 어려운 레지스트리(주입모드·수집방식)는 제거. 정적 — API 불필요.
  const head = el('div', { class: 'page-head' },
    el('h1', {}, '사용 ', el('span', { class: 'accent', text: '설명서' })),
    el('p', { class: 'sub', text: '이 도구가 무엇이고, 안에 담기는 ‘지식’ 하나가 실제로 어떤 건지 쉽게 설명합니다. 한 번만 읽어두면 됩니다. (설치는 옆 [설치]에서.)' }),
  );

  // ── A. 이 서비스가 뭔가요(목적) — 비개발자용 한눈 설명 ──
  const whatCard = el('div', { class: 'card guide-what' },
    el('div', { class: 'card-head' }, el('h2', { text: '이 서비스가 뭔가요' })),
    el('p', { class: 'guide-lead', text: '팀이 쓰는 AI(예: Claude Code)가 매번 같은 배경을 다시 설명하지 않아도 되도록, 회사의 공통 맥락·규칙·기억을 한곳에 모아두는 저장소입니다. 여기 정리해두면, 설치한 모든 구성원의 AI가 세션을 시작할 때 이 내용을 자동으로 읽고 일합니다.' }));
  const whatRows = el('div', { class: 'learn-rows guide-what-rows' });
  whatRows.append(
    learnRow('무엇을 담나', '회사 규칙·페르소나, 팀이 쌓은 지식과 절차, 진행 중인 과업, 자주 쓰는 용어 등 — AI가 알고 있어야 할 회사 맥락 전부.'),
    learnRow('어떻게 전달되나', '구성원이 한 번 설치하면, AI 세션이 열릴 때마다 최신 내용이 자동으로 들어갑니다. 사람이 매번 복사·설명할 필요가 없습니다.'),
    learnRow('누가 바꾸나', '관리자는 [관리] 탭에서 규칙·맥락·메모리를 편집·저장하면, 구성원이 다음에 설치/업데이트할 때 자동으로 받습니다. 구성원은 한 번만 설치하면 끝입니다.'),
    learnRow('처음이라면', '바로 시작하려면 [설치 단계](#/install)를 그대로 따라 하세요 — 5분이면 끝납니다. 그다음은 자동입니다.'),
  );
  whatCard.append(whatRows);

  // B. '지식 하나'가 실제로 뭔지 — 예시 카드로 구체화(추상 개념을 눈으로). 그다음 종류 4가지. (정적 — API 불필요)
  const unitCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '여기 담기는 ‘지식’ 하나가 뭔가요' })),
    el('p', { class: 'guide-lead', text: '회사 지식이 한 덩어리씩 쌓입니다. 덩어리 하나는 제목과 내용으로 된 짧은 글이에요 — 메모 한 장, 문서 한 페이지 같은 겁니다. 성격에 따라 네 가지로 나뉘는데, 각각 이런 모습이에요 (이름 옆 알파벳은 시스템이 쓰는 약자):' }));
  // 네 종류(R/K/H/W) 각각 — 비개발자가 한눈에 이해할 쉬운 예시를 하나씩. [글자, 한글이름, 설명, 예시제목, 예시내용]
  const GLOSS = [
    ['R', '규칙', 'AI가 항상 지켜야 할 회사 규칙',
      '추측으로 답하지 않기', '확실한 근거가 없으면 “잘 모르겠다”고 말한다. 그럴듯하게 지어내지 않는다.'],
    ['K', '지식', '자료·결정·조사처럼 쌓인 지식',
      '경쟁사 가격 비교 (2월 조사)', 'A사 월 9,900원, B사 월 14,000원, 우리 월 12,000원 — 우리가 중간 가격대.'],
    ['H', '절차', '“이런 일은 이렇게” 하는 방법',
      '새 팀원이 오면 하는 일', '① 슬랙·노션에 초대한다 → ② 필요한 권한을 준다 → ③ 환영 점심을 잡는다.'],
    ['W', '할 일', '지금 진행 중인 과업',
      '홈페이지 가격 페이지 새로 만들기', '이번 주까지 · 담당 원준. 새 요금제 3가지를 보기 좋게 정리하기.'],
  ];
  const glossList = el('div', { class: 'kind-ex-list' });
  for (const [g, ko, desc, exTitle, exBody] of GLOSS) {
    glossList.append(el('div', { class: 'kind-ex' },
      el('div', { class: 'kind-ex-head' },
        el('span', { class: 'gloss-glyph', 'aria-hidden': 'true', text: g }),
        el('div', { class: 'gloss-main' },
          el('div', {}, el('span', { class: 'gloss-ko', text: ko }), el('span', { class: 'gloss-code', text: ' (' + g + ')' })),
          el('div', { class: 'gloss-desc', text: desc }))),
      el('div', { class: 'gloss-example' },
        el('span', { class: 'gloss-example-tag', text: '예시' }),
        el('div', { class: 'gloss-example-title', text: exTitle }),
        el('div', { class: 'gloss-example-body', text: exBody }))));
  }
  unitCard.append(glossList, el('p', { class: 'admin-hint', style: 'margin-top:16px' }, '실제 지식들은 ',
    el('a', { href: '#/knowledge', text: '[WIKI] 탭' }), ' 에서 볼 수 있어요.'));

  view.replaceChildren(head, el('div', { class: 'guide-cards' }, whatCard, unitCard));
  document.getElementById('view').focus?.();
}

// 설치 탭(#/install) — 모든 구성원의 첫 행동. 비개발자도 그대로 따라 하도록 구성한다.
//  핵심: 쓰는 곳이 두 갈래라 시작법이 다르다 — (web) 라이블리 [터미널] 탭=서버에서 claude/codex 가 돌고
//  회사맥락이 이미 설치돼 있어 '설치 0' / (local) 내 컴퓨터 터미널=내 머신에 한 번 설치. mode 토글로 분기.
//  게이트웨이 주소는 org 프로필에서(loadAdmin — 비-admin 도 안전: tokens redact).
async function renderInstall(view) {
  const head = el('div', { class: 'page-head' },
    el('h1', {}, 'Lively ', el('span', { class: 'accent', text: '시작하기' })),
    el('p', { class: 'sub', text: '라이블리에서 AI(Claude Code·Codex)를 쓰는 방법은 두 가지입니다. 아래에서 본인 상황을 고르면, 그에 맞춰 차근차근 안내합니다.' }),
  );
  const slot = el('div', { class: 'install-guide' });
  slot.append(skeleton('설치 안내를 준비하는 중'));
  view.replaceChildren(head, slot);
  document.getElementById('view').focus?.();
  loadAdmin().then((data) => drawInstallGuide(slot, data))
    .catch((e) => slot.replaceChildren(errorNote(e, '설치 안내를 불러오지 못했습니다')));
}

// 설치 가이드 — 먼저 '어디서 쓰나'(web/local) 를 고르게 하고, 고른 모드의 가이드만 렌더. slot 안만 교체.
function drawInstallGuide(slot, data) {
  const gw = (data.profile.gateway_url || window.location.origin).replace(/\/mcp$/, '').replace(/\/$/, '');
  const mode = state.start.mode === 'local' ? 'local' : 'web';

  // ── 0. 먼저 이게 뭔가요(짧게) ──
  const intro = el('div', { class: 'card install-intro' },
    el('div', { class: 'card-head' }, el('h2', { text: '먼저, 이게 뭔가요' })),
    el('p', { class: 'guide-lead', text: '이걸 쓰면 AI(Claude Code·Codex)가 우리 회사의 규칙·맥락·기억을 “이미 아는 채로” 일을 시작합니다. 매번 배경을 다시 설명할 필요가 없어져요.' }),
    el('p', { class: 'admin-hint', style: 'margin-bottom:0' }, '개념·용어가 더 궁금하면 ',
      el('a', { href: '#/learn', text: '[사용설명서]' }), ' 를 먼저 봐도 좋아요.'));

  // ── 1. 어디서 쓰나 — 두 갈래 선택(카드 클릭 시 아래 가이드가 바뀜) ──
  const chooser = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '어디서 AI를 쓰실 건가요?' })),
    el('p', { class: 'admin-hint', text: '본인이 주로 쓰는 곳을 고르세요. 둘은 시작법이 다릅니다(둘 다 써도 됩니다).' }),
    el('div', { class: 'mode-choice' },
      modeCard('web', '라이블리 웹의 [터미널] 탭', '설치 필요 없음 · 웹에서 바로',
        '브라우저만 있으면 끝. 빠르게 써보거나 비개발자에게 추천.', mode, slot, data),
      modeCard('local', '내 컴퓨터의 터미널', '한 번 설치 필요 · 약 5분',
        '내 노트북(맥/윈도우) 터미널에서 직접 claude·codex 를 켜서 쓰는 분.', mode, slot, data)));

  const guide = mode === 'web' ? webGuideNodes() : localGuideNodes(gw, slot, data);
  slot.replaceChildren(intro, chooser, ...guide);
}

// 모드 선택 카드(웹 터미널 탭 vs 내 컴퓨터). 선택 시 재렌더.
function modeCard(key, title, tag, hint, active, slot, data) {
  const on = key === active;
  const pick = () => { if (state.start.mode !== key) { state.start.mode = key; drawInstallGuide(slot, data); } };
  return el('div', {
    class: 'mode-card' + (on ? ' active' : ''), role: 'button', tabindex: '0',
    'aria-pressed': on ? 'true' : 'false',
    onclick: pick,
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } },
  },
    el('div', { class: 'mode-card-top' },
      el('span', { class: 'mode-card-radio', 'aria-hidden': 'true' }),
      el('span', { class: 'mode-card-tag', text: tag })),
    el('div', { class: 'mode-card-title', text: title }),
    el('div', { class: 'mode-card-hint', text: hint }));
}

// (web) 라이블리 [터미널] 탭에서 쓰는 사람 — 내 컴퓨터엔 설치 0. 서버에서 claude/codex 가 회사맥락 가진 채 돈다.
function webGuideNodes() {
  const callout = el('div', { class: 'card install-callout' },
    el('div', { class: 'callout-strong', text: '내 컴퓨터엔 아무것도 안 깔아도 됩니다.' }),
    el('p', { class: 'callout-sub', text: 'AI는 라이블리 서버에서 돌고, 회사 맥락·규칙도 거기에 이미 설치돼 있어요. 웹 브라우저만 있으면 바로 시작할 수 있습니다.' }));

  const steps = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '쓰는 순서' })),
    el('div', { class: 'step-list' },
      installStep(1, '위쪽 메뉴에서 [터미널] 탭 열기',
        el('p', { class: 'step-p' }, '맨 위 메뉴에서 ', el('a', { href: '#/terminal', text: '[터미널]' }), ' 을 누르세요.')),
      installStep(2, '[+ 새 세션] 누르기',
        el('p', { class: 'step-p', text: '오른쪽 위 파란 [+ 새 세션] 버튼을 누르면 만들기 창이 떠요.' })),
      installStep(3, '작업 폴더와 AI를 고르고 [만들기]',
        el('p', { class: 'step-p' }, '작업 폴더(', el('b', { text: '공유 워크스페이스' }), ' 또는 ', el('b', { text: '개인 폴더' }),
          '), 사용할 AI(', el('b', { text: 'Claude Code' }), ' 또는 ', el('b', { text: 'Codex' }), '), 세션 이름을 정하고 [만들기]를 누르세요.'),
        el('p', { class: 'step-note', text: '잘 모르겠으면 — 작업 폴더는 [개인 폴더], AI는 [Claude Code]로 두면 무난해요.' })),
      installStep(4, '열린 창에서 바로 대화하기',
        el('p', { class: 'step-p', text: '까만 창(터미널)이 열리면 거기에 하고 싶은 말을 그냥 입력하면 됩니다. 회사 맥락·규칙은 이미 들어가 있어요.' }),
        el('p', { class: 'step-note', text: '세션은 창을 닫아도 서버에 남아 있어, 다음에 [터미널] 탭에서 다시 이어서 쓸 수 있어요.' }))));

  return [callout, steps];
}

// (local) 내 컴퓨터 터미널에서 쓰는 사람 — 내 머신에 한 번 설치. OS 토글로 단계가 바뀐다.
function localGuideNodes(gw, slot, data) {
  const os = state.start.os === 'windows' ? 'windows' : 'mac';
  const isWin = os === 'windows';

  const callout = el('div', { class: 'card install-callout' },
    el('div', { class: 'callout-strong', text: '내 컴퓨터에 한 번 설치합니다 (약 5분).' }),
    el('p', { class: 'callout-sub', text: '설치하면 내 노트북에서 claude(또는 codex)를 켤 때마다 회사 맥락이 자동으로 들어와요. 처음 딱 한 번만 하면 끝입니다.' }));

  // ── 준비물 — 대부분 이미 있음. 막히기 쉬운 node 는 확인법까지 명시(없으면 hooks 미설치=조용한 반쪽설치). ──
  const needs = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '준비물 (잠깐 확인)' })),
    el('p', { class: 'admin-hint', text: '아래만 있으면 됩니다. 대부분 이미 갖춰져 있어요.' }),
    checklist([
      ['내 컴퓨터 (Mac 또는 Windows)', '회사에서 쓰는 본인 노트북이면 됩니다.'],
      ['터미널 앱', '맥·윈도우에 기본으로 들어 있어요. 여는 법은 아래 1단계에서 알려드립니다.'],
      ['Node.js (거의 항상 이미 있음)', '터미널을 연 뒤(아래 1단계) node -v 를 입력해 v20 같은 숫자가 보이면 통과예요. 안 보이면 nodejs.org 에서 ‘LTS’ 설치 파일을 받아 더블클릭하세요.'],
      ['회사 계정', '설치 마지막에 회사 계정으로 로그인하는 브라우저 창이 한 번 뜹니다.'],
    ]));

  // ── 2. 단계 — OS 토글을 카드 헤더에 두고, 단계 본문이 OS 에 맞게 바뀐다 ──
  const osTabs = el('div', { class: 'os-tabs' },
    ...[['mac', 'macOS'], ['windows', 'Windows']].map(([o, label]) => el('button', {
      class: 'btn btn-sm ' + (o === os ? 'btn-primary' : 'btn-ghost'), text: label,
      onclick: () => { if (state.start.os !== o) { state.start.os = o; drawInstallGuide(slot, data); } } })));

  const term = isWin
    ? installStep(1, '터미널(PowerShell) 열기',
        el('p', { class: 'step-p' }, '화면 왼쪽 아래 ', kbd('시작'), ' 버튼을 누르고 ',
          kbd('powershell'), ' 라고 입력 → 목록에서 ', el('b', { text: 'Windows PowerShell' }), ' 을 클릭하세요.'),
        el('p', { class: 'step-note', text: '파란색 글자 입력 창이 하나 뜹니다. 이게 명령을 붙여넣을 곳이에요.' }))
    : installStep(1, '터미널 열기',
        el('p', { class: 'step-p' }, '키보드에서 ', kbd('⌘'), ' + ', kbd('스페이스바'),
          ' 를 동시에 눌러 검색창을 띄우고, ', kbd('터미널'), ' 이라고 입력한 뒤 ', kbd('Enter'), ' 를 누르세요.'),
        el('p', { class: 'step-note', text: '글자만 있는 작은 창이 하나 뜹니다. 이게 ‘터미널’이고, 여기에 명령을 붙여넣게 됩니다.' }));

  const mint = installStep(2, '내 설치 명령 만들기',
    el('p', { class: 'step-p' }, '관리자에게 받은 접속 토큰(이 화면에 ', el('b', { text: '처음 들어올 때 입력한 그 토큰' }),
      ')을 아래 칸에 붙여넣고 ', el('b', { text: '[설치 명령 만들기]' }), ' 를 누르세요. 그러면 그 토큰이 들어간 설치 명령이 만들어집니다.'),
    el('p', { class: 'step-note', text: '토큰은 본인 것이니 남과 공유하지 마세요. 만든 다음 [명령 복사]를 누르면 됩니다. (토큰을 잊었다면 관리자에게 다시 받으세요.)' }),
    installCmdBox(gw, os));

  const run = installStep(3, '명령 붙여넣고 실행하기',
    el('p', { class: 'step-p' }, '1단계에서 연 터미널 창을 클릭한 다음, 방금 복사한 명령을 붙여넣고(',
      isWin ? kbd('Ctrl') : kbd('⌘'), ' + ', kbd('V'), ') ', kbd('Enter'), ' 를 누르세요.'),
    el('p', { class: 'step-note', text: '명령이 길어 보여도 한 줄이에요 — 통째로 붙여넣으면 됩니다. 그러면 알아서 진행됩니다. 도중에 이런 게 나올 수 있어요:' }),
    el('ul', { class: 'step-ul' },
      el('li', {}, 'Claude Code 가 없으면 ', el('b', { text: '“설치할까요? [y/N]”' }), ' 라고 물어봐요 → ', kbd('y'), ' 를 누르고 ', kbd('Enter'), '.'),
      el('li', {}, '회사 계정 ', el('b', { text: '로그인 브라우저 창' }), ' 이 뜨면 회사 계정으로 로그인하세요.'),
      el('li', {}, el('b', { text: '“=== 끝! ===”' }), ' 비슷한 메시지가 보이면 설치가 끝난 거예요.')));

  const verify = installStep(4, '잘 됐는지 확인하기',
    el('p', { class: 'step-p' }, '같은 터미널에 아래를 입력하고 ', kbd('Enter'), ' 를 누르세요.'),
    cmdLine('claude mcp list'),
    el('p', { class: 'step-note' }, '목록에 ', el('b', { text: 'lively' }), ' 가 보이면 성공이에요. ',
      '이제 어느 폴더에서든 ', el('code', { class: 'md-code', text: 'claude' }), ' 를 켜면 회사 맥락이 따라옵니다.'));

  const steps = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', { text: '설치 단계' }),
      el('div', { class: 'os-pick' }, el('span', { class: 'os-pick-label', text: '내 컴퓨터' }), osTabs)),
    isWin ? el('p', { class: 'admin-warn', text: '⚠ Windows 설치는 아직 검증이 충분치 않습니다. 막히면 관리자에게 알려주세요.' }) : null,
    el('div', { class: 'step-list' }, term, mint, run, verify));

  // ── 3. 끝났어요 — 이제 뭘 하나 ──
  const next = el('div', { class: 'card install-next' },
    el('div', { class: 'card-head' }, el('h2', { text: '끝났어요 — 이제 뭘 하나요' })),
    el('p', { class: 'guide-lead', text: '설치가 끝나면 평소처럼 Claude Code 를 켜서 일하면 됩니다. 어느 폴더에서 켜든 회사 공통 맥락·규칙이 자동으로 함께 들어가요. 매번 회사 사정을 설명하지 않아도 됩니다.' }),
    el('p', { class: 'admin-hint', style: 'margin-bottom:0' }, '회사에 어떤 맥락이 쌓여 있는지 둘러보려면 ',
      el('a', { href: '#/knowledge', text: '[WIKI]' }), ' 탭으로 가보세요. (자동 주입은 ', el('b', { text: '다음 세션부터' }), ' 적용됩니다.)'));

  // ── 4. 유지보수(접힘) — 처음엔 필요 없음. 나중에 업데이트/제거할 때만. ──
  const staticBlock = (c) => el('div', { class: 'deploy-block' },
    el('div', { class: 'deploy-head' }, el('h3', { text: c.title }),
      c.cmd !== '(준비 중)' ? copyButton(() => c.cmd, '복사') : null),
    el('p', { class: 'admin-hint', text: c.note }),
    el('pre', { class: 'admin-preview', text: c.cmd }));
  const maint = el('details', { class: 'install-maint' },
    el('summary', { text: '＋ 나중에 필요할 때: 업데이트 · 제거 (지금은 안 봐도 됩니다)' }),
    el('p', { class: 'admin-hint', text: '처음 설치에는 필요 없습니다. 나중에 라이블리를 최신으로 갱신하거나, 내 컴퓨터에서 지울 때만 쓰는 명령이에요. 업데이트·제거는 설치된 토큰을 자동으로 읽어, 토큰을 다시 넣을 필요가 없습니다.' }),
    ...deployCommands(gw, os).filter((c) => c.kind !== 'install').map(staticBlock));

  return [callout, needs, steps, next, maint];
}

// 번호 매긴 설치 단계 한 칸.
function installStep(n, title, ...body) {
  return el('div', { class: 'step' },
    el('div', { class: 'step-num', 'aria-hidden': 'true', text: String(n) }),
    el('div', { class: 'step-body' },
      el('div', { class: 'step-title', text: title }),
      ...body));
}

// 사용자가 '관리자에게 받아 첫 로그인 때 입력한 토큰'을 직접 넣으면 그 토큰으로 설치 명령을 만든다(서버 발급 안 함).
//  입력값은 게이트 로그인 토큰(localStorage TOKEN_KEY)과 정확히 일치할 때만 통과 — 아무 문자열이나 명령으로
//  나가지 않게(아무거나 넣어도 산출되던 문제 차단). 일치하는 토큰은 state.start.token 에 캐시(OS 토글 시 재입력 불필요).
function installCmdBox(gw, os) {
  const result = el('div', { class: 'install-cmd-slot' });
  const err = el('p', { class: 'install-token-err' });
  err.hidden = true;
  const draw = () => {
    if (!state.start.token) { result.replaceChildren(); return; }
    const cmd = installCmd(gw, os, state.start.token);
    result.replaceChildren(
      el('p', { class: 'install-ok', text: '✓ 토큰이 확인됐어요. 설치 명령이 만들어졌습니다 — [명령 복사]를 누른 뒤 3단계로 가세요.' }),
      el('div', { class: 'deploy-head' }, el('span', {}), copyButton(() => cmd, '명령 복사')),
      el('pre', { class: 'admin-preview', text: cmd }));
  };
  const showErr = (msg) => { err.textContent = msg; err.hidden = false; result.replaceChildren(); };
  const tokenIn = el('input', {
    type: 'password', class: 'term-input', autocomplete: 'off', spellcheck: 'false',
    'aria-label': '관리자에게 받은 접속 토큰',
    placeholder: '관리자에게 받은 토큰 (첫 로그인 때 입력한 것)', value: state.start.token || '',
  });
  const go = el('button', { class: 'btn btn-primary btn-sm', text: '설치 명령 만들기' });
  const make = () => {
    const t = tokenIn.value.trim();
    if (!t) { showErr('토큰을 입력하세요.'); tokenIn.focus(); return; }
    // 게이트(첫 로그인) 때 입력한 토큰과 정확히 일치하는지 확인 — 일치할 때만 명령 생성.
    const login = (localStorage.getItem(TOKEN_KEY) || '').trim();
    if (login && t !== login) {
      showErr('이 화면에 처음 들어올 때 입력한 토큰과 다릅니다. 그때 입력한 토큰을 그대로 넣어 주세요. (잊었다면 관리자에게 다시 받으세요.)');
      return;
    }
    err.hidden = true;
    state.start.token = t;
    draw();
  };
  go.addEventListener('click', make);
  tokenIn.addEventListener('input', () => { if (!err.hidden) err.hidden = true; });
  tokenIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); make(); } });
  draw();
  return el('div', {}, el('div', { class: 'install-minter' }, tokenIn, go), err, result);
}

// 복사 가능한 한 줄 명령(확인용 등 — 토큰 없는 짧은 명령).
function cmdLine(cmd) {
  return el('div', { class: 'cmd-line' },
    el('code', { class: 'cmd-line-text', text: cmd }),
    copyButton(() => cmd, '복사'));
}

// 키캡(키보드 키·메뉴 항목 강조) — 비개발자용 시각 힌트.
function kbd(label) { return el('span', { class: 'kbd', text: label }); }

// 준비물 체크리스트.
function checklist(items) {
  const wrap = el('div', { class: 'install-checks' });
  for (const [k, v] of items) {
    wrap.append(el('div', { class: 'install-check' },
      el('span', { class: 'check-mark', 'aria-hidden': 'true', text: '✓' }),
      el('div', { class: 'check-main' },
        el('div', { class: 'check-k', text: k }),
        el('div', { class: 'check-v', text: v }))));
  }
  return wrap;
}

// 안내 카드 안의 라벨 + 값 한 줄 — 값은 안전 마크다운 렌더(자유텍스트의 인라인 서식 허용, HTML 주입 불가).
function learnRow(label, value) {
  return el('div', { class: 'learn-row' },
    el('div', { class: 'learn-row-k', text: label }),
    el('div', { class: 'learn-row-v' }, renderMarkdown(value)));
}

function skeleton(caption) {
  return el('div', {}, el('p', { class: 'loading-caption', text: caption + '…' }),
    el('div', { class: 'skel-stack' }, el('div', { class: 'skel' }), el('div', { class: 'skel' }), el('div', { class: 'skel' })));
}
function skeletonRows(n) {
  const box = el('div', {});
  for (let i = 0; i < n; i++) box.append(el('div', { class: 'row' }, el('div', { class: 'skel', style: 'min-height:18px;border:none;background:var(--bg-tint)' })));
  return box;
}
// 모달 오버레이(저장/편집 폼) — admin 의 overlay() 와 같은 ESC/배경클릭 닫기. 셸 재사용.
function overlayBox(title, ...content) {
  const box = el('div', { class: 'ov-box' },
    el('div', { class: 'ov-head' }, el('h3', { text: title }),
      el('button', { class: 'btn-text', text: '닫기', onclick: () => back.remove() })),
    ...content);
  const back = el('div', { class: 'ov-back' }, box);
  back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
  document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') { back.remove(); document.removeEventListener('keydown', esc); } });
  document.body.append(back);
  return back;
}

// ════════════════════════════════════════════════════════════════════
// 터미널 세션 매니저 (#/terminal) — 중앙 박스 경로 D: xterm.js + 서버 node-pty(tmux).
//  목록/생성폼/CRUD → REST(/api/ui/terminal/*), PTY 스트림 → WS(/terminal/ws, ticket 쿠키).
//  보기(폰트·크기·테마·커서)는 사용자별 localStorage 영속 + 실시간 적용. 보안: el()/textContent 만.
// ════════════════════════════════════════════════════════════════════
const TERM_PREFS_KEY = 'lively_term_prefs';
const TERM_FONTS = [
  { v: 'JetBrains Mono, D2Coding, Menlo, monospace', label: 'JetBrains Mono' },
  { v: 'D2Coding, Menlo, monospace', label: 'D2Coding' },
  { v: 'Menlo, Monaco, monospace', label: 'Menlo' },
  { v: 'SFMono-Regular, "SF Mono", monospace', label: 'SF Mono' },
  { v: 'Consolas, "Courier New", monospace', label: 'Consolas' },
];
const TERM_THEMES = {
  dark:      { name: '다크',      theme: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#585b70' } },
  light:     { name: '라이트',    theme: { background: '#fdfdfd', foreground: '#2a2a2a', cursor: '#5566ff', selectionBackground: '#cfe3ff' } },
  solarized: { name: 'Solarized', theme: { background: '#002b36', foreground: '#93a1a1', cursor: '#cb4b16', selectionBackground: '#073642' } },
  dracula:   { name: 'Dracula',   theme: { background: '#282a36', foreground: '#f8f8f2', cursor: '#ff79c6', selectionBackground: '#44475a' } },
};
function termPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(TERM_PREFS_KEY) || '{}'); } catch (_) { /* 기본값 */ }
  return Object.assign({ fontFamily: TERM_FONTS[0].v, fontSize: 14, theme: 'dark', cursorStyle: 'bar' }, p);
}
function saveTermPrefs(p) { try { localStorage.setItem(TERM_PREFS_KEY, JSON.stringify(p)); } catch (_) { /* noop */ } }

// 활성 터미널(세션) — 라우트 이탈/재진입 시 정리한다(ws 종료 + xterm dispose + 리스너 제거).
let termSession = null;
function teardownTerminal() {
  if (!termSession) return;
  try { if (termSession.ws) termSession.ws.close(); } catch (_) { /* noop */ }
  try { if (termSession.term) termSession.term.dispose(); } catch (_) { /* noop */ }
  if (termSession.onResize) window.removeEventListener('resize', termSession.onResize);
  termSession = null;
}

// 작업자(작성자) = 로그인 사용자. 서버가 토큰으로 owner 를 강제하므로 표시 전용(타인 선택 불가).
function memberName(cfg, id) {
  const m = ((cfg && cfg.members) || []).find((x) => x.id === id);
  return (m && m.name) || id || '';
}
function myName(cfg) {
  const id = (state.me && state.me.userId) || '';
  return memberName(cfg, id) || (state.me && state.me.email) || id || '나';
}
// 세션 생성 시각 — '6월 19일 22:17'(브라우저 로컬 타임존). created 는 epoch 초.
function fmtTermDate(sec) {
  const n = Number(sec) || 0;
  if (!n) return '';
  const d = new Date(n * 1000);
  if (isNaN(d.getTime())) return '';
  const p = (x) => String(x).padStart(2, '0');
  return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

async function renderTerminal(view, teamId) {
  view.replaceChildren(skeleton('세션을 불러오는 중'));
  let data, cfg, td;
  try { [data, cfg, td] = await Promise.all([
    api('/api/ui/terminal/sessions'), api('/api/ui/terminal/config'), api('/api/ui/terminal/teams'),
  ]); }
  catch (e) { view.replaceChildren(errorNote(e, '세션을 불러오지 못했습니다')); return; }
  const sessions = (data && data.sessions) || [];
  const teams = (td && td.teams) || [];
  if (teamId) { renderTeamView(view, cfg, teams, sessions, teamId); return; }

  const reRender = () => renderTerminal(view, null);
  const top = sessions.filter((s) => !s.team);
  const pub = top.filter((s) => s.visibility !== 'private');
  const priv = top.filter((s) => s.visibility === 'private');
  const pubMine = pub.filter((s) => s.owned);
  const pubOthers = pub.filter((s) => !s.owned);
  // 삭제 가능 = 내 소유 세션(공개 내것 + 비공개). 서버도 소유자 아니면 403 으로 재검증.
  const deletable = [...pubMine, ...priv].filter((s) => s.owned);

  // 선택(일괄삭제) 상태 — 리페치 없이 로컬 재페인트. ids = 선택된 세션 id 집합.
  const sel = { mode: false, ids: new Set() };
  const headActions = el('div', { class: 'term-head-actions' });
  const bulkBar = el('div', { class: 'bulk-bar', hidden: true });
  const body = el('div', {});

  function repaintBulk() {
    if (!sel.mode) { bulkBar.hidden = true; bulkBar.replaceChildren(); return; }
    const n = sel.ids.size;
    const allOn = deletable.length > 0 && deletable.every((s) => sel.ids.has(s.id));
    const allBtn = el('button', { class: 'btn btn-ghost btn-sm', text: allOn ? '전체 해제' : '전체 선택',
      onclick: () => { if (allOn) sel.ids.clear(); else deletable.forEach((s) => sel.ids.add(s.id)); repaint(); } });
    const delBtn = el('button', { class: 'btn btn-sm btn-danger', text: '선택 삭제', disabled: n === 0,
      onclick: () => bulkDelete(delBtn) });
    bulkBar.hidden = false;
    bulkBar.replaceChildren(
      el('span', { class: 'bulk-bar-count', text: n ? n + '개 선택됨' : '삭제할 세션을 고르세요' }),
      el('div', { class: 'bulk-bar-actions' }, allBtn, delBtn));
  }

  function repaint() {
    // 헤더 우측 — 생성 버튼들만. (선택/취소 토글은 '공개 세션' 섹션 헤더 우측으로 이동.)
    headActions.replaceChildren(
      el('button', { class: 'btn btn-ghost', text: '+ 새 팀', onclick: () => openTeamCreateForm(cfg, view) }),
      el('button', { class: 'btn btn-primary', text: '+ 새 공개 세션', onclick: () => openTermCreateForm(cfg, view, null, 'public') }),
      el('button', { class: 'btn btn-ghost', text: '+ 새 비공개 세션', onclick: () => openTermCreateForm(cfg, view, null, 'private') }));
    // '공개 세션' 헤더 우측 토글 — 선택모드면 [취소], 평소엔 (삭제 가능한 세션이 있을 때만) [선택].
    const selToggle = sel.mode
      ? el('button', { class: 'btn btn-ghost btn-sm term-sel-toggle', text: '취소', onclick: () => { sel.mode = false; sel.ids.clear(); repaint(); } })
      : (deletable.length
          ? el('button', { class: 'btn btn-ghost btn-sm term-sel-toggle', text: '선택', title: '여러 세션을 골라 한 번에 삭제', onclick: () => { sel.mode = true; repaint(); } })
          : null);
    // 팀 세션 / 공개 세션 / 비공개 세션 — 세 섹션. 선택모드면 내 세션 행에 체크박스(selOpt).
    const selOpt = sel.mode ? { ids: sel.ids, onToggle: repaintBulk } : null;
    const sections = [];
    if (teams.length) {
      const tlist = el('div', { class: 'term-list' });
      for (const t of teams) tlist.append(teamRow(t, cfg, view));
      sections.push([termSectionHead('팀 세션', '같은 팀원끼리만 자유롭게 보고 열 수 있는 세션입니다.'), tlist]);
    }
    sections.push([termSectionHead('공개 세션', '모든 멤버에게 보이는 세션입니다.', selToggle),
      termPublicSection(pubMine, pubOthers, cfg, view, selOpt)]);
    sections.push([termSectionHead('비공개 세션', '나에게만 보이는 세션입니다.'),
      termSessionList(priv, cfg, view, '비공개 세션이 없습니다.', selOpt)]);
    body.replaceChildren();
    sections.forEach(([secHead, secList], i) => {
      if (i > 0) secHead.classList.add('term-section--div'); // 첫 섹션 빼고 위에 구분선
      body.append(secHead, secList);
    });
    repaintBulk();
  }

  async function bulkDelete(btn) {
    const ids = [...sel.ids];
    if (!ids.length) return;
    if (!confirm(ids.length + '개 세션을 삭제할까요?\n\n실행 중인 작업도 함께 종료됩니다(되돌릴 수 없음).')) return;
    btn.disabled = true;
    // 병렬 삭제 — 일부 실패해도 나머지는 진행(성공/실패 건수 보고). 서버가 비소유분은 403.
    const results = await Promise.allSettled(
      ids.map((id) => api('/api/ui/terminal/sessions/' + encodeURIComponent(id), { method: 'DELETE' })));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const fail = results.length - ok;
    toast(fail ? (ok + '개 삭제 · ' + fail + '개 실패') : (ok + '개 세션을 삭제했습니다'), fail > 0);
    sel.mode = false; sel.ids.clear();
    reRender();
  }

  const head = el('div', { class: 'page-head' }, el('h1', { text: '터미널 세션' }), headActions);
  view.replaceChildren(head, bulkBar, body);
  repaint();
}

// 섹션 제목 + 한 줄 설명(desc 없으면 제목만).
function termSectionHead(title, desc, rightEl) {
  return el('div', { class: 'term-section' },
    el('div', { class: 'term-section-row' },
      el('div', { class: 'term-section-title', text: title }),
      rightEl || null),
    desc ? el('div', { class: 'caption term-section-desc', text: desc }) : null);
}
// 세션 목록(비면 안내 문구 — emptyText 가 있을 때만).
function termSessionList(items, cfg, view, emptyText, sel) {
  const list = el('div', { class: 'term-list' });
  if (!items.length && emptyText) list.append(el('div', { class: 'empty', text: emptyText }));
  for (const s of items) list.append(termRow(s, cfg, view, null, sel));
  return list;
}
// 공개 세션 = 내 것 + 다른 멤버 것. 남의 공개 세션은 계속 쌓이므로 기본 접고(N개) 펼쳐 보게 한다.
function termPublicSection(pubMine, pubOthers, cfg, view, sel) {
  const wrap = el('div', {});
  if (pubMine.length) wrap.append(termSessionList(pubMine, cfg, view, '', sel));
  else if (!pubOthers.length) wrap.append(termSessionList([], cfg, view, '공개 세션이 없습니다. "새 세션"으로 만드세요.'));
  else wrap.append(el('div', { class: 'caption', style: 'margin-top:10px', text: '내가 만든 공개 세션은 없습니다.' }));
  if (pubOthers.length) {
    const list = termSessionList(pubOthers, cfg, view, '');
    list.style.display = 'none';
    const caret = el('span', { class: 'term-fold-caret', text: '▾' });
    const toggle = el('button', { class: 'term-fold', type: 'button' },
      caret, el('span', { text: '다른 멤버의 공개 세션 ' + pubOthers.length + '개' }));
    toggle.addEventListener('click', () => {
      const open = list.style.display === 'none';
      list.style.display = open ? '' : 'none';
      caret.textContent = open ? '▴' : '▾';
      toggle.classList.toggle('open', open);
    });
    wrap.append(toggle, list);
  }
  return wrap;
}

// 팀 세션 행(루트 화면). 열기=팀 진입, 소유자는 팀원 관리·해제.
function teamRow(t, cfg, view) {
  const count = (t.members ? t.members.length : 0) + 1; // +1 = 소유자
  const meta = el('div', { class: 'term-row-meta' },
    el('div', { class: 'term-row-title' },
      el('span', { text: '📁 ' + t.label }),
      t.owned ? el('span', { class: 'term-badge', text: '내 팀' }) : null),
    el('div', { class: 'caption', text: '구성원 ' + count + '명' + ((t.memberNames && t.memberNames.length) ? ' · ' + t.memberNames.join(', ') : '') }));
  // 팀 세션은 모두에게 보이되, 멤버가 아니면 입장 불가(열기 자리에 잠금 표시).
  //  accessible 미정의(구 백엔드 응답)면 접근가능으로 본다 — 재시작 전 회귀 방지(구 백엔드는 내 팀만 내려줌).
  const actions = [t.accessible !== false
    ? el('button', { class: 'btn btn-primary btn-sm', text: '열기', onclick: () => { location.hash = '#/terminal?team=' + encodeURIComponent(t.id); } })
    : el('button', { class: 'btn btn-ghost btn-sm', text: '🔒 팀원 전용', disabled: '', title: '이 팀의 팀원만 들어갈 수 있습니다' })];
  if (t.owned) {
    actions.push(el('button', { class: 'btn btn-ghost btn-sm', text: '팀원 관리', onclick: () => openTeamManageForm(t, cfg, view) }));
    actions.push(el('button', { class: 'btn btn-ghost btn-sm', text: '해제', onclick: async () => {
      if (!confirm('팀 "' + t.label + '"을(를) 해제할까요? 폴더와 파일은 그대로 두고 팀 묶음(접근 제한)만 풉니다.')) return;
      try { await api('/api/ui/terminal/teams/' + encodeURIComponent(t.id), { method: 'DELETE' }); toast('팀 해제됨'); renderTerminal(view, null); }
      catch (e) { toast('실패 — ' + e.message, true); }
    } }));
  }
  return el('div', { class: 'term-row' }, meta, el('div', { class: 'term-row-actions' }, ...actions));
}

// 팀 진입 화면 — 루트와 동일 UI(세션 목록 + 새 세션), 단 이 팀 세션으로 스코프.
function renderTeamView(view, cfg, teams, sessions, teamId) {
  const back = el('a', { class: 'btn btn-ghost btn-sm', href: '#/terminal', text: '← 터미널 홈' });
  const team = teams.find((t) => t.id === teamId);
  if (!team || team.accessible === false) {
    const msg = !team ? '존재하지 않는 팀입니다.' : '이 팀 세션은 팀원만 들어갈 수 있습니다. 팀 소유자에게 초대를 요청하세요.';
    view.replaceChildren(el('div', { class: 'page-head' }, el('div', { class: 'term-head-actions' }, back), el('h1', { text: '팀 세션' })),
      el('div', { class: 'empty', text: msg }));
    return;
  }
  const ownerName = team.owned ? myName(cfg) : (memberName(cfg, team.owner) || '소유자');
  const memberBadges = el('div', { class: 'term-members' },
    el('span', { class: 'term-badge owner', text: '👑 ' + ownerName }),
    ...((team.memberNames || []).map((n) => el('span', { class: 'term-badge', text: '👤 ' + n }))));
  const head = el('div', { class: 'page-head' },
    el('div', { class: 'term-head-actions' }, back,
      el('button', { class: 'btn btn-primary', text: '+ 새 세션', onclick: () => openTermCreateForm(cfg, view, team) }),
      team.owned ? el('button', { class: 'btn btn-ghost', text: '팀원 관리', onclick: () => openTeamManageForm(team, cfg, view) }) : null),
    el('h1', { text: '📁 ' + team.label }),
    memberBadges,
    el('div', { class: 'caption', text: '이 팀 세션은 같은 팀원끼리만 자유롭게 보고 열 수 있습니다.' }));
  const mine = sessions.filter((s) => s.team === teamId);
  const list = el('div', { class: 'term-list' });
  if (!mine.length) list.append(el('div', { class: 'empty', text: '이 팀에 세션이 없습니다. "새 세션"으로 만드세요.' }));
  for (const s of mine) list.append(termRow(s, cfg, view, team));
  view.replaceChildren(head, list);
}

function termRow(s, cfg, view, team, sel) {
  const harnessLabel = ((cfg.harnesses || []).find((h) => h.key === s.harness) || {}).label || s.harness;
  const author = memberName(cfg, s.owner) || s.owner || '?';
  const created = fmtTermDate(s.created);
  const meta = el('div', { class: 'term-row-meta' },
    el('div', { class: 'term-row-title' },
      el('span', { class: 'term-row-name', title: s.label, text: s.label }),
      el('span', { class: 'term-badge author', text: '👤 ' + author }),
      el('span', { class: 'term-badge', text: s.visibility === 'private' ? '비공개' : '공개' }),
      s.autoApprove ? el('span', { class: 'term-badge danger', text: '자동승인' }) : null,
      s.attached ? el('span', { class: 'term-badge', text: '접속중' }) : null),
    el('div', { class: 'caption', text: harnessLabel + (created ? ' · ' + created : '') + (s.dir ? ' · ' + s.dir : '') }));
  // 선택(일괄삭제) 모드: 내 소유 세션엔 체크박스(행 전체가 토글 — label). 남의 세션은 체크박스 없음(삭제 불가).
  if (sel && s.owned) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = sel.ids.has(s.id);
    cb.addEventListener('change', () => { if (cb.checked) sel.ids.add(s.id); else sel.ids.delete(s.id); if (sel.onToggle) sel.onToggle(); });
    return el('label', { class: 'term-row term-row--sel' }, el('span', { class: 'term-row-check' }, cb), meta);
  }
  const reRender = () => renderTerminal(view, team ? team.id : null);
  const actions = [el('button', { class: 'btn btn-primary btn-sm', text: '열기', onclick: () => window.open('/ui/terminal.html?session=' + encodeURIComponent(s.id) + '&label=' + encodeURIComponent(s.label || ''), '_blank') })];
  if (s.owned) {
    actions.push(el('button', { class: 'btn btn-ghost btn-sm', text: '수정', onclick: () => openTermEdit(s, cfg, view, team) }));
    actions.push(el('button', { class: 'btn btn-ghost btn-sm', text: '삭제', onclick: async () => {
      if (!confirm('세션 "' + s.label + '" 을(를) 종료할까요? 실행 중인 작업도 함께 종료됩니다.')) return;
      try { await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id), { method: 'DELETE' }); toast('세션 종료됨'); reRender(); }
      catch (e) { toast('실패 — ' + e.message, true); }
    } }));
  }
  return el('div', { class: 'term-row' }, meta, el('div', { class: 'term-row-actions' }, ...actions));
}

// 새 세션. team 이 주어지면 그 팀 세션으로 스코프(작업 위치 고정, team 태그 전달).
function openTermCreateForm(cfg, view, team, fixedVis) {
  const roots = cfg.roots || [];
  const harnesses = cfg.harnesses || [];
  const labelI = el('input', { class: 'term-input', type: 'text', placeholder: '예: 랜딩 카피 수정' });
  const authorI = el('input', { class: 'term-input', type: 'text', value: myName(cfg), disabled: '' });
  const rootSel = el('select', { class: 'term-input' }, ...roots.map((r) => el('option', { value: r.key }, r.label)));
  const pickerBox = el('div', { class: 'term-picker' });
  let pickerPath = '';
  const harnessSel = el('select', { class: 'term-input' }, ...harnesses.map((h) => el('option', { value: h.key }, h.label)));
  const visSel = el('select', { class: 'term-input' },
    el('option', { value: 'public' }, '공개 — 모든 멤버가 열람 가능한 세션 (팀 내부 세션은 팀원만 열람가능)'),
    el('option', { value: 'private' }, '비공개 — 나에게만 보이고 나만 열 수 있는 세션'));
  // 헤더의 '새 공개/비공개 세션' 버튼으로 들어오면 공개여부가 정해져 있으므로 자동선택+비활성(회색)으로 둔다.
  if (fixedVis) { visSel.value = fixedVis; visSel.disabled = true; }
  const flagsBox = el('div', { class: 'term-flags' });
  const autoCb = el('input', { type: 'checkbox' });
  const autoWrap = el('label', { class: 'term-auto' }, autoCb,
    el('span', { text: ' 자동 승인 (위험) — 에이전트가 확인 없이 파일 수정·명령 실행. 공유 폴더에선 특히 주의.' }));

  function renderFlags() {
    const h = harnesses.find((x) => x.key === harnessSel.value) || {};
    flagsBox.replaceChildren();
    for (const f of (h.flags || [])) {
      let ctrl;
      if (f.type === 'select') ctrl = el('select', { class: 'term-input', 'data-flag': f.name }, ...(f.choices || []).map((c) => el('option', { value: c }, c || '(기본)')));
      else if (f.type === 'bool') ctrl = el('input', { type: 'checkbox', 'data-flag': f.name });
      else ctrl = el('input', { class: 'term-input', type: 'text', 'data-flag': f.name, placeholder: f.desc || '' });
      flagsBox.append(el('div', { class: 'field' }, el('label', { class: 'field-label', text: f.label }), ctrl, f.desc ? el('div', { class: 'caption', text: f.desc }) : null));
    }
    autoWrap.style.display = h.hasAutoApprove ? '' : 'none';
  }
  harnessSel.addEventListener('change', renderFlags);
  renderFlags();

  // 작업 폴더 = 선택한 루트(공유/개인) 안을 드롭다운으로 재귀 탐색. 팀 컨텍스트면 폴더 고정.
  async function loadPicker() {
    pickerBox.replaceChildren(el('div', { class: 'caption', text: '폴더 불러오는 중…' }));
    let data;
    try { data = await api('/api/ui/terminal/browse?root=' + encodeURIComponent(rootSel.value) + '&path=' + encodeURIComponent(pickerPath)); }
    catch (e) { pickerBox.replaceChildren(el('div', { class: 'caption', text: '폴더를 불러오지 못했습니다: ' + e.message })); return; }
    pickerPath = data.path || '';
    const rootLabel = (roots.find((r) => r.key === rootSel.value) || {}).label || rootSel.value;
    const crumb = el('div', { class: 'term-crumb' }, el('a', { class: 'crumb', text: rootLabel, onclick: () => { pickerPath = ''; loadPicker(); } }));
    let acc = '';
    for (const seg of (pickerPath ? pickerPath.split('/') : [])) {
      acc = acc ? acc + '/' + seg : seg; const p = acc;
      crumb.append(el('span', { class: 'crumb-sep', text: ' / ' }), el('a', { class: 'crumb', text: seg, onclick: () => { pickerPath = p; loadPicker(); } }));
    }
    const parentPath = data.parent; // '' = 루트로, null = 이미 루트(상위 없음)
    const sel = el('select', { class: 'term-input', onchange: () => {
      const v = sel.value; sel.value = '';
      if (v === '__up__') { pickerPath = parentPath || ''; loadPicker(); return; }
      if (v === '__new__') { newPickerFolder(); return; }
      if (v) { pickerPath = (pickerPath ? pickerPath + '/' : '') + v; loadPicker(); }
    } },
      el('option', { value: '' }, data.dirs.length ? '하위 폴더로 이동…' : '(하위 폴더 없음)'),
      (pickerPath ? el('option', { value: '__up__' }, '⬆ 상위 폴더로') : null),
      ...data.dirs.map((d) => el('option', { value: d }, '📁 ' + d)),
      el('option', { value: '__new__' }, '＋ 새 폴더 만들기…'));
    pickerBox.replaceChildren(crumb, sel, el('div', { class: 'caption', text: '여기서 시작: /' + pickerPath }));
  }
  async function newPickerFolder() {
    const name = prompt('새 폴더 이름'); if (!name || !name.trim()) return;
    const rel = (pickerPath ? pickerPath + '/' : '') + name.trim();
    try { await api('/api/ui/terminal/browse/mkdir?root=' + encodeURIComponent(rootSel.value) + '&path=' + encodeURIComponent(rel), { method: 'POST' }); pickerPath = rel; loadPicker(); }
    catch (e) { toast('폴더 생성 실패 — ' + e.message, true); }
  }
  if (!team) {
    rootSel.addEventListener('change', () => { pickerPath = ''; loadPicker(); });
    loadPicker();
  }

  // 팀 컨텍스트면 작업 위치/폴더 대신 고정된 '팀 세션' 표시 필드.
  const locFields = team
    ? [field('팀 세션', el('input', { class: 'term-input', type: 'text', value: '📁 ' + team.label, disabled: '' }))]
    : [field('작업 위치', rootSel), field('폴더', pickerBox)];

  const newTitle = fixedVis === 'private' ? '새 비공개 세션' : (fixedVis === 'public' ? '새 공개 세션' : '새 세션');
  const back = overlay(team ? ('새 세션 · ' + team.label) : newTitle,
    field('이름', labelI), field('작업자', authorI), locFields, field('하네스', harnessSel),
    field('공개 범위', visSel), flagsBox, autoWrap,
    el('div', { class: 'ov-actions' },
      el('button', { class: 'btn btn-primary', text: '생성하기', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        const flags = {};
        for (const c of flagsBox.querySelectorAll('[data-flag]')) flags[c.dataset.flag] = (c.type === 'checkbox') ? c.checked : c.value;
        const payload = team
          ? { label: labelI.value, rootKey: 'shared', subpath: team.id, harness: harnessSel.value, flags, autoApprove: autoCb.checked, visibility: visSel.value, team: team.id }
          : { label: labelI.value, rootKey: rootSel.value, subpath: pickerPath, harness: harnessSel.value, flags, autoApprove: autoCb.checked, visibility: visSel.value };
        try {
          const out = await api('/api/ui/terminal/sessions', { method: 'POST', body: JSON.stringify(payload) });
          back.remove(); toast('세션 생성됨');
          if (out && out.session) window.open('/ui/terminal.html?session=' + encodeURIComponent(out.session.id) + '&label=' + encodeURIComponent(out.session.label || ''), '_blank');
          renderTerminal(view, team ? team.id : null);
        } catch (e) { btn.disabled = false; toast('생성 실패 — ' + e.message, true); }
      } })));
}

// 세션 수정 — 이름·공개범위만 변경 가능(소유자만, 서버가 강제). 작업폴더·하네스·모델·자동승인은
//  생성 시 실행 명령에 박혀(돌고 있는 LLM/셸 프로세스) 사후 변경 불가 → '현재값'을 비활성으로 보여주고
//  왜 못 바꾸는지(닫고 새로 켜야 함) 안내한다. "기능 미구현"이 아니라 "구조상 고정"임을 분명히.
function openTermEdit(s, cfg, view, team) {
  const harnesses = (cfg && cfg.harnesses) || [];
  const harness = harnesses.find((h) => h.key === s.harness) || {};
  // ── 변경 가능 ──
  const labelI = el('input', { class: 'term-input', type: 'text', value: s.label });
  const visSel = el('select', { class: 'term-input' },
    el('option', { value: 'public', selected: s.visibility !== 'private' ? '' : null }, '공개 — 모든 멤버가 열람 가능한 세션 (팀 내부 세션은 팀원만 열람가능)'),
    el('option', { value: 'private', selected: s.visibility === 'private' ? '' : null }, '비공개 — 나에게만 보이고 나만 열 수 있는 세션'));
  // ── 생성 시 고정(비활성 표시) ──
  const ro = (val) => el('input', { class: 'term-input', type: 'text', value: val, disabled: '' });
  const author = memberName(cfg, s.owner) || s.owner || '?';
  const flagFields = (harness.flags || []).map((f) => {
    const raw = (s.flags && s.flags[f.name] != null) ? String(s.flags[f.name]) : '';
    const shown = f.type === 'bool' ? (raw ? '켜짐' : '꺼짐') : (raw || '(기본)');
    return field(f.label, ro(shown));
  });
  const autoShown = harness.hasAutoApprove ? (s.autoApprove ? '켜짐 (위험)' : '꺼짐') : '해당 없음';
  const lockNote = el('div', { class: 'term-lock-note' },
    el('span', { text: '🔒 작업 폴더 · 하네스 · 모델 · 자동 승인은 세션을 처음 켤 때 정해집니다. 바꾸려면 실행 중인 LLM(또는 셸)을 닫고 새로 켜야 하므로 여기서는 수정할 수 없습니다 — 바꾸려면 새 세션을 만드세요.' }));

  const back = overlay('세션 수정',
    field('이름', labelI),
    field('공개 범위', visSel),
    lockNote,
    field('작업자', ro(author)),
    field('작업 폴더', ro(s.dir || '(기본)')),
    field('하네스', ro(harness.label || s.harness || '?')),
    flagFields,
    field('자동 승인', ro(autoShown)),
    el('div', { class: 'ov-actions' },
      el('button', { class: 'btn btn-primary', text: '저장', onclick: async (ev) => {
        ev.currentTarget.disabled = true;
        try { await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id), { method: 'POST', body: JSON.stringify({ label: labelI.value, visibility: visSel.value }) }); back.remove(); toast('수정됨'); renderTerminal(view, team ? team.id : null); }
        catch (e) { ev.currentTarget.disabled = false; toast('수정 실패 — ' + e.message, true); }
      } })));
}

// 새 팀 — 공유 워크스페이스에 폴더를 만들고 선택한 구성원만 접근. 소유자(나)는 자동 포함.
function openTeamCreateForm(cfg, view) {
  const labelI = el('input', { class: 'term-input', type: 'text', placeholder: '예: 그로스팀' });
  const meId = (state.me && state.me.userId) || '';
  const others = (cfg.members || []).filter((m) => m.id !== meId);
  const checks = others.map((m) => {
    const cb = el('input', { type: 'checkbox', 'data-mid': m.id });
    return { id: m.id, cb, row: el('label', { class: 'term-check' }, cb, el('span', { text: m.name + (m.kind === 'agent' ? ' (AI)' : '') })) };
  });
  const listBox = checks.length
    ? el('div', { class: 'term-checklist' }, ...checks.map((c) => c.row))
    : el('div', { class: 'caption', text: '추가할 다른 구성원이 없습니다 — 나만 접근하는 팀이 됩니다.' });
  const back = overlay('새 팀',
    field('팀 이름', labelI),
    field('소유자', el('input', { class: 'term-input', type: 'text', value: myName(cfg), disabled: '' })),
    field('팀원 (선택한 구성원만 이 팀 세션에 접근)', listBox),
    el('div', { class: 'ov-actions' },
      el('button', { class: 'btn btn-primary', text: '팀 만들기', onclick: async (ev) => {
        if (!labelI.value.trim()) { toast('팀 이름을 입력하세요', true); return; }
        ev.currentTarget.disabled = true;
        const picked = checks.filter((c) => c.cb.checked).map((c) => c.id);
        try {
          const out = await api('/api/ui/terminal/teams', { method: 'POST', body: JSON.stringify({ label: labelI.value, members: picked }) });
          back.remove(); toast('팀 생성됨');
          if (out && out.team) location.hash = '#/terminal?team=' + encodeURIComponent(out.team.id);
          else renderTerminal(view, null);
        } catch (e) { ev.currentTarget.disabled = false; toast('팀 생성 실패 — ' + e.message, true); }
      } })));
}

// 팀원 관리 — 이름·팀원 수정(소유자만). 저장 후 현재 보던 화면 유지.
function openTeamManageForm(team, cfg, view) {
  const labelI = el('input', { class: 'term-input', type: 'text', value: team.label });
  const current = new Set(team.members || []);
  const others = (cfg.members || []).filter((m) => m.id !== team.owner);
  const checks = others.map((m) => {
    const cb = el('input', { type: 'checkbox', 'data-mid': m.id });
    if (current.has(m.id)) cb.checked = true;
    return { id: m.id, cb, row: el('label', { class: 'term-check' }, cb, el('span', { text: m.name + (m.kind === 'agent' ? ' (AI)' : '') })) };
  });
  const listBox = checks.length
    ? el('div', { class: 'term-checklist' }, ...checks.map((c) => c.row))
    : el('div', { class: 'caption', text: '추가할 다른 구성원이 없습니다.' });
  const back = overlay('팀원 관리 · ' + team.label,
    field('팀 이름', labelI),
    field('소유자', el('input', { class: 'term-input', type: 'text', value: memberName(cfg, team.owner), disabled: '' })),
    field('팀원 (선택한 구성원만 이 팀 세션에 접근)', listBox),
    el('div', { class: 'ov-actions' },
      el('button', { class: 'btn btn-primary', text: '저장', onclick: async (ev) => {
        if (!labelI.value.trim()) { toast('팀 이름을 입력하세요', true); return; }
        ev.currentTarget.disabled = true;
        const picked = checks.filter((c) => c.cb.checked).map((c) => c.id);
        try {
          await api('/api/ui/terminal/teams/' + encodeURIComponent(team.id), { method: 'POST', body: JSON.stringify({ label: labelI.value, members: picked }) });
          back.remove(); toast('팀 수정됨');
          renderTerminal(view, parseHash().params.get('team') || null);
        } catch (e) { ev.currentTarget.disabled = false; toast('수정 실패 — ' + e.message, true); }
      } })));
}

async function renderTerminalSession(view, id) {
  const prefs = termPrefs();
  const backLink = el('a', { class: 'btn btn-ghost btn-sm', href: '#/terminal', text: '← 세션 목록' });
  const status = el('span', { class: 'caption', text: '연결 중…' });
  const gear = el('button', { class: 'btn btn-ghost btn-sm', text: '⚙ 보기 설정', onclick: () => openTermSettings() });
  const bar = el('div', { class: 'term-bar' }, backLink, el('span', { class: 'term-bar-id', text: decodeURIComponent(id) }), el('span', { style: 'flex:1' }), status, gear);
  const host = el('div', { class: 'term-host' });
  view.replaceChildren(el('div', { class: 'term-wrap' }, bar, host));

  if (!window.Terminal || !window.FitAddon) { status.textContent = '터미널 라이브러리 로드 실패 (xterm)'; return; }
  const term = new Terminal({
    fontFamily: prefs.fontFamily, fontSize: prefs.fontSize, cursorStyle: prefs.cursorStyle, cursorBlink: true,
    theme: (TERM_THEMES[prefs.theme] || TERM_THEMES.dark).theme, scrollback: 5000, allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  try { fit.fit(); } catch (_) { /* noop */ }

  try { await api('/api/ui/terminal/ticket', { method: 'POST' }); }
  catch (e) { status.textContent = '인증 실패 — ' + e.message; return; }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(proto + '://' + location.host + '/terminal/ws?session=' + encodeURIComponent(id));
  const onResize = () => { try { fit.fit(); } catch (_) { /* noop */ } if (ws.readyState === 1) { try { ws.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows })); } catch (_) { /* noop */ } } };
  termSession = { ws, term, fit, onResize };
  window.addEventListener('resize', onResize);

  ws.onopen = () => { status.textContent = '연결됨'; onResize(); term.focus(); };
  ws.onmessage = (e) => { if (typeof e.data === 'string') term.write(e.data); };
  ws.onclose = () => { status.textContent = '연결 종료'; };
  ws.onerror = () => { status.textContent = '연결 오류'; };
  term.onData((d) => { if (ws.readyState === 1) { try { ws.send(JSON.stringify({ t: 'i', d })); } catch (_) { /* noop */ } } });
}

function openTermSettings() {
  if (!termSession || !termSession.term) { toast('열린 터미널이 없습니다', true); return; }
  const term = termSession.term;
  const prefs = termPrefs();
  const fontSel = el('select', { class: 'term-input' }, ...TERM_FONTS.map((f) => el('option', { value: f.v, selected: f.v === prefs.fontFamily ? '' : null }, f.label)));
  const sizeI = el('input', { class: 'term-input', type: 'number', min: '9', max: '28', value: String(prefs.fontSize) });
  const themeSel = el('select', { class: 'term-input' }, ...Object.entries(TERM_THEMES).map(([k, v]) => el('option', { value: k, selected: k === prefs.theme ? '' : null }, v.name)));
  const cursorSel = el('select', { class: 'term-input' }, ...['bar', 'block', 'underline'].map((c) => el('option', { value: c, selected: c === prefs.cursorStyle ? '' : null }, c)));
  const apply = () => {
    const p = { fontFamily: fontSel.value, fontSize: Number(sizeI.value) || 14, theme: themeSel.value, cursorStyle: cursorSel.value };
    term.options.fontFamily = p.fontFamily; term.options.fontSize = p.fontSize; term.options.cursorStyle = p.cursorStyle;
    term.options.theme = (TERM_THEMES[p.theme] || TERM_THEMES.dark).theme;
    saveTermPrefs(p);
    if (termSession && termSession.onResize) termSession.onResize();
  };
  for (const c of [fontSel, themeSel, cursorSel]) c.addEventListener('change', apply);
  sizeI.addEventListener('input', apply);
  overlay('터미널 보기 설정', field('폰트', fontSel), field('크기(px)', sizeI), field('테마', themeSel), field('커서', cursorSel),
    el('div', { class: 'caption', text: '설정은 이 브라우저에 저장되어 다음에도 적용됩니다.' }));
}

// ── 라우터 ──
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const qIdx = h.indexOf('?');
  const pathPart = qIdx >= 0 ? h.slice(0, qIdx) : h;
  const params = new URLSearchParams(qIdx >= 0 ? h.slice(qIdx + 1) : '');
  return { segs: pathPart.split('/').filter(Boolean), params };
}

function setActiveTab(name) {
  for (const a of document.querySelectorAll('.tabs a, .help-link')) {
    const on = a.dataset.tab === name;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

async function route() {
  teardownTerminal(); // 터미널 뷰를 떠나면 ws/xterm 정리(메모리·소켓 누수 방지)
  if (!localStorage.getItem(TOKEN_KEY)) { showGate(); return; }
  const { segs, params } = parseHash();
  const view = $view();
  const page = segs[0] || 'install'; // 홈(빈 해시·로고) = 시작하기
  try {
    if (page === 'learn') {
      setActiveTab('learn'); // '사용 가이드' — 우측 상단 보조 링크(.help-link)
      await renderLearn(view);
    } else if (page === 'install') {
      setActiveTab('start');
      await renderInstall(view);
    } else if (page === 'domainmap') {
      setActiveTab('domainmap'); // 코드구조 — 독립 탭(index.html data-tab="domainmap")
      await renderDomainmap(view, params);
    } else if (page === 'knowledge') {
      setActiveTab('knowledge'); // 지식(맥락의 기록) — 사업·제품·시스템 + 통계·검토. injection/provenance 직교축.
      await renderKnowledge(view, segs[1] || 'business', params);
    } else if (page === 'trash') {
      setActiveTab('knowledge'); // 휴지통(삭제됨)은 지식 탭 계열의 하위 회수 뷰 — 상위 탭 활성 유지
      await renderTrash(view);
    } else if (page === 'k') {
      setActiveTab('knowledge'); // 지식 상세는 지식 탭의 하위 뷰 — 상위 탭 활성 유지
      await renderKnowledgeDetail(view, decodeURIComponent(segs.slice(1).join('/')));
    } else if (page === 'projects') {
      // v1 프로젝트 탭 폐기(2026-06-23) — projects2 로 통합. 옛 링크/북마크는 리다이렉트.
      location.replace('#/projects2');
      return;
    } else if (page === 'projects2') {
      setActiveTab('projects2'); // 프로젝트(v2) — 맥락의 변화. 대시보드·작업현황·사업·제품·시스템 하위탭.
      if (segs[1] === 'p' && segs[2]) await renderProjectV2Detail(view, segs[2]);
      else await renderProjectsV2(view, segs[1] || 'dashboard', params);
    } else if (page === 'system') {
      setActiveTab('system');
      await renderSystem(view, segs[1] || null);
    } else if (page === 'terminal') {
      setActiveTab('terminal');
      await renderTerminal(view, params.get('team'));
    } else {
      setActiveTab('start');
      await renderInstall(view);
    }
  } catch (e) {
    if (e && e.status === 401) return;
    view.replaceChildren(errorNote(e, '페이지를 불러오지 못했습니다'));
  }
}
window.addEventListener('hashchange', route);

// ── 부팅 ──
async function boot() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) { showGate(); return; }
  try {
    state.me = await api('/api/ui/me');
  } catch (e) {
    if (e.status === 401) return; // api() 가 게이트 표시
    showGate('서버에 연결하지 못했습니다 — ' + e.message);
    return;
  }
  hideGate();
  document.getElementById('user-email').textContent = state.me.email || state.me.userId || '';
  // '관리' 탭은 모든 인증 사용자에게 — admin 은 편집, 그 외는 읽기 전용(서버가 쓰기를 강제 차단).
  const sysTab = document.getElementById('system-tab');
  if (sysTab) sysTab.hidden = false;
  getOverview().catch(() => { /* 칩/배지만 생략(지도 진입 시 재시도) */ });
  route();
}
boot();

// ════════════════════════════════════════════════════════════════════
// 관리(전달/관리 — workflow-std 흡수). 핵심 원칙: 비개발자가 편집/확인하는 모든 항목 옆에
// '구성원에게 미치는 효과'를 항상 보여준다(meaning 패널). 셸/디자인/라우터는 기존 재사용.
// ════════════════════════════════════════════════════════════════════
// 관리 중분류(가로 탭, 2026-06-20) — 비개발자가 섹션에서 길잃지 않게 3분류로 묶는다.
//  ① 기본 설정: 접속·구성원·토큰(굴러가게 하는 기본기) ② 회사·조직: 규칙·맥락·메모리·용어(AI에 가르치는 내용)
//  ③ AI 동작·연결(고급): 훅·도구·MCP·DB(AI가 실제 어떻게 동작/어떤 데이터에 닿나).
//  '지식 종류 레지스트리'·'설치'는 관리에서 빼 #/learn(가이드)로 이관 — 전자=용어설명, 후자=구성원 셋업.
const ADMIN_GROUPS = [
  { key: 'basic', label: '기본 설정' },
  { key: 'access', label: '조직·권한 설정' },
  { key: 'wiki', label: 'WIKI 설정' },
  { key: 'knowledge', label: '맥락 관리 설정' },
  { key: 'ai', label: 'AI 동작·연결 (고급)' },
];
const ADMIN_SECTIONS = [
  // ① 기본 설정 — 한 번 세팅하면 굴러가는 조직 기본 정보(이름·서버 주소).
  { key: 'profile', label: '조직 기본 정보', meaning: 'gateway-url', group: 'basic' },
  // ② 조직·권한 설정 — 누가 함께 쓰나(구성원) + 접속 권한.
  { key: 'members', label: '구성원 관리', meaning: 'member', group: 'access' },
  { key: 'member-add', label: '구성원 추가', meaning: 'member', group: 'access' },
  { key: 'tokens', label: '접속 권한 변경', meaning: null, group: 'access' },
  // ②-B WIKI 카테고리 관리 — 지식(위키)의 분류축(사업·제품·시스템 카테고리) CRUD. 제품 카테고리=도메인.
  //  카테고리 탭(#/categories)과 같은 category-store(/api/ui/categories) — 여기 수정이 지식·프로젝트 탭 좌측에 반영.
  { key: 'wiki-categories', label: '카테고리 설정', meaning: null, group: 'wiki' },
  // ③ 조직 지식 설정 — 회사가 AI에 쌓아 가르치는 맥락(규칙·소개/성격·메모리·주제 분류).
  { key: 'managed-policy', label: 'AI 필수 규칙', meaning: 'managed-policy', group: 'knowledge' },
  { key: 'org-defaults', label: '회사 소개 · AI 성격', meaning: 'org-defaults', group: 'knowledge' },
  { key: 'memory', label: 'WIKI 인덱스', meaning: 'memory', group: 'knowledge' },
  { key: 'domains-repos', label: '주제 분류', meaning: null, group: 'knowledge' },
  // 컨텍스트 온톨로지 가이드 — 매 대화에 깔리는 지식 인덱스 전체 템플릿(고급). ${area}/${rules} 자동 주입. 잘못 바꾸면 위험 → 경고 배너+되돌리기.
  { key: 'context-ontology-guide', label: '컨텍스트 온톨로지 가이드 (고급)', meaning: 'context-ontology-guide', group: 'knowledge', scaffold: true },
  // ④ AI 동작·연결 (고급) — AI가 실제 어떻게 동작/어떤 데이터에 닿나.
  //  훅 — 상위 '훅'(클릭 시 개요 설명, AI도구·MCP·DB 와 동급 최상위) 아래 3종이 자식: '런타임 훅'(빌트인 리플렉스 토글)·'커스텀 훅'(임의 코드 정의)·'주입 미리보기'(주입물 열람).
  { key: 'hooks-group', label: '훅', meaning: null, group: 'ai' },
  { key: 'runtime', label: '런타임 훅 (빌트인 리플렉스 ON/OFF)', meaning: 'runtime', indent: true, group: 'ai' },
  { key: 'custom-hooks', label: '커스텀 훅 (코드 정의)', meaning: 'custom-hook', indent: true, group: 'ai' },
  { key: 'hooks-preview', label: '주입 미리보기 (세션 주입물 확인)', meaning: null, indent: true, group: 'ai' },
  { key: 'tools', label: 'AI 도구(툴)', meaning: 'tool', group: 'ai' },
  { key: 'mcp', label: 'MCP 서버', meaning: 'mcp', group: 'ai' },
  { key: 'db-sources', label: 'DB 데이터소스', meaning: 'db-source', group: 'ai' },
];
const ADMIN_ONLY = ['member-add', 'tokens', 'runtime', 'mcp', 'db-sources']; // admin 권한 전용(쓰기/인프라)
const RUNTIME_ONLY = ['custom-hooks', 'tools']; // runtime 권한 전용(멤버 머신 실행물 정의)
// V4-P5/J: 어휘(도메인·레포·기능) CRUD = context 스코프(admin 완화). 도메인맵 CRUD 엔드포인트가 scope:'context'
//  이므로 context 권한자면 편집 가능 — admin 전용 잠금 해제. context 없는 사용자는 읽기 전용(섹션 자체는 노출).
const CONTEXT_EDIT = ['domains-repos', 'wiki-categories']; // context 스코프면 편집 가능(없으면 읽기 전용으로 표시)
// 컨텍스트 온톨로지 가이드 섹션 — 매 대화에 깔리는 지식 인덱스 전체 템플릿. 잘못 바꾸면 모든 AI 동작이 망가질 수 있어 경고+되돌리기를 단다.
const SCAFFOLD_SECTIONS = ['context-ontology-guide'];
// 플레이스홀더 안내 — 편집창에 보여줄 자동주입 토큰 설명.
const GUIDE_PLACEHOLDER_HINT = '이 글이 매 대화 첫머리의 “지식 인덱스”로 그대로 들어가요. 본문 안의 ${area} 는 주제 목록, ${rules} 는 강제 규칙으로 자동 채워집니다(그 자리에 두세요).';
// 비개발자용 경고 — '이게 무엇인지' 한 줄 + 공통 위험 안내(아래 sectionEditor 가 .admin-warn 으로 렌더).
const SCAFFOLD_WARN = {
  'context-ontology-guide': '이 글은 AI에게 "공유 지식이 무엇이고, 주제로 어떻게 찾고, 알게 된 걸 어디에 기록할지"를 알려주는 인덱스 전체 틀이에요.',
};
const SCAFFOLD_WARN_COMMON = '⚠️ 이건 모든 구성원의 AI가 지식을 정리·검색·기록하는 방식의 뼈대예요. 잘못 바꾸면 AI가 지식을 엉뚱하게 다루거나 못 찾을 수 있어요(특히 ${area} 를 지우면 주제 목록이 사라져요). 평소엔 그대로 두는 게 안전하고, 꼭 바꿔야 하면 뜻을 정확히 아는 사람만 고치세요. 언제든 [기본값으로 되돌리기]로 원래대로 복구할 수 있어요.';
function sectionHidden(key, data) {
  if (ADMIN_ONLY.includes(key) && !data.canEdit) return true;
  if (RUNTIME_ONLY.includes(key) && !data.canRuntime) return true;
  return false;
}
// 현재 토큰이 가진 scope 보유 여부(/api/ui/me 의 scopes). 어휘 CRUD 권한(context) 판정에 쓴다.
function hasScope(s) {
  return !!(state.me && Array.isArray(state.me.scopes) && state.me.scopes.includes(s));
}

async function loadAdmin(force) {
  if (!state.admin.data || force) state.admin.data = await api('/api/ui/org');
  return state.admin.data;
}

function meaningRow(k, v) {
  return el('div', { class: 'meaning-row' },
    el('span', { class: 'meaning-k', text: k }),
    el('span', { class: 'meaning-v', text: v }));
}
// 비개발자용 카드 카피 — 서버 MEANING(기술적·장황) 위에 클라에서 덮어쓴다(즉시 반복, 서버 재시작 불요).
//  키 = 섹션 meaning 키. 없는 키(고급 훅·MCP·DB·툴 등)는 서버 카피로 폴백.
const MEANING_KO = {
  'managed-policy': {
    label: 'AI 필수 규칙',
    what: '회사의 모든 AI가 무조건 지켜야 하는 규칙이에요. 개인이 끄거나 바꿀 수 없어요.',
    reach: '모든 구성원과 그들이 쓰는 AI',
    when: '대화를 시작할 때 가장 먼저 적용돼요',
    where: 'AI가 답을 만들 때 무엇보다 우선해서 지켜요',
    example: "'고객 개인정보는 절대 보여주지 않기'를 넣으면, 그때부터 모두의 AI가 무조건 그렇게 해요.",
  },
  'org-defaults': {
    label: '회사 소개 · AI 성격',
    what: '회사가 어떤 곳인지, AI가 어떤 성격·말투로 일하는지, 우리 팀이 일하는 방식이에요.',
    reach: '모든 구성원과 그들이 쓰는 AI',
    when: '대화를 시작할 때 자동으로 깔려요 (필수 규칙 다음)',
    where: 'AI가 답할 때 바탕에 깔리는 기본 분위기예요',
    example: "'근거 없이 단정하지 않기'를 더하면, 그때부터 모두의 AI가 더 신중하게 답해요.",
  },
  'memory': {
    label: 'WIKI 인덱스',
    what: '팀이 함께 쌓는 위키(지식)예요. AI가 필요할 때 꺼내 봅니다. 📌 핀한 항목은 제목·분류가 매 대화 첫머리에 깔려요.',
    reach: '모든 구성원과 그들이 쓰는 AI',
    when: '제목은 늘 보이고, 자세한 내용은 AI가 필요할 때 찾아봐요',
    where: "AI가 '우리 팀이 전에 이렇게 정했지'를 떠올려야 할 때 참고해요",
    example: '새로 내린 결정을 메모로 올리면, 모두의 AI가 그 결정을 알고 일관되게 답해요.',
  },
  'member': {
    label: '구성원 정보',
    what: '한 사람(또는 AI·시스템)이 누구인지, 어떤 계정(이메일·슬랙 등)을 쓰는지예요.',
    reach: '그 사람 + 전체 검색·연결',
    when: '저장하면 바로 반영돼요',
    where: "AI가 사람을 찾거나 '담당자에게 맡기기' 할 때 쓰는 정보예요",
    example: '어떤 사람의 슬랙 계정을 연결하면, AI가 그 사람의 슬랙 활동을 한 사람으로 묶어 봐요.',
  },
  'gateway-url': {
    label: '서버 주소',
    what: '구성원의 AI가 실시간 현황을 받아오는 우리 회사 서버 주소예요.',
    reach: '모든 구성원의 AI',
    when: '구성원이 다시 설치한 다음부터 새 주소를 써요',
    where: "대화 첫머리의 '실시간 현황'을 어디서 가져올지 정해요",
    example: '서버를 옮겨 주소를 바꾸면, 재설치 후부터 새 주소에서 현황을 받아요. (연결이 안 되면 기본 내용만 보여서 안전해요.)',
  },
  'display_name': {
    label: '조직 이름',
    what: '이 팀(조직)의 이름이에요.',
    reach: '모든 구성원과 그들이 쓰는 AI',
    when: '구성원이 다시 설치한 다음부터 반영돼요',
    where: '대화 맨 앞 머리말과 현황 제목에 나와요',
    example: '이름을 바꾸면 모두의 대화 머리말이 그 이름으로 바뀌어요.',
  },
};
function meaningOf(m) { return (m && MEANING_KO[m.key]) ? { ...m, ...MEANING_KO[m.key] } : m; }

// '이게 뭐예요?' — 기본은 화면에 설명을 깔지 않고 작은 트리거 하나만 둔다. 궁금한 사람이 누르면
//  팝업(overlay)으로 전체 설명(요약·누가/언제/어디·예시)을 보여준다. 예전엔 항상-펼침(이후 한 줄 요약+토글)
//  이라 9개 섹션마다 같은 골격이 반복돼 화면이 무거웠다(윤상민 06-22 지적: "반복·둥둥 뜸"). 단일 함수라
//  모든 섹션에 일괄 적용. tone 색·카피는 팝업 안에서 그대로 보존.
function meaningCard(m0) {
  if (!m0) return null;
  const m = meaningOf(m0);
  const tag = { critical: '꼭 지킴', identity: '신원', infra: '연결', normal: '' }[m.tone] || '';
  const trigger = el('button', { class: 'meaning-trigger', type: 'button', 'aria-haspopup': 'dialog' },
    el('span', { class: 'meaning-trigger-icon', 'aria-hidden': 'true', text: 'ⓘ' }),
    el('span', { text: '이게 뭐예요?' }));
  trigger.addEventListener('click', () => {
    overlay(m.label || '이게 뭐예요?',
      el('div', { class: 'meaning meaning-' + m.tone + ' meaning-pop' },
        el('div', { class: 'meaning-head' },
          el('span', { class: 'meaning-dot', 'aria-hidden': 'true' }),
          el('span', { class: 'meaning-title', text: '구성원에게 미치는 효과' }),
          tag ? el('span', { class: 'meaning-tag', text: tag }) : null),
        el('p', { class: 'meaning-what', text: m.what }),
        el('div', { class: 'meaning-grid' },
          meaningRow('누가 보나', m.reach),
          meaningRow('언제 적용되나', m.when),
          meaningRow('어디에 쓰이나', m.where)),
        el('div', { class: 'meaning-ex' },
          el('span', { class: 'meaning-ex-label', text: '예를 들면' }),
          el('span', { text: m.example }))));
  });
  return trigger;
}

// 섹션 제목 + 바로 옆 '이게 뭐예요?' 트리거(meaningCard 가 트리거 노드를 돌려준다). 제목 우측에 밋밋하게 붙는다.
function sectionTitle(titleText, m) {
  return el('div', { class: 'section-title' }, el('h2', { text: titleText }), meaningCard(m));
}

function adminRowMeta(key, data) {
  if (key === 'kinds') return (state.overview ? state.overview.kinds.length : 4) + '개 종류';
  // 회색 보조설명 = '이게 무슨 탭인지' 짧은 설명(개수·시각 아님). 비개발자가 한눈에 알게.
  if (key === 'profile') return '조직 이름과 서버 주소';
  if (key === 'members') return '함께 쓰는 사람';
  if (key === 'member-add') return '새 팀원 등록 + 접속 열쇠 발급';
  if (key === 'tokens') return '발급된 접속 열쇠 현황·정리';
  if (key === 'managed-policy') return 'AI가 항상 지킬 규칙';
  if (key === 'org-defaults') return '회사 배경과 AI 말투';
  if (key === 'memory') return '팀이 함께 쌓는 메모';
  if (key === 'context-ontology-guide') return '⚠️ 지식 인덱스 전체 틀 (뼈대)';
  if (key === 'domains-repos') return '지식을 정리하는 주제';
  if (key === 'wiki-categories') return '사업·제품·시스템 분류축 CRUD';
  if (key === 'hooks-group') return '세션에 자동으로 끼어드는 동작';
  if (key === 'deploy') return 'OS별 명령 복사';
  if (key === 'runtime') { const rc = data.runtimeConfig; if (!rc) return ''; const off = Object.values(rc.hooks || {}).filter((v) => v === false).length; return (off ? off + '개 훅 꺼짐' : '훅 전체 켜짐') + ' · work-roots ' + (rc.work_roots || []).length; }
  if (key === 'mcp') return (data.mcpServers || []).length + '개 서버';
  if (key === 'db-sources') return ((data.dbSources || []).length + (data.envSources || []).length) + '개 소스';
  if (key === 'hooks-preview') return '세션 주입 메시지 보기';
  if (key === 'custom-hooks') return (data.orgHooks || []).length + '개 훅';
  if (key === 'tools') { const t = (data.tools || []).filter((x) => x.kind !== 'builtin'); return t.length ? t.length + '개 툴' : '기본'; }
  return '';
}

// System 탭 진입점(#/system) — 기존 관리(전달) 화면을 그대로 흡수 + 지식 종류 레지스트리.
async function renderSystem(view, sub) {
  return renderAdmin(view, sub);
}

async function renderAdmin(view, sub) {
  let data;
  try { data = await loadAdmin(); }
  catch (e) { view.replaceChildren(errorNote(e, '관리 데이터를 불러오지 못했습니다')); return; }
  const canEdit = !!data.canEdit;
  state.admin.canEdit = canEdit;
  state.admin.canRuntime = !!data.canRuntime;
  // 어휘 CRUD 권한 — 정확히 context 스코프(admin 완화). 서버 도메인맵 CRUD 게이트가 scope:'context' 를
  //  엄격히 요구하므로(admin 자동 함의 없음 — web.ts mw), 버튼 노출도 context 보유로만 판정해 403 오작동을 막는다.
  state.admin.canContext = hasScope('context');

  // 선택 섹션 — 없거나 권한으로 숨으면 첫 노출 섹션으로(과거 디폴트 'kinds'는 가이드로 이관돼 제거).
  const visibleSections = ADMIN_SECTIONS.filter((s) => !sectionHidden(s.key, data));
  let sel = sub || state.admin.sel;
  if (!sel || !visibleSections.some((s) => s.key === sel)) sel = (visibleSections[0] || ADMIN_SECTIONS[0]).key;
  state.admin.sel = sel;
  // 활성 중분류 = 선택 섹션이 속한 그룹(URL/선택이 단일 진실 — 별도 상태 불필요).
  const activeGroup = (ADMIN_SECTIONS.find((s) => s.key === sel) || ADMIN_SECTIONS[0]).group;

  // ── 가로 중분류 바 — 클릭 시 그 분류의 첫 노출 섹션으로 이동. 권한으로 그룹 전체가 숨으면 탭도 숨김. ──
  const groupBar = el('div', { class: 'admin-cats', role: 'tablist', 'aria-label': '관리 중분류' });
  for (const g of ADMIN_GROUPS) {
    const first = visibleSections.find((s) => s.group === g.key);
    if (!first) continue;
    const on = g.key === activeGroup;
    groupBar.append(el('a', { class: 'admin-cat' + (on ? ' active' : ''), href: '#/system/' + first.key,
      role: 'tab', 'aria-selected': on ? 'true' : 'false', text: g.label }));
  }

  const list = el('div', { class: 'split-list card admin-nav' });
  // 훅 자식(런타임·커스텀·미리보기) 들여쓰기는 부모('훅')가 보일 때만 — 부모는 게이트 없어 항상 노출.
  const hookParentVisible = !sectionHidden('hooks-group', data);
  for (const s of ADMIN_SECTIONS) {
    if (s.group !== activeGroup) continue; // 활성 중분류 섹션만 좌측 nav 에.
    if (sectionHidden(s.key, data)) continue;
    const indentCls = (s.indent && hookParentVisible) ? ' admin-nav-child' : '';
    list.append(el('a', { class: 'row' + (s.key === sel ? ' sel' : '') + indentCls, href: '#/system/' + s.key },
      el('div', { class: 'row-title', text: s.label }),
      el('div', { class: 'row-meta', text: adminRowMeta(s.key, data) })));
  }
  const detail = el('div', { class: 'split-detail' });
  renderAdminDetail(detail, sel, data);

  const split = el('div', { class: 'split admin-split' }, list, detail);

  view.replaceChildren(el('div', {},
    el('div', { class: 'card-head admin-head' },
      el('div', { class: 'admin-head-l' }, el('h2', { text: '관리' })),
      canEdit
        ? el('span', { class: 'admin-sub', text: (data.profile.display_name || '조직') })
        : el('span', { class: 'admin-sub' }, el('span', { class: 'pill', text: '읽기 전용' }), ' ' + (data.profile.display_name || '조직') + ' · 보기 전용(편집은 관리자)')),
    groupBar,
    split));
  applyReveal([list, detail]);
}

function renderAdminDetail(detail, sel, data) {
  if (sel === 'kinds') return kindsRegistry(detail, data);
  if (sel === 'domains-repos') return domainsReposPanel(detail, data);
  if (sel === 'wiki-categories') return wikiCategoriesPanel(detail, data);
  if (sel === 'managed-policy' || sel === 'org-defaults' || SCAFFOLD_SECTIONS.includes(sel)) return sectionEditor(detail, sel, data);
  if (sel === 'memory') return memoryEditor(detail, data);
  if (sel === 'members') return membersEditor(detail, data);
  if (sel === 'member-add') return memberAddPanel(detail, data);
  if (sel === 'tokens') return tokensPanel(detail, data);
  if (sel === 'profile') return profileEditor(detail, data);
  if (sel === 'hooks-group') return hooksOverview(detail, data);
  if (sel === 'runtime') return runtimeEditor(detail, data);
  if (sel === 'hooks-preview') return hooksPreviewPanel(detail, data);
  if (sel === 'custom-hooks') return customHookEditor(detail, data);
  if (sel === 'tools') return toolsEditor(detail, data);
  if (sel === 'mcp') return mcpEditor(detail, data);
  if (sel === 'db-sources') return dbSourceEditor(detail, data);
  if (sel === 'deploy') return deployPanel(detail, data);
}

// ── 지식 종류 레지스트리(읽기 전용 열람) — 4 질적유형(R/K/H/W) + S/G federated + 주입정책 메타. ctx_overview 데이터 재사용. ──
function kindsRegistry(detail, data) {
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '지식 종류 레지스트리' })),
    el('p', { class: 'admin-hint', text: '통합 지식스토어가 분류하는 본질 종류(kind: R·K·H·W 4종)와, 각 종류가 구성원의 AI 세션에 어떻게 주입되는지(injection mode)입니다. 종류를 누르면 그 안의 지식 단위를 탐색합니다. S·G(구조·용어집)는 종류가 아니라 domainmap 파생(federated)으로 별도 표시됩니다.' }),
  );
  const o = state.overview;
  if (!o) {
    card.append(el('p', { class: 'admin-hint', text: '개요를 불러오는 중…' }));
    getOverview(false).then(() => { if (state.admin.sel === 'kinds') renderAdminDetail(detail, 'kinds', data); }).catch(() => {});
    detail.replaceChildren(card);
    return;
  }
  const tbl = el('table', { class: 'fields-table kinds-table' });
  tbl.append(el('tr', {},
    el('td', { class: 'kr-h', text: '종류' }), el('td', { class: 'kr-h', text: '주입 모드' }),
    el('td', { class: 'kr-h', text: '활성 단위' }), el('td', { class: 'kr-h', text: '최신 갱신' })));
  for (const k of o.kinds) {
    const meta = kindMeta(k.kind);
    const fed = isFederatedKind(k.kind);
    const row = el('tr', { class: 'kr-row', role: 'link', tabindex: '0' },
      el('td', {}, el('span', { class: 'kind-badge' }, el('span', { class: 'kb-glyph', text: k.kind }), el('span', { class: 'kb-ko', text: meta.ko || k.label || k.kind }))),
      el('td', {}, fed
        ? el('span', { class: 'inject-tag', title: 'domainmap 파생(ku 종류 아님)', text: 'federated' })
        : el('span', { class: 'inject-tag', title: INJECTION_HINT[k.injection_mode] || '', text: INJECTION_LABEL[k.injection_mode] || k.injection_mode })),
      el('td', { class: 'kr-num', text: String(k.active_count) }),
      el('td', { text: k.latest_updated_at ? relTime(k.latest_updated_at) : '—' }),
    );
    const go = () => { location.hash = '#/knowledge'; };
    row.addEventListener('click', go);
    row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
    tbl.append(row);
  }
  card.append(tbl);
  detail.replaceChildren(card);
}

// ── P-V3-4a 도메인 · 레포 통제어휘 CRUD ──
// repo>domain 계층: repo 셀렉터 + repo CRUD, 그 아래 선택 repo 의 도메인 목록 + domain CRUD.
//  domain_rename 은 soft-alias(물리 key 불변) — UI 에 그 의미를 명시한다.
// ── WIKI 카테고리 관리 — 지식(위키)의 분류축(사업·제품·시스템 카테고리) CRUD. 제품 카테고리=도메인. ──
//  카테고리 탭(#/categories)과 동일한 category-store(/api/ui/categories) — 여기 변경이 지식·프로젝트 탭 좌측에 반영.
//  space 탭으로 나누지 않고 한 화면에 전부(컴팩트 표 — fields-table 재사용). 편집은 context 스코프(없으면 읽기 전용).
async function wikiCategoriesPanel(detail, data) {
  const canEdit = state.admin.canContext;
  const reload = () => wikiCategoriesPanel(detail, data);

  detail.replaceChildren(el('div', { class: 'card' }, skeleton('카테고리를 불러오는 중')));

  // 전 space 카테고리를 한 번에 — space 별로 묶어 컴팩트 표로(탭 분리 없음).
  let bySpace;
  try {
    const lists = await Promise.all(SPACE_SUBS.map((s) =>
      api('/api/ui/categories?' + new URLSearchParams({ space: s.key })).then((d) => (d && d.categories) || [])));
    bySpace = {}; SPACE_SUBS.forEach((s, i) => { bySpace[s.key] = lists[i]; });
  } catch (e) { detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '카테고리를 불러오지 못했습니다'))); return; }

  // calm 리스트(무채·헤어라인·아웃라인 — domain-map 톤). space 별 그룹 + 균일 단일행. 빈 should 열은 두지 않는다.
  const list = el('div', { class: 'wikicat' });
  for (const s of SPACE_SUBS) {
    const items = bySpace[s.key] || [];
    const isProduct = s.key === 'product';
    const head = el('div', { class: 'wikicat-grouphead' },
      el('span', { class: 'wikicat-grouptitle', text: s.label }),
      isProduct ? el('span', { class: 'dm-tag', text: '도메인' }) : null,
      el('span', { class: 'wikicat-groupcount', text: String(items.length) }));
    if (canEdit) head.append(el('button', { class: 'btn btn-ghost btn-sm wikicat-add', text: '+ 추가', onclick: () => openCategoryForm(s.key, null, reload) }));

    const rows = el('div', { class: 'wikicat-rows' });
    if (!items.length) {
      rows.append(el('div', { class: 'wikicat-empty', text: '아직 없습니다.' }));
    } else {
      for (const c of items) {
        const should = (c.should || '').trim();
        // 정의·범위·규칙(should) — 수정에 들어가기 전에도 항상 노출. 비었으면 '있고 수정 가능'을 알리는 placeholder.
        const shouldLine = should
          ? el('span', { class: 'wikicat-should', title: should },
              el('span', { class: 'wikicat-should-label', text: '정의·범위·규칙' }), should)
          : el('span', { class: 'wikicat-should wikicat-should-empty' },
              el('span', { class: 'wikicat-should-label', text: '정의·범위·규칙' }),
              canEdit ? '미설정 — 수정에서 추가할 수 있어요' : '미설정');
        const main = el('div', { class: 'wikicat-row-main' },
          el('span', { class: 'wikicat-name', text: c.name || c.key }),
          el('span', { class: 'wikicat-key mono', text: c.key }),
          c.cross_cutting ? el('span', { class: 'dm-tag', text: '횡단' }) : null,
          shouldLine);
        const acts = canEdit ? el('div', { class: 'wikicat-row-acts' },
          el('button', { class: 'btn btn-ghost btn-sm', text: '수정', onclick: () => openCategoryForm(s.key, c, reload) }),
          el('button', { class: 'btn btn-ghost btn-sm', text: '삭제', onclick: () => deleteWikiCategory(c, reload) })) : null;
        rows.append(el('div', { class: 'wikicat-row' }, main, acts));
      }
    }
    list.append(el('div', { class: 'wikicat-group' }, head, rows));
  }

  const card = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '카테고리 설정' }),
      canEdit ? null : el('span', { class: 'admin-sub' }, el('span', { class: 'pill', text: '읽기 전용' }), ' 편집은 context 권한 필요')),
    el('p', { class: 'admin-hint', text: '지식(위키)의 분류축입니다. 사업·제품·시스템 카테고리를 한 화면에서 추가·수정·삭제하며, 변경은 지식·프로젝트 탭 좌측 카테고리에 그대로 반영됩니다. (제품 카테고리=도메인)' }),
    list);
  detail.replaceChildren(card);
}

// WIKI 카테고리 삭제(확인 후) — categoryCard 의 삭제 로직과 동일 엔드포인트. reload 로 패널 갱신.
async function deleteWikiCategory(c, reload) {
  if (!confirm('‘' + (c.name || c.key) + '’ 카테고리를 삭제할까요? (연결된 매핑·엣지도 함께 정리됩니다)')) return;
  try { await api('/api/ui/categories/' + c.id + '/delete', { method: 'POST' }); toast('삭제했습니다'); reload(); }
  catch (e) { toast('실패 — ' + e.message, true); }
}

async function domainsReposPanel(detail, data) {
  // 어휘 CRUD 는 context 스코프(admin 완화). context 없으면 읽기 전용으로 목록만.
  const canEdit = state.admin.canContext;
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '주제 분류' }),
      canEdit ? null : el('span', { class: 'admin-sub' }, el('span', { class: 'pill', text: '읽기 전용' }), ' 편집은 context 권한 필요')),
    el('p', { class: 'admin-hint', text: '주제(area)는 2단입니다 — 영역(space): 제품 도메인(코드앵커·부채추적) 또는 비즈니스 기능(GTM·가격·펀딩·시장경쟁·브랜드·조직). 도메인·기능은 자유 키워드가 아니라 레포 하위의 통제 어휘이며, 여기서 관리한 어휘만 지식 저장 시 고를 수 있습니다. 이름변경은 옛 슬러그를 보존하는 별칭 방식이라(물리 키 불변) 기존 지식이 끊기지 않습니다.' }));
  detail.replaceChildren(card);

  const repos = await loadRepos();
  let repo = state.admin.repoSel || (repos.includes(VOCAB_CRUD_DEFAULT_REPO) ? VOCAB_CRUD_DEFAULT_REPO : repos[0]);
  if (!repos.includes(repo)) repo = repos[0];
  state.admin.repoSel = repo;

  // ── repo 행 ──
  const repoSel = el('select');
  for (const r of repos) repoSel.append(el('option', { value: r, text: r }));
  repoSel.value = repo;
  repoSel.addEventListener('change', () => { state.admin.repoSel = repoSel.value; domainsReposPanel(detail, data); });

  const repoBar = el('div', { class: 'filter-bar' }, el('span', { class: 'field-label', text: '레포' }), repoSel);
  if (canEdit) {
    repoBar.append(
      el('button', { class: 'btn btn-ghost btn-sm', text: '+ 레포', onclick: () => repoCrudOverlay(null, detail, data) }),
      el('button', { class: 'btn-text', text: '이름변경', onclick: () => repoCrudOverlay({ name: repo, mode: 'rename' }, detail, data) }),
      el('button', { class: 'btn-text', text: '폐기', onclick: () => repoCrudOverlay({ name: repo, mode: 'deprecate' }, detail, data) }),
      // 영구삭제(hard-delete) — 폐기(숨김 보존)와 구분. 연결 자식이 있으면 서버가 막고 카운트 반환(2단 확인).
      el('button', { class: 'btn-text btn-text-danger', text: '영구삭제', onclick: () => deleteRepoFlow(repo, detail, data) }));
  }
  card.append(repoBar);

  // ── 도메인 목록 ──
  const slot = await loadDomains(repo, true); // force: CRUD 직후 최신 반영
  if (slot.error) { card.append(el('p', { class: 'admin-hint', text: '도메인 목록을 불러오지 못했습니다 — ' + slot.error })); return; }

  // 어휘를 영역(space)별로 분리 — 제품 도메인(코드앵커) / 비즈니스 기능(vocab-only). 각각 별도 CRUD.
  const bySpace = { product: [], business: [] };
  for (const d of slot.list) { const sp = (d.space || 'product') === 'business' ? 'business' : 'product'; bySpace[sp].push(d); }

  const SPACE_SECTIONS = [
    { space: 'product', title: '제품 도메인', addLabel: '+ 새 도메인', empty: '이 레포에 제품 도메인이 없습니다. + 새 도메인으로 통제 어휘를 추가하세요.',
      hint: '코드앵커·부채추적이 붙는 제품 영역입니다.' },
    { space: 'business', title: '비즈니스 기능', addLabel: '+ 새 비즈니스 기능', empty: '비즈니스 기능이 없습니다. + 새 비즈니스 기능으로 추가하세요(코드매핑 없음).',
      hint: 'GTM·가격·펀딩·시장경쟁·브랜드·조직 등 코드매핑 없는 비즈니스 영역입니다(vocab-only).' },
  ];
  for (const sec of SPACE_SECTIONS) {
    const items = bySpace[sec.space];
    const head = el('div', { class: 'card-head', style: 'margin-top:14px' }, el('h3', { text: sec.title + ' (' + items.length + ')' }));
    if (canEdit) head.append(el('button', { class: 'btn btn-primary btn-sm', text: sec.addLabel, onclick: () => domainCrudOverlay(null, repo, detail, data, sec.space) }));
    card.append(head);
    card.append(el('p', { class: 'admin-hint', text: sec.hint }));
    if (!items.length) { card.append(el('p', { class: 'empty', text: sec.empty })); continue; }
    const tbl = el('table', { class: 'fields-table' });
    tbl.append(el('tr', {}, el('td', { class: 'kr-h', text: '슬러그(key)' }), el('td', { class: 'kr-h', text: '이름' }), el('td', { class: 'kr-h', text: '상태' }), canEdit ? el('td', { class: 'kr-h', text: '' }) : null));
    for (const d of items) {
      const noun = sec.space === 'business' ? '비즈니스 기능' : '도메인';
      const actions = canEdit ? el('td', { class: 'row-actions' },
        el('button', { class: 'btn-text', text: '이름변경', onclick: () => domainCrudOverlay(d, repo, detail, data, sec.space) }),
        // 폐기(deprecate) — 숨김 보존(기존 매핑 유효). 영구삭제(hard-delete)와 구분.
        d.state === 'deprecated'
          ? null
          : el('button', { class: 'btn-text', text: '폐기', onclick: () => deprecateDomainFlow(d, repo, detail, data, noun) }),
        // 영구삭제 — 연결(매핑·귀속 ku)이 있으면 서버가 막고 카운트 반환(2단 확인 다이얼로그).
        el('button', { class: 'btn-text btn-text-danger', text: '영구삭제', onclick: () => deleteDomainFlow(d, repo, detail, data, noun) })) : null;
      tbl.append(el('tr', {},
        el('td', {}, el('span', { class: 'mono', text: d.key })),
        el('td', { text: d.name || '—' }),
        el('td', { text: (d.state === 'deprecated' ? '폐기' : '활성') + (d.cross_cutting ? ' · 횡단' : '') }),
        actions));
    }
    card.append(tbl);
  }

  // ── P-V3-4b: 프로젝트(이니셔티브 vs 코드 그룹) — '붕뜸' 해소 설명 + provenance_kind 구분 목록 ──
  //  읽기 전용(GET projects 프록시). 두 종이 한 테이블에 섞여 헷갈리던 것을 사람이 이해하도록 명문화.
  renderProjectsSection(card, repo);
}

// 프로젝트 목록 — provenance_kind 로 이니셔티브/코드 그룹을 갈라 보여준다(붕뜸 해소의 사람 이해 표면).
async function renderProjectsSection(card, repo) {
  card.append(el('div', { class: 'card-head', style: 'margin-top:18px' }, el('h3', { text: '프로젝트' })));
  card.append(el('p', { class: 'admin-hint' },
    '한 ‘프로젝트’ 칸에는 의미가 다른 두 종류가 들어 있습니다. ',
    el('b', { text: '이니셔티브' }), '는 PM 도구(ClickUp 등)에서 사람이 선언한 실제 과제로, 작업(W) 단위가 여기에 연결됩니다. ',
    el('b', { text: '코드 그룹' }), '은 문서·코드에서 자동으로 묶인 코드 단위 묶음입니다. 이 둘을 구분해 표시합니다.'));
  let rows;
  try { rows = await api('/api/ui/domainmap/' + encodeURIComponent(repo) + '/projects'); }
  catch (e) { card.append(el('p', { class: 'admin-hint', text: '프로젝트 목록을 불러오지 못했습니다 — ' + (e.message || '') })); return; }
  rows = Array.isArray(rows) ? rows : [];
  const groups = [
    { kind: 'initiative', label: '이니셔티브 (PM 도구 출처 · 작업 연결 대상)', dot: 'ok' },
    { kind: 'code_grouping', label: '코드 그룹 (문서·코드 파생)', dot: 'dim' },
  ];
  for (const g of groups) {
    const items = rows.filter((p) => (p.provenance_kind || 'code_grouping') === g.kind);
    if (!items.length) continue;
    const sub = el('div', { class: 'card-head', style: 'margin-top:10px' },
      el('h4', {}, el('span', { class: 'dot6 ' + g.dot, 'aria-hidden': 'true' }), ' ' + g.label + ' (' + items.length + ')'));
    card.append(sub);
    const ptbl = el('table', { class: 'fields-table' });
    const isInit = g.kind === 'initiative';
    ptbl.append(el('tr', {},
      el('td', { class: 'kr-h', text: '슬러그(key)' }), el('td', { class: 'kr-h', text: '이름' }),
      el('td', { class: 'kr-h', text: isInit ? '출처' : '코드 touch' })));
    for (const p of items) {
      ptbl.append(el('tr', {},
        el('td', {}, el('span', { class: 'mono', text: p.key })),
        el('td', { text: p.name || '—' }),
        el('td', { text: isInit ? (p.prov_system || '사람 큐레이션') : String(p.touched_code || 0) })));
    }
    card.append(ptbl);
  }
}

// ── 도메인/레포 비활(deprecate)·영구삭제(hard-delete) 플로우 ──
//  윤상민 결정: 어휘 삭제 = 비활(가역·숨김) + 영구삭제(비가역·hard-delete) 둘 다 제공. 권한: hard-delete 는
//  사람(웹) 전용(서버가 agent 403). UI 가드: 연결이 있으면 서버가 blocked+카운트를 주므로 2단 확인으로 force.

// 도메인 id 해소 — 목록(loadDomains)엔 key 만 있어, id 가 필요한 deprecate/delete 전에 :repo/domains 에서 찾는다.
async function resolveDomainId(repo, key) {
  const rows = await api('/api/ui/domainmap/' + encodeURIComponent(repo) + '/domains');
  const dom = (Array.isArray(rows) ? rows : []).find((x) => x.key === key);
  return dom ? dom.id : null;
}

async function deprecateDomainFlow(d, repo, detail, data, noun) {
  if (!confirm(`${noun} '${d.key}'를 폐기(숨김)하시겠습니까?\n\n기존 매핑·지식은 보존되고 목록에서 숨김 신호만 남습니다(가역 — 영구삭제 아님).`)) return;
  try {
    const id = await resolveDomainId(repo, d.key);
    if (!id) { toast('도메인 id 를 찾지 못했습니다', true); return; }
    await api('/api/ui/domainmap/domain/' + id + '/deprecate', { method: 'POST', body: JSON.stringify({}) });
    toast(noun + ' 폐기됨(숨김)');
    domainsReposPanel(detail, data);
  } catch (e) { toast('실패 — ' + e.message, true); }
}

async function deleteDomainFlow(d, repo, detail, data, noun) {
  let id;
  try {
    id = await resolveDomainId(repo, d.key);
    if (!id) { toast('도메인 id 를 찾지 못했습니다', true); return; }
  } catch (e) { toast('실패 — ' + e.message, true); return; }
  // 1차 확인 — 비가역 경고. force 없이 호출해 연결 카운트를 먼저 확인(서버가 blocked 면 카운트 반환).
  if (!confirm(`${noun} '${d.key}'를 영구삭제하시겠습니까?\n\n폐기(숨김)와 달리 행 자체가 사라집니다(비가역). 귀속된 지식 단위는 보존되고 도메인 표시만 비워집니다.`)) return;
  try {
    const r = await api('/api/ui/domainmap/domain/' + id + '/delete', { method: 'POST', body: JSON.stringify({}) });
    if (r && r.blocked) {
      // 연결이 있어 막힘 — 카운트를 보여주고 2차(force) 확인.
      const refs = r.refs || {};
      const msg = `${noun} '${d.key}'에 연결이 있습니다:\n` +
        `· 도메인맵 매핑 ${refs.mappings || 0}건\n` +
        `· 귀속 지식(active) ${refs.ku_active || 0}건 / 전체 ${refs.ku_total || 0}건\n` +
        `· 다중귀속(kud) ${refs.kud_rows || 0}건\n\n` +
        `그래도 영구삭제하면 매핑·별칭은 삭제되고, 지식 단위는 보존되되 이 도메인 표시만 비워집니다(domain_key 클리어). 계속할까요?`;
      if (!confirm(msg)) return;
      await api('/api/ui/domainmap/domain/' + id + '/delete', { method: 'POST', body: JSON.stringify({ force: true }) });
      toast(noun + ' 영구삭제됨(연결 정리)');
    } else {
      toast(noun + ' 영구삭제됨');
    }
    state.allDomains = null; // 통합 도메인 캐시 무효화(좌측 위계/드롭다운 갱신)
    domainsReposPanel(detail, data);
  } catch (e) { toast('실패 — ' + e.message, true); }
}

async function deleteRepoFlow(repo, detail, data) {
  if (!confirm(`레포 '${repo}'를 영구삭제하시겠습니까?\n\n폐기(숨김)와 달리 레포와 그 하위 전체(도메인·코드유닛·매핑·프로젝트·부채)가 사라집니다(비가역).`)) return;
  try {
    const r = await api('/api/ui/domainmap/repo/delete', { method: 'POST', body: JSON.stringify({ name: repo }) });
    if (r && r.blocked) {
      const refs = r.refs || {};
      const msg = `레포 '${repo}'에 살아있는 자식이 있습니다:\n` +
        `· 도메인 ${refs.domains || 0}개\n· 코드유닛 ${refs.code_units || 0}개\n· 데이터엔티티 ${refs.data_entities || 0}개\n\n` +
        `그래도 영구삭제하면 이 자식들이 모두 함께 삭제됩니다(cascade). 계속할까요?`;
      if (!confirm(msg)) return;
      await api('/api/ui/domainmap/repo/delete', { method: 'POST', body: JSON.stringify({ name: repo, force: true }) });
      toast('레포 영구삭제됨(하위 cascade)');
    } else {
      toast('레포 영구삭제됨');
    }
    state.domains.__repos__ = null; state.admin.repoSel = null; state.allDomains = null;
    domainsReposPanel(detail, data);
  } catch (e) { toast('실패 — ' + e.message, true); }
}

// repo create/rename/deprecate 오버레이.
function repoCrudOverlay(opt, detail, data) {
  const isNew = !opt;
  const mode = opt && opt.mode;
  if (mode === 'deprecate') {
    if (!confirm(`레포 '${opt.name}'를 폐기하시겠습니까? (도메인·매핑은 보존되고 목록에서 숨김 신호만 남습니다)`)) return;
    api('/api/ui/domainmap/repo/deprecate', { method: 'POST', body: JSON.stringify({ name: opt.name }) })
      .then(() => { toast('레포 폐기됨'); domainsReposPanel(detail, data); })
      .catch((e) => toast('실패 — ' + e.message, true));
    return;
  }
  const nameIn = el('input', { type: 'text', value: isNew ? '' : '', placeholder: 'A-Za-z0-9._- (예: lively-app)' });
  const back = overlayBox(isNew ? '새 레포' : `레포 이름변경 — ${opt.name}`,
    el('p', { class: 'admin-hint', text: isNew ? '도메인의 상위 통제 계층입니다. 보호 리포(lively 등) 이름은 거부됩니다.' : '레포는 도메인맵 자기완결 엔티티라 물리 이름변경이 안전합니다(도메인·매핑 보존).' }),
    field(isNew ? '레포 이름' : '새 이름', nameIn));
  const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '생성' : '변경' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  saveBtn.addEventListener('click', async () => {
    const v = nameIn.value.trim();
    if (!v) { toast('이름을 입력하세요', true); return; }
    saveBtn.disabled = true;
    try {
      if (isNew) { await api('/api/ui/domainmap/repo/create', { method: 'POST', body: JSON.stringify({ name: v }) }); state.admin.repoSel = v; toast('레포 생성됨'); }
      else { await api('/api/ui/domainmap/repo/rename', { method: 'POST', body: JSON.stringify({ name: opt.name, newName: v }) }); state.admin.repoSel = v; toast('레포 이름변경됨'); }
      state.domains.__repos__ = null; // repo 목록 캐시 무효화
      back.remove(); domainsReposPanel(detail, data);
    } catch (e) { saveBtn.disabled = false; toast('실패 — ' + e.message, true); }
  });
  back.querySelector('.ov-box').append(el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
}

// domain create/rename 오버레이. rename 은 soft-alias(물리 key 불변) 명시.
//  space(product|business): create 시 area 1차 영역. product=제품 도메인(코드앵커)·business=비즈니스 기능(vocab-only).
//   서버 domain_create 가 space 인자를 받는다(미지정 시 product 기본). rename 은 space 불변(생성 시 결정).
function domainCrudOverlay(d, repo, detail, data, space) {
  const isNew = !d;
  const sp = space === 'business' ? 'business' : 'product';
  const isBiz = sp === 'business';
  const nounNew = isBiz ? '비즈니스 기능' : '도메인';
  const keyIn = el('input', { type: 'text', value: isNew ? '' : d.key, placeholder: isBiz ? '소문자 슬러그 (예: gtm)' : '소문자 슬러그 (예: billing)', disabled: isNew ? null : '' });
  const nameIn = el('input', { type: 'text', value: isNew ? '' : (d.name || ''), placeholder: isBiz ? '표시 이름 (예: 시장 진입)' : '표시 이름 (예: 결제)' });
  const newKeyIn = isNew ? null : el('input', { type: 'text', value: '', placeholder: '새 슬러그(선택) — 옛 슬러그는 별칭으로 보존' });
  const back = overlayBox(isNew ? `새 ${nounNew} — ${repo}` : `${nounNew} 이름변경 — ${d.key}`,
    el('p', { class: 'admin-hint', text: isNew
      ? (isBiz ? '비즈니스 기능을 추가합니다(코드매핑 없는 vocab-only 어휘). 슬러그는 소문자·숫자·하이픈만.' : '레포 하위 제품 도메인 통제 어휘를 추가합니다. 슬러그는 소문자·숫자·하이픈만.')
      : '이름변경은 soft-alias 방식입니다 — 물리 슬러그(key)는 바뀌지 않고, 새 슬러그를 적으면 별칭으로 적재됩니다. 기존 지식의 옛 슬러그는 그대로 이를 가리킵니다(끊기지 않음).' }),
    isNew ? field('슬러그(key)', keyIn) : field('현재 슬러그(불변)', keyIn),
    field(isNew ? '표시 이름' : '새 표시 이름', nameIn),
    newKeyIn ? field('새 슬러그(선택)', newKeyIn) : null);
  const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '생성' : '변경' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      if (isNew) {
        const key = keyIn.value.trim(), name = nameIn.value.trim();
        if (!key || !name) { toast('슬러그와 이름이 필요합니다', true); saveBtn.disabled = false; return; }
        await api('/api/ui/domainmap/domain/create', { method: 'POST', body: JSON.stringify({ repo, key, name, space: sp }) });
        toast(nounNew + ' 생성됨');
      } else {
        const newKey = newKeyIn.value.trim(), newName = nameIn.value.trim();
        const payload = {};
        if (newName && newName !== d.name) payload.newName = newName;
        if (newKey) payload.newKey = newKey;
        if (!payload.newName && !payload.newKey) { toast('변경할 새 이름 또는 새 슬러그를 입력하세요', true); saveBtn.disabled = false; return; }
        // rename 은 도메인 id 가 필요 — 목록에는 key 만 있어 id 를 도메인 상세에서 확인. domain_list 는 id 포함.
        const dom = (await api('/api/ui/domainmap/' + encodeURIComponent(repo) + '/domains')).find((x) => x.key === d.key);
        if (!dom) { toast('도메인 id 를 찾지 못했습니다', true); saveBtn.disabled = false; return; }
        await api('/api/ui/domainmap/domain/' + dom.id + '/rename', { method: 'POST', body: JSON.stringify(payload) });
        toast('도메인 이름변경됨 (옛 슬러그는 별칭으로 보존)');
      }
      back.remove(); domainsReposPanel(detail, data);
    } catch (e) { saveBtn.disabled = false; toast('실패 — ' + e.message, true); }
  });
  back.querySelector('.ov-box').append(el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
}

// ── 섹션(강제규칙·회사맥락) markdown 에디터 — 기본은 구성원에게 보이는 읽기 전용 뷰, 관리자는 [수정]을 눌러야 편집 ──
function sectionEditor(detail, key, data) {
  const canEdit = state.admin.canEdit;
  const meaning = data.meaning[key];
  const sec = data.sections[key] || { body_md: '', version: 0 };
  const title = meaning ? meaningOf(meaning).label : key;
  const isScaffold = SCAFFOLD_SECTIONS.includes(key);
  // 골격 섹션 기본값(되돌리기·미편집 프리필) — 서버가 sectionDefaults 로 내려준다. 없으면 현재 본문 폴백(안전).
  const defaultBody = (data.sectionDefaults && data.sectionDefaults[key]) || sec.body_md || '';

  // editing 은 로컬 상태 — 섹션에 진입(renderAdminDetail 재호출)할 때마다 항상 읽기 전용으로 시작.
  //  prefill 지정 시 textarea 를 그 값으로 채운다(되돌리기에서 기본값 프리필 — 저장 전까지 DB 미반영).
  function render(editing, prefill) {
    const ta = el('textarea', { rows: '18', class: 'admin-ta', 'aria-label': title });
    ta.value = (prefill != null) ? prefill : (sec.body_md || '');
    ta.readOnly = !editing;

    // 기본값으로 되돌리기 — 골격 섹션은 읽기/수정 모두 상단에 노출(발견성). 클릭=텍스트영역에 기본값 채움(저장은 [저장]으로 확정).
    const resetToDefault = () => {
      toast('기본값을 불러왔어요 — [저장]을 눌러 확정하세요');
      if (editing) { ta.value = defaultBody; ta.focus(); }
      else render(true, defaultBody); // 보기 모드면 기본값 채운 수정 모드로 진입
    };
    // 미리보기 — 가이드 섹션은 '이 편집 부분만'(${area}/${rules} 채워진 인덱스), 그 외는 전체 멤버 컨텍스트.
    const headBtns = el('div', { class: 'card-head-actions' },
      el('button', { class: 'btn btn-ghost btn-sm', text: '미리보기',
        onclick: isScaffold ? (() => showGuidePreview(ta.value)) : showMemberPreview }),
      (canEdit && isScaffold)
        ? el('button', { class: 'btn btn-ghost btn-sm', text: '기본값으로 되돌리기', onclick: resetToDefault })
        : null,
      canEdit
        ? (editing
            ? el('button', { class: 'btn btn-ghost btn-sm', text: '보기', onclick: () => render(false) })
            : el('button', { class: 'btn btn-primary btn-sm', text: '수정', onclick: () => render(true) }))
        : null);

    const body = [
      el('div', { class: 'card-head' },
        el('div', { class: 'section-title' }, el('h2', { text: title }), meaningCard(meaning)),
        headBtns),
    ];
    // 골격 섹션 — 비개발자용 경고 배너(무엇인지 한 줄 + 공통 위험 안내). 읽기/수정 모두 항상 표시.
    if (isScaffold) {
      body.push(el('div', { class: 'admin-warn' },
        el('div', { text: SCAFFOLD_WARN[key] || '' }),
        el('div', { style: 'margin-top:5px;font-weight:500', text: SCAFFOLD_WARN_COMMON })));
    }
    body.push(el('p', { class: 'admin-hint', text: editing
        ? '여기 적은 내용은 [저장]하면 구성원이 다음 설치/업데이트 때 자동으로 받아요(저장 전엔 나만 보는 초안).'
        : (canEdit ? '구성원에게 보이는 모습이에요. 고치려면 [수정]을 누르세요.' : '읽기 전용 — 이 내용이 모든 구성원의 AI에 깔립니다.') }));
    // 가이드 섹션 — 플레이스홀더(${area}/${rules}) 안내. [미리보기]로 채워진 실제 모습을 볼 수 있다고 덧붙임.
    if (isScaffold) {
      body.push(el('p', { class: 'admin-hint', text: GUIDE_PLACEHOLDER_HINT + ' [미리보기]로 실제 채워진 모습을 볼 수 있어요.' }));
    }
    body.push(ta);

    if (editing) {
      const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
      const status = el('span', { class: 'admin-status' });
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        try {
          const r = await api('/api/ui/org/section', { method: 'POST', body: JSON.stringify({ section: key, body_md: ta.value }) });
          data.sections[key] = r.section;
          sec.body_md = r.section.body_md; sec.version = r.section.version; // [보기] 전환 시 최신본 노출
          status.textContent = '저장됨 · v' + r.section.version;
          toast('저장됨 — 구성원이 다음 설치/업데이트 때 자동으로 받아요');
        } catch (e) { toast(e.message, true); status.textContent = ''; }
        saveBtn.disabled = false;
      });
      // '기본값으로 되돌리기'는 상단 버튼 줄(headBtns)로 이동 — 읽기/수정 모두에서 보이게(발견성).
      body.push(el('div', { class: 'admin-actions' }, saveBtn, status));
    }

    detail.replaceChildren(el('div', { class: 'card' }, ...body));
  }

  render(false);
}

// 멤버가 실제 읽는 컨텍스트 미리보기(WYSIWYG) — 오버레이.
async function showMemberPreview() {
  try {
    const r = await api('/api/ui/org/preview');
    overlay('구성원의 AI가 매 세션 실제로 읽는 내용',
      el('p', { class: 'admin-hint', text: '아래가 모든 구성원의 대화 첫머리에 주입되는 정적 컨텍스트입니다(라이브 현황은 별도로 매 세션 자동 추가).' }),
      el('pre', { class: 'admin-preview', text: r.context || '(비어 있음)' }));
  } catch (e) { toast(e.message, true); }
}

// 컨텍스트 온톨로지 가이드 미리보기 — '이 편집 부분만'(${area}/${rules} 채워진 Knowledge Index). 편집 중 textarea 값을 보낸다(미저장 반영).
async function showGuidePreview(bodyMd) {
  try {
    const r = await api('/api/ui/org/guide-preview', { method: 'POST', body: JSON.stringify({ body_md: bodyMd || '' }) });
    overlay('이 가이드가 실제 주입되는 모습 (주제·강제규칙 자동 채움)',
      el('p', { class: 'admin-hint', text: '아래는 이 편집 내용의 ${area}·${rules} 가 실제 데이터로 채워져 매 대화에 주입되는 부분입니다(회사 규칙·소개 등 다른 부분은 제외).' }),
      el('pre', { class: 'admin-preview', text: r.context || '(비어 있음)' }));
  } catch (e) { toast(e.message, true); }
}

// ── 구성원 ──
function membersEditor(detail, data) {
  const canEdit = state.admin.canEdit;
  const meaning = data.meaning['member'];
  const sel = state.admin.memberSel;
  const listCol = el('div', { class: 'admin-sublist' });
  // 새 구성원 추가는 [구성원 추가] 섹션으로 분리됨 — 여기선 기존 구성원의 보기/수정만.
  for (const m of data.members) {
    const meta = canEdit
      ? (m.kind || 'human') + (m.email ? ' · ' + m.email : '')
      : (m.kind || 'human') + (m.state && m.state !== 'active' ? ' · ' + m.state : '');
    listCol.append(el('div', { class: 'mini-row' + (m.id === sel ? ' sel' : ''),
      // 다른 구성원을 고르면 편집모드 해제 — 항상 보기 모드로 먼저 연다([수정] 눌러야 편집).
      onclick: () => { state.admin.memberSel = m.id; state.admin.memberEditing = false; renderAdminDetail(detail, 'members', data); } },
      el('div', { class: 'mini-title', text: (m.display_name || m.id) },
        canEdit ? (m.hasToken ? el('span', { class: 'pill pill-ok', text: '설치됨' }) : el('span', { class: 'pill', text: '미설치' })) : null),
      el('div', { class: 'mini-meta', text: meta })));
  }
  const right = el('div', {});
  const member = data.members.find((m) => m.id === sel);
  // 기존 구성원은 [수정]을 눌러 편집모드(state.admin.memberEditing)일 때만 편집폼,
  //  그 전엔 보기 모드(memberRead) — 권한 없는 사람은 [수정] 버튼 자체가 없다(읽기 전용).
  if (member && state.admin.memberEditing) memberForm(right, member, data, detail, false);
  else if (member) memberRead(right, member, data, detail);
  else right.append(el('p', { class: 'admin-hint', text: canEdit ? '왼쪽에서 구성원을 고르세요. 새 구성원은 [구성원 추가] 탭에서.' : '읽기 전용 — 이름·종류만 표시됩니다(이메일·계정·권한은 관리자만).' }));

  detail.replaceChildren(el('div', { class: 'card' },
    sectionTitle('구성원 관리', meaning),
    el('div', { class: 'admin-two admin-two-cols' }, listCol, right))); // 이 탭만 좌우 2단 유지
}

// 구성원 권한(scope) 옵션 — 보기/편집 공유. 서버 SCOPES(capabilities/scopes.ts) 전체와 일치시킨다.
const MEMBER_SCOPE_OPTS = [
  ['items', '아이템 조회'], ['context', '컨텍스트'], ['memory', '지식·메모리'],
  ['db', 'DB 조회'], ['code', '코드 도구'],
  ['admin', '관리자(편집·적용)'], ['runtime', '런타임(훅·툴 정의)'],
];
const MEMBER_SCOPE_LABEL = Object.fromEntries(MEMBER_SCOPE_OPTS);

// ── 구성원 보기 모드 — [수정]을 누르기 전 기본 화면. 폼이 아니라 읽기 전용 요약을 보여준다. ──
//  권한 있는 사람(canEdit)만 [수정] 버튼이 보이고, 누르면 편집모드로 전환(memberForm). 비-admin 은 버튼 없음.
function memberRead(root, m, data, detail) {
  const canEdit = state.admin.canEdit;
  const roRow = (label, value) => field(label, el('div', { class: 'admin-ro', text: value || '—' }));
  const kids = [
    el('div', { class: 'member-read-head' },
      el('h3', { text: m.display_name || m.id }),
      canEdit ? (m.hasToken ? el('span', { class: 'pill pill-ok', text: '설치됨' }) : el('span', { class: 'pill', text: '미설치' })) : null),
  ];
  if (canEdit) {
    const idnText = (m.identities && m.identities.length)
      ? m.identities.map((idn) => idn.system + ':' + idn.external_id + (idn.email ? ' (' + idn.email + ')' : '')).join('\n')
      : '';
    const scopeText = (m.scopes || []).map((sk) => MEMBER_SCOPE_LABEL[sk] ? MEMBER_SCOPE_LABEL[sk] + ' (' + sk + ')' : sk).join(', ');
    kids.push(
      roRow('아이디', m.id),
      roRow('종류', m.kind || 'human'),
      roRow('대표 이메일', m.email),
      roRow('상태', (m.state || 'active') === 'active' ? '활성' : '비활성'),
      roRow('권한 (이 구성원 토큰의 scope)', scopeText),
      field('외부 계정 연결 (신원 매칭 키)', el('div', { class: 'admin-ro admin-ro-pre', text: idnText || '—' })),
      field('개인 레이어', el('div', { class: 'admin-ro admin-ro-pre', text: (m.body_md && m.body_md.trim()) || '—' })));
  } else {
    kids.push(el('div', { class: 'mini-meta', text: '종류: ' + (m.kind || 'human') + ' · 상태: ' + (m.state || 'active') }));
  }
  if (canEdit) {
    kids.push(el('div', { class: 'admin-actions' },
      el('button', { class: 'btn btn-primary', text: '수정',
        onclick: () => { state.admin.memberEditing = true; renderAdminDetail(detail, 'members', data); } })));
  }
  root.replaceChildren(...kids);
}

// opts(선택): { saveLabel, onSaved(payload), showCancel(기본 true), onCancel, showRemove(기본 !isNew) }
//  기본 동작은 [구성원 관리] 섹션용(저장 후 보기 모드 복귀). [구성원 추가] 섹션이 onSaved 등으로 재정의해 재사용.
function memberForm(root, m, data, detail, isNew, opts = {}) {
  // 읽기 전용(비-admin): 폼 대신 요약(민감 필드는 서버가 이미 redact). (정상 흐름은 memberRead 가 처리 — 안전망.)
  if (!state.admin.canEdit) { memberRead(root, m, data, detail); return; }
  const idIn = el('input', { type: 'text', value: m.id, placeholder: '아이디(영문/숫자, 예: yoon)', disabled: isNew ? null : '' });
  const nameIn = el('input', { type: 'text', value: m.display_name || '', placeholder: '표시 이름' });
  const emailIn = el('input', { type: 'text', value: m.email || '', placeholder: '대표 이메일(매칭 키)' });
  const kindSel = el('select', {}, ...['human', 'agent', 'system'].map((k) => el('option', { value: k, text: k })));
  kindSel.value = m.kind || 'human';
  const stateSel = el('select', {}, ...['active', 'inactive'].map((k) => el('option', { value: k, text: k === 'active' ? '활성' : '비활성' })));
  stateSel.value = m.state || 'active';
  const bodyTa = el('textarea', { rows: '4', placeholder: '개인 레이어(역할/호칭/담당 — 선택)' });
  bodyTa.value = m.body_md || '';

  // 권한(scopes) — 이 구성원이 받는 토큰의 권한. 변경 시 활성 토큰에도 즉시 반영(서버).
  //  체크박스에 없는 권한은 저장 시 보존(아래 보존 로직이 안전망).
  const SCOPE_OPTS = MEMBER_SCOPE_OPTS;
  const scopeChks = {};
  const scopeWrap = el('div', { class: 'scope-wrap' });
  for (const [sk, label] of SCOPE_OPTS) {
    const chk = el('input', { type: 'checkbox' });
    chk.checked = (m.scopes || []).includes(sk);
    scopeChks[sk] = chk;
    scopeWrap.append(el('label', { class: 'admin-check scope-opt' }, chk, ' ' + label + ' (' + sk + ')'));
  }

  // 외부 계정 연결(identities) — 신원 매칭 키. 구조화 행 + 추가/삭제.
  const idnWrap = el('div', { class: 'idn-wrap' });
  const idnRows = [];
  function addIdn(idn) {
    const sysIn = el('input', { type: 'text', value: (idn && idn.system) || '', placeholder: 'slack / discord / notion …', class: 'idn-sys' });
    const extIn = el('input', { type: 'text', value: (idn && idn.external_id) || '', placeholder: '외부 계정 ID', class: 'idn-ext' });
    const emIn = el('input', { type: 'text', value: (idn && idn.email) || '', placeholder: '이메일(선택)', class: 'idn-em' });
    const rm = el('button', { class: 'btn-text', text: '✕', title: '삭제' });
    const row = el('div', { class: 'idn-row' }, sysIn, extIn, emIn, rm);
    const rec = { row, sysIn, extIn, emIn };
    rm.addEventListener('click', () => { row.remove(); const i = idnRows.indexOf(rec); if (i >= 0) idnRows.splice(i, 1); });
    idnRows.push(rec);
    idnWrap.append(row);
  }
  (m.identities || []).forEach(addIdn);

  const saveBtn = el('button', { class: 'btn btn-primary', text: opts.saveLabel || (isNew ? '추가' : '저장') });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    const identities = idnRows.map((r) => ({ system: r.sysIn.value.trim(), external_id: r.extIn.value.trim(), email: r.emIn.value.trim() || undefined }))
      .filter((x) => x.system && x.external_id);
    const knownScopes = SCOPE_OPTS.map(([sk]) => sk);
    const payload = {
      id: idIn.value.trim(), kind: kindSel.value, display_name: nameIn.value.trim(),
      email: emailIn.value.trim(), identities, body_md: bodyTa.value, state: stateSel.value,
      // 체크된 권한 + 체크박스에 없는 권한은 보존 — 목록 누락으로 권한이 조용히 드롭되는 것 방지(안전망).
      scopes: [...knownScopes.filter((sk) => scopeChks[sk].checked), ...(m.scopes || []).filter((sk) => !knownScopes.includes(sk))],
    };
    if (!payload.id) { toast('아이디는 필수입니다', true); return; }
    saveBtn.disabled = true;
    try {
      await api('/api/ui/org/member', { method: 'POST', body: JSON.stringify(payload) });
      await loadAdmin(true);
      if (opts.onSaved) { opts.onSaved(payload); return; }
      state.admin.memberSel = payload.id;
      state.admin.memberEditing = false; // 저장 후 보기 모드로 복귀
      toast('저장됨 — 신원 매칭에 즉시 반영됩니다');
      renderAdminDetail(detail, 'members', state.admin.data);
    } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  });

  const actions = el('div', { class: 'admin-actions' }, saveBtn);
  // 취소 — 편집을 버리고 보기 모드로(신규는 선택 해제). opts.showCancel=false 면 숨김.
  if (opts.showCancel !== false) {
    actions.append(el('button', { class: 'btn btn-ghost', text: '취소',
      onclick: () => {
        if (opts.onCancel) { opts.onCancel(); return; }
        state.admin.memberEditing = false;
        if (isNew) state.admin.memberSel = null;
        renderAdminDetail(detail, 'members', data);
      } }));
  }
  actions.append(status);
  const showRemove = opts.showRemove !== undefined ? opts.showRemove : !isNew;
  if (showRemove) {
    // 토큰 발급은 [구성원 추가] 탭에서 — 여기(구성원 관리)선 신원/권한 편집만.
    actions.append(el('button', { class: 'btn-text', text: '제거',
      onclick: async () => {
        if (!confirm(`구성원 '${m.display_name || m.id}' 제거?`)) return;
        try { await api('/api/ui/org/member/remove', { method: 'POST', body: JSON.stringify({ id: m.id }) });
          await loadAdmin(true); state.admin.memberSel = null; toast('제거됨'); renderAdminDetail(detail, 'members', state.admin.data); }
        catch (e) { toast(e.message, true); }
      } }));
  }

  root.replaceChildren(
    field('아이디', idIn), field('표시 이름', nameIn), field('종류', kindSel),
    field('대표 이메일', emailIn), field('상태', stateSel),
    field('권한 (이 구성원 토큰의 scope)', scopeWrap),
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '외부 계정 연결 (신원 매칭 키)' }), idnWrap,
      el('button', { class: 'btn-text', text: '+ 계정 추가', onclick: () => addIdn(null) })),
    field('개인 레이어', bodyTa),
    actions);
}

// ── 구성원 추가 — 새 팀원 등록 + 접속 열쇠(토큰) 발급을 한 곳에서. admin 전용([구성원 관리]에서 분리). ──
function memberAddPanel(detail, data) {
  const gw = (data.profile.gateway_url || window.location.origin).replace(/\/mcp$/, '').replace(/\/$/, '');
  const card = el('div', { class: 'card' },
    sectionTitle('구성원 추가', data.meaning['member']),
    el('p', { class: 'admin-hint', text: '새 팀원을 등록하고, 그 사람의 접속 열쇠(토큰)를 발급해 전달하세요. ① 아래에서 구성원을 등록하면 ② 접속 열쇠 발급 목록에 나타납니다.' }));

  // ① 새 구성원 등록 — memberForm(신규) 재사용. 등록 성공 시 토큰 발급으로 자연스럽게 이어지도록 패널을 재렌더(그 구성원 미리선택).
  card.append(el('h3', { class: 'member-add-step', text: '① 새 구성원 등록' }));
  const formHost = el('div', {});
  const blank = { id: '', kind: 'human', display_name: '', email: '', identities: [], body_md: '', state: 'active', scopes: ['items', 'context'] };
  memberForm(formHost, blank, data, detail, true, {
    saveLabel: '구성원 등록',
    showCancel: false,
    showRemove: false,
    onSaved: (payload) => {
      state.admin.memberAddPreselect = payload.id;
      toast('구성원 등록됨 — 아래에서 접속 열쇠를 발급해 전달하세요');
      renderAdminDetail(detail, 'member-add', state.admin.data);
    },
  });
  card.append(formHost);

  // ② 접속 열쇠(토큰) 발급 — 등록된 구성원을 골라 발급(기존 발급 블록 재사용). 방금 등록한 사람을 미리 선택.
  card.append(installMinterBlock(data, gw, { title: '② 접속 열쇠 발급', preselectId: state.admin.memberAddPreselect }));
  state.admin.memberAddPreselect = null; // 1회성 미리선택 — 다음 렌더에 잔류 방지

  detail.replaceChildren(card);
}


// ── 팀 메모리 ──
function memoryEditor(detail, data) {
  const canEdit = state.admin.canEdit;
  const card = el('div', { class: 'card' }, sectionTitle('WIKI 인덱스', data.meaning['memory']));
  const head = el('div', { class: 'mem-grid-head' },
    el('p', { class: 'admin-hint', text: '팀이 함께 쌓는 위키(지식)입니다. 카드를 누르면 ' + (canEdit ? '편집 창' : '내용') + '이 열립니다. 📌 핀한 항목은 제목·분류가 매 대화 첫머리(가이드의 ${wiki} 위치)에 깔립니다 — 본문은 제외(필요할 때 AI가 찾아봄).' }));
  if (canEdit) head.append(el('button', { class: 'btn btn-ghost btn-sm', text: '+ 위키 추가',
    onclick: () => openMemoryModal({ name: '', title: '', body_md: '' }, data, detail, true) }));
  card.append(head);

  if (!data.memory.length) {
    card.append(el('p', { class: 'empty', text: '아직 위키가 없습니다.' + (canEdit ? " 위 '+ 위키 추가'로 만들어 보세요." : '') }));
  } else {
    const grid = el('div', { class: 'mem-grid' });
    for (const mem of data.memory) {
      grid.append(el('div', { class: 'mem-card' + (mem.is_wiki ? ' mem-card-pinned' : ''), role: 'button', tabindex: '0',
        onclick: () => openMemoryModal(mem, data, detail, false),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMemoryModal(mem, data, detail, false); } } },
        el('div', { class: 'mem-card-title', text: (mem.is_wiki ? '📌 ' : '') + (mem.summary || mem.title || mem.name) }),
        el('div', { class: 'mem-card-name', text: mem.name }),
        mem.domain_key ? el('span', { class: 'mem-card-dom', text: mem.domain_key }) : null));
    }
    card.append(grid);
  }
  detail.replaceChildren(card);
}

// 메모리 편집/추가 — 카드 클릭 시 팝업(overlay). 기존 메모리는 먼저 **보기 모드**(서식 렌더된 마크다운)로,
//  관리자가 '수정하기'를 누르면 편집폼으로 전환한다. 신규는 바로 편집폼. 저장/제거 성공 후 그리드 재렌더 + 팝업 닫기.
function openMemoryModal(mem, data, detail, isNew) {
  const root = el('div', { class: 'mem-modal' });
  const back = overlay(isNew ? '메모리 추가' : (mem.title || mem.name), root);
  if (isNew) memoryForm(root, mem, data, detail, true, () => back.remove());
  else memoryRead(root, mem, data, detail, () => back.remove());
}

// 보기 모드 — 메타(도메인·파일명·마지막 편집) + 본문을 **서식있는 마크다운**으로 렌더(가독성↑, raw 마크다운 노출 X).
//  본문은 내부 스크롤(.mem-read-body)로 팝업 세로가 안정적이게. 관리자에겐 '수정하기' 버튼(→ 편집폼), 비관리자는 보기 전용.
function memoryRead(root, mem, data, detail, onClose) {
  const meta = el('div', { class: 'mem-read-meta' });
  if (mem.domain_key) meta.append(el('span', { class: 'mem-card-dom', text: mem.domain_key }));
  meta.append(el('span', { class: 'mem-read-name', text: mem.name }));
  if (mem.updated_at || mem.updated_by) {
    meta.append(el('span', { class: 'mem-read-upd',
      text: '마지막 편집' + (mem.updated_by ? ' · ' + mem.updated_by : '') + (mem.updated_at ? ' · ' + absTime(mem.updated_at) : '') }));
  }
  const body = (mem.body_md && mem.body_md.trim())
    ? el('div', { class: 'md-rendered mem-read-body' }, renderMarkdown(mem.body_md))
    : el('p', { class: 'empty', text: '(본문이 비어 있음)' });
  const kids = [meta, body];
  if (state.admin.canEdit) {
    const pinBtn = el('button', { class: 'btn btn-ghost btn-sm',
      text: mem.is_wiki ? '📌 WIKI 핀 해제' : '📍 WIKI 인덱스에 핀',
      title: 'WIKI 핀: 제목·분류가 매 대화 첫머리(가이드 ${wiki})에 항상 주입됩니다(본문 제외).',
      onclick: async () => {
        pinBtn.disabled = true;
        try {
          await api('/api/ui/knowledge/' + encodeURIComponent(mem.name) + '/wiki',
            { method: 'POST', body: JSON.stringify({ is_wiki: !mem.is_wiki }) });
          await loadAdmin(true);
          toast(mem.is_wiki ? 'WIKI 핀 해제됨' : 'WIKI 인덱스에 핀됨');
          renderAdminDetail(detail, 'memory', state.admin.data);
          if (onClose) onClose();
        } catch (e) { toast(e.message, true); pinBtn.disabled = false; }
      } });
    kids.push(el('div', { class: 'ov-actions' },
      el('button', { class: 'btn btn-primary btn-sm', text: '수정하기',
        onclick: () => memoryForm(root, mem, data, detail, false, onClose, true) }),
      pinBtn));
  }
  root.replaceChildren(...kids);
}

async function memoryForm(root, mem, data, detail, isNew, onClose, fromRead) {
  // 보기 전용 사용자가 어쩌다 여기로 오면 보기 모드로 폴백(편집폼 미노출).
  if (!state.admin.canEdit) { memoryRead(root, mem, data, detail, onClose); return; }
  const nameIn = el('input', { type: 'text', value: mem.name, placeholder: '파일명(예: agent-context-architecture)', disabled: isNew ? null : '' });
  const titleIn = el('input', { type: 'text', value: mem.title || '', placeholder: '제목' });
  // 카드에 보이는 '쉬운 한 줄' — 실제 제목·본문과 별개. 비우면 제목으로 폴백.
  const summaryIn = el('input', { type: 'text', value: mem.summary || '', placeholder: '카드에 보일 쉬운 한 줄 (비우면 제목 사용)' });
  // 도메인: 통제어휘 드롭다운(자유텍스트 폐기). 도메인맵 down 시 자유입력 폴백.
  const domSlot = await loadAllDomains();
  const domIn = domSlot.error
    ? el('input', { type: 'text', value: mem.domain_key || '', placeholder: '도메인 슬러그(목록 불가 — 직접 입력)', title: domSlot.error })
    : buildDomainSelect(domSlot, mem.domain_key || '');
  const bodyTa = el('textarea', { class: 'mem-edit-ta', rows: '18', placeholder: 'markdown 본문' }); bodyTa.value = mem.body_md || '';
  const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    if (!nameIn.value.trim()) { toast('파일명 필수', true); return; }
    saveBtn.disabled = true;
    try {
      await api('/api/ui/org/memory', { method: 'POST', body: JSON.stringify({ name: nameIn.value.trim(), title: titleIn.value.trim(), summary: summaryIn.value.trim(), body_md: bodyTa.value, domain_key: domIn.value.trim() }) });
      await loadAdmin(true); state.admin.memorySel = nameIn.value.trim(); toast('저장됨');
      renderAdminDetail(detail, 'memory', state.admin.data);
      if (onClose) onClose();
    } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  });
  const actions = el('div', { class: 'admin-actions' }, saveBtn, status);
  // 보기 모드에서 진입한 편집이면 '취소'로 다시 보기 모드로(팝업은 유지).
  if (fromRead) actions.append(el('button', { class: 'btn-text', text: '취소',
    onclick: () => memoryRead(root, mem, data, detail, onClose) }));
  if (!isNew) actions.append(el('button', { class: 'btn-text', text: '제거', onclick: async () => {
    if (!confirm(`메모리 '${mem.title || mem.name}' 제거?`)) return;
    try { await api('/api/ui/org/memory/remove', { method: 'POST', body: JSON.stringify({ name: mem.name }) });
      await loadAdmin(true); state.admin.memorySel = null; toast('제거됨'); renderAdminDetail(detail, 'memory', state.admin.data);
      if (onClose) onClose(); }
    catch (e) { toast(e.message, true); }
  } }));
  root.replaceChildren(field('파일명', nameIn), field('제목', titleIn),
    field('카드에 보이는 쉬운 한 줄', summaryIn),
    field('도메인', domIn),
    field('본문', bodyTa), actions);
}

// ── 조직 · 연결 ──
function profileEditor(detail, data) {
  const canEdit = state.admin.canEdit;
  const p = data.profile;
  const dnIn = el('input', { type: 'text', value: p.display_name || '', placeholder: '조직 표시명' });
  const gwIn = el('input', { type: 'text', value: p.gateway_url || '', placeholder: 'http://게이트웨이:포트' });
  if (!canEdit) { dnIn.disabled = true; gwIn.disabled = true; }
  const body = [
    el('h2', { text: '조직 기본 정보' }),
    fieldWithHelp('조직 표시명', dnIn, data.meaning['display_name']),
    fieldWithHelp('게이트웨이 주소', gwIn, data.meaning['gateway-url']),
  ];
  if (canEdit) {
    const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
    const status = el('span', { class: 'admin-status' });
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        const r = await api('/api/ui/org/profile', { method: 'POST', body: JSON.stringify({ display_name: dnIn.value.trim(), gateway_url: gwIn.value.trim() }) });
        data.profile = r.profile; toast('저장됨'); status.textContent = '저장됨';
      } catch (e) { toast(e.message, true); }
      saveBtn.disabled = false;
    });
    body.push(el('div', { class: 'admin-actions' }, saveBtn, status));
  }
  detail.replaceChildren(el('div', { class: 'card' }, ...body));
}

// ── 접속 권한 (발급 현황 보기 + 접속 해제) — admin 전용. 토큰 발급은 [구성원 추가] 탭으로 이동. ──
function tokensPanel(detail, data) {
  const tokens = data.tokens || [];
  const active = tokens.filter((t) => !t.revoked_at);
  const revoked = tokens.filter((t) => t.revoked_at);
  const tokenRow = (t, isActive) => {
    const meta = (t.user_id || '') + ' · ' + ((t.scopes || []).join('/') || '-')
      + ' · 발급 ' + (t.created_at ? t.created_at.slice(0, 10) : '?')
      + (t.last_used_at ? ' · 마지막 ' + relTime(t.last_used_at) : ' · 미사용');
    const right = isActive
      ? el('button', { class: 'btn btn-ghost btn-sm', text: '접속 해제', onclick: async (e) => {
          if (!confirm(`'${t.label || t.user_id}' 님의 접속을 해제할까요? 이 열쇠는 즉시 무효화됩니다(되돌릴 수 없음).`)) return;
          e.target.disabled = true;
          try {
            await api('/api/ui/org/token/revoke', { method: 'POST', body: JSON.stringify({ tokenHash: t.token_hash }) });
            await loadAdmin(true); toast('접속 해제됨 — 즉시 무효'); renderAdminDetail(detail, 'tokens', state.admin.data);
          } catch (err) { toast(err.message, true); e.target.disabled = false; }
        } })
      : el('span', { class: 'pill', text: '해제됨' });
    return el('div', { class: 'token-row' + (isActive ? '' : ' token-revoked') },
      el('div', { class: 'token-main' },
        el('div', { class: 'token-label', text: t.label || t.user_id || '(무라벨)' }),
        el('div', { class: 'mini-meta', text: meta })),
      right);
  };
  const children = [
    el('h2', { text: '접속 권한 변경' }),
    el('p', { class: 'admin-hint', text: '지금 누가 회사 게이트웨이에 연결할 수 있는지(발급된 접속 열쇠)를 한눈에 보고, 더 이상 필요 없는 접속을 정리하는 곳입니다. 새 구성원 등록과 열쇠 발급은 [구성원 추가] 탭에서 합니다.' }),
    el('div', { class: 'meaning-grid', style: 'margin:2px 0 12px' },
      meaningRow('여기서 뭘 하나', '발급된 접속 열쇠의 사용 현황을 살펴보고, 필요할 때 특정 구성원의 접속을 해제(차단)합니다.'),
      meaningRow('언제 정리하나', '퇴사·기기 분실 등 그 사람의 접속을 끊어야 할 때. 해제하면 서버를 다시 켤 필요 없이 그 즉시 막힙니다(되돌릴 수 없음).')),
  ];
  if (active.length) children.push(el('div', { class: 'token-section' }, el('div', { class: 'token-section-h', text: '사용 중 (' + active.length + ')' }), ...active.map((t) => tokenRow(t, true))));
  else children.push(el('p', { class: 'admin-hint', text: '아직 발급된 접속 열쇠가 없습니다 — [구성원 추가] 탭에서 구성원을 골라 발급하세요.' }));
  if (revoked.length) children.push(el('div', { class: 'token-section' }, el('div', { class: 'token-section-h', text: '해제됨 (' + revoked.length + ')' }), ...revoked.map((t) => tokenRow(t, false))));
  detail.replaceChildren(el('div', { class: 'card' }, ...children));
}

// ── 런타임 · 훅 (훅 on/off · work-roots · 너지 문구) — admin 전용 ──
// ── '훅' 그룹 개요(클릭 진입점) — 훅이 무엇인지 설명 + 3 하위(런타임·커스텀·미리보기) 안내/이동. ──
function hooksOverview(detail, data) {
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '훅 (Hooks)' })),
    el('p', { class: 'admin-hint', text: '훅은 구성원의 AI 세션 중 특정 시점(이벤트)에 게이트웨이가 자동으로 끼어들어 실행하는 코드·설정입니다. 세션이 시작될 때 조직 컨텍스트를 주입하거나, 지금 작업 중인 폴더를 라이블리 작업으로 인식하거나, 세션이 끝날 때 기록을 남기도록 너지하는 식으로 동작합니다 — 사람이 매번 챙기지 않아도 AI가 조직의 방식대로 일하게 만드는 자동 장치입니다.' }),
    el('p', { class: 'admin-hint', text: '구성원 머신은 매 세션 게이트웨이에서 훅을 내려받아 실행하므로(runner fetch), 여기서 바꾸면 재설치 없이 다음 세션부터 자동 반영됩니다. 주요 주입 시점: 세션 시작(SessionStart) · 프롬프트 제출(UserPromptSubmit) · 도구 사용 전후(Pre/PostToolUse) · 세션 종료(Stop). 아래 세 가지로 관리합니다.' }),
  );
  const items = [
    ['runtime', '런타임 훅 (빌트인 리플렉스)', '게이트웨이가 기본 제공하는 세션 훅(컨텍스트 주입·작업 플래그·종료 기록 너지)을 코딩 없이 켜고 끕니다. 작업 폴더(work-roots)와 AI 도구의 외부 호출 안전범위도 여기서 정합니다.'],
    ['custom-hooks', '커스텀 훅 (코드 정의)', '특정 이벤트에 실행할 임의의 코드를 직접 정의합니다. 본문은 멤버 디스크에 저장되지 않고 매 세션 게이트웨이에서 받아 실행됩니다(끄면 다음 세션부터 무효).'],
    ['hooks-preview', '주입 미리보기 (세션 주입물 확인)', '설치된 세션 훅이 실제 세션에 무엇을 주입하는지 그 최종 메시지 전문을 읽기 전용으로 확인합니다(정확/근사 충실도 표기).'],
  ];
  const list = el('div', { class: 'hooks-ov-list' });
  for (const [key, title, desc] of items) {
    if (sectionHidden(key, data)) continue; // 권한으로 숨은 하위는 안내에서도 제외(404 유도 방지).
    list.append(el('a', { class: 'hooks-ov-card', href: '#/system/' + key },
      el('div', { class: 'hooks-ov-title', text: title }),
      el('div', { class: 'hooks-ov-desc', text: desc })));
  }
  if (list.childNodes.length) card.append(list);
  detail.replaceChildren(card);
}

function runtimeEditor(detail, data) {
  const rc = data.runtimeConfig || { hooks: { session_preload: true, work_flag: true, stop_writeback_gate: true }, writeback_notice: '', work_roots: [] };
  const HOOK_OPTS = [
    ['session_preload', '세션 시작 컨텍스트 주입 (session-preload)'],
    ['work_flag', '작업 플래그 (work-flag)'],
    ['stop_writeback_gate', '종료 시 기록 너지 (writeback-gate)'],
  ];
  const chks = {};
  const hookWrap = el('div', { class: 'scope-wrap' });
  for (const [k, label] of HOOK_OPTS) {
    const chk = el('input', { type: 'checkbox' }); chk.checked = rc.hooks[k] !== false; chks[k] = chk;
    hookWrap.append(el('label', { class: 'admin-check scope-opt' }, chk, ' ' + label));
  }
  const noticeTa = el('textarea', { rows: '3', placeholder: '비우면 기본 안내문 사용' }); noticeTa.value = rc.writeback_notice || '';
  const wrTa = el('textarea', { rows: '4', placeholder: '/Users/you/repo\n줄당 절대경로 한 개' }); wrTa.value = (rc.work_roots || []).join('\n');
  // http_proxy 툴 안전 화이트리스트(B15) — 툴은 이 목록 안에서만 외부 호출/시크릿 참조 가능.
  const envTa = el('textarea', { rows: '3', placeholder: 'ACME_API_TOKEN\n줄당 환경변수 이름 한 개(값 아님)' }); envTa.value = (rc.allowed_auth_envs || []).join('\n');
  const hostTa = el('textarea', { rows: '3', placeholder: 'api.acme.com\n.internal.acme.com (앞에 . = 서브도메인 허용)' }); hostTa.value = (rc.url_allowlist || []).join('\n');
  // DB 데이터소스 안전 화이트리스트 — db_query/db_schema 소스가 접속 허용될 사설/내부 host(외부 공인 DB 는 등록 불요).
  const dbHostTa = el('textarea', { rows: '3', placeholder: 'localhost\ndb.internal.acme.com\n줄당 host 한 개(사설/localhost 만 — 외부 공인 DB 는 불요)' }); dbHostTa.value = (rc.allowed_db_hosts || []).join('\n');
  // 기록 인정 툴(write_tools) — 이 lively MCP 툴을 쓰면 '기록함'으로 보고 종료 너지를 안 띄운다. 비우면 훅 내장 v6 기본목록.
  const writeToolsTa = el('textarea', { rows: '4', placeholder: '비우면 기본 목록 사용\n줄당 lively MCP 툴 이름 한 개 (예: knowledge_save)' }); writeToolsTa.value = (rc.write_tools || []).join('\n');
  const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      const hooks = {}; for (const [k] of HOOK_OPTS) hooks[k] = chks[k].checked;
      const work_roots = wrTa.value.split('\n').map((l) => l.trim()).filter(Boolean);
      const allowed_auth_envs = envTa.value.split('\n').map((l) => l.trim()).filter(Boolean);
      const url_allowlist = hostTa.value.split('\n').map((l) => l.trim()).filter(Boolean);
      const allowed_db_hosts = dbHostTa.value.split('\n').map((l) => l.trim()).filter(Boolean);
      const write_tools = writeToolsTa.value.split('\n').map((l) => l.trim()).filter(Boolean);
      const r = await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ hooks, writeback_notice: noticeTa.value.trim() || null, work_roots, allowed_auth_envs, url_allowlist, allowed_db_hosts, write_tools }) });
      data.runtimeConfig = r.runtimeConfig; status.textContent = '저장됨'; toast('저장됨 — 구성원 다음 세션부터 반영');
    } catch (e) { toast(e.message, true); status.textContent = ''; }
    saveBtn.disabled = false;
  });
  detail.replaceChildren(el('div', { class: 'card' },
    sectionTitle('런타임 훅 (기본 리플렉스)', data.meaning['runtime']),
    el('p', { class: 'admin-hint', text: '게이트웨이가 제공하는 기본 세션 훅(리플렉스)의 ON/OFF 와 작업 폴더를 중앙에서 제어합니다. 구성원 머신은 매 세션 게이트웨이에서 훅을 받아 실행하므로(runner fetch), 변경은 다음 세션에 자동 반영됩니다(재설치 불요). 전체 끄기는 구성원이 LIVELY_OFF=1 로. ※ 코드까지 직접 정의하는 사내 훅은 ‘커스텀 훅’에서, 각 훅이 실제로 주입하는 메시지는 ‘훅 주입 미리보기’에서.' }),
    field('기본 리플렉스 훅 ON/OFF', hookWrap),
    field('writeback 너지 문구 (선택)', noticeTa),
    field('기록 인정 툴 (write_tools) — 이 lively 툴을 쓰면 종료 너지 안 함 · 비우면 기본 목록', writeToolsTa),
    field('work-roots — 이 폴더에서 켠 세션은 라이블리 작업으로 인식 (줄당 절대경로)', wrTa),
    el('div', { class: 'admin-subhead', text: 'AI 도구(http_proxy) 안전 화이트리스트' }),
    el('p', { class: 'admin-hint', text: 'AI 도구가 외부를 호출할 수 있는 범위 — 이 목록 밖은 전부 차단됩니다(SSRF 방어).' }),
    field('허용 인증 환경변수 이름 (allowed_auth_envs)', envTa),
    field('허용 호스트 (url_allowlist)', hostTa),
    el('div', { class: 'admin-subhead', text: 'DB 데이터소스 안전 화이트리스트' }),
    el('p', { class: 'admin-hint', text: 'db_query/db_schema 데이터소스가 접속할 수 있는 사설/내부 host — 이 목록 밖의 사설/localhost 는 차단됩니다(SSRF 방어). 외부 공인 DB 는 등록 불요.' }),
    field('허용 DB host (allowed_db_hosts)', dbHostTa),
    el('div', { class: 'admin-actions' }, saveBtn, status)));
}

// ── 훅 주입 미리보기(V4-P5 J절) — 설치된 3 세션 훅이 각자 세션에 실제로 주입하는 최종 메시지를 보여준다. ──
//  데이터 출처: GET /api/ui/org/hooks/preview (scope null = 인증만, REST 전용). 읽기 전용.
//  보안: 모든 데이터 텍스트는 textContent(el text:)/renderMarkdown(createElement+textContent) 로만 — innerHTML 데이터주입 0.
//  드리프트 정직성: 서버가 fidelity(exact/approximate)와 source 를 함께 주므로 그대로 표기(근사면 사유 명시).
function hooksPreviewPanel(detail, data) {
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '훅 주입 미리보기 (읽기 전용)' })),
    el('p', { class: 'admin-hint', text: '구성원 머신에 설치된 세션 훅이 각자 세션 컨텍스트에 실제로 무엇을 주입하는지, 그 최종 메시지를 보여줍니다. 훅을 고르면 그 훅이 넣는 메시지 전문을 미리볼 수 있습니다. exact=게이트웨이/설치파일이 단일 출처(드리프트 없음), approximate=멤버 머신이 세션마다 동적으로 덧붙이는 부분이 있어 일부만 재현됩니다.' }));
  detail.replaceChildren(card);

  const loading = el('p', { class: 'admin-hint', text: '불러오는 중…' });
  card.append(loading);
  api('/api/ui/org/hooks/preview').then((r) => {
    loading.remove();
    const hooks = (r && r.hooks) || [];
    if (!hooks.length) { card.append(el('p', { class: 'empty', text: '미리볼 세션 훅이 없습니다.' })); return; }
    let sel = state.admin.hookPreviewSel;
    if (!hooks.some((h) => h.id === sel)) sel = hooks[0].id;
    state.admin.hookPreviewSel = sel;

    const listCol = el('div', { class: 'admin-sublist admin-sublist-row' }); // 훅 목록은 가로 카드 배치
    for (const h of hooks) {
      const fidLabel = h.fidelity === 'exact' ? '정확' : '근사';
      listCol.append(el('div', { class: 'mini-row' + (h.id === sel ? ' sel' : ''),
        onclick: () => { state.admin.hookPreviewSel = h.id; renderHookPreviewDetail(); } },
        el('div', { class: 'mini-title', text: h.title || h.id },
          el('span', { class: 'pill', text: h.event })),
        el('div', { class: 'mini-meta' },
          el('span', { class: 'src-status' }, el('span', { class: 'dot6 ' + (h.fidelity === 'exact' ? 'ok' : 'dim'), 'aria-hidden': 'true' }), fidLabel), ' · ' + h.id)));
    }
    const right = el('div', {});
    card.append(el('div', { class: 'admin-two' }, listCol, right));

    function renderHookPreviewDetail() {
      for (const row of listCol.querySelectorAll('.mini-row')) row.classList.remove('sel');
      const idx = hooks.findIndex((h) => h.id === state.admin.hookPreviewSel);
      const rows = listCol.querySelectorAll('.mini-row');
      if (rows[idx]) rows[idx].classList.add('sel');
      const h = hooks[idx] || hooks[0];

      const metaTable = el('table', { class: 'fields-table' });
      const metaRows = [
        ['훅 id', h.id],
        ['이벤트(주입 시점)', h.event],
        ['충실도', (h.fidelity === 'exact' ? '정확(exact) — 게이트웨이/설치파일이 단일 출처, 드리프트 없음' : '근사(approximate) — 일부는 멤버 머신이 세션마다 동적 생성, 미포함')],
        ['출처', h.source],
      ];
      for (const [k, v] of metaRows) metaTable.append(el('tr', {}, el('td', { text: k }), el('td', { text: v })));

      const msg = h.message || '';
      const detailBody = el('div', {},
        el('h3', { text: h.title || h.id }),
        metaTable,
        el('div', { class: 'sec-label', style: 'margin-top:14px' }, '세션에 주입되는 최종 메시지'));

      if (!msg) {
        // work-flag 처럼 주입 메시지가 없는 훅 — provably empty 임을 명시(빈 pre 대신 안내).
        detailBody.append(el('p', { class: 'admin-hint', text: '이 훅은 컨텍스트를 주입하지 않습니다(세션 플래그만 기록). 주입 메시지 없음.' }));
      } else {
        // 메시지 전문 — 서식(마크다운 안전 렌더)/원문 토글. 마크다운 본문 뷰어 재사용(innerHTML 미사용).
        let showRaw = false;
        const rendered = el('div', { class: 'md-rendered admin-md-box' }, renderMarkdown(msg));
        const raw = el('pre', { class: 'admin-preview' }); raw.textContent = msg; raw.hidden = true;
        const toggle = el('button', { class: 'btn btn-ghost btn-sm', text: '원문 보기' });
        toggle.addEventListener('click', () => {
          showRaw = !showRaw; rendered.hidden = showRaw; raw.hidden = !showRaw;
          toggle.textContent = showRaw ? '서식 보기' : '원문 보기';
        });
        detailBody.append(el('div', { class: 'admin-actions' }, toggle), rendered, raw);
      }
      right.replaceChildren(detailBody);
    }
    renderHookPreviewDetail();
  }).catch((e) => {
    // 라이브가 구 빌드면 404(엔드포인트 next-restart) — 정직하게 안내.
    loading.remove();
    card.append(errorNote(e, '훅 미리보기를 불러오지 못했습니다(서버 재시작 후 제공)'));
  });
}

// ── MCP 서버 레지스트리 — admin 전용 ──
function mcpEditor(detail, data) {
  const servers = data.mcpServers || [];
  const sel = state.admin.mcpSel;
  const listCol = el('div', { class: 'admin-sublist' });
  listCol.append(el('button', { class: 'btn btn-ghost btn-sm admin-add', text: '+ MCP 서버 추가',
    onclick: () => { state.admin.mcpSel = '__new__'; renderAdminDetail(detail, 'mcp', data); } }));
  for (const s of servers) {
    listCol.append(el('div', { class: 'mini-row' + (s.name === sel ? ' sel' : ''),
      onclick: () => { state.admin.mcpSel = s.name; renderAdminDetail(detail, 'mcp', data); } },
      el('div', { class: 'mini-title', text: s.name }, s.enabled === false ? el('span', { class: 'pill', text: '비활성' }) : null),
      el('div', { class: 'mini-meta', text: (s.transport || 'http') + ' · ' + (s.transport === 'stdio' ? (s.command || '-') : (s.url || '-')) })));
  }
  const right = el('div', {});
  const editing = sel === '__new__' ? { name: '', transport: 'http', url: '', command: '', auth_env: '', note: '', enabled: true } : servers.find((s) => s.name === sel);
  if (editing) mcpForm(right, editing, data, detail, sel === '__new__');
  else right.append(el('p', { class: 'admin-hint', text: 'lively 게이트웨이는 기본 등록됩니다. 여기엔 추가 도구(MCP 서버)를 둡니다. 인증은 환경변수 이름만(시크릿 값 금지).' }));
  detail.replaceChildren(el('div', { class: 'card' }, sectionTitle('MCP 서버', data.meaning['mcp']), el('div', { class: 'admin-two' }, listCol, right)));
}

function mcpForm(root, s, data, detail, isNew) {
  const nameIn = el('input', { type: 'text', value: s.name, placeholder: '서버 이름(영문/숫자)', disabled: isNew ? null : '' });
  const transSel = el('select', {}, ...['http', 'stdio'].map((t) => el('option', { value: t, text: t })));
  transSel.value = s.transport || 'http';
  const urlIn = el('input', { type: 'text', value: s.url || '', placeholder: 'http://host:port/mcp' });
  const cmdIn = el('input', { type: 'text', value: s.command || '', placeholder: 'node /path/server.mjs --arg' });
  const authIn = el('input', { type: 'text', value: s.auth_env || '', placeholder: '예: ACME_TOKEN (값 아님)' });
  const noteIn = el('input', { type: 'text', value: s.note || '', placeholder: '설명(선택)' });
  const enChk = el('input', { type: 'checkbox' }); enChk.checked = s.enabled !== false;
  const urlField = field('URL (http)', urlIn);
  const cmdField = field('command (stdio)', cmdIn);
  const syncTransport = () => { urlField.style.display = transSel.value === 'http' ? '' : 'none'; cmdField.style.display = transSel.value === 'stdio' ? '' : 'none'; };
  transSel.addEventListener('change', syncTransport);
  const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    if (!nameIn.value.trim()) { toast('이름 필수', true); return; }
    saveBtn.disabled = true;
    try {
      const http = transSel.value === 'http';
      const payload = { name: nameIn.value.trim(), transport: transSel.value, url: http ? urlIn.value.trim() : null, command: http ? null : cmdIn.value.trim(), auth_env: authIn.value.trim() || null, note: noteIn.value.trim() || null, enabled: enChk.checked };
      await api('/api/ui/org/mcp-server', { method: 'POST', body: JSON.stringify(payload) });
      await loadAdmin(true); state.admin.mcpSel = payload.name; toast('저장됨 — 다음 설치/업데이트 시 등록'); renderAdminDetail(detail, 'mcp', state.admin.data);
    } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  });
  const actions = el('div', { class: 'admin-actions' }, saveBtn, status);
  if (!isNew) actions.append(el('button', { class: 'btn-text', text: '제거', onclick: async () => {
    if (!confirm(`MCP 서버 '${s.name}' 제거?`)) return;
    try { await api('/api/ui/org/mcp-server/remove', { method: 'POST', body: JSON.stringify({ name: s.name }) }); await loadAdmin(true); state.admin.mcpSel = null; toast('제거됨'); renderAdminDetail(detail, 'mcp', state.admin.data); }
    catch (e) { toast(e.message, true); }
  } }));
  root.replaceChildren(
    field('이름', nameIn), field('전송 방식', transSel), urlField, cmdField,
    field('인증 환경변수 이름 (auth_env)', authIn), field('설명', noteIn),
    el('label', { class: 'admin-check' }, enChk, ' 활성'),
    actions);
  syncTransport();
}

// ── DB 데이터소스 — admin 전용. db_query/db_schema 가 읽는 외부 운영 DB(읽기전용). ──
function dbSourceEditor(detail, data) {
  const sources = data.dbSources || [];
  const envSources = data.envSources || [];
  const sel = state.admin.dbSrcSel;
  const listCol = el('div', { class: 'admin-sublist' });
  listCol.append(el('button', { class: 'btn btn-ghost btn-sm admin-add', text: '+ DB 소스 추가',
    onclick: () => { state.admin.dbSrcSel = '__new__'; renderAdminDetail(detail, 'db-sources', data); } }));
  for (const s of sources) {
    listCol.append(el('div', { class: 'mini-row' + (s.name === sel ? ' sel' : ''),
      onclick: () => { state.admin.dbSrcSel = s.name; renderAdminDetail(detail, 'db-sources', data); } },
      el('div', { class: 'mini-title', text: s.name }, s.enabled === false ? el('span', { class: 'pill', text: '비활성' }) : null),
      el('div', { class: 'mini-meta', text: (s.host || '-') + ' · ' + (s.auth_mode || 'password') + (s.rls ? ' · RLS' : '') })));
  }
  // env 소스(.env/DB_SOURCES_JSON) — 읽기 전용(여기선 편집 불가).
  for (const s of envSources) {
    listCol.append(el('div', { class: 'mini-row mini-ro' },
      el('div', { class: 'mini-title', text: s.name }, el('span', { class: 'pill', text: 'env' })),
      el('div', { class: 'mini-meta', text: (s.host || '-') + ' · 읽기 전용(.env)' })));
  }
  const right = el('div', {});
  const editing = sel === '__new__'
    ? { name: '', driver: 'postgres', url: '', auth_mode: 'password', auth_ref: '', rls: '', max_rows: '', timeout_ms: '', note: '', enabled: true }
    : sources.find((s) => s.name === sel);
  if (editing) dbSourceForm(right, editing, data, detail, sel === '__new__');
  else right.append(
    el('p', { class: 'admin-hint', text: 'db_query/db_schema 가 읽는 외부 운영 DB(읽기전용)입니다. 접속 비밀번호는 저장하지 않고 환경변수 이름(auth_ref)으로만 참조합니다 — 읽기전용 role + RLS 전제. env(.env)로 설정한 소스는 읽기 전용으로 표시됩니다.' }));
  detail.replaceChildren(el('div', { class: 'card' }, sectionTitle('DB 데이터소스', data.meaning['db-source']), el('div', { class: 'admin-two' }, listCol, right)));
}

function dbSourceForm(root, s, data, detail, isNew) {
  const allowed = (data.runtimeConfig && data.runtimeConfig.allowed_db_secret_refs) || [];
  const nameIn = el('input', { type: 'text', value: s.name, placeholder: '소스 이름(영문/숫자)', disabled: isNew ? null : '' });
  const urlIn = el('input', { type: 'text', value: '', placeholder: isNew ? 'postgres://readonly@host:5432/db (비번 제외)' : ('현재 host: ' + (s.host || '-') + ' · 변경 시에만 입력(비번 제외)') });
  const modeSel = el('select', {},
    el('option', { value: 'password', text: 'password (env 참조)' }),
    el('option', { value: 'iam', text: 'iam (후속)', disabled: '' }),
    el('option', { value: 'mtls', text: 'mtls (후속)', disabled: '' }),
    el('option', { value: 'vault', text: 'vault (후속)', disabled: '' }));
  modeSel.value = s.auth_mode || 'password';
  const refIn = el('input', { type: 'text', value: s.auth_ref || '', placeholder: '예: ANALYTICS_DB_PW (env 이름, 값 아님)' });
  const refHint = el('p', { class: 'admin-hint', text: allowed.length ? '참조 가능한 env: ' + allowed.join(', ') : '⚠ 먼저 [런타임 · 훅]에서 allowed_db_secret_refs 에 env 이름을 추가하세요(비번 없는 DB면 비워도 됩니다)' });
  const rlsIn = el('input', { type: 'text', value: s.rls || '', placeholder: 'app.current_user (비우면 행수준 격리 없음)' });
  const maxIn = el('input', { type: 'number', value: (s.max_rows == null ? '' : s.max_rows), placeholder: '기본 1000' });
  const toIn = el('input', { type: 'number', value: (s.timeout_ms == null ? '' : s.timeout_ms), placeholder: '기본 5000' });
  const noteIn = el('input', { type: 'text', value: s.note || '', placeholder: '설명(선택)' });
  const enChk = el('input', { type: 'checkbox' }); enChk.checked = s.enabled !== false;
  const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    if (!nameIn.value.trim()) { toast('이름 필수', true); return; }
    saveBtn.disabled = true;
    try {
      const urlV = urlIn.value.trim();
      if (isNew && !urlV) { toast('접속 URL 필수', true); saveBtn.disabled = false; return; }
      const payload = {
        name: nameIn.value.trim(), driver: 'postgres', auth_mode: modeSel.value,
        auth_ref: refIn.value.trim() || null,
        rls: rlsIn.value.trim() || null,
        max_rows: maxIn.value ? Number(maxIn.value) : null,
        timeout_ms: toIn.value ? Number(toIn.value) : null,
        note: noteIn.value.trim() || null, enabled: enChk.checked,
      };
      if (urlV) payload.url = urlV; // 빈칸 = url 미변경(수정 시)
      await api('/api/ui/org/db-source', { method: 'POST', body: JSON.stringify(payload) });
      await loadAdmin(true); state.admin.dbSrcSel = payload.name; toast('저장됨 — 즉시 조회 가능'); renderAdminDetail(detail, 'db-sources', state.admin.data);
    } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  });
  const actions = el('div', { class: 'admin-actions' }, saveBtn, status);
  if (!isNew) actions.append(el('button', { class: 'btn-text', text: '제거', onclick: async () => {
    if (!confirm(`DB 소스 '${s.name}' 제거?`)) return;
    try { await api('/api/ui/org/db-source/remove', { method: 'POST', body: JSON.stringify({ name: s.name }) }); await loadAdmin(true); state.admin.dbSrcSel = null; toast('제거됨'); renderAdminDetail(detail, 'db-sources', state.admin.data); }
    catch (e) { toast(e.message, true); }
  } }));
  root.replaceChildren(
    field('이름', nameIn), field('접속 URL (비번 제외)', urlIn), field('인증 방식 (auth_mode)', modeSel),
    field('비번 환경변수 이름 (auth_ref)', refIn), refHint,
    field('RLS GUC (rls)', rlsIn), field('최대 행수 (max_rows)', maxIn), field('타임아웃 ms (timeout_ms)', toIn),
    field('설명', noteIn), el('label', { class: 'admin-check' }, enChk, ' 활성'),
    actions);
}

// ── 커스텀 훅 — runtime 권한 ──
function customHookEditor(detail, data) {
  const hooks = data.orgHooks || [];
  const sel = state.admin.hookSel;
  const listCol = el('div', { class: 'admin-sublist' });
  listCol.append(el('button', { class: 'btn btn-ghost btn-sm admin-add', text: '+ 커스텀 훅 추가',
    onclick: () => { state.admin.hookSel = '__new__'; renderAdminDetail(detail, 'custom-hooks', data); } }));
  for (const h of hooks) {
    listCol.append(el('div', { class: 'mini-row' + (h.id === sel ? ' sel' : ''),
      onclick: () => { state.admin.hookSel = h.id; renderAdminDetail(detail, 'custom-hooks', data); } },
      el('div', { class: 'mini-title', text: h.id }, h.enabled === false ? el('span', { class: 'pill', text: '비활성' }) : null),
      el('div', { class: 'mini-meta', text: h.event + (h.matcher ? ' · ' + h.matcher : '') + ' · ' + (h.harness || 'all') })));
  }
  const right = el('div', {});
  const editing = sel === '__new__'
    ? { id: '', label: '', harness: 'all', event: 'PostToolUse', matcher: '', source_code: '', timeout_sec: 10, note: '', enabled: true }
    : hooks.find((h) => h.id === sel);
  if (editing) hookForm(right, editing, data, detail, sel === '__new__');
  else right.append(
    el('p', { class: 'admin-hint', text: '구성원 머신에서 특정 시점에 자동 실행되는 코드입니다. 본문은 멤버 디스크에 저장되지 않고 매 세션 게이트웨이에서 받아 실행됩니다(끄면 다음 세션부터 무효).' }));
  detail.replaceChildren(el('div', { class: 'card' }, sectionTitle('커스텀 훅 (코드 정의)', data.meaning['custom-hook']), el('div', { class: 'admin-two' }, listCol, right)));
}

function hookForm(root, h, data, detail, isNew) {
  const idIn = el('input', { type: 'text', value: h.id, placeholder: '훅 id (소문자/숫자/_-)', disabled: isNew ? null : '' });
  const labelIn = el('input', { type: 'text', value: h.label || '', placeholder: '표시 이름(선택)' });
  const harnessSel = el('select', {}, ...['all', 'claude', 'codex', 'openclaw'].map((x) => el('option', { value: x, text: x })));
  harnessSel.value = h.harness || 'all';
  const eventSel = el('select', {}, ...['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'Notification'].map((x) => el('option', { value: x, text: x })));
  eventSel.value = h.event || 'PostToolUse';
  const matcherIn = el('input', { type: 'text', value: h.matcher || '', placeholder: '예: Bash (PreToolUse/PostToolUse 의 도구 매처)' });
  const codeTa = el('textarea', { rows: '12', class: 'admin-ta', placeholder: '#!/usr/bin/env node\n// 훅 입력은 stdin(JSON), 응답은 stdout / exit code' });
  codeTa.value = h.source_code || '';
  const timeoutIn = el('input', { type: 'number', value: String(h.timeout_sec || 10), min: '1', max: '120' });
  const enChk = el('input', { type: 'checkbox' }); enChk.checked = h.enabled !== false;
  const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    if (!idIn.value.trim()) { toast('id 필수', true); return; }
    if (!confirm('이 코드는 구성원 컴퓨터에서 그들의 권한으로 실제 실행됩니다. 저장할까요?')) return;
    saveBtn.disabled = true;
    try {
      const payload = { id: idIn.value.trim(), label: labelIn.value.trim() || null, harness: harnessSel.value, event: eventSel.value, matcher: matcherIn.value.trim() || null, source_code: codeTa.value, timeout_sec: Number(timeoutIn.value) || 10, enabled: enChk.checked };
      await api('/api/ui/org/hook', { method: 'POST', body: JSON.stringify(payload) });
      await loadAdmin(true); state.admin.hookSel = payload.id; toast('저장됨 — 구성원 다음 세션부터'); renderAdminDetail(detail, 'custom-hooks', state.admin.data);
    } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  });
  const actions = el('div', { class: 'admin-actions' }, saveBtn, status);
  if (!isNew) actions.append(el('button', { class: 'btn-text', text: '제거', onclick: async () => {
    if (!confirm(`커스텀 훅 '${h.id}' 제거? 다음 세션부터 실행되지 않습니다(미접속 머신은 직전 상태 유지).`)) return;
    try { await api('/api/ui/org/hook/remove', { method: 'POST', body: JSON.stringify({ id: h.id }) }); await loadAdmin(true); state.admin.hookSel = null; toast('제거됨'); renderAdminDetail(detail, 'custom-hooks', state.admin.data); }
    catch (e) { toast(e.message, true); }
  } }));
  root.replaceChildren(
    el('div', { class: 'warn-badge', text: '⚠ 이 코드는 구성원 컴퓨터에서 그들의 권한으로 실제 실행됩니다.' }),
    field('id', idIn), field('표시 이름', labelIn),
    field('하네스', harnessSel), field('이벤트(실행 시점)', eventSel),
    field('매처(선택 — PreToolUse/PostToolUse 의 도구명)', matcherIn),
    field('코드 (Node.js)', codeTa),
    field('타임아웃(초, 1~120)', timeoutIn),
    el('label', { class: 'admin-check' }, enChk, ' 활성'),
    actions);
}

// ── AI 도구(MCP 툴) — runtime 권한 ──
function toolsEditor(detail, data) {
  const proxyTools = (data.tools || []).filter((t) => t.kind === 'http_proxy');
  const sel = state.admin.toolSel;
  const listCol = el('div', { class: 'admin-sublist' });
  listCol.append(el('button', { class: 'btn btn-ghost btn-sm admin-add', text: '+ 도구 추가',
    onclick: () => { state.admin.toolSel = '__new__'; renderAdminDetail(detail, 'tools', data); } }));
  for (const t of proxyTools) {
    listCol.append(el('div', { class: 'mini-row' + (t.name === sel ? ' sel' : ''),
      onclick: () => { state.admin.toolSel = t.name; renderAdminDetail(detail, 'tools', data); } },
      el('div', { class: 'mini-title', text: t.name },
        t.enabled === false ? el('span', { class: 'pill', text: '비활성' }) : null,
        t.auto_approve ? el('span', { class: 'pill pill-warn', text: '자동승인' }) : null),
      el('div', { class: 'mini-meta', text: (t.method || 'GET') + ' · ' + (t.scope || '-') })));
  }
  const right = el('div', {});
  const editing = sel === '__new__'
    ? { name: '', kind: 'http_proxy', enabled: true, auto_approve: false, title: '', description: '', scope: 'items', method: 'GET', url: '', auth_env: '', input_schema: '', note: '' }
    : proxyTools.find((t) => t.name === sel);
  if (editing) toolForm(right, editing, data, detail, sel === '__new__');
  else right.append(
    el('p', { class: 'admin-hint', text: '사내 API를 AI 도구로 래핑합니다. 저장 즉시(재설치 없이) 구성원 AI가 씁니다. 호출은 런타임 설정의 화이트리스트 안에서만, 인증은 환경변수 이름으로만.' }),
    builtinToggles(data));
  detail.replaceChildren(el('div', { class: 'card' }, sectionTitle('AI 도구(툴)', data.meaning['tool']), el('div', { class: 'admin-two' }, listCol, right)));
}

function builtinToggles(data) {
  const byName = {}; for (const t of (data.tools || [])) if (t.kind === 'builtin') byName[t.name] = t;
  const wrap = el('div', { class: 'builtin-toggles' },
    el('div', { class: 'admin-subhead', text: '빌트인 도구 (게이트웨이 기본)' }),
    el('p', { class: 'admin-hint', text: '끄면 구성원 AI 도구 목록에서 사라집니다(즉시). 자동승인을 켜면 구성원 설치 시 확인 없이 실행되도록 설정됩니다.' }));
  for (const name of (data.builtins || [])) {
    const row = byName[name] || { name, enabled: true, auto_approve: false };
    const enChk = el('input', { type: 'checkbox' }); enChk.checked = row.enabled !== false;
    const aaChk = el('input', { type: 'checkbox' }); aaChk.checked = !!row.auto_approve;
    const save = async () => {
      try { await api('/api/ui/org/tool', { method: 'POST', body: JSON.stringify({ name, kind: 'builtin', enabled: enChk.checked, auto_approve: aaChk.checked }) }); await loadAdmin(true); toast('저장됨'); }
      catch (e) { toast(e.message, true); }
    };
    enChk.addEventListener('change', save); aaChk.addEventListener('change', save);
    wrap.append(el('div', { class: 'builtin-row' },
      el('span', { class: 'builtin-name', text: name }),
      el('label', { class: 'admin-check' }, enChk, ' 사용'),
      el('label', { class: 'admin-check' }, aaChk, ' 자동승인')));
  }
  return wrap;
}

function toolForm(root, t, data, detail, isNew) {
  const policy = data.toolPolicy || { allowed_auth_envs: [], url_allowlist: [] };
  const nameIn = el('input', { type: 'text', value: t.name, placeholder: '도구 이름 (소문자/숫자/_-)', disabled: isNew ? null : '' });
  const titleIn = el('input', { type: 'text', value: t.title || '', placeholder: '표시 이름(선택)' });
  const descTa = el('textarea', { rows: '2', placeholder: 'AI에게 이 도구가 무엇인지 설명(AI가 언제 쓸지 판단)' }); descTa.value = t.description || '';
  const scopeSel = el('select', {}, ...['items', 'context', 'db', 'memory', 'code'].map((s) => el('option', { value: s, text: s })));
  scopeSel.value = t.scope || 'items';
  const methodSel = el('select', {}, ...['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => el('option', { value: m, text: m })));
  methodSel.value = t.method || 'GET';
  const urlIn = el('input', { type: 'text', value: t.url || '', placeholder: 'https://api.acme.com/v1/search' });
  let authEl;
  if (policy.allowed_auth_envs.length) {
    authEl = el('select', {}, el('option', { value: '', text: '(인증 없음)' }), ...policy.allowed_auth_envs.map((e) => el('option', { value: e, text: e })));
    authEl.value = t.auth_env || '';
  } else {
    authEl = el('input', { type: 'text', value: '', placeholder: '런타임 설정 > allowed_auth_envs 를 먼저 등록하세요', disabled: '' });
  }
  const schemaTa = el('textarea', { rows: '5', class: 'admin-ta', placeholder: '{ "type":"object", "properties": { "q": {"type":"string"} }, "required":["q"] }' });
  schemaTa.value = typeof t.input_schema === 'string' ? t.input_schema : (t.input_schema ? JSON.stringify(t.input_schema, null, 2) : '');
  const enChk = el('input', { type: 'checkbox' }); enChk.checked = t.enabled !== false;
  const aaChk = el('input', { type: 'checkbox' }); aaChk.checked = !!t.auto_approve;
  const hostHint = el('p', { class: 'admin-hint', text: policy.url_allowlist.length ? '허용 호스트: ' + policy.url_allowlist.join(', ') : '⚠ 허용 호스트가 없습니다 — 런타임 설정 > url_allowlist 에 먼저 추가해야 호출됩니다.' });
  const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    if (!nameIn.value.trim()) { toast('이름 필수', true); return; }
    let schema;
    if (schemaTa.value.trim()) { try { schema = JSON.parse(schemaTa.value); } catch { toast('입력 스키마가 올바른 JSON 이 아닙니다', true); return; } }
    saveBtn.disabled = true;
    try {
      const payload = { name: nameIn.value.trim(), kind: 'http_proxy', enabled: enChk.checked, auto_approve: aaChk.checked, title: titleIn.value.trim() || null, description: descTa.value.trim(), scope: scopeSel.value, method: methodSel.value, url: urlIn.value.trim(), auth_env: (authEl.value || '').trim() || null, input_schema: schema };
      await api('/api/ui/org/tool', { method: 'POST', body: JSON.stringify(payload) });
      await loadAdmin(true); state.admin.toolSel = payload.name; toast('저장됨 — 구성원 다음 대화부터 즉시'); renderAdminDetail(detail, 'tools', state.admin.data);
    } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  });
  const actions = el('div', { class: 'admin-actions' }, saveBtn, status);
  if (!isNew) actions.append(el('button', { class: 'btn-text', text: '제거', onclick: async () => {
    if (!confirm(`도구 '${t.name}' 제거? 구성원 AI 도구 목록에서 즉시 사라집니다.`)) return;
    try { await api('/api/ui/org/tool/remove', { method: 'POST', body: JSON.stringify({ name: t.name }) }); await loadAdmin(true); state.admin.toolSel = null; toast('제거됨'); renderAdminDetail(detail, 'tools', state.admin.data); }
    catch (e) { toast(e.message, true); }
  } }));
  root.replaceChildren(
    field('이름', nameIn), field('표시 이름', titleIn), field('설명 (AI용)', descTa),
    field('권한 (이 도구를 쓸 수 있는 scope)', scopeSel),
    field('HTTP 메서드', methodSel), field('URL (https)', urlIn), hostHint,
    field('인증 환경변수 (auth_env)', authEl),
    field('입력 스키마 (JSON Schema, 선택)', schemaTa),
    el('label', { class: 'admin-check' }, enChk, ' 활성'),
    el('label', { class: 'admin-check' }, aaChk, ' 자동 승인 (구성원 확인 없이 실행 — 주의)'),
    actions);
}

// ── 설치 · 업데이트 · 제거 (OS별 명령 복붙) — 모든 멤버에게 보임(자가 업데이트/제거) ──
function deployPanel(detail, data) {
  const gw = (data.profile.gateway_url || window.location.origin).replace(/\/mcp$/, '').replace(/\/$/, '');
  const canEdit = state.admin.canEdit;
  const os = state.admin.deployOs || 'mac';
  state.admin.deployOs = os;
  const osTabs = el('div', { class: 'os-tabs' },
    ...[['mac', 'macOS'], ['windows', 'Windows']].map(([o, label]) => el('button', {
      class: 'btn btn-sm ' + (o === os ? 'btn-primary' : 'btn-ghost'), text: label,
      onclick: () => { state.admin.deployOs = o; renderAdminDetail(detail, 'deploy', data); } })));
  const staticBlock = (c) => el('div', { class: 'deploy-block' },
    el('div', { class: 'deploy-head' }, el('h3', { text: c.title }),
      c.cmd !== '(준비 중)' ? copyButton(() => c.cmd, '복사') : null),
    el('p', { class: 'admin-hint', text: c.note }),
    el('pre', { class: 'admin-preview', text: c.cmd }));
  // 설치 블록: 본인 토큰 자가발급(어드민·비어드민 동일). 업데이트·제거는 설치된 토큰 자동 읽기.
  const blocks = deployCommands(gw, os).map((c) =>
    c.kind === 'install' ? installSelfBlock(gw, os) : staticBlock(c));
  detail.replaceChildren(el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '설치 · 업데이트 · 제거' }), osTabs),
    el('p', { class: 'admin-hint', text: '본인 머신에 설치/업데이트/제거하는 명령입니다. 업데이트·제거는 설치된 토큰을 자동으로 읽어 토큰 재입력이 필요 없습니다. (다른 구성원에게 배포할 토큰은 [구성원 추가] 탭에서.)' }),
    ...blocks));
}

// OS별 설치 명령(토큰 박음).
function installCmd(gw, os, token) {
  if (os === 'windows') {
    // 맥과 동일: 번들 기반 설치(git clone 없음·토큰 프롬프트 없음) + 설치된 하네스 감지(claude/codex) → --harness.
    //  claude 면 mcp add, codex 면 현재 세션 $env:LIVELY_TOKEN + PowerShell $PROFILE 에 "파일→env 수화" 블록
    //  (Mac rc 패턴과 동일·토큰 리터럴은 ~/.lively/token 한 곳만 · setx 레지스트리 리터럴 제거). 새 PowerShell 부터 적용.
    return `$T="${token}"; $G="${gw}"; $h=@(); if(Get-Command claude -EA 0){$h+="claude"}; if(Get-Command codex -EA 0){$h+="codex"}; if($h.Count -eq 0){$h=@("claude")}; $tmp="$env:TEMP\\lvin"; Remove-Item -Recurse -Force $tmp -EA 0; New-Item -ItemType Directory -Force $tmp|Out-Null; Invoke-WebRequest -Headers @{Authorization="Bearer $T"} "$G/install" -OutFile "$tmp\\b.tgz"; tar -xzf "$tmp\\b.tgz" -C $tmp; New-Item -ItemType Directory -Force "$HOME\\.lively"|Out-Null; Set-Content "$HOME\\.lively\\token" $T -NoNewline; Set-Content "$HOME\\.lively\\gateway-url" $G -NoNewline; if($h -contains "claude"){ claude mcp remove lively *>$null; claude mcp add --transport http --scope user lively "$G/mcp" --header "Authorization: Bearer $T" }; if($h -contains "codex"){ $env:LIVELY_TOKEN=$T; [Environment]::SetEnvironmentVariable('LIVELY_TOKEN',$null,'User'); $pf=$PROFILE.CurrentUserAllHosts; New-Item -ItemType Directory -Force (Split-Path $pf) *>$null; if(-not (Test-Path $pf)){ New-Item -ItemType File -Force $pf *>$null }; $m="# lively-managed (codex LIVELY_TOKEN)"; if(-not (Select-String -Path $pf -SimpleMatch $m -Quiet -EA 0)){ Add-Content $pf ""; Add-Content $pf $m; Add-Content $pf 'if(-not $env:LIVELY_TOKEN -and (Test-Path "$HOME\\.lively\\token")){ $env:LIVELY_TOKEN=(Get-Content "$HOME\\.lively\\token" -Raw).Trim() }' } }; node "$tmp\\setup\\user-install.mjs" --clone-root $tmp --harness ($h -join ",")`;
  }
  return `T=${token}; curl -fsSL -H "Authorization: Bearer $T" "${gw}/install" -o /tmp/lv.tgz && mkdir -p /tmp/lv && tar -xzf /tmp/lv.tgz -C /tmp/lv && LIVELY_TOKEN=$T bash /tmp/lv/setup/setup-mac.sh`;
}

// 설치(본인) — 자가발급으로 본인 토큰 → 본인 설치 명령. admin/비admin 동일.
function installSelfBlock(gw, os) {
  const result = el('div', {});
  const go = el('button', { class: 'btn btn-primary btn-sm', text: '내 토큰 발급 → 설치 명령' });
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const r = await api('/api/ui/org/token/self', { method: 'POST', body: '{}' });
      const cmd = installCmd(gw, os, r.token);
      result.replaceChildren(
        el('p', { class: 'admin-hint', text: '✓ 본인 토큰 발급됨(scope: ' + (r.scopes || []).join('/') + '). 본인 머신에서 아래를 실행하세요 — 토큰은 지금만 보입니다.' }),
        el('div', { class: 'deploy-head' }, el('span', {}), copyButton(() => cmd, '명령 복사')),
        el('pre', { class: 'admin-preview', text: cmd }));
    } catch (e) { toast(e.message, true); }
    go.disabled = false;
  });
  return el('div', { class: 'deploy-block' },
    el('h3', { text: '설치 (본인 머신)' }),
    el('p', { class: 'admin-hint', text: '본인 토큰을 발급해 본인 머신에 설치합니다(git 불필요). 새 기기/재설치 시 사용.' }),
    el('div', { class: 'install-minter' }, go),
    result);
}

// 설치 미니터 — 구성원 선택 + 발급 → 그 사람 토큰이 박힌 완성형 설치 명령(복사).
function installMinterBlock(data, gw, opts = {}) {
  const result = el('div', {});
  const sel = el('select', {}, ...(data.members || []).map((m) =>
    el('option', { value: m.id, text: (m.display_name || m.id) + ' · ' + ((m.scopes || []).join('/') || '-') })));
  if (opts.preselectId && (data.members || []).some((m) => m.id === opts.preselectId)) sel.value = opts.preselectId;
  const go = el('button', { class: 'btn btn-primary btn-sm', text: '토큰 발급' });
  go.addEventListener('click', async () => {
    const m = (data.members || []).find((x) => x.id === sel.value) || { id: sel.value };
    if (!m.id) { toast('구성원을 선택하세요', true); return; }
    go.disabled = true;
    try {
      const r = await api('/api/ui/org/token', { method: 'POST',
        body: JSON.stringify({ userId: m.id, memberId: m.id, label: m.display_name || m.id }) });
      const name = m.display_name || m.id;
      const webUrl = gw + '/ui/';
      result.replaceChildren(
        el('p', { class: 'install-ok', text: '✓ ' + name + ' 님 접속 토큰이 발급됐어요 (권한: ' + r.scopes.join('/') + ').' }),
        el('p', { class: 'admin-hint', text: '아래 토큰을 ' + name + ' 님에게 전달하면 끝이에요 — 받은 분은 이 토큰으로 바로 로그인합니다(설치·명령어 필요 없음).' }),
        el('div', { class: 'deploy-head' }, el('span', { class: 'mini-meta', text: '발급된 토큰' }), copyButton(() => r.token, '토큰 복사')),
        el('pre', { class: 'admin-preview', text: r.token }),
        el('ol', { class: 'minter-steps' },
          el('li', {}, el('b', { text: '[토큰 복사]' }), ' 버튼으로 토큰을 복사하세요.'),
          el('li', {}, name + ' 님에게 ', el('b', { text: '1:1로(슬랙·메신저 DM 등) 전달' }), '하세요 — 토큰은 비밀번호 같은 거라 공개 채널·단톡방엔 올리지 마세요.'),
          el('li', {}, name + ' 님은 ', el('a', { href: webUrl, target: '_blank', rel: 'noopener', text: webUrl }), ' 에 접속해 ', el('b', { text: '첫 화면에 이 토큰을 붙여넣고 로그인' }), '하면 바로 시작합니다.')),
        el('p', { class: 'admin-hint', text: '⚠ 이 토큰은 지금 이 화면에서만 보여요 — 닫으면 다시 볼 수 없습니다(잃어버리면 다시 발급하면 돼요).' }),
        el('p', { class: 'admin-hint', text: '내 컴퓨터 터미널(Claude Code·Codex)에서 직접 쓰실 분은 — 같은 토큰으로 [시작하기] › [설치] 안내를 따르면 됩니다.' }));
      await loadAdmin(true);
    } catch (e) { toast(e.message, true); }
    go.disabled = false;
  });
  return el('div', { class: 'deploy-block' },
    el('h3', { class: 'member-add-step', text: opts.title || '토큰 발급 (새 팀원 추가)' }),
    el('p', { class: 'admin-hint', text: '구성원을 고르고 [토큰 발급]을 누르면 그 사람 전용 토큰이 나옵니다. 그 토큰만 전달하면 — 받은 분이 첫 화면에 붙여넣고 로그인합니다(설치·명령어 불필요).' }),
    el('div', { class: 'install-minter' }, sel, go),
    result);
}

function deployCommands(gw, os) {
  if (os === 'windows') {
    return [
      { kind: 'install', title: '설치 (PowerShell)' }, // 설치 블록은 installSelfBlock 가 렌더(자가발급)
      { kind: 'update', title: '업데이트 (PowerShell)', note: '설치된 토큰을 읽어 최신 묶음 재설치(설치된 하네스 자동 감지). ⚠ Windows 미검증 — 테스트 후 사용.',
        cmd: `$T=(Get-Content "$HOME\\.lively\\token" -Raw).Trim(); $G=((Get-Content "$HOME\\.lively\\gateway-url" -Raw).Trim() -replace '/mcp$',''); $h=@(); if(Get-Command claude -EA 0){$h+="claude"}; if(Get-Command codex -EA 0){$h+="codex"}; if($h.Count -eq 0){$h=@("claude")}; $tmp="$env:TEMP\\lvup"; Remove-Item -Recurse -Force $tmp -EA 0; New-Item -ItemType Directory -Force $tmp|Out-Null; Invoke-WebRequest -Headers @{Authorization="Bearer $T"} "$G/install" -OutFile "$tmp\\b.tgz"; tar -xzf "$tmp\\b.tgz" -C $tmp; if($h -contains "claude"){ claude mcp remove lively *>$null; claude mcp add --transport http --scope user lively "$G/mcp" --header "Authorization: Bearer $T" }; if($h -contains "codex"){ $env:LIVELY_TOKEN=$T; [Environment]::SetEnvironmentVariable('LIVELY_TOKEN',$null,'User'); $pf=$PROFILE.CurrentUserAllHosts; New-Item -ItemType Directory -Force (Split-Path $pf) *>$null; if(-not (Test-Path $pf)){ New-Item -ItemType File -Force $pf *>$null }; $m="# lively-managed (codex LIVELY_TOKEN)"; if(-not (Select-String -Path $pf -SimpleMatch $m -Quiet -EA 0)){ Add-Content $pf ""; Add-Content $pf $m; Add-Content $pf 'if(-not $env:LIVELY_TOKEN -and (Test-Path "$HOME\\.lively\\token")){ $env:LIVELY_TOKEN=(Get-Content "$HOME\\.lively\\token" -Raw).Trim() }' } }; node "$tmp\\setup\\user-install.mjs" --clone-root $tmp --harness ($h -join ",")` },
      { kind: 'uninstall', title: '제거 (PowerShell)', note: '설치 자산 제거(lively 영역만). 완전 차단은 관리자가 [접속 권한 변경] 탭에서 접속 해제. ⚠ Windows 미검증.',
        cmd: `$T=(Get-Content "$HOME\\.lively\\token" -Raw).Trim(); $G=((Get-Content "$HOME\\.lively\\gateway-url" -Raw).Trim() -replace '/mcp$',''); $tmp="$env:TEMP\\lvun"; Remove-Item -Recurse -Force $tmp -EA 0; New-Item -ItemType Directory -Force $tmp|Out-Null; Invoke-WebRequest -Headers @{Authorization="Bearer $T"} "$G/install" -OutFile "$tmp\\b.tgz"; tar -xzf "$tmp\\b.tgz" -C $tmp; node "$tmp\\setup\\user-uninstall.mjs"` },
    ];
  }
  return [
    { kind: 'install', title: '설치', note: '구성원 토큰 필요 — 아래에서 구성원을 골라 발급하면 토큰 박힌 완성형 명령이 나옵니다. (아래는 템플릿: <TOKEN> 교체)',
      cmd: `T=<TOKEN>; curl -fsSL -H "Authorization: Bearer $T" "${gw}/install" -o /tmp/lv.tgz && mkdir -p /tmp/lv && tar -xzf /tmp/lv.tgz -C /tmp/lv && LIVELY_TOKEN=$T bash /tmp/lv/setup/setup-mac.sh` },
    { kind: 'update', title: '업데이트', note: '설치된 토큰을 읽어 최신 묶음으로 멱등 재설치. 콘텐츠(강제규칙·회사맥락·메모리)는 매 세션 자동이라, 훅/설정 변경 시에만 필요합니다.',
      cmd: `T="$(cat ~/.lively/token)"; G="$(sed 's#/mcp$##' ~/.lively/gateway-url)"; curl -fsSL -H "Authorization: Bearer $T" "$G/install" -o /tmp/lv.tgz && rm -rf /tmp/lv && mkdir -p /tmp/lv && tar -xzf /tmp/lv.tgz -C /tmp/lv && LIVELY_TOKEN="$T" bash /tmp/lv/setup/setup-mac.sh` },
    { kind: 'uninstall', title: '제거', note: '설치 자산을 영구 제거(lively-managed 영역만 — tmux 훅·셸 별칭 등 사용자 설정은 보존). 완전 차단하려면 관리자가 [접속 권한 변경] 탭에서 접속을 해제해야 합니다.',
      cmd: `T="$(cat ~/.lively/token)"; G="$(sed 's#/mcp$##' ~/.lively/gateway-url)"; curl -fsSL -H "Authorization: Bearer $T" "$G/install" -o /tmp/lv.tgz && rm -rf /tmp/lv && mkdir -p /tmp/lv && tar -xzf /tmp/lv.tgz -C /tmp/lv && bash /tmp/lv/setup/uninstall-mac.sh` },
  ];
}

// ── 공용 UI 헬퍼 ──
function field(label, control) {
  return el('div', { class: 'field' }, el('label', { class: 'field-label', text: label }), control);
}
// 필드 라벨 바로 옆에 '이게 뭐예요?' 트리거를 붙이는 변형(필드 단위 설명용).
function fieldWithHelp(label, control, m) {
  return el('div', { class: 'field' },
    el('div', { class: 'field-label-row' }, el('label', { class: 'field-label', text: label }), meaningCard(m)),
    control);
}
// 클립보드 복사 — navigator.clipboard 는 보안 컨텍스트(https/localhost)에서만 동작한다.
// http://dev.lvly.io:8080 같은 비보안 origin 에선 undefined 이므로, execCommand('copy') 텍스트영역 폴백을 쓴다.
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* 폴백으로 */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.left = '0'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select(); ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}
function copyButton(getText, label) {
  const b = el('button', { class: 'btn btn-ghost btn-sm', text: label || '복사' });
  b.addEventListener('click', async () => {
    if (await copyText(getText())) toast('복사됨');
    else toast('복사 실패 — 명령을 직접 선택해 복사하세요', true);
  });
  return b;
}
function overlay(title, ...content) {
  const close = el('button', { class: 'btn btn-ghost btn-sm', text: '닫기' });
  const box = el('div', { class: 'ov-box' }, el('div', { class: 'ov-head' }, el('h3', { text: title }), close), ...content);
  const back = el('div', { class: 'ov-back' }, box);
  close.addEventListener('click', () => back.remove());
  back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
  document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') { back.remove(); document.removeEventListener('keydown', esc); } });
  document.body.append(back);
  return back;
}
