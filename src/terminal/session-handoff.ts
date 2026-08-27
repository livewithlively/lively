// 실행 중 세션의 설정을 바꿀 때 다른 CLI 프로세스로 맥락을 넘기는 공통 프롬프트.
// 화면은 하네스별 원문을 공통 ChatLine으로 바꾼 뒤 최근 대화만 보낸다. 서버는 길이 상한과
// 경계를 다시 고정해 임의 클라이언트가 첫 지시 상한(20,000자)을 우회하지 못하게 한다.
import { normalizeSessionKind } from "../sessions/session-kind.js";
import type { SessionState } from "../sessions/session-state.js";
import type { CreateInput } from "./catalog.js";

export const HANDOFF_CONTEXT_MAX = 18_000;
export const HANDOFF_PROMPT_MAX = 20_000;

export function sessionHandoffPrompt(fromHarness: string, toHarness: string, flags: Record<string, unknown>, rawContext: unknown): string {
  const context = String(rawContext ?? "").trim().slice(-HANDOFF_CONTEXT_MAX);
  const changed = [fromHarness !== toHarness ? `${fromHarness} → ${toHarness}` : toHarness]
    .concat(Object.entries(flags).map(([k, v]) => `${k}=${String(v)}`)).join(", ");
  return [
    "이 세션은 사용자가 상단 실행 설정에서 AI를 전환해 이어진 세션입니다.",
    `전환 설정: ${changed}`,
    "아래 이전 대화를 이미 알고 있는 맥락으로 삼고, 같은 작업을 이어가세요. 전환 사실을 길게 설명하지 말고 사용자의 다음 입력을 바로 받을 준비를 하세요.",
    context ? `\n<previous_session_context>\n${context}\n</previous_session_context>` : "\n이전 대화 기록을 화면에서 읽지 못해 전달하지 못했습니다. 현재 작업 폴더와 프로젝트 맥락부터 확인하세요.",
  ].join("\n").slice(0, HANDOFF_PROMPT_MAX);
}

/** 새 프로세스가 원 세션의 작업 자리·프로젝트·권한을 잃지 않게 만드는 단일 복사 계약. */
export function sessionHandoffInput(
  st: SessionState, harness: string, flags: Record<string, unknown>, rawContext: unknown,
): CreateInput {
  return {
    // #2162 — 핸드오버는 **그 세션을 잇는 것**이라 원래 종류를 그대로 물려받는다.
    kind: normalizeSessionKind(st.kind),
    label: st.label || "", rootKey: st.root_key || "personal", subpath: st.subpath || "",
    harness, flags, autoApprove: st.auto_approve, invites: st.invites,
    projectId: st.project_id || undefined, projectSrc: st.project_src === "org" ? "org" : "v6",
    readOnly: st.read_only, incognito: st.incognito, writeVis: st.write_vis ?? undefined,
    restrictRead: !!st.restrict_read, appId: st.app_id || undefined,
    initialPrompt: sessionHandoffPrompt(st.harness, harness, flags, rawContext),
  };
}
