// 서술 형식 검사의 capability 쪽 배선 — 지식·작업기록·프로젝트 저장이 같은 판정과 같은 응답 모양을 쓰게 한다.
//
// 저장을 막는 것은 reject 규칙뿐이고, 그것도 에이전트 저장에만 건다. 사람 여부는 채널(source)만으로 가르지 않는다
//  — REST(/api/ui)는 웹 화면과 토큰 스크립트가 같은 source='web' 으로 들어오므로, source 로 가르면 토큰으로 REST 를 부르는
//  에이전트가 거부를 비껴간다. 사람은 웹 로그인 세션(tokenSource='session')이거나, 웹 화면이 보낸 요청(화면 표식)이다(isHumanWriter).
import { HttpError } from "../http-error.js";
import { audit } from "../org/store/audit.js";
import { getWritingFormat } from "../org/store/runtime-config.js";
import type { WritingFormat, WritingSurface } from "../org/policies/writing-format.js";
import { lintWriting, type WritingFinding } from "../v6/writing-lint.js";

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
  if (opts.observed || opts.folder) return none;
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
