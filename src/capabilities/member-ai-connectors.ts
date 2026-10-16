// 구성원 AI 계정 커넥터 표면(#4213 T6 #4427) — «누가 자기 Claude 에 무엇을 연결했나» 보기 · 내 것 새로 확인 · 워크스페이스 정책.
//
//  · 보기는 구성원(context) — 리브의 연결 제안(«팀이 쓰는 앱 중 ○○님 Claude 에 빠진 것»)과 [외부 앱 연결] 현황판(T13)이
//    앱 × 구성원으로 읽는다. 담는 것은 앱 이름 · 상태 · 시각뿐이다(주소·계정 이메일은 재는 자리에서 버린다).
//  · 새로 확인은 **본인 것만**(memory — 같은 자리를 띄우는 collect_claude_run 과 같은 권한)이다 — 그 사람 홈에서 그 사람 Claude CLI 를 돌린다. 남의 것을 재는 길은 열지 않는다
//    (그 사람 계정을 들여다보는 일이라, 그 사람의 수집 실행(T11)이 자기 시작 때 재는 것으로 충분하다).
//  · 정책은 관리자 — 끄면 세션 안내문·claude 세션의 claude.ai 커넥터·구성원 AI 계정 수집이 함께 막힌다(org/store/member-ai-connectors.ts).
import { z } from "zod";
import type { Capability } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http/rest-util.js";
import { listMemberAiConnectors, memberAiConnectorsPolicy, setMemberAiConnectorsAllowed } from "../org/store/member-ai-connectors.js";
import { probeMemberAiConnectors } from "../terminal/member-ai-connector-probe.js";

const listInput = {
  member_id: z.string().max(128).optional().describe("이 구성원만(member_id). 생략하면 기록이 있는 구성원 전부"),
  app: z.string().max(64).optional().describe("이 앱만 — «claude.ai » 뒤 이름(예 Slack · Notion · Gmail · Google Drive). 대소문자 무시"),
  include_removed: z.boolean().optional().describe("끊은 앱(status=removed)도 함께. 기본 false"),
};
type ListInput = z.infer<z.ZodObject<typeof listInput>>;

const memberAiConnectorsList: Capability = {
  name: "member_ai_connectors",
  title: "구성원 Claude 커넥터 보기",
  description:
    "구성원마다 자기 Claude 계정에 연결해 둔 앱(claude.ai 커넥터 — Slack·Notion·Gmail 등)과 상태를 준다(#4213 T6). " +
    "connectors[].status = connected · needs-auth(그 앱 다시 로그인 필요) · failed · pending · unknown · removed(끊음). " +
    "scan = 마지막 확인 — null 이면 아직 확인한 적 없음, ok=false 면 확인은 했지만 목록을 못 얻음" +
    "(error: not-logged-in · not-claude-ai-login · no-cli · timeout · no-capacity …), origin = probe(새로 확인) · collect(수집 실행 시작 때). " +
    "policy.state = allowed · blocked · unknown(정책을 못 읽음 — 집행 자리는 막음으로 본다). blocked 면 이 워크스페이스는 구성원 Claude 커넥터를 쓰지 않는다" +
    "(세션에 claude.ai 커넥터가 안 실리고 그 경로 수집도 안 돈다). " +
    "새로 재려면 본인이 member_ai_connectors_refresh. 비활성 구성원은 빠진다. context 권한(구성원 기본). " +
    "REST 등가: GET /api/ui/member-ai-connectors?member_id=&app=&include_removed=1.",
  scope: "context",
  input: listInput,
  mutates: false,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/member-ai-connectors"], parse: (req) => {
      const q = (req.query ?? {}) as Record<string, unknown>;
      const s = (v: unknown, n: number): string | undefined => (v == null || v === "" ? undefined : String(v).slice(0, n));
      return {
        member_id: s(q.member_id, 128), app: s(q.app, 64),
        include_removed: q.include_removed === "1" || q.include_removed === "true" ? true : undefined,
      };
    } }],
  },
  handler: async (input: ListInput) => {
    const [state, members] = await Promise.all([
      memberAiConnectorsPolicy(),
      listMemberAiConnectors({ memberId: input.member_id, app: input.app, includeRemoved: input.include_removed === true }),
    ]);
    //  state 는 세 갈래(allowed · blocked · unknown=못 읽음). allowed 는 «확인된 허용» 일 때만 true 다(fail-closed).
    return { policy: { allowed: state === "allowed", state }, members };
  },
};

