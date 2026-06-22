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
//   5) 관리(#/system)      — 3 중분류(기본 설정·회사·조직·AI 동작/연결 고급) 가로 탭으로 묶은 조직 관리(연결/멤버/토큰/발행·규칙/맥락/메모리/용어·훅/툴/MCP/DB).
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
// 작업↔지식 연결 관계 라벨(activity_ku_ref.relation) — produced=산출, references=참조, decided=결정 근거.
const REF_REL_LABEL = { produced: '산출', references: '참조', decided: '결정' };
// should/is 점검 결과 라벨(activity.should_review/is_review) — 도메인 의도(should)·코드구조(is) 점검 3-state.
const REVIEW_LABEL = { na: '해당 없음', checked_no_change: '점검함(변화 없음)', changed: '변경됨' };

const state = {
  me: null,
  overview: null,        // /api/ui/ctx/overview 캐시(지도 + 검토 배지 + 탐색 kind 트리 공유)
  browse: { filters: { kind: '', space: '', domain: '', lifecycle: 'active', confidence: '', q: '', orderBy: 'updated_at' }, entries: [], loaded: false },
  reviewOrderBy: 'updated_at', // 검토 피드 정렬(기본 최신순)
  admin: { data: null, sel: 'kinds', memberSel: null, memorySel: null, repoSel: null, navCollapsed: false }, // 관리(전달) 페이지 상태
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
function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
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
const CTX_SUBS = [
  { key: 'map', label: '지도', href: '#/map' },
  { key: 'browse', label: '탐색', href: '#/browse' },
  { key: 'domainmap', label: '도메인 맵', href: '#/domainmap' },
  { key: 'review', label: '검토', href: '#/review' },
];
function ctxSubBar(active) {
  const bar = el('div', { class: 'sub-cats', role: 'tablist', 'aria-label': '회사 맥락' });
  for (const s of CTX_SUBS) {
    const on = s.key === active;
    const a = el('a', { class: 'sub-cat' + (on ? ' active' : ''), href: s.href,
      role: 'tab', 'aria-selected': on ? 'true' : 'false', text: s.label });
    if (s.key === 'review') { // 하위 칩에도 검토 대기 건수(상위 탭 배지와 별개)
      const n = state.overview ? state.overview.review_pending : 0;
      if (n > 0) a.append(el('span', { class: 'tab-count', text: String(n) }));
    }
    bar.append(a);
  }
  return bar;
}

// '시작하기' 상위 탭의 가로 중분류(설치·사용설명서) — 같은 sub-cats 패턴. 가이드는 top 탭에서 빼 여기로(한 번 읽는 온보딩).
const START_SUBS = [
  { key: 'install', label: '설치', href: '#/install' },
  { key: 'learn', label: '사용설명서', href: '#/learn' },
];
function startSubBar(active) {
  const bar = el('div', { class: 'sub-cats', role: 'tablist', 'aria-label': '시작하기' });
  for (const s of START_SUBS) {
    const on = s.key === active;
    bar.append(el('a', { class: 'sub-cat' + (on ? ' active' : ''), href: s.href,
      role: 'tab', 'aria-selected': on ? 'true' : 'false', text: s.label }));
  }
  return bar;
}

async function renderMap(view) {
  view.replaceChildren(skeleton('지식 지도를 불러오는 중'));
  const o = await getOverview(true);
  const head = el('div', { class: 'page-head' },
    el('h1', {}, '지식 ', el('span', { class: 'accent', text: '지도' })),
    el('p', { class: 'sub', text: '회사의 살아있는 맥락을 종류(kind)별로 한눈에. 폴더(종류)를 열면 그 안의 지식 단위를 볼 수 있습니다.' }),
  );

  // 시스템 건강 — 조용한 숫자 + 여백(§0.5 제품 히어로). total_active 는 큐레이션(observed 제외),
  //  수집물(observed_count)은 커넥터 원천이라 별도 카운트로 분리 노출(H2 — 큐레이션과 섞지 않음).
  const healthStats = [
    stat(fmtNum(o.total_active), '활성 지식 단위', '건'),
    stat(fmtNum(o.kinds.filter((k) => k.active_count > 0).length), '사용 중인 종류', '/ ' + o.kinds.length),
  ];
  if (o.observed_count > 0) healthStats.push(collectedStat(o.observed_count));
  healthStats.push(reviewStat(o.review_pending));
  const health = el('div', { class: 'card health-card' },
    el('div', { class: 'stat-row' }, ...healthStats),
  );

  // kind 카드 그리드 — 라벨·active수·injection_mode·최신성.
  const grid = el('div', { class: 'kind-grid' });
  const cards = [];
  for (const k of o.kinds) {
    const meta = kindMeta(k.kind);
    const fed = isFederatedKind(k.kind);
    const card = el('a', {
      class: 'kind-card' + (k.active_count === 0 ? ' empty' : ''),
      href: '#/browse?kind=' + encodeURIComponent(k.kind),
      role: 'link', tabindex: '0',
    },
      el('div', { class: 'kind-card-top' },
        el('span', { class: 'kind-glyph', 'aria-hidden': 'true', text: k.kind }),
        fed
          ? el('span', { class: 'kind-inject', title: 'domainmap 파생(ku 종류 아님) — 읽기 전용으로 표시', text: 'federated' })
          : el('span', { class: 'kind-inject', title: INJECTION_HINT[k.injection_mode] || '', text: INJECTION_LABEL[k.injection_mode] || k.injection_mode }),
      ),
      el('div', { class: 'kind-card-name', text: meta.ko || k.label || k.kind }),
      el('div', { class: 'kind-card-sub', text: k.label || (meta.label || '') }),
      el('div', { class: 'kind-card-foot' },
        el('span', { class: 'kind-card-num' }, String(k.active_count), el('small', {}, ' 건')),
        k.latest_updated_at
          ? el('span', { class: 'kind-card-fresh' }, k.active_count > 0 ? el('span', { class: 'dot6 ok', 'aria-hidden': 'true' }) : null, relTime(k.latest_updated_at))
          : el('span', { class: 'kind-card-fresh dim', text: '비어 있음' }),
      ),
    );
    cards.push(card);
    grid.append(card);
  }

  // 주제(area) 섹션 — space(제품/비즈니스) 2단의 1차 축. domainmap 에서 도메인을 받아 space 로 묶어
  //  각 영역을 browse?space= 로 진입하는 카드로 보여준다(2차 domain 은 탐색에서). domainmap down 시 graceful 생략.
  const areaWrap = el('div', { class: 'kind-grid area-grid' });
  const areaEyebrow = el('div', { class: 'eyebrow', text: '주제 영역' });
  areaEyebrow.hidden = true; areaWrap.hidden = true;

  view.replaceChildren(ctxSubBar('map'), head, health, el('div', { class: 'eyebrow', text: '종류별 지식' }), grid, areaEyebrow, areaWrap);
  applyReveal([health, ...cards]);
  document.getElementById('view').focus?.();

  // 비동기 area 로드(렌더 차단 안 함) — 성공 시에만 영역 카드 노출.
  loadAllDomains().then((slot) => {
    if (slot.error || !slot.list.length) return;
    const counts = { product: 0, business: 0 };
    for (const d of slot.list) { const sp = (d.space || 'product') === 'business' ? 'business' : 'product'; counts[sp]++; }
    const SPACE_CARDS = [
      { space: 'product', name: '제품 도메인', sub: '코드앵커·부채추적이 붙는 제품 영역' },
      { space: 'business', name: '비즈니스 기능', sub: 'GTM·가격·펀딩·시장경쟁·브랜드·조직' },
    ];
    for (const sc of SPACE_CARDS) {
      if (!counts[sc.space]) continue;
      areaWrap.append(el('a', { class: 'kind-card area-card', href: '#/browse?space=' + sc.space, role: 'link', tabindex: '0' },
        el('div', { class: 'kind-card-name', text: sc.name }),
        el('div', { class: 'kind-card-sub', text: sc.sub }),
        el('div', { class: 'kind-card-foot' },
          el('span', { class: 'kind-card-num' }, String(counts[sc.space]), el('small', {}, ' 도메인')))));
    }
    if (areaWrap.childNodes.length) { areaEyebrow.hidden = false; areaWrap.hidden = false; }
  }).catch(() => { /* graceful: area 섹션 생략 */ });
}

function stat(num, label, unit) {
  return el('div', { class: 'stat' },
    el('div', { class: 'num' }, num, unit ? el('small', {}, ' ' + unit) : null),
    el('div', { class: 'lbl', text: label }));
}
// 검토 대기 — 0 이면 무채(건강), >0 이면 클릭 가능(검토로 이동).
function reviewStat(n) {
  if (!n) {
    return el('div', { class: 'stat' },
      el('div', { class: 'num' }, '0'),
      el('div', { class: 'lbl', text: '검토 대기 없음' }));
  }
  const s = el('a', { class: 'stat stat-link', href: '#/review' },
    el('div', { class: 'num' }, fmtNum(n), el('small', {}, ' 건')),
    el('div', { class: 'lbl' }, el('span', { class: 'dot6 ok', 'aria-hidden': 'true' }), ' 검토 대기'));
  return s;
}
// 외부 미러(observed) — 커넥터가 가져온 외부 시스템의 살아있는 미러(출처=observed). 큐레이션 저작물과
//  의미가 달라 별도 카운트로 노출(overview observed_count). 클릭 시 탐색을 provenance=observed 로 필터.
function collectedStat(n) {
  return el('a', { class: 'stat stat-link', href: '#/browse?confidence=observed' },
    el('div', { class: 'num' }, fmtNum(n), el('small', {}, ' 건')),
    el('div', { class: 'lbl', text: '외부 미러(커넥터)' }));
}

// ════════════════════════════════════════════
// 2) 탐색 #/browse — 좌 kind/domain 트리 + grep 검색 + 필터 목록.
// ════════════════════════════════════════════
async function renderBrowse(view, params) {
  // URL 파라미터 → 필터 동기화(지도 카드 클릭 진입 등).
  const f = state.browse.filters;
  if (params) {
    if (params.has('kind')) f.kind = params.get('kind') || '';
    if (params.has('space')) f.space = params.get('space') || '';
    if (params.has('domain')) f.domain = params.get('domain') || '';
    if (params.has('q')) f.q = params.get('q') || '';
    if (params.has('lifecycle')) f.lifecycle = params.get('lifecycle') || '';
    if (params.has('confidence')) f.confidence = params.get('confidence') || '';
    if (params.has('orderBy')) f.orderBy = params.get('orderBy') || 'updated_at';
  }
  if (!f.orderBy) f.orderBy = 'updated_at';

  const o = await getOverview(false);
  const domSlot = await loadAllDomains();

  // ── 좌측 = 종류(kind, 위) + 주제 위계(space>domain, 아래). 카운트는 절대수치가 아니라 **facet**(현재 다른 필터와의
  //  교집합) — refetch 응답의 facets 로 buildSide 가 갱신한다(kind=지식 선택 시 주제 카운트도 '그 도메인의 지식 수'). ──
  const SPACE_LABEL = { product: '제품 도메인', business: '비즈니스 기능' };
  const side = el('aside', { class: 'browse-side' });
  function buildSide(facets) {
    const domF = (facets && facets.domains) || {};
    const kindF = (facets && facets.kinds) || {};
    // 종류(kind) — 4종 항상 표시(선택지). '전체'=facet 합(현재 필터에서 kind 무관 총). 카운트=교집합.
    const tree = el('nav', { class: 'browse-tree', 'aria-label': 'kind 트리' });
    const kindTotal = Object.values(kindF).reduce((a, b) => a + (Number(b) || 0), 0);
    tree.append(treeItem('전체', '', f.kind === '', kindTotal));
    for (const k of o.kinds) {
      tree.append(treeItem(kindMeta(k.kind).ko || k.label || k.kind, k.kind, f.kind === k.kind, Number(kindF[k.kind]) || 0, k.kind));
    }
    // 주제(space>domain) — facet count>0 도메인만(현재 필터 교집합). 도메인목록 down 이면 생략.
    const areaNav = el('nav', { class: 'browse-tree area-tree', 'aria-label': '주제(space·도메인) 위계' });
    areaNav.append(areaItem('전체 주제', '', '', f.space === '' && f.domain === '', null, '∗'));
    if (!domSlot.error) {
      const bySpace = { product: [], business: [] };
      for (const d of domSlot.list) {
        const cnt = Number(domF[d.key]) || 0;
        if (!(cnt > 0)) continue; // 현재 필터 교집합으로 존재하는 도메인만
        const sp = (d.space || 'product') === 'business' ? 'business' : 'product';
        bySpace[sp].push({ d, cnt });
      }
      for (const sp of ['product', 'business']) {
        if (!bySpace[sp].length) continue;
        areaNav.append(areaItem(SPACE_LABEL[sp], sp, '', f.space === sp && f.domain === '', null, sp === 'business' ? '◴' : '◆', 'area-space'));
        for (const { d, cnt } of bySpace[sp]) {
          const label = (d.name && d.name !== d.key) ? d.name : d.key;
          areaNav.append(areaItem(label, sp, d.key, f.domain === d.key, cnt, '·', 'area-domain'));
        }
      }
    }
    side.replaceChildren(
      el('div', { class: 'eyebrow', text: '종류' }), tree,
      el('div', { class: 'eyebrow', style: 'margin-top:16px', text: '주제' }), areaNav);
  }

  // 상단 검색 + 필터 바(주제 필터는 좌측 위계로 이동 — 여기엔 검색·상태·출처·정렬만).
  const qInput = el('input', { type: 'search', placeholder: '제목·본문 검색(grep)', value: f.q, 'aria-label': '검색어' });
  const lifecycleSel = selectFilter([
    ['active', '유효'], ['', '전체 상태'], ['rejected', '반려'], ['superseded', '대체됨'],
  ], f.lifecycle);
  const confidenceSel = selectFilter([
    ['', '전체 출처'], ['ai', 'AI'], ['human', '사람'], ['rule', '규칙'], ['observed', '외부 미러(커넥터)'],
  ], f.confidence);
  // 정렬 — 최신순(updated_at, 기본)/이름순(name)/수동(sort). 백엔드 orderBy 화이트리스트.
  const orderSel = selectFilter(SORT_OPTS, f.orderBy);
  orderSel.setAttribute('aria-label', '정렬');

  const listBox = el('div', { class: 'list-box browse-list' });
  const foot = el('div', { class: 'list-foot' });

  function syncHash() {
    const p = new URLSearchParams();
    if (f.kind) p.set('kind', f.kind);
    if (f.space) p.set('space', f.space);
    if (f.domain) p.set('domain', f.domain);
    if (f.q) p.set('q', f.q);
    if (f.lifecycle && f.lifecycle !== 'active') p.set('lifecycle', f.lifecycle);
    if (f.confidence) p.set('confidence', f.confidence);
    if (f.orderBy && f.orderBy !== 'updated_at') p.set('orderBy', f.orderBy);
    const qs = p.toString();
    history.replaceState(null, '', '#/browse' + (qs ? '?' + qs : ''));
  }

  async function refetch() {
    listBox.replaceChildren(skeletonRows(4));
    foot.replaceChildren();
    try {
      let entries, facets;
      if (f.q.trim()) {
        // grep 경로 — 스니펫 포함. lifecycle/confidence 는 grep 백엔드 미지원이라 클라이언트에서 표시만.
        const r = await api('/api/ui/ctx/grep?' + new URLSearchParams(
          Object.assign({ query: f.q.trim(), limit: '50', orderBy: f.orderBy || 'updated_at' }, f.kind ? { kind: f.kind } : {}, f.domain ? { domain: f.domain } : {})));
        entries = (r.matches || []).map((m) => ({ ...m, _snippet: m.snippet })); facets = r.facets;
      } else {
        const p = new URLSearchParams({ limit: '200' });
        if (f.kind) p.set('kind', f.kind);
        if (f.domain) p.set('domain', f.domain);
        if (f.lifecycle) p.set('lifecycle', f.lifecycle);
        if (f.confidence) p.set('confidence', f.confidence);
        p.set('orderBy', f.orderBy || 'updated_at');
        const r = await api('/api/ui/ctx/ls?' + p.toString());
        entries = r.entries || []; facets = r.facets;
      }
      state.browse.entries = entries;
      buildSide(facets); // 좌측 카운트 = 현재 필터 교집합(facet)으로 갱신
      renderEntries(listBox, entries, !!f.q.trim());
      foot.replaceChildren(el('span', { class: 'caption', text: entries.length + '건' + (f.q.trim() ? ' (검색)' : '') }));
    } catch (e) {
      listBox.replaceChildren(errorNote(e, '목록을 불러오지 못했습니다'));
    }
  }

  let qTimer = null;
  qInput.addEventListener('input', () => { f.q = qInput.value; clearTimeout(qTimer); qTimer = setTimeout(() => { syncHash(); refetch(); }, 280); });
  lifecycleSel.addEventListener('change', () => { f.lifecycle = lifecycleSel.value; syncHash(); refetch(); });
  confidenceSel.addEventListener('change', () => { f.confidence = confidenceSel.value; syncHash(); refetch(); });
  orderSel.addEventListener('change', () => { f.orderBy = orderSel.value; syncHash(); refetch(); });
  // 좌측 클릭 위임(side 컨테이너 — buildSide 가 내부를 교체해도 핸들러 유지). 'on' 표시는 refetch→buildSide 가 f 기준 재계산.
  side.addEventListener('click', (ev) => {
    const kItem = ev.target.closest('[data-kind-val]');
    if (kItem) { ev.preventDefault(); f.kind = kItem.dataset.kindVal; syncHash(); refetch(); return; }
    const aItem = ev.target.closest('[data-area-space]');
    if (aItem) { ev.preventDefault(); f.space = aItem.dataset.areaSpace || ''; f.domain = aItem.dataset.areaDomain || ''; syncHash(); refetch(); return; }
  });

  const head = el('div', { class: 'page-head' },
    el('h1', {}, '탐색'),
    el('p', { class: 'sub', text: '왼쪽에서 주제(제품 도메인/비즈니스 기능)나 종류로 좁히고, 위에서 상태·출처·정렬을 고르거나 검색어로 제목·본문을 grep 합니다. 항목을 누르면 전문과 메타를 봅니다.' }),
  );
  const filterBar = el('div', { class: 'filter-bar browse-filter' }, qInput, lifecycleSel, confidenceSel, orderSel,
    el('button', { class: 'btn btn-primary btn-sm', text: '+ 새 지식', onclick: () => openSaveOverlay(f.kind, f.domain, refetch) }));

  const layout = el('div', { class: 'browse-layout' },
    side,
    el('section', { class: 'browse-main' }, filterBar, listBox, foot),
  );
  view.replaceChildren(ctxSubBar('browse'), head, layout);
  applyReveal([layout]);
  refetch();
}

// 주제 위계 행 — space(1차)/domain(2차) 둘 다 data-* 로 들고 클릭 위임에서 동시 설정.
//  variant: '' | 'area-space'(1차 헤더) | 'area-domain'(2차, 들여쓰기). glyph/count 는 보조.
function areaItem(label, space, domain, on, count, glyph, variant) {
  return el('a', { class: 'tree-item' + (variant ? ' ' + variant : '') + (on ? ' on' : ''), href: '#',
    'data-area-space': space, 'data-area-domain': domain, role: 'button', tabindex: '0' },
    el('span', { class: 'tree-glyph' + (variant === 'area-domain' ? ' all' : ''), 'aria-hidden': 'true', text: glyph || '·' }),
    el('span', { class: 'tree-label', text: label }),
    el('span', { class: 'tree-count', text: count != null ? String(count) : '' }));
}

function treeItem(label, kindVal, on, count, glyph) {
  return el('a', { class: 'tree-item' + (on ? ' on' : ''), href: '#', 'data-kind-val': kindVal, role: 'button', tabindex: '0' },
    glyph ? el('span', { class: 'tree-glyph', 'aria-hidden': 'true', text: glyph }) : el('span', { class: 'tree-glyph all', 'aria-hidden': 'true', text: '∗' }),
    el('span', { class: 'tree-label', text: label }),
    el('span', { class: 'tree-count', text: count != null ? String(count) : '' }));
}

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
function buildSpaceSelect(current) {
  return selectFilter([['', '전체 주제'], ['product', '제품 도메인'], ['business', '비즈니스 기능']], current);
}

function renderEntries(box, entries, isSearch) {
  if (!entries.length) {
    box.replaceChildren(el('div', { class: 'empty', text: '조건에 맞는 지식 단위가 없습니다. 필터를 넓히거나 새 지식을 추가하세요.' }));
    return;
  }
  box.replaceChildren();
  for (const e of entries) {
    const metaBits = [];
    if (e.kind) metaBits.push(kindBadge(e.kind));
    if (e.domain_key) metaBits.push(el('span', { class: 'mono', text: e.domain_key }));
    const row = el('div', { class: 'row', role: 'link', tabindex: '0' },
      el('div', { class: 'row-title', text: e.title || e.name }),
      el('div', { class: 'row-meta' }, ...interleave(metaBits, ' · '),
        e.lifecycle ? el('span', {}, '  ', lifecycleDot(e.lifecycle)) : null,
        // 수집물(observed)은 출처 점을 함께 표기(큐레이션과 구분) — ctx_ls 가 confidence 반환(grep 결과엔 없음).
        e.confidence === 'observed' ? el('span', {}, '  ', confidenceDot(e.confidence)) : null,
        '  ', relTime(e.updated_at)),
      isSearch && e._snippet ? el('div', { class: 'snippet-2l', text: e._snippet }) : null,
    );
    const go = () => { location.hash = '#/u/' + encodeURIComponent(e.name); };
    row.addEventListener('click', go);
    row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
    box.append(row);
  }
}

function kindBadge(k) {
  return el('span', { class: 'kind-badge', title: kindLabel(k) }, el('span', { class: 'kb-glyph', text: k }), el('span', { class: 'kb-ko', text: kindLabel(k) }));
}
function interleave(arr, sep) {
  const out = [];
  arr.forEach((n, i) => { if (i) out.push(sep); out.push(n); });
  return out;
}

// ════════════════════════════════════════════
// 3) 유닛 상세 #/u/<name> — ctx_cat 전문 + 메타 패널 + 편집/반려.
// ════════════════════════════════════════════
async function renderUnit(view, name) {
  view.replaceChildren(skeleton('지식 단위를 불러오는 중'));
  let u;
  try {
    // history=1 — 수정 이력(누가/언제/경로/내용) 동반 fetch(메타 패널 아래 '수정 이력' 섹션 렌더).
    u = await api('/api/ui/ctx/cat?history=1&name=' + encodeURIComponent(name));
  } catch (e) {
    if (e.status === 404) {
      view.replaceChildren(el('div', { class: 'page-head' }, el('h1', { text: '없는 지식 단위' })),
        el('div', { class: 'note', text: "'" + name + "' 을(를) 찾을 수 없습니다. 탐색에서 이름을 확인하세요." }),
        el('a', { class: 'btn btn-ghost btn-sm', href: '#/browse', text: '← 탐색으로' }));
      return;
    }
    throw e;
  }
  drawUnit(view, u);
}

function drawUnit(view, u) {
  const backRow = el('div', { class: 'crumbs' },
    el('a', { class: 'crumb-link', href: '#/browse', text: '탐색' }), el('span', { class: 'crumb-sep', text: ' / ' }),
    el('a', { class: 'crumb-link', href: '#/browse?kind=' + encodeURIComponent(u.kind), text: kindLabel(u.kind) }),
    u.domain_key ? el('span', {}, el('span', { class: 'crumb-sep', text: ' / ' }), el('span', { class: 'mono', text: u.domain_key })) : null,
  );

  // 본문(전문). 모든 body_md 는 마크다운(_md) — 안전 렌더러로 서식 표시(비개발자 친화).
  // 보안(P4b): 렌더러는 createElement + textContent 로만 DOM 구성, innerHTML 류 미사용이라 HTML 주입 불가능.
  // raw 토글로 원문(평문 pre-wrap)도 볼 수 있다.
  const rawText = u.body_md || '';
  const bodyWrap = el('div', { class: 'unit-body-wrap' });
  let showingRaw = false;
  const rendered = rawText
    ? el('div', { class: 'unit-body md-rendered' }, renderMarkdown(rawText))
    : el('div', { class: 'body-text unit-body', text: '(본문 없음)' });
  const rawView = el('pre', { class: 'body-text unit-body unit-body-raw', text: rawText });
  rawView.hidden = true;
  const rawToggle = rawText
    ? el('button', { class: 'btn btn-ghost btn-sm md-raw-toggle', text: '원문 보기',
        onclick: () => {
          showingRaw = !showingRaw;
          rendered.hidden = showingRaw;
          rawView.hidden = !showingRaw;
          rawToggle.textContent = showingRaw ? '서식 보기' : '원문 보기';
        } })
    : null;
  bodyWrap.append(rendered, rawView);

  // 메타 패널(우) — kind·kinds·confidence·lifecycle·supersedes·author·source_ref·as_of·version.
  // 작성자(노출 — 숨기지 않음): 라이브 author 컬럼은 authored 행에서 NULL 이라 무의미 → updated_by(=actor) 우선.
  //  최신 리비전의 actor_kind(누가)/channel(경로) 라벨을 함께 보여 "yoon (사람·웹)" 형태로 식별성을 높인다.
  const latestRev = Array.isArray(u.history) && u.history.length ? u.history[0] : null;
  const authorActor = u.updated_by || u.author || null;
  let authorLabel = '—';
  if (authorActor) {
    const akKo = latestRev && latestRev.actor_kind ? (ACTOR_KIND_LABEL[latestRev.actor_kind] || latestRev.actor_kind) : null;
    const chKo = latestRev && latestRev.channel ? (CHANNEL_LABEL[latestRev.channel] || latestRev.channel) : null;
    const suffix = (akKo || chKo) ? ' (' + [akKo, chKo].filter(Boolean).join(' · ') + ')' : '';
    authorLabel = authorActor + suffix;
  }
  const metaRows = [
    ['종류(kind)', kindLabel(u.kind) + ' (' + u.kind + ')'],
    Array.isArray(u.kinds) && u.kinds.length ? ['추가 종류', u.kinds.join(', ')] : null,
    ['도메인', u.domain_key ? (u.domain_key + (u.domain_repo ? ' · ' + u.domain_repo : '')) : '—'],
    ['출처(provenance)', CONFIDENCE_LABEL[u.confidence] || u.confidence],
    ['supersedes', u.supersedes || '—'],
    ['작성자/마지막 편집', authorLabel],
    ['출처(source_ref)', u.source_ref || '—'],
    ['기준 시각(as_of)', u.as_of ? absTime(u.as_of) : '—'],
    ['버전', 'v' + u.version],
    ['마지막 갱신', (u.updated_at ? absTime(u.updated_at) : '—') + (u.updated_by ? ' · ' + u.updated_by : '')],
  ].filter(Boolean);
  // 메타 — 본문 위 가로 바(라벨:값, 와이드에서 auto-fill 다열 grid). 우측 절반 점유 폐기.
  const metaBar = el('div', { class: 'unit-metabar' });
  for (const [k, v] of metaRows) metaBar.append(el('div', { class: 'umeta' }, el('span', { class: 'umeta-k', text: k }), el('span', { class: 'umeta-v', text: v })));

  // 상태 액션 — 신뢰우선 모델의 사후 반려/복원(채운 버튼 1개=주행동만, 나머지 ghost).
  const actions = el('div', { class: 'unit-actions' });
  actions.append(el('button', { class: 'btn btn-primary btn-sm', text: '편집', onclick: () => openEditOverlay(u) }));
  if (u.lifecycle === 'active') {
    actions.append(el('button', { class: 'btn btn-ghost btn-sm', text: '반려', onclick: () => changeLifecycle(u.name, 'rejected', view) }));
  } else if (u.lifecycle === 'rejected') {
    actions.append(el('button', { class: 'btn btn-ghost btn-sm', text: '복원', onclick: () => changeLifecycle(u.name, 'active', view) }));
  }

  // 메타는 상단 접이식 바(기본 펼침). 수정 이력은 본문 아래 별도 접이식. 단일 컬럼 — 본문이 가독폭을 갖는다.
  const metaWrap = el('details', { class: 'unit-meta-details', open: '' },
    el('summary', { class: 'unit-meta-summary' }, '메타데이터'),
    metaBar,
  );
  const histSection = buildHistorySection(u);
  const historyWrap = histSection ? el('details', { class: 'unit-history-details' },
    el('summary', { class: 'unit-meta-summary' }, '수정 이력'),
    histSection,
  ) : null;
  const main = el('div', { class: 'detail-card unit-card' },
    el('div', { class: 'unit-title-row' },
      el('h1', { class: 'detail-title', text: u.title || u.name }),
      lifecycleDot(u.lifecycle),
    ),
    el('div', { class: 'detail-meta' }, el('span', { class: 'mono', text: u.name }), confidenceDot(u.confidence)),
    actions,
    metaWrap,
    el('div', { class: 'sec-label sec-label-row' }, el('span', { text: '본문' }), rawToggle),
    bodyWrap,
    historyWrap,
  );
  const head = el('div', { class: 'page-head unit-head' }, backRow);
  view.replaceChildren(head, main);
  applyReveal([main]);
}

// 수정 이력(작성자/리비전) 섹션 — 누가(actor_kind 뱃지)·언제(절대시각)·어떤경로(channel 뱃지)·무슨작업(op)을 타임라인으로.
//  접이식(<details>): 기본 접힘(토큰/공간 절약). 본문 스냅샷(body_snippet)은 행 펼침 없이 회색 보조텍스트로.
//  보안: 모든 텍스트 textContent(el) — innerHTML 미사용. 데이터 없으면 섹션 생략.
function buildHistorySection(u) {
  const revs = Array.isArray(u.history) ? u.history : [];
  if (!revs.length) return null;
  const list = el('div', { class: 'rev-list' });
  for (const r of revs) {
    const akKo = r.actor_kind ? (ACTOR_KIND_LABEL[r.actor_kind] || r.actor_kind) : null;
    const chKo = r.channel ? (CHANNEL_LABEL[r.channel] || r.channel) : null;
    const opKo = REV_OP_LABEL[r.op] || r.op;
    const badges = el('div', { class: 'rev-badges' },
      el('span', { class: 'rev-ver mono', text: 'v' + r.version }),
      el('span', { class: 'rev-op', text: opKo }),
      akKo ? el('span', { class: 'rev-badge rev-actor-' + (r.actor_kind || 'unknown'), text: akKo }) : null,
      chKo ? el('span', { class: 'rev-badge rev-chan', text: chKo }) : null,
    );
    const meta = el('div', { class: 'rev-meta' },
      el('span', { class: 'rev-actor', text: r.actor || '—' }),
      el('span', { class: 'rev-sep', text: ' · ' }),
      el('span', { class: 'rev-time', text: r.at ? absTime(r.at) : '—' }),
    );
    const row = el('div', { class: 'rev-row' }, badges, meta);
    if (r.body_snippet) row.append(el('div', { class: 'rev-snippet', text: r.body_snippet }));
    list.append(row);
  }
  const count = typeof u.history_count === 'number' ? u.history_count : revs.length;
  const summary = el('summary', { class: 'rev-summary' },
    '수정 이력', el('span', { class: 'rev-count', text: ' (' + count + ')' }));
  const det = el('details', { class: 'rev-details' }, summary, list);
  return det;
}

async function changeLifecycle(name, lifecycle, view) {
  try {
    await api('/api/ui/ctx/set-lifecycle', { method: 'POST', body: JSON.stringify({ name, lifecycle }) });
    toast(lifecycle === 'rejected' ? '반려했습니다' : (lifecycle === 'active' ? '복원했습니다' : '상태를 바꿨습니다'));
    state.overview = null; // 검토 배지·지도 카운트 무효화
    getOverview(true).catch(() => {});
    // 상세 재로딩(이력 동반 — 방금 set_lifecycle 리비전이 타임라인에 반영되도록)
    const u = await api('/api/ui/ctx/cat?history=1&name=' + encodeURIComponent(name));
    drawUnit(view, u);
  } catch (e) {
    toast('상태 변경 실패 — ' + e.message, true);
  }
}

// ════════════════════════════════════════════
// 4) 검토 #/review — confidence=ai·lifecycle=active 피드(에이전트 생산물) → reject/edit.
// ════════════════════════════════════════════
async function renderReview(view) {
  view.replaceChildren(skeleton('검토 대기 항목을 불러오는 중'));
  const head = el('div', { class: 'page-head' },
    el('h1', {}, '검토'),
    el('p', { class: 'sub', text: 'AI 에이전트가 생성한 지식(출처=AI)을 사후 검토합니다. 저장은 무게이트(신뢰 우선), 반려는 여기서 — 보고 내려둘지 결정하세요.' }),
  );
  // 정렬 — 검토 피드도 최신순 기본(백엔드 orderBy). 새로 생성된 에이전트 산출물부터 보이게.
  const orderSel = selectFilter(SORT_OPTS, state.reviewOrderBy || 'updated_at');
  orderSel.setAttribute('aria-label', '정렬');
  orderSel.addEventListener('change', () => { state.reviewOrderBy = orderSel.value; load(); });
  const filterBar = el('div', { class: 'filter-bar review-filter' }, el('span', { class: 'field-label', text: '정렬' }), orderSel);
  const listBox = el('div', { class: 'list-box' });
  view.replaceChildren(ctxSubBar('review'), head, filterBar, listBox);

  async function load() {
  listBox.replaceChildren(skeletonRows(4));
  try {
    const r = await api('/api/ui/ctx/ls?' + new URLSearchParams({ confidence: 'ai', lifecycle: 'active', limit: '200', orderBy: state.reviewOrderBy || 'updated_at' }));
    const entries = r.entries || [];
    if (!entries.length) {
      listBox.replaceChildren(el('div', { class: 'empty', text: '검토 대기 중인 에이전트 생산물이 없습니다. 모두 확인되었습니다.' }));
      return;
    }
    listBox.replaceChildren();
    for (const e of entries) {
      const row = el('div', { class: 'review-row' },
        el('div', { class: 'review-main' },
          el('a', { class: 'review-title', href: '#/u/' + encodeURIComponent(e.name), text: e.title || e.name }),
          el('div', { class: 'row-meta' }, kindBadge(e.kind),
            e.domain_key ? el('span', {}, '  ', el('span', { class: 'mono', text: e.domain_key })) : null,
            '  ', relTime(e.updated_at)),
        ),
        el('div', { class: 'review-acts' },
          el('a', { class: 'btn btn-ghost btn-sm', href: '#/u/' + encodeURIComponent(e.name), text: '보기 · 편집' }),
          el('button', { class: 'btn btn-ghost btn-sm', text: '반려', onclick: async (ev) => {
            ev.preventDefault();
            try {
              await api('/api/ui/ctx/set-lifecycle', { method: 'POST', body: JSON.stringify({ name: e.name, lifecycle: 'rejected' }) });
              row.classList.add('flash');
              setTimeout(() => row.remove(), reducedMotion() ? 0 : 350);
              toast('반려했습니다');
              state.overview = null; getOverview(true).then(() => { if (!listBox.querySelector('.review-row')) listBox.replaceChildren(el('div', { class: 'empty', text: '검토 대기 중인 항목이 없습니다.' })); }).catch(() => {});
            } catch (err) { toast('반려 실패 — ' + err.message, true); }
          } }),
        ),
      );
      listBox.append(row);
    }
  } catch (e) {
    listBox.replaceChildren(errorNote(e, '검토 목록을 불러오지 못했습니다'));
  }
  }
  load();
}

// ════════════════════════════════════════════
// 도메인 맵 #/domainmap — 회사맥락 하위. 도메인마다 should(의도)·is(코드 구조)를 나란히 두고
//  둘의 괴리(debt)를 드러낸다. + 두 축의 변화 이력: 의도(should) 변경(누가·어떤 작업으로) /
//  커밋이 구조(is)를 바꾼 이력. 단일 read GET /api/ui/domainmap/map?repo= 가 4묶음을 한 번에 준다.
// ════════════════════════════════════════════
// debt 제목 접두사로 should↔is 괴리 종류 판별(서버 domainmap/core/domain-debt.ts 의 title 규약과 1:1).
const DM_SEV_OF = (title) => /의도-구조 괴리/.test(title) ? 'should_no_is'
  : /구조 증발/.test(title) ? 'vanished' : /구조 침식/.test(title) ? 'eroded' : 'other';
const DM_SEV_LABEL = { should_no_is: '의도-구조 괴리', vanished: '구조 증발', eroded: '구조 침식', other: '이슈' };
const DM_SEV_RANK = { should_no_is: 0, vanished: 1, eroded: 2, other: 3 };
// change_log op 어휘(서버 changelog.ts 불변) → 한국어 라벨.
const DM_OP_LABEL = { insert: '추가', update: '수정', drift: '드리프트', rename: '이름변경', remove: '제거',
  revive: '복구', retomb: '재제거', merge: '병합', reassign: '재배치', restore: '되돌림' };

async function renderDomainmap(view, params) {
  view.replaceChildren(ctxSubBar('domainmap'), skeleton('도메인 맵을 불러오는 중'));
  const repos = await loadRepos();
  let repo = (params && params.get('repo')) || state.dmRepo
    || (repos.includes(VOCAB_CRUD_DEFAULT_REPO) ? VOCAB_CRUD_DEFAULT_REPO : repos[0]);
  if (!repos.includes(repo)) repo = repos[0];
  state.dmRepo = repo;

  const head = el('div', { class: 'page-head' },
    el('h1', {}, '도메인 ', el('span', { class: 'accent', text: '맵' })),
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
    view.replaceChildren(...[ctxSubBar('domainmap'), head, repoBar, errorNote(e, '도메인 맵을 불러오지 못했습니다')].filter(Boolean));
    return;
  }
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

  const nodes = [
    ctxSubBar('domainmap'), head, repoBar, statCard,
    section('도메인별 의도(should) · 구조(is) · 괴리(debt)', repos.length > 1 ? repo : null,
      domains.map(domainRow), '이 레포에 도메인이 없습니다.'),
    section('괴리(debt) — 의도와 구조의 간극', gapCount ? ('should↔is 괴리 ' + fmtNum(gapCount) + '건 포함') : null,
      debtSorted.map(debtRow), '표면화된 괴리·이슈가 없습니다.'),
    section('의도(should) 변경 이력', '누가 · 어떤 작업으로 의도를 바꿨나',
      shoulds.map(shouldChangeRow), '아직 의도(should) 변경 기록이 없습니다. 의도를 설정·수정하면 여기 쌓입니다.'),
    section('커밋 → 구조(is) 변경 이력', '어떤 커밋이 코드 구조를 바꿨나',
      isChanges.map(isChangeRow), '아직 커밋이 구조(is)를 바꾼 기록이 없습니다. commit 작업이 코드를 건드리면 여기 쌓입니다.'),
  ].filter(Boolean);
  view.replaceChildren(...nodes);
}

// ════════════════════════════════════════════
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

async function renderDashboard(view, params) {
  if (!state.dash) state.dash = { expanded: new Set(), filter: { person: '', agent: '', type: '' } };
  // 딥링크(#/dash?person=..&type=..)면 그 필터로 시작. 이후 칩 클릭은 state 로 즉시 반영(무재요청).
  if (params && (params.get('person') || params.get('type') || params.get('agent'))) {
    state.dash.filter = { person: params.get('person') || '', agent: params.get('agent') || '', type: params.get('type') || '' };
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
        el('span', { class: 'dash-latest-title', text: latest.title })) : null,
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
        el('div', { class: 'act-titleline' }, actTypeTag(a.type), el('span', { class: 'act-title', text: a.title })),
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
      (!f.person || (a.author_person || '') === f.person)
      && (!f.agent || (a.author_agent || '') === f.agent)
      && (!f.type || a.type === f.type));
    if (!filtered.length) {
      feedBox.replaceChildren(el('div', { class: 'empty', text: '조건에 맞는 작업이 없습니다. 위 필터를 넓혀 보세요.' }));
      return;
    }
    feedBox.replaceChildren(...filtered.map(activityCard));
  }

  function paint() {
    paintFilters();
    summaryBox.replaceChildren(...people.map(summaryRow));
    renderFeed();
  }

  const sec = (title, hint) => el('div', { class: 'dash-sec-head' },
    el('h2', { class: 'dash-sec-title', text: title }), hint ? el('span', { class: 'dash-sec-hint', text: hint }) : null);

  view.replaceChildren(
    head,
    sec('구성원', '누가 어떤 AI로 얼마나 — 눌러서 그 사람 작업만 보기'),
    summaryBox,
    sec('작업 타임라인', '최근 작업부터 — 작업을 눌러 상세를 펼칩니다'),
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
    learnRow('누가 바꾸나', '관리자는 [관리] 탭에서 규칙·맥락·메모리를 편집하고 [변경사항 적용]하면 모두에게 반영됩니다. 구성원은 한 번만 설치하면 끝입니다.'),
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
    el('a', { href: '#/browse', text: '[탐색] 탭' }), ' 에서 하나씩 열어볼 수 있어요.'));

  view.replaceChildren(startSubBar('learn'), head, whatCard, el('div', { class: 'eyebrow', text: '용어' }), unitCard);
  document.getElementById('view').focus?.();
}

