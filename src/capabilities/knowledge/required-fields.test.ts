// #1641 지식 저장 필수 필드 **일괄** 검증 회귀 잠금 — DB 불요(순수함수), node:assert 자급.
//  실행: npm run build && node dist/capabilities/knowledge/required-fields.test.js
//
// 잠그는 정책은 하나다: **빠진 필수 필드는 한 번에 전부 알린다.**
//  종전엔 검증이 세 곳에서 순차로 throw 됐다 — body_md(capability) → category(store) → type(store).
//  각각 별개 예외라 호출자는 한 번에 하나만 듣고, 고쳐 보내면 다음 것을 맞았다.
//  고객사 도입 첫 40일 실측(MCP 로그 10,050콜 · knowledge_save 실패 234건 — 지식
//  customer-usage-first-40days-mcp-log-2026-08)의 누락 조합을 그대로 케이스로 박는다:
//   category+type 104 · type 단독 83 · body_md+category+type 19 · category 11 · body_md 7
//   → 123건이 2개 이상 동시 누락인데 서버가 하나씩만 알려줘 재시도 체인 121회(낭비 225콜)가 생겼다.
//
// 단언 방식: 메시지는 **무엇이 열거됐나**로 본다 — 빠진 필드는 전부 나타나고, 빠지지 않은 필드는
//  나타나지 않는다(감추지도 않고, 없는 걸 요구하지도 않는다). 나열 개수는 **세어서** 확인한다.
import assert from "node:assert/strict";
import {
  missingRequiredFields, requiredFieldsMessage, KNOWLEDGE_TYPES, CATEGORY_KEYS_SHOWN,
} from "./required-fields.js";

let pass = 0;
const t = (name: string, fn: () => void): void => {
  fn();
  pass++;
  console.log(`ok  ${name}`);
};

type Input = Parameters<typeof missingRequiredFields>[0];
const fields = (input: Input, isCreate: boolean): string[] =>
  missingRequiredFields(input, isCreate).map((m) => m.field);
// 메시지 = 판정과 같은 입력에서 나온 것만 본다(둘이 어긋나면 그 자체가 결함).
const message = (input: Input, isCreate: boolean, keys?: string[]): string =>
  requiredFieldsMessage(missingRequiredFields(input, isCreate), isCreate, keys);
// 부분문자열 충돌 없는 key(3자리 고정) — 나열 개수를 셀 때 cat-001 ⊂ cat-0010 같은 오판을 막는다.
const keyList = (n: number): string[] => Array.from({ length: n }, (_, i) => `cat-${String(i).padStart(3, "0")}`);

// ── 표 1~5: 신규 저장. 동시 누락은 **한 번에** 나와야 한다(구 동작은 하나 알리고 끝냈다). ──
t("1) 신규·분류/유형 누락(실측 최다 104건) → 둘을 한 번에", () => {
  assert.deepEqual(fields({ body_md: "본문" }, true), ["category", "type"]);
});
t("2) 신규·셋 다 누락(19건) → 셋을 한 번에", () => {
  assert.deepEqual(fields({}, true), ["body_md", "category", "type"]);
});
t("3) 신규·유형만 누락(83건 — 종전 두 번째 왕복의 정체)", () => {
  assert.deepEqual(fields({ body_md: "본문", category: "gtm" }, true), ["type"]);
});
t("4) 신규·분류만 누락(11건)", () => {
  assert.deepEqual(fields({ body_md: "본문", type: "research" }, true), ["category"]);
});
t("5) 신규·셋 다 채움 → 누락 없음(첫 시도 성공)", () => {
  assert.deepEqual(fields({ body_md: "본문", category: "gtm", type: "research" }, true), []);
});

// ── 표 6~7: 기존 편집(#290). 생략은 "기존값 보존"이라는 정상 의도다. ──
t("6) 기존 편집·분류/유형 미전송 → 누락 아님(기존값 보존)", () => {
  assert.deepEqual(fields({ body_md: "고친 본문" }, false), []);
});
t("7) 기존 편집·빈 본문 → 본문만(7건)", () => {
  assert.deepEqual(fields({}, false), ["body_md"]);
});

// ── 표 8: 공백뿐인 값은 없는 값이다. ──
t("8) 공백뿐인 값은 없는 값으로 본다", () => {
  assert.deepEqual(fields({ body_md: "   \n ", category: " ", type: "\t" }, true), ["body_md", "category", "type"]);
});

// ── 표 9~12,14: 폴더(#592) — 본문 면제, 표시명 필수. ──
t("9) 신규 폴더·아무것도 없음 → 분류+유형+표시명(본문은 면제)", () => {
  assert.deepEqual(fields({ is_folder: true }, true), ["category", "type", "title"]);
});
t("10) 신규 폴더·표시명/분류/유형 있음 → 통과(빈 본문 허용)", () => {
  assert.deepEqual(fields({ is_folder: true, title: "런북", category: "gtm", type: "reference" }, true), []);
});
t("11) 기존 폴더 편집·표시명 미전송 → 누락 아님", () => {
  assert.deepEqual(fields({ is_folder: true }, false), []);
});
t("12) 폴더에 본문이 있어도 무방 — 면제지 금지가 아니다", () => {
  assert.deepEqual(fields({ is_folder: true, body_md: "본문", title: "런북", category: "gtm", type: "reference" }, true), []);
});
t("14) is_folder=false 명시는 미지정과 같다(본문 필수 유지)", () => {
  assert.deepEqual(fields({ is_folder: false }, true), ["body_md", "category", "type"]);
});

