// 서술 형식 자동 정리의 의미 보존 게이트 — LLM 이 기존 지식의 형식만 고쳐 쓴 결과를 저장해도 되는지 기계로 판정한다.
//
// 왜 필요: 재작성은 LLM 이 하므로 형식을 고치다 수치·식별자·링크를 빠뜨리거나 지어낼 수 있다. 지식은 다른 구성원의
//  세션에 사실로 주입되므로, 뜻이 바뀐 글이 «형식이 좋아졌다»는 이유로 저장되면 원문보다 해롭다. 그래서 LLM 판정 앞에
//  싸고 결정적인 불변식(코드·수치·링크·표 값이 그대로인가)을 둬, 여기서 떨어진 건 LLM 에 묻지도 않는다.
//
// 순수 함수다(DB·네트워크 없음). 배치 스크립트와 테스트가 같은 판정을 쓴다.
import type { WritingFormat, WritingRuleId } from "../org/policies/writing-format.js";
import { lintWriting, type WritingFinding } from "./writing-lint.js";

// 자동으로 고쳐도 되는 규칙 — 글의 모양만 보고 고칠 수 있는 것들.
//  relative_time·undated_status·revision_banner·local_path·body_length 는 뺀다: 고치려면 «그날이 언제였나»·
//  «지금도 유효한가»·«어느 레포 경로인가»·«어디서 나눌까»라는 사실 판단이 필요해, LLM 이 그럴듯하게 지어낸다.
export const AUTO_FIX_RULES: readonly WritingRuleId[] = [
  "title_length", "title_leading_emoji", "title_date", "title_mr_ref", "title_status_mark", "title_multi_dash",
  "lead_missing", "bold_overuse", "symbol_overuse", "heading_symbol", "arrow_chain", "nested_paren",
  "register_mix", "forbidden_term",
];
const AUTO_FIX = new Set<WritingRuleId>(AUTO_FIX_RULES);

// 이보다 긴 본문은 LLM 이 전문을 되쓰는 동안 손대지 말아야 할 문장을 깨뜨릴 확률이 커진다(전사 드리프트) —
//  그래서 통째로 쓰지 않고 섹션 단위로 나눠 쓴다(splitSections).
export const REWRITE_BODY_MAX_CHARS = 15000;

// 형식을 고치면 글자는 줄어든다(기호·볼드·반복 제목). 그 이상 줄면 서술이 빠진 것이다.
const SHRINK_MIN_RATIO = 0.7;
const RECENT_EDIT_MS = 24 * 60 * 60 * 1000;
const DETAIL_MAX = 5;

export interface RewriteDoc {
  title: string | null | undefined;
  body_md: string | null | undefined;
}

/** 다중집합은 정렬된 배열(중복 유지), 집합은 정렬·중복 제거된 배열로 둔다 — JSON 으로 그대로 보고서에 실린다. */
export interface Invariants {
  codeBlocks: string[];
  inlineCode: string[];
  numbers: string[];
  urls: string[];
  wikilinks: string[];
  refs: string[];
  tableRows: string[];
}

export interface RewriteViolation {
  kind: string;
  /** 사람용 요약(보고서). */
  detail: string;
  /** 불변식 위반의 원값 — 재작성 모델에 돌려줄 피드백은 detail 을 되파싱하지 않고 이것을 쓴다. */
  missing?: string[];
  added?: string[];
}
export interface RewriteCheck { ok: boolean; violations: RewriteViolation[] }

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

/** 펜스 블록을 떼어 낸다 — 닫힘 없는 펜스는 끝까지 블록이다(lintWriting 의 proseOf 와 같은 취급). */
function splitFences(text: string): { blocks: string[]; rest: string } {
  const ls = text.split("\n");
  const blocks: string[] = [];
  const rest: string[] = [];
  let i = 0;
  while (i < ls.length) {
    const m = FENCE_OPEN_RE.exec(ls[i]);
    if (!m) { rest.push(ls[i]); i++; continue; }
    const fence = m[1];
    const closeRe = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
    let j = i + 1;
    while (j < ls.length && !closeRe.test(ls[j])) j++;
    const end = Math.min(j, ls.length - 1);
    blocks.push(ls.slice(i, end + 1).join("\n"));
    rest.push("");
    i = end + 1;
  }
  return { blocks, rest: rest.join("\n") };
}

