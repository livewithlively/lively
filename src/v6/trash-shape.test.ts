// #3778 휴지통의 모양 — 감사 스냅샷에서 라벨·미리보기를 추리는 순수 함수. DB 불요.
//   실행: npm run build && node dist/v6/trash-shape.test.js
import assert from "node:assert/strict";
import { labelOf, previewOf, PREVIEW_BODY_MAX, isMirroredSourceSnapshot, TRASHABLE_SOURCE_SYSTEMS, purgeAxesOf } from "./trash-shape.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("S1 라벨 — 종류마다 제 표시 필드, 없으면 번호로(빈 줄을 세우지 않는다)", () => {
  assert.equal(labelOf("knowledge", { name: "k-1", title: "가격 비교" }), "가격 비교");
  assert.equal(labelOf("knowledge", { name: "k-1" }), "k-1");
  assert.equal(labelOf("knowledge", {}), "(제목 없음)");
  assert.equal(labelOf("project", { id: 12, name: "지원서" }), "지원서");
  assert.equal(labelOf("project", { id: 12 }), "#12");
  assert.equal(labelOf("source", { id: 9, title: "회의록.docx" }), "회의록.docx");
  assert.equal(labelOf("source", { id: 9, name: "slack-123" }), "slack-123");
  assert.equal(labelOf("source", { id: 9 }), "자료 #9");
  assert.equal(labelOf("category", { key: "gtm" }), "gtm");
});

t("S2 미리보기 — 지식·자료는 body_md, 프로젝트는 description 을 본문으로", () => {
  assert.equal(previewOf("knowledge", "k-1", { title: "T", body_md: "본문", type: "research" }).body_md, "본문");
  assert.equal(previewOf("knowledge", "k-1", { title: "T", body_md: "본문", type: "research" }).doc_type, "research");
  assert.equal(previewOf("source", "9", { id: 9, title: "S", body_md: "전사록", kind: "transcript" }).kind, "transcript");
  assert.equal(previewOf("project", "12", { id: 12, name: "P", description: "설명", body_md: "엉뚱" }).body_md, "설명");
});

t("S3 ★상한 — 긴 본문은 앞부분만, 잘랐다는 사실을 말한다(화면이 «앞부분만» 이라고 적는다)", () => {
  const long = "가".repeat(PREVIEW_BODY_MAX + 10);
  const p = previewOf("source", "9", { id: 9, body_md: long });
  assert.equal(p.body_md.length, PREVIEW_BODY_MAX);
  assert.equal(p.truncated, true);
  const exact = previewOf("source", "9", { id: 9, body_md: "가".repeat(PREVIEW_BODY_MAX) });
  assert.equal(exact.truncated, false);
});

t("S4 본문이 없는 스냅샷 — 빈 글, 잘리지 않음(던지지 않는다)", () => {
  const p = previewOf("knowledge", "k", { name: "k" });
  assert.equal(p.body_md, ""); assert.equal(p.truncated, false); assert.equal(p.title, "k");
});

t("S5 ★미리보기는 고른 필드만 — 스냅샷의 나머지(공개범위·외부 좌표 등)를 그대로 흘리지 않는다", () => {
  const p = previewOf("knowledge", "k", { name: "k", body_md: "b", visibility: "members", external_id: "secret", fields: { x: 1 } }) as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(p).sort(), ["body_md", "doc_type", "entity", "key", "kind", "title", "truncated", "updated_at", "updated_by"]);
});

t("S6 ★수집해 온 자료(원본이 밖에 있는 것)는 휴지통에 세우지 않는다 — 슬랙·깃허브·디스코드·노션", () => {
  for (const sys of ["slack", "github", "discord", "notion", "linear", "figma", "gdrive"]) assert.equal(isMirroredSourceSnapshot({ external_system: sys }), true, sys);
});

t("S7 휴지통에 서는 자료 — 글로 적어 둔 것(외부 좌표 없음: null·빈 문자열·키 없음)과 내 컴퓨터·프로젝트의 파일(local)", () => {
  assert.equal(isMirroredSourceSnapshot({ external_system: null }), false);
  assert.equal(isMirroredSourceSnapshot({ external_system: "" }), false);
  assert.equal(isMirroredSourceSnapshot({ kind: "transcript" }), false);
  assert.equal(isMirroredSourceSnapshot({ external_system: "local" }), false);
});

t("S8 스냅샷이 아예 없어도 던지지 않는다(null·undefined) — 좌표를 모르면 미러로 보지 않는다", () => {
  assert.equal(isMirroredSourceSnapshot(null), false);
  assert.equal(isMirroredSourceSnapshot(undefined), false);
});

t("S9 SQL 과 같은 집합을 본다 — 허용 목록은 빈 문자열과 local 둘뿐(늘리면 SQL 도 같이 늘어난다: 같은 상수를 넘긴다)", () => {
  assert.deepEqual([...TRASHABLE_SOURCE_SYSTEMS], ["", "local"]);
});

t("S10 ★지식을 완전히 지우면 두 축을 비운다 — 주입 섹션은 같은 문서가 org_section 으로도 감사된다(한 축만 비우면 본문이 남는다)", () => {
  assert.deepEqual(purgeAxesOf("knowledge"), ["knowledge", "org_section"]);
});

t("S11 다른 종류는 제 축 하나 — 모르는 종류도 넓히지 않는다", () => {
  assert.deepEqual(purgeAxesOf("project"), ["project"]);
  assert.deepEqual(purgeAxesOf("source"), ["source"]);
  assert.deepEqual(purgeAxesOf("zzz"), ["zzz"]);
});

console.log(`\n${pass} passed`);
