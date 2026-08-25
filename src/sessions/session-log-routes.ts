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
import { sessionOrBearer } from "../auth/http-auth.js";
import type { BearerVerifier } from "../auth/bearer.js";
import type { LivelyUser } from "../context.js";
import { wrap, HttpError } from "../http/rest-util.js";
import { getRuntimeConfig } from "../org/store.js";
import { appendSessionLog, firstUserPromptTitle, sessionLogWatermark, sessionOwner, sessionParent, sessionHarness, readSessionLog, listSessionsForOwner, listSessionsForProject, listSubagentsForSession } from "../v6/session-log-store.js";
import { harnessIo } from "../terminal/harness-io/adapter.js";        // #1746 — 하네스별 파서로 공통 ChatLine
import { readAlignedWindow } from "../terminal/harness-io/window.js";
import { parseWindow } from "../terminal/harness-io/parse-cache.js";
import { toNdjson } from "../terminal/harness-io/chat-line.js";
import { sessionBoundToMemberProject, isProjectMember, recordSessionProject, latestProjectForSession } from "../v6/project-session-store.js";   // #1313 R21 — 세션 바인딩만(PM 스토어 전체 미적재)
import { executionSessionProject } from "../v6/execution-session-store.js";

/** 실행 바인딩이 있으면 detach(null)까지 그 값이 권위다. legacy query는 실행 행 자체가 없을 때만 쓴다. */
export function sessionLogProjectClaim(
  current: { project_id: number | null; binding_epoch: number } | null,
  legacyProject: number,
): { projectId: number | null; bindingEpoch: number | undefined } | null {
  if (current) return { projectId: current.project_id, bindingEpoch: current.binding_epoch };
  return Number.isInteger(legacyProject) && legacyProject > 0
    ? { projectId: legacyProject, bindingEpoch: undefined }
    : null;
}
import { renderTranscript, firstTranscriptCwd, materializeTranscriptIfMissing } from "../terminal/terminal-transcript.js";
import { createSession, editSession, sharedRoot } from "../terminal/terminal-sessions.js";
import { autoNameUnnamedSession } from "./session-autoname.js";
import { nodeRpc } from "../node/registry.js";
import path from "node:path";
import { getSessionState, sessionStateByClaudeUuid, updateSessionStateMeta } from "./session-state.js";
import { transcriptRange } from "./transcript-range.js";   // #1719 — 창 읽기(대화창)

export const MAX_DELTA = 8 * 1024 * 1024;   // 한 번에 받는 델타 상한(8MB) — 큰 트랜스크립트도 청크로 나눠 보내게.

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

// 웹뷰 열람 인가 판정(순수, #905 C1 슬2d) — 트랜스크립트 **전문**이 나가므로 프라이버시 게이트. ok면 null.
//  · 신원부재 → 403. · 소유자면 항상 허용(view_policy 무관 — 자기 로그). · view_policy="attach" 면 프로젝트 멤버도 허용.
//  · 그 외(owner 정책의 비소유자 등) → 403. 열람은 resume 보다 넓다(canViewLog ≠ canResumeAsOrigin, 설계 §5).
//    isProjectMember 는 라우트가 DB 로 채운다(attach 이고 비소유자일 때만 필요 — 소유자면 조회조차 안 함).
export interface ViewGateInput {
  requester: string; owner: string | null; viewPolicy: string; isProjectMember: boolean;
}
export function checkViewGate(g: ViewGateInput): { status: number; message: string } | null {
  if (!g.requester) return { status: 403, message: "사용자 신원이 없습니다" };
  if (g.owner && g.owner === g.requester) return null;                    // 소유자는 언제나 자기 로그를 본다
  if (g.viewPolicy === "attach" && g.isProjectMember) return null;        // 프로젝트 멤버 열람(DB 기반, 죽은 세션도)
  return { status: 403, message: "이 세션 로그를 볼 권한이 없습니다" };
}
const userOf = (req: express.Request): LivelyUser => (req.auth?.extra ?? {}) as unknown as LivelyUser;
const idOf = (u: LivelyUser): string => u.userId || u.email || "";
// 세션 uuid 형식(claude/codex) — 경로 인젝션·잡값 차단. 관대하게: 영숫자·-·_ (40자 이하).
const SID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const NODE_RE = /^[A-Za-z0-9._-]{0,64}$/;   // 빈 문자열('' = 게이트웨이 로컬) 허용

