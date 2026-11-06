// 관리자가 구성원에게 주는 임시 비밀번호 고르기(순수) — 관리자가 정한 것 또는 자동 발급.
//  관리자가 정해 주면(여러 사람을 한꺼번에 같은 임시 비번으로 열 때 등) 응답에 그 글을 다시 싣지 않는다 — 관리자가 이미 알고,
//  응답 · 로그 · 화면에 비번이 남지 않게(MCP 호출 기록의 입력 값은 org/policies/tool-log.ts SECRET_ARG_FIELDS 가 가린다).
//  자동 발급이면 지금처럼 1회 돌려준다(관리자가 멤버에게 전달).
//  어느 쪽이든 저장은 must_change(첫 로그인 후 변경 권장)로 한다 — capabilities/delivery/members.ts org_member_reset_password.
import { HttpError } from "../http-error.js";

/** 본인 비번 변경(/api/ui/password)과 같은 하한. */
export const TEMP_PASSWORD_MIN = 8;
export const TEMP_PASSWORD_MAX = 128;

/**
 * @param given 관리자가 준 임시 비번 — 없음 · null · 빈 글이면 자동 발급
 * @param generate 자동 발급기(auth/local-accounts.generateInitialPassword)
 * @returns password 저장할 비번 · echo 응답에 다시 싣나(자동 발급일 때만)
 */
export function chooseTempPassword(given: unknown, generate: () => string): { password: string; echo: boolean } {
  if (given === undefined || given === null || given === "") return { password: generate(), echo: true };
  if (typeof given !== "string") throw new HttpError(400, "password 는 글이어야 합니다");
  if (given.length < TEMP_PASSWORD_MIN || given.length > TEMP_PASSWORD_MAX) {
    throw new HttpError(400, `password 는 ${TEMP_PASSWORD_MIN}~${TEMP_PASSWORD_MAX}자여야 합니다`);
  }
  if (/[\u0000-\u001f\u007f]/.test(given)) throw new HttpError(400, "password 에 제어 문자를 넣을 수 없습니다");
  return { password: given, echo: false };
}
