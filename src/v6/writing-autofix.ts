// 서술 형식 결정적 자동 정리 — LLM 없이 기계적으로 고칠 수 있는 규칙만 고친다.
//
// 왜 따로 두나: LLM 재작성은 의미 판정에서 자주 떨어지고 호출 비용이 크다. 그런데 서버가 저장을 거부하는 규칙 중
//  제목 기호·날짜·MR 번호와 헤딩 기호는 «무엇을 지우고 어디로 옮기나» 가 글자만 보고 정해진다. 이 다섯은 여기서 고치고,
//  나머지 규칙은 건드리지 않는다(LLM 재작성 몫).
//
// 탐지는 writing-lint.ts 의 정규식을 그대로 쓴다 — 따로 두면 «고쳤는데 여전히 걸림» 이나 «안 걸린 곳을 고침» 이 생긴다.
//  고친 뒤엔 lintWriting 으로 다시 재서, 대상 규칙이 남으면 그 단계는 되돌린다(고친 척하지 않는다).
// 순수 함수다(DB·네트워크 없음).
import { type WritingFormat, type WritingRuleId, ruleLevel } from "../org/policies/writing-format.js";
import {
  DATE_RE, FENCED_CODE_RES, HEADING_LINE_RE, INLINE_CODE_RE, MR_REF_RE, PICTO_RE, PROSE_LINE_MAX, SIGNAL_SYMBOL_RE, lintWriting,
} from "./writing-lint.js";
import type { RewriteViolation } from "./writing-rewrite-gate.js";

export const AUTOFIX_RULE_IDS = [
  "title_leading_emoji", "title_status_mark", "title_date", "title_mr_ref", "heading_symbol",
] as const satisfies readonly WritingRuleId[];
export type AutofixRuleId = (typeof AUTOFIX_RULE_IDS)[number];
const AUTOFIX = new Set<string>(AUTOFIX_RULE_IDS);

export interface AutofixInput { title: string | null | undefined; body_md: string | null | undefined }
export interface AutofixHeld { rule: AutofixRuleId; reason: "title_too_short" | "unsafe_fragment" | "residual" }
export interface AutofixResult {
  title: string;
  body_md: string;
  /** 실제로 고친 규칙. 비었으면 title·body_md 는 원문 그대로다. */
  fixed: AutofixRuleId[];
  /** 걸려 있었지만 고치지 않은 규칙과 이유 — 보고서용. */
  held: AutofixHeld[];
}

// 고친 제목이 이보다 짧으면 제목 노릇을 못 한다 — 그 문서는 손대지 않는다.
const TITLE_MIN_CHARS = 3;

// 그림 문자 하나와 거기 붙는 변이 선택자·피부색·ZWJ 결합 — PICTO_RE 한 글자만 지우면 FE0F·ZWJ 찌꺼기가 남는다.
const PICTO_CLUSTER_RE = new RegExp(
  `${PICTO_RE.source}(?:\\uFE0F|[\\u{1F3FB}-\\u{1F3FF}])*(?:\\u200D${PICTO_RE.source}(?:\\uFE0F|[\\u{1F3FB}-\\u{1F3FF}])*)*`, "gu",
);
const LEADING_PICTO_RE = new RegExp(`^(?:${PICTO_CLUSTER_RE.source}\\s*)+`, "u");

