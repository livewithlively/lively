// 분산 노드(#869) — 게이트웨이측 노드 레지스트리.
// 노드 에이전트가 아웃바운드로 연결(/node/ws, Bearer 노드토큰)하는 단일 WSS 를 받아
//  ① RPC(세션 CRUD 등 타입드 ops — 임의 셸 없음) ② 상태 push 수신(3s 스냅샷)
//  ③ 브라우저 웹터미널 ↔ 노드 attach 채널 릴레이(raw 바이트 무디코드 — terminal-pty 원칙)
// 를 다중화한다. 정책(가시성·소유·초대 검증)은 전부 이쪽(게이트웨이)이 소유한다(F7 정책/실행 분리).
import { WebSocketServer, type WebSocket } from "ws";
import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { logger } from "../log.js";
import type { SessionInfo } from "../terminal-sessions.js";
import {
  NODE_WS_PATH, decodeChanFrame, parseMsg, nodeSessionVisible,
  type NodeToGwMsg, type GwToNodeMsg, type NodeOp,
} from "./protocol.js";
import { authNodeToken, touchNode, type OrgNode } from "./store.js";

// 웹터미널 close 코드 확장(#869) — 로컬 4410(session-gone)/4403(no-access) 체계에 노드 사유를 더한다.
export const CLOSE_NODE_OFFLINE = 4462; // 노드 미연결(꺼짐·절전·네트워크) — 클라는 재시도 유지(일시 상태일 수 있음)

const RPC_TIMEOUT_MS = 15_000;   // create 가 mkdir·워크트리로 수 초 걸릴 수 있어 여유
const HEARTBEAT_MS = 30_000;     // 노드 WSS liveness(#687 과 동일 패턴 — 반쯤 끊긴 연결 회수)
const STATE_STALE_MS = 12_000;   // 상태 push(3s) 기준 신선 임계 — 넘으면 attach 정책 판정 전 RPC 로 재확인
const TOUCH_MIN_MS = 60_000;     // last_seen DB 갱신 스로틀

type LiveWS = WebSocket & { isAlive?: boolean };

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

interface NodeConn {
  node: OrgNode;
  ws: LiveWS;
  nextReq: number;
  pending: Map<number, Pending>;
  nextChan: number;
  chans: Map<number, { browser: WebSocket; opened: boolean }>;
  lastTouch: number;
}

// 노드 세션 스냅샷 — 노드가 끊겨도 유지해 '오프라인 노드의 세션'을 계속 보여준다(게이트웨이 재시작 시 리셋, 도그푸드 OK).
interface NodeState { ts: number; sessions: SessionInfo[]; name: string; kind: string; owner: string }

const conns = new Map<string, NodeConn>();
const states = new Map<string, NodeState>();
let heartbeat: NodeJS.Timeout | null = null;

export interface NodePublic { id: string; name: string; kind: string; owner: string; online: boolean; lastStateTs: number | null; sessions: number }

// 관리/생성폼용 노드 현황(연결 관점) — DB 목록과 조인은 라우트가(여긴 라이브 연결만 안다).
export function liveNodes(): NodePublic[] {
  const out: NodePublic[] = [];
  const seen = new Set<string>();
  for (const [id, c] of conns) {
    const st = states.get(id);
    out.push({ id, name: c.node.name, kind: c.node.kind, owner: c.node.owner_member, online: true, lastStateTs: st?.ts ?? null, sessions: st?.sessions.length ?? 0 });
    seen.add(id);
  }
  for (const [id, st] of states) {
    if (seen.has(id)) continue;
    out.push({ id, name: st.name, kind: st.kind, owner: st.owner, online: false, lastStateTs: st.ts, sessions: st.sessions.length });
  }
  return out;
}

export function nodeOnline(id: string): boolean { return conns.has(id); }

// 뷰어에게 보이는 노드 세션들(개인 세션 규칙: 소유자 또는 초대 — 프로젝트 전체공개 규칙은 원격에 미적용, D2).
//  오프라인 노드 세션은 마지막 스냅샷으로 보여주되 agentState 를 offline 으로 강제(라이브 오해 방지).
export interface NodeSessionInfo extends SessionInfo { node: { id: string; name: string; online: boolean } }
export function nodeSessionsFor(viewer: string): NodeSessionInfo[] {
  const out: NodeSessionInfo[] = [];
  for (const [id, st] of states) {
    const online = conns.has(id);
    for (const s of st.sessions) {
      if (!nodeSessionVisible(s, viewer)) continue;
      out.push({
        ...s,
        owned: s.owner === viewer,
        agentState: online ? s.agentState : "offline",
        attached: online ? s.attached : false,
        node: { id, name: st.name, online },
      });
    }
  }
  return out;
}

