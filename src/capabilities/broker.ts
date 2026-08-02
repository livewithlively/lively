// per-member 브로커 실행 표면(#746 T4) — 멤버가 자기 브로커 프로세스(전용 uid·격리)에서 D-도구(git·kubectl·terraform)를 실행.
//  routeToBroker: 첫 호출에 브로커 자동 기동(lazy, 명시적 트리거 불요) → 화이트리스트 도구 실행 → 결과 반환.
//  ② 인프라(install-isolation + provision-member)가 있어야 실동작. 없으면 spawn 실패 → 명확한 오류(fail-safe).
import { z } from "zod";
import { fileURLToPath } from "node:url";
import type { Capability } from "./types.js";
import { HttpError } from "./rest-util.js";
import { routeToBroker, defaultBrokerSpawner } from "../broker/route.js";

// 브로커 진입 js — 배포 앱경로(APP_DIR/dist/broker/index.js, world-readable → broker_<slug> 가독). env 우선.
const BROKER_ENTRY = process.env.LIVELY_BROKER_ENTRY || fileURLToPath(new URL("../broker/index.js", import.meta.url));
// ⚠ 보안 모델(리뷰#1): 화이트리스트 도구라도 arg 로 임의실행 가능(git -c·kubectl --kubeconfig·terraform local-exec) →
//  브로커는 '자기 uid 에 대한 샌드박스가 아니다'. 그래서 (1) 도구는 기본 비움(운영자가 LIVELY_BROKER_ALLOWED_TOOLS 로 opt-in),
//  (2) 브로커엔 '그 멤버 본인 자격'만 둔다(org/상승 자격 금지 — 멤버가 자기 것 접근은 위반 아님), (3) 크로스-멤버는 per-broker 토큰 차단.
const DEFAULT_TOOLS = (process.env.LIVELY_BROKER_ALLOWED_TOOLS || "").split(",").map((s) => s.trim()).filter(Boolean);
// slug — provision-member.sh / terminal-sessions.userSlug 와 동일 규칙(불변식). 게이트웨이가 파생하는 osUser 와 일치해야.
const memberSlug = (id: string): string => id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "user";

const brokerRun: Capability = {
  name: "broker_run", title: "브로커에서 도구 실행(session-exec)",
  description: "내 per-member 브로커(전용 uid·격리)에서 화이트리스트 도구(git·kubectl·terraform·helm·aws)를 실행한다. 로컬 파일/state 본질 작업(D-어댑터)용. 첫 호출 시 브로커가 자동 기동된다. 자격은 브로커 프로세스에만 있어 타 구성원·본인 대화 uid 가 열람 불가.",
  scope: "code",
  input: {
    tool: z.string().describe("실행 도구(git·kubectl·terraform·helm·aws 등 화이트리스트)"),
    args: z.array(z.string()).optional().describe("도구 인자(배열 — 셸 미경유)"),
    cwd: z.string().optional().describe("workroot 하위 상대경로(선택)"),
  },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/me/broker/run"], parse: (req) => req.body ?? {} }] },
  handler: async (input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const i = (input ?? {}) as Record<string, unknown>;
    const tool = String(i.tool || "").trim();
    if (!tool) throw new HttpError(400, "tool 은 필수입니다");
    const slug = memberSlug(user.userId);
    const spawner = defaultBrokerSpawner({ entry: BROKER_ENTRY, allowedTools: DEFAULT_TOOLS });
    try {
      const r = await routeToBroker(slug, { op: "exec", tool, args: Array.isArray(i.args) ? i.args.map(String) : [], cwd: i.cwd ? String(i.cwd) : undefined }, spawner);
      return { ok: r.ok === true, stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? null, error: r.error };
    } catch (e) {
      throw new HttpError(502, `브로커 라우팅 실패(격리 인프라 미설치이거나 브로커 기동 실패): ${(e as Error).message}`);
    }
  },
};

export const brokerCapabilities: Capability[] = [brokerRun];