const INLINE_CODE_RE = /(`+)(?!`)([^\n]*?[^`\n])\1(?!`)/g;

function splitInline(text: string): { codes: string[]; rest: string } {
  const codes: string[] = [];
  const rest = text.replace(INLINE_CODE_RE, (all) => { codes.push(all); return " "; });
  return { codes, rest };
}

// 번호 목록 표지(«1. », «2) »)는 사실이 아니라 모양이다 — arrow_chain 을 고치면 번호 목록이 생기는 게 정상이다.
//  세 자리까지만 표지로 본다 — «2024. 그 해에» 같은 연도가 줄머리에 오면 표지가 아니라 사실이다.
//  헤딩·볼드를 연 바로 뒤(«### 1) », «**1.**»)도 줄머리다 — 헤딩 기호·볼드를 정리하며 번호를 떼는 건 모양 변화다(howto-263 계열).
//  «2\. » 는 목록으로 렌더되지 않게 이스케이프한 같은 표지다 — 볼드 번호(«**2. »)를 풀 때 모델이 이렇게 쓴다(holiday-schedule-adjustment).
const LIST_MARKER_RE = /^(\s*(?:#{1,6}\s+)?(?:\*\*|__)?)\d{1,3}\\?[.)](?=\s|\*\*|__|$)/gm;
// 천단위 쉼표는 뒤에 정확히 세 자리일 때만 토큰에 붙인다 — «1,2,3» 같은 나열은 숫자 셋이다.
//  앞의 '-' 는 글자·숫자 뒤가 아닐 때만 부호로 본다 — «-5도»→«5도» 는 뜻이 뒤집히지만 날짜·범위의 '-' 는 부호가 아니다.
const NUMBER_RE = /(?:(?<![\p{L}\p{N}])-)?\d+(?:,\d{3}(?!\d))*(?:\.\d+)*(?:-\d+)*%?/gu;
// 전각 숫자는 반각으로 맞춘 뒤 센다 — «５»→«5» 는 같은 값이고 «５»→«３» 은 다른 값이다.
const toHalfWidth = (s: string): string => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
// «2026년 9월 17일»·«2026년 9월» 은 «2026-09-17»·«2026-09» 와 같은 날이다 — 표기만 바꾼 재작성을 숫자 변경으로 떨어뜨리지 않는다.
const normalizeKoDates = (s: string): string => s
  .replace(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/g, (_, y, m, d) => `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`)
  .replace(/(\d{4})년\s*(\d{1,2})월(?!\s*\d)/g, (_, y, m) => `${y}-${m.padStart(2, "0")}`);
const URL_RE = /https?:\/\/[^\s<>()[\]{}"'`]+/g;
// 마크다운 링크의 대상(상대 경로·앵커 포함) — http 가 아닌 링크도 가리키는 곳이 바뀌면 뜻이 바뀐다.
const MD_LINK_TARGET_RE = /\]\(([^)\s]+)\)/g;
const WIKILINK_RE = /!?\[\[([^\]\n]+?)\]\]/g;
const REF_MRPR_RE = /\b(MR|PR)\s*[!#]?\s*(\d+)\b/gi;
const REF_BANG_RE = /(?<![\w!])!(\d+)\b/g;
const REF_HASH_RE = /(?<![\w&#])#(\d{3,})\b/g;
const TABLE_SEP_RE = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?$/;

const sortedMulti = (xs: string[]): string[] => [...xs].sort();
const sortedSet = (xs: string[]): string[] => [...new Set(xs)].sort();

function trimUrl(u: string): string {
  return u.replace(/[.,;:!?]+$/, "");
}

// 표는 행 단위로 본다 — 셀 다중집합이면 «A|3, B|5» 를 «A|5, B|3» 으로 바꿔도 같게 보인다. 행 순서는 형식이지만
//  한 행 안의 값 배정은 사실이다. 빈 셀도 자리로 남겨 열이 밀리는 것을 잡는다.
function tableRowsOf(prose: string): string[] {
  const out: string[] = [];
  for (const raw of prose.split("\n")) {
    const l = raw.trim();
    if (!l.startsWith("|") || TABLE_SEP_RE.test(l)) continue;
    const inner = l.replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
    const cells = inner.split(/(?<!\\)\|/).map((cell) => cell.replace(/\*\*/g, "").trim());
    if (cells.some((c) => c)) out.push(cells.join(" | "));
  }
  return out;
}

function proseParts(doc: RewriteDoc): { blocks: string[]; codes: string[]; prose: string } {
  const text = `${String(doc.title ?? "")}\n${String(doc.body_md ?? "")}`;
  const f = splitFences(text);
  const inl = splitInline(f.rest);
  return { blocks: f.blocks, codes: inl.codes, prose: inl.rest };
}

// 제목과 본문을 합쳐 본다 — 제목에서 뺀 날짜·MR 번호는 본문으로 옮겨지는 게 정상이라, 따로 세면 전부 위반이 된다.
export function extractInvariants(doc: RewriteDoc): Invariants {
  const { blocks, codes, prose } = proseParts(doc);
  const numbersText = normalizeKoDates(toHalfWidth(prose)).replace(LIST_MARKER_RE, "$1");
  const refs: string[] = [];
  for (const m of prose.matchAll(REF_MRPR_RE)) refs.push(`${m[1].toUpperCase() === "MR" ? "!" : "#"}${m[2]}`);
  for (const m of prose.matchAll(REF_BANG_RE)) refs.push(`!${m[1]}`);
  for (const m of prose.matchAll(REF_HASH_RE)) refs.push(`#${m[1]}`);
  const wikilinks: string[] = [];
  for (const m of prose.matchAll(WIKILINK_RE)) {
    const target = m[1].split("|")[0].split("#")[0].trim();
    if (target) wikilinks.push(target);
  }
  return {
    codeBlocks: sortedMulti(blocks),
    inlineCode: sortedMulti(codes),
    numbers: sortedMulti(numbersText.match(NUMBER_RE) ?? []),
    urls: sortedSet([...(prose.match(URL_RE) ?? []).map(trimUrl), ...[...prose.matchAll(MD_LINK_TARGET_RE)].map((m) => trimUrl(m[1]))]),
    wikilinks: sortedSet(wikilinks),
    refs: sortedSet(refs),
    tableRows: sortedMulti(tableRowsOf(prose)),
  };
}

/** 코드를 뺀 서술 분량 — 공백은 세지 않는다(줄바꿈·공백을 정리하는 건 분량 변화가 아니다). */
export function proseChars(doc: RewriteDoc): number {
  return [...proseParts(doc).prose.replace(/\s+/g, "")].length;
}

function multisetDiff(a: string[], b: string[]): { missing: string[]; added: string[] } {
  const count = new Map<string, number>();
  for (const x of a) count.set(x, (count.get(x) ?? 0) + 1);
  const added: string[] = [];
  for (const x of b) {
    const n = count.get(x) ?? 0;
    if (n > 0) count.set(x, n - 1);
    else added.push(x);
  }
  const missing: string[] = [];
  for (const [x, n] of count) for (let i = 0; i < n; i++) missing.push(x);
  return { missing, added };
}

function setDiff(a: string[], b: string[]): { missing: string[]; added: string[] } {
  const sa = new Set(a), sb = new Set(b);
  return { missing: [...sa].filter((x) => !sb.has(x)), added: [...sb].filter((x) => !sa.has(x)) };
}

const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 80)}…` : s).replace(/\s+/g, " ");

function diffDetail(d: { missing: string[]; added: string[] }): string {
  const parts = [
    ...d.missing.slice(0, DETAIL_MAX).map((x) => `-${clip(x)}`),
    ...d.added.slice(0, DETAIL_MAX).map((x) => `+${clip(x)}`),
  ];
  return parts.join(", ");
}

// 배치는 조직이 안내를 켰는지와 별개로 돈다 — 꺼진 형식으로 판정하면 lintWriting 이 늘 빈 결과라 전부 통과한다.
const forceEnabled = (fmt: WritingFormat): WritingFormat => (fmt.enabled ? fmt : { ...fmt, enabled: true });

// 숫자·인라인 코드는 개수까지 본다 — 집합으로만 보면 «대기 30초» 를 문서 다른 곳에 있는 «3» 으로 바꿔치기해도 통과한다.
//  다만 제목·맨 앞 H1·새 첫 줄(결론)에 나오는 값은 개수 차이를 허용한다: 결론에 원문의 값(«EC2»·날짜)을 한 번 더 쓰거나,
//  제목과 H1 에 두 번 있던 날짜를 본문에 한 번만 옮기는 것은 사실 변경이 아니다(dry-run 20건 중 거짓 거부 3건의 원인).
//  허용은 개수 차이뿐이다 — 원문에 없던 값이 생기거나 있던 값이 통째로 사라지면 여전히 위반이다.
const MULTISET_FIELDS = ["codeBlocks", "tableRows"] as const;
const COUNTED_FIELDS = ["numbers", "inlineCode"] as const;
const SET_FIELDS = ["urls", "wikilinks", "refs"] as const;

function firstLines(body: string, withNextAfterHeading: boolean): string {
  const ls = String(body ?? "").split("\n").map((l) => l.trim()).filter((l) => l);
  if (!ls.length) return "";
  if (withNextAfterHeading && /^#{1,6}\s/.test(ls[0]) && ls[1]) return `${ls[0]}\n${ls[1]}`;
  return ls[0];
}

const countOf = (xs: string[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};

/**
 * 개수 차이의 허용량 — 방향별로, 그 자리에 나온 개수까지만.
 *  added: 재작성본의 제목·첫 줄(결론)에 나온 개수까지(원문에 있던 값일 때만) — 결론에서 값을 되풀이하는 경우.
 *  missing: 원문의 제목·맨 앞 H1 에 나온 개수까지(재작성본에 남아 있을 때만) — 제목과 H1 에 두 번 있던 값을 한 번으로 옮기는 경우.
 *  ⚠ 값 단위로 통째로 허용하면 첫 줄에 나온 값끼리 문서 어디서든 바꿔치기가 통과한다(리뷰 반례: 원문 첫 문단 안의 30→3).
 */
function allowance(before: RewriteDoc, after: RewriteDoc, field: (typeof COUNTED_FIELDS)[number]): { added: Map<string, number>; missing: Map<string, number> } {
  const h1 = firstLines(before.body_md ?? "", false);
  const head = extractInvariants({ title: before.title, body_md: /^#\s/.test(h1) ? h1 : "" })[field];
  const lead = extractInvariants({ title: after.title, body_md: firstLines(after.body_md ?? "", true) })[field];
  return { added: countOf(lead), missing: countOf(head) };
}

/** 다중집합 차이에서 허용량만큼 덜어낸다. 허용은 반대편에 그 값이 남아 있을 때만이다. */
function subtractAllowance(xs: string[], allow: Map<string, number>, otherSide: Set<string>): string[] {
  const left = new Map(allow);
  const out: string[] = [];
  for (const x of xs) {
    const n = left.get(x) ?? 0;
    if (n > 0 && otherSide.has(x)) { left.set(x, n - 1); continue; }
    out.push(x);
  }
  return out;
}

const codeInner = (code: string): string => code.replace(/^(`+)([\s\S]*)\1$/, "$2").trim();
// 낱말 경계로만 센다 — 부분문자열로 세면 지운 `id` 가 평문 "identity" 로, 새 `a` 가 사라진 "data" 로 상쇄돼
//  코드 소실이 면제된다. 한글 조사는 오른쪽에만 붙으므로 오른쪽은 ASCII 경계만 본다(retry_max이다 는 계속 센다).
const occurrences = (hay: string, needle: string): number =>
  needle ? (hay.match(new RegExp(`(?<![\\p{L}\\p{N}_])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`, "gu")) ?? []).length : 0;

