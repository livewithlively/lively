// V4-P4 (P4-ingest) — 인입 LLM 분류 게이트 + 무키 기계폴백.
//
//   설계(context-os-v4-plan H/E): 기계 채널(커넥터·코드스캔·운영)도 kind/area에 **판단**이 필요하다.
//   런타임 인입 시 `ANTHROPIC_API_KEY` 가 있으면 LLM 분류(kind R/K/H/W + area 제안), 없으면 **현 기계 폴백**
//   (external-identity 의 KIND_MAP/kindForSource) **그대로**.
//
//   🔒 철칙(byte-identical): 키가 없으면 라이브 동작이 오늘과 100% 동일해야 한다.
//     · 무키 경로는 즉시 `{ kind: kindForSource(source), area: null, provenance: 'observed', classifiedBy: 'mechanical' }`
//       를 반환 — knowledge-mirror 가 종전에 kind 를 정하던 방식(KIND_MAP[`${type}:${system}`])과 정확히 동일.
//     · 현재 .env 에 ANTHROPIC_API_KEY 가 없으므로(이 경로는 휴면), 키 경로는 한 줄도 실행되지 않는다.
//     · 미러는 항상 observed(수집물 출처 사실) — provenance 는 채널이 기계로 박는다. classifyIngest 의 무키 반환
//       provenance 도 'observed' 로 고정(미러 계약 유지). 키 경로는 area 제안을 위한 ai 라벨만 표기하되,
//       **미러 INSERT 가 confidence='observed' 를 직접 박으므로 라이브 provenance 는 불변**(아래 wiring 노트 참조).
//
//   활성화: CO(context-ontology)/.env 에 ANTHROPIC_API_KEY 추가 → 다음 인입부터 키 경로 자동 진입.
//   새 dependency 없음: 전역 fetch(Node 22) 사용. @anthropic-ai/sdk 미설치.
import { kindForSource } from "./external-identity.js";
import { redactString } from "./redact.js";

// 분류 결과 — knowledge-mirror 가 kind 를 받아 미러 INSERT 에 사용한다.
//  · kind: 'R'|'K'|'H'|'W' 또는 undefined(미정의 source = 미러 skip — 무키 폴백이 KIND_MAP 미정의를 그대로 전달).
//  · area: 제안 도메인/기능 key 또는 null(사람 큐레이션 전 — 키 경로만 채움, 무키는 항상 null).
//  · provenance: 미러 출처 사실 — 항상 'observed'(채널이 기계로 박음, 주입·가치 무관).
//  · classifiedBy: 'mechanical'(무키 폴백/KIND_MAP) | 'ai'(LLM 판단, area=제안 상태).
export interface IngestClassification {
  kind: string | undefined;
  area: string | null;
  provenance: "observed";
  classifiedBy: "mechanical" | "ai";
}

// kind 통제어휘(본질 4종, V4-P2a CHECK narrow 와 정합). LLM 응답 가드.
const VALID_KINDS = new Set(["R", "K", "H", "W"]);

// ── v6 라우팅 — 외부 미러를 어느 v6 엔티티로 적재할지 결정(connector-mirror 가 호출). ──
//  v6 는 kind(R/K/H/W) 컬럼을 폐기하고 외부 작업(구 W ku)을 project(level=task/subtask)로 흡수했으므로,
//  미러는 **소스로 갈라** 적재한다: clickup task → project, notion 등 K류 → knowledge(observed).
//  구 KIND_MAP(kindForSource)의 의미를 **그대로 재사용**(재인코딩 없음 — 단일 source 표): kind 'W'(=작업)이면
//  project, 그 외 정의된 kind(K 등 — 지식/산출물)이면 knowledge, 미정의(undefined = slack 등)이면 null(미러 skip).
//  v6 에 kind 가 없으므로 'W'/'K' 라벨 자체는 미적재 — 라우팅 분기에만 쓴다(task 의 "drop the kind notion" 충족).
export type V6IngestTarget =
  | "project" | "knowledge" | "source"
  | "pm_folder" | "pm_list" | "pm_view" | "pm_comment" | "pm_time"
  | null;
export function routeIngestV6(type: string, system: string): V6IngestTarget {
  // #541 무손실 — PM 계층/부속 엔티티(현재 clickup 만 방출; 타 PM 커넥터도 같은 타입을 쓰면 그대로 라우팅).
  if (type === "space" || type === "folder") return "pm_folder"; // Space=최상위, Folder=하위 — 둘 다 project_folder
  if (type === "list") return "pm_list";
  if (type === "view") return "pm_view";
  if (type === "comment") return "pm_comment";
  if (type === "time") return "pm_time";
  const kind = kindForSource(type, system);
  if (kind === "W") return "project";   // clickup task 등 → project
  if (kind === "K") return "knowledge"; // notion doc 등 정제 문서 → knowledge(observed)
  // KIND_MAP 미정의라도 type 으로 라우팅(#541): message/note=raw 자료(source, distill 대상), doc=정제 문서(knowledge).
  //  이전엔 미정의=null(skip)이라 slack/discord message 가 버려졌다 — 이제 source 로 적재해 distill 이 지식화한다.
  if (type === "message" || type === "note") return "source";
  if (type === "doc") return "knowledge";
  return null; // 그 외 미정의(예: 미지원 task) — skip(보수적).
}

