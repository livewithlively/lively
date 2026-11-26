// 서술 형식 검사의 capability 쪽 배선 — 지식·작업기록·프로젝트 저장이 같은 판정과 같은 응답 모양을 쓰게 한다.
//
// 저장을 막는 것은 reject 규칙뿐이고, 그것도 에이전트 저장에만 건다. 사람 여부는 채널(source)만으로 가르지 않는다
//  — REST(/api/ui)는 웹 화면과 토큰 스크립트가 같은 source='web' 으로 들어오므로, source 로 가르면 토큰으로 REST 를 부르는
//  에이전트가 거부를 비껴간다. 사람은 웹 로그인 세션(tokenSource='session')이거나, 웹 화면이 보낸 요청(화면 표식)이다(isHumanWriter).
import { HttpError } from "../http-error.js";
import { audit } from "../org/store/audit.js";
import { getWritingFormat } from "../org/store/runtime-config.js";
import type { WritingFormat, WritingSurface } from "../org/policies/writing-format.js";
import { lintWriting, LOCAL_PATH_RE, type WritingFinding } from "../v6/writing-lint.js";
import { needsHumanJudgment } from "../v6/writing-rewrite-gate.js";
import { anchorHint, normalizeHomePaths, type TimeAnchor } from "../v6/writing-resolve.js";

/** 웹 화면의 표식 — web/lib/net.ts 의 api() 가 모든 요청에 `x-lively-client` 헤더로 싣고 REST 어댑터(web.ts)가 ctx.client 로 넘긴다.
 *  웹 모듈은 서버 모듈을 import 하지 않는 leaf 라 같은 글자를 그쪽에 따로 적는다 — 바꾸면 둘을 함께 바꾼다. */
export const WEB_UI_CLIENT = "web-ui";

/**
 * 사람의 웹 편집인가 — 앱이 대신 쓰는 호출이 아니면서 ① 웹 로그인 세션이거나 ② 웹 화면이 REST 로 보낸 요청일 때.
 *  ② 는 데스크톱 앱과 «토큰으로 로그인(고급)» 웹 사용자 몫이다. 둘 다 사람이 같은 웹 화면에서 쓰지만 쿠키 세션이 아니라
 *  토큰(Bearer)으로 인증해 tokenSource 가 'db' 다(데스크톱 앱은 CLI 토큰을 웹 화면의 localStorage 에 넣는다 — desktop/preload/web.cjs).
 *  ①만 보면 이들이 에이전트로 판정돼, 지식을 고치거나 프로젝트 본문이 자동 저장될 때 새 위반이 있으면 422 를 받는다.
 *  ⚠ 화면 표식은 요청 헤더라 스크립트도 흉내 낼 수 있다. 이 판정이 정하는 것은 «거부 대신 안내» 뿐인 형식 정책이라 그 위조는 감수한다.
 *   MCP(source 'mcp')는 표식을 실어도 사람이 아니다 — 표식은 REST 어댑터만 넘긴다.
 *  앱 세션은 로그인한 사람의 신원을 물려받지만 글을 쓰는 것은 앱(대개 LLM)이다.
 */
export function isHumanWriter(
  user: { tokenSource?: string; appId?: string } | null | undefined,
  ctx?: { source?: string; client?: string } | null,
): boolean {
  if (!user || user.appId) return false;
  return user.tokenSource === "session" || (ctx?.source === "web" && ctx?.client === WEB_UI_CLIENT);
}

export interface WritingCheckOpts {
  /** 외부 미러 — 원본 소유가 밖이라 고칠 수 없는 글이다. 판정하지 않는다.
   *  ⚠ 호출부는 이 값을 저장 입력이 아니라 **저장된 행**(또는 미러임을 보이는 좌표)으로 정한다 — 입력 하나로 판정을 건너뛰면
   *   reject 를 비껴가는 길이 된다(provenance:"observed" 를 실은 저장). */
  observed?: boolean;
  /** 폴더 — 본문이 없는 구조 노드. 판정하지 않는다. 본문이 있는 폴더는 이 값을 주지 않는다(입력 is_folder 만으로 건너뛰지 않게). */
  folder?: boolean;
  /** 수정 제안(stage)으로 접수 — 라이브가 안 바뀌었고 제안이 있는 동안 edit·append 가 거부되므로 안내가 달라진다. */
  proposed?: boolean;
  /** 고치기 전 글. 있으면 거부는 이번 저장이 새로 만든 위반에만 건다. */
  before?: { title: string | null | undefined; body: string | null | undefined } | null;
  /** 사람의 웹 편집이면 거부하지 않고 안내만 한다(isHumanWriter(user, ctx)). */
  human?: boolean;
  /** 시점 표현 줄의 기준 날짜(writing-resolve timeAnchors). 위반 안내에 싣는다. */
  anchors?: TimeAnchor[];
}