/**
 * 백틱만 씌우거나 벗긴 인라인 코드는 위반에서 뺀다 — 글자는 그대로고 코드 표기만 바뀐 것이다(compute 의 +`OCR-A`).
 *  면제는 반대편 서술에서 같은 글자가 그만큼 줄었을 때(씌움) 또는 늘었을 때(벗김)뿐이다 — 코드와 평문을 합친 등장 횟수가
 *  보존돼야 한다. 그래야 원문에 한 번 있던 평문을 두 군데 코드로 만드는 것, 코드 안 글자를 바꾸는 것(`\"`→`"`)은 계속 잡힌다.
 */
function exemptBacktickOnly(before: RewriteDoc, after: RewriteDoc, missing: string[], added: string[]): { missing: string[]; added: string[] } {
  if (!missing.length && !added.length) return { missing, added };
  const pb = proseParts(before).prose, pa = proseParts(after).prose;
  const keep = (xs: string[], gain: (s: string) => number): string[] => {
    const used = new Map<string, number>();
    return xs.filter((x) => {
      const s = codeInner(x);
      const n = used.get(s) ?? 0;
      // 구두점뿐인 코드(`.`·`/`·`->`)는 낱말 경계가 의미 없어, 공백·괄호 사이에 같은 기호가 하나만 늘어도(A / B, (참고).) 상쇄되므로 면제하지 않는다.
      if (s && /[\p{L}\p{N}]/u.test(s) && n < gain(s)) { used.set(s, n + 1); return false; }
      return true;
    });
  };
  return {
    missing: keep(missing, (s) => occurrences(pa, s) - occurrences(pb, s)),
    added: keep(added, (s) => occurrences(pb, s) - occurrences(pa, s)),
  };
}

