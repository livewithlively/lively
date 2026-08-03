// 도메인맵 is 부트스트랩 인제스트 — 전체 스캔 payload(code_units·mappings·is-edges)를 store 에 '한 번에' 쓴다.
//
// 왜 이 표면이 필요한가(제품 갭·설계, 지식: domainmap-is-initial-bootstrap-gap-and-scanner):
//  ingest 엔진(core/reconcile)은 지금까지 CLI 전용이라 '에이전트가 is 를 쓸 손'이 없었다 — LLM 은 매핑툴
//  (map_code_unit)로 '이미 존재하는' 유닛만 만질 뿐 유닛을 '만들' 수 없어, 최초 부트스트랩을 프로즈 위키 문서로
//  떨궜다(#606). 이 capability 가 그 손: LLM(또는 웹 관리탭)이 결정론 사실(dm scan → 파일목록)을 읽고
//  '유닛 경계 + 도메인 매핑'을 판단해 만든 payload 를 단일 트랜잭션으로 인제스트한다.
//  건별 map_code_unit N회(유닛 수천 = 토큰낭비) 대신 이 한 콜로 배치. 경계=판단(LLM), 파일=사실(결정론).
//
// 안전(엔진이 강제, 이 표면은 얇게):
//  - insert-only(code_unit/data_entity) + trust-first(자동매핑 confirmed 착지, origin=actor.type).
//  - 비-agent 소유(human/source) 매핑은 절대 덮어쓰지 않음(다르면 op='drift' 기록 후 기존값 보존).
//  - 단일 트랜잭션(withTx): 중도 실패 = 전체 롤백.
//  - actor 는 클라이언트 신뢰 대신 게이트웨이가 스탬프(provenance·감사) — payload.run 의 actor 는 무시/덮어씀.
import { z } from "zod";
import { ingest } from "../domainmap/core/reconcile.js";
import { dmWrite } from "./domainmap-compat.js";
import { makeAudited } from "./audit-log.js";
import type { Capability, CapabilityCtx } from "./types.js";
import { HttpError } from "./rest-util.js";

const audited = makeAudited("domainmap_ingest");
const actorType = (ctx: CapabilityCtx | undefined): "agent" | "human" => (ctx?.source === "mcp" ? "agent" : "human");

// payload 선검증(화이트리스트 정신 — 게이트웨이가 형태를 본다) + actor 서버 스탬프.
function normalizePayload(raw: unknown, actorId: string, aType: "agent" | "human"): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "payload 는 객체여야 합니다");
  const p = raw as Record<string, unknown>;
  const repo = p.repo as { name?: unknown } | undefined;
  if (!repo || typeof repo.name !== "string" || !repo.name.trim()) throw new HttpError(400, "payload.repo.name 필수");
  const hasWork = ["code_units", "mappings", "domains", "data_entities", "debts", "imports"]
    .some((k) => Array.isArray(p[k]) && (p[k] as unknown[]).length > 0);
  if (!hasWork) throw new HttpError(400, "payload 에 code_units/mappings/domains/… 중 최소 하나(비어있지 않게) 필요");
  // 액터 서버 스탬프: payload.run 의 클라이언트 값은 신뢰하지 않는다(스푸핑 방지 + 감사 일관).
  return { ...p, run: { ...((p.run as Record<string, unknown>) ?? {}), actor_type: aType, actor_id: actorId } };
}

const domainmapIngest: Capability = {
  name: "domainmap_ingest",
  title: "도메인맵 is 부트스트랩 인제스트",
  description:
    "전체 스캔 payload 를 도메인맵 is-store 에 한 번에 인제스트한다(최초 부트스트랩용). " +
    "payload = {repo:{name,root_path?,detected_stack?}, run?:{runbook?}, domains?:[{key,name,description?}], " +
    "code_units:[{path,kind?,label?}], mappings?:[{domain_key,target_kind:'code_unit'|'data_entity',target,confidence?}], " +
    "data_entities?:[{kind,name,source?}], imports?:[{from_path,to_path}]}. code_unit.path=파일/디렉터리 경로 " +
    "(유닛 경계는 판단이라 호출자가 정한다), mappings.domain_key=category key. imports 를 주면 is-엣지(category_edge axis='is')도 도출. " +
    "insert-only·trust-first(비-agent 소유 매핑 무클로버, 다르면 drift 기록)·단일 트랜잭션. 반환 {repo,run_id,tally}. " +
    "대량은 건별 map_code_unit 대신 이 한 콜로. actor 는 게이트웨이가 스탬프(payload.run actor 무시).",
  scope: "context",
  input: {
    // ⚠ z.any() 금지 — JSON Schema 로 `{}`(타입 없음)이 되어 MCP 클라이언트가 객체를 유지하지 못하고
    // 문자열로 직렬화해 보낸다("payload 는 객체여야 합니다" 400). 그러면 이 툴의 존재 이유(호스트 셸 없는
    // MCP-전용 세션이 is 에 쓰는 경로, #606)가 무력화된다. object 파라미터는 코드베이스 관례대로
    // z.record(z.unknown()) — cron.params·lists.settings·managers.proposed_action 과 동일.
    payload: z.record(z.unknown()).describe(
      "전체 스캔 payload(위 설명 형태). repo.name 필수 + code_units/mappings/domains 중 최소 하나."),
  },
  expose: {
    mcp: true,
    rest: [{
      method: "POST",
      paths: ["/api/ui/domainmap/ingest"],
      parse: (req) => ({ payload: (req.body ?? {}) }),
    }],
  },
  handler: async (input: { payload: unknown }, user, ctx) => {
    const repoName = ((input.payload as { repo?: { name?: unknown } } | null)?.repo?.name) ?? null;
    return audited("domainmap_ingest", user, ctx, { repo: repoName }, () =>
      dmWrite(() => ingest(normalizePayload(input.payload, user.userId, actorType(ctx)))));
  },
};

export const domainmapIngestCapabilities: Capability[] = [domainmapIngest];
