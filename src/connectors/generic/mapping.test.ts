// #1419 T2 — 범용 수집기 매핑 엔진 회귀 잠금. 순수 함수(DB·네트워크 무의존).
//  실행: npm run build && node dist/connectors/generic/mapping.test.js
//
//  왜 여기에 테스트를 거나: 이 계층의 버그는 **조용하다**. 경로가 틀리면 예외가 아니라 빈 값이 나오고,
//  시각을 잘못 읽으면 커서가 엉뚱한 데로 가서 그 구간이 영영 안 읽힌다. 화면에는 '0건 수집'으로만 보여
//  원인을 못 찾는다. 그래서 '무엇이 안 잡히면 안 되는가'를 여기에 못 박는다.
//
//  시나리오는 사양의 엣지 표(E1~E27)를 **행마다 하나씩** 옮긴 것이다 — 표의 행을 빠뜨리면 그게 곧 못 잡는 버그다.
//  각 테스트 이름 끝의 [En] 이 그 대응이다.
import assert from "node:assert/strict";
import { parsePath, extractAll, extractOne, asIso, asText, mapToRawItem } from "./mapping.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ══ 경로 문법 (P1) ══
t("중첩 값을 집는다 [E1]", () => {
  assert.equal(extractOne({ a: { b: { c: 7 } } }, "$.a.b.c"), 7);
});

t("선두 $. 는 생략할 수 있다 [E2]", () => {
  assert.equal(extractOne({ a: { b: 1 } }, "a.b"), 1);
});

t("$ 는 루트 객체 자체 [E3]", () => {
  const o = { x: 1 };
  assert.deepEqual(extractOne(o, "$"), o);
});

t("배열 인덱스 [E4]", () => {
  assert.equal(extractOne({ a: [10, 20, 30] }, "$.a[0]"), 10);
});

t("음수 인덱스는 뒤에서 센다 [E5]", () => {
  assert.equal(extractOne({ a: [10, 20, 30] }, "$.a[-1]"), 30);
});

t("범위 밖 인덱스는 '없음'(예외 아님) [E6·경계]", () => {
  assert.equal(extractOne({ a: [10] }, "$.a[5]"), undefined);
  assert.equal(extractOne({ a: [10] }, "$.a[-5]"), undefined);
});

t("[] 는 배열을 전개한다 [E7]", () => {
  const o = { items: [{ id: "a" }, { id: "b" }, { id: "c" }] };
  assert.deepEqual(extractAll(o, "$.items[].id"), ["a", "b", "c"]);
});

// ══ 없는 것은 오류가 아니다 (P2) ══
t("없는 깊은 경로는 빈 결과 — 던지지 않는다 [E8]", () => {
  assert.deepEqual(extractAll({ a: 1 }, "$.nope.deep.path"), []);
});

t("root 가 null 이어도 던지지 않는다 [E9]", () => {
  assert.equal(extractOne(null, "$.a"), undefined);
});

t("빈 경로는 '없음' [E10]", () => {
  assert.equal(extractOne({ a: 1 }, ""), undefined);
});

t("점이 든 키 — 이스케이프와 대괄호따옴표 [E11]", () => {
  assert.equal(extractOne({ "a.b": 5 }, "a\\.b"), 5);
  assert.equal(extractOne({ "a.b": 5 }, "$['a.b']"), 5);
});

// ══ 설정 오류는 '없음'과 구분된다 (P3) ══
t("문법이 틀린 경로는 null — 값이 없는 것과 다르다 [E12]", () => {
  // 이 구분이 없으면 오타(닫는 괄호 누락)가 '수집 0건'으로만 보여 영영 안 잡힌다.
  assert.equal(parsePath("$.a[bad"), null);
  assert.equal(parsePath(""), null);
  assert.notEqual(parsePath("$.a.b"), null); // 정상 경로는 null 이 아니다(대조군)
});

// ══ 시각 (P6) ══
t("ISO 문자열 [E13]", () => {
  assert.equal(asIso("2026-07-01T10:20:30Z"), "2026-07-01T10:20:30.000Z");
});

t("epoch 초(10자리) [E14·경계]", () => {
  assert.equal(asIso(1_767_225_600), "2026-01-01T00:00:00.000Z");
});

t("epoch 밀리초(13자리) [E15·경계]", () => {
  assert.equal(asIso(1_767_225_600_000), "2026-01-01T00:00:00.000Z");
});

t("epoch 숫자문자열도 같은 규칙 [E16]", () => {
  assert.equal(asIso("1767225600"), "2026-01-01T00:00:00.000Z");
});

