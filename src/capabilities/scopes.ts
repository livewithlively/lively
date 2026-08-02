// #1313 R9 shim — 본체는 src/auth/scopes.ts 로 이동. capabilities/ 내부 소비자용 재수출만 남긴다.
//  capabilities 밖 코드는 ../auth/scopes.js 를 직접 import 할 것(이 shim 역수입은 계층 역전 재발).
export * from "../auth/scopes.js";
