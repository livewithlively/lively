// 지식 본문의 [[위키링크]] — **문법 층**(#907). 순수 함수(DB·네트워크 없음, 단위테스트 대상).
//
//   문법은 Obsidian/Quartz(카파시형 LLM 위키 — llm-wiki-init-* 스킬이 세우는 그 스택) 규격을 그대로 따른다
//   (https://obsidian.md/help/links · "Use a vertical bar (|) to change the display text"):
//     · [[name]]        링크.
//     · [[name|표시글]]  '|' 뒤는 **표시 텍스트**다 — 관계 타입이 아니다(Obsidian 에 타입 관계 문법은 없다).
//                       그래서 자동 엣지 relation 은 전부 'related' 고, 특정 관계는 knowledge_link 로 명시한다(#907 결정).
//     · [[name#헤딩]]    헤딩 링크지만 **엣지 대상은 노트(name)** — '#' 뒤는 문서 내 앵커라 버린다.
//     · ![[name]]       임베드 — Obsidian 그래프가 링크로 세니 우리도 엣지로 센다('!' 는 [[ 앞에 붙을 뿐이라 자연히 걸린다).
//   \[\[…\]\] 처럼 이스케이프한 표기는 '[[' 가 문자열에 없어 자연히 안 걸린다(문서가 문법 자체를 설명할 때 쓰는 형태 — 실재).
//
//   렌더러(connectors/domain-wiki-md.normalizeWikiLinks)와 **문법(RE_WIKI·mapProseSegments)은 공유하되
//   해소 규칙은 공유하지 않는다**: 렌더러는 도메인위키 파일명을 wikiSlug(한글 소거)로 풀고, 엣지 해소는
//   knowledge.name 규칙(slugify — 한글 보존)으로 푼다(knowledge-store.resolveWikiLinkTargets).
//   섞으면 한글 이름 지식(실측 71건)이 통째로 미매칭된다.

/** [[name]] / [[name|label]] — Obsidian 문법. 렌더러와 공유하는 단일 진실원천(두 벌이 되면 문법이 드리프트한다). */
export const RE_WIKI = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;

/** 코드펜스(``` · ~~~) 블록과 인라인코드(`…`) **밖**의 산문 조각만 fn 으로 매핑해 다시 이어붙인다.
 *  코드 안의 [[…]] 는 링크가 아니라 예시다 — 설계문서가 문법을 설명하며 [[name]] 을 적고(#290 문서가 실제로 그렇다),
 *  터미널 문서엔 [[27,13]] 같은 이스케이프 시퀀스가 있다. 이걸 엣지로 만들면 그래프가 오염된다.
 *
 *  펜스는 CommonMark 대로 **같은 문자 + 열 때 이상의 길이**로만 닫힌다. 아무 펜스 마커나 토글하면
 *  중첩 예시(~~~ 로 감싸 그 안에 ``` 블록을 보여주는 흔한 기법)에서 판정이 뒤집혀 안쪽 예시가 산문으로 새어
 *  실제 엣지가 된다(#907 리뷰 지적 — 실측 재현). */
export function mapProseSegments(md: string, fn: (seg: string) => string): string {
  let fence: { ch: string; len: number } | null = null;
  return md.split("\n").map((line) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) {
      const ch = m[1][0], len = m[1].length;
      if (!fence) fence = { ch, len };                          // 열기
      else if (ch === fence.ch && len >= fence.len) fence = null; // 같은 문자·길이 충족 → 닫기 (아니면 코드 내용)
      return line;
    }
    if (fence) return line;
    const parts = line.split(/(`[^`]*`)/);          // 홀수 인덱스 = 인라인코드 → 건드리지 않는다.
    for (let i = 0; i < parts.length; i += 2) parts[i] = fn(parts[i]);
    return parts.join("");
  }).join("\n");
}

/** 본문 → 위키링크 대상 raw 문자열(등장순·중복제거). 해소·정규화는 하지 않는다 — 호출부(knowledge-store) 몫이다. */
export function extractWikiLinkTargets(md: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  mapProseSegments(md ?? "", (seg) => {
    for (const m of seg.matchAll(RE_WIKI)) {
      const target = m[1].split("#")[0].trim();     // 앵커 절단. [[#헤딩]](자기 문서 앵커)은 빈 문자열이 되어 버려진다.
      if (target && !seen.has(target)) { seen.add(target); out.push(target); }
    }
    return seg;                                     // 추출만 — 본문은 그대로 둔다(펜스 규칙을 렌더러와 한 벌로 쓰려고 map 을 빌린다).
  });
  return out;
}
