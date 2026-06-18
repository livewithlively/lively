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
//   5) 관리(#/system)      — kind 레지스트리 열람 + 기존 관리(커넥터/소스/훅/멤버/토큰) 흡수.
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
// lifecycle(상태) 라벨 — active=유효, rejected=반려, superseded=대체됨.
const LIFECYCLE_LABEL = { active: '유효', rejected: '반려', superseded: '대체됨' };

const state = {
  me: null,
  overview: null,        // /api/ui/ctx/overview 캐시(지도 + 검토 배지 + 탐색 kind 트리 공유)
  browse: { filters: { kind: '', space: '', domain: '', lifecycle: 'active', confidence: '', q: '' }, entries: [], loaded: false },
  admin: { data: null, sel: 'kinds', memberSel: null, memorySel: null, repoSel: null }, // 관리(전달) 페이지 상태
  domains: {},           // P-V3-4a: repo별 도메인 통제어휘 캐시 { [repo]: {list, repos, loaded, error} }
};
const DEFAULT_REPO = 'productivity'; // 제품 자신의 도메인맵 repo(ctx_save DEFAULT_DOMAIN_REPO 와 정합)
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
  const stripped = url.replace(/[ -]/g, '');
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
  const areaEyebrow = el('div', { class: 'eyebrow', text: '주제 영역 (area)' });
  areaEyebrow.hidden = true; areaWrap.hidden = true;

  view.replaceChildren(head, health, el('div', { class: 'eyebrow', text: '종류별 지식' }), grid, areaEyebrow, areaWrap);
  applyReveal([health, ...cards]);
  document.getElementById('view').focus?.();

  // 비동기 area 로드(렌더 차단 안 함) — 성공 시에만 영역 카드 노출.
  loadDomains(DEFAULT_REPO).then((slot) => {
    if (slot.error || !slot.list.length) return;
    const counts = { product: 0, business: 0 };
    for (const d of slot.list) { const sp = (d.space || 'product') === 'business' ? 'business' : 'product'; counts[sp]++; }
    const SPACE_CARDS = [
      { space: 'product', name: '제품 도메인', sub: '코드앵커·부채추적이 붙는 제품 영역' },
      { space: 'business', name: '비즈니스 기능', sub: 'GTM·가격·펀딩·시장경쟁·브랜드·조직' },
    ];
    for (const sc of SPACE_CARDS) {
      if (!counts[sc.space]) continue;
      areaWrap.append(el('a', { class: 'kind-card', href: '#/browse?space=' + sc.space, role: 'link', tabindex: '0' },
        el('div', { class: 'kind-card-top' },
          el('span', { class: 'kind-glyph', 'aria-hidden': 'true', text: sc.space === 'product' ? '제품' : '사업' }),
          el('span', { class: 'kind-inject', text: 'area' })),
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
  }

  const o = await getOverview(false);

  // 좌측: kind 트리(폴더) — 전체 + 각 kind. domain 필터는 입력으로(자유 슬러그).
  const tree = el('nav', { class: 'browse-tree', 'aria-label': 'kind 트리' });
  tree.append(treeItem('전체', '', f.kind === '', o.total_active));
  for (const k of o.kinds) {
    tree.append(treeItem(kindMeta(k.kind).ko || k.label || k.kind, k.kind, f.kind === k.kind, k.active_count, k.kind));
  }

  // 상단 검색 + 필터 바.
  const qInput = el('input', { type: 'search', placeholder: '제목·본문 검색(grep)', value: f.q, 'aria-label': '검색어' });
  // 주제(area)는 2단 — 1차 space(제품/비즈니스) → 2차 domain(통제어휘). space 선택 시 도메인 드롭다운을
  //  그 space 로 좁힌다. 도메인은 자유텍스트 폐기(통제어휘 드롭다운). 도메인맵 down 시 자유입력 폴백.
  const domSlot = await loadDomains(DEFAULT_REPO);
  const spaceSel = buildSpaceSelect(f.space);
  spaceSel.setAttribute('aria-label', '주제 영역(space)');
  let domainInput;
  // 도메인 select 를 (재)생성해 현재 space 로 좁힌다 — 필터바 안에서 교체 가능하게 래퍼에 담는다.
  const domSlotWrap = el('span', { class: 'flt-domain-wrap' });
  function buildDomainInput() {
    let inp;
    if (domSlot.error) {
      inp = el('input', { type: 'text', placeholder: '도메인 키(목록 불가 — 직접 입력)', value: f.domain, 'aria-label': '도메인', class: 'flt-domain', title: domSlot.error });
    } else {
      inp = buildDomainSelect(domSlot, f.domain, f.space, '— 전체 도메인 —');
      inp.setAttribute('aria-label', '도메인');
    }
    inp.addEventListener('change', () => { f.domain = inp.value.trim(); syncHash(); refetch(); });
    domainInput = inp;
    domSlotWrap.replaceChildren(inp);
  }
  const lifecycleSel = selectFilter([
    ['active', '유효'], ['', '전체 상태'], ['rejected', '반려'], ['superseded', '대체됨'],
  ], f.lifecycle);
  const confidenceSel = selectFilter([
    ['', '전체 출처'], ['ai', 'AI'], ['human', '사람'], ['rule', '규칙'], ['observed', '외부 미러(커넥터)'],
  ], f.confidence);

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
    const qs = p.toString();
    history.replaceState(null, '', '#/browse' + (qs ? '?' + qs : ''));
  }

  async function refetch() {
    listBox.replaceChildren(skeletonRows(4));
    foot.replaceChildren();
    try {
      let entries;
      if (f.q.trim()) {
        // grep 경로 — 스니펫 포함. lifecycle/confidence 는 grep 백엔드 미지원이라 클라이언트에서 표시만.
        const r = await api('/api/ui/ctx/grep?' + new URLSearchParams(
          Object.assign({ query: f.q.trim(), limit: '50' }, f.kind ? { kind: f.kind } : {}, f.domain ? { domain: f.domain } : {})));
        entries = (r.matches || []).map((m) => ({ ...m, _snippet: m.snippet }));
      } else {
        const p = new URLSearchParams({ limit: '200' });
        if (f.kind) p.set('kind', f.kind);
        if (f.domain) p.set('domain', f.domain);
        if (f.lifecycle) p.set('lifecycle', f.lifecycle);
        if (f.confidence) p.set('confidence', f.confidence);
        const r = await api('/api/ui/ctx/ls?' + p.toString());
        entries = r.entries || [];
      }
      state.browse.entries = entries;
      renderEntries(listBox, entries, !!f.q.trim());
      foot.replaceChildren(el('span', { class: 'caption', text: entries.length + '건' + (f.q.trim() ? ' (검색)' : '') }));
    } catch (e) {
      listBox.replaceChildren(errorNote(e, '목록을 불러오지 못했습니다'));
    }
  }

  buildDomainInput(); // 초기 도메인 select 생성(현재 space 반영, change 리스너 포함)
  let qTimer = null;
  qInput.addEventListener('input', () => { f.q = qInput.value; clearTimeout(qTimer); qTimer = setTimeout(() => { syncHash(); refetch(); }, 280); });
  // space(1차) 변경 → 도메인 드롭다운을 그 space 로 재생성. 현재 도메인이 새 space 에 없으면 도메인 해제(혼선 방지).
  spaceSel.addEventListener('change', () => {
    f.space = spaceSel.value;
    if (f.space && f.domain && !domSlot.error) {
      const cur = domSlot.list.find((d) => d.key === f.domain);
      if (cur && (cur.space || 'product') !== f.space) f.domain = '';
    }
    buildDomainInput();
    syncHash(); refetch();
  });
  lifecycleSel.addEventListener('change', () => { f.lifecycle = lifecycleSel.value; syncHash(); refetch(); });
  confidenceSel.addEventListener('change', () => { f.confidence = confidenceSel.value; syncHash(); refetch(); });
  tree.addEventListener('click', (ev) => {
    const item = ev.target.closest('[data-kind-val]');
    if (!item) return;
    ev.preventDefault();
    f.kind = item.dataset.kindVal;
    for (const a of tree.querySelectorAll('[data-kind-val]')) a.classList.toggle('on', a.dataset.kindVal === f.kind);
    syncHash(); refetch();
  });

  const head = el('div', { class: 'page-head' },
    el('h1', {}, '탐색'),
    el('p', { class: 'sub', text: '종류(폴더)·주제(제품 도메인/비즈니스 기능)·상태로 좁히거나, 검색어로 제목·본문을 grep 합니다. 주제는 영역(space)을 먼저 고르면 도메인 목록이 좁혀집니다. 항목을 누르면 전문과 메타를 봅니다.' }),
  );
  const filterBar = el('div', { class: 'filter-bar browse-filter' }, qInput, spaceSel, domSlotWrap, lifecycleSel, confidenceSel,
    el('button', { class: 'btn btn-primary btn-sm', text: '+ 새 지식', onclick: () => openSaveOverlay(f.kind, f.domain, refetch) }));

  const layout = el('div', { class: 'browse-layout' },
    el('aside', { class: 'browse-side' }, el('div', { class: 'eyebrow', text: '종류' }), tree),
    el('section', { class: 'browse-main' }, filterBar, listBox, foot),
  );
  view.replaceChildren(head, layout);
  applyReveal([layout]);
  refetch();
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
async function loadDomains(repo, force) {
  const key = repo || DEFAULT_REPO;
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
  let repos = [DEFAULT_REPO];
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
    u = await api('/api/ui/ctx/cat?name=' + encodeURIComponent(name));
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
  const metaRows = [
    ['종류(kind)', kindLabel(u.kind) + ' (' + u.kind + ')'],
    Array.isArray(u.kinds) && u.kinds.length ? ['추가 종류', u.kinds.join(', ')] : null,
    ['도메인', u.domain_key ? (u.domain_key + (u.domain_repo ? ' · ' + u.domain_repo : '')) : '—'],
    ['출처(provenance)', CONFIDENCE_LABEL[u.confidence] || u.confidence],
    ['supersedes', u.supersedes || '—'],
    ['작성자', u.author || '—'],
    ['출처(source_ref)', u.source_ref || '—'],
    ['기준 시각(as_of)', u.as_of ? absTime(u.as_of) : '—'],
    ['버전', 'v' + u.version],
    ['마지막 갱신', (u.updated_at ? absTime(u.updated_at) : '—') + (u.updated_by ? ' · ' + u.updated_by : '')],
  ].filter(Boolean);
  const metaTable = el('table', { class: 'fields-table' });
  for (const [k, v] of metaRows) metaTable.append(el('tr', {}, el('td', { text: k }), el('td', { text: v })));

  // 상태 액션 — 신뢰우선 모델의 사후 반려/복원(채운 버튼 1개=주행동만, 나머지 ghost).
  const actions = el('div', { class: 'unit-actions' });
  actions.append(el('button', { class: 'btn btn-primary btn-sm', text: '편집', onclick: () => openEditOverlay(u) }));
  if (u.lifecycle === 'active') {
    actions.append(el('button', { class: 'btn btn-ghost btn-sm', text: '반려', onclick: () => changeLifecycle(u.name, 'rejected', view) }));
  } else if (u.lifecycle === 'rejected') {
    actions.append(el('button', { class: 'btn btn-ghost btn-sm', text: '복원', onclick: () => changeLifecycle(u.name, 'active', view) }));
  }

  const main = el('div', { class: 'detail-card' },
    el('div', { class: 'unit-title-row' },
      el('h1', { class: 'detail-title', text: u.title || u.name }),
      lifecycleDot(u.lifecycle),
    ),
    el('div', { class: 'detail-meta' }, el('span', { class: 'mono', text: u.name }), confidenceDot(u.confidence)),
    actions,
    el('div', { class: 'sec-label sec-label-row' }, el('span', { text: '본문' }), rawToggle),
    bodyWrap,
  );
  const side = el('aside', { class: 'unit-side' },
    el('div', { class: 'eyebrow', text: '메타데이터' }),
    metaTable,
  );

  const head = el('div', { class: 'page-head unit-head' }, backRow);
  view.replaceChildren(head, el('div', { class: 'unit-layout' }, main, side));
  applyReveal([main, side]);
}

async function changeLifecycle(name, lifecycle, view) {
  try {
    await api('/api/ui/ctx/set-lifecycle', { method: 'POST', body: JSON.stringify({ name, lifecycle }) });
    toast(lifecycle === 'rejected' ? '반려했습니다' : (lifecycle === 'active' ? '복원했습니다' : '상태를 바꿨습니다'));
    state.overview = null; // 검토 배지·지도 카운트 무효화
    getOverview(true).catch(() => {});
    // 상세 재로딩
    const u = await api('/api/ui/ctx/cat?name=' + encodeURIComponent(name));
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
  const listBox = el('div', { class: 'list-box' });
  view.replaceChildren(head, listBox);

  try {
    const r = await api('/api/ui/ctx/ls?' + new URLSearchParams({ confidence: 'ai', lifecycle: 'active', limit: '200' }));
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

// ════════════════════════════════════════════
// 안내(#/learn) — 지식유형/수집 ground-truth(GET /api/ui/learn = kind_registry + data_source) 렌더.
//  비개발자 대상: V4 본질 종류 4종(R·K·H·W) 중심 + 통합 예정 legacy 종류는 graceful 표시 + 데이터소스별 수집방식. 읽기 전용.
//  V4: 종류(kind)·주제(area=space+domain)·출처(provenance)는 별개 축 — 종류는 본질, 주제는 도메인, 출처는 채널 사실.
//  non-stale: 서버가 DB 를 그대로 반환하므로 정의를 DB 에서 고치면 이 화면도 즉시 반영(런북과 동일 데이터).
//  §0.5 절제: 무채색 카드 + 작은 상태 점만, 채운 배지 금지. 자유텍스트는 안전 마크다운 렌더 재사용.
// ════════════════════════════════════════════
async function renderLearn(view) {
  view.replaceChildren(skeleton('지식유형 안내를 불러오는 중'));
  let data;
  try { data = await api('/api/ui/learn'); }
  catch (e) { view.replaceChildren(errorNote(e, '안내를 불러오지 못했습니다')); return; }

  const head = el('div', { class: 'page-head' },
    el('h1', {}, '지식 ', el('span', { class: 'accent', text: '안내' })),
    el('p', { class: 'sub', text: '회사의 지식은 세 축으로 정리됩니다 — 본질 종류(kind: R·K·H·W 4종), 주제(area: 제품 도메인/비즈니스 기능), 출처(provenance: 외부 미러·사람·AI·규칙). 아래는 각 종류의 정의·저장·전달과 데이터소스별 수집방식이며, 시스템의 실제 분류 기준(ground-truth)을 그대로 보여줍니다. ‘통합 예정(legacy)’으로 표시된 종류는 K 또는 domainmap 으로 합쳐지는 중입니다.' }),
  );

  // ── 1. 지식 종류(본질 4종 R·K·H·W + 통합 예정 legacy) ── (각 종류 = 무채색 카드: 글리프+이름+전달방식 점 / 정의·분류기준·저장·전달)
  // V4: 본질 종류 4종은 그대로, 그 외(D/F/A/M/S/G/L/Z)는 '통합 예정(legacy)' 태그로 graceful 표시(무중단 — 행은 유지).
  const kindsWrap = el('div', { class: 'learn-kinds' });
  for (const k of (data.kinds || [])) {
    const meta = kindMeta(k.kind);
    const legacy = !isCoreKind(k.kind);
    const card = el('section', { class: 'card learn-kind' + (legacy ? ' learn-kind-legacy' : '') },
      el('div', { class: 'learn-kind-head' },
        el('span', { class: 'kind-glyph', 'aria-hidden': 'true', text: k.kind }),
        el('div', { class: 'learn-kind-titles' },
          el('div', { class: 'learn-kind-name', text: meta.ko || k.label || k.kind }),
          el('div', { class: 'learn-kind-en', text: k.label || (meta.label || '') }),
        ),
        legacy ? el('span', { class: 'src-status', title: 'V4: 본질 4종(R·K·H·W)으로 통합 예정 — 신규 분류엔 쓰지 않습니다.' },
          el('span', { class: 'dot6 dim', 'aria-hidden': 'true' }), '통합 예정') : null,
        el('span', { class: 'inject-tag', title: INJECTION_HINT[k.injection_mode] || '',
          text: INJECTION_LABEL[k.injection_mode] || k.injection_mode }),
      ),
    );
    if (k.description) card.append(el('div', { class: 'learn-def' }, renderMarkdown(k.description)));
    const rows = el('div', { class: 'learn-rows' });
    if (k.criteria) rows.append(learnRow('언제 이 종류인가', k.criteria));
    if (k.storage) rows.append(learnRow('저장방식', k.storage));
    if (k.delivery) rows.append(learnRow('전달방식', k.delivery));
    rows.append(learnRow('도메인 귀속', k.domain_scoped ? '예 (도메인에 묶입니다)' : '아니오'));
    card.append(rows);
    // 그 종류의 지식 단위로 바로 탐색.
    card.append(el('div', { class: 'learn-kind-foot' },
      el('a', { class: 'btn btn-ghost btn-sm', href: '#/browse?kind=' + encodeURIComponent(k.kind), text: '이 종류 탐색 →' })));
    kindsWrap.append(card);
  }

  // ── 2. 데이터소스별 수집방식 ── (담백한 표 + 상태 점)
  const srcCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '데이터소스별 수집방식' })),
    el('p', { class: 'admin-hint', text: '외부 시스템에서 무엇이 어떻게 수집되어 어느 종류로 적재되는지입니다. ‘중단’은 현재 수집하지 않는 상태로, 연결(커넥터)은 보존됩니다.' }),
  );
  const sources = data.sources || [];
  if (!sources.length) {
    srcCard.append(el('p', { class: 'admin-hint', text: '등록된 데이터소스가 없습니다.' }));
  } else {
    const tbl = el('table', { class: 'fields-table learn-src-table' });
    tbl.append(el('tr', {},
      el('td', { class: 'kr-h', text: '소스' }), el('td', { class: 'kr-h', text: '상태' }),
      el('td', { class: 'kr-h', text: '수집방식' }), el('td', { class: 'kr-h', text: '적재 종류' })));
    for (const s of sources) {
      const dropped = s.status === 'dropped';
      tbl.append(el('tr', {},
        el('td', {}, el('b', { text: s.label || s.system })),
        el('td', {}, el('span', { class: 'src-status' },
          el('span', { class: 'dot6 ' + (dropped ? 'dim' : 'ok'), 'aria-hidden': 'true' }),
          dropped ? '중단' : '수집중')),
        el('td', {}, el('span', { text: s.collection_method || '—' }),
          s.cadence ? el('span', { class: 'learn-cadence', text: ' · ' + s.cadence }) : null),
        el('td', {}, el('span', { class: 'mono', text: (s.into_kinds || []).join(', ') || '—' })),
      ));
    }
    srcCard.append(tbl);
  }

  view.replaceChildren(head, el('div', { class: 'eyebrow', text: '지식 종류 (본질 R·K·H·W + 통합 예정 legacy)' }), kindsWrap,
    el('div', { class: 'eyebrow', text: '데이터 수집' }), srcCard);
  document.getElementById('view').focus?.();
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
  saveOverlay(u, true, () => { location.hash = '#/u/' + encodeURIComponent(u.name); route(); });
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
  const domSlot = await loadDomains(DEFAULT_REPO);
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
  if (!localStorage.getItem(TOKEN_KEY)) { showGate(); return; }
  const { segs, params } = parseHash();
  const view = $view();
  const page = segs[0] || 'map';
  try {
    if (page === 'browse') {
      setActiveTab('browse');
      await renderBrowse(view, params);
    } else if (page === 'u') {
      setActiveTab('browse'); // 유닛 상세는 탐색의 하위 — 탐색 탭 활성 유지
      await renderUnit(view, decodeURIComponent(segs.slice(1).join('/')));
    } else if (page === 'learn') {
      setActiveTab('learn');
      await renderLearn(view);
    } else if (page === 'review') {
      setActiveTab('review');
      await renderReview(view);
    } else if (page === 'system') {
      setActiveTab('system');
      await renderSystem(view, segs[1] || null);
    } else {
      setActiveTab('map');
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
const ADMIN_SECTIONS = [
  { key: 'kinds', label: '지식 종류 레지스트리', meaning: null },
  { key: 'domains-repos', label: '도메인 · 레포', meaning: null },
  { key: 'managed-policy', label: '강제 규칙', meaning: 'managed-policy' },
  { key: 'org-defaults', label: '회사 맥락 · 페르소나', meaning: 'org-defaults' },
  { key: 'memory', label: '팀 메모리', meaning: 'memory' },
  { key: 'members', label: '구성원', meaning: 'member' },
  { key: 'tokens', label: '토큰', meaning: null },
  { key: 'profile', label: '조직 · 연결', meaning: 'gateway-url' },
  { key: 'runtime', label: '런타임 · 훅', meaning: 'runtime' },
  { key: 'hooks-preview', label: '훅 주입 미리보기', meaning: null },
  { key: 'custom-hooks', label: '커스텀 훅', meaning: 'custom-hook' },
  { key: 'tools', label: 'AI 도구(툴)', meaning: 'tool' },
  { key: 'mcp', label: 'MCP 서버', meaning: 'mcp' },
  { key: 'db-sources', label: 'DB 데이터소스', meaning: 'db-source' },
  { key: 'publish', label: '발행', meaning: null },
  { key: 'deploy', label: '설치 · 업데이트 · 제거', meaning: null },
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
// '구성원에게 미치는 효과' 카드 — 의미 인지의 핵심 컴포넌트.
function meaningCard(m) {
  if (!m) return null;
  const tag = { critical: '절대 규칙', identity: '신원 · 매칭', infra: '연결 · 배포', normal: '' }[m.tone] || '';
  return el('div', { class: 'meaning meaning-' + m.tone },
    el('div', { class: 'meaning-head' },
      el('span', { class: 'meaning-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'meaning-title', text: '이 내용이 구성원에게 미치는 효과' }),
      tag ? el('span', { class: 'meaning-tag', text: tag }) : null),
    el('p', { class: 'meaning-what', text: m.what }),
    el('div', { class: 'meaning-grid' },
      meaningRow('누가 받나', m.reach),
      meaningRow('언제 도달', m.when),
      meaningRow('어디에 나타나나', m.where)),
    el('div', { class: 'meaning-ex' },
      el('span', { class: 'meaning-ex-label', text: '예시' }),
      el('span', { text: m.example })));
}

function adminRowMeta(key, data) {
  if (key === 'kinds') return (state.overview ? state.overview.kinds.length : 4) + '개 종류';
  if (key === 'domains-repos') { const s = state.domains[DEFAULT_REPO]; return s && s.loaded && !s.error ? s.list.length + '개 도메인' : '통제 어휘 관리'; }
  if (key === 'managed-policy' || key === 'org-defaults') {
    const s = data.sections[key];
    return s && s.body_md && s.body_md.trim() ? '작성됨 · v' + s.version : '비어 있음';
  }
  if (key === 'memory') return data.memory.length + '개 문서';
  if (key === 'members') return data.members.length + '명';
  if (key === 'tokens') return (data.tokens || []).filter((t) => !t.revoked_at).length + '개 활성';
  if (key === 'profile') return data.profile.gateway_url ? '연결됨' : '게이트웨이 미설정';
  if (key === 'publish') return '구성원에게 게시';
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

  let sel = sub || state.admin.sel || 'kinds';
  if (sectionHidden(sel, data)) sel = 'kinds'; // 권한 없는 섹션 진입 차단(admin/runtime)
  state.admin.sel = sel;

  const list = el('div', { class: 'split-list card admin-nav' });
  for (const s of ADMIN_SECTIONS) {
    if (sectionHidden(s.key, data)) continue;
    list.append(el('a', { class: 'row' + (s.key === sel ? ' sel' : ''), href: '#/system/' + s.key },
      el('div', { class: 'row-title', text: s.label }),
      el('div', { class: 'row-meta', text: adminRowMeta(s.key, data) })));
  }
  const detail = el('div', { class: 'split-detail' });
  renderAdminDetail(detail, sel, data);

  view.replaceChildren(el('div', {},
    el('div', { class: 'card-head admin-head' },
      el('h2', { text: '관리' }),
      canEdit
        ? el('span', { class: 'admin-sub', text: (data.profile.display_name || '조직') + ' · 편집은 발행 후 구성원에게 반영됩니다' })
        : el('span', { class: 'admin-sub' }, el('span', { class: 'pill', text: '읽기 전용' }), ' ' + (data.profile.display_name || '조직') + ' · 보기 전용(편집은 관리자)')),
    el('div', { class: 'split admin-split' }, list, detail)));
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
    el('div', { class: 'card-head' }, el('h2', { text: '도메인 · 레포' }),
      canEdit ? null : el('span', { class: 'admin-sub' }, el('span', { class: 'pill', text: '읽기 전용' }), ' 편집은 context 권한 필요')),
    el('p', { class: 'admin-hint', text: '주제(area)는 2단입니다 — 영역(space): 제품 도메인(코드앵커·부채추적) 또는 비즈니스 기능(GTM·가격·펀딩·시장경쟁·브랜드·조직). 도메인·기능은 자유 키워드가 아니라 레포 하위의 통제 어휘이며, 여기서 관리한 어휘만 지식 저장 시 고를 수 있습니다. 이름변경은 옛 슬러그를 보존하는 별칭 방식이라(물리 키 불변) 기존 지식이 끊기지 않습니다.' }));
  detail.replaceChildren(card);

  const repos = await loadRepos();
  let repo = state.admin.repoSel || (repos.includes(DEFAULT_REPO) ? DEFAULT_REPO : repos[0]);
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
      el('button', { class: 'btn-text', text: '폐기', onclick: () => repoCrudOverlay({ name: repo, mode: 'deprecate' }, detail, data) }));
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
      const actions = canEdit ? el('td', {}, el('button', { class: 'btn-text', text: '이름변경', onclick: () => domainCrudOverlay(d, repo, detail, data, sec.space) })) : null;
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

// ── 섹션(강제규칙·회사맥락) markdown 에디터 ──
function sectionEditor(detail, key, data) {
  const canEdit = state.admin.canEdit;
  const meaning = data.meaning[key];
  const sec = data.sections[key] || { body_md: '', version: 0 };
  const ta = el('textarea', { rows: '18', class: 'admin-ta', 'aria-label': meaning ? meaning.label : key });
  ta.value = sec.body_md || '';
  ta.readOnly = !canEdit;
  const body = [
    el('div', { class: 'card-head' },
      el('h2', { text: meaning ? meaning.label : key }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '멤버 미리보기', onclick: showMemberPreview })),
    el('p', { class: 'admin-hint', text: canEdit ? 'markdown 으로 작성하세요. 저장은 초안이고, [발행]해야 구성원이 받습니다.' : '읽기 전용 — 이 내용이 모든 구성원의 세션에 주입됩니다.' }),
    ta,
  ];
  if (canEdit) {
    const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
    const status = el('span', { class: 'admin-status' });
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        const r = await api('/api/ui/org/section', { method: 'POST', body: JSON.stringify({ section: key, body_md: ta.value }) });
        data.sections[key] = r.section;
        status.textContent = '저장됨 · v' + r.section.version;
        toast('저장됨 — 발행하면 구성원에게 반영됩니다');
      } catch (e) { toast(e.message, true); status.textContent = ''; }
      saveBtn.disabled = false;
    });
    body.push(el('div', { class: 'admin-actions' }, saveBtn, status));
  }
  body.push(meaningCard(meaning));
  detail.replaceChildren(el('div', { class: 'card' }, ...body));
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
  else right.append(el('p', { class: 'admin-hint', text: canEdit ? '왼쪽에서 구성원을 고르거나 추가하세요.' : '읽기 전용 — 이름·종류만 표시됩니다(이메일·계정·권한은 관리자만).' }), meaningCard(meaning));

  detail.replaceChildren(el('div', { class: 'card' },
    el('h2', { text: '구성원' }),
    el('div', { class: 'admin-two' }, listCol, right)));
}

function memberForm(root, m, data, detail, isNew) {
  // 읽기 전용(비-admin): 폼 대신 요약(민감 필드는 서버가 이미 redact).
  if (!state.admin.canEdit) {
    root.replaceChildren(
      el('h3', { text: m.display_name || m.id }),
      el('div', { class: 'mini-meta', text: '종류: ' + (m.kind || 'human') + ' · 상태: ' + (m.state || 'active') }),
      meaningCard(data.meaning['member']));
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
  const SCOPE_OPTS = [['items', '아이템 조회'], ['context', '컨텍스트'], ['admin', '관리자(편집·발행)'], ['runtime', '런타임(훅·툴 정의)']];
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
    actions,
    meaningCard(data.meaning['member']));
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
  else right.append(el('p', { class: 'admin-hint', text: '팀이 승인한 공식 지식만 둡니다(개인 메모는 각자 로컬).' }), meaningCard(data.meaning['memory']));
  detail.replaceChildren(el('div', { class: 'card' }, el('h2', { text: '팀 메모리' }), el('div', { class: 'admin-two' }, listCol, right)));
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
  const domSlot = await loadDomains(DEFAULT_REPO);
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
    field('본문', bodyTa), actions, meaningCard(data.meaning['memory']));
}

// ── 조직 · 연결 ──
function profileEditor(detail, data) {
  const canEdit = state.admin.canEdit;
  const p = data.profile;
  const dnIn = el('input', { type: 'text', value: p.display_name || '', placeholder: '조직 표시명' });
  const gwIn = el('input', { type: 'text', value: p.gateway_url || '', placeholder: 'http://게이트웨이:포트' });
  if (!canEdit) { dnIn.disabled = true; gwIn.disabled = true; }
  const body = [
    el('h2', { text: '조직 · 연결' }),
    field('조직 표시명', dnIn), meaningCard(data.meaning['display_name']),
    field('게이트웨이 주소', gwIn), meaningCard(data.meaning['gateway-url']),
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

// ── 발행 · 배포 ──
function publishPanel(detail, data) {
  const pm = data.publishMeaning || {};
  const runBtn = el('button', { class: 'btn btn-primary', text: '발행(검증)' });
  const result = el('div', { class: 'admin-status' });
  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true; result.textContent = '발행 중…';
    try {
      const r = await api('/api/ui/org/publish', { method: 'POST', body: '{}' });
      result.replaceChildren(el('span', { class: 'pill pill-ok', text: '발행 OK' }),
        ' AGENTS.md ' + (r.artifactBytes != null ? (r.artifactBytes / 1024).toFixed(1) + ' KiB' : '?'),
        r.warning ? el('span', { class: 'pill pill-warn', text: r.warning }) : null);
      toast('발행 검증 완료 — 구성원은 설치/재설치로 받습니다');
    } catch (e) { result.textContent = ''; toast(e.message, true); }
    runBtn.disabled = false;
  });
  detail.replaceChildren(el('div', { class: 'card' },
    el('h2', { text: '발행 · 배포' }),
    el('p', { class: 'admin-what', text: pm.what || '' }),
    el('p', { class: 'admin-hint', text: pm.effect || '' }),
    el('p', { class: 'admin-hint', text: pm.note || '' }),
    el('div', { class: 'admin-actions' }, runBtn, result),
    el('div', { class: 'meaning meaning-infra' },
      el('div', { class: 'meaning-head' }, el('span', { class: 'meaning-dot' }), el('span', { class: 'meaning-title', text: '구성원 설치 방법' })),
      el('p', { class: 'meaning-what', text: '구성원은 git 없이 한 줄로 설치합니다 — [구성원] 탭에서 각자 토큰을 발급하면 그 사람 전용 설치 명령이 나옵니다.' }))));
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
    el('h2', { text: '토큰' }),
    el('p', { class: 'admin-hint', text: '구성원별로 토큰을 발급(배포용)하고, 발급된 토큰을 회수합니다. 회수하면 게이트웨이 재시작 없이 즉시 무효화됩니다(오프보딩). 평문 토큰은 발급 시 1회만 표시되고 저장되지 않습니다.' }),
    installMinterBlock(data, gw),
  ];
  if (active.length) children.push(el('div', { class: 'token-section' }, el('div', { class: 'token-section-h', text: '활성 (' + active.length + ')' }), ...active.map((t) => tokenRow(t, true))));
  else children.push(el('p', { class: 'admin-hint', text: '활성 토큰이 없습니다 — [구성원] 탭에서 발급하세요.' }));
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
    el('h2', { text: '런타임 · 훅' }),
    el('p', { class: 'admin-hint', text: '구성원 머신의 리플렉스(훅) 동작과 작업 폴더를 중앙에서 제어. 변경은 다음 세션에 자동 반영(재설치 불요). 전체 끄기는 구성원이 LIVELY_OFF=1 로.' }),
    field('활성 훅', hookWrap),
    field('writeback 너지 문구 (선택)', noticeTa),
    field('work-roots — 이 폴더에서 켠 세션은 라이블리 작업으로 인식 (줄당 절대경로)', wrTa),
    el('div', { class: 'admin-subhead', text: 'AI 도구(http_proxy) 안전 화이트리스트' }),
    el('p', { class: 'admin-hint', text: 'AI 도구가 외부를 호출할 수 있는 범위 — 이 목록 밖은 전부 차단됩니다(SSRF 방어).' }),
    field('허용 인증 환경변수 이름 (allowed_auth_envs)', envTa),
    field('허용 호스트 (url_allowlist)', hostTa),
    el('div', { class: 'admin-actions' }, saveBtn, status),
    meaningCard(data.meaning['runtime'])));
}