/**
 * 형식 규칙을 빼고 «사실이 그대로인가» 만 본다 — 불변식과 분량. 섹션 단위 재작성은 조각마다 이것으로 판정하고,
 *  형식 규칙(첫 줄 결론·강조 개수 등)은 문서 전체에서만 뜻이 있어 다시 합친 뒤에 본다.
 */
export function checkInvariants(
  before: RewriteDoc, after: RewriteDoc,
  opts: { requireTitle?: boolean; allowLeadRepeat?: boolean } = {},
): RewriteViolation[] {
  const violations: RewriteViolation[] = [];
  if ((opts.requireTitle ?? true) && !String(after.title ?? "").trim()) violations.push({ kind: "empty-title", detail: "재작성본의 제목이 비었다" });

  const ib = extractInvariants(before);
  const ia = extractInvariants(after);
  for (const k of MULTISET_FIELDS) {
    const d = multisetDiff(ib[k], ia[k]);
    if (d.missing.length || d.added.length) violations.push({ kind: `invariant:${k}`, detail: diffDetail(d), missing: d.missing, added: d.added });
  }
  for (const k of COUNTED_FIELDS) {
    const d = multisetDiff(ib[k], ia[k]);
    // 중간 조각은 제목·결론이 없는 자리라 허용하지 않는다(allowLeadRepeat=false).
    const al = (opts.allowLeadRepeat ?? true) ? allowance(before, after, k) : { added: new Map(), missing: new Map() };
    const bset = new Set(ib[k]), aset = new Set(ia[k]);
    let missing = subtractAllowance(d.missing, al.missing, aset);
    let added = subtractAllowance(d.added, al.added, bset);
    // 양쪽을 동시에 면제하지 않는다 — 누락 하나(제목 허용)와 추가 하나(첫 줄 허용)를 함께 면제하면 그건 X→Y 치환이다
    //  (예: 제목의 배포일을 첫 줄로 옮기며 본문 날짜를 바꿈). 정당한 경우는 늘 한 방향뿐이다.
    if (missing.length < d.missing.length && added.length < d.added.length) { missing = d.missing; added = d.added; }
    // 백틱 면제는 이 가드 밖이라 양쪽을 함께 면제할 수 있다 — 글자 수가 보존된 표기 교환(`foo` 와 bar → foo 와 `bar`)이라 치환이 아니다.
    if (k === "inlineCode") ({ missing, added } = exemptBacktickOnly(before, after, missing, added));
    if (missing.length || added.length) violations.push({ kind: `invariant:${k}`, detail: diffDetail({ missing, added }), missing, added });
  }
  for (const k of SET_FIELDS) {
    const d = setDiff(ib[k], ia[k]);
    if (d.missing.length || d.added.length) violations.push({ kind: `invariant:${k}`, detail: diffDetail(d), missing: d.missing, added: d.added });
  }

  const cb = proseChars(before), ca = proseChars(after);
  if (cb > 0 && ca < cb * SHRINK_MIN_RATIO) {
    violations.push({ kind: "shrink", detail: `서술 분량 ${cb} → ${ca}자(${Math.round((ca / cb) * 100)}%, 하한 ${SHRINK_MIN_RATIO * 100}%)` });
  }
  return violations;
}