// 설치 탭(#/install) — 모든 구성원의 첫 행동. 비개발자도 그대로 따라 하도록 구성한다.
//  핵심: 쓰는 곳이 두 갈래라 시작법이 다르다 — (web) 라이블리 [터미널] 탭=서버에서 claude/codex 가 돌고
//  회사맥락이 이미 설치돼 있어 '설치 0' / (local) 내 컴퓨터 터미널=내 머신에 한 번 설치. mode 토글로 분기.
//  게이트웨이 주소는 org 프로필에서(loadAdmin — 비-admin 도 안전: tokens redact).
async function renderInstall(view) {
  const head = el('div', { class: 'page-head' },
    el('h1', {}, 'AI 쓰기 ', el('span', { class: 'accent', text: '시작하기' })),
    el('p', { class: 'sub', text: '라이블리에서 AI(Claude Code·Codex)를 쓰는 방법은 두 가지입니다. 아래에서 본인 상황을 고르면, 그에 맞춰 차근차근 안내합니다.' }),
  );
  const slot = el('div', { class: 'install-guide' });
  slot.append(skeleton('설치 안내를 준비하는 중'));
  view.replaceChildren(startSubBar('install'), head, slot);
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

  const note = el('div', { class: 'card install-next' },
    el('div', { class: 'card-head' }, el('h2', { text: '참고' })),
    el('ul', { class: 'step-ul note-ul' },
      el('li', {}, '이 방식이 되려면 ', el('b', { text: '관리자가 서버에 라이블리를 한 번 설치' }), '해 둬야 합니다. 보통 이미 돼 있으니 그냥 쓰면 되고, 안 되면 관리자에게 알려주세요.'),
      el('li', {}, '세션은 팀원과 ', el('b', { text: '공유' }), '하거나 ', el('b', { text: '비공개' }), '로 둘 수 있어요(만들 때 선택).'),
      el('li', {}, '내 노트북 터미널에서 직접 쓰고 싶으면, 위에서 ', el('b', { text: '[내 컴퓨터의 터미널]' }), ' 을 골라 설치하세요.')));

  return [callout, steps, note];
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
    el('p', { class: 'step-p', text: '아래 버튼을 누르면 ‘나만의 설치 명령’이 만들어집니다. 이 명령에는 본인 전용 접속 토큰이 들어 있으니 남과 공유하지 마세요(토큰은 지금 한 번만 보입니다). 만든 다음 [명령 복사]를 누르세요.' }),
    installCmdBox(gw, os, slot, data));

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
      el('a', { href: '#/map', text: '[회사 맥락]' }), ' 탭으로 가보세요. (자동 주입은 ', el('b', { text: '다음 세션부터' }), ' 적용됩니다.)'));

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

