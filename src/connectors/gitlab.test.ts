import assert from "node:assert/strict";
import { parseProjectList, issueItem, noteItem, releaseItem, makeProgressLogger, pages } from "./gitlab.js";
import { routeIngestV6 } from "../org/ingest/ingest-classify.js";
import { sourceKindOf } from "../v6/mirror/mirror-source.js";
import { SOURCE_KINDS } from "../capabilities/source.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("프로젝트 파싱 — 주소(/-/issues 꼬리 제거)·host/ 접두·중첩 그룹·.git·중복", () => {
  assert.deepEqual(parseProjectList("https://git.corp.com/grp/sub/proj/-/issues/3 git.corp.com/A/B.git grp/sub/proj, single nope/../x", "git.corp.com"),
    ["grp/sub/proj", "A/B"]);
});
t("이슈 → o/p#iid, MR → o/p!iid(merged 표식), 둘 다 message/source", () => {
  const i = issueItem("grp/proj", "gitlab.com", { iid: 4, title: "배포 실패", description: "원인 …", state: "closed", labels: ["bug"], user_notes_count: 2, created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-02T00:00:00Z" }, false);
  assert.equal(i.provenance.external_id, "grp/proj#4"); assert.equal(i.fields?.kind, "issue"); assert.equal(routeIngestV6(i.type, "gitlab"), "source");
  const m = issueItem("grp/proj", "gitlab.com", { iid: 9, title: "fix", state: "merged", merged_at: "2026-08-03T00:00:00Z", source_branch: "fix/x", target_branch: "main" }, true);
  assert.equal(m.provenance.external_id, "grp/proj!9"); assert.equal(m.fields?.kind, "mr"); assert.equal(m.fields?.merged_at, "2026-08-03T00:00:00Z");
});
t("노트 → 부모에 매달림, 시스템 노트는 null", () => {
  const n = noteItem("grp/proj", "gitlab.com", 4, false, { id: 77, body: "캐시 키 충돌", created_at: "2026-08-02T00:00:00Z" });
  assert.equal(n?.provenance.external_id, "grp/proj#4:n77"); assert.equal(n?.parent_external_id, "grp/proj#4");
  assert.equal(noteItem("grp/proj", "gitlab.com", 4, false, { id: 78, body: "added label", system: true }), null);
  const mn = noteItem("grp/proj", "gitlab.com", 9, true, { id: 1, body: "LGTM" });
  assert.equal(mn?.parent_external_id, "grp/proj!9"); assert.equal(mn?.fields?.kind, "mr_note");
});
t("릴리스 → note/source · kind gitlab_issue 등록", () => {
  const r = releaseItem("grp/proj", "gitlab.com", { tag_name: "v2.0", name: "봄", description: "- x", released_at: "2026-08-10T00:00:00Z" });
  assert.equal(r.type, "note"); assert.equal(routeIngestV6("note", "gitlab"), "source"); assert.equal(r.provenance.external_id, "grp/proj:release:v2.0");
  assert.equal(sourceKindOf("gitlab"), "gitlab_issue"); assert.ok((SOURCE_KINDS as readonly string[]).includes("gitlab_issue"));
});
t("진행 로그 — 첫 줄은 바로, 간격 안은 삼키고, 간격 지나면 다시(러너 정체 오판 방지)", () => {
  let clock = 1_000;
  const out: string[] = [];
  const log = makeProgressLogger(15_000, () => clock, (m) => out.push(m));

  log("a");                          // 첫 줄은 항상 나간다 — 시작했음을 알려야 한다
  log("b");                          // 같은 시각 → 삼킨다
  clock += 14_999; log("c");         // 아직 간격 미달 → 삼킨다
  clock += 1; log("d");              // 15초 경과 → 나간다
  assert.deepEqual(out, ["a", "d"]);

  clock += 1; log("e", true);        // force 는 간격을 무시한다(프로젝트 경계는 항상 남긴다)
  clock += 1; log("f");              // force 도 타이머를 갱신하므로 직후는 삼킨다
  assert.deepEqual(out, ["a", "d", "e"]);
});
const origFetch = globalThis.fetch;
try {
  // 페이지 2장을 흘리는 GitLab 응답 스텁 — 진행 로그 '배선'이 끊기면(onPage 인자 누락) 여기서 잡힌다.
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    return {
      ok: true, status: 200,
      headers: { get: (k: string) => (k === "x-next-page" ? (n < 2 ? String(n + 1) : "") : null) },
      json: async () => [{ iid: n }, { iid: n * 10 }],
      text: async () => "",
    };
  }) as unknown as typeof fetch;

  const seen: Array<[string, number, number]> = [];
  for await (const _page of pages<{ iid: number }>("tok", "https://x/api/v4/projects/p/issues?a=1", "p issues",
    (label, page, got) => seen.push([label, page, got]))) { /* consume */ }
  assert.deepEqual(seen, [["p issues", 1, 2], ["p issues", 2, 2]]);
  pass++; console.log("ok  pages() 가 페이지마다 onPage 를 부른다 — 배선 누락이면 실패");
} finally {
  globalThis.fetch = origFetch;
}
console.log(`\n${pass} passed`);
