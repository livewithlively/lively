// #1641 지식 저장 필수 필드 — "무엇이 빠졌는지"를 **한 번에** 판정하는 단일 자리(순수함수, DB 불요).
//  판정을 authoring.ts 핸들러에 인라인하지 않은 이유는 테스트다: 그 파일은 DB 풀·인입 게이트·리비전 스토어를
//  딸고 오므로, 인라인하면 이 판정의 단위테스트가 DB 를 요구하게 된다(knowledge-store.test.ts 와 같은 규약 — DB 불요).
//
//  ⚠ 이 판정은 store(upsertKnowledge)의 같은 검증을 **대체하지 않는다 — 앞당길 뿐이다.**
//   store 는 시드·마이그레이션·리비전 적용·undo 가 함께 쓰는 공용 경로라 최후 방어선으로 남는다(이중검증이 정상).
//   그런데도 capability 층에 이걸 두는 이유는 **신규 여부(gate.isCreate)를 아는 첫 지점**이라서다:
//   store 까지 내려가면 category 에서 먼저 throw 되어 type 누락은 **다음 호출**에서야 드러난다 — 그 왕복이 표적이다.
//
//  실측 근거(고객사 도입 첫 40일 MCP 로그 10,050콜 · knowledge_save 실패 234건 — 지식
//   customer-usage-first-40days-mcp-log-2026-08):
//   · 첫 시도 실패의 누락 조합: category+type 104 · type 단독 83 · body_md+category+type 19 · category 11 · body_md 7
//   · 즉 **123건이 2개 이상 동시 누락**인데 서버는 하나씩만 알려줬다 → 재시도 체인 121회(낭비 225콜).
//   · 그 체인의 대표형이 'category → type' 69건 = category 를 고쳐 보내니 type 이 튀어나온 두 번째 왕복이다.
//   · 반면 **오타(미존재 category key)는 0건** — 호출자는 key 를 이미 안다. 그래서 이 메시지의 key 목록은
//     오타 교정용이 아니라 "무엇을 고르면 되는지"를 그 자리에서 끝내는 용도다(에러 직후 category_list 조회는 3건뿐이었다).
//
//  명시적 비범위 — **자동 추론을 하지 않는다.** 서버가 category·type 을 짐작해 채우지 않는다:
//   미분류는 눈에 보이지만 오분류는 안 보인다. 거부는 그대로 두고 **왕복만 줄인다.**

// page-type(#290) 유효값 — 메시지·판정의 단일 출처. zod enum(authoring.ts)과 같은 집합이어야 한다.
export const KNOWLEDGE_TYPES = ["decision", "concept", "how-to", "reference", "research", "entity"] as const;

// 에러 메시지에 나열할 category key 최대 개수 — 조직이 커져도 메시지가 폭주하지 않게.
//  (고객사 실측 20개라 현실에선 전부 나열된다. 넘으면 나머지는 category_list 로 안내.)
//  export 는 테스트가 **경계**(정확히 이 개수 / +1개)를 이 값에 기대어 확인하기 위함 — 상수를 바꿔도
//  경계 검증이 따라오도록(값 자체가 아니라 자르기·나머지셈의 오프바이원을 잠근다).
export const CATEGORY_KEYS_SHOWN = 30;

export interface RequiredFieldInput {
  body_md?: string;
  category?: string;
  type?: string;
  title?: string;
  is_folder?: boolean;
  mode?: string;
}

export interface MissingField {
  field: "body_md" | "category" | "type" | "title";
  hint: string;
}

// 이 저장에 빠진 필수 필드 전부. **순차 throw 금지** — 호출부는 이 배열을 통째로 한 번에 알린다.
//  isCreate = 신규 저장인가(capability 는 gate.isCreate, store 는 !before — 같은 판정).
//  ⚠ mode='edit' 는 애초에 이 판정을 타지 않는다(본문을 서버가 edits 로 만들고, 기존 지식 전용이라
//   category·type 도 불요). 호출부에서 걸러 들어온다.
export function missingRequiredFields(input: RequiredFieldInput, isCreate: boolean): MissingField[] {
  const missing: MissingField[] = [];
  // 폴더(#592)는 본문 없는 트리 노드 — body_md 면제. 대신 title 이 유일한 표시명이라 신규 폴더엔 필수.
  const isFolder = input.is_folder === true;
  if (!isFolder && !String(input.body_md ?? "").trim()) {
    missing.push({
      field: "body_md",
      hint: input.mode === "append"
        ? "기존 본문 끝에 덧붙일 조각(mode='append' 는 전문이 아니라 조각을 보낸다)"
        : "본문 전문(폴더 is_folder=true 만 빈 본문 허용)",
    });
  }
  // category·type 은 **신규 저장에만** 필수 — 기존 지식 편집은 생략 시 기존값 보존(#290, resolveUpsertFacets).
  if (isCreate) {
    if (!String(input.category ?? "").trim()) {
      missing.push({ field: "category", hint: "분류 key 1개(단일 — 교차주제는 복수태깅이 아니라 knowledge_link 로 잇는다)" });
    }
    if (!String(input.type ?? "").trim()) {
      missing.push({ field: "type", hint: `${KNOWLEDGE_TYPES.join("|")} 중 하나` });
    }
    if (isFolder && !String(input.title ?? "").trim()) {
      missing.push({ field: "title", hint: "폴더의 표시명(is_folder=true 는 본문이 없어 title 이 유일한 이름)" });
    }
  }
  return missing;
}

// 누락 전부를 한 통으로 담은 에러 문구. categoryKeys 는 호출부가 조회해 넘긴다(이 함수는 순수 — DB 불요).
//  문구의 목적은 **다음 호출을 마지막 호출로 만드는 것**이다: 남은 누락을 감추지 않고, 고른 값을 그 자리에서 확정시킨다.
export function requiredFieldsMessage(
  missing: MissingField[],
  isCreate: boolean,
  categoryKeys?: string[],
): string {
  const what = isCreate ? "신규 지식 저장" : "저장";
  const lines = missing.map((m) => {
    if (m.field === "category" && categoryKeys?.length) {
      const shown = categoryKeys.slice(0, CATEGORY_KEYS_SHOWN);
      const rest = categoryKeys.length - shown.length;
      const tail = rest > 0 ? ` … 외 ${rest}개(전체는 category_list)` : "";
      return `· category — ${m.hint}. 사용 가능한 key: ${shown.join(", ")}${tail}`;
    }
    return `· ${m.field} — ${m.hint}`;
  });
  return `${what}에 필요한 필드 ${missing.length}개가 빠졌습니다 — 아래를 **한 번에 모두** 채워 다시 보내세요`
    + `(하나씩 고쳐 재시도할 필요 없습니다. 서버가 짐작해 채우지 않습니다).\n${lines.join("\n")}`;
}