// 무키 기계 폴백 — 현 미러 인입이 kind 를 정하던 방식과 **정확히 동일**(external-identity 중앙 함수).
//  knowledge-mirror.knowledgeKindFor / 종전 KIND_MAP[`${type}:${system}`] 와 byte-identical.
function mechanicalFallback(source: string): IngestClassification {
  return {
    kind: kindForSource(source.includes(":") ? source.split(":")[0] : source,
      source.includes(":") ? source.split(":").slice(1).join(":") : ""),
    area: null,
    provenance: "observed",
    classifiedBy: "mechanical",
  };
}

// fetch 주입 시그니처(테스트 스텁용). 기본은 전역 fetch.
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface ClassifyIngestArgs {
  // 본문/제목 등 분류 근거 텍스트.
  text: string;
  // (type, system) 합성 source — knowledge-mirror 가 `${type}:${system}` 로 넘긴다(KIND_MAP 키와 동형).
  //  무키 폴백은 이 source 를 kindForSource(type, system) 로 그대로 해소(종전 동작 보존).
  source: string;
  // 외부 시스템(clickup/notion 등) — LLM 프롬프트 컨텍스트. 무키 경로는 미사용(폴백은 source 로만 판단).
  externalSystem?: string;
  // 테스트용 fetch 주입(미지정 시 전역 fetch). area 통제어휘(선택).
  fetchImpl?: FetchLike;
  areaVocab?: string[];
  // 키 경로 타임아웃(ms). 기본 8s.
  timeoutMs?: number;
}

// ── 인입 분류: 무키=기계폴백(현 동작 동일), 키=LLM 분류(graceful 폴백). ──
export async function classifyIngest(args: ClassifyIngestArgs): Promise<IngestClassification> {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  // 무키 경로(기본·라이브 현 상태) — 즉시 기계 폴백 반환. byte-identical 보장.
  if (!apiKey) return mechanicalFallback(args.source);

  // ── 키 경로(휴면 — 현 .env 무키) — LLM 분류. 오류/타임아웃 → 기계 폴백으로 graceful. ──
  const doFetch: FetchLike = args.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  try {
    return await llmClassify(apiKey, doFetch, args);
  } catch {
    // API 오류·타임아웃·파싱 실패 — 조용히 기계 폴백(인입은 절대 깨지지 않음).
    return mechanicalFallback(args.source);
  }
}

// LLM 분류 호출 — Anthropic Messages API(tool-use 강제 구조화 출력). 새 dependency 없이 fetch.
async function llmClassify(apiKey: string, doFetch: FetchLike, args: ClassifyIngestArgs): Promise<IngestClassification> {
  // 🔴 외부 API 송신 전 redact 재검증(H1) — 본문 평문 시크릿이 외부로 새지 않게 마스킹 후 트렁케이트(8KB).
  const safeText = redactString(String(args.text ?? "")).slice(0, 8192);
  const areaLine = args.areaVocab && args.areaVocab.length
    ? `area 는 다음 통제어휘 중 하나이거나 null(불확실/전사): ${args.areaVocab.join(", ")}.`
    : `area 는 주제 도메인/기능 key(소문자-하이픈) 또는 null(불확실/전사).`;

  const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), args.timeoutMs ?? 8000) : undefined;
  try {
    const res = await doFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: controller?.signal,
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        tool_choice: { type: "tool", name: "classify" },
        tools: [
          {
            name: "classify",
            description: "수집된 텍스트의 본질 kind(4종)와 주제 area 를 분류한다.",
            input_schema: {
              type: "object",
              properties: {
                kind: {
                  type: "string",
                  enum: ["R", "K", "H", "W"],
                  description: "본질 종류: R=규칙(항상 적용), K=지식(연구·결정·설계·산출물), H=절차/런북, W=과업(태스크·상태·담당).",
                },
                area: {
                  type: ["string", "null"],
                  description: `주제 영역(사람 큐레이션 전 제안). ${areaLine}`,
                },
              },
              required: ["kind", "area"],
            },
          },
        ],
        messages: [
          {
            role: "user",
            content:
              `외부 시스템 '${args.externalSystem ?? "unknown"}' 에서 수집된 항목을 분류하라. ` +
              `kind 는 R/K/H/W 중 하나, area 는 제안 주제 key 또는 null.\n\n---\n${safeText}`,
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}`);
    const data = (await res.json()) as { content?: Array<{ type?: string; name?: string; input?: unknown }> };
    const tool = Array.isArray(data.content)
      ? data.content.find((b) => b && b.type === "tool_use" && b.name === "classify")
      : undefined;
    const input = (tool?.input ?? {}) as { kind?: unknown; area?: unknown };

    // 가드: kind 는 통제어휘(R/K/H/W) 만 — 위반 시 기계 폴백(throw → catch).
    const kind = typeof input.kind === "string" && VALID_KINDS.has(input.kind) ? input.kind : undefined;
    if (!kind) throw new Error("kind out of controlled vocabulary");

    // area: 문자열이면 정규화(소문자·트림), 그 외/공백 → null(제안 없음). 통제어휘 있으면 어휘 밖은 null.
    let area: string | null = null;
    if (typeof input.area === "string") {
      const a = input.area.trim().toLowerCase();
      if (a && a !== "null") {
        area = !args.areaVocab || args.areaVocab.includes(a) ? a : null;
      }
    }

    return { kind, area, provenance: "observed", classifiedBy: "ai" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