const memberAiConnectorsRefresh: Capability = {
  name: "member_ai_connectors_refresh",
  title: "내 Claude 커넥터 새로 확인",
  description:
    "내 Claude 계정에 연결된 앱을 지금 다시 잰다 — 내 홈에서 공식 CLI(`claude auth status` 다음 `claude mcp list`)를 돌린다" +
    "(매니지드는 내 하네스 자리 컨테이너를 잠깐 띄운다 — 수 초~수십 초). claude.ai 에서 앱을 막 연결했거나 끊었으면 이걸로 반영한다" +
    "(이미 떠 있는 세션에는 새 커넥터가 안 실린다 — 새 세션부터). 본인 것만. " +
    "정책이 꺼져 있으면 재지 않고(skipped:'policy-off' · 못 읽으면 'policy-unknown'), 15초 안에 다시 부르면 방금 값을 준다(skipped:'recent'). " +
    "실패는 오류가 아니라 record.scan.ok=false 와 사유로 돌아온다 — 원래 있던 앱이 한 번에 전부 사라져 보이면 error:'unconfirmed-empty' " +
    "(로그인 풀림과 모양이 같아 한 번 더 확인해야 반영한다). memory 권한(구성원 기본 — 수집 실행과 같은 자리). " +
    "REST 등가: POST /api/ui/me/ai-connectors/refresh.",
  scope: "memory",
  input: {},
  mutates: true,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/me/ai-connectors/refresh"], parse: () => ({}) }],
  },
  handler: async (_input: Record<string, never>, user: LivelyUser) => {
    const r = await probeMemberAiConnectors(user);
    return { ok: true, probed: r.probed, skipped: r.skipped, record: r.record };
  },
};

const policyInput = {
  allowed: z.boolean().describe("true = 쓴다(기본) · false = 막는다"),
};
type PolicyInput = z.infer<z.ZodObject<typeof policyInput>>;

const memberAiConnectorsPolicySet: Capability = {
  name: "member_ai_connectors_policy_set",
  title: "구성원 Claude 커넥터 정책 바꾸기",
  description:
    "이 워크스페이스가 구성원 Claude 커넥터(구성원이 자기 Claude 계정에 연결한 앱)를 쓰나. " +
    "allowed:true(기본) — 세션 안내문이 «같은 서비스면 조직 연결(ext__) 먼저, 라이블리에 없으면 본인 Claude 커넥터 1순위» 다. " +
    "allowed:false — 안내문이 «ext__ 만» 으로 바뀌고, 라이블리가 띄우는 claude 세션에 claude.ai 커넥터를 싣지 않으며, 구성원 AI 계정 수집이 돌지 않는다" +
    "(구성원 자기 PC 의 CLI 에는 안내문만 닿는다). 바꾼 값은 **새 세션부터** 적용된다. 관리자. " +
    "REST 등가: POST /api/ui/member-ai-connectors/policy {allowed}.",
  scope: "admin",
  input: policyInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/member-ai-connectors/policy"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.allowed !== "boolean") throw new HttpError(400, "allowed 는 true 또는 false 여야 합니다");
      return { allowed: b.allowed };
    } }],
  },
  handler: async (input: PolicyInput, user: LivelyUser, ctx) => {
    const changed = await setMemberAiConnectorsAllowed(input.allowed === true, {
      actor: user?.userId || user?.email || "unknown", source: ctx?.source ?? "web",
    });
    const state = await memberAiConnectorsPolicy();
    return { ok: true, changed, policy: { allowed: state === "allowed", state } };
  },
};

export const memberAiConnectorCapabilities: Capability[] = [memberAiConnectorsList, memberAiConnectorsRefresh, memberAiConnectorsPolicySet];