// ── 훅 주입 미리보기(V4-P5 J절) — 설치된 3 세션 훅이 각자 세션에 실제로 주입하는 최종 메시지를 보여준다. ──
//  데이터 출처: GET /api/ui/org/hooks/preview (scope null = 인증만, REST 전용). 읽기 전용.
//  보안: 모든 데이터 텍스트는 textContent(el text:)/renderMarkdown(createElement+textContent) 로만 — innerHTML 데이터주입 0.
//  드리프트 정직성: 서버가 fidelity(exact/approximate)와 source 를 함께 주므로 그대로 표기(근사면 사유 명시).
function hooksPreviewPanel(detail, data) {
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '훅 주입 미리보기' })),
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
  else right.append(el('p', { class: 'admin-hint', text: 'lively 게이트웨이는 기본 등록됩니다. 여기엔 추가 도구(MCP 서버)를 둡니다. 인증은 환경변수 이름만(시크릿 값 금지).' }), meaningCard(data.meaning['mcp']));
  detail.replaceChildren(el('div', { class: 'card' }, el('h2', { text: 'MCP 서버' }), el('div', { class: 'admin-two' }, listCol, right)));
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
    actions, meaningCard(data.meaning['mcp']));
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
    el('p', { class: 'admin-hint', text: 'db_query/db_schema 가 읽는 외부 운영 DB(읽기전용)입니다. 접속 비밀번호는 저장하지 않고 환경변수 이름(auth_ref)으로만 참조합니다 — 읽기전용 role + RLS 전제. env(.env)로 설정한 소스는 읽기 전용으로 표시됩니다.' }),
    meaningCard(data.meaning['db-source']));
  detail.replaceChildren(el('div', { class: 'card' }, el('h2', { text: 'DB 데이터소스' }), el('div', { class: 'admin-two' }, listCol, right)));
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
    actions, meaningCard(data.meaning['db-source']));
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
    el('p', { class: 'admin-hint', text: '구성원 머신에서 특정 시점에 자동 실행되는 코드입니다. 본문은 멤버 디스크에 저장되지 않고 매 세션 게이트웨이에서 받아 실행됩니다(끄면 다음 세션부터 무효).' }),
    meaningCard(data.meaning['custom-hook']));
  detail.replaceChildren(el('div', { class: 'card' }, el('h2', { text: '커스텀 훅' }), el('div', { class: 'admin-two' }, listCol, right)));
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
    actions, meaningCard(data.meaning['custom-hook']));
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
    builtinToggles(data),
    meaningCard(data.meaning['tool']));
  detail.replaceChildren(el('div', { class: 'card' }, el('h2', { text: 'AI 도구(툴)' }), el('div', { class: 'admin-two' }, listCol, right)));
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
    actions, meaningCard(data.meaning['tool']));
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
  const go = el('button', { class: 'btn btn-primary btn-sm', text: '토큰 발급 → 명령 생성' });
  go.addEventListener('click', async () => {
    const m = (data.members || []).find((x) => x.id === sel.value) || { id: sel.value };
    if (!m.id) { toast('구성원을 선택하세요', true); return; }
    go.disabled = true;
    try {
      const r = await api('/api/ui/org/token', { method: 'POST',
        body: JSON.stringify({ userId: m.id, memberId: m.id, label: m.display_name || m.id }) });
      const cmd = installCmd(gw, 'mac', r.token);
      result.replaceChildren(
        el('p', { class: 'admin-hint', text: '✓ ' + (m.display_name || m.id) + ' 토큰 발급됨(scope: ' + r.scopes.join('/') + '). 아래 macOS 설치 명령을 전달하세요(Windows는 본인이 설치 탭에서). 토큰은 지금만 보입니다.' }),
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
