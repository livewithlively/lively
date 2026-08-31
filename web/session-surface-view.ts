// 세션 표면의 **순수 로직** (#2439 ④) — DOM·네트워크 의존 없음.
//
//  ── 왜 갈라 두나 ────────────────────────────────────────────────────────────────
//  화면 코드는 `core.js` 를 타고 브라우저 전역에 닿아 node 에서 로드조차 안 된다. 그러면
//  «무엇을 어떻게 말하나» 같은 판단을 값으로 지킬 수 없다(session-tasks-view 와 같은 규율).
//
//  ── 여기 있는 판단이 왜 중요한가 ────────────────────────────────────────────────
//  이 화면의 독자는 **컴맹 중학생**이다(상민님 기준). 그러면 다음이 전부 판단거리가 된다:
//   · 승인 버튼에 뭐라고 적나 — "accept" 도 "allow_once" 도 사람 말이 아니다.
//   · 위험한 것을 어떻게 티 내나 — `rm -rf` 와 `ls` 가 같은 카드로 뜨면 안 된다.
//   · 슬래시를 어떻게 고르나 — 터미널은 `/` 를 치면 목록이 뜬다. 웹에서 그게 없으면 «기능 없음» 이다.
//  이 규칙들이 틀리면 화면은 떠 있는데 사람이 못 쓴다 — 그게 가장 비싼 실패다.

/** 서버 어휘(harness-io/session-event.ts)의 화면 쪽 그림자 — **필드를 늘릴 때 서버와 함께 늘린다.** */
export interface AskInfo {
  id: string;
  toolName: string;
  input?: unknown;
  title?: string;
  displayName?: string;
  description?: string;
  suggestions?: unknown[];
}
export interface SlashCommandInfo { name: string; description?: string; argumentHint?: string }
export interface FactsInfo {
  model?: string;
  permissionMode?: string;
  commands?: SlashCommandInfo[];
  skills?: string[];
  agents?: string[];
  mcpServers?: Array<{ name: string; status: string }>;
}
export interface UsageInfo {
  utilization?: Record<string, number>;
  resetsAt?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}
/** 사람이 고른 답 — **우리 낱말**이다(하네스 낱말은 서버의 respond 가 만든다). */
export interface AnswerChoice { label: string; value: { allow: boolean; scope?: "once" | "always"; optionId?: string }; primary?: boolean; hint: string }

/**
 * 승인 카드의 **제목** — 사람이 읽고 판단할 수 있는 한 줄.
 *  ⚠ 도구 이름만 적으면 판단이 불가능하다("Bash 를 허용할까요?" 는 아무 정보가 아니다).
 */
export function askHeadline(ask: AskInfo): string {
  return (ask.title || ask.displayName || ask.toolName || "확인").trim();
}

/** 카드 왼쪽의 종류 딱지 — 무슨 일이 벌어지려는지 한눈에. */
export function askKind(ask: AskInfo): string {
  const t = String(ask.toolName || "").toLowerCase();
  if (t.includes("bash") || t.includes("execute") || t === "command") return "명령 실행";
  if (t.includes("patch") || t.includes("edit") || t.includes("write")) return "파일 변경";
  if (t.includes("read") || t.includes("glob") || t.includes("grep")) return "파일 읽기";
  if (t.includes("fetch") || t.includes("websearch") || t.includes("http")) return "인터넷 접속";
  if (t.includes("elicitation") || t.includes("확인")) return "확인";
  return "권한";
}

/** 카드 본문 — **원문 그대로** 보여 준다(요약하면 사람이 무엇을 허용하는지 모른다). */
export function askDetail(ask: AskInfo): string {
  const i = ask.input;
  if (typeof i === "string") return i;
  if (i && typeof i === "object") {
    const o = i as Record<string, unknown>;
    const cmd = o.command;
    if (typeof cmd === "string") return cmd;
    if (Array.isArray(cmd)) return cmd.map(String).join(" ");
    try { return JSON.stringify(o, null, 2); } catch { /* 순환 참조 */ }
  }
  return ask.description || askHeadline(ask);
}

