// 분산 노드(#869) — 게이트웨이측 노드 레지스트리.
// 노드 에이전트가 아웃바운드로 연결(/node/ws, Bearer 노드토큰)하는 단일 WSS 를 받아
//  ① RPC(세션 CRUD 등 타입드 ops — 임의 셸 없음) ② 상태 push 수신(3s 스냅샷)
//  ③ 브라우저 웹터미널 ↔ 노드 attach 채널 릴레이(raw 바이트 무디코드 — terminal-pty 원칙)
// 를 다중화한다. 정책(가시성·소유·초대 검증)은 전부 이쪽(게이트웨이)이 소유한다(F7 정책/실행 분리).
import { WebSocketServer, type WebSocket } from "ws";
import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { logger } from "../log.js";
import { servedAgentVersion } from "./agent-bundle.js";   // #1713 — 노드에게 알려줄 서빙 번들 지문(단일 출처)
import type { SessionInfo } from "../terminal/terminal-sessions.js";
import {
  NODE_WS_PATH, PROTO_VER, decodeChanFrame, parseMsg, nodeSessionVisible, nodeCaps, nodeHarnesses, NODE_BASELINE_OPS, NODE_BASELINE_HARNESSES,
  type NodeToGwMsg, type GwToNodeMsg, type NodeOp, type NodeResources, type TaskDoneMsg,
} from "./protocol.js";
import { authNodeToken, getNode, touchNode, type OrgNode } from "./store.js";
import { loadNodeStates, saveNodeState, sessionsDigest, shouldPersist } from "./node-state-store.js";

// 웹터미널 close 코드 확장(#869) — 로컬 4410(session-gone)/4403(no-access) 체계에 노드 사유를 더한다.
export const CLOSE_NODE_OFFLINE = 4462; // 노드 미연결(꺼짐·절전·네트워크) — 클라는 재시도 유지(일시 상태일 수 있음)

const RPC_TIMEOUT_MS = 15_000;   // create 가 mkdir·워크트리로 수 초 걸릴 수 있어 여유
// 노드 WSS liveness(#687 패턴) — §10 "온오프 즉각 인지": 정상 종료/절전은 close 이벤트로 즉시,
//  반쯤 열린 연결(VPN 절단 등)은 ping 무응답 1주기로 → 오프라인 인지 상한 ≈ 2×10s.
const HEARTBEAT_MS = 10_000;
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
  hasDocker: boolean;
  // 이 노드가 실제로 할 수 있는 op(#905 C4). hello 전에는 **기준선으로 시작한다** — hello 는 연결 직후 오지만
  //  그 사이 도착한 req 를 "미지원"으로 오판해 떨구면 안 되기 때문(구 노드도 기준선은 전부 한다).
  caps: Set<string>;
  harnesses: string[];   // #1713 — 이 노드가 실제로 띄울 수 있는 하네스(hello 보고 · 미보고면 기준선)
}

// 노드 세션 스냅샷 — 노드가 끊겨도 유지해 '오프라인 노드의 세션'을 계속 보여준다.
//  res = 상시 노출 리소스(§10) — 스케줄러의 배치 입력(오프라인이면 후보 제외라 stale 무해).
// ★ #1834 — 이 Map 은 **정본이 아니라 캐시**다. 정본은 DB(org_node_state)이고 부팅 때 hydrateNodeStates 가
//  여기를 채운다. 종전엔 이게 유일한 저장소라 게이트웨이를 재배포할 때마다 노드 세션 목록이 통째로 비었고,
//  노드가 다시 붙을 때까지(최악 33초) 살아 있는 세션이 화면에서 사라졌다 — 그 빈 판을 본 세션 화면이
//  '이 세션은 없어졌다'로 오판해 다른 세션으로 갈아타는 사고까지 났다(web/v2/panes-parts.ts 주석).
//  조회는 계속 이 캐시가 답한다(동기 API 유지 — 목록 API 가 조회마다 DB 를 때리지 않는다).
interface NodeState { ts: number; sessions: SessionInfo[]; name: string; kind: string; owner: string; res: NodeResources | null }

const conns = new Map<string, NodeConn>();
const states = new Map<string, NodeState>();
// 정본에 마지막으로 쓴 것 — 같은 목록을 3초마다 다시 쓰지 않기 위한 기억(node-state-store.shouldPersist).
const persisted = new Map<string, { digest: string; at: number }>();

