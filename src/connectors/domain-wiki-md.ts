// 도메인위키(마크다운 git 미러) → 지식 본문 변환기 — 순수 함수(네트워크/FS 없음, 단위테스트 대상).
//
//   배경(프로젝트 #696): domain-wiki repo(charles_wiki, Obsidian/Quartz vault, Notion=primary 의 md 미러)를
//   지식으로 인입할 때, 원본의 링크 문법이 우리 WIKI 렌더러(web/core.ts renderInline)에서 안 걸린다:
//     · 상대경로 `.md` 링크  `[x](../a/b.md#h)`  — 브라우저가 상대경로로 풀페이지 이동 → 깨짐
//     · `[[wikilink]]`                            — 렌더러 미지원 → 죽은 텍스트
//     · 노션 URL  `[x](https://notion.so/…)`      — 내부 미러 대신 외부 노션으로 이탈
//   이 모듈이 인입 시점에 이 셋을 내부 링크 `[label](#/k/<name>)` 로 정규화한다. 타깃은 호출부가 준
//   knownTargets(레포 슬러그 ∪ 기존 notion 미러 name) 안에 있을 때만 재작성 — 없으면 원형 유지(외부/미미러)
//   또는 평문(위키링크). 코드펜스·인라인코드 내부는 절대 건드리지 않는다.
//
//   지식 name(=external_id) = 파일 basename 슬러그. 최초 수동이관이 이 규칙으로 name 을 부여했으므로 동일 규칙
//   이어야 기존 행을 재싱크가 그대로 갱신(name 키 upsert)한다. 상대링크는 basename 만 보고 해소한다 —
//   레포 슬러그가 전역 유니크라 디렉터리 traversal(`../`) 을 풀 필요가 없다.

/** 파일 basename(확장자 제외) → 지식 name 슬러그. 소문자·[a-z0-9_-] 외 '-'·양끝 '-' 제거·64자 상한. */
export function wikiSlug(basename: string): string {
  return basename.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

/** notion 페이지 URL → 캐노니컬 uuid(하이픈드). 아니면 null. (notion-md.notionIdFromUrl 과 동일 규칙 — 의존 회피 위해 국소 복제.) */
export function notionIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)notion\.(so|site|com)$/.test(u.hostname)) return null;
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
    const m = last.match(/([0-9a-fA-F]{32})$/);
    if (!m) return null;
    const h = m[1].toLowerCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  } catch { return null; }
}

/** 상대경로 링크 href → 대상 슬러그. 앵커(#)·쿼리(?) 절단, .md 제거, 마지막 경로 세그먼트만. */
export function relTargetSlug(href: string): string {
  let clean: string;
  try { clean = decodeURIComponent(href.split("#")[0].split("?")[0]); }
  catch { clean = href.split("#")[0].split("?")[0]; }
  const base = clean.replace(/\.md$/i, "").split("/").filter(Boolean).pop() ?? "";
  return wikiSlug(base);
}

/** 프론트매터(--- … ---) 파싱 — title 추출 + 본문(프론트매터 제거) 반환. 없으면 {title:null, body:raw}. */
export function parseFrontmatter(raw: string): { title: string | null; body: string } {
  if (!raw.startsWith("---")) return { title: null, body: raw };
  // 여는 --- 다음 줄부터 닫는 --- 까지가 프론트매터.
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { title: null, body: raw };
  const fm = m[1];
  const body = raw.slice(m[0].length);
  const mt = fm.match(/^title:\s*(.+)$/m);
  const title = mt ? mt[1].trim().replace(/^["']|["']$/g, "") : null;
  return { title, body };
}

const RE_MD = /(!?)\[([^\]]*)\]\(([^)\s]+)\)/g;         // [txt](href) / ![alt](href)
const RE_WIKI = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;      // [[name]] / [[name|label]]

/**
 * 링크 정규화. 코드펜스(```)·인라인코드(`…`) 밖의 텍스트에서만:
 *  A) 노션 URL → `#/k/notion-<id>`  (해당 notion-<id> 가 knownTargets 에 있을 때만)
 *  B) `[[name]]`/`[[name|label]]` → `[label](#/k/<slug>)`  (slug 가 knownTargets 에 있을 때 / 없으면 평문 label)
 *  C) 상대경로 `.md`·경로형 링크 → `[label](#/k/<slug>)`  (slug 가 knownTargets 에 있을 때만)
 * 외부 http(s)/mailto·앵커(#)·절대경로(/…)·이미지(!)는 원형 유지.
 */
export function normalizeWikiLinks(md: string, knownTargets: Set<string>): string {
  const lines = md.split("\n");
  let inFence = false;
  const out = lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return line; }
    if (inFence) return line;
    // 인라인코드 스팬 분리 — 짝수 인덱스(코드 밖)만 변환.
    const parts = line.split(/(`[^`]*`)/);
    for (let i = 0; i < parts.length; i += 2) {
      let seg = parts[i];
      // A + C : 마크다운 링크
      seg = seg.replace(RE_MD, (m, bang: string, label: string, href: string) => {
        if (bang === "!") return m;                               // 이미지 — 유지
        const nid = notionIdFromUrl(href);
        if (nid) {                                                // A: 노션 URL
          const name = `notion-${nid}`;
          return knownTargets.has(name) ? `[${label}](#/k/${name})` : m;
        }
        if (/^(https?:|mailto:|#|\/)/.test(href)) return m;       // 외부/앵커/절대 — 유지
        if (href.includes("/") || /\.md($|[#?])/i.test(href)) {   // C: 경로형/.md 상대링크
          const slug = relTargetSlug(href);
          return knownTargets.has(slug) ? `[${label}](#/k/${slug})` : m;
        }
        return m;                                                 // 경로 신호 없는 bare — 모호 → 유지
      });
      // B : [[wikilink]]
      seg = seg.replace(RE_WIKI, (_m, name: string, label?: string) => {
        const slug = relTargetSlug(name.trim());                  // 경로형 [[a/b/c]] 도 basename 슬러그
        const text = (label ?? name).trim().replace(/[[\]]/g, " ").replace(/\s+/g, " ").trim();
        return knownTargets.has(slug) ? `[${text}](#/k/${slug})` : text;  // 미해소 → 평문(죽은 [[..]] 방지)
      });
      parts[i] = seg;
    }
    return parts.join("");
  });
  return out.join("\n");
}