// 날짜 조각 — lint 의 DATE_RE 에 붙은 요일·시각·범위 꼬리(«(화)», «09:56», «~15», «~2026-09-30», 열린 «~»)까지 한 조각으로 본다.
//  꼬리를 남기면 제목에 «~15»·«09:56» 같은 뜻 없는 찌꺼기가 남는다. 요일은 날짜에서 계산되는 값이라 옮기지 않고 지운다 —
//  옮기면 첫 줄 괄호 안에 괄호가 생겨(nested_paren) 게이트가 막는다.
const WEEKDAY = "\\s*\\([월화수목금토일]\\)";
const DATE_TOKEN_RE = new RegExp(
  `${DATE_RE.source}(?:${WEEKDAY})?(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?\\b)?(?:\\s*[~～]\\s*(?:(?:20\\d{2}-)?\\d{1,2}(?:-\\d{1,2})?\\b)?)?`, "g",
);
const WEEKDAY_RE = new RegExp(WEEKDAY, "g");
const MR_TOKEN_RE = new RegExp(MR_REF_RE.source, "g");
// 괄호 하나(안에 괄호 없음). 날짜·MR 이 든 괄호는 통째로 옮긴다 — «(2026-09-18 규명)» 에서 날짜만 빼면 «(규명)» 이 남는다.
const GROUP_RE = /[(\[（【]([^()[\]（）【】\n]*)[)\]）】]/g;
const SEP = "—–\\-·:|,/~";
const SEP_CHAR_RE = new RegExp(`[${SEP}]`);

const hasDate = (s: string): boolean => DATE_RE.test(s);
const hasMr = (s: string): boolean => MR_REF_RE.test(s);

/** 기호를 지운 뒤 남는 빈 괄호·겹친 구분자·양끝 구분자·연속 공백을 정리한다. */
function tidyTitle(t: string): string {
  let s = t.replace(/\s*\uE002[\s\uE002]*(?=[.,;!?)\]）】」』]|$)/g, "").replace(/\uE002/g, " ");
  for (let i = 0; i < 3; i++) {
    const prev = s;
    s = s.replace(new RegExp(`[(\\[（【]\\s*[${SEP}\\s]*[)\\]）】]`, "g"), " ");
    // 공백으로 띄운 구분자가 겹치면 첫 것만 남긴다(«A — — B»). 붙은 하이픈(«app-server»)은 건드리지 않는다.
    s = s.replace(new RegExp(`(\\s[${SEP}])(?:\\s+[${SEP}])+(?=\\s|$)`, "g"), "$1");
    s = s.replace(/,(?:\s*,)+/g, ",").replace(/\s+,(?=\s)/g, ",");
    s = s.replace(new RegExp(`^[\\s${SEP}]+|[\\s${SEP}]+$`, "g"), "");
    s = s.replace(/\s{2,}/g, " ").trim();
    if (s === prev) break;
  }
  return s;
}

/** 괄호 밖 조각을 지워도 제목 문장이 안 깨지는 자리인가 — 한쪽이 제목 끝·구분자·괄호여야 하고, 낱말에 딱 붙어 있으면 안 된다. */
function safeTokenSpot(title: string, start: number, end: number): boolean {
  const before = title.slice(0, start), after = title.slice(end);
  // 조사·단위가 바로 붙은 자리(«2026-09-07에», «!6593의»)와 설명 괄호가 바로 붙은 자리(«!6445(유니크 키)») — 지우면 문장이 깨진다.
  if (/^[\p{L}\p{N}([（【]/u.test(after) || /[\p{L}\p{N}]$/u.test(before)) return false;
  const l = before.trimEnd(), r = after.trimStart();
  const leftEdge = !l || SEP_CHAR_RE.test(l.slice(-1)) || /[\])）】」』(\[（【]$/.test(l);
  const rightEdge = !r || SEP_CHAR_RE.test(r[0]) || /^[)\]）】]/.test(r);
  return leftEdge || rightEdge;
}

interface Extraction { title: string; pieces: string[]; ok: boolean }

// 인라인 코드 자리표 — 사용자 영역 문자(\p{L}·\p{N} 이 아니다)라 경계 판정에 낱말로 잡히지 않는다.
const PH_OPEN = "\uE000", PH_CLOSE = "\uE001";
const PH_RE = /\uE000(\d+)\uE001/g;
// 지운 자리 표시 — 정리는 원래 있던 문장부호·공백이 아니라 지운 자리 주변만 손댄다(«조각 . 다음» 같은 찌꺼기).
const GAP = "\uE002";

