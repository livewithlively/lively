// lib/uitext.ts — 안내문 인라인 표기 → 화면 칩(#1313 R29b). core.ts 에서 **verbatim 이동**(로직 변경 0).
//  왜 별도 모듈인가: 이 한 가족(uiText·uiKeyCls)의 소비자가 세 층에 걸쳐 있다 —
//   lib/overlay(toast·infoPop) · lib/widgets(cardHead 경유) · lib/markdown(uiKeyCls).
//   widgets 에 두면 overlay→widgets(uiText)와 widgets→overlay(infoPop)로 **순환**이 되고,
//   overlay 에 두면 markdown→overlay 라는 엉뚱한 엣지가 생긴다. dom 하나만 보는 leaf 로 떼어 둘 다 없앤다.
//  소비 파일은 종전대로 './core.js' 에서 받는다(core 의 배럴 재수출).
import { el } from './dom.js';

// 설명 문자열의 인라인 표기를 화면 언어로 승격한다 — **강조** · [버튼] · 「옵션·메뉴·상태」.
//  왜: 안내문에 별표·대괄호·꺽쇠가 그대로 노출돼 읽기 나빴다(예전엔 [외부 자료 수집] 설명의 '**우리 DB 로 복사**'가
//  별표째 보였고, 관리탭엔 '[저장]을 눌러야 반영'처럼 대괄호가 난무했다). #1013 에서 사용가이드 마크다운을
//  칩으로 승격한 것과 **같은 시각언어**를 코드 하드코딩 문구(관리탭)에도 쓴다 — 스타일은 .md-uikey 하나로 공유.
//  el() 이 텍스트 노드로만 붙이므로 innerHTML 주입 경로는 없다.
function uiText(text) {
  const out: any[] = [];
  const s = String(text == null ? '' : text);
  let buf = '';
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  const chip = (mod, label) => el('span', { class: uiKeyCls(mod, label) }, ...uiText(label));
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '*' && s[i + 1] === '*') {
      const close = s.indexOf('**', i + 2);
      if (close > i + 2) { flush(); out.push(el('b', {}, ...uiText(s.slice(i + 2, close)))); i = close + 2; continue; }
    }
    if (ch === '[') {
      const close = s.indexOf(']', i + 1);
      // [x](url) 은 링크 문법이라 건드리지 않는다. 단 **주소일 때만** — '[끄기](주소는 남고 프로세스만 내려감)'
      //  처럼 버튼 뒤에 괄호 설명이 붙는 문장이 실제로 흔해서, 괄호만 보고 링크로 넘기면 그 버튼이 칩을 못 받는다.
      if (close > i + 1 && !MD_LINK_AT.test(s.slice(close + 1)) && uiKeyOk(s.slice(i + 1, close))) {
        flush(); out.push(chip('md-uikey-btn', s.slice(i + 1, close))); i = close + 1; continue;
      }
    }
    if (ch === '「') {
      const close = s.indexOf('」', i + 1);
      if (close > i + 1 && uiKeyOk(s.slice(i + 1, close))) {
        flush(); out.push(chip('md-uikey-opt', s.slice(i + 1, close))); i = close + 1; continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}
// 칩 클래스 — 라벨이 한 덩어리(공백 없음)면 nowrap 을 걸어 '연결·데이/터'처럼 이름이 잘리는 걸 막는다.
//  (한국어는 중점·조사 경계에서 줄바꿈이 일어나 word-break:keep-all 만으로는 안 막힌다.)
//  공백이 있는 긴 라벨은 어절 단위로 흐르게 둔다 — 안 그러면 좁은 팝오버에서 칩이 통째로 넘친다.
function uiKeyCls(mod, label) {
  return 'md-uikey ' + mod + (/\s/.test(String(label).trim()) ? '' : ' md-uikey-solid');
}
// ']' 바로 뒤가 마크다운 링크의 (주소) 인가 — 프로토콜·라우트로 시작하고 공백 없이 닫히는 것만 링크로 본다.
const MD_LINK_AT = /^\((?:https?:\/\/|mailto:|#|\/)[^)\s]*\)/;
// 칩으로 승격할 라벨인가 — UI 라벨은 짧고 따옴표·중괄호가 없다. JSON/코드 예시( ["Read","Grep"] 등)를
// 버튼처럼 보이게 만들면 오히려 거짓말이 되므로 제외한다.
function uiKeyOk(label) {
  return !!label.trim() && label.length <= 40 && !/["'{}\n]/.test(label);
}

export {
  uiKeyCls,
  uiText,
};
