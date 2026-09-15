// 리브 킥오프(#1631) — 처음 설정(온보딩)이 끝난 직후, **그 사람이 보는 실제 AI 세션 하나**를 열고 1턴 지시를 넣는다.
//
//  ── 왜 이 길인가 ──
//  · 리브는 별도 채팅 UI 가 아니라 **보통 AI 세션**이다(2026-08-28 결정 — "웹채팅 인터페이스 포기해도 돼"). 그래서 홈 입력창이
//    첫 지시로 세션을 여는 길(#1719 quick-session → createSession + initialPrompt)을 서버에서 그대로 밟는다.
//    createSession 이 initialPrompt 를 받으면 아웃박스(입력창이 뜨면 배달·에코 확인 #1753) / codex app-server / 노드 배달까지
//    알아서 가른다 — 여기서 send-keys 를 직접 치지 않는다.
//  · 하네스는 **그 사람이 로그인한 것**(resolveHeadlessHarness — claude 하드코딩 금지, #1884). 비용 주체 = 사용자.
//  · 세션 종류는 **task** 다(원준 2026-09-15) — 사람이 열어 보고 이어 말을 거는 세션이지만, 첫 지시가 서버 조립물이라 이름 짓기·첫 지시
//    프로젝트 자동 생성·그에 딸린 승인 프롬프트(session_rename·project_rename_v6)가 LIVELY_SESSION_KIND 게이트에서 건너뛴다(#1979 항목4).
//    그래도 spawnTaskSession 이 아니라 createSession 이라 세션 호스트로 떠 매니지드에서도 뜬다 — 자세한 근거는 아래 createSession 자리 주석.
//  · 워크스페이스 바인딩은 세션 생성 관문(session-launch.ts)과 같은 함수(recordSessionTenant) — registry 모드에서 이 세션이 어느 워크스페이스
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
  const { registerSessionInstance, recordSessionTenant } = await import("../../terminal/session-launch.js");   // #3626 — 세션 생성 관문 모듈로 이사

  const harness = await resolveHeadlessHarness(userId, o.harness ?? null);
  const session = await createSession(user, {
    //  (#1631, 원준 2026-09-14) 킥오프 세션은 **task 종류**다 — 사람이 아닌 종류라 이름 짓기·첫 지시 프로젝트 자동 생성·그에 딸린
    //  승인 프롬프트(session_rename·project_rename_v6)가 LIVELY_SESSION_KIND 게이트에서 구조적으로 건너뛴다(#1979 항목4). 그래도
    //  spawnTaskSession(게이트웨이 로컬 워커)이 아니라 createSession 이라 세션 호스트로 뜬다 — 매니지드에서도 app·login 세션과 같은
    //  프로비저닝을 타므로 헤드리스 위탁 경로의 «게이트웨이가 /work/shared 를 못 만진다» 500 을 안 겪는다.
    kind: "task",
    label: LIV_SESSION_LABEL,
    rootKey: "personal", subpath: "",
    harness, flags: {}, autoApprove: false,
    initialPrompt: o.prompt,
  });
  await registerSessionInstance(session.id, userId, { title: session.label });
  await recordSessionTenant(session.id);
  return { session_id: session.id, href: `#/s/${encodeURIComponent(session.id)}`, harness, label: session.label };
}
