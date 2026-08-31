// opencode serve(SSE) → SessionEvent 번역기 (#2439). **순수** — 프로세스·IO 없음.
//
//  ── 근거 ────────────────────────────────────────────────────────────────────────
//  `opencode serve` 를 실제로 띄우고 **OpenAPI 문서를 받아** 계약을 읽었다(1.18.25, 2026-08-31):
//    · 엔드포인트 162개. 우리에게 필요한 것은 `/event`(SSE) · `/permission/{requestID}/reply` ·
//      `/session/{id}/shell` · `/session/{id}/children`(서브에이전트) · `/session/{id}/abort`.
//    · 이벤트 스키마 실측(properties 까지):
//        EventPermissionAsked   { id, type, properties:{id,sessionID,permission,patterns,metadata,always} }
//        EventCommandExecuted   { id, type, properties:{name,sessionID,arguments,messageID} }
//        EventSessionIdle       { id, type, properties:{sessionID} }
//        EventMessagePartUpdated{ id, type, properties:{sessionID,part,time} }
//
//  ── ⭐ 이 하네스만은 서버화가 **기능을 새로 연다** ──────────────────────────────
//  opencode 는 단일 대화 파일을 안 써서 지금까지 **대화 읽기(parse)가 구조적으로 아예 없었다**
//  (#1884 §2 #35 ⛔ — 화면이 정직하게 «못 읽는다» 고 말하고 터미널로 물러났다).
//  serve 로 가면 읽기와 **승인이 동시에** 열린다. 다른 하네스는 «있는 것을 옮기는» 일이지만
//  여기서는 없던 것이 생긴다.
//
//  ── 아직 안 옮기는 것 ───────────────────────────────────────────────────────────
//  대화 본문(EventMessagePartUpdated 의 `part`)은 ChatLine 축이라 여기서 다루지 않는다.
//  그리고 실제 SSE 프레임을 **로그인 없이는 못 받아** 필드값의 형태(문자열인지 객체인지)를
//  전부 확정하지 못했다 — 그래서 모르는 것은 `raw` 로 올려 관측한다(session-event.ts ★2).
import type { SessionEvent, TaskInfo } from "./session-event.js";

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** 명령·인자를 사람이 읽을 한 줄로(카드 한 줄이다). */
function titleOf(name: unknown, args: unknown): string {
  const a = Array.isArray(args) ? args.map(String).join(" ") : (str(args) ?? "");
  const one = `${str(name) ?? ""} ${a}`.replace(/\s+/g, " ").trim();
  return one.length > 120 ? one.slice(0, 117) + "…" : one;
}

/** SSE 프레임 한 장(파싱된 JSON) → 세션 이벤트. 모르는 것은 `raw`. */
export function opencodeEvent(line: unknown): SessionEvent | null {
  const o = rec(line);
  if (!o) return null;
  const type = String(o.type ?? "");
  //  실측 스키마상 페이로드는 `properties` 아래 있다(EventXxx.properties).
  const p = rec(o.properties) ?? rec(o.props) ?? {};

  //  ── 승인 — opencode 는 이 축이 **API 로 열려 있다**(/permission/{id}/reply). ──
  if (type === "permission.asked" || type === "permission.v2.asked") {
    const id = str(p.id) ?? str(o.id) ?? "";
    if (!id) return { t: "raw", source: "opencode", payload: o };
    const perm = rec(p.permission) ?? {};
    return { t: "permission.asked", ask: {
      id,
      toolName: str(perm.type) ?? str(p.type) ?? "Tool",
      title: str(perm.title) ?? str(perm.pattern),
      description: str(perm.description),
      //  «항상 허용» 재료 — 화면이 그대로 되돌려준다(내용을 해석하지 않는다).
      suggestions: Array.isArray(p.patterns) ? p.patterns : undefined,
      input: p.metadata,
    } };
  }
  if (type === "permission.replied" || type === "permission.v2.replied") {
    const id = str(p.id) ?? str(o.id) ?? "";
    return id ? { t: "permission.resolved", id } : null;
  }

  //  ── 명령 실행 = 우리 «작업». opencode 낱말(name/arguments)을 우리 낱말로. ──
  if (type === "command.executed") {
    const id = str(p.messageID) ?? str(o.id) ?? "";
    if (!id) return { t: "raw", source: "opencode", payload: o };
    const task: TaskInfo = {
      id, kind: "shell", title: titleOf(p.name, p.arguments), status: "running",
    };
    return { t: "task.started", task };
  }

  //  ── 턴이 끝났다 — 도는 작업을 «끝남» 으로 접을 근거다(opencode 는 개별 완료 이벤트가 없다). ──
  //   ⚠ 여기서 작업을 지우지 않는다: 지우면 방금 끝난 것의 제목을 잃는다(claude 에서 밟은 그 버그).
  if (type === "session.idle") return { t: "usage", usage: {} };

  //  대화 본문은 ChatLine 축이다.
  if (type.startsWith("message.")) return null;

  //  ★ 나머지는 버리지 않는다 — 실제 SSE 를 받는 날 이 raw 가 형식을 알려준다.
  return type ? { t: "raw", source: "opencode", payload: o } : null;
}