// ══ 최고위험 — 못 읽는 시각 (P4) ══
t("못 읽는 시각은 undefined — 0(1970)이나 현재시각으로 때우지 않는다 [E17]", () => {
  // 0 으로 떨어지면 커서가 1970 으로 밀려 매 run 전체를 다시 읽고,
  // 엉뚱한 값이면 그 사이 구간을 영영 건너뛴다(조용한 유실).
  for (const bad of ["어제", "", "  ", "not-a-date", null, undefined, {}, []] as unknown[]) {
    assert.equal(asIso(bad), undefined, `'${JSON.stringify(bad)}' 는 undefined 여야 한다`);
  }
});

// ══ 멱등 키 (P5) ══
const OPTS = { system: "acme-api", instance: "prod" };

t("고유 id 매핑이 없으면 항목을 버린다 [E18]", () => {
  assert.equal(mapToRawItem({ title: "제목만 있음" }, { title: "$.title" }, OPTS), null);
});

t("고유 id 가 빈 문자열이면 버린다 [E19·경계]", () => {
  assert.equal(mapToRawItem({ id: "" }, { external_id: "$.id" }, OPTS), null);
  assert.equal(mapToRawItem({ id: null }, { external_id: "$.id" }, OPTS), null);
});

t("숫자 id 는 문자열로 정규화된다 [E20]", () => {
  const item = mapToRawItem({ id: 42 }, { external_id: "$.id" }, OPTS);
  assert.equal(item?.provenance.external_id, "42");
});

// ══ 전체 매핑 ══
t("전 필드가 제자리에 들어간다 [E21]", () => {
  const raw = {
    id: 42, subject: "배포 완료", content: { text: "본문입니다" },
    creator: { name: "윤상민", email: "yoon@lively.kr" },
    created: "2026-07-01T00:00:00Z", channel: { id: "C1", name: "일반" },
    link: "/posts/42",
  };
  const item = mapToRawItem(raw, {
    external_id: "$.id", title: "$.subject", body: "$.content.text",
    author_name: "$.creator.name", author_email: "$.creator.email",
    occurred_at: "$.created", container_ref: "$.channel.id", container_name: "$.channel.name",
    url: "$.link",
  }, { ...OPTS, baseUrl: "https://acme.example.com/api" });

  assert.ok(item);
  assert.equal(item.provenance.external_id, "42");
  assert.equal(item.provenance.system, "acme-api");
  assert.equal(item.provenance.instance, "prod");
  assert.equal(item.title, "배포 완료");
  assert.equal(item.body, "본문입니다");
  assert.equal(item.actor?.display_name, "윤상민");
  assert.equal(item.actor?.email, "yoon@lively.kr");
  assert.equal(item.container_ref, "C1");
  assert.equal(item.container_name, "일반");
  assert.equal(item.occurred_at, "2026-07-01T00:00:00.000Z");
});

t("갱신시각이 없으면 발생시각으로 대체 — 커서가 전진할 수 있게 [E22]", () => {
  const item = mapToRawItem({ id: "1", at: "2026-07-01T00:00:00Z" },
    { external_id: "$.id", occurred_at: "$.at" }, OPTS);
  assert.equal(item?.updated_at, "2026-07-01T00:00:00.000Z");
});

t("상대 URL 은 절대화된다 [E23]", () => {
  const item = mapToRawItem({ id: "1", u: "/posts/42" },
    { external_id: "$.id", url: "$.u" }, { ...OPTS, baseUrl: "https://acme.example.com/api" });
  assert.equal(item?.provenance.external_url, "https://acme.example.com/posts/42");
});

t("이미 절대 URL 이면 건드리지 않는다 [E24·경계]", () => {
  const item = mapToRawItem({ id: "1", u: "https://other.example.com/x" },
    { external_id: "$.id", url: "$.u" }, { ...OPTS, baseUrl: "https://acme.example.com" });
  assert.equal(item?.provenance.external_url, "https://other.example.com/x");
});

t("채널명은 fields 에도 보존된다 [E25]", () => {
  const item = mapToRawItem({ id: "1", ch: "공지" },
    { external_id: "$.id", container_name: "$.ch" }, OPTS);
  assert.equal(item?.fields?.container_name, "공지");
});

t("extra 매핑은 fields 로 보존된다 [E26]", () => {
  const item = mapToRawItem({ id: "1", pri: "high", tags: ["a", "b"] },
    { external_id: "$.id", extra: { priority: "$.pri", tags: "$.tags" } }, OPTS);
  assert.equal(item?.fields?.priority, "high");
  assert.deepEqual(item?.fields?.tags, ["a", "b"]);
});

t("스칼라는 문자열로, 객체는 JSON 으로 접는다 [E27]", () => {
  assert.equal(asText("x"), "x");
  assert.equal(asText(3), "3");
  assert.equal(asText(false), "false");
  assert.equal(asText({ a: 1 }), '{"a":1}');
  assert.equal(asText(null), undefined);
});

console.log(`\n${pass} passed`);