// raw 바디를 Buffer 로 수집(상한 초과 시 413). 이 라우트는 octet-stream 전용(핸들러가 content-type 게이트)이라 전역
//  express.json 이 스트림을 소진하지 않는다. 그래도 방어적으로 처리한다:
//   ① 상위 미들웨어가 이미 스트림을 다 읽었으면(readableEnded) 'data'/'end' 가 다시 안 온다 → **매달리지 말고** 즉시 종료.
//   ② 상한 초과 시 소켓을 **죽이지 않는다**(pause 만) — 죽이면 413 응답을 보낼 상대가 사라진다(upload-file.ts 선례).
export function readRawBody(req: express.Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let n = 0; let done = false;
    const fin = (fn: () => void) => { if (!done) { done = true; fn(); } };
    // ⚠ readableEnded 일 때만 즉시 종료(=스트림이 실제로 소진됨, 예: 전역 json 파서가 이미 읽음). complete 는 쓰지 않는다:
    //   작은 본문은 auth(비동기 토큰조회) 사이에 전부 버퍼되어 complete=true 가 되지만 **아직 안 읽힌** 상태 —
    //   그걸 소진으로 오인해 조기 종료하면 본문을 통째로 잃는다(작은 델타·서브에이전트 캡처 유실. #905 C1 실버그).
    if (req.readableEnded) { resolve(Buffer.concat(chunks)); return; }
    req.on("data", (c: Buffer) => {
      if (done) return;
      n += c.length;
      if (n > limit) { req.pause(); fin(() => reject(new HttpError(413, `델타가 너무 큽니다(${limit} 바이트 이하로 나눠 보내세요)`))); return; }
      chunks.push(c);
    });
    req.on("end", () => fin(() => resolve(Buffer.concat(chunks))));
    req.on("error", (e) => fin(() => reject(e)));
  });
}