export function checkRewrite(before: RewriteDoc, after: RewriteDoc, fmt: WritingFormat): RewriteCheck {
  const f = forceEnabled(fmt);
  const violations: RewriteViolation[] = checkInvariants(before, after);

  const lb = new Set(lintWriting(before, f).map((x) => x.rule));
  const la = lintWriting(after, f);
  const seen = new Set<string>();
  for (const x of la) {
    if (seen.has(x.rule)) continue;
    seen.add(x.rule);
    if (AUTO_FIX.has(x.rule)) violations.push({ kind: `lint:${x.rule}`, detail: x.message });
    if (!lb.has(x.rule)) violations.push({ kind: `new:${x.rule}`, detail: x.message });
  }

  return { ok: violations.length === 0, violations };
}

export interface EligibilityInput {
  provenance: string | null | undefined;
  lifecycle: string | null | undefined;
  is_folder: boolean | null | undefined;
  body_md: string | null | undefined;
  title: string | null | undefined;
  updated_at: string | null | undefined;
}

export type IneligibleReason = "provenance" | "lifecycle" | "folder" | "recently_edited" | "nothing_to_fix";

export type RewriteMode = "whole" | "sections";

export interface Eligibility {
  eligible: boolean;
  reason?: IneligibleReason;
  targetRules: WritingRuleId[];
  /** 걸린 AUTO_FIX 규칙의 안내 — 재작성 프롬프트에 그대로 싣는다. */
  findings: WritingFinding[];
  /** whole = 통째로 재작성, sections = 섹션 단위로 나눠 재작성(긴 문서). 대상이 아니면 없다. */
  mode?: RewriteMode;
}

export interface EligibilityOptions {
  /** 마지막 변경이 이 배치 자신의 반영으로 확인됐다(isOwnLastEdit) — 사람 편집 보호 창을 적용하지 않는다. */
  lastEditIsOwn?: boolean;
}

export interface HistoryVersions {
  version_before: number | null | undefined;
  version_after: number | null | undefined;
}

/**
 * 최신 변경 이력 한 줄이 배치가 savedOver 판 위에 저장한 바로 그 반영인지.
 *  그 뒤 누가 한 번이라도 고쳤으면 최신 줄의 version_before 가 savedOver 가 아니게 되고,
 *  이력에 안 잡히는 변경으로 판이 올랐으면 version_after 가 현재 판과 어긋난다 — 둘 다 사람 편집 가능성으로 보고 보호한다.
 *  판을 올리지 않고 updated_at 만 바꾸는 메타 변경(set_lifecycle·set_wiki·move·정렬)은 통과한다 — 재작성이 덮는 본문·제목이 아니다.
 *  새 메타 변경이 판을 올리기 시작하면 이 판정은 저절로 보수적이 된다.
 *  저장 주체(actor)로 가르지 않는 건 배치가 사람 토큰으로 저장해 actor 가 사람과 같기 때문이다.
 */
export function isOwnLastEdit(latest: HistoryVersions | null | undefined, savedOver: number | null | undefined, current: number | null | undefined): boolean {
  if (!latest || savedOver == null || current == null) return false;
  return latest.version_before === savedOver && latest.version_after === current;
}

/** 적용 리포트(jsonl 줄들)에서 이름별로 배치가 덮어쓴 판 — 여러 번 반영했으면 가장 나중 판이다. */
export function ownEditVersions(lines: Iterable<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of lines) {
    if (!line.trim()) continue;
    let r: { name?: unknown; status?: unknown; version?: unknown };
    try { r = JSON.parse(line); } catch { continue; } // 중단 순간 반쯤 쓰인 마지막 줄
    if (r.status !== "applied" || typeof r.name !== "string" || !Number.isInteger(r.version)) continue;
    const v = r.version as number;
    const prev = out.get(r.name);
    if (prev === undefined || v > prev) out.set(r.name, v);
  }
  return out;
}

export function isEligible(k: EligibilityInput, fmt: WritingFormat, now: Date | number, opts: EligibilityOptions = {}): Eligibility {
  const no = (reason: IneligibleReason): Eligibility => ({ eligible: false, reason, targetRules: [], findings: [] });
  // 외부 미러(observed)는 원본 소유가 밖이라 여기서 고쳐도 다음 동기화가 덮는다.
  if (k.provenance !== "authored") return no("provenance");
  if (k.lifecycle !== "active") return no("lifecycle");
  if (k.is_folder) return no("folder");
  const body = String(k.body_md ?? "");
  // 방금 사람이 고친 글은 그 사람이 아직 손보는 중일 수 있다 — 자동 재작성이 편집을 덮으면 안 된다.
  //  시각을 못 읽으면 최근으로 본다(보수적으로 건너뛴다). 배치 자신의 반영은 보호할 사람 편집이 아니다 —
  //  그것까지 세면 결정적 정리(--autofix) 직후 24시간 동안 LLM 재작성이 전부 막힌다(2026-10-01 적용 1,839건).
  const nowMs = typeof now === "number" ? now : now.getTime();
  const upd = k.updated_at ? Date.parse(k.updated_at) : NaN;
  if (!opts.lastEditIsOwn && (!Number.isFinite(upd) || nowMs - upd < RECENT_EDIT_MS)) return no("recently_edited");
  const findings = lintWriting({ title: k.title, body_md: body }, forceEnabled(fmt)).filter((x) => AUTO_FIX.has(x.rule));
  if (!findings.length) return no("nothing_to_fix");
  // 긴 문서는 통째로 재작성하면 대조 정확도가 떨어져 섹션 단위로 나눠 고친다.
  const mode: RewriteMode = [...body].length > REWRITE_BODY_MAX_CHARS ? "sections" : "whole";
  return { eligible: true, targetRules: [...new Set(findings.map((x) => x.rule))], findings, mode };
}