/** 제목에서 날짜·MR 조각을 뺀다. pieces 는 본문으로 옮길 원문 조각(제목 순서). 안전하지 않은 자리가 있으면 ok=false. */
function extractFragments(title: string): Extraction {
  // 인라인 코드 안은 서술이 아니다 — «`text()`» 의 괄호를 빈 괄호로 지우거나 코드 속 숫자를 날짜로 옮기지 않게 가린다.
  const codes: string[] = [];
  const masked = title.replace(new RegExp(INLINE_CODE_RE.source, "g"), (m) => `${PH_OPEN}${codes.push(m) - 1}${PH_CLOSE}`);
  const unmask = (x: string): string => x.replace(PH_RE, (_, i: string) => codes[Number(i)]);
  const fail: Extraction = { title, pieces: [], ok: false };
  const pieces: string[] = [];
  let s = masked;
  let unsafe = false;
  // 바깥 괄호 안에 날짜 괄호가 든 경우가 있어 몇 번 되풀이한다.
  for (let round = 0; round < 3; round++) {
    let changed = false;
    s = s.replace(GROUP_RE, (all, inner: string, at: number, whole: string) => {
      if (!hasDate(inner) && !hasMr(inner)) return all;
      // 괄호 뒤에 조사가 바로 붙은 자리(«첫 달(2025-05)부터») — 괄호째 빼면 문장이 깨진다.
      if (/^[\p{L}\p{N}]/u.test(whole.slice(at + all.length))) { unsafe = true; return all; }
      changed = true;
      pieces.push(inner.trim());
      return GAP;
    });
    if (!changed) break;
  }
  if (unsafe) return fail;
  // 괄호 밖 조각 — 지울 자리마다 안전한지 본다. 하나라도 위험하면 날짜·MR 정리는 통째로 포기한다(반쯤 고친 제목이 더 나쁘다).
  const spans: { start: number; end: number; text: string }[] = [];
  for (const m of s.matchAll(DATE_TOKEN_RE)) spans.push({ start: m.index!, end: m.index! + m[0].length, text: m[0].replace(WEEKDAY_RE, "") });
  for (const m of s.matchAll(MR_TOKEN_RE)) {
    // MR_REF_RE 의 두 번째 갈래는 앞 구분자 한 글자를 함께 잡는다 — 구분자는 제목에 남기고 번호만 옮긴다.
    const lead = /^[\s(·,]/.test(m[0]) ? m[0][0] : "";
    spans.push({ start: m.index! + lead.length, end: m.index! + m[0].length, text: m[0].slice(lead.length) });
  }
  spans.sort((x, y) => x.start - y.start);
  for (let i = 1; i < spans.length; i++) if (spans[i].start < spans[i - 1].end) return fail;
  if (!spans.every((x) => safeTokenSpot(s, x.start, x.end))) return fail;
  for (const x of [...spans].reverse()) s = `${s.slice(0, x.start)}${GAP}${s.slice(x.end)}`;
  // 괄호 조각은 치환 전, 밖 조각은 치환 후 위치라 위치로 섞어 정렬할 수 없다 — 원제목에서 다시 찾아 제목 순서로 둔다.
  const ordered = [...pieces, ...spans.map((x) => x.text)]
    .filter((t) => t)
    .map((text) => ({ text, at: masked.indexOf(text) }))
    .sort((x, y) => x.at - y.at)
    .map((p) => unmask(p.text));
  return { title: unmask(tidyTitle(s)), pieces: ordered, ok: true };
}

const lineIsBlank = (l: string): boolean => !l.trim();

/** 본문 첫 줄 문맥 — 첫 줄이 헤딩이면 다음 줄까지(재작성 게이트의 첫 줄 허용과 같은 범위). */
function leadContext(lines: string[]): string {
  const ne = lines.filter((l) => !lineIsBlank(l));
  if (!ne.length) return "";
  return HEADING_LINE_RE.test(ne[0]) && ne[1] ? `${ne[0]}\n${ne[1]}` : ne[0];
}

/** 숫자 경계를 지켜 포함하는가 — «2026-06» 이 «2026-06-01» 안에 있다고 보면 값이 다른데 덧붙이기를 건너뛴다. */
const includesValue = (ctx: string, v: string): boolean => {
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\d-])${esc}(?!\\d|-\\d)`).test(ctx);
};

/**
 * 이 조각이 이미 첫 줄에 있나 — 그 글이 통째로 있으면 있다. MR 번호만인 조각은 번호가 있으면 있다(«MR !4986» ↔ «!4986»).
 *  날짜는 표기가 같아야 같은 값이라 통째 비교만 한다. 말이 붙은 조각(«2026-09-18 규명»)도 통째로 있어야 한다 — 값만 보고
 *  건너뛰면 «규명» 이 사라진다.
 */
function covered(piece: string, ctx: string): boolean {
  if (includesValue(ctx, piece)) return true;
  const bareMr = piece.replace(MR_TOKEN_RE, "").replace(new RegExp(`[\\s${SEP}]`, "g"), "") === "";
  if (!bareMr) return false;
  const nums = [...piece.matchAll(/!(\d+)|MR\s*!?(\d+)/g)].map((m) => m[1] ?? m[2]);
  return nums.length > 0 && nums.every((n) => new RegExp(`(?:!|MR\\s*!?)${n}(?!\\d)`).test(ctx));
}

// 첫 줄에 붙여도 되는 서술 줄인가. 목록·인용·표·펜스·HTML·구분선 줄은 그 항목에만 걸리는 말이 되거나 구조가 깨진다.
const NOT_APPENDABLE_RE = /^\s*(?:[-*+]\s|\d{1,3}[.)]\s|>|\||```|~~~|<|---|\*\*\*)/;