export function registerSessionLogRoutes(app: express.Express, verifier: BearerVerifier): void {
  const auth = sessionOrBearer(verifier);

  // 내 세션 목록(웹뷰 슬⑤b) — 소유자=요청자인 세션을 모든 노드에서. "어느 환경에서 만들었든 내 세션들"의 목록면.
  app.get("/api/ui/v6/sessions", auth, wrap(async (req, res) => {
    const requester = idOf(userOf(req));
    if (!requester) throw new HttpError(403, "사용자 신원이 없습니다");
    res.setHeader("Cache-Control", "no-store");
    res.json({ sessions: await listSessionsForOwner(requester) });
  }));

  // 프로젝트 **세션이력** 목록(웹뷰 슬⑤b) — 이 프로젝트에 바인딩된 중앙 기록 세션(과거 포함). 인가: 프로젝트 멤버.
  //  ⚠ 경로가 `/sessions` 가 아니라 `/session-logs` — `/projects/:id/sessions`(project-routes.ts)는 **살아있는
  //    tmux 세션**을 돌려주는 별개 엔드포인트라 충돌한다. 여기는 중앙 로그 이력(죽은 세션 포함)이라 개념도 다르다.
  app.get("/api/ui/v6/projects/:id/session-logs", auth, wrap(async (req, res) => {
    const requester = idOf(userOf(req));
    if (!requester) throw new HttpError(403, "사용자 신원이 없습니다");
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) throw new HttpError(400, "프로젝트 id 형식 오류");
    if (!(await isProjectMember(projectId, requester))) throw new HttpError(403, "이 프로젝트의 멤버가 아닙니다");
    res.setHeader("Cache-Control", "no-store");
    res.json({ sessions: await listSessionsForProject(projectId) });
  }));

  // 델타 append — offset-CAS. at=현재 보낸 쪽 오프셋, node=실행 노드('' 기본). 응답 {ok, verdict, bytes} 로 오프셋 정정.
  app.post("/api/ui/v6/sessions/:id/log", auth, wrap(async (req, res) => {
    const requester = idOf(userOf(req));
    if (!requester) throw new HttpError(403, "사용자 신원이 없습니다");
    const sessionId = String(req.params.id ?? "");
    if (!SID_RE.test(sessionId)) throw new HttpError(400, "세션 id 형식 오류");
    const nodeId = String(req.query.node ?? "");
    if (!NODE_RE.test(nodeId)) throw new HttpError(400, "node 형식 오류");
    // 이 엔드포인트는 octet-stream 델타 전용. 다른 content-type(특히 application/json)은 전역 express.json 이
    //  먼저 스트림을 소진해 readRawBody 가 영원히 매달린다 → DB 접근 전에 415 로 일찍 막는다. 훅은 항상 octet-stream 전송.
    if (!req.is("application/octet-stream")) throw new HttpError(415, "본문은 application/octet-stream 이어야 합니다");
    const atOffset = Number(req.query.at);
    const harness = req.query.harness ? String(req.query.harness) : null;

    // 인가 게이트(순수 checkAppendGate) — enabled·하네스·소유자·오프셋. config·owner 는 DB 에서 채운다.
    const cfg = (await getRuntimeConfig()).session_share;
    const owner = await sessionOwner(nodeId, sessionId);
    const denied = checkAppendGate({ enabled: cfg.enabled, harnesses: cfg.harnesses, requester, harness, owner, atOffset });
    if (denied) throw new HttpError(denied.status, denied.message);

    const data = await readRawBody(req, MAX_DELTA);
    // 서브에이전트 트리(#905 C1 슬⑥) — parent=부모(주) 세션 id. 최상위 목록엔 안 나오고 부모 대화록 아래에 붙는다.
    const parentSessionId = req.query.parent !== undefined && SID_RE.test(String(req.query.parent)) ? String(req.query.parent) : null;
    const r = await appendSessionLog({ nodeId, sessionId, atOffset, data, harness, owner: requester, store: cfg.store, parentSessionId });
    // 프로젝트 귀속(#905 C1 슬⑤b) — 대화 id(sessionId)와 실행 세션 id(execution)는 별개이므로,
    //  execution_session의 현재 DB 바인딩을 대화 이력에 투영한다. cwd·project.json은 보지 않는다.
    //  구 백필 클라이언트의 project query는 멤버십 검사 뒤에만 허용하는 전환 호환 경로다.
    // 세션 자동 이름(#1808) — 첫 청크에서 '처음 시킨 말'을 알아낸 순간, 아직 이름이 없는 박스에 그 이름을 붙인다.
    //  이름을 안 주고 만든 세션(= 새 세션 폼이 프로젝트명을 프리필하지 않게 된 뒤의 기본)이 여기서 이름을 얻는다.
    //  사람이 지은 이름은 손대지 않고(autoNameUnnamedSession 이 판정), 실패는 전부 삼킨다 — 대화 기록 저장이 먼저다.
    if (atOffset === 0 && data.length > 0) {
      const t = firstUserPromptTitle(data.toString("utf8"));
      if (t) {
        void autoNameUnnamedSession(sessionId, t, {
          lookup: (uuid) => sessionStateByClaudeUuid(uuid),
          renameLocal: (owner, id, label) => editSession({ userId: owner } as LivelyUser, id, { label }),
          renameNode: (nodeId2, owner, id, label) => nodeRpc(nodeId2, "edit", { user: { userId: owner }, id, patch: { label } }).then(() => undefined),
          saveLabel: (id, label) => updateSessionStateMeta(id, { label }),
          warn: (msg, err) => console.warn(`[session-log] ${msg}:`, (err as Error)?.message ?? err),
        });
      }
    }
    const executionId = req.query.execution !== undefined ? String(req.query.execution) : "";
    const headerExecution = String(req.headers["x-lively-session"] ?? "");
    // 같은 소유자의 다른 실행 id를 대입해 귀속을 바꾸지 못하게, 전송 주체 헤더와 query가 같은 경우만 DB 바인딩을 쓴다.
    const currentBinding = executionId && executionId === headerExecution
      ? await executionSessionProject(executionId, requester).catch(() => null) : null;
    const claim = sessionLogProjectClaim(currentBinding, req.query.project !== undefined ? Number(req.query.project) : NaN);
    if (claim) {
      try {
        if (currentBinding || (claim.projectId != null && await isProjectMember(claim.projectId, requester))) {
          await recordSessionProject(sessionId, claim.projectId, claim.bindingEpoch);
        }
      } catch { /* 귀속 실패는 비치명 — 로그 저장은 이미 끝났다 */ }
    }
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

  // 트랜스크립트 회수(웹뷰, 슬2d) — from 바이트부터 끝까지 JSONL 원문을 돌려준다(렌더는 클라).
  //  열람권한: 소유자(항상) 또는 view_policy="attach" 면 이 세션이 바인딩됐던 프로젝트의 멤버(DB 기반 — 죽은 세션도).
  //  capture.enabled 와 **무관** — 이미 수집된 로그는 조직이 껐어도 소유자·멤버가 볼 수 있다(껐다고 과거를 못 보게 하진 않음).
  app.get("/api/ui/v6/sessions/:id/log", auth, wrap(async (req, res) => {
    const requester = idOf(userOf(req));
    if (!requester) throw new HttpError(403, "사용자 신원이 없습니다");
    const sessionId = String(req.params.id ?? "");
    if (!SID_RE.test(sessionId)) throw new HttpError(400, "세션 id 형식 오류");
    const nodeId = String(req.query.node ?? "");
    if (!NODE_RE.test(nodeId)) throw new HttpError(400, "node 형식 오류");
    const from = req.query.from !== undefined ? Number(req.query.from) : 0;
    if (!Number.isFinite(from) || from < 0 || Math.floor(from) !== from) throw new HttpError(400, "from(오프셋)은 0 이상 정수여야 합니다");

    // 열람 게이트(순수 checkViewGate) — owner·view_policy·멤버십. attach 이고 비소유자일 때만 멤버십 DB 조회.
    const cfg = (await getRuntimeConfig()).session_share;
    const owner = await sessionOwner(nodeId, sessionId);
    const isOwner = !!owner && owner === requester;
    const isProjectMember = !isOwner && cfg.view_policy === "attach"
      ? await sessionBoundToMemberProject(sessionId, requester) : false;
    const denied = checkViewGate({ requester, owner, viewPolicy: cfg.view_policy, isProjectMember });
    if (denied) throw new HttpError(denied.status, denied.message);

    // #1719 세션 대화창 — to/tail 이 오면 창(window)으로 읽는다(꼬리부터, 상한 4MB — transcript-range.ts).
    //  둘 다 없으면 종전대로 from 부터 끝까지(클래식 대화록 뷰어·이어받기가 전문을 쓴다 — 그 경로는 손대지 않는다).
    // #1746 — 창 읽기와 웹뷰 렌더는 **하네스 어댑터 파서**를 거친다: 저장은 원본 바이트(하네스마다 다른 스키마)지만 화면은 공통
    //  ChatLine 만 안다. 창은 줄 경계로 맞춰(window.ts) X-Log-From/To 를 준다 — 화면은 그 값을 다음 창의 경계로 그대로 쓴다.
    //  파서 없는 하네스(미보고 구 행 포함)는 종전대로 원본을 준다(claude 원본은 ChatLine 의 상위집합이라 화면이 그대로 그린다).
    //  ⚠ to/tail/fmt 없는 GET 은 **원본 바이트** 그대로다 — CLI(`lively resume`)가 그 바이트로 로컬 파일을 물질화한다. 대화창은
    //   증분 폴(from 만)에도 fmt=chat 을 붙여 공통 ChatLine 을 받는다.
    const windowed = req.query.to !== undefined || req.query.tail !== undefined;
    const chatFmt = windowed || req.query.fmt === "chat";
    const io = harnessIo(await sessionHarness(nodeId, sessionId));
    let log: { from: number; bytes: number; data: Buffer };
    let winEnd: number | undefined;
    let ndjson: string | undefined;            // 어댑터를 거친 공통 ChatLine 본문(있으면 이걸 낸다)
    if (chatFmt) {
      const total = await sessionLogWatermark(nodeId, sessionId);
      const rng = transcriptRange(total, { from: req.query.from, to: req.query.to, tail: req.query.tail });
      if (io?.parse) {
        const reader = { read: (s: number, e: number) => readSessionLog(nodeId, sessionId, s, e).then((r) => r.data) };
        const win = rng.end > rng.start ? await readAlignedWindow(reader, total, rng.start, rng.end, req.query.to !== undefined) : { from: rng.start, to: rng.start, data: Buffer.alloc(0) };
        const lines = win.data.length ? parseWindow(io.parse, `log|${nodeId}|${sessionId}`, win.from, win.to, win.data.toString("utf8")) : [];
        ndjson = toNdjson(lines);
        log = { from: win.from, bytes: total, data: win.data }; winEnd = win.to;
      } else {
        log = await readSessionLog(nodeId, sessionId, rng.start, rng.end);
        winEnd = rng.end;
      }
    } else {
      log = await readSessionLog(nodeId, sessionId, from);
    }
    res.setHeader("Cache-Control", "no-store");
    if (req.query.view === "render") {   // 웹뷰: 사람이 읽을 항목으로 파싱(채널필터) — 툴결과·노이즈 제거.
      // 서브에이전트 트랜스크립트(#905 C1 슬⑥)는 전 줄이 isSidechain 이라, 서브에이전트일 때만 sidechain 포함해 렌더.
      const includeSidechain = !!(await sessionParent(nodeId, sessionId));
      // 비-claude 는 어댑터로 공통 ChatLine 을 만든 뒤 렌더(renderTranscript 는 ChatLine 문법을 읽는다). claude 는 원본 그대로.
      const text = (io && io.parse && io.key !== "claude") ? toNdjson(io.parse(log.data.toString("utf8"), {}).lines) : log.data.toString("utf8");
      res.json({ from: log.from, bytes: log.bytes, items: renderTranscript(text, 5000, { includeSidechain }) });
      return;
    }
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("X-Log-Bytes", String(log.bytes));   // 전체 워터마크 — UI 가 증분 tail 에 쓴다
    res.setHeader("X-Log-From", String(log.from));
    if (winEnd !== undefined) res.setHeader("X-Log-To", String(winEnd));
    if (io) res.setHeader("X-Harness", io.key);
    if (ndjson !== undefined) { res.end(ndjson); return; }
    res.end(log.data);
  }));

  // 서브에이전트 목록(#905 C1 슬⑥) — 이 (부모)세션이 스폰한 서브에이전트들(대화록 아래 트리). 열람 게이트는 log 회수와 동일.
  app.get("/api/ui/v6/sessions/:id/subagents", auth, wrap(async (req, res) => {
    const requester = idOf(userOf(req));
    if (!requester) throw new HttpError(403, "사용자 신원이 없습니다");
    const sessionId = String(req.params.id ?? "");
    if (!SID_RE.test(sessionId)) throw new HttpError(400, "세션 id 형식 오류");
    const nodeId = String(req.query.node ?? "");
    if (!NODE_RE.test(nodeId)) throw new HttpError(400, "node 형식 오류");
    const cfg = (await getRuntimeConfig()).session_share;
    const owner = await sessionOwner(nodeId, sessionId);
    const isOwner = !!owner && owner === requester;
    const isMember = !isOwner && cfg.view_policy === "attach" ? await sessionBoundToMemberProject(sessionId, requester) : false;
    const denied = checkViewGate({ requester, owner, viewPolicy: cfg.view_policy, isProjectMember: isMember });
    if (denied) throw new HttpError(denied.status, denied.message);
    res.setHeader("Cache-Control", "no-store");
    res.json({ subagents: await listSubagentsForSession(nodeId, sessionId) });
  }));

  // 이어 질문하기(#905 C1) — 이 세션을 **원본 박스에서** claude --resume 로 잇는 새 터미널 세션을 만든다.
  //  소유자만(이어받기는 열람보다 강한 게이트). 원본이 박스(node_id='')·cwd 가 공유 루트 아래면 그 경로로 열어
  //  로컬 기록을 잇고(없으면 중앙본을 그 경로로 물질화). 원격 노드/경로불명이면 같은 프로젝트에 '새 세션' 폴백(이력 없음).
  app.post("/api/ui/v6/sessions/:id/resume", auth, wrap(async (req, res) => {
    const requester = idOf(userOf(req));
    if (!requester) throw new HttpError(403, "사용자 신원이 없습니다");
    const sessionId = String(req.params.id ?? "");
    if (!SID_RE.test(sessionId)) throw new HttpError(400, "세션 id 형식 오류");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const nodeId = String(body.node ?? req.query.node ?? "");
    if (!NODE_RE.test(nodeId)) throw new HttpError(400, "node 형식 오류");
    // 소유자 게이트 — 이어받기는 소유자만.
    const owner = await sessionOwner(nodeId, sessionId);
    if (!owner) throw new HttpError(404, "세션 기록이 없습니다");
    if (owner !== requester) throw new HttpError(403, "이 세션을 이어받을 수 없습니다(소유자만 가능).");

    const log = await readSessionLog(nodeId, sessionId, 0);
    if (!log.bytes) throw new HttpError(404, "이어받을 중앙 기록이 없습니다(내용 0).");
    const cwd = firstTranscriptCwd(log.data.toString("utf8"));
    const proj = await latestProjectForSession(sessionId);
    const user = userOf(req);
    const sharedBase = sharedRoot().base;
    const underShared = !!cwd && (cwd === sharedBase || cwd.startsWith(sharedBase + "/"));

    // 원본이 이 박스이고 cwd 가 공유 루트 아래 → 원본 경로에서 이어받기(로컬 없으면 중앙본 물질화).
    if (nodeId === "" && underShared && cwd) {
      await materializeTranscriptIfMissing(cwd, sessionId, log.data);
      // 원본 세션의 모드·기록범위를 승계한다(#1291 v2) — 안 넘기면 읽기전용으로 만든 세션이 일반 모드로 환생하고,
      //  좁혀둔 기록 범위도 풀린다. '이어보기'는 그 세션을 잇는 것이지 새로 여는 게 아니다.
      const prev = await getSessionState(sessionId).catch(() => undefined);
      const session = await createSession(user, {
        label: `이어보기 · ${sessionId.slice(0, 8)}`, rootKey: "shared", subpath: path.relative(sharedBase, cwd),
        // #1711 — 원본 세션의 하네스로 연다. 종전엔 "claude" 고정이라, codex 로 만든 세션의 기록을 이어보면
        //  **다른 하네스로** 열리면서 resume id 도 그 하네스에서 무의미해졌다(모드·기록범위는 이미 승계 중이었다).
        harness: prev?.harness || "claude", flags: {}, autoApprove: false, resume: sessionId, projectId: proj?.id, projectSrc: "v6",
        readOnly: !!prev?.read_only, incognito: !!prev?.incognito,
        writeVis: prev?.write_vis ?? undefined, restrictRead: !!prev?.restrict_read,
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ mode: "resume", session, projectId: proj?.id ?? null, cwd });
      return;
    }

    // 폴백 — 원격 노드/경로불명: 같은 프로젝트에 '원본 기반' 새 세션(이력 없음). 프로젝트도 없으면 만들 수 없음.
    if (proj?.folder) {
      const prevF = await getSessionState(sessionId).catch(() => undefined);
      const session = await createSession(user, {
        label: `새 세션(원본 기반) · ${sessionId.slice(0, 8)}`, rootKey: "shared", subpath: proj.folder,
        harness: prevF?.harness || "claude", flags: {}, autoApprove: false, projectId: proj.id, projectSrc: "v6",   // #1711 — 원본 하네스 승계
        readOnly: !!prevF?.read_only, incognito: !!prevF?.incognito,
        writeVis: prevF?.write_vis ?? undefined, restrictRead: !!prevF?.restrict_read,
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ mode: "fallback", session, projectId: proj.id,
        reason: nodeId ? "원본이 원격 노드라 여기서 바로 이어받을 수 없어, 같은 프로젝트에 새 세션을 만들었습니다." : "원본 실행 경로를 찾지 못해 같은 프로젝트에 새 세션을 만들었습니다." });
      return;
    }
    throw new HttpError(409, "원본 머신을 열 수 없고 연결된 프로젝트도 없어 이어받기 세션을 만들 수 없습니다.");
  }));
}
