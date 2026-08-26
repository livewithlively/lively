import { strict as assert } from "node:assert";
import path from "node:path";
import test from "node:test";
import {
  APP_PLUGIN_MANIFEST_REL, appPluginArgs, appPluginManifest, assetDiskPath, assertOrigNameSafe, composeAssetFile,
  materializePreparedAppAssets, splitLeadingFrontmatter,
} from "./session-assets.js";

// 순수 — 자산 종류 → cwd 밖 private plugin 상대경로 디스패치(#1867: cwd `.claude/` 가 아니라 session_home/plugin).
test("assetDiskPath — skill/subagent/command 디스패치", () => {
  assert.equal(assetDiskPath("skill", "greet"), "plugin/skills/greet/SKILL.md");
  assert.equal(assetDiskPath("subagent", "reviewer"), "plugin/agents/reviewer.md");
  assert.equal(assetDiskPath("command", "deploy"), "plugin/commands/deploy.md");
});

test("앱 plugin manifest와 Claude 세션 전용 --plugin-dir 배선", () => {
  assert.deepEqual(JSON.parse(appPluginManifest("hello")), {
    name: "hello", description: "Lively app session assets for hello", version: "1.0.0",
  });
  assert.equal(APP_PLUGIN_MANIFEST_REL, "plugin/.claude-plugin/plugin.json");
  assert.deepEqual(appPluginArgs("claude", "/private/session"), ["--plugin-dir", path.join("/private/session", "plugin")]);
  assert.deepEqual(appPluginArgs("codex", "/private/session"), [], "Claude plugin을 다른 하네스 argv에 넘기지 않는다");
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

test("원격 실행 자산 봉투는 plugin/ 아래(+manifest)만 쓰고 traversal·구 cwd 배치는 거부한다", async () => {
  const writes: string[] = [];
  const writer = {
    mkdirp: async (_path: string) => {},
    writeFile: async (file: string, body: string, mode: number) => { writes.push(`${file}:${body}:${mode}`); },
  };
  await materializePreparedAppAssets("/session", [
    { path: "plugin/.claude-plugin/plugin.json", body: "{}", mode: 0o644 },
    { path: "plugin/skills/greet/SKILL.md", body: "hello", mode: 0o644 },
    { path: "plugin/agents/reviewer.md", body: "r", mode: 0o644 },
    { path: "plugin/commands/deploy.md", body: "d", mode: 0o644 },
  ], writer);
  assert.equal(writes.length, 4);
  assert.ok(writes.every((w) => w.startsWith(path.resolve("/session", "plugin") + path.sep)), "전부 session_home/plugin 아래");
  await assert.rejects(
    () => materializePreparedAppAssets("/session", [{ path: "../token", body: "bad", mode: 0o600 }], writer),
    /세션 밖|허용되지 않은/,
  );
  for (const p of [
    "plugin/skills/../../.lively/token",
    "plugin/agents/../commands/evil.md",
    "plugin\\commands\\evil.md",
    "plugin/skills/not-a-skill.md",
    "plugin/.claude-plugin/../../.lively/token",
    ".claude/skills/greet/SKILL.md",   // 종전 cwd 배치 — 사용자 workspace 에 쓰는 경로라 더 이상 받지 않는다(#1867)
    ".claude/commands/deploy.md",
  ]) {
    await assert.rejects(
      () => materializePreparedAppAssets("/session", [{ path: p, body: "bad", mode: 0o600 }], writer),
      /허용되지 않은/,
      p,
    );
  }
});

// ── #1867 실측: 앱 스킬이 세션에 안 실리던 원인 — body 에 frontmatter 가 든 자산 ────────────────
//  dev 라이브(2026-08-25): 앱 'hello' 의 greet 이 `description: ""` + frontmatter 두 벌로 깔려
//  Claude 의 호출 가능 스킬 목록에 아예 없었다. description 이 빈 스킬은 무효다.
test("splitLeadingFrontmatter — 블록을 떼고 스칼라 값을 돌려준다 · 수평선 본문은 안 자른다", () => {
  const withFm = '---\nname: greet\ndescription: 인사한다\n---\n\n# 본문\n내용';
  assert.deepEqual(splitLeadingFrontmatter(withFm), { body: '# 본문\n내용', fields: { name: 'greet', description: '인사한다' } });
  assert.deepEqual(splitLeadingFrontmatter('# 그냥 본문'), { body: '# 그냥 본문', fields: {} });
  // 첫 비공백 줄이 `key:` 가 아니면 frontmatter 가 아니다 — 수평선으로 시작하는 마크다운을 잘라먹지 않는다.
  const rule = '---\n본문이 수평선으로 시작한다\n---\n뒤 본문';
  assert.equal(splitLeadingFrontmatter(rule).body, rule);
  assert.deepEqual(splitLeadingFrontmatter(null), { body: '', fields: {} });
});

test("composeAssetFile — body frontmatter 를 두 벌로 심지 않는다", () => {
  const out = composeAssetFile(
    { description: "", body: '---\nname: greet\ndescription: 인사한다\n---\n\n# greet\n본문', frontmatter: {} },
    "greet",
  );
  assert.equal(out.split(/^---$/m).length - 1, 2, "frontmatter 블록은 정확히 한 벌(--- 두 줄)이어야 한다");
  assert.ok(!out.includes("\nname: greet\ndescription: 인사한다\n---"), "body 쪽 블록이 남으면 본문 첫 단락이 YAML 로 샌다");
  assert.match(out, /# greet/);
});

test("composeAssetFile — 빈 description 을 심지 않는다(컬럼 없으면 body 블록에서 가져온다)", () => {
  const out = composeAssetFile(
    { description: "", body: '---\nname: greet\ndescription: 사용자에게 인사한다\n---\n본문', frontmatter: {} },
    "greet",
  );
  assert.match(out, /description: "사용자에게 인사한다"/, "빈 description 스킬은 하네스가 싣지 않는다");
  // 컬럼이 있으면 컬럼이 이긴다(중앙 편집이 조용히 무시되면 안 된다).
  const col = composeAssetFile(
    { description: "컬럼 설명", body: '---\ndescription: 본문 설명\n---\n본문', frontmatter: { description: "fm 설명" } },
    "greet",
  );
  assert.match(col, /description: "컬럼 설명"/);
  // 셋 다 비면 빈 값이지만 본문은 보존된다(그 이상은 데이터 문제).
  const none = composeAssetFile({ description: "", body: "본문만", frontmatter: {} }, "greet");
  assert.match(none, /description: ""/);
  assert.match(none, /본문만/);
});
