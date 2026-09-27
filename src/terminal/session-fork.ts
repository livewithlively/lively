// 세션 복제(#4135, 원준 2026-09-27) — **이 세션의 대화를 아는 새 세션**을 하나 더 만든다. 이 파일은 **순수**다.
//
// ── 무엇인가 ────────────────────────────────────────────────────────────────
//  원래 세션은 그대로 두고, 같은 작업 자리(폴더·프로젝트·AI·모델·권한)에 새 세션을 띄우되 하네스의 복제 수단으로 연다
//  (claude `--resume <id> --fork-session` · codex `fork <id>` — catalog.ts Harness.forkArgv). 새 세션은 복제한 순간까지의
//  대화를 알고, 그 뒤로 두 세션은 서로 영향을 주지 않는다(대화 파일이 따로다).
//
// ── 이어받기(복원)·전환(handoff)과 무엇이 다른가 ─────────────────────────────
//  · 복원  = 죽은 세션을 **같은 대화로** 다시 연다. 대화 하나에 세션 하나다(#3891 이 지키는 불변식).
//  · 전환  = 다른 AI 로 옮긴다. 하네스가 달라 대화 파일을 못 읽으니 화면이 추린 **요약 글**을 첫 지시로 넣는다.
//  · 복제  = 같은 AI 로, 하네스가 대화를 **통째로 복사한 새 대화**를 연다. 요약이 아니라 원문이고, 원래 세션은 살아 있다.
//
// ── 거절하는 경우(라우트가 이 판정을 그대로 사람 말로 돌려준다) ─────────────────
//  모르는 채로 띄우면 «복제했다» 는 답과 함께 **아무것도 모르는 세션**이 뜬다. 그래서 확인된 것만 띄운다.
import { normalizeSessionKind } from "../sessions/session-kind.js";
import type { SessionState } from "../sessions/session-state.js";
import { HARNESSES, RESUME_ID_RE, type CreateInput } from "./catalog.js";
import type { ResumeCheck } from "./resume-plan.js";

/** 복제본 이름의 꼬리 — 「이름 (복제)」 · 복제본을 또 복제하면 「이름 (복제 2)」. */
const FORK_TAIL_RE = /\s*\(복제(?:\s+(\d+))?\)\s*$/;
export const FORK_LABEL_MAX = 80;

/**
 * 복제본의 이름. 원래 이름이 없으면(아직 id 가 이름인 세션) 빈 문자열 — 새 세션도 이름 없는 세션으로 시작한다.
 *  ⚠ 길이는 **꼬리를 지키는 쪽**으로 자른다: 앞을 줄이고 「(복제)」 는 남긴다(꼬리가 잘리면 목록에서 둘이 같은 이름이 된다).
 */
export function forkLabel(label: string | null | undefined, id: string): string {
  const raw = String(label ?? "").trim();
  if (!raw || raw === id) return "";
  const m = FORK_TAIL_RE.exec(raw);
  const base = (m ? raw.slice(0, m.index) : raw).trim();
  const n = m ? (Number(m[1]) || 1) + 1 : 1;
  const tail = n === 1 ? " (복제)" : ` (복제 ${n})`;
  const room = Math.max(1, FORK_LABEL_MAX - tail.length);
  return (base.length > room ? base.slice(0, room).trimEnd() : base) + tail;
}

/** 이 하네스가 복제 수단을 갖고 있나(catalog 가 실증한 것만). */
export function forkSupported(harness: string | null | undefined): boolean {
  const h = HARNESSES.find((x) => x.key === String(harness || "claude"));
  return typeof h?.forkArgv === "function";
}

export interface ForkFacts {
  /** 원래 세션의 실행 설정(desired-state 행). 없으면 복제할 좌표를 모른다. */
  st: SessionState | null | undefined;
  /** 요청한 사람. */
  me: string;
  /** 원래 세션이 돌고 있는 하네스 대화 id(훅이 보고한 값). */
  convId: string | null | undefined;
  /** 그 대화 파일이 실제로 있나 — 확인할 수 있는 자리에서만 present/absent, 아니면 unknown. */
  check: ResumeCheck;
  /** 세션이 다른 컴퓨터(노드)에 있으면 그 노드 id, 아니면 ''. */
  nodeId: string;
  /** 그 노드가 지금 연결돼 있나(nodeId 가 있을 때만 본다). */
  nodeOnline: boolean;
  /** 그 노드가 `forkSession` op 를 선언했나(nodeId 가 있을 때만 본다). */
  nodeCanFork: boolean;
}

