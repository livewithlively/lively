// 세션이력 회수·수집 라우트(#905 C1 슬2b) — 트랜스크립트 델타를 중앙에 offset-CAS append + 읽기.
//  캡처 훅(kit 번들, 슬2c)이 여기로 델타를 POST 한다. 저장 척추는 v6/session-log-store.ts(offset-CAS).
//
//  ── 게이트(설계 §5) ──
//   ① 조직 스위치: session_share.enabled 가 꺼져 있으면 **아무것도 안 받는다**(403) — 구 훅이 남아 있어도 조용히 저장되지 않는다.
//   ② 하네스: session_share.harnesses 에 없는 하네스는 거부(정책 밖 수집 차단).
//   ③ 소유자: 로그는 **첫 append 한 멤버**가 소유(session.owner). 이후 그 사람만 append — 남이 남의 세션 로그를 오염 못 함.
//      (세션 uuid 는 사실상 유일하지만, 위조 방어로 명시 게이트를 둔다.)
//   회수(GET)는 슬2d(웹뷰)에서 열람권한(view_policy)까지 붙인다 — 이 슬라이스는 append 를 위한 최소 GET(watermark)만.
import type express from "express";
import { sessionOrBearer } from "./auth/http-auth.js";
import type { BearerVerifier } from "./auth/bearer.js";
import type { LivelyUser } from "./context.js";
import { wrap, HttpError } from "./capabilities/rest-util.js";
import { getRuntimeConfig } from "./org/store.js";
import { appendSessionLog, sessionLogWatermark, sessionOwner } from "./v6/session-log-store.js";

const MAX_DELTA = 8 * 1024 * 1024;   // 한 번에 받는 델타 상한(8MB) — 큰 트랜스크립트도 청크로 나눠 보내게.

// append 인가 판정(순수) — 프라이버시가 걸린 게이트라 HTTP 없이 단위검증한다. ok면 null, 막으면 {status,message}.
//  ① enabled 꺼짐 → 403(조직이 안 켰으면 저장 안 함) ② 정책 밖 하네스 → 403 ③ 소유자 아님 → 403
//  ④ 오프셋 형식 오류 → 400. requester 부재 → 403(신원 필수).
export interface AppendGateInput {
  enabled: boolean; harnesses: string[];
  requester: string; harness: string | null; owner: string | null; atOffset: number;
}
export function checkAppendGate(g: AppendGateInput): { status: number; message: string } | null {
  if (!g.requester) return { status: 403, message: "사용자 신원이 없습니다" };
  if (!Number.isFinite(g.atOffset) || g.atOffset < 0 || Math.floor(g.atOffset) !== g.atOffset) return { status: 400, message: "at(오프셋)은 0 이상 정수여야 합니다" };
  if (!g.enabled) return { status: 403, message: "세션 공유가 꺼져 있습니다(관리탭 ▸ 세션 공유에서 켜세요)" };
  if (g.harness && !g.harnesses.includes(g.harness)) return { status: 403, message: `하네스 '${g.harness}' 는 수집 대상이 아닙니다` };
  if (g.owner && g.owner !== g.requester) return { status: 403, message: "이 세션 로그의 소유자가 아닙니다" };
  return null;
}
const userOf = (req: express.Request): LivelyUser => (req.auth?.extra ?? {}) as unknown as LivelyUser;
const idOf = (u: LivelyUser): string => u.userId || u.email || "";
// 세션 uuid 형식(claude/codex) — 경로 인젝션·잡값 차단. 관대하게: 영숫자·-·_ (40자 이하).
const SID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const NODE_RE = /^[A-Za-z0-9._-]{0,64}$/;   // 빈 문자열('' = 게이트웨이 로컬) 허용

// raw 바디를 Buffer 로 수집(상한 초과 시 413). express.json 마운트 이전이 아니라도, 이 라우트는 자체 수집한다.
function readRawBody(req: express.Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let n = 0; let done = false;
    const fin = (fn: () => void) => { if (!done) { done = true; fn(); } };
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > limit) { fin(() => reject(new HttpError(413, `델타가 너무 큽니다(${limit} 바이트 이하로 나눠 보내세요)`))); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => fin(() => resolve(Buffer.concat(chunks))));
    req.on("error", (e) => fin(() => reject(e)));
  });
}

export function registerSessionLogRoutes(app: express.Express, verifier: BearerVerifier): void {
  const auth = sessionOrBearer(verifier);

  // 델타 append — offset-CAS. at=현재 보낸 쪽 오프셋, node=실행 노드('' 기본). 응답 {ok, verdict, bytes} 로 오프셋 정정.
  app.post("/api/ui/v6/sessions/:id/log", auth, wrap(async (req, res) => {
    const requester = idOf(userOf(req));
    if (!requester) throw new HttpError(403, "사용자 신원이 없습니다");
    const sessionId = String(req.params.id ?? "");
    if (!SID_RE.test(sessionId)) throw new HttpError(400, "세션 id 형식 오류");
    const nodeId = String(req.query.node ?? "");
    if (!NODE_RE.test(nodeId)) throw new HttpError(400, "node 형식 오류");
    const atOffset = Number(req.query.at);
    const harness = req.query.harness ? String(req.query.harness) : null;

    // 인가 게이트(순수 checkAppendGate) — enabled·하네스·소유자·오프셋. config·owner 는 DB 에서 채운다.
    const cfg = (await getRuntimeConfig()).session_share;
    const owner = await sessionOwner(nodeId, sessionId);
    const denied = checkAppendGate({ enabled: cfg.enabled, harnesses: cfg.harnesses, requester, harness, owner, atOffset });
    if (denied) throw new HttpError(denied.status, denied.message);

    const data = await readRawBody(req, MAX_DELTA);
    const r = await appendSessionLog({ nodeId, sessionId, atOffset, data, harness, owner: requester });
    res.setHeader("Cache-Control", "no-store");
    res.json(r);   // { ok, verdict, bytes } — 보낸 쪽이 bytes 로 로컬 오프셋을 정정한다.
  }));

  // 재연결 오프셋 고지 + 캡처 정책 — 캡처 훅이 **한 번의 GET**으로 "보내야 하나·어떻게·어디부터"를 다 받는다
  //  (로컬 오프셋 상태 파일 불요 — 서버 워터마크가 오프셋의 진실). append 와 같은 소유자 게이트.
  //  capture 는 비밀이 아닌 정책 플래그라 인증된 멤버에게 노출해도 안전(훅이 이걸로 조기 종료 판단).
  app.get("/api/ui/v6/sessions/:id/log/watermark", auth, wrap(async (req, res) => {
    const requester = idOf(userOf(req));
    if (!requester) throw new HttpError(403, "사용자 신원이 없습니다");
    const sessionId = String(req.params.id ?? "");
    if (!SID_RE.test(sessionId)) throw new HttpError(400, "세션 id 형식 오류");
    const nodeId = String(req.query.node ?? "");
    if (!NODE_RE.test(nodeId)) throw new HttpError(400, "node 형식 오류");
    const owner = await sessionOwner(nodeId, sessionId);
    if (owner && owner !== requester) throw new HttpError(403, "이 세션 로그의 소유자가 아닙니다");
    const c = (await getRuntimeConfig()).session_share;
    res.setHeader("Cache-Control", "no-store");
    res.json({
      bytes: await sessionLogWatermark(nodeId, sessionId),
      capture: { enabled: c.enabled, harnesses: c.harnesses, scope: c.scope, store: c.store },
    });
  }));
}