//  ⚠ **되돌릴 수 없는 것**만 고른다. 여기에 흔한 명령을 넣으면 경고가 늘 떠서 아무도 안 읽는다
//   (경고 피로 — 늘 빨간 화면은 안 빨간 화면과 같다).
const DESTRUCTIVE = /\b(rm\s+-[rf]|rm\s+-\w*[rf]|mkfs|dd\s+if=|shutdown|reboot|:\s*\(\)\s*\{|drop\s+(table|database)|truncate\s+table|git\s+push\s+.*--force|git\s+reset\s+--hard|chmod\s+-R\s+777)\b/i;

/**
 * 이 요청은 **되돌리기 어려운가** — 카드에 경고를 세울지 정한다.
 *  ⚠ 판단을 대신 하지 않는다(자동 거부하지 않는다). 사람이 결정하되 **모르고 누르지는 않게** 한다.
 */
export function askIsRisky(ask: AskInfo): boolean {
  return DESTRUCTIVE.test(askDetail(ask));
}

/**
 * 이 카드에 놓을 **버튼들** — 하네스가 선택지를 줬으면 그것을, 아니면 우리 기본 셋.
 *
 *  ⚠ 선택지를 준 하네스(ACP)는 **그중 하나를 돌려줘야** 한다 — 우리가 지어낸 값은 튕기고 턴이 선다.
 *  ⚠ «항상 허용» 은 하네스가 그 감을 줬을 때만 그린다. 없는데 그리면 눌러도 이번 한 번만 되고,
 *   사람은 «껐는데 또 묻네» 를 겪는다(가장 신뢰를 깎는 종류의 거짓말이다).
 */
export function askChoices(ask: AskInfo): AnswerChoice[] {
  const opts = (Array.isArray(ask.suggestions) ? ask.suggestions : []) as Array<Record<string, unknown>>;
  //  하네스가 «고르라» 고 준 선택지(ACP options): optionId + name 이 있는 것만 쓴다.
  const acp = opts.filter((o) => o && typeof o.optionId === "string" && typeof o.name === "string");
  if (acp.length) {
    return acp.map((o) => {
      const kind = String(o.kind ?? "");
      const allow = !kind.startsWith("reject");
      return {
        label: String(o.name),
        value: { allow, scope: kind.endsWith("always") ? "always" as const : "once" as const, optionId: String(o.optionId) },
        primary: kind === "allow_once",
        hint: allow ? "이 작업을 실행합니다" : "실행하지 않고 하던 일을 이어갑니다",
      };
    });
  }
  //  선택지를 안 준 하네스 — 우리 기본 셋. «항상» 은 근거(제안)가 있을 때만.
  const canAlways = opts.length > 0;
  return [
    { label: "허용", value: { allow: true, scope: "once" }, primary: true, hint: "이번 한 번만 실행합니다" },
    ...(canAlways ? [{ label: "항상 허용", value: { allow: true, scope: "always" as const }, hint: "같은 요청을 앞으로 묻지 않습니다" }] : []),
    { label: "거부", value: { allow: false, scope: "once" }, hint: "실행하지 않고 하던 일을 이어갑니다" },
  ];
}

/**
 * 슬래시 자동완성 — 지금 친 글에서 **명령을 고르는 중인가**, 그렇다면 무엇이 후보인가.
 *
 *  ⚠ 줄 맨 앞의 `/` 일 때만 연다. 문장 가운데의 `/`(경로 `src/foo`)에 목록이 뜨면 방해만 된다.
 *  ⚠ 공백이 나오면 닫는다 — `/review 이 파일` 은 이미 명령을 고른 뒤라 목록이 필요 없다.
 */
export function slashQuery(text: string, caret: number): string | null {
  const head = text.slice(0, caret);
  const lineStart = head.lastIndexOf("\n") + 1;
  const line = head.slice(lineStart);
  if (line[0] !== "/") return null;
  const rest = line.slice(1);
  if (/\s/.test(rest)) return null;
  return rest;
}

/** 후보 목록 — 앞글자 일치를 먼저, 그다음 부분 일치(터미널 자동완성과 같은 감). */
export function slashMatches(commands: readonly SlashCommandInfo[], q: string, limit = 8): SlashCommandInfo[] {
  const needle = q.toLowerCase();
  const starts: SlashCommandInfo[] = [];
  const contains: SlashCommandInfo[] = [];
  for (const c of commands) {
    const n = String(c.name || "").toLowerCase();
    if (!n) continue;
    if (n.startsWith(needle)) starts.push(c);
    else if (needle && n.includes(needle)) contains.push(c);
  }
  return [...starts, ...contains].slice(0, limit);
}

/** 고른 명령을 글에 끼워 넣은 결과 — 커서 위치까지 함께 돌려준다(화면이 커서를 옮긴다). */
export function applySlash(text: string, caret: number, name: string): { text: string; caret: number } {
  const head = text.slice(0, caret);
  const lineStart = head.lastIndexOf("\n") + 1;
  const next = `${text.slice(0, lineStart)}/${name} `;
  return { text: next + text.slice(caret), caret: next.length };
}

/**
 * 사용량 한 줄 — **가장 빡빡한 창**을 말한다.
 *  ⚠ 여러 창(5시간·주간…)을 다 늘어놓으면 아무도 안 읽는다. 사람이 알아야 할 것은 «언제 막히나» 하나다.
 *  ⚠ 여유로울 땐 **아무 말도 안 한다**(null) — 늘 떠 있는 숫자는 화면만 좁힌다.
 */
export function usageLine(u: UsageInfo, now = Date.now()): string | null {
  const util = u.utilization ?? {};
  let worstKey = "";
  let worst = 0;
  for (const [k, v] of Object.entries(util)) {
    if (typeof v === "number" && v > worst) { worst = v; worstKey = k; }
  }
  if (!worstKey || worst < 0.5) return null;      // 절반도 안 썼으면 말할 일이 아니다
  const pct = Math.round(worst * 100);
  const when = u.resetsAt && u.resetsAt > now ? ` · ${untilText(u.resetsAt - now)} 뒤 초기화` : "";
  return `사용량 ${pct}%${when}`;
}

/** 남은 시간을 사람 말로. */
export function untilText(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${Math.max(1, m)}분`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}시간` : `${Math.floor(h / 24)}일`;
}

/**
 * 세션 사실 칩들 — 지금 무엇으로 도는지.
 *  ⚠ **모르는 것은 안 그린다**(빈 칩은 «없다» 로 읽힌다). 값이 있는 것만 나온다.
 */
export function factChips(f: FactsInfo): string[] {
  const out: string[] = [];
  if (f.model) out.push(f.model);
  if (f.permissionMode === "needs-auth") out.push("로그인 필요");
  else if (f.permissionMode) out.push(PERM_KO[f.permissionMode] ?? f.permissionMode);
  const mcp = (f.mcpServers ?? []).filter((m) => m.status !== "failed").length;
  if (mcp) out.push(`도구 ${mcp}`);
  if (f.agents?.length) out.push(`에이전트 ${f.agents.length}`);
  return out;
}

//  하네스 낱말 → 사람 말. 모르는 값은 **그대로 둔다**(지어낸 번역이 더 나쁘다).
const PERM_KO: Record<string, string> = {
  default: "물어보고 실행", acceptEdits: "수정 자동 허용", bypassPermissions: "확인 없이 실행",
  plan: "계획만", "on-request": "필요할 때 확인", "on-failure": "실패할 때 확인", never: "확인 안 함", untrusted: "확인 필요",
};

//  축 이름 → 사람 말. **서버의 COVERAGE_AXES 와 짝이다** — 늘릴 때 함께 늘린다.
//  ⚠ 모르는 축은 지어내지 않고 **빼 버린다**(정체 모를 낱말을 화면에 세우면 사람이 더 헷갈린다).
const AXIS_KO: Record<string, string> = {
  read: "읽기", send: "보내기", tasks: "작업 목록", approve: "승인",
  slash: "슬래시 명령", usage: "사용량", interrupt: "멈추기", model: "모델 바꾸기",
};

/**
 * «이건 터미널에서 하세요» 안내문 — 웹에서 못 하는 축이 있을 때만.
 *
 *  ⚠ 이 줄이 없으면 사람은 **없는 기능을 찾아 헤매다 포기한다**(막다른 길). 그게 «반쪽 UX» 의
 *   두 번째 얼굴이다 — 첫 번째는 기능이 없는 것이고, 두 번째는 **없다는 사실을 안 알려주는 것**이다.
 *  ⚠ 전부 되면 **아무 말도 안 한다**(null). 늘 뜨는 안내는 아무도 안 읽는다.
 */
export function terminalOnlyNote(axes: readonly string[]): string | null {
  const ko = axes.map((a) => AXIS_KO[a]).filter(Boolean);
  if (!ko.length) return null;
  return `${ko.join(" · ")}\u2014 이 AI 는 터미널 탭에서만 됩니다`;
}
