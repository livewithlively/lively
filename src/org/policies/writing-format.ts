// 조직 서술 형식(writing_format) — AI 가 라이블리에 저장하는 서술의 형식을 조직마다 정한다.
//
// 왜 필요: 지식 저장 경로(knowledge_save)는 제목 길이·슬러그 말고는 형식을 보지 않는다. 그래서 저장되는
//  서술의 모양은 작성 AI 가 따르는 개인 지침(강조 기호·라벨·작업일지 서술)을 그대로 닮는다. 지식은 다른
//  구성원의 세션에 검색·주입되는 컨텍스트라, 첫 줄에 결론이 없거나 작성 세션 맥락이 남으면 읽는 쪽이 비용을 낸다.
//
// 조직마다 다르게 둘 수 있어야 하는 이유: 문체(평서/존댓말)·제목 길이·금지어는 조직의 글쓰기 관행이다.
//  제품은 기본값만 제안하고, 조직이 org_runtime_update 의 writing_format 으로 덮는다.
//
// 기본 enabled=false 인 이유: 켜면 저장 응답에 형식 위반 안내가 실리고, reject 로 정한 규칙은 에이전트 저장을 막는다.
//  안내만 받아도 에이전트는 고치려 들기 때문에, 조직이 고르기 전에 모든 워크스페이스에서 행동이 바뀌면 안 된다.
//
// DB 원본은 «조직이 바꾼 칸»만 담는다. 여기서 기본값 위에 얹어 유효 형식을 만든다 — 기본값을 DB 에 굳히면
//  제품 기본값이 개선돼도 그 조직엔 영영 안 먹는다(#688 과 같은 함정).

export const WRITING_RULE_IDS = [
  "title_length", "title_leading_emoji", "title_date", "title_mr_ref", "title_status_mark", "title_multi_dash",
  "lead_missing", "body_length",
  "bold_overuse", "symbol_overuse", "heading_symbol",
  "relative_time", "local_path", "arrow_chain", "nested_paren", "undated_status", "revision_banner",
  "forbidden_term", "register_mix",
  "activity_body_missing",
] as const;
export type WritingRuleId = (typeof WRITING_RULE_IDS)[number];

/**
 * 규칙 수준. warn = 저장하고 안내만 · reject = 에이전트 저장을 거부하고 고칠 곳을 돌려준다.
 *  reject 가 필요한 이유: 안내는 받는 쪽이 따를 때만 효과가 있다. 형식을 모르는 옛 클라이언트·지침을 무시하는
 *  에이전트의 글도 저장소에 들어오는 순간 같은 모양이어야 하므로, 서버가 받는 자리에서 막을 수단이 있어야 한다.
 */
export const WRITING_RULE_LEVELS = ["off", "warn", "reject"] as const;
export type WritingRuleLevel = (typeof WRITING_RULE_LEVELS)[number];

export type WritingRegister = "plain" | "polite" | "any";

/** 형식을 적용할 서술 표면. 표면마다 적용하는 규칙이 다르다(writing-lint.ts SURFACE_RULES). */
export const WRITING_SURFACES = ["knowledge", "activity", "project"] as const;
export type WritingSurface = (typeof WRITING_SURFACES)[number];

export interface WritingFormatLimits {
  title_max_chars: number;
  /** 작업기록 제목은 지식 제목보다 기술 상세를 담는 자리라 따로 둔다. */
  activity_title_max_chars: number;
  body_max_chars: number;
  bold_max: number;
  symbol_max: number;
}

export interface WritingFormat {
  enabled: boolean;
  /** plain = 평서 '~다'체, polite = '~습니다'체, any = 문체 검사 안 함. */
  register: WritingRegister;
  apply_to: WritingSurface[];
  limits: WritingFormatLimits;
  /** 본문·제목에 쓰지 않을 말(대소문자 무시 부분일치). 조직이 채운다 — 예: 작성 도구 이름, 개인 호칭. */
  forbid_terms: string[];
  /** 규칙별 수준. 없는 규칙은 default_level. */
  rules: Partial<Record<WritingRuleId, WritingRuleLevel>>;
  default_level: WritingRuleLevel;
  /** 작성 AI 에게 보여 줄 문체 가이드. 위반 안내에 함께 실린다. */
  guide_md: string;
}

/** limits 칸의 null 은 «그 칸을 기본값으로 되돌림». */
export type WritingFormatPatch = Partial<Omit<WritingFormat, "limits">> & { limits?: Partial<Record<keyof WritingFormatLimits, number | null>> };

