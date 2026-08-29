// 리브 킥오프(#1631) — 처음 설정(온보딩)이 끝난 직후, **그 사람이 보는 실제 AI 세션 하나**를 열고 1턴 지시를 넣는다.
//
//  ── 왜 이 길인가 ──
//  · 리브는 별도 채팅 UI 가 아니라 **보통 AI 세션**이다(2026-08-28 결정 — "웹채팅 인터페이스 포기해도 돼"). 그래서 홈 입력창이
//    첫 지시로 세션을 여는 길(#1719 quick-session → createSession + initialPrompt)을 서버에서 그대로 밟는다.
//    createSession 이 initialPrompt 를 받으면 아웃박스(입력창이 뜨면 배달·에코 확인 #1753) / codex app-server / 노드 배달까지
//    알아서 가른다 — 여기서 send-keys 를 직접 치지 않는다.
//  · 하네스는 **그 사람이 로그인한 것**(resolveHeadlessHarness — claude 하드코딩 금지, #1884). 비용 주체 = 사용자.
//  · 세션 종류는 human — 사람이 열어 보고 이어서 말을 걸 수 있는 자기 세션이다(kind=task/managed 는 기계 세션).
//  · 워크스페이스 바인딩은 라우트 층과 같은 함수(recordSessionTenant) — registry 모드에서 이 세션이 어느 워크스페이스
//    소속인지는 여기서 정해진다. 이걸 빼면 세션이 primary 로 취급된다.
//
//  ── 실패 규율 ──
//  · 실패는 던진다. 부르는 쪽(me_welcome_apply)이 잡아서 온보딩은 성공으로 끝내고 응답에 사유를 싣는다 —
//    리브가 못 떠도 처음 설정은 끝난 것이 맞다(사람이 답한 것은 이미 반영됐다).
import type { LivelyUser } from "../../context.js";

export const LIV_SESSION_LABEL = "리브 — 처음 설정 점검";

export interface LivKickoffResult { session_id: string; href: string; harness: string; label: string }

export async function livKickoff(user: LivelyUser, o: { prompt: string; harness?: string | null }): Promise<LivKickoffResult> {
  const userId = user?.userId;
  if (!userId) throw new Error("인증된 사용자가 아닙니다");
  if (!o.prompt?.trim()) throw new Error("첫 지시가 비어 있습니다");
  // 동적 import — terminal/sessions 는 무거운 모듈(tmux·pty)이고 org/* 에서 정적으로 걸면 순환(check-imports) 위험.
  const { resolveHeadlessHarness } = await import("../../node/headless-harness.js");
  const { createSession } = await import("../../terminal/sessions.js");
  const { registerSessionInstance, recordSessionTenant } = await import("../../terminal/routes.js");

  const harness = await resolveHeadlessHarness(userId, o.harness ?? null);
  const session = await createSession(user, {
    kind: "human",
    label: LIV_SESSION_LABEL,
    rootKey: "personal", subpath: "",
    harness, flags: {}, autoApprove: false,
    initialPrompt: o.prompt,
  });
  await registerSessionInstance(session.id, userId, { title: session.label });
  await recordSessionTenant(session.id);
  return { session_id: session.id, href: `#/s/${encodeURIComponent(session.id)}`, harness, label: session.label };
}
