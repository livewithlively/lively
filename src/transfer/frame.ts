// 워크스페이스 간 옮기기(#5458) — 올리기 본문에 비밀번호를 싣는 틀.
//
// 왜 머리글이 아니라 본문인가(리뷰 지적 2026-11-09): 프록시·접근 기록은 요청 머리글을 남기기도 하고, 흔한 설정은
//  Authorization·Cookie 정도만 가린다. 비밀번호를 `X-…` 머리글로 보내면 기록에 그대로 남을 수 있다.
//
// 모양: "LIVELY-PW1\n" + base64(UTF-8 비밀번호) + "\n" + 파일 바이트.
//  파일 쪽 첫 바이트는 zip("PK\x03\x04") 또는 잠긴 묶음("LIVELY-SEALED-BUNDLE\n")이라 이 머리와 겹치지 않는다.
//  base64 로 싸는 이유: 비밀번호에 줄바꿈이 들어 있어도 틀이 깨지지 않게.

export const PASSWORD_FRAME = Buffer.from("LIVELY-PW1\n", "ascii");
const MAX_PASSWORD_B64 = 2048;

export class PasswordFrameError extends Error {}

/** 본문 → 비밀번호(없으면 null) + 파일 바이트. 틀이 아니면 본문 전체가 파일이다. */
export function splitPasswordFrame(body: Buffer): { password: string | null; file: Buffer } {
  if (body.length < PASSWORD_FRAME.length || !body.subarray(0, PASSWORD_FRAME.length).equals(PASSWORD_FRAME)) {
    return { password: null, file: body };
  }
  const nl = body.indexOf(0x0a, PASSWORD_FRAME.length);
  if (nl < 0 || nl - PASSWORD_FRAME.length > MAX_PASSWORD_B64) throw new PasswordFrameError("비밀번호 칸이 망가졌습니다");
  const b64 = body.subarray(PASSWORD_FRAME.length, nl).toString("ascii");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new PasswordFrameError("비밀번호 칸이 망가졌습니다");
  const password = Buffer.from(b64, "base64").toString("utf8");
  return { password: password || null, file: body.subarray(nl + 1) };
}

/** 비밀번호 + 파일 → 본문(시험·CLI 용 — 화면은 같은 모양을 Blob 으로 만든다). */
export function joinPasswordFrame(password: string, file: Buffer): Buffer {
  return Buffer.concat([PASSWORD_FRAME, Buffer.from(Buffer.from(password, "utf8").toString("base64") + "\n", "ascii"), file]);
}
