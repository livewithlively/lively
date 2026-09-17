// AGENTS.md 의 «사람 규칙» 영역 판정 — 생성기(agents-md.ts)와 저장소 이관(project-storage.ts)이 **같은 자**로 잰다.
//  import 가 없는 잎 모듈이다: 이관이 생성기를 가져오면 생성기 → 저장소 → 생성기 순환이 된다(#4064).

export const RULES_MARK = "<!-- LIVELY:RULES — 아래는 사람이 작성·편집 (digest 는 자동 갱신, 규칙은 보존) -->";
// 규칙이 비었을 때 '## 규칙' 본문 자리표시 — HTML 주석이라 사람이 파일을 열면 힌트로 보이되 AI 에겐 지시문으로
//  읽히지 않는다(과거엔 안내 문장을 그대로 써넣어 AI 컨텍스트를 오염시켰다 — #246). 규칙을 저장하면 사라진다.
export const RULES_PLACEHOLDER = "<!-- (아직 작성된 규칙이 없습니다) 이 프로젝트에서 AI가 지켰으면 하는 규칙을 적으세요 — 웹: 프로젝트 ▸ 세부 설정 ▸ 규칙 -->";
// 구(舊) 기본 템플릿 문장 — 디스크의 기존 AGENTS.md 에 본문으로 박혀 있을 수 있어, 읽을 때 '빈 규칙'으로 이관 처리한다.
const LEGACY_DEFAULT_RULES = "여기에 이 프로젝트에서 AI가 지켰으면 하는 걸 적으세요. (예: 새로 만들기 전에 비슷한 게 있는지 먼저 찾는다 / 큰 변경·삭제는 먼저 물어본다)";
/** 생성기가 digest 머리에 박는 문장 — «이 AGENTS.md 는 우리가 쓴 것인가» 의 판정 재료 */
export const GENERATED_BANNER = "> 이 파일은 lively 가 자동 생성합니다";
/** CLAUDE.md 에 우리가 쓰는 한 줄 — Claude Code 가 CLAUDE.md 를 로드하므로 AGENTS.md 를 끌어온다 */
export const CLAUDE_IMPORT = "@AGENTS.md";

export function extractRules(content: string): string | null {
  const i = content.indexOf(RULES_MARK);
  if (i < 0) return null;
  const body = content.slice(i + RULES_MARK.length)
    .replace(/^\s*##\s*규칙\s*\n?/, "")
    .replace(/<!--[\s\S]*?-->/g, "")  // 자리표시 주석 제거 → 주석만 있으면 빈 규칙
    .trim();
  return body === LEGACY_DEFAULT_RULES ? "" : body;  // 구 기본 템플릿 문장도 빈 규칙으로 이관
}

// 구 CLAUDE.md 의 사람 규칙(LIVELY:REFS 자동블록 제외) — AGENTS.md 최초 생성 시 1회 이관.
export function stripClaudeManaged(content: string): string {
  const s = content.indexOf("<!-- LIVELY:REFS");
  return (s >= 0 ? content.slice(0, s) : content).trim();
}

/** 구 형식(자동블록이 든) CLAUDE.md 인가 — 이미 규칙이 AGENTS.md 로 옮겨졌으면 import 한 줄로 정리해도 된다 */
export function isLegacyManagedClaude(content: string): boolean {
  return content.includes("<!-- LIVELY:REFS");
}

/** CLAUDE.md 에 AGENTS.md import 줄이 이미 있나(사람이 쓴 문서 안에 섞여 있어도 된다) */
export function hasClaudeImport(content: string): boolean {
  return content.split(/\r?\n/).some((l) => l.trim() === CLAUDE_IMPORT);
}

/** 우리가 쓴 AGENTS.md 인가 — 규칙 표식이나 생성 문장이 있으면 우리 것이다 */
export function isGeneratedAgentsMd(content: string): boolean {
  return content.includes(RULES_MARK) || content.includes(GENERATED_BANNER);
}

/** 규칙을 어디서 읽었나 — CLAUDE.md 를 import 한 줄로 정리해도 되는지가 여기에 달렸다 */
export type RulesSource = "agents" | "claude" | "none";

/**
 * 사람 규칙과 그 출처(순수 판정 — 읽기는 호출부가 한다).
 *  ① AGENTS.md 의 규칙 표식 아래 — 정본.
 *  ② AGENTS.md 가 아직 없고 옛 자리의 원본(original)에 규칙이 있으면 — 저장소를 옮기는 중이다(project-storage 이관).
 *  ③ 표식 없는 AGENTS.md 가 우리 것이 아니면 — 사람이 쓴 문서다. 통째로 규칙 자리로 옮겨 잃지 않는다(#4064).
 *  ④ 구 CLAUDE.md 의 사람 규칙 — AGENTS.md 최초 생성 시 1회 이관. 우리가 쓴 import 한 줄은 규칙이 아니다.
 */
export function pickRules(o: { agents: string | null; original: string | null; claude: string | null }): { rules: string; from: RulesSource } {
  const marked = o.agents == null ? null : extractRules(o.agents);
  if (marked != null) return { rules: marked, from: "agents" };
  if (o.agents == null && o.original != null) {
    const r = extractRules(o.original);
    if (r != null) return { rules: r, from: "agents" };
  }
  if (o.agents != null && o.agents.trim() && !isGeneratedAgentsMd(o.agents)) return { rules: o.agents.trim(), from: "agents" };
  const legacy = o.claude == null ? "" : stripClaudeManaged(o.claude);
  if (legacy && legacy !== CLAUDE_IMPORT) return { rules: legacy, from: "claude" };
  return { rules: "", from: "none" };
}

/**
 * CLAUDE.md 의 다음 내용 — null 이면 손대지 않는다.
 *  import 한 줄로 정리하는 건 ①없거나 비었을 때 ②규칙을 방금 CLAUDE.md 에서 옮겨 왔을 때(내용은 이제 AGENTS.md 규칙에 있다)
 *  ③구 자동블록 형식일 때뿐이다. 그 밖(사람이 쓴 CLAUDE.md)은 **덮지 않고** import 줄이 없을 때만 맨 위에 보탠다(#4064).
 */
export function nextClaudeMd(prev: string | null, rulesFrom: RulesSource): string | null {
  if (prev == null || !prev.trim() || rulesFrom === "claude" || isLegacyManagedClaude(prev)) {
    return prev != null && prev.trim() === CLAUDE_IMPORT ? null : `${CLAUDE_IMPORT}\n`;
  }
  return hasClaudeImport(prev) ? null : `${CLAUDE_IMPORT}\n\n${prev}`;
}

/** 두 AGENTS.md 가 **같은 사람 규칙**을 담고 있나 — digest(자동 영역)는 시점마다 달라도 된다 */
export function sameRules(a: string, b: string): boolean {
  const ra = extractRules(a);
  const rb = extractRules(b);
  return ra != null && rb != null && ra === rb;
}