// 자가발급 토큰으로 본인 설치 명령을 만들어 보여주는 박스(step 2 내부). 토큰은 state.start.token 에 캐시.
function installCmdBox(gw, os, slot, data) {
  const result = el('div', { class: 'install-cmd-slot' });
  const draw = () => {
    if (!state.start.token) { result.replaceChildren(); return; }
    const cmd = installCmd(gw, os, state.start.token);
    result.replaceChildren(
      el('p', { class: 'install-ok', text: '✓ 내 설치 명령이 만들어졌어요. [명령 복사]를 누른 뒤 3단계로 가세요. (이 토큰은 지금만 보입니다.)' }),
      el('div', { class: 'deploy-head' }, el('span', {}), copyButton(() => cmd, '명령 복사')),
      el('pre', { class: 'admin-preview', text: cmd }));
  };
  const go = el('button', { class: 'btn btn-primary btn-sm', text: state.start.token ? '명령 다시 만들기' : '내 설치 명령 만들기' });
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const r = await api('/api/ui/org/token/self', { method: 'POST', body: '{}' });
      state.start.token = r.token;
      go.textContent = '명령 다시 만들기';
      draw();
    } catch (e) { toast(e.message, true); }
    go.disabled = false;
  });
  draw();
  return el('div', {}, el('div', { class: 'install-minter' }, go), result);
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

