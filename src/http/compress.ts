// 웹 화면 응답 압축이 «무엇을 압축하나»(#4989) — index.ts 의 compression 미들웨어가 묻는다.
//
//  통째로 한 번에 나가는 글자 형식만 고른다. 조금씩 흘려 보내는 응답 — SSE(text/event-stream · 알림 스트림 · 터미널 사건)와
//   ndjson(대화 흐름) — 은 빼야 한다: 압축기는 창을 채울 때까지 모아 두므로, 한 줄짜리 사건이 사람에게 제때 닿지 않는다.
//   (compression 의 기본 필터는 mime-db 의 compressible 을 보는데, 거기선 text/event-stream 도 «압축 가능» 이다.)
//  CSV 내보내기 · 파일 내려받기처럼 그 밖의 형식은 종전대로 둔다 — 고를 이유가 생기면 그때 더한다.
import type express from "express";

const WHOLE_TEXT = /^(?:application\/(?:json|javascript)|text\/(?:javascript|css|html|plain)|image\/svg\+xml)\s*(?:;|$)/i;

/** 이 Content-Type 을 압축해도 되나 — 순수 판정(값으로 시험한다). */
export function compressibleType(type: unknown): boolean {
  return typeof type === "string" && WHOLE_TEXT.test(type.trim());
}

/** compression({ filter }) 자리 — 응답 헤더가 정해진 순간 한 번 묻는다. */
export function compressionFilter(_req: express.Request, res: express.Response): boolean {
  return compressibleType(res.getHeader("Content-Type"));
}