export interface SectionOutcome { status: "skipped" | "rejected"; reason: "no_section_target" | "no_section_passed" }

/**
 * 섹션 재작성에서 재작성된 조각이 하나도 없을 때의 결과. 조각이 전부 clean·oversized 면 LLM 에 보낸 조각이 없으니
 *  거부가 아니라 대상 없음이다 — 문서 단위 규칙(lead_missing)이 걸렸어도 첫 조각이 한도를 넘으면 이렇게 된다
 *  (kcis-rule-2021-9-appendix-a). 시도한 조각(kept)이 하나라도 있으면 거부다. 재작성된 조각이 있으면 null.
 */
export function unrewrittenOutcome(report: ReadonlyArray<{ section: string }>): SectionOutcome | null {
  if (report.some((r) => r.section === "rewritten")) return null;
  return report.some((r) => r.section === "kept")
    ? { status: "rejected", reason: "no_section_passed" }
    : { status: "skipped", reason: "no_section_target" };
}

export interface DocSection {
  /** 원문 조각 그대로. 모든 조각을 이으면 원문과 글자 단위로 같다. */
  text: string;
  /** 조각을 여는 헤딩 줄(첫 조각이 헤딩 없이 시작하면 null). */
  heading: string | null;
  /** 한 번 더 나눠도 한도를 넘는 조각 — 재작성하지 않고 그대로 둔다. */
  oversized: boolean;
}

const HEADING_RE = (level: number) => new RegExp(`^ {0,3}#{${level}}(?!#)\\s`);

/** 코드펜스 밖에서 주어진 수준의 헤딩이 시작되는 줄 번호들. */
function headingLines(lines: string[], level: number): number[] {
  const out: number[] = [];
  let fence: string | null = null;
  const re = HEADING_RE(level);
  lines.forEach((l, i) => {
    const m = l.match(FENCE_OPEN_RE);
    if (fence) { if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null; return; }
    if (m) { fence = m[1]; return; }
    if (re.test(l)) out.push(i);
  });
  return out;
}

function cutAt(lines: string[], starts: number[]): string[][] {
  const cuts = [0, ...starts.filter((i) => i > 0), lines.length];
  const out: string[][] = [];
  for (let j = 0; j < cuts.length - 1; j++) if (cuts[j + 1] > cuts[j]) out.push(lines.slice(cuts[j], cuts[j + 1]));
  return out;
}

/**
 * 본문을 재작성 단위로 나눈다. «## » 헤딩마다 자르고, 한도를 넘는 조각은 그 안의 «### » 로 한 번 더 자른다.
 *  코드펜스 안의 «#» 줄은 헤딩이 아니다. 조각은 줄 단위로 자르며 줄바꿈을 그대로 보존한다.
 */
export function splitSections(body: string, maxChars: number): DocSection[] {
  const lines = body.split("\n");
  // 각 조각의 마지막 줄 뒤에 줄바꿈을 되붙여 이었을 때 원문이 되게 한다(마지막 조각만 원문 끝 그대로).
  const join = (ls: string[], isLast: boolean) => ls.join("\n") + (isLast ? "" : "\n");
  const top = cutAt(lines, headingLines(lines, 2));
  const pieces: string[][] = [];
  for (const chunk of top) {
    if ([...chunk.join("\n")].length <= maxChars) { pieces.push(chunk); continue; }
    const subs = cutAt(chunk, headingLines(chunk, 3));
    pieces.push(...subs);
  }
  return pieces.map((ls, i) => {
    const text = join(ls, i === pieces.length - 1);
    const first = ls[0] ?? "";
    const heading = /^ {0,3}#{1,6}\s/.test(first) ? first : null;
    return { text, heading, oversized: [...text].length > maxChars };
  });
}

// 첫 조각만 제목·첫 줄 결론을 맡는다 — 뒤 조각은 헤딩으로 시작하는 게 정상이고, 문서 길이는 조각이 판정할 일이 아니다.
const DOC_LEVEL_RULES = new Set<WritingRuleId>([
  "title_length", "title_leading_emoji", "title_date", "title_mr_ref", "title_status_mark", "title_multi_dash", "lead_missing",
]);

/** 이 조각에서 고칠 자동 정리 대상 위반. 첫 조각(index 0)은 제목과 함께 본다. */
export function sectionFindings(title: string | null | undefined, section: string, index: number, fmt: WritingFormat): WritingFinding[] {
  const f = forceEnabled(fmt);
  return lintWriting({ title: index === 0 ? title : null, body_md: section }, f)
    .filter((x) => AUTO_FIX.has(x.rule) && (index === 0 || !DOC_LEVEL_RULES.has(x.rule)));
}

/**
 * 중간 조각의 재작성본이 원문과 같은 수준의 헤딩으로 시작하는가 — 문서 구조(섹션 경계)를 지키는지 본다.
 *  헤딩 글자는 비교하지 않는다: 헤딩의 기호를 빼는 것(heading_symbol)이 이 조각이 고칠 일일 수 있다.
 */
