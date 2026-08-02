// #1313 R22 — Notion 커넥터는 notion/ 디렉터리로 분할됐다(client·state·assets·scope·traverse·emit·index).
//  기존 소비자(notion-push·run-sync·feed-targets·notion-exclude.test·connectors/index)의 import 스펙
//  "./notion.js" 가 계속 해석되도록 남긴 재수출 shim — 표면(export 집합)은 배럴(notion/index.ts)과 byte 동일하다.
export * from "./notion/index.js";
