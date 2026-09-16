// 리브 킥오프(#1631) — 처음 설정(온보딩)이 끝난 직후, **그 사람의 리브 세션**을 열고 1턴 지시를 넣는다.
//
//  ── 왜 이 길인가 ──
//  · 리브는 별도 채팅 UI 가 아니라 **보통 AI 세션**이다(2026-08-28 결정 — "웹채팅 인터페이스 포기해도 돼").
//    세션을 여는 일은 리브 세션 모듈(session.ts openLivSession)이 한다 — 리브 탭의 첫 말과 **같은 문**이고, 거기서
//    홈 입력창과 같은 생성 관문(launchSession)을 탄다. 첫 지시는 initialPrompt 로 넘겨 아웃박스가 입력창이 뜬 뒤 넣는다.
//  · 이 세션이 곧 **리브 탭의 세션**이다(#4032) — 화면은 리브 탭(#/liv)으로 가고, 리브 탭이 이 세션 대화창을 붙인다.
//    작업 폴더는 <개인 루트>/liv 라 리브 부팅 훅이 정체성·현황을 넣는다.
//  · 세션 종류는 **task** 다(원준 2026-09-15) — 첫 지시가 서버 조립물이라 이름 짓기·첫 지시 프로젝트 자동 생성·그에 딸린
//    승인 프롬프트(session_rename·project_rename_v6)가 LIVELY_SESSION_KIND 게이트에서 건너뛴다(#1979 항목4).
//  · 세션 이름(LIV_SESSION_LABEL)이 화면의 «첫 지시 숨김» 신호다 — web/session-chat.ts 가 같은 글자로 이 세션을 알아보고
//    서버가 넣은 지시를 사람 말풍선으로 그리지 않는다(liv-kickoff-chat-view 시험이 두 글자를 맞춘다).
//
//  ── 실패 규율 ──
//  · 실패는 던진다. 부르는 쪽(me_welcome_apply)이 잡아서 온보딩은 성공으로 끝내고 응답에 사유를 싣는다 —
//    리브가 못 떠도 처음 설정은 끝난 것이 맞다(사람이 답한 것은 이미 반영됐다).
import type { LivelyUser } from "../../context.js";
import { openLivSession } from "./session.js";

export const LIV_SESSION_LABEL = "리브 — 처음 설정 점검";
/** 킥오프 뒤 화면이 갈 곳 — 리브 탭이 이 세션 대화창을 붙인다(#4032). */
export const LIV_HREF = "#/liv";

export interface LivKickoffResult { session_id: string; href: string; harness: string; label: string }

export async function livKickoff(user: LivelyUser, o: { prompt: string; harness?: string | null }): Promise<LivKickoffResult> {
  if (!o.prompt?.trim()) throw new Error("첫 지시가 비어 있습니다");
  const made = await openLivSession(user, { prompt: o.prompt, label: LIV_SESSION_LABEL, harness: o.harness ?? null });
  return { session_id: made.session_id, href: LIV_HREF, harness: made.harness, label: made.label };
}
