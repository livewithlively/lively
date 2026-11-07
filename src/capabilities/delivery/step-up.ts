// delivery ▸ step-up — 「관리 권한을 이 기기로 내보낼 때 사람을 한 번 더 확인한다」의 판정 한 곳 (#3970)
//
// 왜 한 곳인가: 이 판정은 **화면과 서버가 같은 답을 내야** 한다. 어긋나면 사람은 채울 수 없는 칸을 보거나
//  (#2044 가 고친 바로 그 문제), 반대로 물어야 할 것을 안 묻는다. 그래서 «무엇으로 확인하나» 를 여기서만
//  정하고, 승인 창구(tokens-devices 의 device_approve)와 승인 화면(web/activate.ts)이 같은 값을 읽는다.
//
// ── 수단 셋 ──────────────────────────────────────────────────────────────────
//   cp    — 라이블리 계정(app.lvly.io) 비밀번호. **매니지드에서 사람이 실제로 아는 비밀번호는 이것뿐이다.**
//   local — 이 게이트웨이의 로컬 비밀번호(member_credential). 셀프호스트와 플랫폼 운영 계정이 쓴다.
//   none  — 물을 것이 없다(소셜 로그인·SSO). 세션 자체가 신선도 증거다(device-auth 설계 R2-F3).
//
// ⚠ 매니지드에서 local 을 먼저 보면 안 된다(#3970 의 사고가 정확히 그것이었다). 프로비저닝이 멤버를 만들 때
//  코어가 초기 비번을 자동 발급했고(delivery/members.ts), CP 는 그 값을 쓰지 않고 버렸다 — 그래서 매니지드
//  사용자는 전원 «아무도 모르는 로컬 비번» 을 갖게 됐다. 화면은 그걸 보고 칸을 띄우고 서버도 그걸로 검증하니,
//  라이블리 비밀번호를 정확히 넣어도 403 이었다. 즉 **통과할 수 없는 관문**이었고, 사람이 빠져나가는 유일한 길은
//  체크를 풀어 관리 권한 없는 토큰을 받는 것(조용한 권한 손실)이었다.
//  → 지금은 ① 그 자국을 만들지 않고(members.ts) ② 남은 자국을 지우고(schema/member-auth.ts)
//    ③ CP 계정으로 들어오는 사람에겐 **CP 에 물어본다**(이 파일).
//
// ⚠ 실패는 닫는 쪽이다. CP 를 못 부르면 «물을 것이 없다» 가 아니라 오류다 — 네트워크 사고로 관문이 열리면
//  그 관문은 없는 것과 같다. 화면 조회만 관대하게(칸을 보여주고) 처리하고, 검증은 반드시 fail-closed 다.
import type { LivelyUser } from "../../context.js";
import { hasCredential, verifyOwnPassword } from "../../auth/local-accounts.js";
import { callCp, resolveCpTarget, type CpTarget } from "./managed-cp.js";

/** CP 창구 — 조회(비번 없이)와 검증(비번과 함께)이 같은 경로다. lvly-cloud/control/src/tenant-account-routes.ts */
const CP_PASSWORD_CHECK = "/api/tenant/account-password-check";

export type StepUpMethod = "cp" | "local" | "none";

export interface CpPasswordCheck { has_password?: boolean; ok?: boolean }

/**
 * 이 사람을 CP 로 물어볼 수 있나 — 매니지드이고, 그 사람이 CP 계정으로 들어오는 경우에만 대상이 잡힌다.
 * 셀프호스트·CP 미연결·CP 계정 없는 멤버(플랫폼 운영 계정 등)는 null 이라 로컬 축으로 떨어진다.
 */
async function cpTargetFor(user: LivelyUser): Promise<CpTarget | null> {
  return resolveCpTarget(user, { optional: true });
}

/**
 * ★ 판정 그 자체 — 조회 결과만 받는다(DB·네트워크를 모른다). 화면과 서버가 **같은 답**을 내는 지점이라
 *  여기만 순수 함수로 떼어 둔다(우선순위가 어긋나는 종류의 사고를 테스트가 직접 잡을 수 있게).
 *
 *  cp=null 은 «라이블리 계정으로 들어오는 사람이 아니다» 이지 «CP 를 못 불렀다» 가 아니다 —
 *  후자는 부르는 쪽에서 예외로 끝난다(fail-closed).
 */
export function decideStepUp(cp: CpPasswordCheck | null, hasLocal: boolean): StepUpMethod {
  // 라이블리 계정으로 들어오는 사람 — **로컬 비번이 남아 있어도 그건 그 사람이 모르는 값이다.**
  //  비밀번호가 없는 계정(구글 로그인만)이면 물을 것이 없다. 비번을 유일 게이트로 두면 그 사람은
  //  영영 관리 권한을 못 얻는다(device-auth R2-F3 과 같은 판단).
  if (cp) return cp.has_password === true ? "cp" : "none";
  return hasLocal ? "local" : "none";
}

/**
 * 무엇으로 확인할 것인가 — 화면이 «어느 비밀번호를 달라고 적을지» 를 정하는 값.
 * ⚠ CP 가 안 잡히면 던진다(호출부가 화면 사정에 맞게 처리한다 — 승인 창구는 verifyStepUp 이 따로 막는다).
 */
export async function stepUpMethodFor(user: LivelyUser): Promise<StepUpMethod> {
  const t = await cpTargetFor(user);
  if (t) return decideStepUp(await callCp<CpPasswordCheck>(t, CP_PASSWORD_CHECK, {}), false);
  return decideStepUp(null, await hasCredential(user.userId));
}

/**
 * 재확인 검증 — 통과하면 true. **물을 것이 없는 사람도 true** 다(관문이 없는 것이 정상인 경우).
 * ⚠ fail-closed: CP 를 못 부르면 callCp 가 던지고, 승인은 그 오류로 막힌다.
 */
export async function verifyStepUp(user: LivelyUser, password: string): Promise<boolean> {
  const t = await cpTargetFor(user);
  if (t) {
    const r = await callCp<CpPasswordCheck>(t, CP_PASSWORD_CHECK, { password });
    // 수단 판정은 조회와 **같은 함수**로 한다 — 여기서 조건을 따로 적으면 화면과 갈린다.
    if (decideStepUp(r, false) === "none") return true;   // 물을 것이 없다
    return r?.ok === true;
  }
  if (decideStepUp(null, await hasCredential(user.userId)) === "none") return true;   // 종전 동작 그대로
  return !!password && await verifyOwnPassword(user.userId, password);
}
