// 도메인위키(마크다운 git 미러) → 지식 본문 변환기 — 순수 함수(네트워크/FS 없음, 단위테스트 대상).
//
//   배경(프로젝트 #696): domain-wiki repo(team_wiki, Obsidian/Quartz vault, Notion=primary 의 md 미러)를
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
//
//   위키링크 **문법**(RE_WIKI·펜스/인라인코드 규칙)은 v6/wikilink 가 단일 진실원천이다(#907 — 본문 [[…]] 가
//   지식 그래프 엣지로도 해소되면서 문법이 두 벌이 될 위험이 생겼다). 여기선 그 문법으로 찾은 링크를
//   '도메인위키 파일명' 규칙으로 풀 뿐이다.

import { createHash } from "node:crypto";
import path from "node:path";
import { RE_WIKI, mapProseSegments } from "../v6/wikilink.js";

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

/**
 * 링크 정규화. 코드펜스(```)·인라인코드(`…`) 밖의 텍스트에서만(mapProseSegments):
 *  A) 노션 URL → `#/k/notion-<id>`  (해당 notion-<id> 가 knownTargets 에 있을 때만)
 *  B) `[[name]]`/`[[name|label]]` → `[label](#/k/<slug>)`  (slug 가 knownTargets 에 있을 때 / 없으면 평문 label)
 *  C) 상대경로 `.md`·경로형 링크 → `[label](#/k/<slug>)`  (slug 가 knownTargets 에 있을 때만)
 * 외부 http(s)/mailto·앵커(#)·절대경로(/…)·이미지(!)는 원형 유지.
 *
 * ⚠ 문법(RE_WIKI·펜스 규칙)은 v6/wikilink 와 공유하되 **해소는 다르다** — 여기는 도메인위키 파일명(wikiSlug,
 *  한글 소거), 지식 그래프 엣지(#907)는 knowledge.name 규칙(slugify, 한글 보존). 섞으면 한글 지식이 미매칭된다.
 */
export function normalizeWikiLinks(md: string, knownTargets: Set<string>): string {
  return mapProseSegments(md, (seg) => {
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
    return seg;
  });
}

// ════════ 경로 식별 모드(id_mode=path) ════════
//  basename 슬러그를 이름으로 쓰는 위 규칙은 «파일 1개 = 주제 1개, 파일명이 전역 유니크» 인 작은 위키 레포에서만 성립한다.
//  제품 문서 레포는 그렇지 않다 — 실측(한 제품 문서 레포 .md 4,078개): `readme` 230개 · `skill` 101개가 한 이름을 나눠 쓰고,
//  한글만으로 된 파일명 102개는 슬러그가 빈 문자열이 된다. 이름이 겹치면 name 키 upsert 가 서로를 덮는다.
//  그래서 경로 모드는 **레포 상대경로를 정체성으로** 쓴다(external_id = 경로). 아래는 그 모드가 쓰는 순수 함수들이다.

/** 지식 이름 규칙(v6/knowledge-common slugify)과 같은 문자 규칙 — 한글을 남긴다. 그 함수는 DB 모듈을 끌어와서 복제한다.
 *  ⚠ 바꾸면 knowledge-common.slugify 도 같이 본다 — 둘이 갈라지면 경로 이름이 knowledge_get 의 이름 정규화를 못 버틴다. */
function knowledgeSlugPart(s: string): string {
  return String(s ?? "").normalize("NFC").toLowerCase().trim()
    .replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "");
}

/** 경로 모드 지식 이름 — `<instance>-<파일명>-<경로 해시 10자>`, 64자 이내.
 *  · 해시가 있어 같은 파일명(readme 230개)도, 슬러그가 비는 파일명도 겹치지 않는다.
 *  · 파일명 부분은 사람이 이름만 보고 짐작하라고 둔다(정체성은 해시가 진다 — 잘려도 된다).
 *  · instance 를 해시에 넣는다 — 같은 경로의 파일이 다른 위키 레포에도 있을 수 있다.
 *  · knowledge_save·knowledge_get 이 이름을 slugify 로 정규화하므로 그 함수의 고정점이어야 한다(_ 는 쓰지 않는다). */