// 타입드 RPC — 노드에 op 실행을 위임하고 결과를 기다린다. 노드 미연결이면 즉시 실패.
export async function nodeRpc<T = unknown>(nodeId: string, op: NodeOp, args?: Record<string, unknown>): Promise<T> {
  const c = conns.get(nodeId);
  if (!c) throw new Error("node-offline");
  const id = c.nextReq++;
  const msg: GwToNodeMsg = { t: "req", id, op, args };
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { c.pending.delete(id); reject(new Error("node-rpc-timeout")); }, RPC_TIMEOUT_MS);
    c.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    try { c.ws.send(JSON.stringify(msg)); } catch (e) { clearTimeout(timer); c.pending.delete(id); reject(e as Error); }
  });
}

// attach 가부 판정(정책 — 게이트웨이 소유). 스냅샷이 신선하면 그걸로, 아니면 노드에 목록을 재조회.
export async function nodeCanAttach(nodeId: string, sessionId: string, viewer: string):
  Promise<{ ok: true } | { ok: false; code: number; reason: string }> {
  if (!conns.has(nodeId)) return { ok: false, code: CLOSE_NODE_OFFLINE, reason: "node-offline" };
  let st = states.get(nodeId);
  if (!st || Date.now() - st.ts > STATE_STALE_MS) {
    try {
      const sessions = await nodeRpc<SessionInfo[]>(nodeId, "list");
      st = applyState(nodeId, sessions);
    } catch { return { ok: false, code: CLOSE_NODE_OFFLINE, reason: "node-offline" }; }
  }
  const s = st.sessions.find((x) => x.id === sessionId);
  if (!s) {
    // 스냅샷에 없음 — 진짜 종료인지 노드에 확답을 구한다(#835 '확답 only' 원칙: 판정불가를 gone 으로 넘기지 않는다).
    const gone = await nodeRpc<boolean>(nodeId, "gone", { id: sessionId }).catch(() => false);
    return gone ? { ok: false, code: 4410, reason: "session-gone" } : { ok: false, code: 4403, reason: "no-access" };
  }
  if (!nodeSessionVisible(s, viewer)) return { ok: false, code: 4403, reason: "no-access" };
  return { ok: true };
}

// 브라우저 WS ↔ 노드 attach 채널 릴레이. 정책 판정(nodeCanAttach)은 호출자(terminal-pty 업그레이드)가 끝냈다.
//  브라우저→노드: 텍스트(JSON 제어 i/r/cap)를 ctl 로 포워딩(노드가 안전한 tmux 명령으로 번역 — 명령 구성은 서버측 불변).
//  노드→브라우저: 바이너리 채널 프레임의 payload 를 그대로 send(무디코드 — 멀티바이트 경계 보존).
export function nodeRelayAttach(nodeId: string, sessionId: string, browser: WebSocket): void {
  const c = conns.get(nodeId);
  if (!c) { try { browser.close(CLOSE_NODE_OFFLINE, "node-offline"); } catch { /* noop */ } return; }
  const chan = c.nextChan++;
  c.chans.set(chan, { browser, opened: false });
  const cleanup = (notifyNode: boolean): void => {
    if (!c.chans.has(chan)) return;
    c.chans.delete(chan);
    if (notifyNode) { try { c.ws.send(JSON.stringify({ t: "close", chan } satisfies GwToNodeMsg)); } catch { /* noop */ } }
  };
  browser.on("message", (raw) => {
    let m: Record<string, unknown>;
    try { m = JSON.parse(String(raw)) as Record<string, unknown>; } catch { return; }
    try { c.ws.send(JSON.stringify({ t: "ctl", chan, m } satisfies GwToNodeMsg)); } catch { /* 노드 끊김 — close 에서 정리 */ }
  });
  browser.on("close", () => cleanup(true));
  browser.on("error", () => cleanup(true));
  try { c.ws.send(JSON.stringify({ t: "open", chan, session: sessionId } satisfies GwToNodeMsg)); }
  catch { cleanup(false); try { browser.close(CLOSE_NODE_OFFLINE, "node-offline"); } catch { /* noop */ } }
}

function applyState(nodeId: string, sessions: SessionInfo[]): NodeState {
  const c = conns.get(nodeId);
  const prev = states.get(nodeId);
  const st: NodeState = {
    ts: Date.now(), sessions,
    name: c?.node.name ?? prev?.name ?? nodeId,
    kind: c?.node.kind ?? prev?.kind ?? "member",
    owner: c?.node.owner_member ?? prev?.owner ?? "",
  };
  states.set(nodeId, st);
  return st;
}