export interface WritingCheck {
  /** 응답에 펼쳐 싣는 조각({} 또는 { style }). */
  info: Record<string, unknown>;
  /** 저장을 거부할 위반. 비어 있으면 저장해도 된다. */
  rejects: WritingFinding[];
  /** 거부 응답에 실을 조직 가이드(위반이 없으면 빈 글). */
  guide: string;
}

// legacy 는 고친 글에 원래 있던 위반이 남았을 때의 다음 행동이다. 거부는 새 위반에만 걸기 때문에 옛 위반은 막히지 않고 남는다
//  — 이 안내가 «같은 글을 한 번 더 저장해 고친다»를 짚지 않으면 수정 저장마다 옛 위반이 그대로 굳는다.
const NEXT_STEP: Record<WritingSurface, { saved: string; proposed: string; legacy: string }> = {
  knowledge: {
    saved: "본문은 mode='edit' 로 그 부분만, 제목은 knowledge_set_title 로 고치세요 — 전문을 다시 보낼 필요가 없습니다.",
    proposed: "제안에 반영하려면 고친 전문으로 같은 지식을 다시 저장하세요 — 제안이 갱신됩니다.",
    legacy: "같은 지식을 mode='edit' 로 한 번 더 저장해 그 부분을 고치세요(제목은 knowledge_set_title).",
  },
  activity: {
    saved: "다음 기록부터 맞추세요.",
    proposed: "다음 기록부터 맞추세요.",
    legacy: "다음 기록부터 맞추세요.",
  },
  project: {
    saved: "같은 항목의 수정 도구(project_update_v6·task_update_v6)로 description 을 고치세요.",
    proposed: "같은 항목의 수정 도구(project_update_v6·task_update_v6)로 description 을 고치세요.",
    legacy: "같은 항목의 수정 도구(project_update_v6·task_update_v6)로 description 을 한 번 더 저장해 고치세요.",
  },
};

// 고치는 법(fix). 사실이 있어야 고칠 수 있는 규칙(needsHumanJudgment) 가운데 그 사실을 서버가 찾아 주거나(기준 날짜) 서버가
//  직접 고치는(홈 경로) 것은 사람에게 묻지 않는다(serverResolves·resolveFindings). 시점 규칙은 그 줄의 기준 날짜를 얻었을
//  때만 그렇다(처음 판을 못 찾은 줄도 마지막 저장일을 상한으로 한 no_later_than 날짜를 얻는다). 기준 날짜를 하나도 얻지
//  못하면(조회 자체가 실패) ask_human 으로 남겨 사람에게 묻는다(날짜를 지어내지 않게).
export const RULE_FIX: Partial<Record<WritingFinding["rule"], string>> = {
  relative_time: "anchors 의 기준 날짜로 고친다. 상대시간은 그 날을 기준으로 절대 날짜로 바꾼다. 형식 정리 저장(style_fix)에서 기준 날짜를 새로 적는 것은 사실 변경으로 보지 않는다.",
  undated_status: "anchors 의 기준 날짜를 같은 문장에 「(YYYY-MM-DD 기준)」으로 붙이거나, 상태 대신 규칙으로 바꾼다. 형식 정리 저장(style_fix)에서 기준 날짜를 새로 적는 것은 사실 변경으로 보지 않는다.",
  local_path: "개인 홈 접두(/Users/<계정>/)를 $HOME 으로, C:\\Users\\<계정>\\ 를 %USERPROFILE%\\ 로 바꾼다. 에이전트가 보내는 글은 서버가 저장할 때 바꾸고, 이미 있던 경로는 형식 정리 저장(mode='edit' style_fix=true)을 하면 서버가 함께 바꾼다. 의미 보존 검사는 이 치환을 사실 변경으로 보지 않는다. 서버는 코드 펜스 안·URL 안의 경로와, 한 글에 계정이 둘 이상인 경로는 바꾸지 않는다(글자 그대로인 로그·설정·명령이거나 다른 사람의 경로다) — 그 경로는 ask_human 으로 남으니 사람에게 확인한다. /home/<계정>/ 경로는 서버의 서비스 계정 경로면 사실이니 그대로 두고, 개인 컴퓨터 경로면 $HOME/ 으로 바꾼다.",
};

