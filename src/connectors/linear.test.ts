import assert from "node:assert/strict";
import { parseTeamKeys, issueFilter, issueItem, commentItem, documentItem } from "./linear.js";
import { parseLinearTokenResponse, buildLinearAuthorizeUrl } from "../org/credentials/linear-oauth.js";
import { routeIngestV6 } from "../org/ingest/ingest-classify.js";
import { sourceKindOf } from "../v6/mirror/mirror-source.js";
import { SOURCE_KINDS } from "../capabilities/source.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("팀 키 파싱 — 대문자화·중복 제거", () => { assert.deepEqual(parseTeamKeys("eng, PRD eng"), ["ENG", "PRD"]); assert.deepEqual(parseTeamKeys(""), []); });
t("이슈 필터 — since·팀 하나/여럿·없음", () => {
  assert.equal(issueFilter(undefined, []), undefined);
  assert.deepEqual(issueFilter("2026-08-01T00:00:00Z", ["ENG"]), { updatedAt: { gt: "2026-08-01T00:00:00Z" }, team: { key: { eq: "ENG" } } });
  assert.deepEqual(issueFilter(undefined, ["ENG", "PRD"]), { team: { key: { in: ["ENG", "PRD"] } } });
});
t("이슈 → message/source, external_id=identifier, completed/canceled 는 closed", () => {
  const i = issueItem("lively", { id: "u1", identifier: "ENG-12", title: "로그인 오류", description: "…", url: "https://linear.app/x/issue/ENG-12", state: { name: "Done", type: "completed" }, team: { key: "ENG", name: "Engineering" }, labels: { nodes: [{ name: "bug" }] }, creator: { id: "p1", name: "yoon" }, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-02T00:00:00Z", comments: { nodes: [{ id: "9f3a", body: "원인은 캐시" }] } });
  assert.equal(i.provenance.external_id, "ENG-12"); assert.equal(i.fields?.closed, true); assert.equal(i.container_ref, "ENG");
  assert.equal(routeIngestV6(i.type, "linear"), "source");
  assert.equal((i.raw as { comments?: unknown }).comments, undefined, "댓글은 따로 자료가 되므로 raw 에 중복 저장하지 않는다");
});
t("댓글 → 부모 이슈에 매달림 · 문서 → note/source", () => {
  const issue = { id: "u1", identifier: "ENG-12", team: { key: "ENG" } };
  const c = commentItem("lively", issue, { id: "9f3a", body: "원인은 캐시", createdAt: "2026-08-02T00:00:00Z", user: { id: "p2", name: "jang" } });
  assert.equal(c.provenance.external_id, "ENG-12:c9f3a"); assert.equal(c.parent_external_id, "ENG-12");
  const d = documentItem("lively", { id: "d1", title: "온보딩 스펙", content: "…", project: { name: "온보딩" } });
  assert.equal(d.type, "note"); assert.equal(routeIngestV6("note", "linear"), "source"); assert.equal(d.provenance.external_id, "doc:d1");
});
t("자료 kind linear_issue 등록", () => { assert.equal(sourceKindOf("linear"), "linear_issue"); assert.ok((SOURCE_KINDS as readonly string[]).includes("linear_issue")); });
t("OAuth — 인가 URL 파라미터(actor=user·prompt=consent·scope=read) · 토큰 응답 파싱(에러는 던진다)", () => {
  const u = new URL(buildLinearAuthorizeUrl({ clientId: "cid", redirectUri: "https://gw/oauth/callback", state: "st" }));
  assert.equal(u.searchParams.get("actor"), "user"); assert.equal(u.searchParams.get("scope"), "read"); assert.equal(u.searchParams.get("prompt"), "consent"); assert.equal(u.searchParams.get("state"), "st");
  const tok = parseLinearTokenResponse({ access_token: "lin_oauth_x", token_type: "Bearer", expires_in: 315360000, scope: "read" });
  assert.equal(tok.access_token, "lin_oauth_x"); assert.equal(tok.expires_in, 315360000);
  assert.throws(() => parseLinearTokenResponse({ error: "invalid_grant", error_description: "bad code" }), /invalid_grant/);
  assert.throws(() => parseLinearTokenResponse({}), /access_token/);
});
console.log(`\n${pass} passed`);
