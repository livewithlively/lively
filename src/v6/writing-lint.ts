// 서술 형식 검사 — 조직 서술 형식(writing_format)에 비춰 지식 제목·본문의 기계 판정 가능한 위반을 찾는다.
//
// 이 모듈은 순수 함수다(DB·네트워크 없음). 저장 경로·관리기·재작성 게이트가 같은 판정을 쓰게 하려고 분리했다.
// 판정은 휴리스틱이다. 저장을 막을지(reject)는 조직이 규칙마다 정한다. 오탐보다 누락을 택한 규칙이 많다
//  (예: 결론 여부는 판정하지 않고 «첫 줄이 헤딩·인용·표로 시작하는가»만 본다). 의미 판정은 LLM 몫이다.
import { type WritingFormat, type WritingRuleId, type WritingSurface, ruleLevel } from "../org/policies/writing-format.js";

// 표면마다 볼 규칙. 지식은 검색·주입되는 정본이라 전부 본다. 작업기록은 짧은 진척 기록이라 골격·길이·배너는 보지 않고,
//  제목은 작업기록 전용 한도로 본다. 프로젝트 본문은 목표·범위 골격을 쓰므로 첫 줄 결론을 요구하지 않고, 이름(name)은
//  짧은 라벨이라 제목 규칙을 걸지 않는다.
const SURFACE_RULES: Record<WritingSurface, ReadonlySet<WritingRuleId>> = {
  knowledge: new Set<WritingRuleId>([
    "title_length", "title_leading_emoji", "title_date", "title_mr_ref", "title_status_mark", "title_multi_dash",
    "lead_missing", "body_length", "bold_overuse", "symbol_overuse", "heading_symbol",
    "relative_time", "local_path", "arrow_chain", "nested_paren", "undated_status", "revision_banner",
    "forbidden_term", "register_mix",
  ]),
  activity: new Set<WritingRuleId>([
    "title_length", "title_leading_emoji", "title_status_mark",
    "bold_overuse", "symbol_overuse", "relative_time", "local_path", "arrow_chain",
    "forbidden_term", "register_mix", "activity_body_missing",
  ]),
  project: new Set<WritingRuleId>([
    "bold_overuse", "symbol_overuse", "heading_symbol", "relative_time", "local_path", "arrow_chain", "nested_paren",
    "forbidden_term", "register_mix",
  ]),
};

export interface WritingFinding {
  rule: WritingRuleId;
  level: "warn" | "reject";
  message: string;
  count?: number;
  sample?: string;
}

export interface WritingLintInput {
  title: string | null | undefined;
  body_md: string | null | undefined;
}

const SAMPLE_MAX = 80;
const sample = (s: string): string => {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > SAMPLE_MAX ? `${t.slice(0, SAMPLE_MAX)}…` : t;
};

