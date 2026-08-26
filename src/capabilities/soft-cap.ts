// 소프트캡(#1442) — heavy payload 툴의 '짧은 메타 필드' 상한은 하드 리젝트가 아니라 서버 조정이어야 한다.
//
//  문제의 구조: MCP SDK 는 입력 zod 검증을 **핸들러 앞에서** 한다(@modelcontextprotocol/sdk server/mcp.js —
//   validateToolInput → executeToolHandler). 그래서 title 200자 같은 한 필드의 초과가 같은 호출에 실린
//   body_md(최대 200,000자 ≈ 50k 토큰)까지 통째로 무효로 만들고, 호출자는 같은 본문을 다시 실어 재시도한다.
//   게다가 그 실패는 registerTool wrap(server.ts instrument) **앞**에서 터지므로 mcp_call_log 에 흔적이 없다 —
//   사람은 반복 실패를 체감하는데 서버는 모르는 실패다(#1442 계기: 헤비한 지식 저장이 제목 길이로 계속 튕김).
//
//  그 상한엔 데이터 근거도 없었다: knowledge.title 컬럼은 TEXT(무제한)이고 REST 경로는 zod 를 안 타
//   같은 값이 그냥 저장된다(MCP 만 튕기는 비대칭). name 은 더해서, store 의 slugify 가 이미 .slice(0,64) 로
//   자르므로 **데이터 층이 스키마보다 관용적**이었다 — 스키마가 거부한 값을 store 는 받아 정규화할 수 있었다.
//
//  그래서 이 필드들은 zod .max() 를 두지 않는다(= SDK 가 핸들러 앞에서 튕길 근거를 없앤다). 대신 핸들러가
//   이 모듈로 조정하고, 무엇이 어떻게 조정됐는지 응답(capped)에 실어 호출자가 알게 한다. 상한 자체는
//   describe(softCapHint)로 스키마에 광고되므로 하네스는 여전히 사전에 안다 — 예방은 설명이, 안전망은 조정이 한다.
//
//  ⚠ 상한을 없앤다고 무제한이 아니다: express.json({limit:"1mb"})(src/index.ts)이 요청 전체의 방어선이고
//   조정은 그 안에서 일어난다. '폭주 입력 차단'은 전송 층이, '계약 상한'은 이 층이 담당한다.
import { logger } from "../log.js";

/** 이 값 이상을 받는 문자열 필드가 있으면 그 툴은 heavy — 한 필드의 거부가 통째로 재전송을 부른다.
 *  #1442 가드(mcp-input-schema.test.ts R5)가 '어느 툴이 이 정책의 대상인가'를 이 값으로 판정한다. */
export const HEAVY_PAYLOAD_CHARS = 20_000;

/** 상한 초과를 어떻게 다루는가 — 값을 잘라도 뜻이 사는지, 잘린 값이 무의미해지는지로 갈린다. */
export type SoftCapPolicy =
  | "clamp"   // 표시용 텍스트(title·summary·change_note) — 앞부분만 남겨도 뜻이 산다 → 자른다.
  | "drop"    // 소프트 참조(supersedes·parent_name) — 상한을 넘는 이름은 애초에 **존재할 수 없다**(대상 name 이
              //  그보다 짧으므로). 자르면 아무것도 가리키지 않는 참조가 조용히 남으니 참조를 버린다.
  | "note";   // 데이터 층이 이미 정규화하는 값(name → slugify) — 값은 건드리지 않고 사실만 알린다.

export interface SoftCapSpec {
  readonly limit: number;
  readonly policy: SoftCapPolicy;
  /** 초과 시 응답에 그대로 실릴 한 문장 — 호출자는 '무엇이 어떻게 됐는지'를 이걸로 안다. */
  readonly effect: string;
}

export interface SoftCapReport {
  readonly limit: number;
  readonly was: number;
  readonly policy: SoftCapPolicy;
  readonly effect: string;
}