function onNodeMessage(c: NodeConn, raw: unknown, isBinary: boolean): void {
  if (isBinary) {
    // 노드 → 브라우저 PTY 데이터. 페어된 브라우저가 없으면(이미 닫힘) 조용히 버린다.
    const f = decodeChanFrame(raw as Buffer);
    if (!f) return;
    const pair = c.chans.get(f.chan);
    if (!pair) return;
    try { pair.browser.send(f.payload); } catch { /* 브라우저 끊김 — close 이벤트가 정리 */ }
    return;
  }
  const m = parseMsg<NodeToGwMsg>(raw);
  if (!m) return;
  if (m.t === "res") {
    const p = c.pending.get(m.id);
    if (!p) return;
    c.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.data);
    else p.reject(new Error(m.error || "node-op-failed"));
    return;
  }
  if (m.t === "state") {
    applyState(c.node.id, Array.isArray(m.sessions) ? m.sessions : []);
    const now = Date.now();
    if (now - c.lastTouch > TOUCH_MIN_MS) { c.lastTouch = now; void touchNode(c.node.id).catch(() => { /* 비치명 */ }); }
    return;
  }
  if (m.t === "opened") {
    const pair = c.chans.get(m.chan);
    if (pair) pair.opened = true;
    return;
  }
  if (m.t === "openfail") {
    const pair = c.chans.get(m.chan);
    c.chans.delete(m.chan);
    if (pair) { try { pair.browser.close(m.code || 4403, m.reason || "no-access"); } catch { /* noop */ } }
    return;
  }
  if (m.t === "close") {
    const pair = c.chans.get(m.chan);
    c.chans.delete(m.chan);
    if (pair) { try { pair.browser.close(); } catch { /* noop */ } }
    return;
  }
}

function onNodeDisconnected(c: NodeConn): void {
  if (conns.get(c.node.id) !== c) return; // 이미 새 연결로 교체됨(재연결 레이스) — 새 연결을 건드리지 않는다
  conns.delete(c.node.id);
  for (const p of c.pending.values()) { clearTimeout(p.timer); p.reject(new Error("node-offline")); }
  c.pending.clear();
  for (const { browser } of c.chans.values()) { try { browser.close(CLOSE_NODE_OFFLINE, "node-offline"); } catch { /* noop */ } }
  c.chans.clear();
  void touchNode(c.node.id).catch(() => { /* 비치명 */ });
  logger.info({ node: c.node.id }, "노드 연결 해제");
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

// /node/ws 업그레이드 — Authorization: Bearer <노드토큰> 을 org_node 매칭으로 검증(스코프 불요·표면 최소).
//  같은 노드가 재연결하면 구 연결을 교체한다(반쯤 열린 구 소켓이 새 연결을 가리지 않게).
export function setupNodeUpgrade(server: Server): void {
  startHeartbeat();
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try { url = new URL(req.url || "", "http://localhost"); } catch { return; }
    if (url.pathname !== NODE_WS_PATH) return; // 다른 업그레이드(/terminal/ws)는 미관여
    void (async () => {
      const auth = String(req.headers.authorization || "");
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      const node = await authNodeToken(token);
      if (!node) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const prev = conns.get(node.id);
        if (prev) { logger.info({ node: node.id }, "노드 재연결 — 구 연결 교체"); try { prev.ws.terminate(); } catch { /* noop */ } onNodeDisconnected(prev); }
        const c: NodeConn = { node, ws: ws as LiveWS, nextReq: 1, pending: new Map(), nextChan: 1, chans: new Map(), lastTouch: Date.now() };
        conns.set(node.id, c);
        (ws as LiveWS).isAlive = true;
        ws.on("pong", () => { (ws as LiveWS).isAlive = true; });
        ws.on("message", (raw, isBinary) => onNodeMessage(c, raw, isBinary));
        ws.on("close", () => onNodeDisconnected(c));
        ws.on("error", () => onNodeDisconnected(c));
        void touchNode(node.id).catch(() => { /* 비치명 */ });
        logger.info({ node: node.id, kind: node.kind, owner: node.owner_member }, "노드 연결");
      });
    })();
  });
  logger.info(`node registry mounted (ws ${NODE_WS_PATH})`);
}

// 노드 WSS liveness(#687 동일 패턴) — pong 없는 연결을 terminate → close 경로가 정리를 돌린다.
function startHeartbeat(): void {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    for (const c of conns.values()) {
      if (c.ws.isAlive === false) { try { c.ws.terminate(); } catch { /* noop */ } continue; }
      c.ws.isAlive = false;
      try { c.ws.ping(); } catch { /* noop */ }
    }
  }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();
}
