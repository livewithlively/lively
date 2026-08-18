// lib/markdown.ts — 안전 마크다운 렌더러(R28). core.ts 에서 **verbatim 적출**(로직 변경 0).
//  왜 갈랐나: core.ts 1,582줄의 절반(793줄)이 이 렌더러였다 — 커널(부트/네트/DOM 프리미티브/공용 위젯)과
//  렌더러가 한 파일에 섞여 있어 서로 무관한 변경이 같은 diff 를 밟았다. 이제 마크다운 문법 손질은 이 파일만 바뀐다.
//  ⚠ MD_UI_CHIPS 재진입 플래그(저장/복원 관용구)는 renderInline·renderMarkdown 과 **반드시 같은 모듈**에 있어야 한다 —
//    갈라 두면 중첩 렌더의 재진입 보호가 깨진다(모듈 경계를 넘는 순간 서로 다른 바인딩을 보게 된다).
//  의존 방향: lib/markdown → lib/* 직결(R29b). R28 때는 core 배럴을 경유해 core↔markdown 순환이었지만,
//    core 가 쓰던 프리미티브가 lib/(net·dom·format·uitext)로 마저 내려와 이제 lib 안에서 끝난다
//    (core 는 renderMarkdown 계열을 재수출만 한다 → 단방향. ALLOWED_CYCLES 등재분도 함께 제거).
import { TOKEN_KEY, api, apiUrl } from './net.js';
import { el } from './dom.js';
import { relTime } from './format.js';
import { isMdTableSep, mdTableSplitRow } from './table-md.js';   // 표 셀 분리 규칙은 에디터(표 즉시 편집)와 공유한다(#1685)
import { uiKeyCls } from './uitext.js';

// :::shot 첫 만남 시연을 이미 튼 라우트(#1107 v2) — 같은 페이지에서 한 번만, 재방문에도 다시 안 튼다.
let shotDemoRoute = '';

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

// 이미지 로더(#551) — 인증 라우트(/api/ui/…)의 이미지는 <img> 가 Authorization 헤더를 못 실어 토큰 세션에서
// 401 이 난다 → fetch(토큰 헤더, 쿠키 동봉) 후 blob URL 로 표시. 그 외(외부/정적) 이미지는 그대로 src.
function mdImage(src, alt) {
  const img: any = el('img', { class: 'md-img', alt: alt || '', loading: 'lazy' });
  img.dataset.mdSrc = String(src);   // #657 블록 에디터 직렬화용 원본 src 보존(blob URL 로 바뀌어도 md 는 원본 유지)
  if (!String(src).startsWith('/api/ui/')) { img.setAttribute('src', src); return img; }
  const token = localStorage.getItem(TOKEN_KEY);
  fetch(apiUrl(src), { headers: token ? { Authorization: 'Bearer ' + token } : {} })
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.blob(); })
    .then((b) => { img.src = URL.createObjectURL(b); })
    .catch(() => { img.classList.add('md-img-missing'); img.alt = (alt || '이미지') + ' (불러오기 실패)'; });
  return img;
}