/**
 * 제목에서 뺀 조각을 본문 첫 줄에 남긴다.
 *  왜 «첫 줄 끝 괄호» 인가: 조각을 문장으로 풀면(«기준일은 2026-09-07 이다») 원문에 없던 관계(기준일인지 배포일인지)를
 *  지어내게 된다. 제목에 있던 글자를 그대로 괄호에 붙이면 뜻은 제목에서와 같고, 숫자·번호 불변식도 글자 그대로 보존된다.
 *  첫 줄이 헤딩이거나 목록·표 같은 구조 줄이면 붙일 자리가 아니라, 조각만 담은 줄을 따로 넣는다.
 */
function placeFragments(body: string, frag: string): string {
  const lines = body.split("\n");
  const i = lines.findIndex((l) => !lineIsBlank(l));
  const line = `(${frag})`;
  if (i < 0) return body.trim() ? body : line;
  const first = lines[i];
  if (HEADING_LINE_RE.test(first)) {
    const ins = ["", line];
    if (i + 1 < lines.length && !lineIsBlank(lines[i + 1])) ins.push("");
    lines.splice(i + 1, 0, ...ins);
    return lines.join("\n");
  }
  if (NOT_APPENDABLE_RE.test(first)) {
    lines.splice(i, 0, line, "");
    return lines.join("\n");
  }
  const m = first.match(/^(.*?)(\s*)$/)!;
  const core = m[1];
  const trail = m[2];
  lines[i] = /[.!?。]$/.test(core)
    ? `${core.slice(0, -1)} (${frag})${core.slice(-1)}${trail}`
    : `${core} (${frag})${trail}`;
  return lines.join("\n");
}

/** 펜스 코드 자리를 같은 길이 공백으로 가린 본문 — 줄 번호와 글자 위치가 원문과 같다. lint 의 proseOf 와 같은 순서로 지운다. */
function maskFences(body: string): string {
  let s = body;
  for (const re of FENCED_CODE_RES) s = s.replace(new RegExp(re.source, re.flags), (m) => m.replace(/[^\n]/g, " "));
  return s;
}