/**
 * 부팅 hydrate — 정본(org_node_state)에서 캐시를 채운다. **재배포가 목록에 보이지 않게 하는 자리**다.
 *
 * 이미 그 노드가 붙어 상태를 보고했으면 건너뛴다(라이브 보고가 정본보다 신선하다 — 부팅 레이스 안전).
 *  복구한 스냅샷의 ts 는 과거라, 그 노드에 attach 할 때는 nodeCanAttach 가 STATE_STALE_MS 로 걸러 노드에
 *  목록을 다시 물어본다(오래된 근거로 attach 를 통과시키지 않는다).
 */
export async function hydrateNodeStates(): Promise<number> {
  const rows = await loadNodeStates();
  let n = 0;
  for (const r of rows) {
    if (states.has(r.nodeId)) continue;
    states.set(r.nodeId, { ts: r.reportedAt, sessions: r.sessions, name: r.name, kind: r.kind, owner: r.owner, res: r.res });
    persisted.set(r.nodeId, { digest: sessionsDigest(r.sessions), at: r.reportedAt });
    n++;
  }
  logger.info({ nodes: n, sessions: rows.reduce((a, r) => a + r.sessions.length, 0) }, "노드 세션 스냅샷 복구(정본 org_node_state)");
  return n;
}
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

// 이 노드의 에이전트가 게이트웨이 서빙 번들보다 낡았나 — **에러 번역용**(#1541). op 미지원(caps)과 다른 축이다:
//  op 은 있는데(기준선 create 등) 그 구현이 새 규약(sessionDir 등)을 몰라 "허용되지 않은 루트" 류의 낯선 오류를
//  던지는 케이스가 실측됐다. 그때 사용자에게 "노드를 다시 시작하라"는 다음 행동을 줘야 한다(#1713 자가 갱신이
//  그 재시작 한 번으로 영구 부트스트랩된다). 라이브 hello 값 우선, 없으면(오프라인 직후) DB 기억을 본다.
export async function nodeAgentStale(id: string): Promise<boolean> {
  const served = servedAgentVersion();
  if (!served) return false;                                  // 서빙 번들을 모르면 판정하지 않는다(거짓 힌트 금지)
  // hello 가 touchNode 로 DB 에 남긴 값을 본다(라이브 conn 은 agentVer 를 안 들고 있다 — 저장은 DB 한 곳).
  const ver = (await getNode(id).catch(() => undefined))?.agent_ver ?? null;
  return !!ver && ver !== served;
}

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

// 이 세션이 어느 노드의 것인가 — 없으면 null(= 게이트웨이 로컬 세션이거나, 그 노드가 아직 상태를 안 올렸다).
//  주입(#1664)처럼 **세션 id 만 들고 오는 호출자**가 로컬/원격을 가르는 자리다. 스냅샷(3s push) 기준이라
//  방금 만든 세션은 잠깐 안 보일 수 있는데, 그때는 로컬로 폴백해 `has-session` 이 정직하게 실패한다
//  — 못 찾은 걸 '로컬에 있다'고 단정해 엉뚱한 세션에 키를 흘리는 일은 없다(id 가 겹칠 수 없으므로).
export function nodeOfSession(sessionId: string): string | null {
  for (const [id, st] of states) if (st.sessions.some((s) => s.id === sessionId)) return id;
  return null;
}

// 노드 세션이 어느 하네스로 떴나(스냅샷 기준) — 모르면 ''. 노드 세션은 게이트웨이의 desired-state 미러에 없어서
//  (그 세션은 그 컴퓨터가 만든다) 하네스를 여기서만 알 수 있다. 모델·추론강도 바꾸기(#1758)가 '어떤 슬래시 명령을
//  칠까'를 정하려면 하네스가 있어야 한다 — 화면이 보낸 값을 믿지 않는다(남의 하네스 명령을 대신 치게 할 여지를 안 만든다).
export function nodeSessionHarness(nodeId: string, sessionId: string): string {
  return states.get(nodeId)?.sessions.find((s) => s.id === sessionId)?.harness || "";
}

// 이 노드가 op 를 할 수 있나(#905 C4) — hello.caps 가 근거, 안 보낸 구 노드는 v1 기준선.
//  provision-remote.ts(assertNodeUsable 의 requireProvision 게이트)가 배치 전 사전 조회로 쓴다 — 못 할 노드를
//   미리 걸러 사람 말로 안내한다. 강제 게이트는 nodeRpc 가 이미 한다(여긴 사전 조회용).
export function nodeSupports(nodeId: string, op: NodeOp): boolean {
  const c = conns.get(nodeId);
  return !!c && c.caps.has(op);
}

