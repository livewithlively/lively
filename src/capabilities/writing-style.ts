// 서술 형식 검사의 capability 쪽 배선 — 지식·작업기록·프로젝트 저장이 같은 판정과 같은 응답 모양을 쓰게 한다.
//
// 저장을 막는 것은 reject 규칙뿐이고, 그것도 에이전트 저장에만 건다. 사람 여부는 채널(source)이 아니라 인증 출처로 가른다
//  — REST(/api/ui)는 웹 화면과 토큰 스크립트가 같은 source='web' 으로 들어오므로, source 로 가르면 토큰으로 REST 를 부르는
//  에이전트가 거부를 비껴간다. 웹 로그인 세션(tokenSource='session')만 사람이다.
import { HttpError } from "../http-error.js";
import { getWritingFormat } from "../org/store/runtime-config.js";
import type { WritingFormat, WritingSurface } from "../org/policies/writing-format.js";
import { lintWriting, type WritingFinding } from "../v6/writing-lint.js";

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
}

const NEXT_STEP: Record<WritingSurface, { saved: string; proposed: string }> = {
  knowledge: {
    saved: "본문은 mode='edit' 로 그 부분만, 제목은 knowledge_set_title 로 고치세요 — 전문을 다시 보낼 필요가 없습니다.",
    proposed: "제안에 반영하려면 고친 전문으로 같은 지식을 다시 저장하세요 — 제안이 갱신됩니다.",
  },
  activity: {
    saved: "external_system·external_id 로 남긴 기록이면 같은 키로 다시 부르면 갱신됩니다. 아니면 다음 기록부터 맞추세요.",
    proposed: "다음 기록부터 맞추세요.",
  },
  project: {
    saved: "project_update_v6 의 description 으로 고치세요.",
    proposed: "project_update_v6 의 description 으로 고치세요.",
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
  const none: WritingCheck = { info: {}, rejects: [] };
  if (opts.observed || opts.folder) return none;
  try {
    const fmt = await loadFormat();
    const findings = lintWriting({ title: input.title, body_md: input.body }, fmt, surface);
    if (!findings.length) return none;
    const existed = new Set(opts.before
      ? lintWriting({ title: opts.before.title, body_md: opts.before.body }, fmt, surface).map((f) => f.rule)
      : []);
    const rejects = opts.human ? [] : findings.filter((f) => f.level === "reject" && !existed.has(f.rule));
    const step = opts.proposed ? NEXT_STEP[surface].proposed : NEXT_STEP[surface].saved;
    const state = opts.proposed ? "수정 제안으로 접수됐습니다" : "저장은 됐습니다";
    return {
      rejects,
      info: {
        style: {
          findings,
          note: `이 조직의 서술 형식에 어긋난 곳이 ${findings.length}건 있습니다(${state}). ${step} 의미는 바꾸지 말고 형식만 고치세요.`,
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
