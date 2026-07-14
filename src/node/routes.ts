// 분산 노드(#869) — REST(/api/ui/nodes*). 노드 등록·토큰 회전·활성/비활성·삭제 + 현황.
// 등록에 관리자 수동 승인은 없다(§8-7 ⑵ — 토큰 보유=신뢰). 대신:
//  - member 노드: 본인 것만 만들 수 있다(owner=본인 고정 — 남의 PC 를 자기 노드로 등록 불가).
//  - worker 노드: admin 만(조직 공용 실행기라 관리 표면).
// 평문 토큰은 생성/회전 응답 1회만 반환(저장은 해시). 응답에 설치 한 줄을 같이 준다.
import type express from "express";
import { sessionOrBearer } from "../auth/http-auth.js";
import type { BearerVerifier } from "../auth/bearer.js";
import type { LivelyUser } from "../context.js";
import { wrap, HttpError } from "../capabilities/rest-util.js";
import { getOrgProfile } from "../org/store.js";
import { createNode, deleteNode, getNode, listNodes, rotateNodeToken, setNodeEnabled, type OrgNode } from "./store.js";
import { liveNodes } from "./registry.js";
import { logger } from "../log.js";

const userOf = (req: express.Request): LivelyUser => (req.auth?.extra ?? {}) as unknown as LivelyUser;
const idOf = (u: LivelyUser): string => u.userId || u.email || "";
const isAdmin = (u: LivelyUser): boolean => !!u.scopes?.includes("admin");

async function gatewayUrlHint(req: express.Request): Promise<string> {
  const p = await getOrgProfile().catch(() => null);
  if (p?.gateway_url) return p.gateway_url.replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host") ?? "localhost:8080"}`;
}

function installHint(gw: string, token: string, id: string): string {
  return `bash deploy/node/install.sh --url ${gw} --token ${token} --id ${id}`;
}

interface NodeView extends Omit<OrgNode, "token_hash"> { online: boolean; sessions: number }
function toView(n: OrgNode, live: Map<string, { online: boolean; sessions: number }>): NodeView {
  const { token_hash: _hash, ...rest } = n; // 토큰 해시는 응답에 싣지 않는다(상관추적은 토큰탭에서)
  const lv = live.get(n.id);
  return { ...rest, online: lv?.online ?? false, sessions: lv?.sessions ?? 0 };
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
}