export type ResolvedFinding = WritingFinding & {
  fix?: string;
  anchors?: Array<{ line: string; date: string; basis: string; hint: string }>;
  /** 사람 확인이 필요하다 — 고치는 데 글에 없는 사실이 필요하고, 서버도 그 사실을 찾지 못했다. */
  ask_human?: true;
};

// 사실이 필요한 규칙이지만 서버가 사실 없이 처리하는 것 — 경로 치환은 지식 저장 때 서버가 한다.
//  경로 치환은 지식 저장 경로에만 있다(authoring). 경로는 치환한 뒤에도 남는 것(/home/<개인 계정>·펜스 안·URL 안·계정 둘 이상)이
//  있으면 사람 확인이다. text 는 본문이다 — 탐지(lintWriting local_path)도 치환도 본문만 본다.
export interface ResolveContext { surface?: WritingSurface; text?: string }
function serverResolves(rule: WritingFinding["rule"], ctx: ResolveContext): boolean {
  if ((ctx.surface ?? "knowledge") !== "knowledge") return false;
  if (rule === "local_path") return ctx.text != null && (normalizeHomePaths(ctx.text).match(LOCAL_PATH_RE) ?? []).length === 0;
  return false;
}

const ANCHORS_PER_FINDING = 6;
const ANCHOR_LINE_MAX = 120;

/** 위반마다 고치는 법과(있으면) 줄별 기준 날짜를 단다. 저장 응답과 읽기 신호가 같이 쓴다. */
export function resolveFindings(findings: WritingFinding[], anchors: TimeAnchor[] = [], ctx: ResolveContext = {}): ResolvedFinding[] {
  return findings.map((f) => {
    const fix = RULE_FIX[f.rule];
    const ask = needsHumanJudgment(f.rule) ? { ask_human: true as const } : {};
    if (f.rule !== "relative_time" && f.rule !== "undated_status") {
      return { ...f, ...(fix ? { fix } : {}), ...(serverResolves(f.rule, ctx) ? {} : ask) };
    }
    const mine = anchors.filter((a) => (a.rules as string[]).includes(f.rule)).slice(0, ANCHORS_PER_FINDING).map((a) => ({
      line: [...a.line].length > ANCHOR_LINE_MAX ? `${[...a.line].slice(0, ANCHOR_LINE_MAX).join("")}…` : a.line,
      date: a.date, basis: a.basis, hint: anchorHint(a),
    }));
    return mine.length ? { ...f, ...(fix ? { fix } : {}), anchors: mine } : { ...f, ...ask };
  });
}

/** 판정하지 않는 글 — 저장 판정과 읽기 신호가 같은 면제를 쓴다. */
function isWritingExempt(o: { observed?: boolean; folder?: boolean }): boolean {
  return !!(o.observed || o.folder);
}

/**
 * 조직 형식을 읽어 판정한다. 형식을 못 읽거나 판정이 터지면 안내도 거부도 없다(fail-open) — 형식 검사는 저장의 부가 기능이라,
 *  설정 조회 장애로 조직의 모든 기록이 멈추는 쪽이 형식이 한때 흐트러지는 쪽보다 크다.
 */
