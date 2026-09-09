// lib/xml.ts — 사무문서(OOXML·ODF·HWPX)를 읽으려고 두는 **아주 작은 XML 훑개**.
//
// 왜 DOMParser 를 안 쓰나
//  ① 우리가 하는 일은 «어떤 태그 사이의 글자를 순서대로 줍는다» 뿐이라 트리가 필요 없다.
//  ② DOMParser 는 브라우저에만 있다 — 여기 있는 판정을 node 로 실물 파일에 돌려 확인할 수 있어야 한다.
//  ③ 워드가 뱉는 document.xml 은 200MB 도 나온다. 트리를 세우면 그 몇 배가 메모리에 앉는다.
//
// 다루지 않는 것(의도) — DTD·네임스페이스 해석·엔티티 선언. 사무문서엔 나오지 않고,
//  나오더라도 «글자를 줍는다» 는 목적엔 영향이 없다.
//
// leaf 규약: import 0.

export type XmlTok =
  | { t: 'open'; name: string; attrs: Record<string, string>; self: boolean }
  | { t: 'close'; name: string }
  | { t: 'text'; text: string };

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** XML 엔티티를 푼다 — 이름꼴(&amp;)과 숫자꼴(&#10; &#x1F600;) 둘 다. 모르는 것은 원문 그대로 남긴다. */
export function unescapeXml(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g: string) => {
    if (g[0] === '#') {
      const n = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENT[g] ?? m;
  });
}

/** 태그 이름에서 접두사를 뗀다(`w:tbl` → `tbl`) — 문서마다 접두사가 달라 이름만 보고 판정한다. */
export function localName(n: string): string {
  const i = n.indexOf(':');
  return i < 0 ? n : n.slice(i + 1);
}

/** 속성 문자열 → 맵. 접두사는 남긴다(`r:embed`·`xml:space` 는 접두사가 곧 의미다). */
function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_:][-.\w:]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = unescapeXml(m[3] !== undefined ? m[3] : (m[4] ?? ''));
  return out;
}

/**
 * XML 을 토큰으로 훑는다. 트리를 세우지 않고 **읽는 쪽이 필요한 만큼만** 상태를 들고 간다.
 *  주석·처리명령(<?xml?>)·DOCTYPE 은 건너뛰고, CDATA 는 글자로 낸다.
 */
export function* xmlTokens(src: string): Generator<XmlTok> {
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      const tail = src.slice(i);
      if (tail) yield { t: 'text', text: unescapeXml(tail) };
      return;
    }
    if (lt > i) yield { t: 'text', text: unescapeXml(src.slice(i, lt)) };
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9);
      const end = e < 0 ? n : e;
      yield { t: 'text', text: src.slice(lt + 9, end) };   // CDATA 안은 엔티티가 아니다 — 그대로
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) { const e = src.indexOf('?>', lt + 2); i = e < 0 ? n : e + 2; continue; }
    if (src.startsWith('<!', lt)) { const e = src.indexOf('>', lt + 2); i = e < 0 ? n : e + 1; continue; }
    const gt = src.indexOf('>', lt + 1);
    if (gt < 0) return;                                    // 잘린 문서 — 여기까지가 우리가 아는 전부
    const body = src.slice(lt + 1, gt);
    if (body[0] === '/') { yield { t: 'close', name: body.slice(1).trim() }; i = gt + 1; continue; }
    const self = body.endsWith('/');
    const inner = self ? body.slice(0, -1) : body;
    const sp = inner.search(/[\s]/);
    const name = (sp < 0 ? inner : inner.slice(0, sp)).trim();
    const attrs = sp < 0 ? {} : parseAttrs(inner.slice(sp + 1));
    if (name) yield { t: 'open', name, attrs, self };
    i = gt + 1;
  }
}

/** 문서 전체에서 어떤 태그(로컬 이름)들 안의 글자만 순서대로 줍는다 — «텍스트만 필요할 때»의 지름길. */
export function textInTags(src: string, tags: string[], joinAt?: string[]): string {
  const want = new Set(tags);
  const brk = new Set(joinAt || []);
  const out: string[] = [];
  let depth = 0;
  for (const tk of xmlTokens(src)) {
    if (tk.t === 'open') {
      if (want.has(localName(tk.name)) && !tk.self) depth++;
      else if (brk.has(localName(tk.name))) out.push('\n');
    } else if (tk.t === 'close') {
      if (want.has(localName(tk.name)) && depth > 0) depth--;
    } else if (depth > 0) out.push(tk.text);
  }
  return out.join('');
}
