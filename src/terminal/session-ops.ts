// 세션 op — **세션 호스트가 실행하는 타입드 명령의 한 벌** (#2600 T1).
//
// ── 무엇인가 ────────────────────────────────────────────────────────────────
// 게이트웨이가 정책(소유·초대·가시성)을 **다 끝낸 뒤** 세션 호스트에 시키는 기계적 실행이다.
//  임의 셸이 아니라 닫힌 목록이고(`SESSION_OPS`), 그 목록과 구현이 여기 한 곳에 있다.
//
// ── 왜 갈랐나 ───────────────────────────────────────────────────────────────
//  종전엔 이 표가 `node/agent.ts` 의 `runOp` 안에 노드 전용 op(파일·위탁 태스크·앱 워커·provision)와
//  **섞여** 있었다. 그래서 «세션 op» 이 어디까지인지 목록으로 말할 수 없었고, 세션을 소유하는 다른
//  프로세스(#2600 T2 의 매니지드 세션 호스트)가 그 표를 쓰려면 노드 전용 짐까지 함께 들어야 했다.
//  여기로 옮기면 노드 에이전트는 **전송 어댑터**가 되고(받아서 이 표로 넘긴다), 다음 호스트는 같은
//  표를 그대로 부른다.
//
// ── 인가는 여기 없다(F7) ────────────────────────────────────────────────────
//  `user` 는 게이트웨이가 넘긴 신원 그대로 tmux 메타(`@box_owner`)·소유자 확인에 쓰인다.
//  **이 표는 판정하지 않는다** — 판정하는 자리를 둘로 만들면 두 답이 나온다.
//
// ⚠ 이 층은 세션 표면(DB·초대 검증)을 끌어오므로 **attach 워커는 이 파일을 import 하지 않는다.**
//  워커의 존재 이유가 «이벤트루프에 attach 말고 아무 일도 없게» 이고(#2228), 그 규율이 곧 import
//  최소 규율이다. attach 만 공유하는 층은 `session-host.ts` 다 — 그래서 층이 둘이다.
import {
  listSessionsRaw, createSession, killSession, editSession, applyValidatedInvites,
  sessionGone, getSessionLabel, markSessionActive, markSessionSeen, isReportedPhase,
  type CreateInput,
} from "./terminal-sessions.js";
import { sendKeysToSession } from "./send-keys.js";
import { injectFirstPrompt } from "./session-first-prompt.js";
import { applySessionProject } from "./session-project.js";
import type { LivelyUser } from "../context.js";

/**
 * 세션 호스트가 실행하는 op 의 **닫힌 목록**. 노드 프로토콜의 `NODE_OPS` 는 이 집합에 노드 전용
 *  op(파일·위탁 태스크·앱 워커·provision·대화)를 더한 것이다 — 그 관계를 `session-ops.test.ts` 가 지킨다.
 */
export const SESSION_OPS = [
  "list", "create", "createAppSession", "kill", "edit", "gone", "label",
  "sendKeys", "setProject", "injectFirstPrompt", "markActive", "markSeen",
] as const;

export type SessionOp = (typeof SESSION_OPS)[number];

const SESSION_OP_SET: ReadonlySet<string> = new Set(SESSION_OPS);

/** 이 op 를 세션 호스트가 실행하나 — 어댑터의 디스패치가 이걸로 갈린다. */
export function isSessionOp(op: string): op is SessionOp {
  return SESSION_OP_SET.has(op);
}

/**
 * 세션 op 하나를 실행한다. 인자 형태는 노드 프로토콜(`node/protocol.ts` 의 `ReqMsg.args`)과 같다 —
 *  게이트웨이가 만든 그 봉투를 어댑터가 **그대로** 넘긴다(형태를 어댑터마다 다시 빚으면 또 두 벌이다).
 */