// 인라인 파싱 → 텍스트 노드/엘리먼트 배열. 코드(`)·굵게(**)·기울임(*)·링크·이미지·취소선(~~)·밑줄(++)·하이라이트(==) 지원.
//  이미지/밑줄/하이라이트는 #551 노션 무손실 미러 본문(notion-md.ts 방언) 대응 — 일반 저작 지식에도 동일 적용.
// docs 전용 인라인 UI 참조 칩(#1013) — 사용가이드의 [버튼]·「메뉴/옵션/상태」 대괄호·꺽쇠 노이즈를
//  '눌리는 버튼' 칩과 '부드러운 태그' 칩으로 승격해 가독성을 올린다. renderMarkdown(md, {uiChips:true}) 로만
//  켜지며(learn.ts docs 렌더), 지식·위키·프로젝트 등 다른 마크다운 소비자엔 영향이 없다.
let MD_UI_CHIPS = false;
function renderInline(text, opts?: { noAutolink?: boolean }) {
  const noAutolink = !!(opts && opts.noAutolink);   // 링크 label 안에선 autolink 끔(중첩 링크·저장 시 [url](url) 재-오토링크 방지)
  const out: any[] = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(document.createTextNode(buf)); buf = ''; } };
  const s = text;
  let i = 0;
  // 쌍 구분자(~~, ++, ==) 공통 처리 — 오탐 가드 3중(#551 리뷰):
  //  ① 여는 구분자 앞이 ASCII 영숫자면 스킵(코드성 a==b, i++, C++ — 노션 변환 출력은 경계가 공백/한글/행머리)
  //  ② 내용이 비거나(====) 공백으로 시작/끝나면 스킵("a == b == c")
  const paired = (mark, make) => {
    const prev = i > 0 ? s[i - 1] : '';
    if (prev && /[A-Za-z0-9]/.test(prev)) return false;
    const end = s.indexOf(mark, i + 2);
    if (end > i + 2 && s[i + 2] !== ' ' && s[end - 1] !== ' ') {
      flush();
      out.push(make(s.slice(i + 2, end)));
      i = end + 2;
      return true;
    }
    return false;
  };
  while (i < s.length) {
    const ch = s[i];
    // 백슬래시 이스케이프(#541 — ClickUp markdown_description 은 평문 대시/구두점을 \- \* 등으로 이스케이프해 준다.
    //  CommonMark 이스케이프 문자면 리터럴로 소비 — 안 하면 \- 가 화면에 그대로 보인다.)
    if (ch === '\\' && s[i + 1] !== undefined && '\\`*_{}[]()#+-.!~|<>"\''.indexOf(s[i + 1]) >= 0) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
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
    // 이미지 ![alt](url) — 링크보다 먼저(문법이 링크의 상위집합).
    if (ch === '!' && s[i + 1] === '[') {
      const close = s.indexOf(']', i + 2);
      if (close > i && s[close + 1] === '(') {
        const paren = s.indexOf(')', close + 2);
        if (paren > close) {
          const alt = s.slice(i + 2, close);
          const src = safeHref(s.slice(close + 2, paren));
          flush();
          if (src) out.push(mdImage(src, alt));
          else if (alt) out.push(document.createTextNode(alt));
          i = paren + 1;
          continue;
        }
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
    // 취소선 ~~...~~ · 밑줄 ++...++ · 하이라이트 ==...==
    if (ch === '~' && s[i + 1] === '~' && paired('~~', (t) => el('del', { class: 'md-del' }, ...renderInline(t)))) continue;
    if (ch === '+' && s[i + 1] === '+' && paired('++', (t) => el('u', { class: 'md-u' }, ...renderInline(t)))) continue;
    if (ch === '=' && s[i + 1] === '=' && paired('==', (t) => el('mark', { class: 'md-mark' }, ...renderInline(t)))) continue;
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
    // 기울임 _..._ (#541 — ClickUp 이탤릭). snake_case 오탐 방지: 여는 _ 앞은 시작/공백/구두점, 닫는 _ 뒤는 단어문자 금지.
    if (ch === '_' && s[i + 1] !== '_' && s[i + 1] !== ' ' && s[i + 1] !== undefined
      && (i === 0 || !/[\p{L}\p{N}_]/u.test(s[i - 1]))) {
      const end = s.indexOf('_', i + 1);
      if (end > i && s[end - 1] !== ' ' && (end === s.length - 1 || !/[\p{L}\p{N}_]/u.test(s[end + 1]))) {
        flush();
        out.push(el('em', {}, ...renderInline(s.slice(i + 1, end))));
        i = end + 1;
        continue;
      }
    }
    // 자동 링크(autolink) — 본문에 그냥 붙여넣은 맨 URL(http/https/www)을 하이퍼링크로 만든다.
    //  마크다운 링크 [텍스트](url) 는 아래에서 별도 처리되므로 여기선 '벌거벗은' URL 만 잡는다.
    //  경계 가드: 여는 위치 앞이 단어문자면(이메일 도메인·URL 일부 등 오탐) 스킵. URL 은 공백/제어문자 전까지,
    //  뒤따르는 문장부호(.,;:!?)·닫는 괄호는 링크에서 제외(문장 끝 오탐 방지). www. 는 https:// 를 붙여 링크.
    if (!noAutolink && (ch === 'h' || ch === 'w') && (i === 0 || !/[\p{L}\p{N}@._-]/u.test(s[i - 1]))) {
      const rest = s.slice(i);
      const m = /^(https?:\/\/[^\s<]+|www\.[^\s<]+)/i.exec(rest);
      if (m) {
        let raw = m[0];
        // 뒤쪽 문장부호·닫는 괄호 제거(단, 짝이 맞는 괄호는 URL 의 일부일 수 있어 보존).
        let trail = '';
        while (raw.length) {
          const last = raw[raw.length - 1];
          if ('.,;:!?"\''.indexOf(last) >= 0) { trail = last + trail; raw = raw.slice(0, -1); continue; }
          if (last === ')' && (raw.split('(').length - 1) < (raw.split(')').length - 1)) { trail = last + trail; raw = raw.slice(0, -1); continue; }
          break;
        }
        const href = safeHref(/^www\./i.test(raw) ? 'https://' + raw : raw);
        if (href) {
          flush();
          out.push(el('a', { class: 'md-link', href, rel: 'noopener noreferrer nofollow' }, document.createTextNode(raw)));
          i += raw.length; // trail 은 다시 일반 파서로 흘려 문장부호로 렌더
          continue;
        }
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
            // 내부 앵커(#/k/…)는 같은 SPA 이동이라 새 탭 힌트 불필요, 외부는 noopener.
            //  label 은 noAutolink — label 이 URL 이어도([url](url)) 안에서 또 autolink 되어 링크가 중첩되지 않게(저장 왕복 안정).
            out.push(el('a', { class: 'md-link', href, rel: 'noopener noreferrer nofollow' }, ...renderInline(label, { noAutolink: true })));
          } else {
            // 위험 스킴 → 링크 무력화. 라벨만 평문으로(href 비노출).
            out.push(...renderInline(label, { noAutolink: true }));
          }
          i = paren + 1;
          continue;
        }
      }
    }
    // docs 전용: 링크가 아닌 [라벨] = UI 버튼/액션 참조 → 버튼 칩 (#1013). 링크([x](url))는 위에서 이미 처리됨.
    if (MD_UI_CHIPS && ch === '[') {
      const close = s.indexOf(']', i + 1);
      if (close > i && s[close + 1] !== '(') {
        const label = s.slice(i + 1, close);
        if (label.trim() && label.indexOf('\n') < 0) {
          flush();
          out.push(el('span', { class: uiKeyCls('md-uikey-btn', label) }, ...renderInline(label)));
          i = close + 1;
          continue;
        }
      }
    }
    // docs 전용: 「라벨」 = 메뉴/옵션/상태 이름 → 태그 칩 (#1013).
    if (MD_UI_CHIPS && ch === '「') {
      const close = s.indexOf('」', i + 1);
      if (close > i) {
        const label = s.slice(i + 1, close);
        if (label.trim() && label.indexOf('\n') < 0) {
          flush();
          out.push(el('span', { class: uiKeyCls('md-uikey-opt', label) }, ...renderInline(label)));
          i = close + 1;
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

// ── :::컨테이너(#551 notion-md 방언) — :::타입 [속성|요약] … ::: (중첩 가능). ──
//  toggle(details)·callout(틴트 카드)·columns/column(flex)·synced(동기화 블록)·toc·unsupported.
//  미지 타입은 마커 없이 내용만 렌더(우아한 강등 — 다른 MD 소비자와 같은 자세).
function parseContainerAttrs(rest) {
  const attrs: any = {};
  let summary = '';
  for (const tok of String(rest || '').split(/\s+/)) {
    const m = /^([a-zA-Z_-]+)=(.*)$/.exec(tok);
    if (m && summary === '') attrs[m[1]] = m[2];
    else summary += (summary ? ' ' : '') + tok;
  }
  return { attrs, summary: summary.trim() };
}

function renderContainer(type, rest, bodyLines) {
  const { attrs, summary } = parseContainerAttrs(rest);
  const inner = () => renderMarkdown(bodyLines.join('\n'));
  const moveChildren = (from, to) => { while (from.firstChild) to.append(from.firstChild); return to; };
  switch (type) {
    case 'toggle': case 'template': {
      const det = el('details', { class: 'md-toggle' },
        el('summary', { class: 'md-toggle-sum' }, ...renderInline(summary || rest || '펼치기')));
      return moveChildren(inner(), det);
    }
    case 'callout': {
      const color = String(attrs.color || '').replace(/_background$/, '') || 'default';
      const box = el('div', { class: 'md-callout md-callout-' + color.replace(/[^a-z]/g, '') });
      if (attrs.icon) box.append(el('span', { class: 'md-callout-ic', 'aria-hidden': 'true', text: attrs.icon }));
      box.append(moveChildren(inner(), el('div', { class: 'md-callout-body' })));
      return box;
    }
    case 'columns': {
      const row = el('div', { class: 'md-columns' });
      const rendered = inner();
      // 자식 중 md-column 만 수평 배치 — 그 외 노드는 그대로(방어).
      while (rendered.firstChild) row.append(rendered.firstChild);
      return row;
    }
    case 'column': {
      const col = el('div', { class: 'md-column' });
      const ratio = Number(attrs.ratio);
      if (Number.isFinite(ratio) && ratio > 0 && ratio <= 1) col.style.flex = String(ratio) + ' 1 0';
      return moveChildren(inner(), col);
    }
    case 'tabs': {
      // 전환형 탭(#780 사용설명서) — 자식 :::tab 패널들을 버튼 바로 전환(Claude Code docs 의 Tabs 대응).
      //  패널이 하나도 없으면(문법 오용) 내용을 그대로 흘려 안전 강등.
      const rendered = inner();
      const panes = Array.from(rendered.children).filter((n: any) => n.classList && n.classList.contains('md-tabpane'));
      if (!panes.length) return moveChildren(rendered, el('div', { class: 'md-tabs-fallback' }));
      const bar = el('div', { class: 'md-tabs-bar', role: 'tablist' });
      const body = el('div', { class: 'md-tabs-body' });
      const btns: any[] = [];
      panes.forEach((p: any, idx: number) => {
        const btn = el('button', { class: 'md-tab-btn' + (idx === 0 ? ' active' : ''), type: 'button', role: 'tab',
          'aria-selected': idx === 0 ? 'true' : 'false', text: p.getAttribute('data-tab-label') || '탭 ' + (idx + 1) });
        btn.onclick = () => btns.forEach((b, k) => {
          const on = b === btn;
          b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
          (panes[k] as any).style.display = on ? '' : 'none';
        });
        btns.push(btn);
        if (idx > 0) p.style.display = 'none';
        bar.append(btn); body.append(p);
      });
      return el('div', { class: 'md-tabs' }, bar, body);
    }
    case 'tab': {
      const pane = el('div', { class: 'md-tabpane' });
      pane.setAttribute('data-tab-label', (summary || rest || '탭').trim());
      return moveChildren(inner(), pane);
    }
    case 'prompt': {
      // AI에게 실제로 시켜 볼 말 한 덩어리(#780 사용설명서) — 코드블록(명령어)과 구분되는 '대화 예시' 표면.
      return moveChildren(inner(), el('div', { class: 'md-prompt' }));
    }
    case 'button': case 'cta': {
      // 설명서 안의 실제 CTA 버튼(#879) — href 로 이동(예: 따라하기 투어 #/dashboard?tour=1), 라벨은 요약 텍스트.
      const a = el('a', { class: 'btn btn-primary md-cta', href: attrs.href || '#' });
      if (attrs.target) { a.setAttribute('target', attrs.target); a.setAttribute('rel', 'noopener'); }
      a.append(...renderInline(summary || rest || '열기'));
      return a;
    }
    case 'steps': {
      // 번호 매겨진 단계 흐름(#879) — 설치 가이드의 .step-list 와 같은 시각언어. 번호는 CSS 카운터.
      const box = el('div', { class: 'md-steps' });
      return moveChildren(inner(), box);
    }
    case 'step': {
      const item = el('div', { class: 'md-step' });
      item.append(el('div', { class: 'md-step-num', 'aria-hidden': 'true' }));
      const body = el('div', { class: 'md-step-body' });
      if (summary) body.append(el('div', { class: 'md-step-title' }, ...renderInline(summary)));
      item.append(moveChildren(inner(), body));
      return item;
    }
    case 'fields': {
      // 라벨-설명 나열(#879) — 번호 없는 단계(폼 필드 등). :::step 과 같은 행 구분선 시각언어.
      return moveChildren(inner(), el('div', { class: 'md-fields' }));
    }
    case 'field': {
      const item = el('div', { class: 'md-field' });
      if (summary) item.append(el('div', { class: 'md-field-name' }, ...renderInline(summary)));
      const body = el('div', { class: 'md-field-body' });
      item.append(moveChildren(inner(), body));
      return item;
    }
    case 'flow': {
      // 가로 흐름 다이어그램(#879) — 한 줄당 한 칩, 사이에 → 화살표. 본문 줄을 그대로 칩으로.
      const box = el('div', { class: 'md-flow' });
      const items = bodyLines.map((l) => l.trim()).filter((l) => l && l !== ':::');
      items.forEach((it, idx) => {
        if (idx) box.append(el('span', { class: 'md-flow-arrow', 'aria-hidden': 'true', text: '→' }));
        box.append(el('span', { class: 'md-flow-item' }, ...renderInline(it)));
      });
      return box;
    }
    case 'fig': {
      // 라벨 화살표 도식(#853) — 줄 = 체인 한 행, 토큰 구분 '|': 박스('제목 ~ 부제') 또는 화살표('-> 라벨').
      //  화살표 의미색(도메인맵 범례와 동일): ->ok 파랑 실선(일치·긍정) · ->viol 빨강 실선 · ->should 주황 점선
      //  · ->pend 회색 점선 · ->x 차단(✕). kind=fan 이면 마지막 줄 '=> 타깃 ~ 부제 ~ 공통 화살표 라벨'로
      //  위 줄들(소스 박스)이 전부 타깃 하나로 모인다. 캡션은 요약 텍스트(':::fig 캡션') 또는 caption= 속성.
      const figBox = (t: string) => {
        const [nm, sub] = t.split('~').map((s) => s.trim());
        const b0 = el('span', { class: 'md-fig-box' }, el('span', { class: 'md-fig-nm' }, ...renderInline(nm || '')));
        if (sub) b0.append(el('span', { class: 'md-fig-sub' }, ...renderInline(sub)));
        return b0;
      };
      const figArrow = (t: string) => {
        const m = /^->([a-z]*)\s*(.*)$/.exec(t.trim());
        const ak = (m && m[1]) || '';
        const lab = (m && m[2]) || '';
        const ar = el('span', { class: 'md-fig-ar' + (ak ? ' is-' + ak : '') });
        if (lab) ar.append(el('span', { class: 'md-fig-arlab' }, ...renderInline(lab)));
        ar.append(el('span', { class: 'md-fig-arline', 'aria-hidden': 'true' },
          el('span', { class: 'md-fig-arhead', text: ak === 'x' ? '✕' : '▸' })));
        return ar;
      };
      const figRows = bodyLines.map((l) => l.trim()).filter((l) => l && l !== ':::');
      const fig = el('figure', { class: 'md-fig' });
      if (attrs.kind === 'fan') {
        const fm = /^=>\s*(.*)$/.exec(figRows[figRows.length - 1] || '');
        const [tn, tsub, tlab] = ((fm && fm[1]) || '').split('~').map((s) => s.trim());
        const fanAr = el('span', { class: 'md-fig-ar is-fan' });
        if (tlab) fanAr.append(el('span', { class: 'md-fig-arlab' }, ...renderInline(tlab)));
        fanAr.append(el('span', { class: 'md-fig-arline', 'aria-hidden': 'true' }, el('span', { class: 'md-fig-arhead', text: '▸' })));
        fig.append(el('div', { class: 'md-fig-fan' },
          el('div', { class: 'md-fig-fansrcs' }, ...figRows.slice(0, -1).map((r) => figBox(r))),
          fanAr,
          figBox((tn || '') + (tsub ? ' ~ ' + tsub : ''))));
      } else {
        for (const r of figRows) {
          const row = el('div', { class: 'md-fig-row' });
          for (const tok of r.split('|').map((s) => s.trim()).filter(Boolean)) row.append(tok.startsWith('->') ? figArrow(tok) : figBox(tok));
          fig.append(row);
        }
      }
      if (attrs.caption || summary) fig.append(el('figcaption', { class: 'md-fig-cap' }, ...renderInline(attrs.caption ? String(attrs.caption).replace(/_/g, ' ') : summary)));
      return fig;
    }
    case 'wire': {
      // 미니 와이어프레임(#853) — 화면 배치 축소 모형. 줄 = 가로 행, '|' = 그 행의 컬럼 박스, '~' = 박스 부제,
      //  2칸 들여쓰기 = 직전 박스 '안'에 중첩, 'hl:' 접두 = 파랑 강조. 캡션은 요약 텍스트 또는 caption=.
      const wRows = bodyLines.filter((l) => l.trim() && l.trim() !== ':::');
      const frame = el('figure', { class: 'md-wire' });
      const wBox = (txt: string) => {
        let t = txt.trim();
        const hl = t.startsWith('hl:');
        if (hl) t = t.slice(3).trim();
        const [nm, sub] = t.split('~').map((s) => s.trim());
        const b0 = el('div', { class: 'md-wire-box' + (hl ? ' is-hl' : '') },
          el('div', { class: 'md-wire-nm' }, ...renderInline(nm || '')));
        if (sub) b0.append(el('div', { class: 'md-wire-sub' }, ...renderInline(sub)));
        return b0;
      };
      const stack: any[] = [frame];
      const levels: number[] = [-1];
      for (const raw of wRows) {
        const indent = (/^\s*/.exec(raw) || [''])[0].length;
        while (levels.length > 1 && indent <= levels[levels.length - 1]) { stack.pop(); levels.pop(); }
        const cols = raw.trim().split('|').map((s) => s.trim()).filter(Boolean);
        const row = el('div', { class: 'md-wire-row' + (cols.length > 1 ? ' is-cols' : '') });
        const boxes = cols.map(wBox);
        row.append(...boxes);
        stack[stack.length - 1].append(row);
        stack.push(boxes[boxes.length - 1]);   // 다음 줄이 더 들여쓰면 마지막 박스 안으로
        levels.push(indent);
      }
      if (attrs.caption || summary) frame.append(el('figcaption', { class: 'md-fig-cap' }, ...renderInline(attrs.caption ? String(attrs.caption).replace(/_/g, ' ') : summary)));
      return frame;
    }
    case 'shot': {
      // 주석 스크린샷 v2(#1107) — 쉬는 상태는 깨끗한 화면 + 파란 번호 마커만. 범례 항목이나 마커를
      //  짚으면(hover·focus·탭) 그 영역만 스포트라이트로 밝히고 나머지를 딤 처리한다 — 제품의
      //  둘러보기(guide-tour) 스포트라이트와 같은 시각언어, 색은 블루 단색(컬러 예산 §0.5).
      //  속성: src=이미지(필수) alt caption. 본문 = 구획 목록:
      //    좌표줄  'left% | top% | width% | height% | 제목 ~ 한 줄 설명'  (전부 이미지 기준 %)
      //    상세줄  그 아래 일반 줄들 = 그 번호의 추가 문단. 다음 좌표줄 전까지.
      //  클릭은 고정 토글(터치 대응) — 같은 항목을 다시 누르면 해제. 이미지는 데이터 마스킹된 정적 자산.
      const items: any[] = [];
      for (const raw of bodyLines) {
        const t = (raw || '').trim();
        if (!t || t === ':::') continue;
        // 요소줄(v3): '@ x% | y% | 이름 ~ 설명' — 직전 구역 안의 세부 요소(말풍선 콜아웃) 앵커.
        //  요소줄이 하나라도 있으면 그 shot 은 v3(구역 탭 + 콜아웃 패널)로 렌더된다. 없으면 v2 범례 그대로.
        if (t.startsWith('@') && items.length) {
          const parts = t.slice(1).split('|').map((s) => s.trim());
          const nmRaw = parts.slice(2).join(' | ');
          const cut = nmRaw.indexOf('~');   // 첫 물결표만 구분자 — 설명 안의 '①~④' 같은 표기를 살린다
          const name = (cut < 0 ? nmRaw : nmRaw.slice(0, cut)).trim();
          const desc = cut < 0 ? '' : nmRaw.slice(cut + 1).trim();
          items[items.length - 1].elems.push({ x: parseFloat(parts[0]), y: parseFloat(parts[1]), name: name || '', desc: desc || '' });
          continue;
        }
        const isCoord = /^[\d.]+\s*\|/.test(t) && t.split('|').length >= 5;
        if (isCoord) {
          const parts = t.split('|').map((s) => s.trim());
          const n = parts.map((c) => parseFloat(c));
          const titleRaw = parts.slice(4).join(' | ');
          const rc = titleRaw.indexOf('~');
          const title = (rc < 0 ? titleRaw : titleRaw.slice(0, rc)).trim();
          const sub = rc < 0 ? '' : titleRaw.slice(rc + 1).trim();
          items.push({ l: n[0], t: n[1], w: n[2], h: n[3], title, detail: sub ? [sub] : [], elems: [] });
        } else if (items.length) {
          items[items.length - 1].detail.push(t);
        }
      }
      const hasElems = items.some((s0) => s0.elems.length > 0);
      const stage = el('div', { class: 'md-shot-stage' },
        el('img', { class: 'md-shot-img', src: attrs.src || '', alt: attrs.alt || '화면 스크린샷', loading: 'lazy' }));
      const fig = el('figure', { class: 'md-shot' }, stage);
      const hits: any[] = [], marks: any[] = [], rows: any[] = [];
      // 스포트라이트 구멍은 하나(v2.2) — 구역을 오가면 딤은 유지된 채 구멍이 미끄러진다(꺼졌다 켜지는
      //  번쩍임 제거). 진입은 짧은 머뭇(의도 판정) 뒤에 켜고, 이탈은 유예를 두고 끈다 — 마우스가 스쳐
      //  지나가거나 구역 사이 틈을 건널 때 딤이 펄럭이지 않게.
      const hl = el('span', { class: 'md-shot-hl', 'aria-hidden': 'true' });
      let sticky = -1;   // v2: 클릭 고정된 항목(없으면 -1). v3: 현재 선택된 구역 탭(항상 ≥0)
      let active = -1;
      let selectTab: ((i: number) => void) | null = null;   // v3 에서만 할당 — wire 의 클릭이 여기로 온다
      let pend: any = 0, clr: any = 0;
      const place = (s0: any) => { hl.style.left = s0.l + '%'; hl.style.top = s0.t + '%';
        hl.style.width = s0.w + '%'; hl.style.height = s0.h + '%'; };
      const setOn = (i: number) => {   // 즉시 적용 — 시연·클릭 고정용. hover 는 아래 enter/leave 타이머를 거친다
        clearTimeout(pend); clearTimeout(clr); pend = clr = 0;
        const ok = i >= 0 && items[i] && Number.isFinite(items[i].l);
        if (ok) {
          if (active < 0) { hl.style.transition = 'none'; place(items[i]); void hl.offsetWidth; hl.style.transition = ''; }
          else place(items[i]);   // 켜진 채 이동 → CSS 가 구멍을 미끄러뜨린다
        }
        hl.classList.toggle('is-on', ok);
        active = ok ? i : -1;
        stage.classList.toggle('has-on', ok);
        marks.forEach((m, k) => m.classList.toggle('is-on', k === active));
        rows.forEach((r, k) => r.classList.toggle('is-on', k === active));
      };
      const enter = (i: number) => {
        if (sticky >= 0 && !hasElems) return;              // v2 고정 중엔 hover 무시. v3 는 고정(탭) 위로 미리보기 허용
        clearTimeout(clr); clr = 0;                        // 유예 중 재진입 — 딤을 끊지 않는다
        if (active === i) { clearTimeout(pend); pend = 0; return; }
        clearTimeout(pend);
        pend = setTimeout(() => setOn(i), active >= 0 ? 60 : 130);   // 첫 점등은 머뭇, 이동은 빠르게
      };
      const leave = () => {
        if (sticky >= 0 && !hasElems) return;
        clearTimeout(pend); pend = 0;
        clearTimeout(clr);
        clr = setTimeout(() => setOn(hasElems ? sticky : -1), 200);  // v3: 손을 떼면 선택된 탭 구역으로 복귀
      };
      const toggle = (i: number) => { sticky = sticky === i ? -1 : i; setOn(sticky); };
      const wire = (i: number) => ({ onmouseenter: () => enter(i), onmouseleave: leave,
        onclick: () => { if (hasElems && selectTab) selectTab(i); else toggle(i); },
        onfocus: () => enter(i), onblur: leave });
      items.forEach((s0, i) => {
        if (![s0.l, s0.t, s0.w, s0.h].every((v) => Number.isFinite(v))) return;
        // 구역 자체가 포인터 표적(#1107 v2) — 보이지 않는 히트 영역으로 이미지 위 직접 탐색·탭을 받는다.
        //  키보드·스크린리더 동선은 범례 버튼이 전담하므로 여긴 aria-hidden 포인터 전용으로 둔다.
        hits.push(el('span', { class: 'md-shot-hit', 'aria-hidden': 'true',
          style: `left:${s0.l}%; top:${s0.t}%; width:${s0.w}%; height:${s0.h}%`, ...wire(i) }));
        // 마커는 영역 좌상단 모서리에 걸친다 — 이미지 가장자리에 붙은 영역은 잘리지 않게 살짝 안쪽으로.
        marks.push(el('button', { type: 'button', class: 'md-shot-marker', text: String(i + 1),
          'aria-label': (i + 1) + '. ' + (s0.title || ''), style: `left:${Math.max(s0.l, 1.1)}%; top:${Math.max(s0.t, 1.6)}%`,
          ...wire(i) }));
      });
      stage.append(...hits, hl, ...marks);
      if (attrs.caption || summary) fig.append(el('figcaption', { class: 'md-shot-cap' },
        el('span', { class: 'md-shot-capt' }, ...renderInline(attrs.caption ? String(attrs.caption).replace(/_/g, ' ') : summary)),
        items.length ? el('span', { class: 'md-shot-hint', 'aria-hidden': 'true',
          text: hasElems ? '아래 탭이나 화면 위 번호를 눌러 구역을 하나씩 살펴보세요' : '화면이나 항목을 짚으면 그 영역만 밝혀집니다' }) : null));
      // 범례 — 번호와 1:1 로 묶인 부품 목록(2열 그리드). 짚으면 위 화면의 해당 영역이 밝혀진다.
      //  v3(요소줄 있음)에선 범례 대신 아래 구역 탭 + 콜아웃 패널이 그 역할을 맡는다.
      if (items.length && !hasElems) {
        fig.append(el('div', { class: 'md-shot-legend' }, ...items.map((s0, i) => {
          const body = el('span', { class: 'md-shot-pbody' },
            el('span', { class: 'md-shot-ptitle' }, ...renderInline(s0.title || '')));
          for (const d of s0.detail) if (d) body.append(el('span', { class: 'md-shot-pdesc' }, ...renderInline(d)));
          const r = el('button', { type: 'button', class: 'md-shot-part', ...wire(i) },
            el('span', { class: 'md-shot-pnum', 'aria-hidden': 'true', text: String(i + 1) }), body);
          rows.push(r);
          return r;
        })));
      }
      // 첫 만남 시연(#1107 v2) — 데스크톱 쉬는 상태는 마커까지 숨긴 완전한 화면이라, '짚으면 밝아진다'는
      //  대응을 처음 한 번은 보여줘야 한다: 이 라우트에서 처음 화면에 들어온 shot 하나만 마커를 띄우고
      //  1번 구역을 잠깐 밝혔다 놓는다. 사용자가 만지기 시작하면 즉시 중단, 모션 축소 설정이면 생략
      //  (그땐 마커·범례 숫자가 상시 대응을 대신한다 — 아래 CSS reduced-motion 참조).
      if (items.length && !hasElems && typeof IntersectionObserver !== 'undefined'
          && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const io = new IntersectionObserver((es) => {
          if (!es.some((e0) => e0.isIntersecting)) return;
          io.disconnect();
          if (shotDemoRoute === location.hash || sticky >= 0) return;
          shotDemoRoute = location.hash;
          const timers = [
            setTimeout(() => { if (sticky < 0) setOn(0); }, 380),
            setTimeout(() => { if (sticky < 0) setOn(-1); }, 1550),
            setTimeout(() => stage.classList.remove('is-demo'), 1950),
          ];
          const cancelDemo = () => { timers.forEach(clearTimeout); stage.classList.remove('is-demo'); if (sticky < 0) setOn(-1); };
          stage.classList.add('is-demo');
          fig.addEventListener('pointerenter', cancelDemo, { once: true });
          fig.addEventListener('pointerdown', cancelDemo, { once: true });
        }, { threshold: 0.3 });
        io.observe(stage);
      }
      // ── v3(#1107) 구역 탭 + 콜아웃 패널 — 요소줄이 있는 shot 만. 위 화면은 지도(스포트라이트 유지),
      //  아래 패널은 선택한 구역의 확대 크롭 + 말풍선이다. 크롭은 같은 스크린샷을 background-position 으로
      //  오려내 추가 자산이 없고, 말풍선은 절대배치가 아니라 일반 플로우(행/열)라 서로 겹칠 수 없다.
      //  안내선(SVG)은 레이아웃이 잡힌 뒤 실측 좌표로 말풍선과 화면 속 지점을 잇는다.
      if (hasElems) {
        fig.classList.add('md-shot--x');
        const img0 = stage.querySelector('img') as HTMLImageElement;
        const tabBtns: any[] = [];
        const panel = el('section', { class: 'md-shotx-panel', role: 'tabpanel' });
        let ro: any = null;
        const renderPanel = (i: number) => {
          if (ro) { ro.disconnect(); ro = null; }
          panel.textContent = '';
          const s0 = items[i];
          if (!s0) return;
          if (s0.detail.length) {
            const lead = el('p', { class: 'md-shotx-lead' });
            s0.detail.forEach((d: string, k: number) => { if (d) { if (k) lead.append(' '); lead.append(...renderInline(d)); } });
            panel.append(lead);
          }
          const iw = (img0 && img0.naturalWidth) || 1440, ih = (img0 && img0.naturalHeight) || 900;
          const imgAspect = iw / ih;
          // 크롭 사각형 — 구역 rect 에 약간의 프레이밍 여백(이미지 가장자리는 클램프)
          const px = 0.6, py = px * imgAspect;
          const l2 = Math.max(0, s0.l - px), t2 = Math.max(0, s0.t - py);
          const w2 = Math.min(100, s0.l + s0.w + px) - l2;
          let h2 = Math.min(100, s0.t + s0.h + py) - t2;
          let t2b = t2;
          // 아주 홀쭉한 구역(사이드바 등)은 통째로 오리면 글씨가 안 보일 만큼 작아진다 —
          //  짚는 지점들이 담기는 만큼만 세로로 잘라 확대 배율을 지킨다(구역 표시 자체는 원래 크기 그대로).
          if ((w2 / h2) * imgAspect < 0.5 && s0.elems.length) {
            const need = (w2 * imgAspect) / 0.5;                 // 가로세로비 0.5 를 만드는 높이
            const ys = s0.elems.map((e0: any) => e0.y);
            const mid = (Math.min(...ys) + Math.max(...ys)) / 2;
            const span = Math.max(need, Math.max(...ys) - Math.min(...ys) + 2 * py);
            t2b = Math.min(Math.max(t2, mid - span / 2), t2 + h2 - Math.min(span, h2));
            h2 = Math.min(span, h2);
          }
          const cropAspect = (w2 / h2) * imgAspect;
          const wideLayout = cropAspect >= 1.55;   // 가로형 → 말풍선 위/아래 행, 세로형 → 크롭 왼쪽 + 말풍선 오른쪽 열
          const crop = el('div', { class: 'md-shotx-crop', 'aria-hidden': 'true',
            style: `aspect-ratio:${(w2 * imgAspect).toFixed(3)} / ${h2.toFixed(3)};`
              + `background-image:url('${attrs.src || ''}');`
              + `background-size:${(10000 / w2).toFixed(2)}% ${(10000 / h2).toFixed(2)}%;`
              + `background-position:${w2 >= 100 ? 0 : (l2 / (100 - w2) * 100).toFixed(2)}% ${h2 >= 100 ? 0 : (t2b / (100 - h2) * 100).toFixed(2)}%` });
          const pairs: any[] = [];
          const mkPair = (e0: any) => {
            const d0 = el('span', { class: 'md-shotx-dot',
              style: `left:${((e0.x - l2) / w2 * 100).toFixed(2)}%; top:${((e0.y - t2b) / h2 * 100).toFixed(2)}%` });
            const b0 = el('div', { class: 'md-shotx-bl' },
              el('span', { class: 'md-shotx-bn', 'aria-hidden': 'true' }),
              el('span', { class: 'md-shotx-bt' }, ...renderInline(e0.name)),
              e0.desc ? el('span', { class: 'md-shotx-bd' }, ...renderInline(e0.desc)) : null);
            crop.append(d0);
            pairs.push({ b0, d0, e0, line: null });
            return b0;
          };
          // 말풍선 자리 = 짚는 지점을 따라간다(교차·엇갈림 방지). 가로형은 지점이 위 절반이면 위 행,
          //  아래 절반이면 아래 행 — 가까운 변으로 나간다. 아주 납작한 스트립은 위/아래 교대로 균형을 잡는다.
          const rel = (e0: any) => ({ rx: (e0.x - l2) / w2, ry: (e0.y - t2b) / h2 });
          const elems = s0.elems.slice().sort((a: any, b1: any) => (wideLayout ? a.x - b1.x : a.y - b1.y));
          const body = el('div', { class: 'md-shotx-body ' + (wideLayout ? 'is-wide' : 'is-tall') });
          const groups: { box: any; list: any[]; side: string }[] = [];
          if (wideLayout) {
            const thin = cropAspect > 4;
            const top: any[] = [], bot: any[] = [];
            elems.forEach((e0: any, k: number) => ((thin ? k % 2 === 0 : rel(e0).ry < 0.5) ? top : bot).push(e0));
            // 한 행에 너무 몰리면(4개 이상) 가운데에 가까운 것부터 반대 행으로 넘긴다 — 말풍선이 잘게 쪼개지지 않게.
            const spill = (from: any[], to: any[], toTop: boolean) => {
              while (from.length > 3) {
                from.sort((a: any, b1: any) => (toTop ? rel(a).ry - rel(b1).ry : rel(b1).ry - rel(a).ry));
                to.push(from.pop());
              }
            };
            spill(top, bot, false); spill(bot, top, true);
            top.sort((a: any, b1: any) => a.x - b1.x); bot.sort((a: any, b1: any) => a.x - b1.x);
            const mkRow = (list: any[], side: string) => {
              const box = el('div', { class: 'md-shotx-row is-' + side }, ...list.map(mkPair));
              groups.push({ box, list, side });
              return box;
            };
            if (top.length) body.append(mkRow(top, 'top'));
            body.append(crop);
            if (bot.length) body.append(mkRow(bot, 'bot'));
          } else {
            const box = el('div', { class: 'md-shotx-col' }, ...elems.map(mkPair));
            groups.push({ box, list: elems, side: 'right' });
            body.append(crop, box);
          }
          const NS = 'http://www.w3.org/2000/svg';
          const net = document.createElementNS(NS, 'svg');
          net.setAttribute('class', 'md-shotx-net');
          net.setAttribute('aria-hidden', 'true');
          body.append(net);
          panel.append(body);
          // 말풍선 ↔ 지점 짝 강조 — 어느 쪽을 짚어도 둘 다 밝아진다
          pairs.forEach((p0) => {
            const hot = (on: boolean) => () => { p0.b0.classList.toggle('is-hot', on); p0.d0.classList.toggle('is-hot', on);
              if (p0.line) p0.line.classList.toggle('is-hot', on); };
            p0.b0.onmouseenter = hot(true); p0.b0.onmouseleave = hot(false);
            p0.d0.onmouseenter = hot(true); p0.d0.onmouseleave = hot(false);
          });
          // 1차원 자리잡기 — 원하는 위치(짚는 지점)에 최대한 붙이되 서로 겹치지 않게 밀어낸다.
          const spread = (arr: { want: number; size: number; pos: number }[], min: number, max: number, gap: number) => {
            arr.sort((a, b1) => a.want - b1.want);
            let cur = min;                       // ① 앞에서부터 — 원하는 자리, 겹치면 뒤로 민다
            for (const it of arr) { it.pos = Math.max(it.want - it.size / 2, cur); cur = it.pos + it.size + gap; }
            cur = max;                           // ② 뒤에서부터 — 끝을 넘긴 만큼 되민다(칸에 다 들어가게)
            for (let i = arr.length - 1; i >= 0; i--) { arr[i].pos = Math.min(arr[i].pos, cur - arr[i].size); cur = arr[i].pos - gap; }
          };
          const GAP = 12;
          const place = () => {
            const bw = body.clientWidth;
            if (!bw) return;
            for (const g of groups) {
              const gr = g.box.getBoundingClientRect();
              if (g.side === 'right') {   // 세로형 — 오른쪽 열, 지점의 높이를 따라 배치
                const arr = g.list.map((e0: any) => {
                  const b0 = pairs.find((p1: any) => p1.e0 === e0).b0;
                  return { b0, want: rel(e0).ry * crop.offsetHeight, size: 0, pos: 0 };
                });
                arr.forEach((it) => { it.size = it.b0.offsetHeight; });
                const need = arr.reduce((a, it) => a + it.size, 0) + GAP * (arr.length - 1);
                const H = Math.max(crop.offsetHeight, need);
                g.box.style.height = H + 'px';
                spread(arr as any, 0, H, GAP);
                arr.forEach((it) => { it.b0.style.top = it.pos + 'px'; });
              } else {                    // 가로형 — 행 안에서 지점의 x 를 따라 배치
                const n0 = g.list.length;
                const w = Math.max(150, Math.min(320, (gr.width - GAP * (n0 - 1)) / n0));
                const arr = g.list.map((e0: any) => {
                  const b0 = pairs.find((p1: any) => p1.e0 === e0).b0;
                  b0.style.width = w + 'px';
                  return { b0, want: rel(e0).rx * crop.offsetWidth + (crop.getBoundingClientRect().left - gr.left), size: w, pos: 0 };
                });
                let h = 0;
                arr.forEach((it) => { h = Math.max(h, it.b0.offsetHeight); });
                g.box.style.height = h + 'px';
                spread(arr as any, 0, gr.width, GAP);
                arr.forEach((it) => { it.b0.style.left = it.pos + 'px';
                  it.b0.style.top = (g.side === 'top' ? h - it.b0.offsetHeight : 0) + 'px'; });
              }
            }
          };
          // 안내선 — 이미지 안에서는 한 방향(가로형=세로선 / 세로형=가로선)으로만 뻗고, 꺾임은 이미지 밖
          //  여백(도랑)에서 처리한다. 도랑 높이·깊이를 항목마다 조금씩 어긋내 선끼리 겹치지 않는다.
          const poly = (pts: number[][], r: number) => {
            const p1 = pts.filter((pt, k) => !k || Math.abs(pt[0] - pts[k - 1][0]) > 0.5 || Math.abs(pt[1] - pts[k - 1][1]) > 0.5);
            if (p1.length < 2) return '';
            let d = `M ${p1[0][0].toFixed(1)} ${p1[0][1].toFixed(1)}`;
            for (let k = 1; k < p1.length - 1; k++) {
              const [ax, ay] = p1[k - 1], [cx, cy] = p1[k], [nx, ny] = p1[k + 1];
              const d1 = Math.hypot(cx - ax, cy - ay), d2 = Math.hypot(nx - cx, ny - cy);
              const rr = Math.min(r, d1 / 2, d2 / 2);
              d += ` L ${(cx + (ax - cx) / d1 * rr).toFixed(1)} ${(cy + (ay - cy) / d1 * rr).toFixed(1)}`
                + ` Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${(cx + (nx - cx) / d2 * rr).toFixed(1)} ${(cy + (ny - cy) / d2 * rr).toFixed(1)}`;
            }
            const last = p1[p1.length - 1];
            return d + ` L ${last[0].toFixed(1)} ${last[1].toFixed(1)}`;
          };
          const draw = () => {
            const bb = body.getBoundingClientRect();
            if (!bb.width) return;
            net.setAttribute('viewBox', `0 0 ${bb.width} ${bb.height}`);
            net.textContent = '';
            const cr = crop.getBoundingClientRect();
            for (const g of groups) {
              g.list.forEach((e0: any, k: number) => {
                const p0 = pairs.find((p1: any) => p1.e0 === e0);
                if (!p0) return;
                const br = p0.b0.getBoundingClientRect(), dr = p0.d0.getBoundingClientRect();
                const dx2 = dr.left + dr.width / 2 - bb.left, dy2 = dr.top + dr.height / 2 - bb.top;
                const stag = 9 + (k % 3) * 7;   // 도랑 어긋내기 — 나란한 선이 겹쳐 한 줄로 보이지 않게
                let pts: number[][];
                if (g.side === 'right') {
                  const gx = cr.right - bb.left + stag;
                  const by = Math.min(Math.max(dy2, br.top - bb.top + 14), br.bottom - bb.top - 14);
                  pts = [[dx2, dy2], [gx, dy2], [gx, by], [br.left - bb.left, by]];
                } else {
                  const top = g.side === 'top';
                  const gy = (top ? br.bottom - bb.top + stag : br.top - bb.top - stag);
                  const bx = Math.min(Math.max(dx2, br.left - bb.left + 20), br.right - bb.left - 20);
                  pts = [[dx2, dy2], [dx2, gy], [bx, gy], [bx, top ? br.bottom - bb.top : br.top - bb.top]];
                }
                const path = document.createElementNS(NS, 'path');
                path.setAttribute('d', poly(pts, 7));
                path.setAttribute('class', 'md-shotx-line');
                net.append(path);
                p0.line = path;
              });
            }
          };
          let lastW = 0, raf = 0;
          const relayout = (force: boolean) => {
            const w = body.clientWidth;
            if (!force && w === lastW) return;
            lastW = w; place(); draw();
          };
          requestAnimationFrame(() => relayout(true));
          if (typeof ResizeObserver !== 'undefined') {
            ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => relayout(false)); });
            ro.observe(body);
          }
        };
        const tabs = el('nav', { class: 'md-shotx-tabs', role: 'tablist', 'aria-label': '화면 구역' });
        items.forEach((s0, i) => {
          const b0 = el('button', { type: 'button', class: 'md-shotx-tab', role: 'tab', 'aria-selected': 'false',
            onclick: () => { if (selectTab) selectTab(i); } },
            el('span', { class: 'md-shotx-tno', 'aria-hidden': 'true', text: String(i + 1) }),
            el('span', { class: 'md-shotx-tlab', text: s0.title || '' }));
          tabBtns.push(b0);
          tabs.append(b0);
        });
        selectTab = (i: number) => {
          sticky = i;
          setOn(i);
          tabBtns.forEach((b0, k) => { b0.classList.toggle('is-on', k === i); b0.setAttribute('aria-selected', k === i ? 'true' : 'false'); });
          renderPanel(i);
        };
        fig.append(tabs, panel);
        if (img0 && !img0.complete) img0.addEventListener('load', () => { if (selectTab) selectTab(sticky); }, { once: true });
        selectTab(0);
      }
      return fig;
    }
    case 'axes': {
      // 맥락의 두 축(#1035) — [지식(정적) ⇄ 프로젝트(동적)] 두 박스, 가운데 양방향 화살표의 이름이 곧
      //  '필요 지식(꺼내 씀)'과 '산출 지식(새로 남김)' — 필요/산출이 별도 요소가 아니라 흐름의 이름임을 그림이 말한다.
      //  카테고리는 맥락의 축이 아니라 이 둘을 담는 분류라 도식에서 뺐다(본문 '번외' 박스로 설명).
      //  본문 2줄 `이모지 | 이름 | 부제`(지식/프로젝트 순).
      const rows = bodyLines.map((l) => l.trim()).filter((l) => l && l !== ':::').map((l) => l.split('|').map((s) => s.trim()));
      const kn = rows[0] || [], pj = rows[1] || [];
      const fnode = (ic, nm, sub, cls) => el('div', { class: 'md-axes-fnode ' + cls },
        el('span', { class: 'md-axes-ic', 'aria-hidden': 'true', text: ic }),
        el('span', { class: 'md-axes-nm' }, ...renderInline(nm)),
        el('span', { class: 'md-axes-sub' }, ...renderInline(sub)));
      const biflow = el('div', { class: 'md-axes-biflow' },
        el('span', { class: 'md-axes-bi' },
          el('span', { class: 'md-axes-bilab', text: '필요 지식으로 꺼내 씀' }),
          el('span', { class: 'md-axes-biar to-r', 'aria-hidden': 'true', text: '⟶' })),
        el('span', { class: 'md-axes-bi' },
          el('span', { class: 'md-axes-biar to-l', 'aria-hidden': 'true', text: '⟵' }),
          el('span', { class: 'md-axes-bilab', text: '산출 지식으로 새로 남김' })));
      return el('figure', { class: 'md-axes', role: 'group', 'aria-label': '맥락의 두 축' },
        el('div', { class: 'md-axes-flow' },
          fnode(kn[0] || '📄', kn[1] || '지식', kn[2] || '정적 · 이미 정해진 것', 'is-static is-stack'),
          biflow,
          fnode(pj[0] || '🔄', pj[1] || '프로젝트', pj[2] || '동적 · 지금 바꾸는 것', 'is-dynamic')));
    }
    case 'synced': {
      const box = el('div', { class: 'md-synced' });
      box.append(el('span', { class: 'md-block-chip', text: '↻ 동기화 블록' }));
      if (attrs.missing === 'true') {
        box.append(el('div', { class: 'md-synced-missing', text: '원본 블록이 공유 범위 밖이라 내용을 가져올 수 없습니다.' }));
      } else {
        box.append(moveChildren(inner(), el('div', { class: 'md-synced-body' })));
      }
      return box;
    }
    case 'toc':
      return el('div', { class: 'md-block-chip md-toc', text: '목차 (원본 문서의 목차 블록)' });
    case 'collection':   // #657w 라이브 컬렉션 — 카테고리/유형 조건의 지식 목록을 렌더 시점에 조회(노션 linked DB view 등가)
      return renderCollection(attrs);
    case 'unsupported':
      return el('div', { class: 'md-block-chip md-unsup', title: attrs.id ? 'block ' + attrs.id : '',
        text: '지원되지 않는 블록' + (attrs.type ? ': ' + attrs.type : '') });
    default:
      return inner(); // 미지 컨테이너 — 내용만(마커 무시)
  }
}

// ── #657w 컬렉션 블록 — `:::collection category=<key> type=<t> limit=<n> view=list|cards sort=updated|title` ──
//  대문/문서 어디서든 살아있는 지식 목록을 임베드(위키의 linked database view). 자가 하이드레이션(api) —
//  렌더러는 즉시 자리를 만들고 비동기로 채운다. 실패/빈 결과는 조용한 안내문(graceful).
let mdCatMapP: Promise<Map<string, string>> | null = null;   // category key → id (목록 API 는 id 를 받는다)
function mdCategoryMap(): Promise<Map<string, string>> {
  if (!mdCatMapP) {
    mdCatMapP = api('/api/ui/categories')
      .then((d) => { const m = new Map<string, string>(); for (const c of (d && d.categories) || []) m.set(String(c.key), String(c.id)); return m; })
      .catch(() => { mdCatMapP = null; return new Map<string, string>(); });
  }
  return mdCatMapP;
}
function renderCollection(attrs: any) {
  const view = attrs.view === 'cards' ? 'cards' : 'list';
  const box = el('div', { class: 'md-collection md-collection-' + view });
  box.append(el('div', { class: 'md-coll-note', text: '목록 불러오는 중…' }));
  (async () => {
    try {
      const limit = Math.min(Math.max(Number(attrs.limit) || 5, 1), 12);
      const p = new URLSearchParams({ limit: String(limit + 4), injection: 'recalled',
        orderBy: attrs.sort === 'title' ? 'name' : 'updated_at' });
      if (attrs.category) {
        const id = (await mdCategoryMap()).get(String(attrs.category));
        if (id) p.set('category', id);
      }
      if (attrs.type) p.set('type', String(attrs.type));
      const r = await api('/api/ui/knowledge?' + p.toString());
      const entries = (((r && r.entries) || []) as any[])
        .filter((e) => !String(e.name || '').startsWith('category-home-') && !e.is_folder)
        .slice(0, limit);
      if (!entries.length) { box.replaceChildren(el('div', { class: 'md-coll-note', text: '조건에 맞는 문서가 아직 없습니다.' })); return; }
      box.replaceChildren(...entries.map((e) => el('a', {
        class: view === 'cards' ? 'md-coll-card' : 'md-coll-row',
        href: '#/k/' + encodeURIComponent(e.name) },
        el('span', { class: 'md-coll-ic', 'aria-hidden': 'true', text: e.icon || '📄' }),
        el('span', { class: 'md-coll-title', text: e.title || e.name }),
        el('span', { class: 'md-coll-time', text: relTime(e.updated_at) }))));
    } catch (_) {
      box.replaceChildren(el('div', { class: 'md-coll-note', text: '목록을 불러오지 못했습니다.' }));
    }
  })();
  return box;
}

// #657w 페이지 카드 — '내부 링크(#/k/…) 하나가 전부인 줄' = 문서 카드로 승격(노션 페이지 멘션/스마트 링크).
//  순수 markdown 링크라 어떤 소비자(에이전트·타 렌더러)에게도 평범한 링크로 안전 강등된다.
const MD_PAGECARD_RE = /^\s*\[([^\]\n]+)\]\((#\/k\/[^)\s]+)\)\s*$/;
function mdPageCard(label: string, href: string) {
  return el('a', { class: 'md-pagecard', href },
    el('span', { class: 'md-pagecard-ic', 'aria-hidden': 'true', text: '📄' }),
    el('span', { class: 'md-pagecard-title', text: label }),
    el('span', { class: 'md-pagecard-arrow', 'aria-hidden': 'true', text: '↗' }));
}

// 블록 파서 — 줄 단위로 블록을 구성한다. 모든 텍스트는 renderInline 경유(textContent).
function renderMarkdown(md, opts?: any) {
  const _prevChips = MD_UI_CHIPS;                       // #1013 docs UI 칩 모드 — 재진입(중첩 컨테이너) 안전하게 저장/복원
  if (opts && typeof opts === 'object' && 'uiChips' in opts) MD_UI_CHIPS = !!opts.uiChips;
  const root = el('div', { class: 'md' });
  const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
  let i = 0;

  const contOpen = (l) => /^:::\s*[a-zA-Z_-]/.test(l);
  const contClose = (l) => l.trim() === ':::';

  while (i < lines.length) {
    let line = lines[i];

    // 빈 줄 — 스킵.
    if (line.trim() === '') { i++; continue; }

    // ::: 컨테이너(#551) — 중첩 깊이 추적으로 매칭 닫힘까지 수집.
    const cont = /^:::\s*([a-zA-Z_-]+)\s*(.*)$/.exec(line);
    if (cont) {
      const body: any[] = [];
      let depth = 1;
      let inFence = false; // 코드펜스 안의 ':::' 줄은 컨테이너 문법이 아님(depth 오염 방지)
      i++;
      while (i < lines.length && depth > 0) {
        const l = lines[i];
        if (/^(```|~~~)/.test(l)) inFence = !inFence;
        else if (!inFence && contOpen(l)) depth++;
        else if (!inFence && contClose(l)) { depth--; if (depth === 0) { i++; break; } }
        body.push(l);
        i++;
      }
      root.append(renderContainer(cont[1], cont[2], body));
      continue;
    }
    if (contClose(line)) { i++; continue; } // 고아 닫힘 마커 — 무시(안전)

    // 수식 블록 $$ … $$ (#551) — LaTeX 원문을 수식 스타일 프리로. 닫힘이 없으면 평문 단락(문서 통째 삼킴 방지).
    if (line.trim() === '$$') {
      let close = -1;
      for (let j = i + 1; j < lines.length; j++) { if (lines[j].trim() === '$$') { close = j; break; } }
      if (close >= 0) {
        root.append(el('pre', { class: 'md-eq', title: 'LaTeX' }, el('code', { text: lines.slice(i + 1, close).join('\n') })));
        i = close + 1;
        continue;
      }
      root.append(el('p', { class: 'md-p', text: '$$' }));
      i++;
      continue;
    }

    // 코드블록 ``` ... ```
    const fence = /^(```|~~~)(.*)$/.exec(line);
    if (fence) {
      const marker = fence[1];
      const code: any[] = [];
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
      const quote: any[] = [];
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
    if (line.indexOf('|') >= 0 && i + 1 < lines.length && isMdTableSep(lines[i + 1])) {
      const header = mdTableSplitRow(line);
      i += 2; // 헤더 + 구분행 소비
      const rows: any[] = [];
      while (i < lines.length && lines[i].trim() !== '' && lines[i].indexOf('|') >= 0) {
        rows.push(mdTableSplitRow(lines[i]));
        i++;
      }
      const headerEmpty = header.every((c) => !c);
      const table = el('table', { class: 'md-table' });
      if (!headerEmpty) { // 노션 '열 헤더 없는 표'는 빈 헤더행으로 옴 — thead 생략(#551)
        const thead = el('thead');
        const htr = el('tr');
        for (const c of header) htr.append(el('th', {}, ...renderInline(c)));
        thead.append(htr);
        table.append(thead);
      }
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

    // 리스트 — 순서/비순서 + 체크박스(- [ ]) + 들여쓰기(2칸/단) 중첩(#551). 연속 리스트 줄을 모아 트리로 조립.
    const bulletRe = /^(\s*)([-*+])\s+(.*)$/;
    const orderedRe = /^(\s*)(\d+)[.)]\s+(.*)$/;
    if (bulletRe.test(line) || orderedRe.test(line)) {
      const items: any[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const bm = bulletRe.exec(l);
        const om = bm ? null : orderedRe.exec(l);
        if (bm || om) {
          const m: any = bm || om;
          const level = Math.floor(m[1].replace(/\t/g, '  ').length / 2);
          let text = m[3];
          let checked: any = null;
          if (bm) {
            const cb = /^\[( |x|X)\]\s+(.*)$/.exec(text);
            if (cb) { checked = cb[1] !== ' '; text = cb[2]; }
          }
          items.push({ level, ordered: !!om, num: om ? Number(om[2]) : 0, checked, text });
          i++;
          continue;
        }
        // 이어지는(들여쓴, 마커 없는) 줄은 직전 항목 텍스트에 합류.
        if (l.trim() !== '' && /^\s+/.test(l) && items.length) {
          items[items.length - 1].text += ' ' + l.trim();
          i++;
          continue;
        }
        break;
      }
      // 레벨 트리 조립 — 같은 레벨·같은 종류(ol/ul) 연속을 한 리스트로, 더 깊은 항목은 직전 li 아래로.
      const build = (idx, level) => {
        const first = items[idx];
        const listTag = first.ordered ? 'ol' : 'ul';
        const list = el(listTag, { class: 'md-list' });
        if (first.ordered && first.num > 1) list.setAttribute('start', String(first.num));
        let j = idx;
        while (j < items.length && items[j].level >= level) {
          if (items[j].level > level) {
            const sub = build(j, items[j].level);
            (list.lastChild || list).append(sub.node);
            j = sub.next;
            continue;
          }
          if (items[j].ordered !== first.ordered) break; // 같은 레벨에서 종류 전환 → 새 리스트
          const it = items[j];
          const li = el('li', {});
          if (it.checked != null) {
            const cb: any = el('input', { type: 'checkbox', class: 'md-check', disabled: '', tabindex: '-1', 'aria-hidden': 'true' });
            cb.checked = it.checked;
            li.classList.add('md-task');
            if (it.checked) li.classList.add('md-task-done');
            li.append(cb);
          }
          for (const n of renderInline(it.text)) li.append(n);
          list.append(li);
          j++;
        }
        return { node: list, next: j };
      };
      let idx = 0;
      while (idx < items.length) {
        const r = build(idx, items[idx].level);
        root.append(r.node);
        idx = r.next;
      }
      continue;
    }

    // 단락 — 빈 줄/블록 경계 전까지 모은다. 줄바꿈은 <br> 로 보존.
    const para: any[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') break;
      // 다음 블록 시작이면 단락 종료.
      if (/^(#{1,6})\s+/.test(l) || /^(```|~~~)/.test(l) || /^\s*>\s?/.test(l) ||
          /^(-{3,}|\*{3,}|_{3,})\s*$/.test(l) || /^(\s*)([-*+])\s+/.test(l) ||
          /^(\s*)(\d+)[.)]\s+/.test(l) || contOpen(l) || contClose(l) || l.trim() === '$$' ||
          (l.indexOf('|') >= 0 && lines[i + 1] != null && isMdTableSep(lines[i + 1]))) break;
      para.push(l);
      i++;
    }
    // #657w 페이지 카드 승격 — 문단 안에서 '내부 링크뿐인 줄'은 카드로, 나머지 줄은 문단으로(줄 단위 분할).
    let curP: any = null;
    const flushP = () => { if (curP) { root.append(curP); curP = null; } };
    for (const l of para) {
      const pc = MD_PAGECARD_RE.exec(l);
      if (pc) { flushP(); root.append(mdPageCard(pc[1], pc[2])); continue; }
      if (!curP) curP = el('p', { class: 'md-p' });
      else curP.append(el('br'));
      for (const n of renderInline(l)) curP.append(n);
    }
    flushP();
  }
  MD_UI_CHIPS = _prevChips;                             // #1013 복원 — 중첩 렌더는 상속(true 유지), 최상위 docs 호출만 false 로 되돌림
  return root;
}

// 공개 표면은 적출 전 core.ts 가 내보내던 4개 그대로 — mdImage·mdPageCard·renderContainer·mdCategoryMap 은
//  이 모듈 안에서만 쓰이는 내부 헬퍼다(적출을 계기로 공개 범위를 넓히지 않는다).
export {
  renderCollection,
  renderInline,
  renderMarkdown,
  safeHref,
};
