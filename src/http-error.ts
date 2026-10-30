// HTTP 에러 leaf (#1313 R9) — capabilities/rest-util.ts 에서 원문 추출. 무의존(import 0) 모듈이라
//  저수준 인프라(disk-guard·org/·v6/ 스토어 등)가 express 헬퍼(http/rest-util) 없이 상태코드 오류를 던질 수 있다.
// ── 에러/검증 헬퍼 ──
//  cause: 사용자 문구(message)와 별개로 **원인 오류**를 실어 보낸다 — 5xx 는 wrap 이 이걸 로그에 남긴다(#1278).
//  body: 응답 JSON 에 **함께 실을 구조화 정보**(#3870). 화면이 안내 문구를 파싱하지 않고 분기하게 하려는 것이다.
//   왜 필요한가: 서버 문구가 «화면의 [강제로 되살리기] 를 눌러 주세요» 처럼 **화면의 장치를 지목**하는 자리가 있는데,
//    그 장치를 실제로 그리는 화면은 하나뿐이었다 — 나머지 화면은 그 문장을 그대로 토스트해서 **없는 버튼을 누르라고**
//    했다(실측 2026-09-12, 원준님). 같은 상태코드 안에서도 그 선택지가 있는 것과 없는 것이 섞이므로(복원 409 는
//    «force 로 풀리는 모름» 셋과 «노드가 켜져야 풀림» 셋이 같은 409 다) 상태코드만으로는 화면이 못 가른다.
//   ⚠ `error` 키는 넣지 마라 — 직렬화에서 message 가 이긴다(안내문이 조용히 덮이지 않게, rest-util wrap).
export class HttpError extends Error {
  readonly body?: Record<string, unknown>;
  constructor(public status: number, message: string, options?: { cause?: unknown; body?: Record<string, unknown> }) {
    super(message, options);
    this.body = options?.body;
  }
}
