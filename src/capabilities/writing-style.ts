// 서술 형식 검사의 capability 쪽 배선 — 지식·작업기록·프로젝트 저장이 같은 판정과 같은 응답 모양을 쓰게 한다.
//
// 저장을 막는 것은 reject 규칙뿐이고, 그것도 에이전트 저장에만 건다. 사람 여부는 채널(source)이 아니라 인증 출처로 가른다
//  — REST(/api/ui)는 웹 화면과 토큰 스크립트가 같은 source='web' 으로 들어오므로, source 로 가르면 토큰으로 REST 를 부르는
//  에이전트가 거부를 비껴간다. 웹 로그인 세션(tokenSource='session')만 사람이다.
import { HttpError } from "../http-error.js";
import { audit } from "../org/store/audit.js";
import { getWritingFormat } from "../org/store/runtime-config.js";
import type { WritingFormat, WritingSurface } from "../org/policies/writing-format.js";
import { lintWriting, type WritingFinding } from "../v6/writing-lint.js";
import { needsHumanJudgment } from "../v6/writing-rewrite-gate.js";

/** 사람의 웹 편집인가 — 웹 로그인 세션이면서 앱이 대신 쓰는 호출이 아닐 때만. 앱 세션은 로그인한 사람의 신원을
 *  물려받지만 글을 쓰는 것은 앱(대개 LLM)이다. */
export function isHumanWriter(user: { tokenSource?: string; appId?: string } | null | undefined): boolean {
  return user?.tokenSource === "session" && !user?.appId;
}

export interface WritingCheckOpts {
  /** 외부 미러 — 원본 소유가 밖이라 고칠 수 없는 글이다. 판정하지 않는다. */
  observed?: boolean;
  /** 폴더 — 본문이 없는 구조 노드. 판정하지 않는다. */
  folder?: boolean;
  /** 수정 제안(stage)으로 접수 — 라이브가 안 바뀌었고 제안이 있는 동안 edit·append 가 거부되므로 안내가 달라진다. */
  proposed?: boolean;
  /** 고치기 전 글. 있으면 거부는 이번 저장이 새로 만든 위반에만 건다. */
  before?: { title: string | null | undefined; body: string | null | undefined } | null;
  /** 사람의 웹 편집이면 거부하지 않고 안내만 한다. */
  human?: boolean;
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
    const legacyLine = legacy.length
      ? ` 이 글에 원래 있던 형식 위반 ${legacy.length}건(${legacy.join(", ")})이 남아 있습니다. 내용을 고친 김에 형식도 고쳐 주세요.`
      : "";
    return {
      rejects,
      guide: fmt.guide_md,
      info: {
        style: {
          findings,
          introduced,
          legacy,
          note: `${head}${legacyLine} ${step} 의미는 바꾸지 말고 형식만 고치세요.`,
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
  /** ask_human — 자동 정리에서 뺀 규칙이다(writing-rewrite-gate AUTO_FIX_RULES 밖). 고치는 데 «그날이 언제였나» 같은
   *  사실 판단이 필요해, 에이전트가 혼자 고치면 그럴듯한 값을 지어낸다. */
  findings: Array<WritingFinding & { ask_human?: true }>;
  /** 있으면 지금 고치지 않는다 — note 도 고치라고 하지 않는다. */
  edit_blocked?: ReadStyleEditBlock;
  note: string;
}

export interface ReadStyleOpts {
  /** 지금 고치면 안 되는 까닭(없으면 null). 위반이 있을 때만 부른다 — 쓰기 게이트 조회를 깨끗한 글의 읽기에 물리지 않으려고. */
  editBlock?: () => Promise<ReadStyleEditBlock | null>;
  /** 부분읽기(offset·limit)로 읽었다 — 판정은 전문 기준이라, 고치기 전에 전문을 읽으라고 덧붙인다. */
  partial?: boolean;
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
 *  응답에 남은 규칙이 어느 묶음인지 알아보려면 전부 있어야 한다. 저장 응답의 안내(checkWriting)는 ask_human 을 가르지 않으므로
 *  «그래도 멈춘다» 를 여기서 말해 둔다.
 */
function readStyleNote(findings: WritingFinding[], blocked: ReadStyleEditBlock | null, partial: boolean): string {
  const self = findings.filter((f) => !needsHumanJudgment(f.rule));
  const ask = findings.filter((f) => needsHumanJudgment(f.rule));
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
  // 제목이 마지막인 까닭: knowledge_set_title 은 편집자(updated_by)·시각은 바꾸고 confidence 는 그대로 둔다. 사람이 마지막으로 저장한 글의
  //  제목부터 고치면 «내 마지막 저장»(updated_by 가 같고 confidence='ai')이 아니게 되어, 본문 고치기가 최근 편집 보호에 막힌다.
  //  MCP 본문 저장(confidence='ai')이 먼저면 그 뒤 제목 변경도 내 마지막 저장으로 남는다.
  const title = self.some((f) => f.rule.startsWith("title_")) ? " 제목은 본문을 고친 뒤 마지막에 knowledge_set_title 로 고친다." : "";
  const askLine = ask.length
    ? ` 사람 확인이 필요한 항목(findings 의 ask_human)은 ${ASK_HUMAN_WHY} — 지어내지 말고 사람에게 묻고, 답을 받은 뒤에만 고친다. 저장 응답의 안내가 한 번 더 고치라고 해도 사람 확인이 필요한 항목만 남으면 멈추고 사람에게 묻는다.`
    : "";
  return `${head} 이 지식을 작업 근거로 쓰고 있다면 직접 고칠 항목을 지금 고친다.${readFull} 본문은 knowledge_save mode='edit' 로 그 부분만 고친다.${title} 의미·사실·수치·코드 위치·[[링크]]는 그대로 두고 형식만 고친다. 저장 응답의 style 에 직접 고칠 항목이 남아 있으면 한 번 더 고치고, 같은 규칙이 그래도 남으면 더 고치지 않고 멈춘다.${askLine}`;
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
    return {
      style: {
        count: findings.length,
        findings: findings.slice(0, READ_FINDINGS_MAX).map((f) => (needsHumanJudgment(f.rule) ? { ...f, ask_human: true as const } : f)),
        ...(blocked ? { edit_blocked: blocked } : {}),
        note: readStyleNote(findings, blocked, opts.partial === true),
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
