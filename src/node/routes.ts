// 분산 노드(#869) — REST(/api/ui/nodes*). 노드 등록·토큰 회전·활성/비활성·삭제 + 현황.
// 등록에 관리자 수동 승인은 없다(§8-7 ⑵ — 토큰 보유=신뢰). 대신:
//  - member 노드: 본인 것만 만들 수 있다(owner=본인 고정 — 남의 PC 를 자기 노드로 등록 불가).
//  - worker 노드: admin 만(조직 공용 실행기라 관리 표면).
// 평문 토큰은 생성/회전 응답 1회만 반환(저장은 해시). 응답에 설치 한 줄을 같이 준다.
import type express from "express";
import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { sessionOrBearer } from "../auth/http-auth.js";
import type { BearerVerifier } from "../auth/bearer.js";
import type { LivelyUser } from "../context.js";
import { wrap, HttpError } from "../capabilities/rest-util.js";
import { getOrgProfile } from "../org/store.js";
import { createNode, deleteNode, getNode, listNodes, rotateNodeToken, setNodeEnabled, type OrgNode } from "./store.js";
import { liveNodes } from "./registry.js";
import { agentIsLatest } from "./protocol.js";
import { logger } from "../log.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."); // dist/node/ → 리포 루트

const userOf = (req: express.Request): LivelyUser => (req.auth?.extra ?? {}) as unknown as LivelyUser;
const idOf = (u: LivelyUser): string => u.userId || u.email || "";
const isAdmin = (u: LivelyUser): boolean => !!u.scopes?.includes("admin");

async function gatewayUrlHint(req: express.Request): Promise<string> {
  const p = await getOrgProfile().catch(() => null);
  if (p?.gateway_url) return p.gateway_url.replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host") ?? "localhost:8080"}`;
}

function installHint(_gw: string, _token: string, id: string): string {
  // 정본(단일 번들 상시화): `lively` 설치 + `lively login`(멤버 인증) 후 이 PC 를 노드로 상시 연결.
  //  `lively node` 는 멤버 로그인으로 self-register(게이트웨이 주소는 ~/.lively/gateway-url) 하므로,
  //  응답의 노드 토큰(token)은 구 deploy/node/install.sh(헤드리스 토큰 주입) 경로에서만 쓴다.
  return `lively node --daemon --id ${id}`;
}

// 게이트웨이가 **지금 서빙하는** 에이전트 번들의 지문(#905 C4) — 노드가 hello 로 보내는 agentVer 와 같은 계산.
//  키트 kit-version 과 같은 모델("서빙하는 바이트가 곧 버전"). 노드가 그 값을 그대로 보내면 최신, 다르면 구버전이다.
//  캐시: 이 파일은 배포 때만 바뀌는데 노드 목록은 관리탭이 자주 조회한다.
const AGENT_BUNDLE = path.join(REPO_ROOT, "dist", "node-agent", "agent.mjs");
const AGENT_VER_TTL_MS = 60_000;
let servedAgentVer: { v: string | null; at: number } | null = null;
function servedAgentVersion(): string | null {
  if (servedAgentVer && Date.now() - servedAgentVer.at < AGENT_VER_TTL_MS) return servedAgentVer.v;
  let v: string | null = null;
  try { v = createHash("sha256").update(readFileSync(AGENT_BUNDLE)).digest("hex").slice(0, 12); }
  catch { v = null; }   // 번들 미빌드 → 모름. 모르면 최신 여부를 **판정하지 않는다**(아래 agent_latest=null).
  servedAgentVer = { v, at: Date.now() };
  return v;
}

//  agent_latest 3상(true/false/null)의 근거는 protocol.agentIsLatest 참조 — 거기서 검증한다.
interface NodeView extends Omit<OrgNode, "token_hash"> {
  online: boolean; sessions: number; agent_latest: boolean | null; agent_ver_latest: string | null;
}
function toView(n: OrgNode, live: Map<string, { online: boolean; sessions: number }>): NodeView {
  const { token_hash: _hash, ...rest } = n; // 토큰 해시는 응답에 싣지 않는다(상관추적은 토큰탭에서)
  const lv = live.get(n.id);
  const served = servedAgentVersion();
  return {
    ...rest, online: lv?.online ?? false, sessions: lv?.sessions ?? 0,
    agent_ver_latest: served,
    agent_latest: agentIsLatest(n.agent_ver, served),
  };
}