// ── 표 13: append(#921) — 본문의 의미가 '전문'에서 '조각'으로 바뀌지만 비면 안 되는 건 같다. ──
t("13) 덧붙이기 모드·빈 조각 → 거부하고 '조각'임을 안내한다", () => {
  const m = missingRequiredFields({ mode: "append" }, false);
  assert.deepEqual(m.map((x) => x.field), ["body_md"]);
  assert.ok(m[0]!.hint.includes("조각"), "전문이 아니라 조각을 보낸다고 알려야 함");
  // 전문 모드의 안내와 실제로 달라야 한다(같으면 분기가 죽어 있는 것).
  assert.notEqual(m[0]!.hint, missingRequiredFields({}, false)[0]!.hint);
});

// ── 메시지: 남은 누락을 감추지 않는다 + 없는 걸 요구하지도 않는다. ──
t("메시지는 빠진 필드를 전부 열거한다", () => {
  const msg = message({}, true);
  for (const f of ["body_md", "category", "type"]) assert.ok(msg.includes(f), `${f} 가 메시지에 없음`);
});
t("메시지는 빠지지 않은 필드를 요구하지 않는다", () => {
  const msg = message({ body_md: "본문", category: "gtm" }, true);
  assert.ok(msg.includes("type"), "빠진 type 은 알려야 함");
  assert.ok(!msg.includes("body_md"), "채워 보낸 body_md 를 다시 요구하면 안 됨");
  assert.ok(!msg.includes("category —"), "채워 보낸 category 를 다시 요구하면 안 됨");
});

// ── 표 15~17: 새로 도입한 것(분류값 목록)이 부재/빈 경우. ──
t("15) 분류값 목록 부재(조회 실패) → 목록만 생략, 무엇이 빠졌는지는 그대로", () => {
  const msg = message({ body_md: "b", type: "research" }, true, undefined);
  assert.ok(msg.includes("category"), "목록 없이도 무엇이 빠졌는지는 알려야 함");
});
t("16) 분류값 목록이 빈 배열 → 안내가 '사용 가능:' 뒤 공백으로 끊기지 않는다", () => {
  const msg = message({ body_md: "b", type: "research" }, true, []);
  assert.ok(msg.includes("category"), "무엇이 빠졌는지는 알려야 함");
  assert.ok(!/사용 가능한 key: *(\n|$)/.test(msg), "빈 목록을 나열하려 들면 안 됨");
});
t("17) 누락이 없으면 메시지도 아무 필드를 요구하지 않는다(거짓 요구 금지)", () => {
  const msg = requiredFieldsMessage([], true);
  for (const f of ["body_md", "category", "type", "title"]) assert.ok(!msg.includes(f), `${f} 를 요구하면 안 됨`);
});

// ── 표 18~19: 나열 상한의 경계(오프바이원). 개수는 문구가 아니라 **세어서** 본다. ──
const listedKeys = (msg: string, all: string[]): string[] => all.filter((k) => msg.includes(k));
t(`18) 목록이 상한(${CATEGORY_KEYS_SHOWN})과 정확히 같으면 전부 나열하고 생략 꼬리가 없다`, () => {
  const all = keyList(CATEGORY_KEYS_SHOWN);
  const msg = message({ body_md: "b", type: "research" }, true, all);
  assert.equal(listedKeys(msg, all).length, CATEGORY_KEYS_SHOWN, "전부 나열돼야 함");
  assert.ok(!/외 \d+개/.test(msg), "생략된 게 없는데 생략을 알리면 안 됨");
});
t(`19) 목록이 상한+1이면 상한까지만 나열하고 남은 1개를 밝힌다`, () => {
  const all = keyList(CATEGORY_KEYS_SHOWN + 1);
  const msg = message({ body_md: "b", type: "research" }, true, all);
  assert.equal(listedKeys(msg, all).length, CATEGORY_KEYS_SHOWN, "상한까지만 나열돼야 함");
  assert.ok(!msg.includes(all[CATEGORY_KEYS_SHOWN]!), "상한을 넘은 key 가 실리면 안 됨");
  assert.ok(/외 1개/.test(msg), "남은 개수를 정확히 밝혀야 함(오프바이원)");
  assert.ok(msg.includes("category_list"), "전체를 볼 경로를 남겨야 함");
});

// ── 신규/기존 문구 구분 — 기존 편집을 '신규 저장'이라 부르지 않는다. ──
t("신규와 기존의 문구가 갈린다", () => {
  assert.ok(message({}, true).includes("신규 지식 저장"));
  assert.ok(!message({}, false).includes("신규 지식 저장"));
});

// ── 유형 6종(#290)은 zod enum(authoring.ts)·store 검증과 같은 집합이어야 한다. ──
t("유형 유효값 6종이 안내에 그대로 실린다", () => {
  assert.deepEqual([...KNOWLEDGE_TYPES], ["decision", "concept", "how-to", "reference", "research", "entity"]);
  const hint = missingRequiredFields({ body_md: "b", category: "gtm" }, true)[0]!.hint;
  for (const ty of KNOWLEDGE_TYPES) assert.ok(hint.includes(ty), `${ty} 가 안내에 없음`);
});

console.log(`\n${pass} passed`);
