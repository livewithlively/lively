// 앱 사용 동의가 없거나 예전 범위라 막혔다는 표지(#4482) — 잎 모듈(가져오는 것 없음).
//  서버 두 자리(capabilities/app-tool-call.ts 가 던지고 · apps/app-front-api.ts 가 consent_url 을 붙인다)와
//  웹 SDK 런타임(web/v2/app-ui-runtime.ts — 주입 문자열이라 가져올 수 없어 글자로 적는다)이 같은 글자를 쓴다.
//  한쪽만 바꾸면 동의 자리 첨부와 SDK 의 동의 이동이 조용히 사라진다 — app-front-api.test.ts 가 세 자리를 대조한다.
export const CONSENT_REQUIRED = "consent_required";
