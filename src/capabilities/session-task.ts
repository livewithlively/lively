// 세션이 **자기 태스크**를 다루는 표면 — `session_task` (#4084).
//
//  세션 = 태스크(v6/session-task.ts): 프로젝트 안의 세션은 태스크 하나를 맡는다. 그 태스크의 관리(완료 처리·되열기)는
//  세션 안에서 자연스럽게 일어나야 하는데, 모델에게 태스크 번호를 기억하라고 하면 긴 세션·컨텍스트 압축에서 잃는다.
//  그래서 session_rename·session_set_project 와 **같은 규약**으로 id 없이 부른다 — 기본값 = 이 요청을 보낸 세션 자신
//  (게이트웨이가 접속 헤더 x-lively-session 으로 식별). 번호를 몰라도 «이 세션의 태스크»가 곧 대상이다.
//
//  맡은 태스크가 아직 없으면(이 기능 전에 이름을 지은 세션 · 다른 프로젝트로 옮겨진 세션) **이 세션 이름으로 만든다** —
//   이름짓기와 같은 규칙(ensureSessionTask)이라 두 입구가 같은 태스크를 낸다. 이름이 아직 없으면(세션 id 그대로) 만들지
//   않고 task:null 로 돌려준다 — 태스크 이름이 될 재료가 없다.
//
//  ⚠ session_rename 과 마찬가지로 실패를 만들지 않는다 — 소속 없음·태스크 없음은 에러가 아니라 task:null 이다.
//   막는 건 신원 문제뿐이다(세션을 특정 못 함 400).
import { z } from "zod";
import type { Capability, CapabilityCtx } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http/rest-util.js";
import { getSessionState } from "../sessions/session-state.js";
import { ensureSessionTask, sessionTaskOf, setSessionTaskStatus, type SessionTask } from "../v6/session-task.js";

const idOf = (u: LivelyUser): string => u.userId || u.email || "";

const sessionTaskInput = {
  status: z.enum(["in_progress", "done"]).optional().describe(
    "바꿀 상태. 생략하면 조회만 한다. done = 이 세션이 요청받은 일을 끝냈다(검증까지) · in_progress = 같은 세션에서 후속 작업을 시작했다"),
  reason: z.string().max(1000).optional().describe(
    "done 으로 닫을 때 무엇을 끝냈는지 한두 문장(예: 'MR !123 머지, CI 그린 확인'). ClickUp 에 미러된 태스크면 코멘트로 남는다. 생략하면 어느 세션이 끝냈다고 보고했는지만 남는다"),
  session_id: z.string().max(128).optional().describe("대상 세션 id — 보통 생략한다(기본 = 이 요청을 보낸 세션 자신). 남의 세션의 태스크는 다룰 수 없다"),
};
type SessionTaskInput = z.infer<z.ZodObject<typeof sessionTaskInput>>;

export interface SessionTaskResult {
  ok: true;
  /** 이 세션이 맡은 태스크. 프로젝트 밖 세션이거나 이름이 아직 없으면 null. */
  task: (SessionTask & { created?: boolean }) | null;
  /** task 가 null 인 이유(모델이 헛돌지 않게 한 줄로). */
  reason?: "no-project" | "no-name";
}

const sessionTask: Capability = {
  name: "session_task",
  title: "이 세션의 태스크",
  description:
    "이 세션이 맡은 태스크를 조회하거나 상태를 바꾼다 — 프로젝트 안의 세션은 태스크 하나를 맡는다(세션이 이름을 지을 때 서버가 " +
    "만들거나, 사람이 태스크에서 세션을 열면 그 태스크). session_id 생략 시 **이 요청을 보낸 세션 자신**이라 태스크 번호를 " +
    "몰라도 된다. 요청받은 일을 끝내면(검증까지) `{status:\"done\"}`, 같은 세션에서 후속 작업을 시작하면 `{status:\"in_progress\"}`. " +
    "done 으로 닫을 땐 reason 에 무엇을 끝냈는지 적는다(ClickUp 미러 태스크엔 코멘트로 남는다). " +
    "맡은 태스크가 없으면 이 세션 이름으로 만든다. REST 등가: POST /api/ui/terminal/sessions/:id/task {status?, reason?}.",
  scope: "memory",
  input: sessionTaskInput,
  mutates: true,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/terminal/sessions/:id/task"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return { session_id: String(req.params?.id ?? ""), status: b.status == null || b.status === "" ? undefined : String(b.status),
          reason: b.reason == null || b.reason === "" ? undefined : String(b.reason).slice(0, 1000) };
      } }],
  },
  handler: async (input: SessionTaskInput, user: LivelyUser, ctx?: CapabilityCtx): Promise<SessionTaskResult> => {
    const sid = (input.session_id ?? "").trim() || (ctx?.session ?? "").trim();
    if (!sid) throw new HttpError(400, "세션을 특정할 수 없습니다 — 라이블리 세션 안에서 호출하거나 session_id 를 넘기세요");
    const me = idOf(user);
    if (!me) throw new HttpError(403, "사용자 신원이 없습니다");

    let task: (SessionTask & { created?: boolean }) | null = await sessionTaskOf(sid, me);
    if (!task) {
      // 아직 없다 — 이름짓기와 같은 규칙으로 이 세션 이름을 태스크로. 이름이 세션 id 그대로면(아직 안 지었다) 재료가 없다.
      const st = await getSessionState(sid).catch(() => undefined);
      const label = String(st?.label ?? "").trim();
      if (!label || label === sid || st?.label_source === "id") return { ok: true, task: null, reason: "no-name" };
      task = await ensureSessionTask({ sessionId: sid, owner: me, name: label });
      if (!task) return { ok: true, task: null, reason: "no-project" };
    }
    if (input.status) {
      const after = await setSessionTaskStatus({ sessionId: sid, owner: me, status: input.status, reason: input.reason });
      if (after) task = { ...task, status: after.status };
    }
    return { ok: true, task };
  },
};

export const sessionTaskCapabilities: Capability[] = [sessionTask];
