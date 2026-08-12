// delivery ▸ canary — 상류 회귀 자동탐지 조회·실행 (#1657).
//
//  ⚠ 이건 **라이블리 인프라에서 도는 장치**다(고객사 게이트웨이 아님) — 카나리 자격을 고객이 들면 안 되고,
//   신호는 고객 수만큼이 아니라 함대 단위로 하나여야 한다. 고객 박스에서도 이 표면은 존재하지만 프로브가
//   가리키는 커넥터가 없으면 그냥 '미적용'으로 뜬다(무해).
//  실행 주체(어느 멤버 자격으로 도나)는 호출자가 정한다 — 크론이면 그 크론의 실행 멤버.
import type { Capability, CapabilityCtx } from "../types.js";
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import { CANARY_PROBES, assertProbeCoverage } from "../../org/canary/probes.js";
import { runCanary, canaryStatus, FAIL_THRESHOLD } from "../../org/canary/run.js";
import { restOnly, str } from "./shared.js";

export const canaryCapabilities: Capability[] = [
  restOnly("org_canary_status", "상류 회귀 탐지 현황",
    "카나리 프로브별 현재 상태(ok · failing · unknown)와 마지막 실패 사유. " +
    "state=failing 은 연속 " + FAIL_THRESHOLD + "회 이상 실패했다는 뜻이다(일시적 오류로 사람을 깨우지 않으려는 임계). " +
    "tier=plain 은 고객과 같은 구성, privileged 는 우리만 가진 구성 — 둘을 함께 봐야 '우리만 되는 고장'이 보인다.",
    [{ method: "GET", paths: ["/api/ui/org/canary"], parse: () => ({}) }],
    async () => ({ threshold: FAIL_THRESHOLD, probes: await canaryStatus() })),

  restOnly("org_canary_run", "상류 회귀 탐지 실행",
    "카나리를 지금 1회전 돌린다(크론이 부르는 것과 같은 경로). 프로브는 **실제 어댑터 경로를 그대로** 타므로 " +
    "호출자의 자격으로 상류에 실제 요청이 나간다 — 라이블리 카나리 계정으로 부르는 것이 전제다. " +
    "keys 를 주면 그 프로브만. 상태가 바뀌는 프로브가 있으면 경보 채널로 알림이 나간다.",
    [{ method: "POST", paths: ["/api/ui/org/canary/run"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser, _ctx?: CapabilityCtx) => {
      if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
      const raw = input.keys;
      const keys = Array.isArray(raw) ? raw.map((k) => str(k, "keys[]", 100).trim()).filter(Boolean) : [];
      const unknown = keys.filter((k) => !CANARY_PROBES.some((p) => p.key === k));
      if (unknown.length) throw new HttpError(400, `그런 프로브가 없습니다: ${unknown.join(", ")}`);
      return await runCanary({ callerId: user.userId, keys });
    }, {
      keys: z.array(z.string()).optional().describe("돌릴 프로브 key 목록(비우면 전부)"),
    }),

  restOnly("org_canary_probes", "카나리 프로브 정의",
    "코드에 정의된 프로브 목록(무엇을 어떻게 단언하는지). 정의는 데이터가 아니라 코드에 있다 — 프로브는 " +
    "'상류가 이렇게 답해야 한다'는 우리 계약의 표현이라 코드 리뷰를 거쳐야 하고, 박스마다 달라지면 " +
    "함대 단위 신호라는 전제가 깨진다.",
    [{ method: "GET", paths: ["/api/ui/org/canary/probes"], parse: () => ({}) }],
    async () => {
      assertProbeCoverage(); // 구성 등급 커버리지가 깨졌으면 조회 단계에서 드러나게(조용히 눈멀지 않게)
      return {
        probes: CANARY_PROBES.map((p) => ({
          key: p.key, label: p.label, adapter: p.adapter, tier: p.tier, target: p.target, why: p.why, expect: p.expect,
        })),
      };
    }),
];
