// 공유 전환 판정 — shareChangeVerdict 사양 진리표 (#4004). 행 번호(S1…S13)는 사양 엣지 표와 1:1.
//
// 이 파일이 대체하는 것: #1558 은 이 라우트를 **해제 전용**으로 두고 그 규칙을 «입력만 보는 판정»으로
//  못박았다(body.shared 가 truthy 면 노드를 조회하기도 전에 400). #4004 에서 «자기 컴퓨터는 주인이 직접
//  공유로 켠다» 가 되면서 판정에 **노드의 주인**이 필요해졌다 — 더 이상 입력만으로 결정되지 않으므로
//  «DB 조회 전에 끝난다» 는 계약 자체가 성립하지 않는다. 그래서 판정을 순수 함수로 내리고 여기서 표로 못박는다.
//
// 이건 #1558 이 경계한 «() => false 를 검사하는 공허한 테스트» 가 아니다 — 축이 셋(주인 일치 · 관리자 ·
//  원하는 값)이고 급소가 그 조합 안에 살아 있다: **S3 = 관리자가 남의 노드를 공유로 올리는 것**(종전 금지).
//  그리고 **S1 = 주인 본인의 켜기**(이번에 연 자리). 둘이 한 표 안에 같이 있어야 한 쪽으로 쏠린 구현이 걸린다.
//
// 라우트 계층에서 여기 남는 것은 **경로 배선**뿐이다 — 유닛 계층은 실 DB 를 안 쓰는데(scripts/run-tests.mjs)
//  이 라우트는 이제 주인을 알아야 해서 DB 를 먼저 탄다. 라우트가 이 술어를 실제로 부르는지는 배포 뒤 실측으로 본다.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { registerNodeRoutes } from "./routes.js";
import { shareChangeVerdict, type NodeAccessFacts, type ShareChangeVerdict } from "./node-access.js";
import type { BearerVerifier } from "../auth/bearer.js";

let pass = 0;
const ok = (n: string): void => { pass++; console.log(`ok  ${n}`); };

const ME = "bob";
const OTHER = "alice";
const node = (owner: NodeAccessFacts["owner_member"], shared?: boolean | null): NodeAccessFacts =>
  ({ owner_member: owner, shared });

// 기대값 표기 — 허용이면 **저장될 값**까지 본다(켜기를 끄기로 바꿔 저장하는 구현도 걸리도록).
const got = (v: ShareChangeVerdict): string => (v.ok ? `허용:${v.shared}` : String(v.status));