export function wikiPathName(instance: string, relpath: string): string {
  const rel = relpath.normalize("NFC");
  const hash = createHash("sha1").update(`${instance}\n${rel}`).digest("hex").slice(0, 10);
  const prefix = knowledgeSlugPart(instance).slice(0, 24).replace(/-+$/, "") || "wiki";
  let tail = knowledgeSlugPart(path.posix.basename(rel).replace(/\.md$/i, ""));
  if (!tail) tail = knowledgeSlugPart(path.posix.basename(path.posix.dirname(rel)));
  const room = 64 - prefix.length - hash.length - 2;
  tail = tail.slice(0, Math.max(0, room)).replace(/-+$/, "");
  return tail ? `${prefix}-${tail}-${hash}` : `${prefix}-${hash}`;
}

/** 본문 첫 `# 제목`(코드펜스 밖) — 프론트매터 title 이 없을 때의 표시 제목. 없으면 null.
 *  펜스는 mapProseSegments 와 같은 규칙(같은 문자 + 열 때 이상의 길이로만 닫힌다)으로 건너뛴다. */
export function firstHeading(md: string): string | null {
  let fence: { ch: string; len: number } | null = null;
  for (const raw of String(md ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      const ch = f[1][0], len = f[1].length;
      if (!fence) fence = { ch, len };
      else if (ch === fence.ch && len >= fence.len) fence = null;
      continue;
    }
    if (fence) continue;
    const m = /^ {0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (!m) continue;
    //  링크는 글자만, 강조·코드 표시는 걷는다. 낱개 `_` 는 남긴다 — `card_policy` 같은 이름이 붙어 버린다.
    const t = m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|__|`/g, "").trim();
    if (t) return t;
  }
  return null;
}

/** 경로 모드 링크 해소에 쓰는 표 — 미러 대상 파일만 담는다(범위 밖 파일로 가는 링크는 원형 유지). */
export interface PathLinkTargets {
  /** 레포 상대경로(NFC) → 지식 이름 */
  byPath: Map<string, string>;
  /** 파일명 키(pathBaseKey) → 그 파일명을 가진 지식 이름들 — [[위키링크]] 를 파일명으로 찾을 때. 둘 이상이면 모호하다. */
  byBase: Map<string, string[]>;
  /** 기존 노션 미러 이름 — 노션 URL 링크 해소(슬러그 모드와 같다). */
  notion: Set<string>;
}

/** [[위키링크]] 의 이름과 파일명을 맞춰 보는 키 — 한글을 남긴다(wikiSlug 는 한글을 지워서 한글 파일명끼리 전부 같은 빈 키가 된다).
 *  `[[카드사 입회 조건]]` 이 `카드사-입회-조건.md` 에, `[[Card Policy]]` 가 `card_policy.md` 에 맞는다. */
export function pathBaseKey(nameOrFile: string): string {
  return knowledgeSlugPart(path.posix.basename(String(nameOrFile ?? "")).replace(/\.md$/i, ""));
}

/** 대상 표 만들기 — 범위 안 경로 목록과 이름 규칙에서. */
export function buildPathLinkTargets(rels: readonly string[], nameOf: (rel: string) => string, notion: Set<string>): PathLinkTargets {
  const byPath = new Map<string, string>();
  const byBase = new Map<string, string[]>();
  for (const r of rels) {
    const rel = r.normalize("NFC");
    const name = nameOf(rel);
    byPath.set(rel, name);
    const base = pathBaseKey(rel);
    if (base) byBase.set(base, [...(byBase.get(base) ?? []), name]);
  }
  return { byPath, byBase, notion };
}

/** href(상대 또는 루트 기준) → 대상 경로 후보. 레포 밖(`../` 로 루트를 넘음)이면 null. */
function resolveRepoPath(fromRel: string, href: string): string | null {
  let clean: string;
  try { clean = decodeURIComponent(href.split("#")[0].split("?")[0]); }
  catch { clean = href.split("#")[0].split("?")[0]; }
  if (!clean) return null;
  const joined = clean.startsWith("/") ? clean.replace(/^\/+/, "") : path.posix.join(path.posix.dirname(fromRel), clean);
  const norm = path.posix.normalize(joined).normalize("NFC");
  if (norm === ".." || norm.startsWith("../")) return null;
  return norm.replace(/^\.\//, "");
}

function lookupPath(t: PathLinkTargets, candidate: string | null): string | undefined {
  if (!candidate) return undefined;
  return t.byPath.get(candidate) ?? (/\.md$/i.test(candidate) ? undefined : t.byPath.get(`${candidate}.md`));
}

/**
 * 경로 모드 링크 정규화 — normalizeWikiLinks 의 경로판. 코드펜스·인라인코드 밖에서만:
 *  A) 노션 URL → `#/k/notion-<id>` (그 노션 미러가 있을 때만)
 *  C) 상대경로 · 루트 기준(`/…`) 링크 → 이 파일 위치에서 풀어 **미러 대상 파일이면** `#/k/<이름>`.
 *     basename 이 아니라 경로로 푼다 — 이 모드가 생긴 이유가 «파일명이 겹친다» 이므로.
 *  B) `[[이름]]` → 경로형(`a/b`)이면 경로로, 아니면 파일명으로 찾되 **그 파일명이 하나뿐일 때만** 링크. 겹치면 평문.
 * 외부 http(s)/mailto·앵커(#)·이미지(!)는 원형 유지. 못 푼 상대 링크도 원형 유지(원문의 깨진 링크를 고치지 않는다).
 */
export function normalizeWikiLinksByPath(md: string, fromRel: string, t: PathLinkTargets): string {
  const from = fromRel.normalize("NFC");
  return mapProseSegments(md, (seg) => {
    seg = seg.replace(RE_MD, (m, bang: string, label: string, href: string) => {
      if (bang === "!") return m;
      const nid = notionIdFromUrl(href);
      if (nid) {
        const name = `notion-${nid}`;
        return t.notion.has(name) ? `[${label}](#/k/${name})` : m;
      }
      if (/^(https?:|mailto:|#)/i.test(href) || /^[a-z][a-z0-9+.-]*:/i.test(href)) return m;
      const name = lookupPath(t, resolveRepoPath(from, href));
      return name ? `[${label}](#/k/${name})` : m;
    });
    seg = seg.replace(RE_WIKI, (_m, raw: string, label?: string) => {
      const target = raw.trim();
      const text = (label ?? target).trim().replace(/[[\]]/g, " ").replace(/\s+/g, " ").trim();
      let name: string | undefined;
      if (target.includes("/")) {
        name = lookupPath(t, resolveRepoPath(from, target)) ?? lookupPath(t, resolveRepoPath("", target));
      } else {
        const key = pathBaseKey(target);
        const hits = key ? t.byBase.get(key) : undefined;
        if (hits && hits.length === 1) name = hits[0];
      }
      return name ? `[${text}](#/k/${name})` : text;
    });
    return seg;
  });
}

// ════════ 민감정보 가리기(mask) ════════
//  레포 문서에는 고객 연락처 · 사업자번호가 섞여 있다(실측: 한 영업 CRM 의 회사 조사 문서 538개 중 517개에 사업자번호 모양).
//  지식은 조직 전체가 검색 · 소환하는 자리라, 수집기가 쓰기 전에 가린다. 가린 자리는 무엇이 있었는지 알 수 있게
//  표식으로 남긴다 — 그냥 지우면 «원문에 연락처가 없다» 로 읽힌다.
//  ⚠ 모양으로만 잡는다. 사람 이름 · 주소는 못 잡는다 — 그런 문서는 범위(exclude)에서 빼는 것이 맞다.
//  ⚠ 파일 경로 · 파일명은 가리지 않는다 — 경로는 정체성(external_id)이자 원본 링크라 바꾸면 미러가 원본을 잃는다.
//   경로에 민감정보가 든 파일은 exclude 로 뺀다.

export type MaskKind = "phone" | "email" | "bizno" | "rrn";
export const MASK_KINDS: readonly MaskKind[] = ["phone", "email", "bizno", "rrn"];

function maskWords(raw: string | null | undefined): string[] {
  return String(raw ?? "").split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
}

/** 설정 문자열 → 가릴 종류. `all` 은 전부, 비어 있으면 안 가린다.
 *  ⚠ **모르는 낱말이 하나라도 있으면 네 종류 전부를 가린다** — 개인정보를 가리는 옵션이라, 오타(`phones` · `e-mail`)가
 *   가리기를 조용히 끄면 고객 연락처가 그대로 조직 검색에 실린다. 실패는 닫힌 쪽으로 둔다(호출부가 경고를 남긴다). */
export function parseMaskKinds(raw: string | null | undefined): Set<MaskKind> {
  const out = new Set<MaskKind>();
  for (const w of maskWords(raw)) {
    if (w === "all") MASK_KINDS.forEach((k) => out.add(k));
    else if ((MASK_KINDS as readonly string[]).includes(w)) out.add(w as MaskKind);
    else return new Set(MASK_KINDS);
  }
  return out;
}

/** parseMaskKinds 가 모르는 낱말 — 경고용(그 낱말 때문에 전부 가리기로 돌았다는 것을 사람이 알게). */
export function unknownMaskWords(raw: string | null | undefined): string[] {
  return maskWords(raw).filter((w) => w !== "all" && !(MASK_KINDS as readonly string[]).includes(w));
}

const MASK_TOKEN: Record<MaskKind, string> = {
  phone: "[전화번호]", email: "[이메일]", bizno: "[사업자번호]", rrn: "[주민·법인번호]",
};
//  순서가 중요하다 — 등록번호(6-7)·사업자번호(3-2-5)를 전화번호보다 먼저 가린다. 숫자 경계는 앞뒤 숫자로만 본다.
const RE_RRN = /(?<!\d)\d{6}-\d{7}(?!\d)/g;
const RE_BIZNO = /(?<!\d)\d{3}-\d{2}-\d{5}(?!\d)/g;
//  휴대폰은 구분자가 없어도(01012345678) 잡고, 유선은 구분자가 있을 때만 잡는다 — 구분자 없는 9~11자리 숫자는
//   금액 · 코드와 구별되지 않는다. 대표번호(1588-…)는 공개 번호라 대상이 아니다.
//  국번을 괄호로 감싼 꼴((02) 1234-5678 · (031)123-4567 · (010) 1234-5678)은 괄호까지 함께 가린다 — 한국 문서에서 흔한 꼴이다.
const RE_PHONE = /(?<![\d+])(?:\+82[-. ]?1[016-9]|01[016-9])[-. ]?\d{3,4}[-. ]?\d{4}(?!\d)|(?<!\d)(?:\(0(?:1[016-9]|2|[3-6][1-5]|70|50[2-8]?)\) ?|0(?:2|[3-6][1-5]|70|50[2-8]?)[-. )])\d{3,4}[-. ]\d{4}(?!\d)/g;
//  지역부(@ 앞)는 64자까지만 본다(RFC 5321 상한). 상한이 없으면 @ 없는 긴 덩어리(해시 · 덤프)에서 시작점마다 끝까지 읽고
//   되돌아가 입력 길이의 제곱 시간이 든다(10만 자에 약 8초 · 실측). 64자보다 긴 지역부는 @ 앞 64자와 도메인만 가린다.
const RE_EMAIL = /[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

/** 가리기. keepEmailDomains 의 도메인(하위 도메인 포함) 이메일은 남긴다 — 조직 구성원 주소는 연락처가 아니라 담당자 표시다. */
export function maskSensitive(text: string, kinds: ReadonlySet<MaskKind>, keepEmailDomains: readonly string[] = []):
  { text: string; masked: Record<MaskKind, number> } {
  const masked: Record<MaskKind, number> = { phone: 0, email: 0, bizno: 0, rrn: 0 };
  if (!text || !kinds.size) return { text, masked };
  const keep = keepEmailDomains.map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  let out = text;
  const sub = (kind: MaskKind, re: RegExp, keepIt?: (m: string, ...g: string[]) => boolean) => {
    if (!kinds.has(kind)) return;
    out = out.replace(re, (m: string, ...g: unknown[]) => {
      if (keepIt && keepIt(m, ...(g.filter((x) => typeof x === "string") as string[]))) return m;
      masked[kind]++;
      return MASK_TOKEN[kind];
    });
  };
  sub("email", RE_EMAIL, (_m, domain) => {
    const d = String(domain ?? "").toLowerCase();
    return keep.some((k) => d === k || d.endsWith(`.${k}`));
  });
  sub("rrn", RE_RRN);
  sub("bizno", RE_BIZNO);
  sub("phone", RE_PHONE);
  return { text: out, masked };
}
