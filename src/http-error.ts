// HTTP 에러 leaf (#1313 R9) — capabilities/rest-util.ts 에서 원문 추출. 무의존(import 0) 모듈이라
//  저수준 인프라(disk-guard·org/·v6/ 스토어 등)가 express 헬퍼(http/rest-util) 없이 상태코드 오류를 던질 수 있다.
// ── 에러/검증 헬퍼 ──
//  cause: 사용자 문구(message)와 별개로 **원인 오류**를 실어 보낸다 — 5xx 는 wrap 이 이걸 로그에 남긴다(#1278).
export class HttpError extends Error {
  constructor(public status: number, message: string, options?: { cause?: unknown }) { super(message, options); }
}