// ── 진리표: 주인 일치 × 관리자 × 원하는 값 ──
{
  const rows: Array<[string, NodeAccessFacts, string, boolean, boolean, string]> = [
    //  label                                                  node                    requester admin  want   기대
    ["S1 주인 본인 · 비관리자 · 켜기 → 허용(#4004 이 연 자리)",   node(ME, false),        ME,       false, true,  "허용:true"],
    ["S2 주인 본인 · 관리자 · 켜기 → 허용",                      node(ME, false),        ME,       true,  true,  "허용:true"],
    ["S3 🔴 관리자 · 남의 노드 · 켜기 → 400(#1558 금지 유지)",    node(OTHER, false),     ME,       true,  true,  "400"],
    ["S4 비관리자 · 남의 노드 · 켜기 → 403(규칙을 알기 전에)",    node(OTHER, false),     ME,       false, true,  "403"],
    ["S5 주인 본인 · 끄기 → 허용",                               node(ME, true),         ME,       false, false, "허용:false"],
    ["S6 관리자 · 남의 노드 · 끄기 → 허용(좁히는 방향)",          node(OTHER, true),      ME,       true,  false, "허용:false"],
    ["S7 비관리자 · 남의 노드 · 끄기 → 403",                     node(OTHER, true),      ME,       false, false, "403"],
    ["S8 주인 미상(null) · 관리자 · 켜기 → 400",                 node(null, false),      ME,       true,  true,  "400"],
    ["S9 주인 미상(null) · 관리자 · 끄기 → 허용",                node(null, true),       ME,       true,  false, "허용:false"],
    ["S10 이미 공유인 내 노드에 또 켜기 → 허용(멱등)",            node(ME, true),         ME,       false, true,  "허용:true"],
    ["S12 내 노드 · shared 미기록(구 스키마 행) · 켜기 → 허용",   node(ME, undefined),    ME,       false, true,  "허용:true"],
    ["S13 남의 노드 · shared 미기록 · 관리자 · 끄기 → 허용(멱등)", node(OTHER, undefined), ME,       true,  false, "허용:false"],
  ];
  for (const [label, n, requester, admin, want, expect] of rows) {
    assert.equal(got(shareChangeVerdict(n, requester, admin, want)), expect, label);
  }
  ok(`공유 전환 진리표 ${rows.length}칸`);

  // 배선 단언 — 한쪽으로 쏠린 구현(전부 허용·전부 거부)이 표를 그냥 통과하지 못하게, 세 갈래가 **모두** 관측돼야 한다.
  //  관측 장치가 죽으면 표는 통과하면서 아무것도 안 본다.
  const seen = new Set(rows.map(([, n, r, a, w]) => got(shareChangeVerdict(n, r, a, w)).split(":")[0]));
  for (const kind of ["허용", "400", "403"]) {
    assert.ok(seen.has(kind), `관측 장치 확인 — ${kind} 갈래가 표에서 실제로 관측돼야 한다(seen=${[...seen].join(",")})`);
  }
  ok("세 갈래(허용·400·403) 전부 관측 — 공허한 통과 방지");
}

// ── S11 신원 없음 → fail-closed. 주인도 빈 값이면 '우연한 일치'로 내 노드가 되는 자리가 생긴다. 거기서 열리면 안 된다.
{
  for (const owner of ["", null, undefined] as const) {
    for (const want of [true, false]) {
      assert.equal(got(shareChangeVerdict(node(owner, false), "", true, want)), "403",
        `S11 신원 없음 + 주인 ${String(owner) || "빈 문자열"}(원하는 값=${want}) → 우연한 일치로 열려선 안 된다`);
    }
  }
  ok("S11 요청자 신원 없음 → fail-closed(빈 값끼리의 우연한 일치 포함)");
}

// ── 라우트 배선 — 이 경로가 실제로 등록돼 있나(없는 동작이면 404). 판정 자체는 위 표가 본다.
interface Resp { status: number; body: string }

function post(port: number, path: string, body: unknown): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1", port, method: "POST", path,
      headers: { authorization: "Bearer x", "content-type": "application/json", "content-length": String(payload.length) },
    }, (res) => {
      let data = ""; res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    const to = setTimeout(() => req.destroy(new Error("client-timeout")), 3000);
    req.on("close", () => clearTimeout(to));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function listen(app: express.Express): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() }));
  });
}

// scopes 만 바꿔 끼우는 가짜 검증기(DB 무접촉) — 실제 sessionOrBearer→requireBearerAuth 경로를 그대로 태운다.
const verifierWith = (scopes: string[]): BearerVerifier => ({
  verifyAccessToken: async () => ({
    token: "x", clientId: "u1", scopes,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    extra: { userId: "u1", email: "u1@example.com", scopes },
  }),
}) as unknown as BearerVerifier;

{
  const app = express();
  app.use(express.json({ limit: "1mb" }));   // 프로덕션 index.ts 와 같은 순서(전역 json 파서 먼저)
  registerNodeRoutes(app, verifierWith(["admin"]));
  const { port, close } = await listen(app);
  try {
    const r = await post(port, "/api/ui/nodes/nonexistent-node/no-such-action", { shared: true });
    assert.equal(r.status, 404, `배선 확인 — 없는 동작은 404 여야 한다(got ${r.status})`);
    ok("배선 확인 — 라우터가 :id/<동작>을 아무거나 받지 않는다");
  } finally { close(); }
}

console.log(`\n${pass} passed`);