export function registerNodeRoutes(app: express.Express, verifier: BearerVerifier): void {
  const auth = sessionOrBearer(verifier);

  // 목록 — 본인 소유(admin 은 전체). 라이브 연결 상태를 DB 행에 얹는다.
  app.get("/api/ui/nodes", auth, wrap(async (req, res) => {
    const u = userOf(req);
    const me = idOf(u);
    const live = new Map(liveNodes().map((n) => [n.id, { online: n.online, sessions: n.sessions }]));
    const rows = (await listNodes()).filter((n) => isAdmin(u) || n.owner_member === me);
    res.setHeader("Cache-Control", "no-store");
    res.json({ nodes: rows.map((n) => toView(n, live)) });
  }));

  // 등록 — member=본인, worker=admin. 평문 토큰은 이 응답 1회.
  app.post("/api/ui/nodes", auth, wrap(async (req, res) => {
    const u = userOf(req);
    const me = idOf(u);
    if (!me) throw new HttpError(403, "사용자 신원이 없습니다");
    const b = (req.body ?? {}) as Record<string, unknown>;
    const kind = b.kind === "worker" ? "worker" : "member";
    if (kind === "worker" && !isAdmin(u)) throw new HttpError(403, "worker 노드 등록은 admin 권한이 필요합니다");
    const { node, token } = await createNode(
      { id: String(b.id ?? b.name ?? ""), name: String(b.name ?? b.id ?? ""), kind, owner: me },
      me,
    );
    const gw = await gatewayUrlHint(req);
    logger.info({ node: node.id, kind, owner: me }, "노드 등록");
    res.setHeader("Cache-Control", "no-store");
    res.json({ node: toView(node, new Map()), token, install: installHint(gw, token, node.id) });
  }));

  const requireOwn = async (req: express.Request): Promise<OrgNode> => {
    const n = await getNode(String(req.params.id ?? ""));
    if (!n) throw new HttpError(404, "노드 없음");
    const u = userOf(req);
    if (n.owner_member !== idOf(u) && !isAdmin(u)) throw new HttpError(403, "본인 노드가 아닙니다");
    return n;
  };

  // 토큰 회전 — 구 토큰 revoke + 새 토큰 1회 반환(재설치/유출 대응).
  app.post("/api/ui/nodes/:id/rotate", auth, wrap(async (req, res) => {
    const n = await requireOwn(req);
    const { node, token } = await rotateNodeToken(n.id, idOf(userOf(req)));
    const gw = await gatewayUrlHint(req);
    res.setHeader("Cache-Control", "no-store");
    res.json({ node: toView(node, new Map()), token, install: installHint(gw, token, node.id) });
  }));

  // 활성/비활성 — 비활성은 즉시 연결 차단(authNodeToken 이 enabled 를 본다 — 다음 재연결부터. 현 연결은 heartbeat 로 소멸).
  app.post("/api/ui/nodes/:id/enable", auth, wrap(async (req, res) => {
    const n = await requireOwn(req);
    const enabled = !!((req.body ?? {}) as Record<string, unknown>).enabled;
    await setNodeEnabled(n.id, enabled);
    res.json({ ok: true, id: n.id, enabled });
  }));

  app.delete("/api/ui/nodes/:id", auth, wrap(async (req, res) => {
    const n = await requireOwn(req);
    const r = await deleteNode(n.id, idOf(userOf(req)));
    logger.info({ node: n.id }, "노드 삭제(토큰 회수)");
    res.json(r);
  }));

  // 노드 에이전트 번들 배달(#869) — `lively node` 가 받아 실행. agent.mjs(단일 esbuild 번들) + node-pty(네이티브,
  //  external 이라 실행환경에 필요). 인증된 멤버면 받는다(코드일 뿐 비밀 없음 — /install 과 동일 성격). tar.gz 스트림.
  app.get("/api/ui/node-agent", auth, wrap(async (req, res) => {
    if (!idOf(userOf(req))) throw new HttpError(403, "사용자 신원이 없습니다");
    // 버전 판정(servedAgentVersion)과 **같은 파일**이어야 한다 — 서빙본과 해시 대상이 갈리면 판정이 거짓이 된다.
    if (!existsSync(AGENT_BUNDLE)) throw new HttpError(503, "노드 에이전트 번들이 아직 빌드되지 않았습니다(npm run build).");
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", 'attachment; filename="node-agent.tgz"');
    // dist/node-agent/agent.mjs → agent.mjs · node_modules/node-pty → node_modules/node-pty (전 플랫폼 prebuild 동봉)
    const tar = spawn("tar", [
      "-czf", "-",
      "-C", path.dirname(AGENT_BUNDLE), path.basename(AGENT_BUNDLE),
      "-C", REPO_ROOT, "node_modules/node-pty",
    ], { stdio: ["ignore", "pipe", "ignore"] });
    tar.stdout.pipe(res);
    tar.on("error", () => { if (!res.headersSent) res.status(500).end(); });
    res.on("close", () => { try { tar.kill(); } catch { /* noop */ } });
  }));
}
