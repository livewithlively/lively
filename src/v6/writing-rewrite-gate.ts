// 서술 형식 자동 정리의 의미 보존 게이트 — LLM 이 기존 지식의 형식만 고쳐 쓴 결과를 저장해도 되는지 기계로 판정한다.
//
// 왜 필요: 재작성은 LLM 이 하므로 형식을 고치다 수치·식별자·링크를 빠뜨리거나 지어낼 수 있다. 지식은 다른 구성원의
//  세션에 사실로 주입되므로, 뜻이 바뀐 글이 «형식이 좋아졌다»는 이유로 저장되면 원문보다 해롭다. 그래서 LLM 판정 앞에
//  싸고 결정적인 불변식(코드·수치·링크·표 값은 한 글자도 안 바뀐다)을 둬, 여기서 떨어진 건 LLM 에 묻지도 않는다.
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
//  긴 글은 사람이 나누는 게 먼저다.
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

export interface RewriteViolation { kind: string; detail: string }
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
const LIST_MARKER_RE = /^(\s*)\d{1,3}[.)](?=\s)/gm;
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
    inlineCode: sortedSet(codes),
    numbers: sortedSet(numbersText.match(NUMBER_RE) ?? []),
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

// 숫자·인라인 코드는 집합으로 본다 — 첫 줄 결론에 원문의 값(«EC2»·날짜)을 한 번 더 쓰거나 제목과 H1 에 두 번 있던 날짜를
//  본문에 한 번만 옮기는 것은 사실 변경이 아닌데, 다중집합으로 세면 전부 거부됐다(dry-run 20건 중 거짓 거부 3건).
//  값이 사라지거나 없던 값이 생기는 것은 집합으로도 잡힌다. 코드블록과 표 행은 통째로 한 단위라 개수까지 본다.
const MULTISET_FIELDS = ["codeBlocks", "tableRows"] as const;
const SET_FIELDS = ["inlineCode", "numbers", "urls", "wikilinks", "refs"] as const;

export function checkRewrite(before: RewriteDoc, after: RewriteDoc, fmt: WritingFormat): RewriteCheck {
  const f = forceEnabled(fmt);
  const violations: RewriteViolation[] = [];

  if (!String(after.title ?? "").trim()) violations.push({ kind: "empty-title", detail: "재작성본의 제목이 비었다" });

  const ib = extractInvariants(before);
  const ia = extractInvariants(after);
  for (const k of MULTISET_FIELDS) {
    const d = multisetDiff(ib[k], ia[k]);
    if (d.missing.length || d.added.length) violations.push({ kind: `invariant:${k}`, detail: diffDetail(d) });
  }
  for (const k of SET_FIELDS) {
    const d = setDiff(ib[k], ia[k]);
    if (d.missing.length || d.added.length) violations.push({ kind: `invariant:${k}`, detail: diffDetail(d) });
  }

  const cb = proseChars(before), ca = proseChars(after);
  if (cb > 0 && ca < cb * SHRINK_MIN_RATIO) {
    violations.push({ kind: "shrink", detail: `서술 분량 ${cb} → ${ca}자(${Math.round((ca / cb) * 100)}%, 하한 ${SHRINK_MIN_RATIO * 100}%)` });
  }

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

export type IneligibleReason = "provenance" | "lifecycle" | "folder" | "too_long" | "recently_edited" | "nothing_to_fix";

export interface Eligibility {
  eligible: boolean;
  reason?: IneligibleReason;
  targetRules: WritingRuleId[];
  /** 걸린 AUTO_FIX 규칙의 안내 — 재작성 프롬프트에 그대로 싣는다. */
  findings: WritingFinding[];
}

export function isEligible(k: EligibilityInput, fmt: WritingFormat, now: Date | number): Eligibility {
  const no = (reason: IneligibleReason): Eligibility => ({ eligible: false, reason, targetRules: [], findings: [] });
  // 외부 미러(observed)는 원본 소유가 밖이라 여기서 고쳐도 다음 동기화가 덮는다.
  if (k.provenance !== "authored") return no("provenance");
  if (k.lifecycle !== "active") return no("lifecycle");
  if (k.is_folder) return no("folder");
  const body = String(k.body_md ?? "");
  if ([...body].length > REWRITE_BODY_MAX_CHARS) return no("too_long");
  // 방금 사람이 고친 글은 그 사람이 아직 손보는 중일 수 있다 — 자동 재작성이 편집을 덮으면 안 된다.
  //  시각을 못 읽으면 최근으로 본다(보수적으로 건너뛴다).
  const nowMs = typeof now === "number" ? now : now.getTime();
  const upd = k.updated_at ? Date.parse(k.updated_at) : NaN;
  if (!Number.isFinite(upd) || nowMs - upd < RECENT_EDIT_MS) return no("recently_edited");
  const findings = lintWriting({ title: k.title, body_md: body }, forceEnabled(fmt)).filter((x) => AUTO_FIX.has(x.rule));
  if (!findings.length) return no("nothing_to_fix");
  return { eligible: true, targetRules: [...new Set(findings.map((x) => x.rule))], findings };
}