export async function checkWriting(
  surface: WritingSurface,
  input: { title: string | null | undefined; body: string | null | undefined },
  opts: WritingCheckOpts = {},
  loadFormat: () => Promise<WritingFormat> = getWritingFormat,
): Promise<WritingCheck> {
  const none: WritingCheck = { info: {}, rejects: [], guide: "" };
  if (isWritingExempt(opts)) return none;
  try {
    const fmt = await loadFormat();
    const findings = lintWriting({ title: input.title, body_md: input.body }, fmt, surface);
    if (!findings.length) return none;
    const existed = new Set(opts.before
      ? lintWriting({ title: opts.before.title, body_md: opts.before.body }, fmt, surface).map((f) => f.rule)
      : []);
    const introducedFindings = findings.filter((f) => !existed.has(f.rule));
    const introduced = [...new Set(introducedFindings.map((f) => f.rule))];
    const legacy = [...new Set(findings.filter((f) => existed.has(f.rule)).map((f) => f.rule))];
    const rejects = opts.human ? [] : introducedFindings.filter((f) => f.level === "reject");
    const state = opts.proposed ? "수정 제안으로 접수됐습니다" : "저장은 됐습니다";
    const head = `이 조직의 서술 형식에 어긋난 곳이 ${findings.length}건 있습니다(${state}).`;
    // 제안(stage) 중엔 edit 가 거부되므로, 옛 위반이 있어도 다음 행동은 제안 갱신 안내를 따른다.
    const step = opts.proposed ? NEXT_STEP[surface].proposed : legacy.length ? NEXT_STEP[surface].legacy : NEXT_STEP[surface].saved;
    const marked = resolveFindings(findings, opts.anchors, { surface, text: String(input.body ?? "") });
    const legacyLine = legacy.length
      ? ` 이 글에 원래 있던 형식 위반 ${legacy.length}건(${legacy.join(", ")})이 남아 있습니다. 내용을 고친 김에 형식도 고쳐 주세요.`
      : "";
    // 날짜·현행 여부·경로처럼 글에 없는 사실이 있어야 고칠 수 있는 위반(needsHumanJudgment)은 «고쳐서 다시 저장» 만 말하면
    //  에이전트가 그럴듯한 값을 지어낸다 — 읽기 안내(readStyleNote)와 같이 따로 적고, 그것만 남았으면 고치라는 말은 하지 않는다.
    //  서버가 사실을 찾아 줬거나(anchors) 직접 처리하는 위반은 사람 확인 항목에서 뺀다(resolveFindings 의 ask_human).
    const askRules = [...new Set(marked.filter((f) => f.ask_human).map((f) => f.rule))];
    const askOnly = askRules.length > 0 && marked.every((f) => f.ask_human);
    const askLine = askRules.length
      ? ` 그중 ${askRules.join(", ")} 는 날짜·현행 여부·경로처럼 글에 없는 사실이 있어야 고칠 수 있으니, 지어내지 말고 사람에게 확인한 뒤 고치세요.`
      : "";
    const stepLine = askOnly ? "" : ` ${step} 의미는 바꾸지 말고 형식만 고치세요.`;
    const fixLine = !opts.human && !askOnly && marked.some((f) => f.fix && !f.ask_human)
      ? ` 위반마다 fix 에 고치는 법이 있습니다.${marked.some((f) => f.anchors) ? " 날짜가 필요한 항목은 anchors 의 기준 날짜(저장 기록에서 찾은 값)를 쓰고, 다른 날짜를 지어내지 마세요." : ""}`
      : "";
    return {
      rejects,
      guide: fmt.guide_md,
      info: {
        style: {
          findings: marked,
          introduced,
          legacy,
          note: `${head}${legacyLine}${stepLine}${fixLine}${askLine}`,
          guide_md: fmt.guide_md,
        },
      },
    };
  } catch {
    return none;
  }
}

// 읽기 신호는 위반 목록 앞부분만 싣는다. 가이드 전문은 세션 주입으로 이미 받았고, 상세 조회마다 실으면 응답이 불어난다.
const READ_FINDINGS_MAX = 10;

/** 읽은 자리에서 형식을 고치지 말아야 하는 까닭. no_write: 이 요청으로는 고칠 수 없다(쓰기 게이트·읽기전용 세션·앱 도구 범위) ·
 *  injected: 세션 주입 문구(injection='always') · recently_edited: 다른 사람이 보호 창(24시간) 안에 고쳤다. */
export type ReadStyleEditBlock = "no_write" | "injected" | "recently_edited";

