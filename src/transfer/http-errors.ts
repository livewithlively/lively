// 워크스페이스 간 옮기기(#5458) — 도메인 오류 → HTTP 상태. 내보내기·올리기 경로(routes.ts)와 capability(적용·되돌리기)가 같이 쓴다.
//  화면이 문구를 파싱하지 않고 분기하도록 code 를 body 에 싣는다(HttpError body 규약 — src/http-error.ts 머리말).
import { HttpError } from "../http-error.js";
import { BundleFormatError, BundlePasswordRequiredError } from "./bundle.js";
import { SealFormatError, SealPasswordError } from "./seal.js";
import { ZipFormatError } from "./zip.js";
import { PlanError } from "./plan.js";
import { TransferInputError } from "./apply.js";

export function transferHttpError(e: unknown): HttpError | null {
  if (e instanceof HttpError) return e;
  if (e instanceof BundlePasswordRequiredError) return new HttpError(400, e.message, { body: { code: "password_required" } });
  if (e instanceof SealPasswordError) return new HttpError(400, e.message, { body: { code: "wrong_password" } });
  if (e instanceof BundleFormatError || e instanceof SealFormatError || e instanceof ZipFormatError) return new HttpError(400, e.message, { body: { code: "bad_file" } });
  if (e instanceof PlanError) return new HttpError(400, e.message, { body: { code: "plan" } });
  if (e instanceof TransferInputError) return new HttpError(e.status, e.message, e.code ? { body: { code: e.code } } : undefined);
  return null;
}

/** 올리기 상한을 넘었을 때 사람에게 보이는 문구. 화면은 올리기 전에 같은 문구로 막는다(web/v2/transfer.ts). */
export const UPLOAD_TOO_LARGE = "파일이 100MB 를 넘습니다 — 옮기기 파일이 맞는지 확인해 주세요. 맞다면 보내는 쪽에서 자료를 빼거나 분류를 나눠 다시 내보내 주세요";

/**
 * 올리기 경로의 본문 파서 오류 → 응답(순수). express.raw 가 상한을 넘는 본문을 거절하면(type 'entity.too.large', 413)
 *  기본 오류 처리는 영어 HTML 을 돌려줘 화면에 «요청 실패 (413)» 만 보였다(2026-11-18 — 설치 파일 zip 을 잘못 올린 경우).
 *  모르는 오류면 null(다음 처리로 넘긴다).
 */
export function uploadBodyError(err: unknown): { status: number; body: { error: string; code: string } } | null {
  const e = err as { type?: unknown; status?: unknown } | null;
  if (e && e.type === "entity.too.large") return { status: 413, body: { error: UPLOAD_TOO_LARGE, code: "too_large" } };
  return null;
}

/** 감싸서 던진다 — 모르는 오류는 그대로(wrap 이 500 으로 낸다). */
export async function mapTransferErrors<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) { throw transferHttpError(e) ?? e; }
}