// ── 선언 표(단일 진실원천) ────────────────────────────────────────────────────────────────
//  상한 값이 zod .max() 에 흩어져 있던 것을 여기 모은다 — capability 는 이 표에서 상한을 읽어 describe 를
//  만들고(softCapHint) 핸들러에서 같은 표로 조정한다(applySoftCaps). #1442 가드가 읽는 표도 이것이다.
export const SOFT_CAPS: Readonly<Record<string, Readonly<Record<string, SoftCapSpec>>>> = {
  knowledge_save: {
    // ⚠ 안내는 **실제로 존재하는 싼 경로**를 가리켜야 한다: knowledge_save 는 body_md 가 필수라 "title 만 다시
    //  보내라"가 성립하지 않는다(전문 재전송 = 이 정책이 없애려던 바로 그 낭비). 그래서 knowledge_set_title 을 뒀다.
    title: { limit: 200, policy: "clamp",
      effect: "제목이 상한을 넘어 앞부분만 남기고 잘라 저장했습니다. 제목을 고치려면 knowledge_set_title(name+title)로 갱신하세요 — 본문을 다시 보낼 필요가 없습니다." },
    change_note: { limit: 600, policy: "clamp",
      effect: "변경 요약이 상한을 넘어 잘라 기록했습니다(1~2문장이면 충분합니다)." },
    // note — 값을 여기서 자르지 않는다. 핸들러가 곧바로 slugify 로 정규화·절단하고(store 와 같은 함수) 그
    //  결과가 인입 게이트·공개범위 검사·store 전부에 쓰인다. 이 표의 몫은 '얼마나 길었는지'를 알리는 것뿐이다.
    name: { limit: 64, policy: "note",
      effect: "이름이 상한을 넘어 서버가 슬러그로 줄여 저장했습니다 — 응답 knowledge.name 이 실제 이름입니다(다음 저장·조회엔 그 이름을 쓰세요)." },
    supersedes: { limit: 64, policy: "drop",
      effect: "그 길이의 지식 이름은 존재할 수 없어(이름 상한 64자) 대체 관계를 걸지 않고 저장했습니다 — 필요하면 올바른 이름으로 다시 지정하세요." },
    parent_name: { limit: 64, policy: "drop",
      effect: "그 길이의 지식 이름은 존재할 수 없어(이름 상한 64자) 트리 배치를 생략하고 저장했습니다 — 위치는 knowledge_move 로 지정하세요." },
  },
  // heavy payload 툴이 아니다(본문을 안 받는다) — 그래도 같은 필드의 상한이 툴마다 다른 방식으로 강제되면
  //  혼란스러우므로 knowledge_save.title 과 같은 200자 · 같은 clamp 로 맞춘다(R5a 가 max 되붙기를 막는다).
  knowledge_set_title: {
    title: { limit: 200, policy: "clamp",
      effect: "제목이 상한을 넘어 앞부분만 남기고 잘라 저장했습니다(제목은 한 줄 라벨입니다 — 긴 설명은 본문 첫 헤딩으로)." },
    change_note: { limit: 600, policy: "clamp",
      effect: "변경 요약이 상한을 넘어 잘라 기록했습니다(1~2문장이면 충분합니다)." },
  },
  source_save: {
    title: { limit: 200, policy: "clamp",
      effect: "제목이 상한을 넘어 앞부분만 남기고 잘라 저장했습니다(원문 body_md 는 그대로입니다)." },
    // knowledge 와 달리 clamp 다 — source-store 에는 slugify 가 없어 데이터 층이 값을 정규화하지 않는다(TEXT 컬럼 +
    //  부분 유니크 인덱스). 상한을 아예 없애면 아주 긴 이름이 btree 인덱스 항목 한계에서 INSERT 오류가 되므로
    //  (하드 리젝트보다 나쁜 500) 여기서 자른다. 자료 인용은 name 이 아니라 source_id 로 하므로 절단 피해가 없다.
    name: { limit: 64, policy: "clamp",
      effect: "이름이 상한을 넘어 서버가 잘라 저장했습니다 — 응답 source.name 이 실제 이름입니다(자료 인용은 이름이 아니라 source_id 로 하세요)." },
  },
  activity_log: {
    title: { limit: 500, policy: "clamp",
      effect: "제목이 상한을 넘어 잘라 기록했습니다 — 작업 기록은 얇게 두고 실질 내용은 지식(ku_refs)으로 남기세요." },
    summary: { limit: 120, policy: "clamp",
      effect: "요약 라벨이 상한을 넘어 잘랐습니다 — summary 는 '중분류 - 내용' 형태의 짧은 라벨이고 설명은 title/body 에 씁니다." },
  },
};

