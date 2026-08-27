// 처음 설정(#/welcome) 을 이 사람에게 보여줄까 — **서버 판정**(#2039 · #2067 · #2171).
//
//  왜 서버가 정하나. 종전엔 **화면이 localStorage 하나로** 정했다(web/v2/onboarding.ts 의 `lively_ob_done`,
//   main.ts 부팅부 `if (!boot && !onboardingDone()) boot='#/welcome'`). 그 열쇠는 브라우저마다 따로 살아서
//   **몇 달째 쓰던 사람도 새 브라우저·다른 기기·시크릿창·저장소 청소 뒤엔 홈 대신 처음 설정이 떴다**
//   (원준님 신고 2026-08-26, dev.lvly.io:8080 로그인 직후). 기대한 화면이 아닌 게 뜨는 것은 그 자체로
//   고장이다 — 리브가 홈을 덮던 설계를 걷어낸 대표 결정과 같은 이유(capabilities/delivery/liv.ts 머리말).
//
//  판정 규칙: **이 워크스페이스에서 아직 아무것도 안 한 사람에게, 아직 한 번도 안 보냈을 때만** 보여준다.
//   - 끝냈다는 표식이 서버에 있으면(liv_profile.onboarded_at) 끝. 브라우저를 바꿔도 다시 안 뜬다.
//   - ★ 자동으로 **보낸 적이 있으면**(liv_profile.welcome_shown_at) 다시 안 보낸다 — 아래 참조.
//   - **하다 만 자리가 남아 있으면**(#2207 — liv_profile.welcome_progress) 아직 안 보여준 경우에 한해 보낸다.
//   - AI 가 이 신원으로 MCP 를 한 번이라도 성공 호출했으면 이미 쓰던 사람이다(설치·인증·연결이 다 됐다는 뜻).
//   - 터미널 세션이 하나라도 있었으면(session 레지스트리는 불멸이라 '있었다'를 증언) 이미 쓰던 사람이다.
//
//  ★ **자동 진입은 평생 한 번**(#2171). 종전엔 «끝냄»(onboarded_at)만이 유일한 탈출구였는데, 그 표식은
//   온보딩 맨 끝 [준비 끝, 정리해 주세요] 한 자리에서만 찍혔다. 그래서 중간에 나간 사람·웹만 쓰는 사람은
//   MCP 호출도 터미널 세션도 영영 0건이라 **앱을 열 때마다 처음 설정으로 끌려갔다**(원준님 신고 2026-08-27
//   "시도때도없이 떠서 돌아버리겠어"). 보여준 사실 자체를 서버에 남겨 그 고리를 끊는다.
//
//  ★ 왜 «하다 만 자리»가 흔적보다 세나(#2207). 온보딩 자체가 흔적을 만든다 — 「내 컴퓨터에 잇기」 장면은
//   데스크톱 앱을 깔게 하고, 그 앱이 붙는 순간 mcp_call_log 에 성공 호출이 남는다. 즉 «흔적 없음»만으로는
//   하다 만 사람을 못 알아본다. 그래서 진행 중이면 흔적을 이긴다 — 단, **아직 자동으로 안 보냈을 때만**이다.
//
//  ⚠ #2207 과 #2171 이 만나는 자리 — 둘의 의도를 다 지키는 답은 «끌고 가기»가 아니라 «길을 남기기»다.
//   #2207 이 막으려던 것은 *하던 설정으로 돌아갈 길이 사라지는 것*이지 *강제로 끌려가는 것*이 아니다.
//   그래서 자동 진입은 한 번으로 두되, 하다 만 사람에게는 홈의 «처음 설정 이어서 하기»(welcomePending)가
//   끝낼 때까지 남는다 — 진행 상태(welcome_progress)는 그대로 있으니 눌렀을 때 그 자리에서 이어진다.
//
//  ⚠ **모르면 홈이다.** 조회가 실패하면 '흔적 있음'으로 접는다 — 여기서 fail-open 하면 장애 때 전원이
//   처음 설정으로 튄다(고장을 고장으로 덮는 것). 처음 설정은 못 봐도 되지만 홈은 늘 홈이어야 한다.
import { itemsPool } from "../../db/client.js";
import { getLivProfile } from "../store.js";