// ════════════════════════════════════════════
// 저장/편집 오버레이 — ctx_save(웹→confidence=human 자동).
// ════════════════════════════════════════════
function openSaveOverlay(presetKind, presetDomain, onDone) {
  saveOverlay({ kind: presetKind || 'K', domain: presetDomain || '' }, false, onDone);
}
function openEditOverlay(u) {
  // 편집은 모달이 아니라 별도 라우트(#/u/<name>/edit) — split view 에디터 + 실시간 프리뷰.
  location.hash = '#/u/' + encodeURIComponent(u.name) + '/edit';
}

// ════════════════════════════════════════════
// 지식 편집 페이지 #/u/<name>/edit — split view(좌 textarea 에디터 | 우 실시간 마크다운 프리뷰).
//  모달(saveOverlay) 대신 전체 페이지. 입력 즉시(디바운스) renderMarkdown 으로 우측을 다시 그린다.
//  저장=ctx_save(웹→confidence=human). XSS: 프리뷰는 renderMarkdown(createElement+textContent)만 — innerHTML 0.
// ════════════════════════════════════════════
async function renderEditPage(view, name) {
  view.replaceChildren(skeleton('편집할 지식 단위를 불러오는 중'));
  let u;
  try {
    u = await api('/api/ui/ctx/cat?name=' + encodeURIComponent(name));
  } catch (e) {
    if (e.status === 404) {
      view.replaceChildren(el('div', { class: 'page-head' }, el('h1', { text: '없는 지식 단위' })),
        el('div', { class: 'note', text: "'" + name + "' 을(를) 찾을 수 없습니다." }),
        el('a', { class: 'btn btn-ghost btn-sm', href: '#/browse', text: '← 탐색으로' }));
      return;
    }
    throw e;
  }
  drawEditPage(view, u);
}

