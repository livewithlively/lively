// 증류기의 레인 두 종류(#4194) — 자료 레인 · 카테고리 붙이기 레인. 이 파일은 **순수 판정**만 한다(DB 무의존).
//
//  증류기는 «지식을 완성시킨다»(완성 = 본문·유형·카테고리가 다 있는 상태 — upsertKnowledge 가 새 지식에 강제하는
//  바로 그 불변식). 두 레인이 그 일을 입력별로 나눠 맡는다:
//   · source    — 자료(source)를 읽어 지식을 새로 쓴다. 저장소 org_distiller.
//   · knowledge — 카테고리 행이 0건인 지식(노션 같은 지식 직행 미러·시드·카테고리 삭제·휴지통 복원·검토 반려로 생긴다)에
//                 카테고리를 제안한다. 본문은 건드리지 않는다. 저장소 org_classifier(옛 이름 «분류기» — 롤백·컨트롤플레인
//                 호환 때문에 테이블·크론 액션 이름은 그대로 둔다. 까닭은 org/schema/connectors-ingest.ts 의 그 테이블 주석).
//
//  ⚠ 두 레인은 **id·key 공간이 다르다** — 매니지드 테넌트는 자료 레인 "default" 와 카테고리 붙이기 레인 "default" 를 둘 다
//   가진다(컨트롤플레인 프로비저너가 둘 다 심는다). 그래서 쓰기 op 도 둘로 갈랐다(자료 레인 org_distiller_* ·
//   카테고리 붙이기 레인 org_distiller_category_*). 한 op 에 갈래 파라미터를 얹으면 그 파라미터를 모르는 옛 코어가
//   요청을 자료 레인에 적용한다(delivery/classifiers.ts 머리말 — #4194 적대검증).
//  ⚠ 종류에 안 맞는 필드는 **거부한다**(조용히 무시하지 않는다) — 무시하면 호출자는 «저장됐다» 를 보고, 실제로는
//   아무 일도 안 일어난 설정을 믿게 된다(카테고리 붙이기 레인에 include_channels 를 넣고 채널이 좁혀졌다고 믿는 식).

export type LaneInput = "source" | "knowledge";

/** 자료 레인에만 뜻이 있는 필드 — 자료의 종류·채널·작성자·사전필터와, 새로 쓰는 지식의 형식. */
export const SOURCE_ONLY_FIELDS: readonly string[] = [
  "match_kinds", "match_system", "include_channels", "exclude_channels", "include_authors", "exclude_authors",
  "exclude_bots", "format_md", "target_category", "default_type", "name_prefix", "thread_aware",
  "prefilter_level", "prefilter_rules", "prompt_sections", "batch_max_msgs",
];

/** 카테고리 붙이기 레인에만 뜻이 있는 필드 — 지식의 유형·출처·이름과, 제안의 후보·확정 문턱. */
export const KNOWLEDGE_ONLY_FIELDS: readonly string[] = [
  "target", "confidence_below", "match_types", "match_provenance", "match_systems", "exclude_names",
  "candidate_categories", "confirm_threshold",
];

/**
 * 이 카테고리 붙이기 레인이 **실제로 일하는가** — 켜져 있고, 폐지된 재분류 모드(target=low_confidence)가 아니다.
 *  크론의 접수 대상·커버리지·파이프라인의 «켜진 수» 가 **이 한 판정**을 쓴다(#4194 적대검증). 폐지 레인을 «켜짐» 으로 세면
 *  그 레인만 켜진 조직에서 기본 기준 폴백(레인이 하나도 없을 때 도는 전역 경로)이 영영 안 돈다 — 인박스가 빈 레인이
 *  자리만 차지하고 미분류 지식은 아무도 안 본다.
 */
export function isActiveLane(l: { enabled: boolean; target?: string | null }): boolean {
  return l.enabled === true && l.target !== "low_confidence";
}

/**
 * 레인별 헤드리스 배치의 중첩 방지 표식 — 레인마다 따로(`cron:<잡>#<레인 key>`).
 *  하나로 두면(종전 `cron:<잡>`) 앞 레인의 배치가 도는 동안 뒤 레인은 전부 «이전 실행 아직 진행 중» 으로 건너뛰어
 *  레인들이 병렬이 아니라 한 줄로 선다 — 자료 레인(distill.ts)·관리기(manage.ts)가 이미 이 모양이다.
 */
export function laneMarker(jobId: string, key: string): string {
  return "cron:" + jobId + "#" + key;
}

/**
 * 이 레인 종류에 안 맞는 필드가 **값과 함께** 왔는지 — 왔으면 그 이름들을 담아 던진다.
 *  undefined 는 «안 보냄»이라 통과시킨다(부분 저장). null·빈 배열도 «비움» 이라 통과 — 값을 **주려는** 시도만 막는다.
 *  ⚠ 자료 레인 화면은 저장할 때 자기 필드 전부를 되보낸다(settable) — 그 목록에 이 파일의 KNOWLEDGE_ONLY 가 섞이면
 *   여기서 막혀 저장 자체가 안 된다. 그게 의도다(어느 쪽 필드인지 코드가 한 번은 정해야 한다).
 */
export function assertLaneFields(input: Record<string, unknown>, kind: LaneInput): void {
  const foreign = kind === "source" ? KNOWLEDGE_ONLY_FIELDS : SOURCE_ONLY_FIELDS;
  const given = foreign.filter((f) => carriesValue(input[f]));
  //  target 은 카테고리 붙이기 레인 필드지만 'unmapped'(기본값) 만 뜻이 있다 — 재분류 모드(low_confidence·both)는
  //   폐지했다(org/store/classifiers.ts scopeWhere). 새로 그 값을 **설정**하려는 시도는 이유와 함께 거부한다.
  if (kind === "knowledge" && carriesValue(input.target) && String(input.target) !== "unmapped") {
    throw new Error(`target='${String(input.target)}' 는 폐지됐습니다 — 카테고리 붙이기 레인은 미분류 지식(카테고리가 없는 지식)만 맡습니다. ` +
      "이미 붙은 카테고리를 고치는 일은 이 레인이 하지 않습니다 — 점검(분류 어긋남 보정)을 켜거나 사람이 옮기세요.");
  }
  //  confidence_below 는 그 폐지된 재분류 모드의 문턱이다 — 받아 주면 아무 효과 없는 설정을 «저장됐다» 로 믿게 된다.
  if (kind === "knowledge" && carriesValue(input.confidence_below)) {
    throw new Error("confidence_below 는 폐지된 재분류 모드의 설정입니다 — 이미 붙은 카테고리를 고치는 일은 이 레인이 하지 않습니다(점검의 분류 어긋남 보정 또는 사람).");
  }
  if (!given.length) return;
  const what = kind === "source" ? "자료 레인" : "카테고리 붙이기 레인";
  const other = kind === "source" ? "카테고리 붙이기 레인(input='knowledge')" : "자료 레인(input='source')";
  throw new Error(`${what}에는 없는 설정입니다: ${given.join(", ")} — ${other}의 설정이거나 오타입니다.`);
}

/** 값이 실려 있나 — 부분 저장(undefined)·비움(null·''·[]·{})은 «안 줌» 으로 본다. */
function carriesValue(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length > 0;
  return true;
}
