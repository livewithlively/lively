import { strict as assert } from "node:assert";
import test from "node:test";
import { assetDiskPath, assertOrigNameSafe, composeAssetFile, materializePreparedAppAssets } from "./session-assets.js";

// 순수 — 자산 종류 → 세션 폴더 상대경로 디스패치(design D4, kit placement 규약과 동일).
test("assetDiskPath — skill/subagent/command 디스패치", () => {
  assert.equal(assetDiskPath("skill", "greet"), ".claude/skills/greet/SKILL.md");
  assert.equal(assetDiskPath("subagent", "reviewer"), ".claude/agents/reviewer.md");
  assert.equal(assetDiskPath("command", "deploy"), ".claude/commands/deploy.md");
});

test("assetDiskPath — 알 수 없는 종류 → null(skip)", () => {
  assert.equal(assetDiskPath("hook", "x"), null);
  assert.equal(assetDiskPath("", "x"), null);
});

// 경로안전 — orig_name 이 STRICT_SLUG 가 아니면 거부(traversal 2차 방어).
test("assertOrigNameSafe — 정상 슬러그 통과(정규화 반환)", () => {
  assert.equal(assertOrigNameSafe("hello", "greet"), "greet");
  assert.equal(assertOrigNameSafe("hello", "  Greet  "), "greet"); // trim + 소문자
  assert.equal(assertOrigNameSafe("hello", "my-skill_2"), "my-skill_2");
});

test("assertOrigNameSafe — traversal/불량 이름 거부(HttpError)", () => {
  for (const bad of ["../etc/passwd", "a/b", "a.b", "..", "/abs", "", null, undefined, "has space", "대문자한글"]) {
    assert.throws(() => assertOrigNameSafe("hello", bad as string), /orig_name 형식 오류|경로안전/, `거부해야: ${JSON.stringify(bad)}`);
  }
});

// 본문 조립 — name 은 origName(앱 슬러그)로 강제되어야 앱 내부 상호참조가 맞물린다(중앙 저장 id 가 아니라).
test("composeAssetFile — name 을 origName 으로 강제 + description·본문 포함", () => {
  const out = composeAssetFile(
    { description: "인사 스킬", body: "# 본문\n인사하세요.", frontmatter: { name: "app-abc123-greet", model: "sonnet" } },
    "greet",
  );
  assert.match(out, /^---\n/);
  assert.match(out, /name: "greet"/);            // 중앙 저장 id(app-abc123-greet)가 아니라 앱 슬러그
  assert.doesNotMatch(out, /app-abc123-greet/);  // 저장 id 는 새어나오지 않는다
  assert.match(out, /description: "인사 스킬"/);
  assert.match(out, /model: "sonnet"/);          // 나머지 frontmatter 키는 보존
  assert.match(out, /# 본문/);                    // 본문 포함
});

test("원격 실행 자산 봉투는 .claude 아래만 쓰고 traversal은 거부한다", async () => {
  const writes: string[] = [];
  const writer = {
    mkdirp: async (_path: string) => {},
    writeFile: async (file: string, body: string, mode: number) => { writes.push(`${file}:${body}:${mode}`); },
  };
  await materializePreparedAppAssets("/session", [{ path: ".claude/skills/greet/SKILL.md", body: "hello", mode: 0o644 }], writer);
  assert.equal(writes.length, 1);
  await assert.rejects(
    () => materializePreparedAppAssets("/session", [{ path: "../token", body: "bad", mode: 0o600 }], writer),
    /세션 밖|허용되지 않은/,
  );
  for (const path of [
    ".claude/skills/../../.lively/token",
    ".claude/agents/../commands/evil.md",
    ".claude\\commands\\evil.md",
    ".claude/skills/not-a-skill.md",
  ]) {
    await assert.rejects(
      () => materializePreparedAppAssets("/session", [{ path, body: "bad", mode: 0o600 }], writer),
      /허용되지 않은/,
      path,
    );
  }
});