export const DEFAULT_WRITING_GUIDE_MD = [
  "## 서술 형식",
  "",
  "- 본문 첫 줄에 결론을 1~3문장으로 쓴다. 헤딩·인용·배너로 시작하지 않는다. 배경과 경과는 그 다음이다.",
  "- 제목은 주제와 결론 하나만 담는 한 줄이다. 날짜·MR 번호·상태 기호·부제 나열은 본문으로 내린다.",
  "- 고칠 때는 본문을 현행 사실로 다시 쓴다. 위에 '정정'·'폐기' 배너를 덧쌓지 않는다. 필요하면 끝에 「변경 이력」을 3줄 이내로 남긴다.",
  "- 문장으로 쓴다. `→` 연쇄, `A=B` 식 서술, 조사를 뺀 명사 나열로 문장을 대신하지 않는다. 괄호 안에 괄호를 넣지 않는다.",
  "- 강조는 결론 한두 곳에만 쓴다. 위험 등급은 기호 대신 '위험도: 높음'처럼 글로 적는다.",
  "- 다른 사람의 세션에서 읽힌다고 생각하고 쓴다. 상대시간(오늘·어제·지난주), '이번 세션', 작성 도구 이름, 로컬 파일 경로, 대화 전사를 남기지 않는다. 사람은 결정 주체와 날짜로만 적는다.",
  "- 확인한 사실에는 확인 방법(코드 위치·쿼리와 날짜)을 붙인다. 추론은 '추정:'으로, 확인하지 못한 것은 '[미확인]'으로 표시한다.",
  "- 상태를 적을 땐 날짜를 같은 문장에 쓴다. 가능하면 상태 대신 규칙으로 쓴다.",
  "- 한 지식에는 한 주제만 담는다. 길어지면 현행 규칙과 이력을 나눈다.",
].join("\n");

export const DEFAULT_WRITING_FORMAT: WritingFormat = {
  enabled: false,
  register: "plain",
  apply_to: [...WRITING_SURFACES],
  limits: { title_max_chars: 60, activity_title_max_chars: 80, body_max_chars: 8000, bold_max: 10, symbol_max: 3 },
  forbid_terms: [],
  rules: {},
  default_level: "warn",
  guide_md: DEFAULT_WRITING_GUIDE_MD,
};

// 상한 — 관리 API 스키마도 이 표를 읽는다(범위를 두 곳에 두면 API 는 거부하고 저장소는 다르게 클램프한다).
//  오타로 천문학적 값이 들어와 규칙이 사실상 꺼지는 것을 막는다. 끄려면 rules 에서 off 로 명시한다.
export const WRITING_LIMIT_BOUNDS: Readonly<Record<keyof WritingFormatLimits, readonly [number, number]>> = {
  title_max_chars: [10, 200],
  activity_title_max_chars: [20, 500],
  body_max_chars: [500, 200_000],
  bold_max: [0, 500],
  symbol_max: [0, 500],
};
const FORBID_TERMS_MAX = 200;
const FORBID_TERM_MAX_CHARS = 80;
const GUIDE_MAX_CHARS = 8000;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function cleanLimit(key: keyof WritingFormatLimits, v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const [lo, hi] = WRITING_LIMIT_BOUNDS[key];
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

function cleanTerms(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    if (typeof x !== "string") continue;
    const s = x.trim().slice(0, FORBID_TERM_MAX_CHARS);
    const key = s.toLowerCase();
    if (!s || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= FORBID_TERMS_MAX) break;
  }
  return out;
}

function cleanSurfaces(v: unknown): WritingSurface[] | null {
  if (!Array.isArray(v)) return null;
  return WRITING_SURFACES.filter((x) => v.includes(x));
}

function cleanRules(v: unknown): Partial<Record<WritingRuleId, WritingRuleLevel>> {
  if (!isObj(v)) return {};
  const out: Partial<Record<WritingRuleId, WritingRuleLevel>> = {};
  for (const [k, lvl] of Object.entries(v)) {
    if (!(WRITING_RULE_IDS as readonly string[]).includes(k)) continue;
    if (!(WRITING_RULE_LEVELS as readonly string[]).includes(lvl as string)) continue;
    out[k as WritingRuleId] = lvl as WritingRuleLevel;
  }
  return out;
}

/** DB 원본(조직이 바꾼 칸) → 유효 형식. 잡값은 조용히 기본값으로 접는다(throw 금지 — 사람 손이 닿는 입력이다). */
export function resolveWritingFormat(raw: unknown): WritingFormat {
  const d = DEFAULT_WRITING_FORMAT;
  const r = isObj(raw) ? raw : {};
  const lim = isObj(r.limits) ? r.limits : {};
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    register: r.register === "plain" || r.register === "polite" || r.register === "any" ? r.register : d.register,
    apply_to: cleanSurfaces(r.apply_to) ?? [...d.apply_to],
    limits: {
      title_max_chars: cleanLimit("title_max_chars", lim.title_max_chars, d.limits.title_max_chars),
      activity_title_max_chars: cleanLimit("activity_title_max_chars", lim.activity_title_max_chars, d.limits.activity_title_max_chars),
      body_max_chars: cleanLimit("body_max_chars", lim.body_max_chars, d.limits.body_max_chars),
      bold_max: cleanLimit("bold_max", lim.bold_max, d.limits.bold_max),
      symbol_max: cleanLimit("symbol_max", lim.symbol_max, d.limits.symbol_max),
    },
    forbid_terms: cleanTerms(r.forbid_terms) ?? d.forbid_terms,
    rules: cleanRules(r.rules),
    default_level: (WRITING_RULE_LEVELS as readonly string[]).includes(r.default_level as string)
      ? (r.default_level as WritingRuleLevel) : d.default_level,
    guide_md: typeof r.guide_md === "string" && r.guide_md.trim() ? r.guide_md.slice(0, GUIDE_MAX_CHARS) : d.guide_md,
  };
}