/** 헤딩 줄에서 그림 문자만 지운다. 인라인 코드 안은 서술이 아니라 그대로 둔다. */
function stripHeadingPictos(line: string): string {
  const parts: string[] = [];
  let last = 0;
  for (const m of line.matchAll(new RegExp(INLINE_CODE_RE.source, "g"))) {
    parts.push(cleanSeg(line.slice(last, m.index!)), m[0]);
    last = m.index! + m[0].length;
  }
  parts.push(cleanSeg(line.slice(last)));
  const [, hashes = "", rest = ""] = parts.join("").match(/^(\s*#{1,6})\s+(.*)$/) ?? [];
  return hashes ? `${hashes} ${rest.replace(/^\s+|\s+$/g, "")}` : parts.join("").trimEnd();
}
const cleanSeg = (s: string): string => s.replace(PICTO_CLUSTER_RE, "").replace(/[ \t]{2,}/g, " ");

// 화살표(↔·➡ 등)와 낱말 사이에 붙은 기호는 장식이 아니라 관계를 말한다 — «8081↔8082» 에서 지우면 «80818082» 가 된다.
//  그런 헤딩은 고치지 않고 남긴다(lint 재검사가 heading_symbol 을 held 로 돌린다).
const ARROW_RE = /[\u2190-\u21FF\u27A1\u2934\u2935\u2B05-\u2B07]/u;
function decorativeOnly(line: string): boolean {
  const prose = line.replace(new RegExp(INLINE_CODE_RE.source, "g"), " ");
  for (const m of prose.matchAll(PICTO_CLUSTER_RE)) {
    if (ARROW_RE.test(m[0])) return false;
    const l = prose[m.index! - 1] ?? " ", r = prose[m.index! + m[0].length] ?? " ";
    if (/[\p{L}\p{N}]/u.test(l) && /[\p{L}\p{N}]/u.test(r)) return false;
  }
  return true;
}

function fixHeadings(body: string): { body: string; changed: boolean } {
  const masked = maskFences(body).split("\n");
  const lines = body.split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const prose = masked[i].replace(new RegExp(INLINE_CODE_RE.source, "g"), "");
    if (prose.length > PROSE_LINE_MAX || !HEADING_LINE_RE.test(prose) || !PICTO_RE.test(prose)) continue;
    // 펜스와 같은 줄에 걸친 헤딩(희귀)은 가린 자리를 지키기 어렵다 — 건너뛴다. 남으면 lint 재검사가 heading_symbol 을 남긴다.
    if (masked[i] !== lines[i] || !decorativeOnly(lines[i])) continue;
    const next = stripHeadingPictos(lines[i]);
    if (next !== lines[i]) { lines[i] = next; changed = true; }
  }
  return { body: lines.join("\n"), changed };
}

const forceEnabled = (fmt: WritingFormat): WritingFormat => (fmt.enabled ? fmt : { ...fmt, enabled: true });

export function autofixWriting(input: AutofixInput, fmt: WritingFormat): AutofixResult {
  const f = forceEnabled(fmt);
  const origTitle = String(input.title ?? "");
  const origBody = String(input.body_md ?? "");
  const unchanged = (held: AutofixHeld[] = []): AutofixResult => ({ title: origTitle, body_md: origBody, fixed: [], held });
  const on = (r: AutofixRuleId): boolean => ruleLevel(f, r) !== "off";
  const rulesOf = (t: string, b: string): Set<string> => new Set(lintWriting({ title: t, body_md: b }, f).map((x) => x.rule));
  const before = rulesOf(origTitle, origBody);
  const targets = AUTOFIX_RULE_IDS.filter((r) => before.has(r));
  if (!targets.length) return unchanged();

  const fixed: AutofixRuleId[] = [];
  const held: AutofixHeld[] = [];
  let title = origTitle.trim();
  let body = origBody;

  // 1) 맨 앞 이모지 — 지우고 나면 뒤에 가려 있던 상태 기호가 title_status_mark 로 드러날 수 있어 2) 보다 먼저 한다.
  if (before.has("title_leading_emoji")) {
    title = title.replace(LEADING_PICTO_RE, "").trim();
    fixed.push("title_leading_emoji");
  }
  // 2) 상태·경고 기호 — 맨 앞 이모지를 지운 뒤 드러난 것도 함께 지운다.
  //  lint 는 맨 앞이 이모지면 상태 기호를 따로 세지 않는다 — 여기서 안 지우면 정리 결과에 «새 위반» 으로 나타난다.
  if (on("title_status_mark") && title.match(SIGNAL_SYMBOL_RE)) {
    title = tidyTitle(title.replace(SIGNAL_SYMBOL_RE, " "));
    fixed.push("title_status_mark");
  }
  // 3) 날짜·MR 번호 — 본문 첫 줄로 옮긴다.
  const wantDate = before.has("title_date"), wantMr = before.has("title_mr_ref");
  if (wantDate || wantMr) {
    const ex = extractFragments(title);
    const heldBoth = (reason: AutofixHeld["reason"]) => {
      if (wantDate) held.push({ rule: "title_date", reason });
      if (wantMr) held.push({ rule: "title_mr_ref", reason });
    };
    if (!ex.ok) heldBoth("unsafe_fragment");
    else {
      const left = rulesOf(ex.title, body);
      if ((wantDate && left.has("title_date")) || (wantMr && left.has("title_mr_ref"))) heldBoth("residual");
      else {
        // 인라인 코드 속 값은 서술이 아니다(재작성 게이트도 숫자·참조를 셀 때 뺀다) — 거기 있다고 덧붙이기를 건너뛰면 값이 사라진다.
        const ctx = leadContext(body.split("\n")).replace(new RegExp(INLINE_CODE_RE.source, "g"), " ");
        const add = ex.pieces.filter((p) => !covered(p, ctx));
        if (add.length) body = placeFragments(body, add.join(", "));
        title = ex.title;
        if (wantDate) fixed.push("title_date");
        if (wantMr) fixed.push("title_mr_ref");
      }
    }
  }
  if ([...title].length < TITLE_MIN_CHARS) {
    return unchanged(targets.map((r) => ({ rule: r, reason: "title_too_short" as const })));
  }
  // 4) 헤딩 기호.
  if (before.has("heading_symbol")) {
    const h = fixHeadings(body);
    if (h.changed) { body = h.body; fixed.push("heading_symbol"); } else held.push({ rule: "heading_symbol", reason: "residual" });
  }

  // 고친 척하지 않는다 — 다시 재서 남은 규칙은 fixed 에서 빼고 held 로 돌린다. 남았다는 건 탐지와 수정이 어긋났다는 뜻이다.
  const after = rulesOf(title, body);
  const really = fixed.filter((r) => !after.has(r));
  for (const r of fixed) if (after.has(r)) held.push({ rule: r, reason: "residual" });
  if (!really.length) return unchanged(held);
  return { title, body_md: body, fixed: really, held };
}

/**
 * 결정적 정리 결과를 재작성 게이트(checkRewrite)로 판정할 때 막아야 할 위반만 남긴다.
 *  원문부터 있던 위반 중 이 정리가 고친다고 하지 않은 규칙(lead_missing 같은 LLM 몫, 자리가 위험해 보류한 title_date)은
 *  막지 않는다 — 서버도 원문부터 있던 위반으로는 저장을 거부하지 않는다(capabilities/writing-style.ts 의 existed).
 *  고쳤다고 한 규칙(fixed)이 남았거나, 새 위반·불변식 위반·분량 감소가 있으면 막는다.
 */
export function autofixBlocking(violations: RewriteViolation[], fixed: readonly string[]): RewriteViolation[] {
  const claimed = new Set(fixed.filter((r) => AUTOFIX.has(r)));
  return violations.filter((v) => !v.kind.startsWith("lint:") || claimed.has(v.kind.slice(5)));
}
