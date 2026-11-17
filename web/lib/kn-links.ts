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

/** 한 줄 글(제목)의 마크다운 강조 표식만 뗀다 — **굵게** · `코드` → 글자. 짝이 안 맞는 표식은 그대로.
 *  ⚠ __ 는 건드리지 않는다 — mcp__lively__tool · __init__ 같은 이름이 제목에 든다(렌더러도 __x__ 를 굵게로 읽지 않는다). */
export function plainMd(s: string): string {
  return String(s || '').replace(/\*\*([^*\n]+?)\*\*/g, '$1').replace(/`([^`\n]+?)`/g, '$1');
}

/** 본문 맨 앞의 H1 이 제목을 **되풀이할 때만** 뗀다(읽기 화면 머리에 이미 있다). 다른 말이면 그대로 —
 *  지식 저장 지침이 «제목은 짧게, 긴 설명은 본문 첫 헤딩으로» 라 그 H1 이 곧 설명일 수 있다(격리 리뷰 지적). */
export function dropTitleH1(md: string, titles: Array<string | null | undefined>): string {
  const s = String(md || '');
  const m = /^\s*#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n|$)/.exec(s);
  if (!m) return s;
  const h = plainMd(m[1]).trim();
  return titles.some((t) => !!t && plainMd(t).trim() === h) ? s.slice(m[0].length).replace(/^\s*\n/, '') : s;
}

// 지식 화면(#/k/…)은 본문을 renderMarkdown 과 블록 에디터로 그리는데 둘 다 [[…]] 를 글자로 뒀다 — 에이전트가 쓴 지식은
//  연결을 거의 전부 [[이름]] 으로 적으니 문서 사이를 걸어 다닐 수가 없었다(신규 입사 온보딩에서 신고). 그래서 렌더러가
//  자리마다 토큰 하나를 판정하는 wikiLinkAt 과, 서버가 이미 해소해 둔 연결 목록으로 이름을 푸는 resolveWikiTarget 을 둔다.
//  · 이름 · 라벨에 ` 가 들면 링크로 치지 않는다 — 서버 판정(src/v6/wikilink.ts mapProseSegments)이 인라인 코드를 먼저 떼므로
//    `…` 를 가로지르는 [[…]] 는 엣지가 아니다. 렌더러가 링크로 그리면 «연결 안 된 링크» 가 생긴다.
const WIKI_AT = /^\[\[([^\[\]|\n`]+?)(?:\|([^\[\]\n`]*?))?\]\]/;

export interface WikiLinkToken { raw: string; target: string; label: string }

/** s 의 i 자리에서 시작하는 [[이름]] · [[이름|라벨]] 하나(아니면 null). target = 이름(앞뒤 공백 뗌, #헤딩 포함), label = 라벨 또는 이름. */
export function wikiLinkAt(s: string, i: number): WikiLinkToken | null {
  if (s[i] !== '[' || s[i + 1] !== '[') return null;
  const m = WIKI_AT.exec(s.slice(i));
  if (!m) return null;
  const target = m[1].trim();
  if (!target) return null;
  return { raw: m[0], target, label: (m[2] || '').trim() || target };
}

/** 서버 slugify(src/v6/knowledge-common.ts)와 같은 식 — 링크 대상이 이름 대신 제목처럼 적혔을 때 서버가 푸는 두 번째 후보. */
export function knSlug(s: string): string {
  return (String(s || 'untitled').toLowerCase().trim()
    .replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)) || 'untitled';
}

/** 링크 대상 → 열 지식 이름과 «없음» 여부. null = 링크가 아니다([[#헤딩]] 처럼 문서 이름이 빈 것).
 *  known = 서버가 이 문서에서 실제로 이어 둔 지식 이름(links.outgoing). 서버 해소 순서(src/v6/knowledge-links.ts
 *  resolveWikiLinkTargets: 그대로 → slug)를 known 안에서 밟는다 — 서버에 없는 단계를 더하면 서버가 잇지 않은 문서로
 *  링크가 걸린다. known 이 없으면 판정하지 않고 적힌 이름 그대로 연다.
 *  ⚠ «없음» 은 «이 문서와 이어져 있지 않음» 이다 — 볼 수 없는 지식, 저장 뒤에 새로 생겨 아직 엣지가 안 붙은 지식도 여기 든다. */
export function resolveWikiTarget(target: string, known: ReadonlySet<string> | null | undefined): { name: string; missing: boolean } | null {
  const base = String(target || '').split('#')[0].trim();
  if (!base) return null;
  if (!known) return { name: base, missing: false };
  if (known.has(base)) return { name: base, missing: false };
  const slug = knSlug(base);
  if (known.has(slug)) return { name: slug, missing: false };
  return { name: base, missing: true };
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
