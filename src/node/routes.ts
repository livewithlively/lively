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
import { sessionOrBearer } from "../auth/http-auth.js";
import type { BearerVerifier } from "../auth/bearer.js";
import type { LivelyUser } from "../context.js";
import { wrap, HttpError } from "../http/rest-util.js";
import { authNodeTokenDetailed, createNode, deleteNode, getNode, listNodes, revokeNodeToken, rotateNodeToken, setNodeEnabled, setNodeShared, loadRecentLinkEvents, type OrgNode } from "./store.js";
import { diagnoseLink, type LinkDiagnosis, type LinkEvent } from "./sleep-pattern.js";   // #1849 — 링크 이력으로 원인 추정
import { linkDiagMessage, linkDiagSummary, keepAwakeLine, staleAgentNote } from "./link-advice.js";     // #1849 — 그 판정을 사람의 말로 · #2127 낡은 인스턴스
import { nodeOpenTo } from "./node-access.js";
import { liveNodes, isSelfNode, logNodeAuthDenial, looksLikeGatewayBox } from "./registry.js";
import { selfNodeMessage } from "./self-node.js";   // #2592 — «이 노드는 게이트웨이 자신» 을 말하는 문장의 단일 출처
import { nodeHarnesses, agentIsLatest } from "./protocol.js";
import { AGENT_BUNDLE, AGENT_BUNDLE_ROOT, servedAgentVersion, agentBundleExists } from "./agent-bundle.js";
import { logger } from "../log.js";


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

/**
 * #2592 — 요청 본문에서 «내 tmux 세션 id» 프로브를 꺼낸다(등록·프리플라이트 공용).
 *
 * 형식을 여기서 좁히는 이유: 이 값은 곧바로 게이트웨이 자기 세션 목록과 대조되는 재료라, 길이·타입이
 *  통제되지 않으면 큰 배열 하나로 판정 비용을 밀어 넣을 수 있다. 세션 id 형식(box-*)만·상한 200개만 받는다.
 *  없거나 형식 밖이면 빈 배열 = 판정 불가(양성일 때만 참 — sharesGatewayTmux 계약).
 */
function boxProbe(b: Record<string, unknown>): string[] {
  const raw = Array.isArray(b.boxSessions) ? b.boxSessions : [];
  const out: string[] = [];
  for (const v of raw) {
    const id = String(v ?? "").trim();
    if (/^box-[A-Za-z0-9._-]{1,120}$/.test(id)) out.push(id);
    if (out.length >= 200) break;
  }
  return out;
}

// 번들 위치·지문은 node/agent-bundle.ts 단일 출처(#1713 — registry 도 같은 값을 써야 노드에게 알려줄 수 있다).