export interface ForkRefusal { status: number; message: string }

/**
 * 복제를 거절해야 하면 그 이유, 아니면 null.
 *  순서가 곧 사람이 받는 안내의 우선순위다 — 고칠 수 없는 것(내 세션이 아님)부터, 기다리면 풀리는 것(노드 갱신)은 뒤에.
 */
export function forkRefusal(f: ForkFacts): ForkRefusal | null {
  const st = f.st;
  if (!st) return { status: 409, message: "이 세션의 실행 설정을 찾지 못해 복제할 수 없습니다 — 새 세션으로 열어 주세요." };
  //  대화 파일은 **만든 사람의 자리**(그 사람의 하네스 설정 폴더)에 있다. 다른 사람 이름으로 띄운 하네스는 그 파일을 못 읽는다.
  if (st.owner !== f.me) return { status: 403, message: "본인이 만든 세션만 복제할 수 있습니다 — 대화 기록이 만든 사람의 자리에 있습니다." };
  if (st.app_id) return { status: 409, message: "앱으로 연 세션은 아직 복제할 수 없습니다." };
  const harness = HARNESSES.find((h) => h.key === String(st.harness || "claude"));
  if (!harness || typeof harness.forkArgv !== "function") {
    return { status: 409, message: `${harness?.label || st.harness || "이 AI"} 세션은 아직 복제할 수 없습니다 — 지금은 Claude Code 와 Codex 세션만 됩니다.` };
  }
  const conv = String(f.convId ?? "").trim();
  if (!conv || !RESUME_ID_RE.test(conv)) {
    return { status: 409, message: "이 세션에는 아직 복제할 대화가 없습니다 — 한 번이라도 말을 주고받은 뒤에 복제할 수 있어요." };
  }
  if (f.check === "absent") return { status: 409, message: "복제할 대화 기록을 찾지 못했습니다 — 세션이 있던 컴퓨터에 그 기록이 남아 있지 않습니다." };
  if (f.nodeId) {
    if (!f.nodeOnline) return { status: 409, message: "그 세션이 있는 컴퓨터가 지금 연결돼 있지 않아 복제할 수 없습니다 — 컴퓨터가 켜지면 다시 시도하세요." };
    //  op 를 선언하지 않은 노드에 create 로 보내면 fork 를 모르는 번들이 **빈 새 대화**를 연다(node/protocol.ts 머리말).
    if (!f.nodeCanFork) return { status: 409, message: "그 컴퓨터의 라이블리 프로그램이 아직 세션 복제를 모릅니다 — 프로그램은 스스로 갱신되니 잠시 뒤 다시 시도하세요." };
  }
  return null;
}

/**
 * 복제본이 원래 세션의 태스크를 물려받나 — 같은 프로젝트의 **진행 중** 태스크일 때만.
 *  끝난(또는 아직 시작 안 한) 태스크는 물려주지 않는다: 세션에 태스크를 잇는 순간 상태가 「진행 중」 으로 바뀌므로,
 *  복제했다는 이유만으로 끝난 일이 다시 열리면 안 된다.
 */
export function forkInheritsTask(task: { id: number; status: string; project_id: number } | null | undefined, projectId: number | null | undefined): boolean {
  return !!task && Number(task.id) > 0 && Number(task.project_id) === Number(projectId) && String(task.status) === "in_progress";
}

/**
 * 복제본의 생성 입력 — 원래 세션의 작업 자리·프로젝트·AI·모델·권한을 그대로 물려받고 `fork` 만 얹는다.
 *  ⚠ 첫 지시(initialPrompt)는 없다: 복제본은 원래 대화를 이미 알고, 사람의 다음 말을 기다리는 상태로 뜬다.
 *  ⚠ carryConv 도 없다(CreateInput.fork 머리말 — 복제본은 원래 대화를 «도는» 세션이 아니다).
 */
export function sessionForkInput(st: SessionState, convId: string): CreateInput {
  return {
    kind: normalizeSessionKind(st.kind),
    label: forkLabel(st.label, st.id), rootKey: st.root_key || "personal", subpath: st.subpath || "",
    harness: st.harness || "claude", flags: st.flags || {}, autoApprove: st.auto_approve, invites: st.invites,
    projectId: st.project_id || undefined, projectSrc: st.project_src === "org" ? "org" : "v6",
    readOnly: st.read_only, incognito: st.incognito, writeVis: st.write_vis ?? undefined,
    restrictRead: !!st.restrict_read,
    fork: convId,
  };
}