export interface ReadStyleHint {
  /** 위반 전체 건수 — findings 는 앞부분만 싣는다. */
  count: number;
  /** fix — 고치는 법, anchors — 시점 표현 줄의 기준 날짜(저장 기록에서 찾은 값), ask_human — 글에 없는 사실이 필요한데 서버도
   *  찾지 못한 항목(자동 정리 규칙 밖). 에이전트가 혼자 고치면 그럴듯한 값을 지어낸다. */
  findings: ResolvedFinding[];
  /** 있으면 지금 고치지 않는다 — note 도 고치라고 하지 않는다. */
  edit_blocked?: ReadStyleEditBlock;
  note: string;
}

export interface ReadStyleOpts {
  /** 지금 고치면 안 되는 까닭(없으면 null). 위반이 있을 때만 부른다 — 쓰기 게이트 조회를 깨끗한 글의 읽기에 물리지 않으려고. */
  editBlock?: () => Promise<ReadStyleEditBlock | null>;
  /** 부분읽기(offset·limit)로 읽었다 — 판정은 전문 기준이라, 고치기 전에 전문을 읽으라고 덧붙인다. */
  partial?: boolean;
  /** 시점 표현 줄의 기준 날짜를 찾는다(DB 조회). 시점 위반이 있을 때만 부른다. 실패하면 날짜 없이(사람 확인으로) 안내한다. */
  anchorsOf?: () => Promise<TimeAnchor[]>;
}

// 고치지 말아야 하는 까닭 — note 의 첫머리(위반 묶음) 뒤에 그대로 싣는다.
const EDIT_BLOCK_WHY: Record<ReadStyleEditBlock, string> = {
  no_write: "이 요청으로는 이 지식을 고칠 수 없다(쓰기 권한·읽기전용 세션·도구 범위).",
  injected: "모든 AI 세션에 지시문으로 들어가는 세션 주입 문구(injection='always')라 읽은 자리에서 고치는 글이 아니다.",
  recently_edited: "다른 사람이 최근 24시간 안에 고친 글이라 그 사람이 아직 손보는 중일 수 있다.",
};
// 사람 확인 항목을 고치는 데 필요한 사실 — 자동 정리에서 뺀 까닭(writing-rewrite-gate AUTO_FIX_RULES 머리말)과 같다.
const ASK_HUMAN_WHY = "날짜·현행 여부·경로·나눌 자리처럼 글에 없는 사실이 있어야 고칠 수 있다";

/**
 * 읽기 신호의 다음 행동. 직접 고칠 항목(자동 정리 규칙)과 사람 확인이 필요한 항목(ask_human)을 나눠 적고, 반복은 직접 고칠
 *  항목에만 건다 — «위반 0건까지 반복» 이면 ask_human 이 남은 글에서 안내를 따르는 에이전트가 같은 저장을 되풀이하거나 날짜·경로를
 *  지어낸다. 같은 규칙은 한 번 더까지만 고친다(고쳐지지 않는 규칙에서 돌지 않게). 묶음은 잘라 싣기 전 전체 위반으로 센다 — 저장
 *  응답에 남은 규칙이 어느 묶음인지 알아보려면 전부 있어야 한다.
 */
