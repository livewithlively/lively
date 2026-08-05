// 분산 노드(#869) — REST(/api/ui/nodes*). 노드 등록·토큰 회전·활성/비활성·삭제 + 현황.
// 등록에 관리자 수동 승인은 없다(§8-7 ⑵ — 토큰 보유=신뢰). 대신:
//  - member 노드: 본인 것만 만들 수 있다(owner=본인 고정 — 남의 PC 를 자기 노드로 등록 불가).
//  - worker 노드: admin 만(조직 공용 실행기라 관리 표면).
//  - 공유 지정(shared, #1540): admin 만. 등록은 누구나 해도 **조직 전체에 여는 것은 관리자 결정**이다
//    (소유자 본인도 못 켠다 — 각자 켤 수 있으면 '기본은 본인 것'이 무력해진다).
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
import { wrap, HttpError } from "../http/rest-util.js";
import { createNode, deleteNode, getNode, listNodes, rotateNodeToken, setNodeEnabled, setNodeShared, type OrgNode } from "./store.js";
import { nodeOpenTo } from "./node-access.js";
import { liveNodes } from "./registry.js";
import { agentIsLatest } from "./protocol.js";
import { logger } from "../log.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."); // dist/node/ → 리포 루트

const userOf = (req: express.Request): LivelyUser => (req.auth?.extra ?? {}) as unknown as LivelyUser;
const idOf = (u: LivelyUser): string => u.userId || u.email || "";
const isAdmin = (u: LivelyUser): boolean => !!u.scopes?.includes("admin");

function installHint(id: string): string {
  // 정본(단일 번들 상시화): `lively` 설치 + `lively login`(멤버 인증) 후 이 PC 를 노드로 상시 연결.
  //  `lively node` 는 멤버 로그인으로 self-register(게이트웨이 주소는 ~/.lively/gateway-url) 하므로,
  //  응답의 노드 토큰(token)은 구 deploy/node/install.sh(헤드리스 토큰 주입) 경로에서만 쓴다.
  //  ⚠ 그래서 이 문자열엔 게이트웨이 base 가 안 들어간다 — 종전엔 base 를 구해 넘겼는데 여기서 쓰지 않아
  //   노드 등록·회전마다 org 프로필을 읽고 버리기만 했다(게다가 gateway-url.ts 단일 소스를 우회한 자체
  //   정규화라 '/mcp' 를 못 벗었다). 다시 필요해지면 gatewayUrlForRequest(단일 소스)를 쓸 것 — 여기서
  //   정규화를 재구현하지 말 것.
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
  //  usable=1(#905 C4): 프로젝트 세션을 **열 수 있는** 노드 = 내 노드 ∪ 공유 노드. 판정은 nodeOpenTo 로
  //  provision·세션생성 게이트와 **같은 술어**를 쓴다(#1540) — 목록과 게이트가 갈리면 골랐는데 403 이 나거나
  //  쓸 수 있는데 목록에 없다. 종전 기준은 kind==='worker' 였고, 그래서 '개방을 끄는 손잡이'가 없었다.
  //  기본(관리 목록)은 종전대로 본인 소유만 — 관리 액션(토글·삭제·토큰회전)은 각 라우트가 따로 게이트한다.
  app.get("/api/ui/nodes", auth, wrap(async (req, res) => {
    const u = userOf(req);
    const me = idOf(u);
    const usable = req.query.usable === "1" || req.query.usable === "true";
    const live = new Map(liveNodes().map((n) => [n.id, { online: n.online, sessions: n.sessions }]));
    // 두 목록은 **질문이 다르다**: usable=1 은 "이 노드를 쓸 수 있나"(게이트와 동일한 술어여야 한다), 기본은
    //  "내가 관리하는 노드"(admin 은 전체 — 토글·회전·삭제 대상). 그래서 usable 에는 admin 예외를 얹지 않는다:
    //  얹으면 관리자에게 남의 비공유 노드가 선택지로 보이고, 고르면 게이트가 403 을 던진다(목록≠게이트).
    const rows = (await listNodes()).filter((n) => usable
      ? (n.enabled && nodeOpenTo(n, me))
      : (isAdmin(u) || n.owner_member === me));
    res.setHeader("Cache-Control", "no-store");
    res.json({ nodes: rows.map((n) => toView(n, live)) });
  }));

  // 등록 — member=본인, worker=admin. 평문 토큰은 이 응답 1회.
  //  shared(#1540)는 **admin 만** 등록 시점에 켤 수 있다(그 외엔 항상 비공유로 시작 → 등록한 사람 것).
  app.post("/api/ui/nodes", auth, wrap(async (req, res) => {
    const u = userOf(req);
    const me = idOf(u);
    if (!me) throw new HttpError(403, "사용자 신원이 없습니다");
    const b = (req.body ?? {}) as Record<string, unknown>;
    const kind = b.kind === "worker" ? "worker" : "member";
    if (kind === "worker" && !isAdmin(u)) throw new HttpError(403, "worker 노드 등록은 admin 권한이 필요합니다");
    if (b.shared && !isAdmin(u)) throw new HttpError(403, "공유 노드 지정은 admin 권한이 필요합니다");
    const { node, token } = await createNode(
      { id: String(b.id ?? b.name ?? ""), name: String(b.name ?? b.id ?? ""), kind, owner: me, shared: !!b.shared },
      me,
    );
    logger.info({ node: node.id, kind, owner: me, shared: !!b.shared }, "노드 등록");
    res.setHeader("Cache-Control", "no-store");
    res.json({ node: toView(node, new Map()), token, install: installHint(node.id) });
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
    res.setHeader("Cache-Control", "no-store");
    res.json({ node: toView(node, new Map()), token, install: installHint(node.id) });
  }));

  // 활성/비활성 — 비활성은 즉시 연결 차단(authNodeToken 이 enabled 를 본다 — 다음 재연결부터. 현 연결은 heartbeat 로 소멸).
  app.post("/api/ui/nodes/:id/enable", auth, wrap(async (req, res) => {
    const n = await requireOwn(req);
    const enabled = !!((req.body ?? {}) as Record<string, unknown>).enabled;
    await setNodeEnabled(n.id, enabled);
    res.json({ ok: true, id: n.id, enabled });
  }));

  // 공유 노드 지정/해제(#1540) — **admin 전용**. 소유자 본인도 자기 노드를 조직에 개방할 수 없다:
  //  개방은 조직의 결정(누가 어디서 무엇을 돌리는지)이고, 그걸 각자가 켤 수 있으면 "기본은 본인 것" 이라는
  //  이 정책의 기본값이 사실상 무력해진다. 그래서 requireOwn(소유자 또는 admin)을 쓰지 않는다.
  app.post("/api/ui/nodes/:id/share", auth, wrap(async (req, res) => {
    const u = userOf(req);
    if (!isAdmin(u)) throw new HttpError(403, "공유 노드 지정/해제는 admin 권한이 필요합니다");
    const n = await getNode(String(req.params.id ?? ""));
    if (!n) throw new HttpError(404, "노드 없음");
    const shared = !!((req.body ?? {}) as Record<string, unknown>).shared;
    await setNodeShared(n.id, shared);
    logger.info({ node: n.id, shared, by: idOf(u) }, shared ? "노드 공유 지정" : "노드 공유 해제");
    res.json({ ok: true, id: n.id, shared });
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