// 강조 기호로 쓰이는 것들. 이모지 전체가 아니라 «상태·경고 신호»로 남발되는 기호만 센다.
const SIGNAL_SYMBOL_RE = /🔴|🟠|🟡|🟢|✅|❌|⭐|⚠️?|🚨|🔥|💡|📌|‼️?|❗/gu;
const PICTO_RE = /\p{Extended_Pictographic}/u;
const DATE_RE = /\b20\d{2}-\d{2}(?:-\d{2})?\b/;
const MR_REF_RE = /\bMR\s*!?\d+|(?:^|[\s(·,])!\d{2,}\b/;
// '방금'은 기술 서술(«방금 만든 파일»)에서 시점이 아니라 순서를 말할 때가 많아 넣지 않는다(실데이터 보정).
const RELATIVE_TIME_RE = /오늘|어제|(?<!안)내일|그저께|엊그제|지난주|이번 ?주|다음 ?주|이번 세션|지난 세션|이 세션/g;
const LOCAL_PATH_RE = /\/Users\/[A-Za-z0-9._-]+|\/home\/[a-z][A-Za-z0-9._-]*|(?:^|[\s`(])~\/[A-Za-z0-9._-]|[A-Za-z]:\\Users\\/g;
const UNDATED_STATUS_RE = /아직|진행 ?중|대기 ?중|배포 ?대기|머지 ?대기|미배포|미머지|예정(?:이다|입니다|임)/;
// '갱신'은 넣지 않는다 — «토큰 갱신 절차» 같은 헤딩이 배너로 잡힌다.
const REVISION_BANNER_RE = /\bUPDATE\b|정정|폐기|방향 ?전환|더 이상 유효하지|\bv\d+\s*→\s*v\d+/i;
const NESTED_PAREN_RE = /[(（][^()（）\n]*[(（][^()（）\n]*[)）][^()（）\n]*[)）]/;
const POLITE_END_RE = /(?:습니다|ㅂ니다|니다|세요|십시오|어요|에요|해요)[.!?]?$/;
const PLAIN_END_RE = /[가-힣]다[.!?]?$/;

/** 코드(펜스·인라인)와 URL 을 지운 본문 — 코드 안의 화살표·괄호·경로는 서술이 아니다. */
function proseOf(body: string): string {
  return body
    .replace(/```[\s\S]*?(?:```|$)/g, "\n")
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, "\n")
    .replace(/`[^`\n]*`/g, "")
    .replace(/https?:\/\/\S+/g, "");
}

const lines = (s: string): string[] => s.split("\n");
// 이보다 긴 한 줄은 문장이 아니라 데이터(덤프·base64·한 줄 JSON)다. 줄 단위 서술 규칙에서 뺀다 —
//  정규식 몇 개는 줄 길이에 비례해 되짚으므로, 서술이 아닌 거대한 줄 하나가 저장 한 번을 수 초씩 붙잡을 수 있다.
const PROSE_LINE_MAX = 2000;
// 따옴표 안은 남의 말이거나 낱말 자체를 가리키는 언급이다(«"아직" 같은 표현»). 시점·상태 판정에서 뺀다.
//  홑따옴표는 넣지 않는다 — 영문 아포스트로피(don't … isn't) 사이를 통째로 지운다.
//  길이를 300자로 묶는다 — 닫힘 없는 여는 기호마다 줄 끝까지 훑으면 긴 한 줄에서 제곱 시간이 된다.
const unquoted = (l: string): string => l.replace(/"[^"\n]{0,300}"|“[^”\n]{0,300}”|「[^」\n]{0,300}」|『[^』\n]{0,300}』|‘[^’\n]{0,300}’/g, "");
const isQuote = (l: string): boolean => /^\s*>/.test(l);

/** 본문의 «첫 문단»이 서술로 시작하는지 — 맨 앞 H1(제목 반복)은 한 번 건너뛴다. */
function leadLine(body: string): string | null {
  const ls = lines(body).map((l) => l.trim());
  let i = 0;
  while (i < ls.length && !ls[i]) i++;
  if (i < ls.length && /^#\s/.test(ls[i])) {
    i++;
    while (i < ls.length && !ls[i]) i++;
  }
  return i < ls.length ? ls[i] : null;
}

const CLOSERS = new Set([")", "]", "」", "』", '"', "'", "*", "_"]);
/** 문장 끝의 닫는 기호·강조 표시를 걷는다. 정규식 `[…]+$` 는 긴 기호 런 뒤에 다른 글자가 오면 시작점마다 되짚는다. */
function stripClosers(s: string): string {
  let end = s.length;
  while (end > 0 && CLOSERS.has(s[end - 1])) end--;
  return s.slice(0, end);
}

const NON_PROSE_START_RE = /^(#{1,6}\s|>|\||```|~~~|<!--|---\s*$|\*\*\*\s*$)/;

export function lintWriting(input: WritingLintInput, fmt: WritingFormat, surface: WritingSurface = "knowledge"): WritingFinding[] {
  if (!fmt.enabled || !fmt.apply_to.includes(surface)) return [];
  const allowed = SURFACE_RULES[surface];
  const title = String(input.title ?? "").trim();
  const body = String(input.body_md ?? "");
  const prose = proseOf(body);
  const proseLines = lines(prose).filter((l) => l.length <= PROSE_LINE_MAX);
  const out: WritingFinding[] = [];
  const add = (rule: WritingRuleId, message: string, extra: { count?: number; sample?: string } = {}): void => {
    if (!allowed.has(rule)) return;
    const level = ruleLevel(fmt, rule);
    if (level === "off") return;
    out.push({ rule, level, message, ...extra });
  };

  // ── 제목 ──
  if (title) {
    const len = [...title].length;
    const titleMax = surface === "activity" ? fmt.limits.activity_title_max_chars : fmt.limits.title_max_chars;
    if (len > titleMax) {
      add("title_length", `제목이 ${len}자다(상한 ${titleMax}자). 주제와 결론 하나만 남기고 나머지는 본문으로 내려라.`, { count: len });
    }
    if (PICTO_RE.test([...title][0] ?? "")) add("title_leading_emoji", "제목을 이모지로 시작하지 마라. 분류는 카테고리가, 상태는 본문이 말한다.", { sample: sample(title) });
    if (DATE_RE.test(title)) add("title_date", "제목에 날짜를 넣지 마라. 시점은 본문의 사실 옆에 적는다.", { sample: sample(title) });
    if (MR_REF_RE.test(title)) add("title_mr_ref", "제목에 MR·커밋 번호를 넣지 마라. 본문 출처에 적는다.", { sample: sample(title) });
    const marks = title.match(SIGNAL_SYMBOL_RE);
    if (marks && !PICTO_RE.test([...title][0] ?? "")) add("title_status_mark", "제목에 상태·경고 기호를 넣지 마라.", { count: marks.length, sample: sample(title) });
    const dashes = (title.match(/—/g) ?? []).length;
    if (dashes >= 2) add("title_multi_dash", "제목에 '—'로 부제를 여러 개 이어 붙이지 마라. 제목은 한 줄 라벨이다.", { count: dashes, sample: sample(title) });
  }

  if (!body.trim()) {
    if (surface === "activity" && title) add("activity_body_missing", "작업기록에 본문이 없다. 무엇을 바꿨고, 어떻게 확인했고, 무엇이 남았는지 짧게 적어라.");
    return out;
  }

  // ── 골격 ──
  const lead = leadLine(body);
  if (lead && NON_PROSE_START_RE.test(lead)) {
    add("lead_missing", "본문 첫 줄이 헤딩·인용·표로 시작한다. 첫 줄에 결론을 1~3문장으로 쓰고 배경은 그 다음에 둔다.", { sample: sample(lead) });
  }
  const bodyLen = [...body].length;
  if (bodyLen > fmt.limits.body_max_chars) {
    add("body_length", `본문이 ${bodyLen.toLocaleString()}자다(권장 ${fmt.limits.body_max_chars.toLocaleString()}자 이하). 한 지식에 여러 주제가 쌓였다면 현행 규칙과 이력을 나눠라.`, { count: bodyLen });
  }

  // ── 강조 ──
  // 표 안의 볼드·기호는 셈하지 않는다 — 표의 ✅·❌ 는 상태를 적은 값(데이터)이지 강조가 아니고, 강조 규칙을 맞추려고
  //  표 값을 바꾸면 사실이 바뀐다(자동 정리의 불변식이 표 행을 글자 단위로 지키는 것과 짝).
  const emphasisText = proseLines.filter((l) => !/^\s*\|/.test(l)).join("\n");
  const bolds = (emphasisText.match(/\*\*[^*\n]+\*\*/g) ?? []).length;
  if (bolds > fmt.limits.bold_max) add("bold_overuse", `볼드가 ${bolds}곳이다(상한 ${fmt.limits.bold_max}). 강조는 결론 한두 곳에만 둔다.`, { count: bolds });
  const symbols = (emphasisText.match(SIGNAL_SYMBOL_RE) ?? []).length;
  if (symbols > fmt.limits.symbol_max) add("symbol_overuse", `강조 기호(🔴⚠✅ 등)가 ${symbols}개다(상한 ${fmt.limits.symbol_max}). 위험 등급은 글로 적는다.`, { count: symbols });
  const symHeads = proseLines.filter((l) => /^\s*#{1,6}\s/.test(l) && PICTO_RE.test(l));
  if (symHeads.length) add("heading_symbol", "헤딩에 기호를 넣지 마라.", { count: symHeads.length, sample: sample(symHeads[0]) });

  // ── 작성 맥락 ──
  const nonQuote = proseLines.filter((l) => !isQuote(l)).map(unquoted).join("\n");
  const rel = nonQuote.match(RELATIVE_TIME_RE);
  if (rel) add("relative_time", "상대시간 표현이 있다. 다른 날 다른 사람이 읽으면 가리키는 날이 없다 — 절대 날짜로 바꿔라.", { count: rel.length, sample: rel[0] });
  // 경로는 코드블록 안에 있어도 남의 자리에서 못 여는 건 같다 — 원문 전체에서 본다.
  const paths = body.match(LOCAL_PATH_RE);
  if (paths) add("local_path", "개인 컴퓨터 경로가 있다. 다른 구성원은 열 수 없다 — 레포 경로와 커밋, 또는 첨부 자료로 바꿔라.", { count: paths.length, sample: sample(paths[0]) });

  // ── 문장 ──
  const arrowLines = proseLines.filter((l) => (l.match(/→/g) ?? []).length >= 3);
  if (arrowLines.length) add("arrow_chain", "한 줄에 '→'를 세 번 넘게 이었다. 인과는 문장으로, 절차는 번호 목록으로 쓴다.", { count: arrowLines.length, sample: sample(arrowLines[0]) });
  const nested = proseLines.filter((l) => NESTED_PAREN_RE.test(l));
  if (nested.length) add("nested_paren", "괄호 안에 괄호가 있다. 괄호 속 사실은 별도 문장이나 표로 뺀다.", { count: nested.length, sample: sample(nested[0]) });
  const undated = proseLines.filter((l) => !isQuote(l) && UNDATED_STATUS_RE.test(unquoted(l)) && !DATE_RE.test(l));
  if (undated.length) add("undated_status", "날짜 없는 상태 서술이 있다('아직'·'대기'·'예정' 등). 같은 문장에 기준 날짜를 적거나 규칙으로 바꿔라.", { count: undated.length, sample: sample(undated[0]) });
  const allLines = lines(body);
  const topN = Math.max(15, Math.ceil(allLines.length * 0.2));
  const banners = allLines.slice(0, topN).filter((l) => REVISION_BANNER_RE.test(l) && (/^\s*(>|#|\*\*|⚠|🔴)/.test(l) || DATE_RE.test(l)));
  if (banners.length) add("revision_banner", "본문 앞부분에 개정 배너('정정'·'폐기' 등)가 있다. 본문을 현행 사실로 다시 쓰고, 이력은 끝에 짧게 남겨라.", { count: banners.length, sample: sample(banners[0]) });

  // ── 금지어 ──
  if (fmt.forbid_terms.length) {
    const hay = `${title}\n${body}`.toLowerCase();
    const hits = fmt.forbid_terms.filter((t) => hay.includes(t.toLowerCase()));
    if (hits.length) add("forbidden_term", `조직이 서술에 쓰지 않기로 한 말이 있다: ${hits.slice(0, 10).join(", ")}.`, { count: hits.length, sample: hits[0] });
  }

  // ── 문체 ──
  if (fmt.register !== "any") {
    let polite = 0, plain = 0;
    let firstOff: string | null = null;
    for (const l of proseLines) {
      if (isQuote(l) || /^\s*(#|\|)/.test(l)) continue;
      for (const sent of l.split(/(?<=[.!?])\s+/)) {
        const s = stripClosers(sent.trim());
        if (!s) continue;
        if (POLITE_END_RE.test(s)) { polite++; if (fmt.register === "plain" && !firstOff) firstOff = s; }
        else if (PLAIN_END_RE.test(s)) { plain++; if (fmt.register === "polite" && !firstOff) firstOff = s; }
      }
    }
    const off = fmt.register === "plain" ? polite : plain;
    const total = polite + plain;
    // 한두 문장은 인용·예시일 수 있다 — 섞임이 뚜렷할 때만 안내한다.
    if (off >= 3 && off / total > 0.2) {
      const want = fmt.register === "plain" ? "평서 '~다'체" : "'~습니다'체";
      add("register_mix", `문체가 섞였다. 이 조직의 서술은 ${want}로 통일한다.`, { count: off, sample: firstOff ? sample(firstOff) : undefined });
    }
  }

  return out;
}
