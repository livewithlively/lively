// 세션 요청 알림(#5713) — 요청이 걸렸다 · 끝났다를 **요청을 건 그 사람의 스트림**에 민다(v6/notify-bus NotifyAskEvent).
//  화면(곁칸 «요청» 칸 · #/ask 화면)은 이걸 받으면 목록을 다시 읽는다 — 내용은 싣지 않는다.
//  ⚠ 비치명 — 알림이 실패해도 요청은 이미 저장됐다(화면은 곁에 둔 느린 되묻기로 따라잡는다). 구독자가 없으면 버스가 즉시 돌아온다.
import { logger } from "../log.js";
import { publishNotify, type NotifyAskEvent } from "../v6/notify-bus.js";
import { hereSlug } from "../v6/notify-scope.js";

let seq = 0;
export function publishAsk(member: string, ev: Omit<NotifyAskEvent, "type" | "key" | "ts" | "ws">): void {
  try {
    const ts = Date.now();
    publishNotify({ ws: hereSlug(), member }, { type: "ask", ...ev, key: `q:${ev.id}:${ev.kind}:${ts}:${++seq}`, ts });
  } catch (e) { logger.warn({ err: e, ask: ev.id }, "세션 요청 알림 전달 실패(비치명)"); }
}