export async function runSessionOp(op: SessionOp, args: Record<string, unknown>): Promise<unknown> {
  const user = (args.user ?? {}) as LivelyUser;
  switch (op) {
    case "list": return listSessionsRaw();

    // #1221 — 게이트웨이가 릴레이한 하네스 보고(활동 시각 + 실행단계)를 이 호스트의 tmux 에 새긴다.
    //  모르는 state 는 무시하고 활동 시각만 갱신.
    case "markActive": {
      const st = args.state;
      // #1842 — 전이(prev→phase)를 게이트웨이에 **돌려준다**. 이 호스트의 tmux 는 게이트웨이가 직접 볼 수
      //  없으므로, 이 응답이 없으면 다른 곳에서 도는 세션만 실시간 알림에서 빠져 30초 폴링에 묶인다.
      //  구 게이트웨이는 이 필드를 모르고 무시한다(무회귀).
      const change = await markSessionActive(String(args.id), isReportedPhase(st) ? st : undefined);
      return { ok: true, change: change ?? null };
    }

    // #1954 3차 — 게이트웨이가 릴레이한 '이 화면을 보고 있다' 도장. markActive 와 같은 구조·같은 전제.
    case "markSeen": {
      await markSessionSeen(String(args.id));
      return { ok: true };
    }

    // #1664 — 세션 PTY 에 프롬프트를 넣는다(크론 주입·리브). mux 표면 분기(tmux `-l` vs psmux 코드포인트)와
    //  flush 지연 규약은 terminal/send-keys 안에 갇혀 있어 게이트웨이 로컬 주입과 **같은 코드**로 돈다.
    case "sendKeys": {
      await sendKeysToSession(String(args.id), String(args.text ?? ""));
      return { ok: true };
    }

    // 세션 프로젝트 소속(붙이기·떼기). 게이트웨이가 소유권·공개범위를 검증하고 DB desired 를 먼저 기록한다.
    //  호스트는 tmux 실행 캐시만 갱신하며 cwd 나 프로젝트 표현 파일을 만들지 않는다.
    case "setProject": {
      const b = args.bind as { projectId: number; folder: string; name?: string | null; src?: "v6" | "org" } | null | undefined;
      return applySessionProject(user, String(args.id), b && Number(b.projectId) > 0 ? b : null);
    }

    case "injectFirstPrompt": {
      const id = String(args.id);
      const harness = String(args.harness || "claude");
      const prompt = String(args.text || "");
      // 신뢰 대화상자 자동 수락 여부는 **게이트웨이가 판정해 실어 보낸다**(#1867 autoTrustWorkspace) —
      //  세션 호스트엔 프로젝트 폴더 규약이 없다.
      if (prompt.trim()) void injectFirstPrompt(id, harness, prompt, { trustOk: args.trustOk === true })
        .catch((e) => console.warn(`[session-host] 첫 지시 주입 실패(${id}):`, (e as Error)?.message ?? e));
      return { ok: true };
    }

    case "create":
    case "createAppSession": {
      const session = await createSession(user, args.input as CreateInput);
      // 초대는 게이트웨이가 구성원 디렉터리로 검증해 넘긴다 — 세션 호스트엔 DB 가 없어
      //  createSession 내부 검증이 빈 배열이 된다.
      const invites = Array.isArray(args.invites) ? (args.invites as string[]) : [];
      if (invites.length) { await applyValidatedInvites(user, session.id, invites); session.invites = invites; }
      return session;
    }

    case "kill": await killSession(user, String(args.id)); return { ok: true };

    case "edit": {
      const patch = (args.patch ?? {}) as { label?: string };
      if (patch.label !== undefined) await editSession(user, String(args.id), { label: patch.label });
      if (args.invites !== undefined) await applyValidatedInvites(user, String(args.id), args.invites);
      return { ok: true };
    }

    case "gone": return sessionGone(String(args.id));
    case "label": return getSessionLabel(String(args.id));

    // ⚠ 소진 검사 — 종전엔 이 switch 가 `node/agent.ts` 안에 있었고 끝에 `default: throw unknown op` 가
    //  있어서 «모르는 op» 가 시끄러웠다. 표를 여기로 옮기며 그 자리를 잃으면, **목록(`SESSION_OPS`)과
    //  이 case 들이 어긋났을 때 선언된 op 가 조용히 `undefined` 를 돌려준다**(게이트웨이는 성공으로 읽는다).
    //  `never` 대입이 그 어긋남을 **컴파일 오류**로 만든다 — 두 목록이 «알아서 맞겠지» 에 기대지 않는다.
    default: {
      const unreachable: never = op;
      throw new Error(`세션 op 표에 구현이 없습니다: ${String(unreachable)}`);
    }
  }
}
