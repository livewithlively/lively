// #1313 R9 shim — 본체는 src/http/rest-util.ts 로 이동(HttpError 는 src/http-error.ts leaf).
//  capabilities/ 내부 소비자용 재수출만 남긴다 — capabilities 밖 코드는 ../http/rest-util.js
//  또는 ../http-error.js 를 직접 import 할 것(이 shim 을 역수입하면 계층 역전이 재발한다).
export * from "../http/rest-util.js";