// 화면이 쓰는 노드 뷰 — DB 행 + 라이브 상태 + **판정**(최신인가·무엇을 띄울 수 있나).
//  agent_latest 3상(true/false/null)의 근거는 protocol.agentIsLatest 참조 — 거기서 검증한다.
interface NodeView extends Omit<OrgNode, "token_hash"> {
  online: boolean; sessions: number; agent_latest: boolean | null; agent_ver_latest: string | null;
  harnesses: string[];   // #1713 — 이 노드에서 열 수 있는 하네스(정규화 — 미보고면 기준선)
  // #1849 — 최근 24시간 연결 이력으로 본 추정 원인(잠자기 등)과 그 근거 수치. 화면은 이걸로
  //  "연결돼 있지 않습니다" 에서 멈추지 않고 **왜 그런지·무엇을 하면 되는지**까지 말한다.
  link_diag: LinkDiagnosis;
  /** 잠자기로 추정될 때 화면에 그대로 띄울 한 문장(근거+조치). 판정이 없으면 null — 모르면 말하지 않는다. */
  link_note: string | null;
  /** 같은 판정의 한 줄 요약 — 목록처럼 폭이 좁은 자리용(전문은 툴팁·오류 메시지에서 쓴다). */
  link_note_short: string | null;
  /** 억제가 걸려 있나를 사람의 말로. 상태가 정상이어도 노드 화면이 "무엇이 안 막히는지"를 알려 준다. */
  keep_awake_note: string;
  /** #2108 — 이 노드가 **게이트웨이 자신이 도는 박스**인가(같은 tmux 를 쓰는 것을 확답으로 관측했을 때만 true). */
  self: boolean;
  /** self 일 때 화면에 그대로 띄울 한 문장(무엇인지 + 어떻게 하면 되는지). 아니면 null. */
  self_note: string | null;
  /**
   * #2127·#2128 — 온라인인데 그 PC 의 노드 프로그램이 **낡은 채로 굳어 있는** 것으로 보이나(근거+조치 한 문장).
   *  아니면 null. 실측에서 이 상태가 며칠간 무신호로 지속돼 하네스 검출이 통째로 실패했다 — 그 침묵을 메우는 자리다.
   */
  stale_note: string | null;
}
function toView(
  n: OrgNode,
  live: Map<string, { online: boolean; sessions: number }>,
  linkEvents?: Map<string, LinkEvent[]>,
  now: number = Date.now(),
): NodeView {
  const { token_hash: _hash, ...rest } = n; // 토큰 해시는 응답에 싣지 않는다(상관추적은 토큰탭에서)
  const lv = live.get(n.id);
  const served = servedAgentVersion();
  const diag = diagnoseLink(linkEvents?.get(n.id) ?? [], now);   // #1849
  return {
    ...rest, online: lv?.online ?? false, sessions: lv?.sessions ?? 0,
    agent_ver_latest: served,
    agent_latest: agentIsLatest(n.agent_ver, served),
    // #1713 — 이 노드에서 열 수 있는 하네스(미보고 = 구 번들 → 기준선). 노드 화면이 그대로 보여준다.
    harnesses: nodeHarnesses(n.agent_harnesses),
    // #1849 — 이력이 없으면(방금 등록·기록 이전) 빈 판정이 나온다. 그건 '정상'이 아니라 '모름'이고,
    //  cycles=0 으로 드러나므로 화면이 억지 결론을 내지 않는다.
    link_diag: diag,
    link_note: linkDiagMessage(diag, { platform: n.platform, keepAwake: n.keep_awake }),
    link_note_short: linkDiagSummary(diag),
    keep_awake_note: keepAwakeLine(n.keep_awake, n.platform),
    stale_note: staleAgentNote({
      online: lv?.online ?? false, keepAwake: n.keep_awake, agentLatest: agentIsLatest(n.agent_ver, served),
    }),
    // #2108 — 이 노드가 게이트웨이 자신인가(같은 tmux 를 쓰는 것을 확답으로 관측). 관리 화면에선 **숨기지 않는다**
    //  — 데몬이 돌고 있다는 사실 자체를 관리자가 봐야 내릴지 말지 정할 수 있다. 다만 세션 생성 대상에선 빠진다.
    self: isSelfNode(n.id),
    //  #2592 — 이제는 «빠진다»가 아니라 **연결 자체를 거부한다**. 배지가 그 사실을 말해야 관리자가
    //   "왜 이 노드는 계속 오프라인인가" 를 헤매지 않는다.
    self_note: isSelfNode(n.id)
      ? `${selfNodeMessage()} 그래서 이 노드의 연결은 거부되고 있습니다(세션은 '중앙 컴퓨터(기본)' 로 정상 동작합니다).`
      : null,
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
    // #1849 — 전 노드 24시간 이력을 **한 번에** 읽는다(노드마다 왕복하면 그게 곧 목록 지연이 된다).
    //  실패해도 목록은 나와야 한다 — 진단은 부가 정보지 목록의 전제가 아니다.
    const linkEvents = await loadRecentLinkEvents().catch(() => new Map<string, LinkEvent[]>());
    // 두 목록은 **질문이 다르다**: usable=1 은 "이 노드를 쓸 수 있나"(게이트와 동일한 술어여야 한다), 기본은
    //  "내가 관리하는 노드"(admin 은 전체 — 토글·회전·삭제 대상). 그래서 usable 에는 admin 예외를 얹지 않는다:
    //  얹으면 관리자에게 남의 비공유 노드가 선택지로 보이고, 고르면 게이트가 403 을 던진다(목록≠게이트).
    const rows = (await listNodes()).filter((n) => usable
      ? (n.enabled && nodeOpenTo(n, me))
      : (isAdmin(u) || n.owner_member === me));
    res.setHeader("Cache-Control", "no-store");
    res.json({ nodes: rows.map((n) => toView(n, live, linkEvents)) });
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
    // #2592 — **게이트웨이가 도는 그 박스는 노드로 등록되지 않는다.** 등록되면 그 순간부터 같은 tmux 가
    //  두 경로(중앙 즉답 / 노드 3초 스냅샷+릴레이)로 잡혀 접속·목록·발견 기록이 전부 샌다(#2108 은 «그 노드로
    //  새로 만들기»만 막았다). 판정 근거는 등록하는 쪽이 실어 보낸 자기 tmux 세션 id 와의 겹침 — #2108 과
    //  **같은 술어**라 오탐이 없고(원격 PC 의 세션 id 가 이 박스 tmux 에 있을 수 없다), 겹친 id 는 응답에 안 싣는다.
    if (await looksLikeGatewayBox(boxProbe(b))) throw new HttpError(409, selfNodeMessage());
    if (b.shared && !isAdmin(u)) throw new HttpError(403, "공유 노드 지정은 admin 권한이 필요합니다");
    const { node, token } = await createNode(
      { id: String(b.id ?? b.name ?? ""), name: String(b.name ?? b.id ?? ""), kind, owner: me, shared: !!b.shared },
      me,
    );
    logger.info({ node: node.id, kind, owner: me, shared: !!b.shared }, "노드 등록");
    res.setHeader("Cache-Control", "no-store");
    res.json({ node: toView(node, new Map()), token, install: installHint(node.id) });
  }));

  // 프리플라이트(#2592) — `lively node` 가 **등록을 건너뛰는 실행**(토큰 재사용)에서도 물어본다.
  //  응답은 불리언 하나 + 사람에게 할 말. 겹친 세션 id 는 싣지 않는다(#2108 규율 — 테넌트 간 노출 없음).
  app.post("/api/ui/nodes/self-check", auth, wrap(async (req, res) => {
    const self = await looksLikeGatewayBox(boxProbe((req.body ?? {}) as Record<string, unknown>));
    res.setHeader("Cache-Control", "no-store");
    res.json({ self, note: self ? selfNodeMessage() : null });
  }));

  const requireOwn = async (req: express.Request): Promise<OrgNode> => {
    const n = await getNode(String(req.params.id ?? ""));
    if (!n) throw new HttpError(404, "노드 없음");
    const u = userOf(req);
    if (n.owner_member !== idOf(u) && !isAdmin(u)) throw new HttpError(403, "본인 노드가 아닙니다");
    return n;
  };

  // 토큰 회수(#2215) — **등록은 남기고 접속만 끊는다.** `lively logout` 이 부른다: 로그아웃했는데 그 PC 가
  //  옛 테넌트에 계속 붙어 있는 구멍을 막는 자리다. 회전(rotate)과 다르다 — 새 토큰을 주지 않는다.
  app.post("/api/ui/nodes/:id/revoke-token", auth, wrap(async (req, res) => {
    const n = await requireOwn(req);
    const r = await revokeNodeToken(n.id, idOf(userOf(req)));
    logger.info({ node: n.id, actor: idOf(userOf(req)), revoked: r.revoked, outcome: r.outcome }, "노드 토큰 회수");
    res.setHeader("Cache-Control", "no-store");
    res.json(r);
  }));

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

  // 공유 **해제** 전용(#1558) — admin 전용. ⚠ 이 라우트로 공유를 **켤 수는 없다**.
  //
  //  왜 승격을 없앴나: 종전엔 admin 이 아무 노드나 `shared:true` 로 올릴 수 있었다. 그러면 구성원이 붙여 둔
  //  **개인 노트북이 어느 날 조직 공용이 되는** 경로가 열려 있고, 그걸 하려면 관리 화면이 남의 개인 컴퓨터
  //  목록을 늘어놔야 한다(프라이버시). 공유 컴퓨터는 처음부터 그 목적으로 등록하는 것이지, 남의 것을 끌어
  //  올리는 게 아니다 → **공유는 등록 시점(POST /api/ui/nodes {shared:true})에만 켠다.**
  //  해제는 남긴다 — 좁히는 방향이라 안전하고, 잘못 등록한 것을 지우지 않고 되돌릴 수 있어야 한다.
  //  다시 공유로 만들려면 지우고 공유용으로 새로 등록한다(그 편이 감사에도 한 줄로 남는다).
  app.post("/api/ui/nodes/:id/share", auth, wrap(async (req, res) => {
    const u = userOf(req);
    if (!isAdmin(u)) throw new HttpError(403, "공유 해제는 admin 권한이 필요합니다");
    // 승격 차단은 **DB 조회보다 먼저** 본다 — 입력만으로 결정되는 규칙이고(노드가 뭐든 답은 같다), 그래야
    //  이 계약을 DB 없이 테스트할 수 있다(share-promotion-gate.test.ts).
    if (((req.body ?? {}) as Record<string, unknown>).shared) {
      throw new HttpError(400, "이미 등록된 컴퓨터를 공유로 올릴 수는 없습니다 — 공유 컴퓨터는 등록할 때 지정합니다(관리 ▸ 컴퓨터(노드) ▸ 공유 컴퓨터 등록).");
    }
    const n = await getNode(String(req.params.id ?? ""));
    if (!n) throw new HttpError(404, "노드 없음");
    await setNodeShared(n.id, false);
    logger.info({ node: n.id, by: idOf(u) }, "노드 공유 해제");
    res.json({ ok: true, id: n.id, shared: false });
  }));

  app.delete("/api/ui/nodes/:id", auth, wrap(async (req, res) => {
    const n = await requireOwn(req);
    const r = await deleteNode(n.id, idOf(userOf(req)));
    logger.info({ node: n.id }, "노드 삭제(토큰 회수)");
    res.json(r);
  }));

  // 자가 갱신용 번들 배달(#1713) — **노드 토큰**으로 받는다. 멤버 인증 경로(/api/ui/node-agent)는 사람이 설치할
  //  때 쓰고, 이건 이미 붙어 있는 노드가 스스로 최신 바이트를 가져갈 때 쓴다. 노드는 멤버 토큰이 없다.
  //  ⚠ 실측(#1713): launchd/systemd 는 `lively node` CLI 가 아니라 받아 둔 agent.mjs 를 **직접** 실행한다 →
  //   재시작해도 pull 이 없어 노드가 영원히 옛 번들로 돈다(라이브 4대 전부). 그래서 이 경로가 필요하다.
  //  내용은 코드일 뿐 비밀이 없다(멤버 경로와 같은 tar) — 노드 토큰 보유자에게 주는 데 위험이 없다.
  app.get("/node/agent-bundle", wrap(async (req, res) => {
    const raw = String(req.headers.authorization ?? "");
    const tok = raw.startsWith("Bearer ") ? raw.slice(7).trim() : "";
    // 자가갱신 경로라 여기서 막히면 노드가 **영원히 옛 번들로 돈다**(#1713) — 사유를 로그에 남긴다(#2161).
    //  응답 본문에는 사유를 싣지 않는다: 인증을 통과하지 못한 요청자에게 라벨·노드 id 를 알려 줄 이유가 없다.
    const outcome = await authNodeTokenDetailed(tok);
    if (!outcome.ok) {
      logNodeAuthDenial(outcome, null);
      throw new HttpError(403, "노드 토큰이 유효하지 않습니다");
    }
    if (!agentBundleExists()) throw new HttpError(503, "노드 에이전트 번들이 아직 빌드되지 않았습니다(npm run build).");
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("X-Agent-Ver", servedAgentVersion() ?? "");   // 노드가 받은 바이트를 대조할 기준
    const tar = spawn("tar", ["-czf", "-",
      "-C", path.dirname(AGENT_BUNDLE), path.basename(AGENT_BUNDLE),
      "-C", AGENT_BUNDLE_ROOT, "node_modules/node-pty",
    ], { stdio: ["ignore", "pipe", "ignore"] });
    tar.stdout.pipe(res);
    tar.on("error", () => { if (!res.headersSent) res.status(500).end(); });
  }));

  // 노드 에이전트 번들 배달(#869) — `lively node` 가 받아 실행. agent.mjs(단일 esbuild 번들) + node-pty(네이티브,
  //  external 이라 실행환경에 필요). 인증된 멤버면 받는다(코드일 뿐 비밀 없음 — /install 과 동일 성격). tar.gz 스트림.
  app.get("/api/ui/node-agent", auth, wrap(async (req, res) => {
    if (!idOf(userOf(req))) throw new HttpError(403, "사용자 신원이 없습니다");
    // 버전 판정(servedAgentVersion)과 **같은 파일**이어야 한다 — 서빙본과 해시 대상이 갈리면 판정이 거짓이 된다.
    if (!agentBundleExists()) throw new HttpError(503, "노드 에이전트 번들이 아직 빌드되지 않았습니다(npm run build).");
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", 'attachment; filename="node-agent.tgz"');
    // dist/node-agent/agent.mjs → agent.mjs · node_modules/node-pty → node_modules/node-pty (전 플랫폼 prebuild 동봉)
    const tar = spawn("tar", [
      "-czf", "-",
      "-C", path.dirname(AGENT_BUNDLE), path.basename(AGENT_BUNDLE),
      "-C", AGENT_BUNDLE_ROOT, "node_modules/node-pty",
    ], { stdio: ["ignore", "pipe", "ignore"] });
    tar.stdout.pipe(res);
    tar.on("error", () => { if (!res.headersSent) res.status(500).end(); });
    res.on("close", () => { try { tar.kill(); } catch { /* noop */ } });
  }));
}
