// lib/dom.ts — DOM 생성 프리미티브(#1313 R29b). core.ts 에서 **verbatim 이동**(로직 변경 0).
//  el/sv 는 앱 전체가 쓰는 최하층이라 leaf 로 둔다 — 우리 모듈 import 0(순환이 생길 여지 자체를 없앤다).
//  ⚠ revealUsed(입장 리빌 1회 플래그)는 모듈 전역 mutable 이라 소유자인 applyReveal 과 **같은 모듈**에 있어야 한다.
//  소비 파일은 종전대로 './core.js' 에서 받는다(core 의 배럴 재수출).

const SVG_NS = 'http://www.w3.org/2000/svg';

let revealUsed = false; // 입장 리빌은 첫 부팅 렌더 1회만(§6)

// ── DOM 헬퍼 ──
// 불리언 HTML 속성 — 존재만으로 참이라 setAttribute(k, false) 로는 끌 수 없다(값 'false' 여도 켜진 상태).
//  el 에서 이들만 특수처리: 불리언 false → 미설정(끔), 그 외(true·'' 등) → 빈 속성으로 존재(켬).
const EL_BOOL_ATTRS = new Set(['disabled', 'hidden', 'checked', 'selected', 'readonly', 'required', 'multiple', 'open', 'autofocus']);

// ── 브라우저·패스워드매니저 자동완성 오작동 차단(#1250) ──
//  크롬은 type=password 칸이 보이면 그 언저리를 로그인 폼으로 파싱하고, **바로 앞의 텍스트칸을 아이디로 오인**한다.
//  그래서 client_id·대상 구분·CLI 승인코드 같은 칸에 저장된 이메일이 채워지고, 제출하면 "비밀번호를 저장할까요?"가 뜬다.
//  비번칸의 autocomplete=off 는 크롬이 **무시**하므로(MDN: 로그인 필드에서 autocomplete=off 미지원) 그것만으론 못 막는다.
//  두 겹으로 막는다 — ① 여기: el() 로 만드는 입력칸은 기본적으로 자동완성 대상에서 뺀다.
//                    ② secretInput(): 토큰·시크릿은 애초에 type=password 를 안 써서 로그인 폼 파싱 자체를 안 부른다.
//  ⚠ 진짜 자격증명 칸(로그인·비번변경·비번재확인)은 autocomplete 를 **명시**한다 → 명시한 칸은 ①이 손대지 않으므로
//    브라우저·패스워드매니저가 평소대로 채워준다. 로그인 게이트는 정적 index.html 이라 이 경로를 애초에 안 탄다.
const AUTOFILLABLE_TYPES = new Set(['', 'text', 'email', 'search', 'tel', 'url', 'number', 'password']);
// 패스워드매니저는 저마다 autocomplete=off 를 무시하고 자기 data 속성으로만 물러난다(표준 없음).
const PM_IGNORE_ATTRS: Array<[string, string]> = [
  ['data-1p-ignore', ''],              // 1Password
  ['data-lpignore', 'true'],           // LastPass
  ['data-bwignore', 'true'],           // Bitwarden
  ['data-protonpass-ignore', 'true'],  // Proton Pass
];
function denyAutofill(n: any): void {
  if (!n.hasAttribute('autocomplete')) n.setAttribute('autocomplete', 'off');
  for (const [k, v] of PM_IGNORE_ATTRS) n.setAttribute(k, v);
}

function el(tag: string, attrs?: any, ...children: any[]): any {
  const n: any = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries<any>(attrs)) {
      if (v == null) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (EL_BOOL_ATTRS.has(k)) { if (v !== false) n.setAttribute(k, ''); } // false 만 끔('' / true 는 켬)
      else n.setAttribute(k, v);
    }
  }
  // autocomplete 를 명시하지 않은 입력칸 = 자격증명 칸이 아니다 → 자동완성 대상에서 뺀다(위 주석).
  if (!n.hasAttribute('autocomplete')
      && (tag === 'textarea' || (tag === 'input' && AUTOFILLABLE_TYPES.has(n.getAttribute('type') || ''))))
    denyAutofill(n);
  for (const c of children.flat(Infinity)) {
    if (c == null) continue;
    n.append((c as any).nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}

function sv(name: string, attrs?: any, ...children: any[]): any {
  const n: any = document.createElementNS(SVG_NS, name);
  if (attrs) for (const [k, v] of Object.entries<any>(attrs)) { if (v != null) n.setAttribute(k, v); }
  for (const c of children.flat(Infinity)) { if (c != null) n.append((c as any).nodeType ? c : document.createTextNode(String(c))); }
  return n;
}
const $view = () => document.getElementById('view');
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function applyReveal(nodes) {
  if (revealUsed || reducedMotion()) { revealUsed = true; return; }
  nodes.forEach((n, i) => { n.classList.add('reveal'); n.style.animationDelay = (i * 70) + 'ms'; });
  revealUsed = true;
}

function interleave(arr, sep) {
  const out: any[] = [];
  arr.forEach((n, i) => { if (i) out.push(sep); out.push(n); });
  return out;
}

export {
  $view,
  applyReveal,
  denyAutofill,
  el,
  interleave,
  reducedMotion,
  sv,
};