export function sectionHeadingOk(heading: string | null, body: string): boolean {
  if (!heading) return true;
  const level = (heading.trim().match(/^#+/) ?? [""])[0].length;
  if (!level) return true;
  return new RegExp(`^ {0,3}#{${level}}(?!#)\\s`).test(body.replace(/^(?:[ \t]*\n)+/, ""));
}

// ── 의미 판정 환원 ──
// LLM 판정기는 두 글의 차이를 항목으로 적고, 항목마다 «사실이 달라졌나» 를 스스로 표시한다. 통과·탈락은 그 표시로만 가른다.
//  종전 판정은 missing·added·changed 배열이 비었는지로 갈라, 판정기가 «표현 요소라 사실 변화 아님» 이라고 적은 항목까지
//  탈락으로 셌다(top-16 dry-run 에서 의미 탈락 13건 중 다수). 표시는 두 신호가 맞을 때만 믿는다 — fact_changed 가 false 이고
//  category 가 expression 이거나, category 가 risk 이면서 riskGradePreserved 를 통과할 때만 비사실로 보고,
//  하나라도 빠지거나 어긋나면 사실 변화로 친다(판정기의 자기모순은 탈락 쪽으로).

export type MeaningKind = "missing" | "added" | "changed";
/** 사실 범주 — expression 만 비사실이다(risk 는 위험도 기호를 같은 등급 글로 옮긴 것만 예외, riskGradePreserved). meta 는 원문의 모양·편집 과정을 설명하는 문장으로, 원문에 없던 주장이라 사실 추가다. */
export const MEANING_CATEGORIES = ["claim", "number", "condition", "scope", "subject", "date", "certainty", "risk", "meta", "expression"] as const;
export type MeaningCategory = (typeof MEANING_CATEGORIES)[number];

export interface MeaningItem {
  kind: MeaningKind;
  /** 원문 쪽 대목(없으면 빈 문자열). 자리를 바꿔 물은 판정도 여기선 늘 원문이다. */
  a: string;
  /** 재작성본 쪽 대목. */
  b: string;
  category: MeaningCategory | "unknown";
  fact_changed: boolean;
  /** 판정기가 적은 fact_changed 그대로 — 위 fact_changed 는 범주 대조까지 거친 값이라, 이동 대조(meaningVerdict)는 이것을 본다. */
  judge_fact_changed: boolean;
  /** 원문 대목이 재작성본 전문에 그대로 있어 이동으로 받은 항목(meaningVerdict). */
  moved?: boolean;
  reason: string;
}

const KINDS = new Set<string>(["missing", "added", "changed"]);
const CATS = new Set<string>(MEANING_CATEGORIES);
const asText = (x: unknown): string => (x == null ? "" : typeof x === "string" ? x : JSON.stringify(x));

// 위험도 기호를 같은 등급의 글로 옮긴 것은 재작성 프롬프트가 시킨 변환이다. 그런데 판정기는 이 항목을 category=risk 로
//  분류하면서 reason 엔 «등급 유지»라고 적는 일이 잦았다(2026-10-03 E 재처리 측정: 위험도 항목 80개 중 65개).
//  판정기의 fact_changed=false 와 기계 대조(등급 표지의 순서·등급이 같고 기호가 실제로 글로 바뀌었다) 두 신호가
//  모두 맞을 때만 비사실로 본다. 기호를 지우기만 했거나 🔴 를 «주의» 로 낮춘 것은 등급 열이 어긋나 그대로 탈락한다.
// 등급 표지를 등장 순서대로 뽑아 «등급 열»로 비교한다 — 개수만 보면 이웃한 두 문장의 높음·중간이 서로 바뀐 재작성본도 통과한다.
//  🟠·🚨 는 프롬프트가 글 대응을 정하지 않았으니 그대로 남아야 하는 표지로 둔다(지우면 열 길이가 달라져 탈락).
const GRADE_TOKEN = /🔴|🟡|🟢|🟠|🚨|⚠\uFE0F?|위험도\s*[:：]\s*(?:높음|중간|낮음)|주의\s*[:：]/gu;
const gradeOf = (t: string): string =>
  /🔴|높음/u.test(t) ? "high" : /🟡|중간/u.test(t) ? "mid" : /🟢|낮음/u.test(t) ? "low"
    : t === "🟠" ? "orange" : t === "🚨" ? "siren" : "caution";
const isSymbol = (t: string): boolean => !/위험도|주의/u.test(t);

/** 원문의 위험도 기호가 재작성본에서 같은 등급의 글로 옮겨졌고, 등급 표지의 순서·등급이 그대로인가. */
export function riskGradePreserved(orig: string, rewritten: string): boolean {
  const a = orig.match(GRADE_TOKEN) ?? [];
  const b = rewritten.match(GRADE_TOKEN) ?? [];
  if (a.length !== b.length || a.some((t, i) => gradeOf(t) !== gradeOf(b[i]))) return false;
  return a.filter(isSymbol).length > b.filter(isSymbol).length;
}

/**
 * 판정기 답 하나를 항목 목록으로 편다. swapped 는 A·B 자리를 바꿔 물은 판정이다 — missing↔added 와 a↔b 를 되돌린다.
 *  답의 모양이 아니면 null(파싱 실패). 옛 모양 {missing, added, changed} 는 표시가 없으니 전부 사실 변화로 받는다.
 */
export function normalizeJudgement(raw: unknown, swapped: boolean): MeaningItem[] | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  let items: MeaningItem[];
  if (Array.isArray(o.items)) {
    items = o.items.map((it): MeaningItem => {
      const r = (it && typeof it === "object" ? it : { a: it }) as Record<string, unknown>;
      const kind = (KINDS.has(String(r.kind)) ? String(r.kind) : "changed") as MeaningKind;
      const category = CATS.has(String(r.category)) ? (String(r.category) as MeaningCategory) : "unknown";
      // 자리를 바꿔 물은 판정은 r.a 가 재작성본이다 — 등급 대조는 늘 원문→재작성본 방향으로 한다.
      const [orig, rewritten] = swapped ? [asText(r.b), asText(r.a)] : [asText(r.a), asText(r.b)];
      const nonFact = r.fact_changed === false
        && (category === "expression" || (category === "risk" && riskGradePreserved(orig, rewritten)));
      return { kind, a: asText(r.a), b: asText(r.b), category, fact_changed: !nonFact, judge_fact_changed: r.fact_changed !== false, reason: asText(r.reason) };
    });
  } else if (["missing", "added", "changed"].every((k) => Array.isArray(o[k]))) {
    items = (["missing", "added", "changed"] as const).flatMap((kind) => (o[kind] as unknown[]).map((x): MeaningItem => ({
      kind, a: kind === "added" ? "" : asText(x), b: kind === "added" ? asText(x) : "", category: "unknown", fact_changed: true, judge_fact_changed: true, reason: "",
    })));
  } else return null;
  if (!swapped) return items;
  const flip: Record<MeaningKind, MeaningKind> = { missing: "added", added: "missing", changed: "changed" };
  return items.map((x) => ({ ...x, kind: flip[x.kind], a: x.b, b: x.a }));
}

export interface MeaningVerdict {
  pass: boolean;
  /** 사실 변화 항목 — 하나라도 있으면 탈락이고, 재작성 모델에 되돌려 줄 것도 이것뿐이다. */
  factual: MeaningItem[];
  /** 판정기가 표현 차이로 표시한 항목과 이동으로 받은 항목 — 보고서에만 남긴다. */
  ignored: MeaningItem[];
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
export const MOVED_MIN_CHARS = 8;
// 이동으로 받을 수 있는 범주. 서술 주장(claim·condition·scope·certainty)은 원문 문장을 그대로 두고 상반 주장을 덧붙여도
//  원문 대목이 남으므로 이동 대조로는 가를 수 없다 — 관측된 오탐(제목 날짜·부제를 첫 줄로 옮김)의 범주만 연다.
const MOVABLE_CATEGORIES = new Set<string>(["meta", "date", "subject"]);

/**
 * 판정 여러 번의 항목을 합쳐 통과를 가른다. 통과는 요구 횟수를 다 채우고 사실 변화가 하나도 없을 때뿐이다.
 *  rewritten(재작성본 전문)을 주면 이동 대조를 한다: 판정기가 fact_changed=false 라 했고 원문 쪽 대목이 재작성본에 공백만 빼고
 *  그대로 있으면 meta·date·subject 범주에 한해 «옮겨졌을 뿐» 으로 받는다. 판정기는 제목 날짜·부제를 첫 줄로 옮긴 것을
 *  reason 엔 «값은 그대로» 라 적고 category 는 meta 로 달아 떨어뜨렸다(r2 재처리, cis-socket-buildchain 등 5건).
 *  reason 은 믿지 않고 원문 글자가 재작성본에 남았는지로만 확인한다 — 마크다운 기호까지 맞아야 하니 볼드·헤딩을 벗긴 대목은 못 건진다.
 */
export function meaningVerdict(runs: MeaningItem[][], requiredRuns: number, rewritten?: RewriteDoc): MeaningVerdict {
  const hay = rewritten ? squash(`${String(rewritten.title ?? "")}\n${String(rewritten.body_md ?? "")}`) : "";
  // 짧은 값("40"·"높음")은 문서 다른 자리에 같은 글자가 흔해 치환이 이동으로 새므로 대조하지 않는다.
  const isMoved = (x: MeaningItem): boolean =>
    !!hay && x.fact_changed && !x.judge_fact_changed && MOVABLE_CATEGORIES.has(x.category)
    && squash(x.a).length >= MOVED_MIN_CHARS && hay.includes(squash(x.a));
  const all = runs.flat().map((x) => (isMoved(x) ? { ...x, fact_changed: false, moved: true } : x));
  const factual = all.filter((x) => x.fact_changed);
  const ignored = all.filter((x) => !x.fact_changed);
  return { pass: runs.length >= requiredRuns && factual.length === 0, factual, ignored };
}

const KIND_WORD: Record<MeaningKind, string> = {
  missing: "원문의 이 내용이 빠졌다(원문대로 되살려라)",
  added: "원문에 없는 내용이 생겼다(지워라)",
  changed: "뜻이 바뀌었다(원문대로 되돌려라)",
};

/** 의미 탈락을 재작성 모델에 돌려줄 문장으로 — 사실 변화 항목만 싣는다. 표현 차이까지 주면 모델이 그걸 «되살리려고» 메타 문장을 지어낸다. */
export function meaningFeedback(items: MeaningItem[]): string[] {
  return items.filter((x) => x.fact_changed).map((x) => {
    const parts = [
      x.a ? `원문: ${x.a}` : "",
      x.b ? `재작성본: ${x.b}` : "",
      x.reason ? `이유: ${x.reason}` : "",
    ].filter(Boolean);
    return `${KIND_WORD[x.kind]} [${x.category}] ${parts.join(" / ")}`;
  });
}