function drawEditPage(view, u) {
  const backHref = '#/u/' + encodeURIComponent(u.name);
  const crumbs = el('div', { class: 'crumbs' },
    el('a', { class: 'crumb-link', href: '#/browse', text: '탐색' }), el('span', { class: 'crumb-sep', text: ' / ' }),
    el('a', { class: 'crumb-link', href: backHref, text: u.title || u.name }), el('span', { class: 'crumb-sep', text: ' / ' }),
    el('span', { text: '편집' }));

  // 메타 입력(제목·종류·도메인) — 좁은 상단 바. 본문만 split.
  const titleIn = el('input', { type: 'text', value: u.title || '', placeholder: '제목(선택)' });
  const kindSel = el('select');
  for (const k of CORE_KIND_KEYS) kindSel.append(el('option', { value: k, text: k + ' · ' + KIND_META[k].ko }));
  if (u.kind && !isCoreKind(u.kind)) kindSel.append(el('option', { value: u.kind, text: u.kind + ' · ' + (kindMeta(u.kind).ko || u.kind) + ' (현재 값 · 통합 예정)' }));
  kindSel.value = u.kind || 'K';

  // 본문 split view — 좌 에디터, 우 프리뷰. 입력 즉시(디바운스 120ms) 프리뷰 갱신.
  const bodyIn = el('textarea', { class: 'edit-editor', placeholder: '본문(markdown) — 입력하면 오른쪽에 실시간으로 서식이 보입니다.', spellcheck: 'false' });
  bodyIn.value = u.body_md || '';
  const preview = el('div', { class: 'edit-preview md-rendered' });
  const renderPreview = () => {
    const md = renderMarkdown(bodyIn.value);
    preview.replaceChildren();
    if (bodyIn.value.trim()) preview.append(md);
    else preview.append(el('p', { class: 'admin-hint', text: '(본문을 입력하면 여기에 미리보기가 표시됩니다)' }));
  };
  let pvTimer = null;
  bodyIn.addEventListener('input', () => { clearTimeout(pvTimer); pvTimer = setTimeout(renderPreview, 120); });

  const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: '저장' });
  const cancelBtn = el('a', { class: 'btn btn-ghost btn-sm', href: backHref, text: '취소' });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    const note = bodyIn.value.trim();
    if (!note) { toast('본문은 비울 수 없습니다', true); return; }
    saveBtn.disabled = true;
    try {
      await api('/api/ui/ctx/save', { method: 'POST', body: JSON.stringify({
        note, name: u.name, title: titleIn.value.trim() || undefined, kind: kindSel.value,
        domain: (u.domain_key || undefined),
      }) });
      toast('저장했습니다');
      state.overview = null; getOverview(true).catch(() => {});
      location.hash = backHref; // 저장 후 상세로 복귀(route 가 최신 fetch)
    } catch (e) { saveBtn.disabled = false; toast('저장 실패 — ' + e.message, true); }
  });

  const metaBar = el('div', { class: 'edit-meta-bar' },
    field('제목', titleIn), field('종류(kind)', kindSel),
    el('div', { class: 'edit-meta-static' }, el('span', { class: 'field-label', text: '도메인 · 이름(불변)' }),
      el('div', { class: 'mono edit-static-val', text: (u.domain_key || '—') + ' · ' + u.name })));

  const split = el('div', { class: 'edit-split' },
    el('div', { class: 'edit-pane' }, el('div', { class: 'edit-pane-label', text: '에디터 (Markdown)' }), bodyIn),
    el('div', { class: 'edit-pane' }, el('div', { class: 'edit-pane-label', text: '미리보기 (실시간)' }), preview));

  const head = el('div', { class: 'page-head unit-head' }, crumbs,
    el('p', { class: 'admin-hint', text: '웹에서 편집하면 출처(provenance)가 사람(human)으로 기록됩니다. 왼쪽에 입력하면 오른쪽에 즉시 서식이 보입니다.' }));
  view.replaceChildren(head, metaBar, split, el('div', { class: 'edit-actions' }, saveBtn, cancelBtn, status));
  renderPreview();
  applyReveal([metaBar, split]);
  bodyIn.focus();
}