function readStyleNote(findings: ResolvedFinding[], blocked: ReadStyleEditBlock | null, partial: boolean): string {
  const self = findings.filter((f) => !f.ask_human);
  const ask = findings.filter((f) => f.ask_human);
  const rules = (fs: WritingFinding[]): string => fs.map((f) => f.rule).join(", ");
  const groups = [
    self.length ? `직접 고칠 항목 ${self.length}건(${rules(self)})` : "",
    ask.length ? `사람 확인이 필요한 항목 ${ask.length}건(${rules(ask)})` : "",
  ].filter(Boolean).join(", ");
  const head = `이 지식은 조직의 서술 형식에 어긋난 곳이 ${findings.length}건 있다 — ${groups}.`
    + (partial ? " 판정은 받은 줄 범위가 아니라 본문 전체 기준이다." : "");
  if (blocked) return `${head} ${EDIT_BLOCK_WHY[blocked]} 지금 고치지 않는다 — 형식 위반은 그대로 두고 내용만 근거로 쓴다.`;
  const readFull = partial ? " 고치기 전에 offset·limit 없이 전문을 읽는다(edit 의 앵커는 전문에서 찾는다)." : "";
  if (!self.length) {
    return `${head} 모두 ${ASK_HUMAN_WHY}(findings 의 ask_human). 혼자 고치지 않는다 — 이 지식을 작업 근거로 쓰고 있다면 그 사실을 사람에게 묻고, 답을 받은 뒤에만 knowledge_save mode='edit' 로 고친다.${readFull} 사실을 지어내지 않는다.`;
  }
  // 제목이 마지막인 까닭: 본문 저장(style_fix · expected_version)이 판을 하나 올리므로, 제목을 먼저 고치면 읽을 때 받은 version 으로
  //  보낸 본문 저장이 409 가 된다. 본문을 먼저 고치고 그 응답의 판으로 제목을 고치는 순서가 왕복이 적다.
  //  (knowledge_set_title 도 저장 채널을 confidence 에 남기므로 — #1740 — 제목 변경 뒤에도 «내 마지막 저장» 판정은 유지된다.)
  const title = self.some((f) => f.rule.startsWith("title_")) ? " 제목은 본문을 고친 뒤 마지막에 knowledge_set_title 로 고친다." : "";
  const fix = self.some((f) => f.fix)
    ? ` 위반마다 fix 에 고치는 법이 있다.${self.some((f) => f.anchors) ? " 날짜가 필요한 항목은 anchors 의 기준 날짜(저장 기록에서 찾은 값)를 쓴다." : ""}`
    : "";
  const askLine = ask.length
    ? ` 사람 확인이 필요한 항목(findings 의 ask_human)은 ${ASK_HUMAN_WHY} — 지어내지 말고 사람에게 묻고, 답을 받은 뒤에만 고친다. 저장 응답의 안내가 한 번 더 고치라고 해도 사람 확인이 필요한 항목만 남으면 멈추고 사람에게 묻는다.`
    : "";
  return `${head} 이 지식을 작업 근거로 쓰고 있다면 직접 고칠 항목을 지금 고친다.${readFull} 본문은 knowledge_save mode='edit' 로 그 부분만 고치고, style_fix:true 와 이 응답의 knowledge.version 을 expected_version 으로 함께 보낸다(서버가 사실·수치·링크가 그대로인지와 그 사이 다른 저장이 없었는지 본다).${title}${fix} 의미·사실·수치·코드 위치·[[링크]]는 그대로 두고 형식만 고친다. 저장 응답의 style 에 직접 고칠 항목이 남아 있으면 한 번 더 고치고, 같은 규칙이 그래도 남으면 더 고치지 않고 멈춘다.${askLine}`;
}

/**
 * 지식 상세 조회에 싣는 서술 형식 신호({} 또는 { style }). 조직 지시가 «읽은 지식이 형식에 어긋나면 고쳐라» 라서,
 *  에이전트가 어긋났는지를 문서마다 알 수 있어야 한다. 면제·fail-open 은 checkWriting 과 같다 — 신호 때문에 읽기가 실패하면 안 된다.
 *  지금 고치면 안 되는 글(edit_blocked)이면 위반은 싣되 note 가 고치라고 하지 않는다 — 주입 문구는 행으로, 권한·최근 편집은
 *  호출부의 opts.editBlock 으로 가린다. 부분읽기(opts.partial)면 판정이 전문 기준이라는 것과 고치기 전에 전문을 읽으라는 말을 더한다.
 */
