// GitHub 커넥터 순수 단위(#2247) — 범위 파싱·아이템 매핑·착지 규칙 교차검증. 네트워크 불요.
import assert from "node:assert/strict";
import { parseRepoList, issueItem, commentItem, releaseItem, nextLinkOf, apiBaseOf, issueNumberOf } from "./github.js";
import { routeIngestV6 } from "../org/ingest/ingest-classify.js";
import { sourceKindOf } from "../v6/mirror/mirror-source.js";
import { SOURCE_KINDS } from "../capabilities/source.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const R = { owner: "livewithlively", repo: "lively", full: "livewithlively/lively" };

t("범위 파싱 — 주소·o/r.git·o/r 을 다 받고, 중복(대소문자)·쓰레기는 버린다", () => {
  const got = parseRepoList("https://github.com/livewithlively/lively/issues/12 LiveWithLively/Lively.git\nfoo/bar, github.com/a/b/ nope ../x");
  assert.deepEqual(got.map((r) => r.full), ["livewithlively/lively", "foo/bar", "a/b"]);
  assert.deepEqual(parseRepoList(""), []);
});
t("API base — github.com 은 api.github.com, GHE 는 /api/v3", () => {
  assert.equal(apiBaseOf(undefined), "https://api.github.com");
  assert.equal(apiBaseOf("GHE.corp.com"), "https://ghe.corp.com/api/v3");
});
t("이슈·PR → message/source, external_id=o/r#n, PR 은 fields.kind=pr", () => {
  const it = issueItem(R, "github.com", { number: 7, title: "로그인 깨짐", body: "재현: …", state: "closed", user: { id: 1, login: "yoon" }, labels: [{ name: "bug" }, "p1"], created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-02T00:00:00Z", closed_at: "2026-08-02T00:00:00Z" });
  assert.equal(it.type, "message");
  assert.equal(it.provenance.external_id, "livewithlively/lively#7");
  assert.equal(it.provenance.system, "github");
  assert.deepEqual(it.fields?.labels, ["bug", "p1"]);
  assert.equal(it.fields?.kind, "issue");
  assert.match(String(it.body), /^이슈 #7 로그인 깨짐\n\n재현/);
  assert.equal(routeIngestV6(it.type, "github"), "source", "이슈 본문은 자료로 들어와 증류 대상이 된다");
  const pr = issueItem(R, "github.com", { number: 8, title: "fix", pull_request: { merged_at: "2026-08-03T00:00:00Z" }, user: { login: "bot", type: "Bot" } });
  assert.equal(pr.fields?.kind, "pr"); assert.equal(pr.fields?.merged_at, "2026-08-03T00:00:00Z"); assert.equal(pr.actor?.is_bot, true);
});
t("댓글 → 부모(이슈)에 매달린 message; 번호는 issue_url/pull_request_url 끝에서; 못 알아보면 null", () => {
  const c = commentItem(R, "github.com", { id: 55, body: "원인은 캐시", issue_url: "https://api.github.com/repos/livewithlively/lively/issues/7", created_at: "2026-08-02T00:00:00Z" }, false);
  assert.equal(c?.provenance.external_id, "livewithlively/lively#7:c55");
  assert.equal(c?.parent_external_id, "livewithlively/lively#7");
  assert.equal(routeIngestV6("message", "github"), "source");
  const rc = commentItem(R, "github.com", { id: 9, body: "여기 널 체크", pull_request_url: "https://api.github.com/repos/livewithlively/lively/pulls/8", path: "src/a.ts", line: 12 }, true);
  assert.equal(rc?.fields?.kind, "review_comment"); assert.match(String(rc?.body), /src\/a\.ts:12/);
  assert.equal(commentItem(R, "github.com", { id: 1, body: "x" }, false), null);
  assert.equal(issueNumberOf({ issue_url: "https://x/issues/42" }), 42);
});
t("릴리스 → note(자료) — doc 이 아니다(doc 은 지식 직행이라 릴리스 노트가 검토 없이 지식이 된다)", () => {
  const r = releaseItem(R, "github.com", { id: 3, tag_name: "v1.2.0", name: "여름 릴리스", body: "- 로그인 개선", published_at: "2026-08-10T00:00:00Z" });
  assert.equal(r.type, "note");
  assert.equal(r.provenance.external_id, "livewithlively/lively:release:3");
  assert.equal(routeIngestV6("note", "github"), "source");
  assert.match(String(r.title), /v1\.2\.0 — 여름 릴리스/);
});
t("자료 kind — github 은 github_issue 로 잡힌다(other 로 뭉개지면 자료함 필터·증류기 match_kinds 가 안 걸린다)", () => {
  assert.equal(sourceKindOf("github"), "github_issue");
  assert.ok((SOURCE_KINDS as readonly string[]).includes("github_issue"));
});
t("Link 헤더 next 파싱", () => {
  assert.equal(nextLinkOf('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"'), "https://api.github.com/x?page=2");
  assert.equal(nextLinkOf('<https://api.github.com/x?page=1>; rel="prev"'), null);
  assert.equal(nextLinkOf(null), null);
});
console.log(`\n${pass} passed`);