async function saveOverlay(u, isEdit, onDone) {
  const titleIn = el('input', { type: 'text', value: u.title || '', placeholder: '제목(선택)' });
  const kindSel = el('select');
  // 본질 4종(R·K·H·W)만 신규 선택 가능. 편집 중인 유닛이 옛 종류(federated/legacy)면 현재값을
  //  보존 옵션으로 추가해 무심코 종류가 바뀌지 않게 한다(서버 변경 없이 표시만 — 사람이 K 로 재분류 가능).
  for (const k of CORE_KIND_KEYS) kindSel.append(el('option', { value: k, text: k + ' · ' + KIND_META[k].ko }));
  if (u.kind && !isCoreKind(u.kind)) {
    kindSel.append(el('option', { value: u.kind, text: u.kind + ' · ' + (kindMeta(u.kind).ko || u.kind) + ' (현재 값 · 통합 예정)' }));
  }
  kindSel.value = u.kind || 'K';
  // 도메인: 통제어휘 드롭다운(자유텍스트 폐기). 도메인맵 down 시 자유입력 폴백.
  const domSlot = await loadAllDomains();
  const domainIn = domSlot.error
    ? el('input', { type: 'text', value: u.domain_key || '', placeholder: '도메인 키(목록 불가 — 직접 입력)', title: domSlot.error })
    : buildDomainSelect(domSlot, u.domain_key || '');
  const nameIn = el('input', { type: 'text', value: u.name || '', placeholder: '이름(생략 시 자동 생성)', disabled: isEdit ? 'disabled' : null });
  const bodyIn = el('textarea', { class: 'admin-ta', placeholder: '본문(markdown)' }); bodyIn.value = u.body_md || '';

  const back = overlayBox(isEdit ? '지식 편집' : '새 지식 저장',
    el('p', { class: 'admin-hint', text: isEdit ? '웹에서 편집하면 출처(provenance)가 사람(human)으로 기록됩니다(마지막 저자).' : '웹에서 저장하면 출처(provenance)가 사람(human)으로 기록됩니다. 출처·상태는 서버가 정합니다.' }),
    field('제목', titleIn),
    el('div', { class: 'frow' }, field('종류(kind)', kindSel), field('도메인', domainIn)),
    isEdit ? null : field('이름(name)', nameIn),
    field('본문', bodyIn),
  );
  const saveBtn = el('button', { class: 'btn btn-primary', text: isEdit ? '저장' : '저장' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  saveBtn.addEventListener('click', async () => {
    const note = bodyIn.value.trim();
    if (!note) { toast('본문은 비울 수 없습니다', true); return; }
    saveBtn.disabled = true;
    const payload = { note, title: titleIn.value.trim() || undefined, kind: kindSel.value, domain: domainIn.value.trim() || undefined };
    if (isEdit) payload.name = u.name;
    else if (nameIn.value.trim()) payload.name = nameIn.value.trim();
    try {
      const r = await api('/api/ui/ctx/save', { method: 'POST', body: JSON.stringify(payload) });
      back.remove();
      toast(isEdit ? '저장했습니다' : ('저장했습니다 — ' + (r.saved && r.saved.name)));
      state.overview = null; getOverview(true).catch(() => {});
      if (onDone) onDone(r.saved);
    } catch (e) {
      saveBtn.disabled = false;
      toast('저장 실패 — ' + e.message, true);
    }
  });
  back.querySelector('.ov-box').append(el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
}

// ── 공용 작은 컴포넌트 (field() 는 관리 블록의 동일 정의 재사용) ──
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

  const head = el('div', { class: 'page-head' },
    el('h1', { text: '터미널 세션' }),
    el('div', { class: 'term-head-actions' },
      el('button', { class: 'btn btn-ghost', text: '+ 새 팀', onclick: () => openTeamCreateForm(cfg, view) }),
      el('button', { class: 'btn btn-primary', text: '+ 새 세션', onclick: () => openTermCreateForm(cfg, view, null) })));

  const body = el('div', {});
  // 팀 폴더 / 공개 세션 / 비공개 세션 — 세 섹션. 섹션 사이엔 구분선(term-section--div).
  const top = sessions.filter((s) => !s.team);
  const pub = top.filter((s) => s.visibility !== 'private');
  const priv = top.filter((s) => s.visibility === 'private');
  const sections = [];
  if (teams.length) {
    const tlist = el('div', { class: 'term-list' });
    for (const t of teams) tlist.append(teamRow(t, cfg, view));
    sections.push([termSectionHead('팀 폴더', '팀원만 보고 열 수 있는 폴더입니다.'), tlist]);
  }
  const pubMine = pub.filter((s) => s.owned);
  const pubOthers = pub.filter((s) => !s.owned);
  sections.push([termSectionHead('공개 세션', '모든 멤버에게 보이는 세션입니다.'),
    termPublicSection(pubMine, pubOthers, cfg, view)]);
  sections.push([termSectionHead('비공개 세션', '나에게만 보이는 세션입니다.'),
    termSessionList(priv, cfg, view, '비공개 세션이 없습니다.')]);
  sections.forEach(([secHead, secList], i) => {
    if (i > 0) secHead.classList.add('term-section--div'); // 첫 섹션 빼고 위에 구분선
    body.append(secHead, secList);
  });

  view.replaceChildren(head, body);
}

// 섹션 제목 + 한 줄 설명(desc 없으면 제목만).
function termSectionHead(title, desc) {
  return el('div', { class: 'term-section' },
    el('div', { class: 'term-section-title', text: title }),
    desc ? el('div', { class: 'caption term-section-desc', text: desc }) : null);
}
// 세션 목록(비면 안내 문구 — emptyText 가 있을 때만).
function termSessionList(items, cfg, view, emptyText) {
  const list = el('div', { class: 'term-list' });
  if (!items.length && emptyText) list.append(el('div', { class: 'empty', text: emptyText }));
  for (const s of items) list.append(termRow(s, cfg, view, null));
  return list;
}
// 공개 세션 = 내 것 + 다른 멤버 것. 남의 공개 세션은 계속 쌓이므로 기본 접고(N개) 펼쳐 보게 한다.
function termPublicSection(pubMine, pubOthers, cfg, view) {
  const wrap = el('div', {});
  if (pubMine.length) wrap.append(termSessionList(pubMine, cfg, view, ''));
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

// 팀 폴더 행(루트 화면). 열기=팀 진입, 소유자는 팀원 관리·해제.
function teamRow(t, cfg, view) {
  const count = (t.members ? t.members.length : 0) + 1; // +1 = 소유자
  const meta = el('div', { class: 'term-row-meta' },
    el('div', { class: 'term-row-title' },
      el('span', { text: '📁 ' + t.label }),
      t.owned ? el('span', { class: 'term-badge', text: '내 팀' }) : null),
    el('div', { class: 'caption', text: '구성원 ' + count + '명' + ((t.memberNames && t.memberNames.length) ? ' · ' + t.memberNames.join(', ') : '') }));
  const actions = [el('button', { class: 'btn btn-primary btn-sm', text: '열기', onclick: () => { location.hash = '#/terminal?team=' + encodeURIComponent(t.id); } })];
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

// 팀 진입 화면 — 루트와 동일 UI(세션 목록 + 새 세션), 단 이 팀 폴더로 스코프.
function renderTeamView(view, cfg, teams, sessions, teamId) {
  const back = el('a', { class: 'btn btn-ghost btn-sm', href: '#/terminal', text: '← 터미널 홈' });
  const team = teams.find((t) => t.id === teamId);
  if (!team) {
    view.replaceChildren(el('div', { class: 'page-head' }, el('div', { class: 'term-head-actions' }, back), el('h1', { text: '팀 폴더' })),
      el('div', { class: 'empty', text: '접근할 수 없는 팀이거나 존재하지 않습니다.' }));
    return;
  }
  const count = (team.members ? team.members.length : 0) + 1;
  const head = el('div', { class: 'page-head' },
    el('div', { class: 'term-head-actions' }, back,
      el('button', { class: 'btn btn-primary', text: '+ 새 세션', onclick: () => openTermCreateForm(cfg, view, team) }),
      team.owned ? el('button', { class: 'btn btn-ghost', text: '팀원 관리', onclick: () => openTeamManageForm(team, cfg, view) }) : null),
    el('h1', { text: '📁 ' + team.label }),
    el('div', { class: 'caption', text: '이 팀 폴더의 세션은 팀원만 보고 열 수 있습니다 · 구성원 ' + count + '명' + ((team.memberNames && team.memberNames.length) ? ' (' + team.memberNames.join(', ') + ')' : '') }));
  const mine = sessions.filter((s) => s.team === teamId);
  const list = el('div', { class: 'term-list' });
  if (!mine.length) list.append(el('div', { class: 'empty', text: '이 팀에 세션이 없습니다. "새 세션"으로 만드세요.' }));
  for (const s of mine) list.append(termRow(s, cfg, view, team));
  view.replaceChildren(head, list);
}

function termRow(s, cfg, view, team) {
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
  const reRender = () => renderTerminal(view, team ? team.id : null);
  const actions = [el('button', { class: 'btn btn-primary btn-sm', text: '열기', onclick: () => window.open('/ui/terminal.html?session=' + encodeURIComponent(s.id), '_blank') })];
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

// 새 세션. team 이 주어지면 그 팀 폴더로 스코프(작업 위치 고정, team 태그 전달).
function openTermCreateForm(cfg, view, team) {
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

  // 팀 컨텍스트면 작업 위치/폴더 대신 고정된 '팀 폴더' 표시 필드.
  const locFields = team
    ? [field('팀 폴더', el('input', { class: 'term-input', type: 'text', value: '📁 ' + team.label, disabled: '' }))]
    : [field('작업 위치', rootSel), field('폴더', pickerBox)];

  const back = overlay(team ? ('새 세션 · ' + team.label) : '새 세션',
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
          if (out && out.session) window.open('/ui/terminal.html?session=' + encodeURIComponent(out.session.id), '_blank');
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
    field('팀원 (선택한 구성원만 이 팀 폴더·세션에 접근)', listBox),
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
    field('팀원 (선택한 구성원만 이 팀 폴더·세션에 접근)', listBox),
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
  for (const a of document.querySelectorAll('.tabs a')) {
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
  const page = segs[0] || 'map';
  try {
    if (page === 'browse') {
      setActiveTab('ctx'); // '회사 맥락' 상위 탭(지도·탐색·검토 묶음)
      await renderBrowse(view, params);
    } else if (page === 'u') {
      setActiveTab('ctx'); // 유닛 상세는 탐색의 하위 — '회사 맥락' 상위 탭 활성 유지
      // #/u/<name>/edit → 편집 페이지(split view), 그 외 → 상세. name 에 '/' 가 있을 수 있어 마지막 'edit' 만 분리.
      const rest = segs.slice(1);
      if (rest.length > 1 && rest[rest.length - 1] === 'edit') {
        await renderEditPage(view, decodeURIComponent(rest.slice(0, -1).join('/')));
      } else {
        await renderUnit(view, decodeURIComponent(rest.join('/')));
      }
    } else if (page === 'learn') {
      setActiveTab('start'); // '시작하기' 상위 탭(설치·사용설명서 묶음)
      await renderLearn(view);
    } else if (page === 'install') {
      setActiveTab('start');
      await renderInstall(view);
    } else if (page === 'review') {
      setActiveTab('ctx');
      await renderReview(view);
    } else if (page === 'domainmap') {
      setActiveTab('ctx'); // 도메인 맵은 '회사 맥락' 상위 탭의 하위 뷰(지도·탐색과 동급)
      await renderDomainmap(view, params);
    } else if (page === 'dash') {
      setActiveTab('dash');
      await renderDashboard(view, params);
    } else if (page === 'system') {
      setActiveTab('system');
      await renderSystem(view, segs[1] || null);
    } else if (page === 'terminal') {
      setActiveTab('terminal');
      await renderTerminal(view, params.get('team'));
    } else {
      setActiveTab('ctx');
      await renderMap(view);
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
// 관리 중분류(가로 탭, 2026-06-20) — 비개발자가 14개 섹션에서 길잃지 않게 3분류로 묶는다.
//  ① 기본 설정: 접속·구성원·토큰·발행(굴러가게 하는 기본기) ② 회사·조직: 규칙·맥락·메모리·용어(AI에 가르치는 내용)
//  ③ AI 동작·연결(고급): 훅·도구·MCP·DB(AI가 실제 어떻게 동작/어떤 데이터에 닿나).
//  '지식 종류 레지스트리'·'설치'는 관리에서 빼 #/learn(가이드)로 이관 — 전자=용어설명, 후자=구성원 셋업.
const ADMIN_GROUPS = [
  { key: 'basic', label: '기본 설정' },
  { key: 'org', label: '회사·조직' },
  { key: 'ai', label: 'AI 동작·연결 (고급)' },
];
const ADMIN_SECTIONS = [
  // ① 기본 설정 — 한 번 세팅하면 굴러가는 기본기(누가 쓰나·어떻게 연결·반영).
  { key: 'profile', label: '조직 정보 · 연결', meaning: 'gateway-url', group: 'basic' },
  { key: 'members', label: '구성원', meaning: 'member', group: 'basic' },
  { key: 'tokens', label: '접속 권한', meaning: null, group: 'basic' },
  { key: 'publish', label: '변경사항 적용', meaning: null, group: 'basic' },
  // ② 회사·조직 — 회사가 AI에 가르치는 내용(규칙·맥락·메모리·통제어휘).
  { key: 'managed-policy', label: 'AI 필수 규칙', meaning: 'managed-policy', group: 'org' },
  { key: 'org-defaults', label: '회사 소개 · AI 성격', meaning: 'org-defaults', group: 'org' },
  { key: 'memory', label: '팀 공유 메모리', meaning: 'memory', group: 'org' },
  { key: 'domains-repos', label: '주제 분류', meaning: null, group: 'org' },
  // ③ AI 동작·연결 (고급) — AI가 실제 어떻게 동작/어떤 데이터에 닿나.
  //  훅 — '커스텀 훅'(임의 코드 정의 = 일반)이 상위, '런타임 훅'(빌트인 리플렉스 토글 = 특수)과 '주입 미리보기'는 그 하위.
  { key: 'custom-hooks', label: '커스텀 훅 (코드 정의)', meaning: 'custom-hook', group: 'ai' },
  { key: 'runtime', label: '런타임 훅 (빌트인 리플렉스 ON/OFF)', meaning: 'runtime', indent: true, group: 'ai' },
  { key: 'hooks-preview', label: '주입 미리보기 (세션 주입물 확인)', meaning: null, indent: true, group: 'ai' },
  { key: 'tools', label: 'AI 도구(툴)', meaning: 'tool', group: 'ai' },
  { key: 'mcp', label: 'MCP 서버', meaning: 'mcp', group: 'ai' },
  { key: 'db-sources', label: 'DB 데이터소스', meaning: 'db-source', group: 'ai' },
];
const ADMIN_ONLY = ['publish', 'tokens', 'runtime', 'mcp', 'db-sources']; // admin 권한 전용(쓰기/인프라)
const RUNTIME_ONLY = ['custom-hooks', 'tools']; // runtime 권한 전용(멤버 머신 실행물 정의)
// V4-P5/J: 어휘(도메인·레포·기능) CRUD = context 스코프(admin 완화). 도메인맵 CRUD 엔드포인트가 scope:'context'
//  이므로 context 권한자면 편집 가능 — admin 전용 잠금 해제. context 없는 사용자는 읽기 전용(섹션 자체는 노출).
const CONTEXT_EDIT = ['domains-repos']; // context 스코프면 편집 가능(없으면 읽기 전용으로 표시)
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
    label: '팀 공유 메모리',
    what: '팀이 함께 쌓아두는 메모예요. AI가 필요할 때 꺼내 봅니다.',
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
  if (key === 'tokens') return '구성원에게 접속 열쇠 발급';
  if (key === 'publish') return '바꾼 내용을 구성원에게 반영';
  if (key === 'managed-policy') return 'AI가 항상 지킬 규칙';
  if (key === 'org-defaults') return '회사 배경과 AI 말투';
  if (key === 'memory') return '팀이 함께 쌓는 메모';
  if (key === 'domains-repos') return '지식을 정리하는 주제';
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
  // 훅 자식(런타임·미리보기) 들여쓰기는 부모('커스텀 훅')가 보일 때만 — 권한 게이팅으로 부모가 숨으면 고아 '└' 방지.
  const hookParentVisible = !sectionHidden('custom-hooks', data);
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
        ? el('span', { class: 'admin-sub', text: (data.profile.display_name || '조직') + ' · 편집은 [변경사항 적용] 후 구성원에게 반영돼요' })
        : el('span', { class: 'admin-sub' }, el('span', { class: 'pill', text: '읽기 전용' }), ' ' + (data.profile.display_name || '조직') + ' · 보기 전용(편집은 관리자)')),
    groupBar,
    split));
  applyReveal([list, detail]);
}

function renderAdminDetail(detail, sel, data) {
  if (sel === 'kinds') return kindsRegistry(detail, data);
  if (sel === 'domains-repos') return domainsReposPanel(detail, data);
  if (sel === 'managed-policy' || sel === 'org-defaults') return sectionEditor(detail, sel, data);
  if (sel === 'memory') return memoryEditor(detail, data);
  if (sel === 'members') return membersEditor(detail, data);
  if (sel === 'tokens') return tokensPanel(detail, data);
  if (sel === 'profile') return profileEditor(detail, data);
  if (sel === 'runtime') return runtimeEditor(detail, data);
  if (sel === 'hooks-preview') return hooksPreviewPanel(detail, data);
  if (sel === 'custom-hooks') return customHookEditor(detail, data);
  if (sel === 'tools') return toolsEditor(detail, data);
  if (sel === 'mcp') return mcpEditor(detail, data);
  if (sel === 'db-sources') return dbSourceEditor(detail, data);
  if (sel === 'publish') return publishPanel(detail, data);
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
    const go = () => { location.hash = '#/browse?kind=' + encodeURIComponent(k.kind); };
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

  // editing 은 로컬 상태 — 섹션에 진입(renderAdminDetail 재호출)할 때마다 항상 읽기 전용으로 시작.
  function render(editing) {
    const ta = el('textarea', { rows: '18', class: 'admin-ta', 'aria-label': title });
    ta.value = sec.body_md || '';
    ta.readOnly = !editing;

    const headBtns = el('div', { class: 'card-head-actions' },
      el('button', { class: 'btn btn-ghost btn-sm', text: '미리보기', onclick: showMemberPreview }),
      canEdit
        ? (editing
            ? el('button', { class: 'btn btn-ghost btn-sm', text: '보기', onclick: () => render(false) })
            : el('button', { class: 'btn btn-primary btn-sm', text: '수정', onclick: () => render(true) }))
        : null);

    const body = [
      el('div', { class: 'card-head' },
        el('div', { class: 'section-title' }, el('h2', { text: title }), meaningCard(meaning)),
        headBtns),
      el('p', { class: 'admin-hint', text: editing
        ? '여기 적은 내용은 [변경사항 적용]을 눌러야 구성원에게 반영돼요(그 전엔 나만 보는 초안).'
        : (canEdit ? '구성원에게 보이는 모습이에요. 고치려면 [수정]을 누르세요.' : '읽기 전용 — 이 내용이 모든 구성원의 AI에 깔립니다.') }),
      ta,
    ];

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
          toast('저장됨 — [변경사항 적용]하면 구성원에게 반영돼요');
        } catch (e) { toast(e.message, true); status.textContent = ''; }
        saveBtn.disabled = false;
      });
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

// ── 구성원 ──
function membersEditor(detail, data) {
  const canEdit = state.admin.canEdit;
  const meaning = data.meaning['member'];
  const sel = state.admin.memberSel;
  const listCol = el('div', { class: 'admin-sublist' });
  if (canEdit) listCol.append(el('button', { class: 'btn btn-ghost btn-sm admin-add', text: '+ 구성원 추가',
    onclick: () => { state.admin.memberSel = '__new__'; renderAdminDetail(detail, 'members', data); } }));
  for (const m of data.members) {
    const meta = canEdit
      ? (m.kind || 'human') + (m.email ? ' · ' + m.email : '') + ' · 권한 ' + ((m.scopes || []).join('/') || '-')
      : (m.kind || 'human') + (m.state && m.state !== 'active' ? ' · ' + m.state : '');
    listCol.append(el('div', { class: 'mini-row' + (m.id === sel ? ' sel' : ''),
      onclick: () => { state.admin.memberSel = m.id; renderAdminDetail(detail, 'members', data); } },
      el('div', { class: 'mini-title', text: (m.display_name || m.id) },
        canEdit ? (m.hasToken ? el('span', { class: 'pill pill-ok', text: '설치됨' }) : el('span', { class: 'pill', text: '미설치' })) : null),
      el('div', { class: 'mini-meta', text: meta })));
  }
  const right = el('div', {});
  const editing = sel === '__new__' ? { id: '', kind: 'human', display_name: '', email: '', identities: [], body_md: '', state: 'active', scopes: ['items', 'context'] }
    : data.members.find((m) => m.id === sel);
  if (editing) memberForm(right, editing, data, detail, sel === '__new__');
  else right.append(el('p', { class: 'admin-hint', text: canEdit ? '왼쪽에서 구성원을 고르거나 추가하세요.' : '읽기 전용 — 이름·종류만 표시됩니다(이메일·계정·권한은 관리자만).' }));

  detail.replaceChildren(el('div', { class: 'card' },
    sectionTitle('구성원', meaning),
    el('div', { class: 'admin-two' }, listCol, right)));
}

function memberForm(root, m, data, detail, isNew) {
  // 읽기 전용(비-admin): 폼 대신 요약(민감 필드는 서버가 이미 redact).
  if (!state.admin.canEdit) {
    root.replaceChildren(
      el('h3', { text: m.display_name || m.id }),
      el('div', { class: 'mini-meta', text: '종류: ' + (m.kind || 'human') + ' · 상태: ' + (m.state || 'active') }));
    return;
  }
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
  const SCOPE_OPTS = [['items', '아이템 조회'], ['context', '컨텍스트'], ['admin', '관리자(편집·적용)'], ['runtime', '런타임(훅·툴 정의)']];
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

  const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    const identities = idnRows.map((r) => ({ system: r.sysIn.value.trim(), external_id: r.extIn.value.trim(), email: r.emIn.value.trim() || undefined }))
      .filter((x) => x.system && x.external_id);
    const payload = {
      id: idIn.value.trim(), kind: kindSel.value, display_name: nameIn.value.trim(),
      email: emailIn.value.trim(), identities, body_md: bodyTa.value, state: stateSel.value,
      scopes: SCOPE_OPTS.map(([sk]) => sk).filter((sk) => scopeChks[sk].checked),
    };
    if (!payload.id) { toast('아이디는 필수입니다', true); return; }
    saveBtn.disabled = true;
    try {
      await api('/api/ui/org/member', { method: 'POST', body: JSON.stringify(payload) });
      await loadAdmin(true);
      state.admin.memberSel = payload.id;
      toast('저장됨 — 신원 매칭에 즉시 반영됩니다');
      renderAdminDetail(detail, 'members', state.admin.data);
    } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  });

  const actions = el('div', { class: 'admin-actions' }, saveBtn, status);
  if (!isNew) {
    // 토큰 발급은 [토큰] 탭으로 이동(구성원별 발급) — 여기선 신원/권한 편집만.
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


// ── 팀 메모리 ──
function memoryEditor(detail, data) {
  const canEdit = state.admin.canEdit;
  const sel = state.admin.memorySel;
  const listCol = el('div', { class: 'admin-sublist' });
  if (canEdit) listCol.append(el('button', { class: 'btn btn-ghost btn-sm admin-add', text: '+ 메모리 추가',
    onclick: () => { state.admin.memorySel = '__new__'; renderAdminDetail(detail, 'memory', data); } }));
  for (const mem of data.memory) {
    listCol.append(el('div', { class: 'mini-row' + (mem.name === sel ? ' sel' : ''),
      onclick: () => { state.admin.memorySel = mem.name; renderAdminDetail(detail, 'memory', data); } },
      el('div', { class: 'mini-title', text: (mem.title || mem.name) }),
      el('div', { class: 'mini-meta', text: mem.name + (mem.domain_key ? ' · ' + mem.domain_key : '') })));
  }
  const right = el('div', {});
  const editing = sel === '__new__' ? { name: '', title: '', body_md: '' }
    : data.memory.find((x) => x.name === sel);
  if (editing) memoryForm(right, editing, data, detail, sel === '__new__');
  else right.append(el('p', { class: 'admin-hint', text: '팀이 승인한 공식 지식만 둡니다(개인 메모는 각자 로컬).' }));
  detail.replaceChildren(el('div', { class: 'card' }, sectionTitle('팀 공유 메모리', data.meaning['memory']), el('div', { class: 'admin-two' }, listCol, right)));
}

async function memoryForm(root, mem, data, detail, isNew) {
  if (!state.admin.canEdit) {
    root.replaceChildren(
      el('h3', { text: mem.title || mem.name }),
      el('pre', { class: 'admin-preview', text: mem.body_md || '(비어 있음)' }));
    return;
  }
  const nameIn = el('input', { type: 'text', value: mem.name, placeholder: '파일명(예: agent-context-architecture)', disabled: isNew ? null : '' });
  const titleIn = el('input', { type: 'text', value: mem.title || '', placeholder: '제목' });
  // 도메인: 통제어휘 드롭다운(자유텍스트 폐기). 도메인맵 down 시 자유입력 폴백.
  const domSlot = await loadAllDomains();
  const domIn = domSlot.error
    ? el('input', { type: 'text', value: mem.domain_key || '', placeholder: '도메인 슬러그(목록 불가 — 직접 입력)', title: domSlot.error })
    : buildDomainSelect(domSlot, mem.domain_key || '');
  const bodyTa = el('textarea', { rows: '12', placeholder: 'markdown 본문' }); bodyTa.value = mem.body_md || '';
  const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    if (!nameIn.value.trim()) { toast('파일명 필수', true); return; }
    saveBtn.disabled = true;
    try {
      await api('/api/ui/org/memory', { method: 'POST', body: JSON.stringify({ name: nameIn.value.trim(), title: titleIn.value.trim(), body_md: bodyTa.value, domain_key: domIn.value.trim() }) });
      await loadAdmin(true); state.admin.memorySel = nameIn.value.trim(); toast('저장됨');
      renderAdminDetail(detail, 'memory', state.admin.data);
    } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  });
  const actions = el('div', { class: 'admin-actions' }, saveBtn, status);
  if (!isNew) actions.append(el('button', { class: 'btn-text', text: '제거', onclick: async () => {
    if (!confirm(`메모리 '${mem.title || mem.name}' 제거?`)) return;
    try { await api('/api/ui/org/memory/remove', { method: 'POST', body: JSON.stringify({ name: mem.name }) });
      await loadAdmin(true); state.admin.memorySel = null; toast('제거됨'); renderAdminDetail(detail, 'memory', state.admin.data); }
    catch (e) { toast(e.message, true); }
  } }));
  root.replaceChildren(field('파일명', nameIn), field('제목', titleIn),
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
    el('h2', { text: '조직 정보 · 연결' }),
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

// ── 변경사항 적용(옛 '발행') ──
function publishPanel(detail, data) {
  const runBtn = el('button', { class: 'btn btn-primary', text: '구성원에게 적용하기' });
  const result = el('div', { class: 'admin-status' });
  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true; result.textContent = '적용 중…';
    try {
      await api('/api/ui/org/publish', { method: 'POST', body: '{}' });
      result.replaceChildren(el('span', { class: 'pill pill-ok', text: '적용 완료' }), ' 구성원이 받을 준비가 됐어요.');
      toast('적용됐어요 — 구성원은 설치/재설치로 최신 내용을 받아요');
    } catch (e) { result.textContent = ''; toast(e.message, true); }
    runBtn.disabled = false;
  });
  detail.replaceChildren(el('div', { class: 'card' },
    el('h2', { text: '변경사항 적용' }),
    el('p', { class: 'admin-what', text: '관리 탭에서 바꾼 내용(규칙·회사 소개·메모리 등)을 구성원이 실제로 받을 수 있게 반영하는 버튼이에요.' }),
    el('p', { class: 'admin-hint', text: '누르기 전 수정은 나만 보는 초안이에요. 누르면 구성원이 명령 한 줄(또는 재설치)로 최신 내용을 받아요.' }),
    el('p', { class: 'admin-hint', text: '실시간 현황(최근 활동 등)은 이 버튼과 상관없이 늘 자동으로 갱신돼요.' }),
    el('div', { class: 'admin-actions' }, runBtn, result),
    el('div', { class: 'meaning meaning-infra' },
      el('div', { class: 'meaning-head' }, el('span', { class: 'meaning-dot' }), el('span', { class: 'meaning-title', text: '구성원은 어떻게 받나요?' })),
      el('p', { class: 'meaning-what', text: '구성원은 [시작하기] > [설치]에서 자기 전용 설치 명령을 받아 한 줄로 설치해요(git 필요 없음).' }))));
}

// ── 토큰 (발급 현황 + 즉시 회수) — admin 전용 ──
function tokensPanel(detail, data) {
  const gw = (data.profile.gateway_url || window.location.origin).replace(/\/mcp$/, '').replace(/\/$/, '');
  const tokens = data.tokens || [];
  const active = tokens.filter((t) => !t.revoked_at);
  const revoked = tokens.filter((t) => t.revoked_at);
  const tokenRow = (t, isActive) => {
    const meta = (t.user_id || '') + ' · ' + ((t.scopes || []).join('/') || '-')
      + ' · 발급 ' + (t.created_at ? t.created_at.slice(0, 10) : '?')
      + (t.last_used_at ? ' · 마지막 ' + relTime(t.last_used_at) : ' · 미사용');
    const right = isActive
      ? el('button', { class: 'btn btn-ghost btn-sm', text: '회수', onclick: async (e) => {
          if (!confirm(`토큰 '${t.label || t.user_id}' 회수? 즉시 무효화됩니다(되돌릴 수 없음).`)) return;
          e.target.disabled = true;
          try {
            await api('/api/ui/org/token/revoke', { method: 'POST', body: JSON.stringify({ tokenHash: t.token_hash }) });
            await loadAdmin(true); toast('회수됨 — 즉시 무효'); renderAdminDetail(detail, 'tokens', state.admin.data);
          } catch (err) { toast(err.message, true); e.target.disabled = false; }
        } })
      : el('span', { class: 'pill', text: '회수됨' });
    return el('div', { class: 'token-row' + (isActive ? '' : ' token-revoked') },
      el('div', { class: 'token-main' },
        el('div', { class: 'token-label', text: t.label || t.user_id || '(무라벨)' }),
        el('div', { class: 'mini-meta', text: meta })),
      right);
  };
  const children = [
    el('h2', { text: '접속 권한' }),
    el('p', { class: 'admin-hint', text: '구성원의 AI가 회사 게이트웨이에 연결할 때 쓰는 개인 접속 열쇠(토큰)입니다 — 사람마다 하나씩 발급해 건넵니다.' }),
    el('div', { class: 'meaning-grid', style: 'margin:2px 0 12px' },
      meaningRow('언제 발급하나', '새 구성원이 합류하거나 누가 처음 쓰기 시작할 때. 그 사람 몫으로 발급하면 열쇠가 박힌 설치 명령이 바로 나오고, 그 사람이 설치할 때 한 번만 쓰입니다.'),
      meaningRow('언제 회수하나', '퇴사·기기 분실 등 그 사람의 접속을 끊어야 할 때. 회수하면 서버를 다시 켤 필요 없이 그 즉시 막힙니다(되돌릴 수 없음).')),
    el('p', { class: 'admin-hint', text: '열쇠 원본은 발급 직후 딱 한 번만 보이고 어디에도 저장되지 않습니다 — 그때 복사해 전달하세요.' }),
    installMinterBlock(data, gw),
  ];
  if (active.length) children.push(el('div', { class: 'token-section' }, el('div', { class: 'token-section-h', text: '발급됨 · 사용 중 (' + active.length + ')' }), ...active.map((t) => tokenRow(t, true))));
  else children.push(el('p', { class: 'admin-hint', text: '아직 발급한 접속 열쇠가 없습니다 — 위 ‘설치’ 칸에서 구성원을 골라 발급하세요.' }));
  if (revoked.length) children.push(el('div', { class: 'token-section' }, el('div', { class: 'token-section-h', text: '회수됨 (' + revoked.length + ')' }), ...revoked.map((t) => tokenRow(t, false))));
  detail.replaceChildren(el('div', { class: 'card' }, ...children));
}

// ── 런타임 · 훅 (훅 on/off · work-roots · 너지 문구) — admin 전용 ──
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
  const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      const hooks = {}; for (const [k] of HOOK_OPTS) hooks[k] = chks[k].checked;
      const work_roots = wrTa.value.split('\n').map((l) => l.trim()).filter(Boolean);
      const allowed_auth_envs = envTa.value.split('\n').map((l) => l.trim()).filter(Boolean);
      const url_allowlist = hostTa.value.split('\n').map((l) => l.trim()).filter(Boolean);
      const r = await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ hooks, writeback_notice: noticeTa.value.trim() || null, work_roots, allowed_auth_envs, url_allowlist }) });
      data.runtimeConfig = r.runtimeConfig; status.textContent = '저장됨'; toast('저장됨 — 구성원 다음 세션부터 반영');
    } catch (e) { toast(e.message, true); status.textContent = ''; }
    saveBtn.disabled = false;
  });
  detail.replaceChildren(el('div', { class: 'card' },
    sectionTitle('런타임 훅 (기본 리플렉스)', data.meaning['runtime']),
    el('p', { class: 'admin-hint', text: '게이트웨이가 제공하는 기본 세션 훅(리플렉스)의 ON/OFF 와 작업 폴더를 중앙에서 제어합니다. 구성원 머신은 매 세션 게이트웨이에서 훅을 받아 실행하므로(runner fetch), 변경은 다음 세션에 자동 반영됩니다(재설치 불요). 전체 끄기는 구성원이 LIVELY_OFF=1 로. ※ 코드까지 직접 정의하는 사내 훅은 ‘커스텀 훅’에서, 각 훅이 실제로 주입하는 메시지는 ‘훅 주입 미리보기’에서.' }),
    field('기본 리플렉스 훅 ON/OFF', hookWrap),
    field('writeback 너지 문구 (선택)', noticeTa),
    field('work-roots — 이 폴더에서 켠 세션은 라이블리 작업으로 인식 (줄당 절대경로)', wrTa),
    el('div', { class: 'admin-subhead', text: 'AI 도구(http_proxy) 안전 화이트리스트' }),
    el('p', { class: 'admin-hint', text: 'AI 도구가 외부를 호출할 수 있는 범위 — 이 목록 밖은 전부 차단됩니다(SSRF 방어).' }),
    field('허용 인증 환경변수 이름 (allowed_auth_envs)', envTa),
    field('허용 호스트 (url_allowlist)', hostTa),
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

    const listCol = el('div', { class: 'admin-sublist' });
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
    el('p', { class: 'admin-hint', text: '본인 머신에 설치/업데이트/제거하는 명령입니다. 업데이트·제거는 설치된 토큰을 자동으로 읽어 토큰 재입력이 필요 없습니다. (다른 구성원에게 배포할 토큰은 [토큰] 탭에서.)' }),
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
function installMinterBlock(data, gw) {
  const result = el('div', {});
  const sel = el('select', {}, ...(data.members || []).map((m) =>
    el('option', { value: m.id, text: (m.display_name || m.id) + ' · ' + ((m.scopes || []).join('/') || '-') })));
  const go = el('button', { class: 'btn btn-primary btn-sm', text: '설치 명령 만들기' });
  go.addEventListener('click', async () => {
    const m = (data.members || []).find((x) => x.id === sel.value) || { id: sel.value };
    if (!m.id) { toast('구성원을 선택하세요', true); return; }
    go.disabled = true;
    try {
      const r = await api('/api/ui/org/token', { method: 'POST',
        body: JSON.stringify({ userId: m.id, memberId: m.id, label: m.display_name || m.id }) });
      const cmd = installCmd(gw, 'mac', r.token);
      const name = m.display_name || m.id;
      result.replaceChildren(
        el('p', { class: 'install-ok', text: '✓ ' + name + ' 님 접속 토큰이 발급됐어요 (권한: ' + r.scopes.join('/') + ').' }),
        el('p', { class: 'admin-hint', text: '아래는 ' + name + ' 님 전용 macOS 설치 명령이에요(토큰이 안에 들어 있습니다). 이렇게 전달하세요:' }),
        el('ol', { class: 'minter-steps' },
          el('li', {}, el('b', { text: '아래 [명령 복사]' }), ' 버튼으로 명령을 통째로 복사하세요.'),
          el('li', {}, name + ' 님에게 ', el('b', { text: '1:1로(슬랙·메신저 DM 등) 전달' }), '하세요 — 토큰이 들어 있으니 공개 채널·단톡방엔 올리지 마세요.'),
          el('li', {}, name + ' 님이 받은 명령을 ', el('b', { text: '본인 Mac 터미널에 붙여넣고 한 번 실행' }), '하면 끝이에요. 그러면 그분 컴퓨터의 AI(claude·codex)에 회사 맥락·규칙이 자동으로 연결됩니다.')),
        el('p', { class: 'admin-hint', text: '⚠ 이 토큰은 지금 이 화면에서만 보여요(닫으면 다시 볼 수 없습니다 — 잃어버리면 다시 만들면 돼요). 받는 분이 Windows라면, 그분이 직접 [시작하기] > [설치] 화면에서 본인 명령을 만들어 설치하면 됩니다.' }),
        el('div', { class: 'deploy-head' }, el('span', {}), copyButton(() => cmd, '명령 복사')),
        el('pre', { class: 'admin-preview', text: cmd }));
      await loadAdmin(true);
    } catch (e) { toast(e.message, true); }
    go.disabled = false;
  });
  return el('div', { class: 'deploy-block' },
    el('h3', { text: '설치' }),
    el('p', { class: 'admin-hint', text: '구성원을 고르고 발급하면 그 사람 토큰이 박힌 설치 명령이 바로 나옵니다(git 불필요).' }),
    el('div', { class: 'install-minter' }, sel, go),
    result);
}

function deployCommands(gw, os) {
  if (os === 'windows') {
    return [
      { kind: 'install', title: '설치 (PowerShell)' }, // 설치 블록은 installSelfBlock 가 렌더(자가발급)
      { kind: 'update', title: '업데이트 (PowerShell)', note: '설치된 토큰을 읽어 최신 묶음 재설치(설치된 하네스 자동 감지). ⚠ Windows 미검증 — 테스트 후 사용.',
        cmd: `$T=(Get-Content "$HOME\\.lively\\token" -Raw).Trim(); $G=((Get-Content "$HOME\\.lively\\gateway-url" -Raw).Trim() -replace '/mcp$',''); $h=@(); if(Get-Command claude -EA 0){$h+="claude"}; if(Get-Command codex -EA 0){$h+="codex"}; if($h.Count -eq 0){$h=@("claude")}; $tmp="$env:TEMP\\lvup"; Remove-Item -Recurse -Force $tmp -EA 0; New-Item -ItemType Directory -Force $tmp|Out-Null; Invoke-WebRequest -Headers @{Authorization="Bearer $T"} "$G/install" -OutFile "$tmp\\b.tgz"; tar -xzf "$tmp\\b.tgz" -C $tmp; if($h -contains "claude"){ claude mcp remove lively *>$null; claude mcp add --transport http --scope user lively "$G/mcp" --header "Authorization: Bearer $T" }; if($h -contains "codex"){ $env:LIVELY_TOKEN=$T; [Environment]::SetEnvironmentVariable('LIVELY_TOKEN',$null,'User'); $pf=$PROFILE.CurrentUserAllHosts; New-Item -ItemType Directory -Force (Split-Path $pf) *>$null; if(-not (Test-Path $pf)){ New-Item -ItemType File -Force $pf *>$null }; $m="# lively-managed (codex LIVELY_TOKEN)"; if(-not (Select-String -Path $pf -SimpleMatch $m -Quiet -EA 0)){ Add-Content $pf ""; Add-Content $pf $m; Add-Content $pf 'if(-not $env:LIVELY_TOKEN -and (Test-Path "$HOME\\.lively\\token")){ $env:LIVELY_TOKEN=(Get-Content "$HOME\\.lively\\token" -Raw).Trim() }' } }; node "$tmp\\setup\\user-install.mjs" --clone-root $tmp --harness ($h -join ",")` },
      { kind: 'uninstall', title: '제거 (PowerShell)', note: '설치 자산 제거(lively 영역만). 완전 차단은 관리자가 [토큰] 탭에서 회수. ⚠ Windows 미검증.',
        cmd: `$T=(Get-Content "$HOME\\.lively\\token" -Raw).Trim(); $G=((Get-Content "$HOME\\.lively\\gateway-url" -Raw).Trim() -replace '/mcp$',''); $tmp="$env:TEMP\\lvun"; Remove-Item -Recurse -Force $tmp -EA 0; New-Item -ItemType Directory -Force $tmp|Out-Null; Invoke-WebRequest -Headers @{Authorization="Bearer $T"} "$G/install" -OutFile "$tmp\\b.tgz"; tar -xzf "$tmp\\b.tgz" -C $tmp; node "$tmp\\setup\\user-uninstall.mjs"` },
    ];
  }
  return [
    { kind: 'install', title: '설치', note: '구성원 토큰 필요 — 아래에서 구성원을 골라 발급하면 토큰 박힌 완성형 명령이 나옵니다. (아래는 템플릿: <TOKEN> 교체)',
      cmd: `T=<TOKEN>; curl -fsSL -H "Authorization: Bearer $T" "${gw}/install" -o /tmp/lv.tgz && mkdir -p /tmp/lv && tar -xzf /tmp/lv.tgz -C /tmp/lv && LIVELY_TOKEN=$T bash /tmp/lv/setup/setup-mac.sh` },
    { kind: 'update', title: '업데이트', note: '설치된 토큰을 읽어 최신 묶음으로 멱등 재설치. 콘텐츠(강제규칙·회사맥락·메모리)는 매 세션 자동이라, 훅/설정 변경 시에만 필요합니다.',
      cmd: `T="$(cat ~/.lively/token)"; G="$(sed 's#/mcp$##' ~/.lively/gateway-url)"; curl -fsSL -H "Authorization: Bearer $T" "$G/install" -o /tmp/lv.tgz && rm -rf /tmp/lv && mkdir -p /tmp/lv && tar -xzf /tmp/lv.tgz -C /tmp/lv && LIVELY_TOKEN="$T" bash /tmp/lv/setup/setup-mac.sh` },
    { kind: 'uninstall', title: '제거', note: '설치 자산을 영구 제거(lively-managed 영역만 — tmux 훅·셸 별칭 등 사용자 설정은 보존). 완전 차단하려면 관리자가 서버에서도 토큰을 회수해야 합니다.',
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