// ── 의도적 하드캡 ─────────────────────────────────────────────────────────────────────────
//  기계값(해시·경로·브랜치·ISO 시각·외부 시스템 식별자)은 자르면 뜻이 깨지고, 모델이 임의로 늘려 쓸 일도
//  없다 — 초과는 조정할 값이 아니라 입력 오류라서 거부가 맞다. #1442 가드는 이 목록에 있는 필드를 통과시킨다.
//  ⚠ 여기 넣는 건 "본문 전체가 함께 튕겨도 괜찮다"는 판단이다. 모델이 자연어로 채우는 필드는 넣지 말 것.
export const HARD_CAP_OK: Readonly<Record<string, readonly string[]>> = {
  activity_log: [
    "commit_sha", "committed_at", "repo",                                  // 커밋 좌표 — 형식값
    "author_agent", "session_id",                                          // 게이트웨이가 자동 식별(보통 미전송)
    "external_system", "external_id", "external_url", "external_instance", // PM 미러 좌표 — 잘리면 링크가 깨진다
  ],
  delegate_run: ["subpath", "repo", "ref", "node", "harness"],             // 실행 좌표 — 잘린 경로·브랜치·하네스 키로 돌면 안 된다
};

/**
 * 소프트캡 적용 — 초과 필드를 정책대로 조정하고, 응답에 spread 할 조각을 돌려준다(초과 없으면 `{}`).
 *
 * ⚠ input 을 **제자리에서** 고친다(새 객체를 반환하지 않는다). 두 가지 이유다:
 *  ① 핸들러가 input.<필드>를 읽는 지점이 여럿이라(인입 게이트·리비전 제안·store 호출) 재바인딩하면
 *     한 곳만 놓쳐도 조정 전 값이 그리로 흘러간다. 제자리 조정은 그 누락을 구조적으로 없앤다.
 *  ② 파라미터를 다른 이름으로 재바인딩하면 #923 R2/R3 가드(mcp-input-schema.test.ts)가 핸들러 소스에서
 *     `input.<필드>` 접근을 못 찾아 **조용히 눈을 감는다** — 스키마↔핸들러 정합 검사가 무력화된다.
 *  zod 파싱 결과(및 REST mount.parse 산출)는 이 호출 전용 객체라 제자리 수정이 남에게 보이지 않는다.
 *
 * 조정 사실은 logger 에도 남긴다 — 하드 리젝트였을 때 이 실패가 **어디에도 기록되지 않았던** 게 문제의
 * 절반이었다(SDK 검증은 mcp_call_log 앞에서 터진다). 빈도가 보이면 상한 자체를 재검토할 수 있다.
 */
export function applySoftCaps<T extends object>(
  tool: string,
  input: T,
  specs: Readonly<Record<string, SoftCapSpec>>,
): Record<string, unknown> {
  // 캐스팅은 호출부가 아니라 여기서 한 번만 — 핸들러들이 자기 입력 타입을 그대로 넘길 수 있게.
  const bag = input as Record<string, unknown>;
  const capped: Record<string, SoftCapReport> = {};
  for (const [field, spec] of Object.entries(specs)) {
    const v = bag[field];
    if (typeof v !== "string" || v.length <= spec.limit) continue;
    capped[field] = { limit: spec.limit, was: v.length, policy: spec.policy, effect: spec.effect };
    if (spec.policy === "clamp") bag[field] = v.slice(0, spec.limit);
    else if (spec.policy === "drop") delete bag[field];
    // note — 값은 그대로 둔다(데이터 층이 정규화한다).
  }
  const fields = Object.keys(capped);
  if (!fields.length) return {};
  logger.info({ tool, capped }, "소프트캡 적용 — 짧은 메타 필드를 조정하고 호출은 그대로 진행");
  return {
    capped,
    capped_note:
      `입력 ${fields.join("·")} 가 상한을 넘어 서버가 조정했습니다 — **호출은 성공했고 본문은 저장됐으니 같은 내용을 다시 보내지 마세요.** ` +
      fields.map((f) => `${f}: ${capped[f].effect}(보낸 값 ${capped[f].was.toLocaleString()}자 / 상한 ${capped[f].limit}자)`).join(" "),
  };
}

/** describe() 에 붙일 상한 안내 — 하네스가 **사전에** 알아 애초에 넘기지 않게 하는 예방선.
 *  (maxLength 만으로는 안 막혔다는 게 #1442 의 실측이라, 자연어로 상한과 초과 시 동작을 함께 적는다.) */
export function softCapHint(spec: SoftCapSpec): string {
  const tail = spec.policy === "clamp"
    ? `넘기면 서버가 ${spec.limit}자로 자른다`
    : spec.policy === "drop"
      ? "넘기면 그 길이의 대상이 존재할 수 없어 이 참조를 무시한다"
      : "넘기면 서버가 슬러그로 줄인다";
  return `⚠ ${spec.limit}자 이내 — ${tail}(호출은 실패하지 않으니 본문을 다시 보내지 마라. 조정하면 응답 capped 로 알린다).`;
}