export async function readStyleHint(
  k: {
    title: string | null | undefined; body_md: string | null | undefined;
    provenance?: string | null; is_folder?: boolean | null; lifecycle?: string | null; injection?: string | null;
  },
  loadFormat: () => Promise<WritingFormat> = getWritingFormat,
  opts: ReadStyleOpts = {},
): Promise<{ style?: ReadStyleHint }> {
  if (isWritingExempt({ observed: k.provenance === "observed", folder: k.is_folder === true })) return {};
  // 보관·대체된 지식은 더 이상 근거로 쓰지 않는 글이라 고치라고 안내하지 않는다.
  if (k.lifecycle === "archived" || k.lifecycle === "superseded") return {};
  try {
    const findings = lintWriting({ title: k.title, body_md: k.body_md }, await loadFormat(), "knowledge");
    if (!findings.length) return {};
    // 고쳐도 되는지는 위반이 있을 때만 가린다 — 쓰기 게이트 조회를 깨끗한 글의 읽기에 물리지 않는다.
    //  주입 문구는 행만 보고 가른다: 모든 AI 세션에 지시문으로 들어가는 글이라 관리자가 읽어도 읽은 자리에서 고치지 않는다.
    //  권한·최근 편집은 요청마다 달라 호출부가 가린다. 그 판정이 터지면 고치라고 하지 않는다(신호는 싣고 안내만 닫는다).
    let blocked: ReadStyleEditBlock | null = k.injection === "always" ? "injected" : null;
    if (!blocked && opts.editBlock) {
      try {
        blocked = await opts.editBlock();
      } catch {
        blocked = "no_write";
      }
    }
    //  기준 날짜는 시점 위반이 있을 때만 찾는다(DB 조회). 못 찾은 시점 위반은 사람 확인 항목으로 남는다.
    const needsAnchors = findings.some((f) => f.rule === "relative_time" || f.rule === "undated_status");
    const anchors = needsAnchors && opts.anchorsOf ? await opts.anchorsOf().catch(() => []) : [];
    const marked = resolveFindings(findings, anchors, { surface: "knowledge", text: String(k.body_md ?? "") });
    return {
      style: {
        count: findings.length,
        findings: marked.slice(0, READ_FINDINGS_MAX),
        ...(blocked ? { edit_blocked: blocked } : {}),
        note: readStyleNote(marked, blocked, opts.partial === true),
      },
    };
  } catch {
    return {};
  }
}

/** 거부 응답 — MCP 는 에러 메시지만 전달하므로 고칠 곳과 가이드를 메시지 본문에 담는다(REST 는 body 로도 준다). */
export function writingRejectError(rejects: WritingFinding[], guide: string): HttpError {
  const lines = rejects.map((f) => `- ${f.rule}: ${f.message}${f.sample ? ` (예: ${f.sample})` : ""}`);
  const msg = [
    `이 조직의 서술 형식에 맞지 않아 저장하지 않았습니다(${rejects.length}건). 아래를 고쳐 같은 호출로 다시 저장하세요. 의미는 바꾸지 말고 형식만 고치세요.`,
    ...lines,
    "",
    guide,
  ].join("\n");
  return new HttpError(422, msg, { body: { style: { findings: rejects, guide_md: guide } } });
}

type AuditFn = typeof audit;

export interface WritingRejectCtx {
  actor?: string | null;
  source?: string | null;
  tokenHashPrefix?: string | null;
  ip?: string | null;
}

/**
 * 거부를 감사 로그(org_content_audit, entity=writing_format, op=reject)에 남기고 거부 에러를 돌려준다.
 *  거부된 저장은 DB 어디에도 흔적이 없어서, 이 기록이 없으면 «규칙이 몇 번·누구에게·어느 규칙으로 걸렸나» 를 셀 수 없다.
 *  조회: org_audit_list {entity:"writing_format"}. 본문은 싣지 않는다(크기·민감정보) — 표면·규칙·대상·제목 앞부분만.
 *  기록이 실패해도 거부 응답은 그대로 나간다 — 로그 장애로 저장이 통과되거나 500 이 되면 안 된다.
 */
export async function rejectWriting(
  surface: WritingSurface,
  target: string | null,
  title: string | null | undefined,
  rejects: WritingFinding[],
  guide: string,
  ctx: WritingRejectCtx | undefined,
  record: AuditFn = audit,
): Promise<HttpError> {
  const t = String(title ?? "").trim();
  try {
    await record("writing_format", target, "reject", null, {
      surface,
      rules: rejects.map((f) => f.rule),
      ...(t ? { title: [...t].slice(0, 80).join("") } : {}),
    }, ctx?.actor ?? undefined, ctx?.source ?? undefined, { tokenHashPrefix: ctx?.tokenHashPrefix ?? null, ip: ctx?.ip ?? null });
  } catch { /* 기록 실패는 거부를 바꾸지 않는다 */ }
  return writingRejectError(rejects, guide);
}