// 타입드 RPC — 노드에 op 실행을 위임하고 결과를 기다린다. 노드 미연결이면 즉시 실패.
export async function nodeRpc<T = unknown>(nodeId: string, op: NodeOp, args?: Record<string, unknown>): Promise<T> {
  const c = conns.get(nodeId);
  if (!c) throw new Error("node-offline");
  // 🔴 미지원 노드엔 **보내지 않는다**(#905 C4). 보내면 구 노드가 `unknown op: <op>` 라는 **문자열**을 돌려주고,
  //  호출자는 그걸 "실패"와 구별하지 못한다 — 기능이 없는 건지 하다 터진 건지 모른 채 재시도·오진이 쌓인다.
  //  여기가 단일 관문이라 모든 호출자가 자동으로 보호된다. 에러코드는 기계가 분기할 수 있게 고정 문자열.
  if (!c.caps.has(op)) throw new Error(`node-unsupported-op:${op}`);
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
  // WS liveness(#687·#869) — 이게 없으면 게이트웨이 heartbeat 가 **살아있는** 노드-릴레이 브라우저도 매 주기 isAlive=false
  //  로 보고 terminate → 30s 마다 재연결·재attach 를 유발한다. 그 churn 이 노드에서 pty 를 반복 spawn/정리하게 만들고,
  //  노드-pty 가 fd 를 완전히 안 닫아(#869 실측: revoked CHR 누적) EMFILE 로 붕괴한다. 브라우저 자동 pong 으로 생존 갱신.
  (browser as { isAlive?: boolean }).isAlive = true;
  browser.on("pong", () => { (browser as { isAlive?: boolean }).isAlive = true; });
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

function applyState(nodeId: string, sessions: SessionInfo[], res?: NodeResources | null): NodeState {
  const c = conns.get(nodeId);
  const prev = states.get(nodeId);
  const st: NodeState = {
    ts: Date.now(), sessions,
    name: c?.node.name ?? prev?.name ?? nodeId,
    kind: c?.node.kind ?? prev?.kind ?? "member",
    owner: c?.node.owner_member ?? prev?.owner ?? "",
    res: res ?? prev?.res ?? null,
  };
  states.set(nodeId, st);
  // 정본(org_node_state)으로 흘려보낸다(#1834) — 이 게이트웨이가 재배포로 죽어도 다음 부팅이 여기서 목록을 되찾는다.
  //  세션 목록이 바뀌었을 때 즉시, 그대로면 최소 간격마다(node-state-store.shouldPersist). 비치명 —
  //  실패하면 기억을 지워 다음 보고(3초 뒤)가 곧바로 다시 시도한다.
  const digest = sessionsDigest(sessions);
  if (shouldPersist(persisted.get(nodeId), digest, st.ts)) {
    persisted.set(nodeId, { digest, at: st.ts });
    void saveNodeState(nodeId, sessions, st.res, st.ts).catch((err) => {
      persisted.delete(nodeId);
      logger.warn({ err, node: nodeId }, "노드 스냅샷 정본 저장 실패(비치명 — 다음 보고에 재시도)");
    });
  }
  return st;
}

// 위탁 태스크 종결 훅(P2) — 스케줄러가 구독(순환 import 회피: registry 는 태스크 로직을 모른다).
let taskDoneHandler: ((nodeId: string, m: TaskDoneMsg) => void) | null = null;
export function onTaskDone(cb: (nodeId: string, m: TaskDoneMsg) => void): void { taskDoneHandler = cb; }

// worker 복구 훅 — registry가 앱/DB 계층을 import하지 않게 단일 콜백으로 역전한다.
// 최신 에이전트 hello가 확정된 뒤 호출돼, 연결 단절 때 fail-closed 정지한 AppInstance worker를 다시 맞춘다.
let nodeReadyHandler: ((nodeId: string) => void | Promise<void>) | null = null;
export function onNodeReady(cb: (nodeId: string) => void | Promise<void>): void { nodeReadyHandler = cb; }

// 스케줄러용 원격 노드 뷰(§10) — 온라인 노드만(오프라인은 후보 자체가 아님).
// 스케줄러가 여기서 얻는 것은 **지금 붙어 있는가 + 그 머신의 리소스**뿐이다(liveness). 소유자·공유·활성 같은
//  정책 필드는 일부러 안 싣는다(#1540) — c.node 는 **연결 시점 스냅샷**이라, 관리자가 공유를 끈 뒤에도 그 노드가
//  재연결하기 전까지 옛 값을 들고 있다. 정책은 스케줄러가 매 tick DB(listNodes)에서 다시 읽는다.
export interface RemoteSchedulable { id: string; hasDocker: boolean; res: NodeResources | null }
export function schedulableRemotes(): RemoteSchedulable[] {
  const out: RemoteSchedulable[] = [];
  for (const [id, c] of conns) {
    const st = states.get(id);
    out.push({ id, hasDocker: c.hasDocker, res: st?.res ?? null });
  }
  return out;
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
    applyState(c.node.id, Array.isArray(m.sessions) ? m.sessions : [], m.res ?? null);
    const now = Date.now();
    if (now - c.lastTouch > TOUCH_MIN_MS) { c.lastTouch = now; void touchNode(c.node.id).catch(() => { /* 비치명 */ }); }
    return;
  }
  if (m.t === "hello") {
    // 🔴 프로토콜 버전 대조(#905 C4) — 여태 안 봤다. 다르면 프레임 해석이 어긋나므로 **붙여두면 안 된다**:
    //  조용히 오동작하느니 끊고 로그를 남긴다(노드는 백오프 재접속하므로, 업데이트되면 알아서 복귀한다).
    if (m.ver !== PROTO_VER) {
      logger.warn({ node: c.node.id, nodeVer: m.ver, gatewayVer: PROTO_VER, agentVer: m.agentVer },
        "노드 프로토콜 버전 불일치 — 연결 거부(노드 에이전트를 업데이트해야 한다)");
      try { c.ws.close(4426, `proto-ver-mismatch:${PROTO_VER}`); } catch { /* noop */ }
      return;
    }
    c.hasDocker = !!m.hasDocker;
    c.caps = nodeCaps(m.caps);   // 미전송(구 노드) → v1 기준선. 기준선 밖 op 는 선언한 노드에만 간다.
    // #1713 — 이 PC 에서 실제로 띄울 수 있는 하네스. 미전송(구 번들) → 기준선(claude·codex·shell)으로 본다.
    //  세션 폼이 이 값으로 선택지를 거른다 — 없는 하네스를 고르고 [생성하기] 뒤에 502 를 보던 것을 사전에 막는다.
    c.harnesses = nodeHarnesses(m.harnesses);
    void touchNode(c.node.id, { platform: m.platform, agentVer: m.agentVer, host: m.host, caps: [...c.caps], harnesses: [...c.harnesses] })
      .catch(() => { /* 비치명 */ });
    // #1713 — "지금 서빙 중인 번들의 지문". 노드가 이걸 받아 자기와 비교해 스스로 갱신한다.
    //  구 노드는 모르는 t 를 무시하므로 안전하다(무회귀).
    try { c.ws.send(JSON.stringify({ t: "helloOk", agentVerLatest: servedAgentVersion() } satisfies GwToNodeMsg)); }
    catch { /* 전송 실패는 비치명 — 다음 재연결에 다시 알린다 */ }
    const latest = servedAgentVersion();
    if (c.caps.has("startWorker") && c.caps.has("stageWorkerChunk") && (!latest || m.agentVer === latest)) {
      void Promise.resolve(nodeReadyHandler?.(c.node.id)).catch((err) =>
        logger.warn({ err, node: c.node.id }, "노드 worker 복구 실패(비치명 — 다음 재연결/조회가 재시도)"));
    }
    return;
  }
  if (m.t === "taskdone") {
    try { taskDoneHandler?.(c.node.id, m); } catch { /* 스케줄러 오류는 태스크 1건에 한정 */ }
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
        // caps 는 **기준선으로 시작**한다 — hello 가 오기 전에도 v1 op 는 보낼 수 있어야 한다(구 노드와 동일 취급).
        //  hello 를 받으면 그 노드가 선언한 실제 목록으로 교체된다.
        const c: NodeConn = {
          node, ws: ws as LiveWS, nextReq: 1, pending: new Map(), nextChan: 1, chans: new Map(),
          lastTouch: Date.now(), hasDocker: false, caps: new Set(NODE_BASELINE_OPS), harnesses: [...NODE_BASELINE_HARNESSES],
        };
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