/**
 * 저장할 DB 원본을 만든다 — 기존 원본 위에 patch 를 얹되, 유효한 칸만 남긴다(기본값은 채워 넣지 않는다).
 *  patch 가 null 이면 원본을 비운다(= 제품 기본값으로 되돌림). limits 는 칸 단위로 병합한다.
 */
export function mergeWritingFormatRaw(currentRaw: unknown, patch: WritingFormatPatch | null): Record<string, unknown> {
  if (patch === null) return {};
  const cur = isObj(currentRaw) ? { ...currentRaw } : {};
  const next: Record<string, unknown> = { ...cur };
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  if (patch.register === "plain" || patch.register === "polite" || patch.register === "any") next.register = patch.register;
  if (patch.apply_to !== undefined) next.apply_to = cleanSurfaces(patch.apply_to) ?? [];
  if (patch.limits !== undefined) {
    const limCur = isObj(cur.limits) ? cur.limits : {};
    const lim: Record<string, number> = {};
    for (const k of Object.keys(WRITING_LIMIT_BOUNDS) as Array<keyof WritingFormatLimits>) {
      const v = k in (patch.limits ?? {}) ? patch.limits[k] : limCur[k];
      if (typeof v === "number" && Number.isFinite(v)) lim[k] = cleanLimit(k, v, DEFAULT_WRITING_FORMAT.limits[k]);
    }
    next.limits = lim;
  }
  if (patch.forbid_terms !== undefined) next.forbid_terms = cleanTerms(patch.forbid_terms) ?? [];
  if (patch.rules !== undefined) next.rules = { ...cleanRules(cur.rules), ...cleanRules(patch.rules) };
  if (patch.default_level !== undefined && (WRITING_RULE_LEVELS as readonly string[]).includes(patch.default_level)) {
    next.default_level = patch.default_level;
  }
  if (patch.guide_md !== undefined) {
    // 빈 가이드는 «기본 가이드로 되돌린다»는 뜻이다 — 빈 문자열을 저장하면 안내에 아무것도 안 실린다.
    if (typeof patch.guide_md === "string" && patch.guide_md.trim()) next.guide_md = patch.guide_md.slice(0, GUIDE_MAX_CHARS);
    else delete next.guide_md;
  }
  return next;
}

/**
 * default_level 을 물려받지 않고 명시할 때만 켜지는 규칙. 작업기록 본문은 도구 계약상 선택이라(activity_log.body 는
 *  «짧은 메모(선택)»), 본문을 요구하는 규칙이 기본값으로 켜지면 계약과 어긋나는 안내·거부가 모든 기록에 붙는다.
 */
const OPT_IN_RULES: ReadonlySet<WritingRuleId> = new Set<WritingRuleId>(["activity_body_missing"]);

export function ruleLevel(fmt: WritingFormat, id: WritingRuleId): WritingRuleLevel {
  return fmt.rules[id] ?? (OPT_IN_RULES.has(id) ? "off" : fmt.default_level);
}

const LEVEL_WORD: Record<WritingRuleLevel, string> = { off: "끔", warn: "안내", reject: "저장 거부" };

/**
 * 세션 주입·증류 프롬프트에 싣는 형식 블록. 꺼져 있으면 빈 글 — 켜지 않은 조직의 주입은 바이트 단위로 그대로다.
 *  거부 규칙을 함께 적는 이유: 에이전트가 저장한 뒤 422 를 받고서야 규칙을 알면 한 번의 저장이 버려진다.
 */
export function buildWritingGuideBlock(fmt: WritingFormat): string {
  if (!fmt.enabled) return "";
  const rejects = WRITING_RULE_IDS.filter((id) => ruleLevel(fmt, id) === "reject");
  const lines = [fmt.guide_md.trim()];
  if (rejects.length) {
    lines.push("", `다음 규칙에 걸리는 저장은 게이트웨이가 ${LEVEL_WORD.reject}한다(422 — 고쳐서 다시 저장): ${rejects.join(", ")}.`);
  }
  if (fmt.forbid_terms.length) lines.push("", `서술에 쓰지 않는 말: ${fmt.forbid_terms.join(", ")}.`);
  return lines.join("\n");
}