/** 판정에 필요한 사실 — DB 를 안 타는 순수 입력(표로 테스트한다). */
export interface FirstRunFacts {
  /** 처음 설정을 끝냈다고 서버에 남은 시각(liv_profile.onboarded_at). 있으면 끝. */
  onboardedAt: string | null;
  /** 처음 설정으로 **자동으로 보낸** 시각(liv_profile.welcome_shown_at). 있으면 다시 자동으로 안 보낸다. */
  shownAt: string | null;
  /** 처음 설정을 **하다 만 자리**가 서버에 남아 있나(#2207 — liv_profile.welcome_progress). */
  welcomeInProgress: boolean;
  /** 이 신원으로 MCP 툴이 성공 호출된 적 있나. */
  everCalledMcp: boolean;
  /** 이 사람 소유의 터미널 세션이 하나라도 있었나. */
  everHadSession: boolean;
}

/** 사실 → **자동 진입** 판정. **순수 함수**(DB·시각 무접촉). */
export function isFirstRun(f: FirstRunFacts): boolean {
  if (f.onboardedAt) return false;        // 끝냈다
  if (f.shownAt) return false;            // 이미 한 번 보냈다 — 두 번은 끌고 가지 않는다(#2171)
  if (f.welcomeInProgress) return true;   // 하다 만 자리가 있다 = 아직 하는 중(#2207)
  return !f.everCalledMcp && !f.everHadSession;
}

/**
 * 사실 → **홈에 «이어서 하기» 를 띄울까**(#2171).
 *
 * 자동 진입을 한 번으로 줄인 것의 짝이다 — 끌고 가지 않는 대신 **길은 남긴다.** 대상은 둘:
 *  보여는 줬는데 안 끝낸 사람(shownAt), 그리고 하다 만 자리가 남은 사람(#2207 welcomeInProgress).
 */
export function isWelcomePending(f: FirstRunFacts): boolean {
  if (f.onboardedAt) return false;
  return !!f.shownAt || !!f.welcomeInProgress;   // ⚠ 둘 다 접는다 — 이 축을 안 주는 옛 호출부에선 undefined 가 샌다
}

async function used(sql: string, params: unknown[]): Promise<boolean> {
  try { const r = await itemsPool.query(sql, params); return (r.rowCount ?? 0) > 0; }
  catch { return true; } // 모르면 '이미 쓰던 사람' — 위 ⚠ 참조(장애 때 홈이 사라지지 않게)
}

/** 지금 이 사람의 처음 설정 상태. 실패는 전부 '보여주지 않음'으로 접는다. */
export async function memberWelcomeState(memberId: string): Promise<{ firstRun: boolean; pending: boolean }> {
  if (!memberId) return { firstRun: false, pending: false };
  const [profile, everCalledMcp, everHadSession] = await Promise.all([
    getLivProfile(memberId).catch(() => ({} as { onboarded_at?: string | null; welcome_shown_at?: string | null; welcome_progress?: unknown })),
    used("SELECT 1 FROM mcp_call_log WHERE actor=$1 AND ok LIMIT 1", [memberId]),
    used("SELECT 1 FROM session WHERE owner=$1 LIMIT 1", [memberId]),
  ]);
  const facts: FirstRunFacts = {
    onboardedAt: profile?.onboarded_at ?? null,
    shownAt: profile?.welcome_shown_at ?? null,
    welcomeInProgress: !!profile?.welcome_progress,
    everCalledMcp, everHadSession,
  };
  return { firstRun: isFirstRun(facts), pending: isWelcomePending(facts) };
}

/** 지금 이 사람에게 처음 설정을 보여줄까. 실패는 전부 '아니오'로 접는다. */
export async function memberFirstRun(memberId: string): Promise<boolean> {
  return (await memberWelcomeState(memberId)).firstRun;
}
