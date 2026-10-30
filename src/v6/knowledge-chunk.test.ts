// 조각 규칙(#5203) 유닛 시험 — 측정한 규칙(research_notes 의 chunklib.py, 변형 Fq)에서 벗어나지 않았는지 잠근다.
import test from "node:test";
import assert from "node:assert/strict";
import { chunkKnowledge, chunkEmbedText, CHUNK_MAX_CHARS, CHUNK_DOC_MAX } from "./knowledge-chunk.js";

const texts = (d: { title?: string; body_md?: string }) => chunkKnowledge(d).map((c) => chunkEmbedText(c));

test("절마다 한 조각 · 앞머리는 절 경로 · 문서 제목은 안 붙인다", () => {
  const c = chunkKnowledge({ title: "문서 제목", body_md: "# 큰 제목\n첫 글\n\n## 작은 제목\n둘째 글" });
  assert.deepEqual(c.map((x) => [x.path, x.prefix, x.body, x.startLine, x.seq]), [
    ["큰 제목", "큰 제목", "첫 글", 2, 0],
    ["큰 제목 › 작은 제목", "큰 제목 › 작은 제목", "둘째 글", 5, 1],
  ]);
});

test("경로가 없는 절만 문서 제목을 쓴다", () => {
  const c = chunkKnowledge({ title: "문서 제목", body_md: "머리 글\n\n# 절\n글" });
  assert.deepEqual(c.map((x) => [x.path, x.prefix]), [["", "문서 제목"], ["절", "절"]]);
});

test("같은 수준 제목은 경로에서 갈아 끼운다", () => {
  const c = chunkKnowledge({ body_md: "# a\n## b\nx\n## c\ny\n# d\nz" });
  assert.deepEqual(c.map((x) => x.path), ["a › b", "a › c", "d"]);
});

test("본문 줄이 없는 절은 버린다 · 빈 줄은 뺀다", () => {
  assert.deepEqual(texts({ body_md: "# a\n\n# b\n\n가\n\n나\n" }), ["b\n가\n나"]);
});

test("코드 블록 안의 # 는 제목이 아니다", () => {
  const c = chunkKnowledge({ body_md: "# 절\n```sh\n# 주석\necho\n```\n뒤" });
  assert.equal(c.length, 1);
  assert.ok(c[0].body.includes("# 주석"));
  assert.equal(chunkKnowledge({ body_md: "~~~\n# 주석\n~~~\n# 진짜\n글" }).at(-1)?.path, "진짜");
});

test("긴 절은 줄 경계에서 나눈다 · 겹침 없음 · 앞머리는 조각마다", () => {
  const line = "가".repeat(900);
  const c = chunkKnowledge({ body_md: `# 절\n${line}\n${line}\n${line}` });
  assert.equal(c.length, 2);
  assert.equal(c[0].body, `${line}\n${line}`);
  assert.equal(c[1].body, line);
  assert.deepEqual(c.map((x) => [x.prefix, x.startLine]), [["절", 2], ["절", 4]]);
});

test("줄 하나가 상한보다 길면 글자 수로 끊는다 · 서로게이트 쌍을 가르지 않는다", () => {
  const c = chunkKnowledge({ body_md: `# 절\n${"a".repeat(CHUNK_MAX_CHARS - 1)}😀${"b".repeat(CHUNK_MAX_CHARS)}` });
  assert.equal(c.length, 3);
  assert.ok(c.every((x) => x.body.length <= CHUNK_MAX_CHARS));
  assert.ok(!c.some((x) => /[\ud800-\udbff]$/.test(x.body)));
  assert.equal(c.map((x) => x.body).join(""), `${"a".repeat(CHUNK_MAX_CHARS - 1)}😀${"b".repeat(CHUNK_MAX_CHARS)}`);
});

test("줄바꿈이 CRLF 여도 제목을 알아본다", () => {
  assert.deepEqual(chunkKnowledge({ title: "t", body_md: "# 절\r\n글\r\n" }).map((x) => [x.path, x.body]), [["절", "글"]]);
});

test("문서 하나의 조각 상한", () => {
  const body = Array.from({ length: CHUNK_DOC_MAX + 50 }, (_, i) => `# 절${i}\n글`).join("\n");
  assert.equal(chunkKnowledge({ body_md: body }).length, CHUNK_DOC_MAX);
});

test("본문이 없으면 제목 한 조각 · 둘 다 없으면 없다", () => {
  assert.deepEqual(texts({ title: "제목", body_md: "" }), ["제목"]);
  assert.deepEqual(texts({ title: " ", body_md: " \n " }), []);
  assert.deepEqual(texts({ title: "제목", body_md: "# 빈 절" }), ["제목\n\n# 빈 절"]);
});

test("글이 같으면 해시가 같고 앞머리가 다르면 다르다", () => {
  const [a] = chunkKnowledge({ body_md: "# 가\n글" }); const [b] = chunkKnowledge({ title: "다른 제목", body_md: "# 가\n글" }); const [c] = chunkKnowledge({ body_md: "# 나\n글" });
  assert.equal(a.hash, b.hash);
  assert.notEqual(a.hash, c.hash);
});
