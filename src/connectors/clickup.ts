// #1313 R22 — ClickUp 커넥터는 clickup/ 디렉터리로 분할됐다(types·transform·api·stream·index).
//  기존 소비자(clickup-push·discover·run-sync·connectors/index)의 import 스펙 "./clickup.js" 가 계속
//  해석되도록 남긴 재수출 shim — 표면(export 집합)은 배럴(clickup/index.ts)과 byte 동일하다.
export * from "./clickup/index.js";
