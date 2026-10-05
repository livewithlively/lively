// lib/kn-links.ts — 지식 본문의 위키 링크 [[이름]] · [[이름|라벨]] 을 마크다운 링크(#/k/이름)로 (#4443).
//  renderMarkdown 은 [[…]] 를 모른다(위키 화면도 글자 그대로 둔다). 곁칸 지식 읽기는 그 링크를 눌러 **그 자리에서 이어 읽게**
//  하려고 렌더 전에 한 번 바꿔 넣는다 — #/k/… 링크는 읽기 화면이 가로채 곁칸 안에서 연다(v2/panes-knowledge).
//  · 코드(``` · ~~~ 울타리 블록, `인라인 코드`) 안의 [[…]] 는 글자 그대로 — 문서가 위키 문법 자체를 설명하는 일이 잦다.
//  · 이름이 비었거나 닫히지 않은 [[ 는 그대로. 이름 · 라벨에 대괄호가 들면 위키 링크로 치지 않는다(마크다운 링크 라벨이 끊긴다).
//  · 이름의 ( ) 는 %28 %29 로 — renderMarkdown 의 링크 파서는 첫 ')' 에서 주소를 끊는다.

const WIKI_LINK = /\[\[([^\[\]|\n]+?)(?:\|([^\[\]\n]+?))?\]\]/g;

/** 지식 이름 → 앱 안 주소. 읽기 화면이 거꾸로 풀 때는 knNameOfHref. */
export function knHref(name: string): string {
  return '#/k/' + encodeURIComponent(name).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/** #/k/이름 주소 → 지식 이름(아니면 null). ?·# 뒤는 버린다. */
export function knNameOfHref(href: string | null | undefined): string | null {
  const m = /^#\/k\/([^?#]+)/.exec(String(href || ''));
  if (!m) return null;
  try { return decodeURIComponent(m[1]) || null; } catch (_) { return null; }
}

/** 본문의 [[이름]] · [[이름|라벨]] 을 [라벨](#/k/이름) 으로. 코드 안은 건드리지 않는다. */
export function wikiLinksToMd(md: string): string {
  const s = String(md || '');
  if (s.indexOf('[[') < 0) return s;
  let fence = '';                                    // 열린 울타리의 글자(` 또는 ~) — 비었으면 울타리 밖
  return s.split('\n').map((line) => {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = '';
      return line;
    }
    if (fence) return line;
    //  백틱으로 가른 홀수 번째 조각이 인라인 코드다(split 의 잡는 괄호가 그 조각을 남긴다).
    return line.split(/(`+[^`]*`+)/).map((part, i) => (i % 2 ? part : part.replace(WIKI_LINK, (whole, name: string, label?: string) => {
      const n = name.trim();
      if (!n) return whole;
      const lab = String(label || '').trim() || n;
      return `[${lab}](${knHref(n)})`;
    }))).join('');
  }).join('\n');
}
