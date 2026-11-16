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

/** 감싸서 던진다 — 모르는 오류는 그대로(wrap 이 500 으로 낸다). */
export async function mapTransferErrors<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) { throw transferHttpError(e) ?? e; }
}
