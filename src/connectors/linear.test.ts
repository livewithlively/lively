import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTeamKeys, issueFilter, issueItem, commentItem, documentItem, commentActor, assetCtx, localizeLinearUploads, LINEAR_ASSET_ROUTE, MAX_ASSET_BYTES, ASSET_PROGRESS_EVERY } from "./linear.js";
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
// ── #5012 업로드 첨부 · 댓글 작성자 ─────────────────────────────────────────────
//  관찰 축: 가짜 fetch 의 호출 로그(어디로 · 무슨 인증으로 나갔나)와 임시 폴더의 파일. 문구가 아니라 효과로 단언한다.
const UP = (n: string): string => `https://uploads.linear.app/org/${n}/${n}`;
type Reply = { status: number; type?: string; len?: number; body?: string; retryAfter?: string };
function fakeFetch(replies: Record<string, Reply[]>): { fn: typeof fetch; calls: Array<{ url: string; auth: string | null }> } {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fn = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, auth: init?.headers?.Authorization ?? null });
    const r = (replies[url] ?? []).shift() ?? { status: 404 };
    const headers = new Headers();
    if (r.type) headers.set("content-type", r.type);
    if (r.len != null) headers.set("content-length", String(r.len));
    if (r.retryAfter) headers.set("retry-after", r.retryAfter);
    return new Response(r.body ?? "PNGDATA", { status: r.status, headers });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "linear-assets-"));
const filesIn = (d: string): string[] => fs.readdirSync(d).filter((f) => !f.startsWith(".")).sort();

await (async () => {
  // 1 · 2 이미지 하나가 두 번 — Bearer 로 한 번 받고 두 곳 다 바꾼다
  {
    const d = tmpDir(); const f = fakeFetch({ [UP("a")]: [{ status: 200, type: "image/png" }] });
    const ctx = assetCtx("tok", d, f.fn);
    const out = await localizeLinearUploads(`앞 ![image.png](${UP("a")}) 중간 ![image.png](${UP("a")})`, ctx);
    assert.deepEqual(f.calls, [{ url: UP("a"), auth: "Bearer tok" }], "한 번만 · 연결 토큰으로");
    const [file] = filesIn(d);
    assert.match(file, /^[0-9a-f]{24}\.png$/);
    assert.equal(fs.readFileSync(path.join(d, file), "utf8"), "PNGDATA");
    assert.equal(out, `앞 ![image.png](${LINEAR_ASSET_ROUTE}${file}) 중간 ![image.png](${LINEAR_ASSET_ROUTE}${file})`);
    // 3 다음 실행 — 폴더에 이미 있으면 요청하지 않는다
    const f2 = fakeFetch({}); const again = await localizeLinearUploads(`![image.png](${UP("a")})`, assetCtx("tok", d, f2.fn));
    assert.equal(f2.calls.length, 0, "이미 받은 첨부를 다시 요청했다");
    assert.equal(again, `![image.png](${LINEAR_ASSET_ROUTE}${file})`);
  }
  // 4 이미지가 아닌 링크(영상) · 5 글자에 확장자가 없으면 응답 타입 · 모르는 타입이면 bin
  {
    const d = tmpDir();
    const f = fakeFetch({ [UP("v")]: [{ status: 200, type: "application/octet-stream" }], [UP("p")]: [{ status: 200, type: "image/jpeg" }], [UP("z")]: [{ status: 200, type: "application/x-odd" }] });
    const out = String(await localizeLinearUploads(`[clip.mp4](${UP("v")}) ![](${UP("p")}) [첨부](${UP("z")})`, assetCtx("tok", d, f.fn)));
    const exts = filesIn(d).map((x) => x.split(".")[1]).sort();
    assert.deepEqual(exts, ["bin", "jpg", "mp4"]);
    assert.ok(!out.includes("uploads.linear.app"), out);
    assert.match(out, /^\[clip\.mp4\]\(\/api\/ui\/linear-assets\/[0-9a-f]{24}\.mp4\)/);
  }
  // 6 401·500 — 파일 없음 · 원래 링크 그대로
  {
    const d = tmpDir(); const f = fakeFetch({ [UP("x")]: [{ status: 401 }], [UP("y")]: [{ status: 500 }] });
    const ctx = assetCtx("tok", d, f.fn);
    const src = `![a.png](${UP("x")}) ![b.png](${UP("y")})`;
    assert.equal(await localizeLinearUploads(src, ctx), src);
    assert.deepEqual(filesIn(d), []);
    assert.equal(ctx.stats.failed, 2);
  }
  // 7 크기 상한 — 헤더가 상한+1 이면 안 받고, 정확히 상한이면 받는다
  {
    const d = tmpDir();
    const f = fakeFetch({ [UP("big")]: [{ status: 200, type: "video/mp4", len: MAX_ASSET_BYTES + 1 }], [UP("edge")]: [{ status: 200, type: "image/png", len: MAX_ASSET_BYTES }] });
    const ctx = assetCtx("tok", d, f.fn);
    const out = String(await localizeLinearUploads(`[big.mp4](${UP("big")}) ![e.png](${UP("edge")})`, ctx));
    assert.ok(out.includes(`[big.mp4](${UP("big")})`), "상한 초과는 원래 링크로 남아야 한다");
    assert.deepEqual(filesIn(d).map((x) => x.split(".")[1]), ["png"], "경계값(정확히 상한)은 받아야 한다");
    assert.equal(ctx.stats.tooLarge, 1);
  }
  // 8 리니어 업로드가 아닌 링크 · 9 빈 본문 — 요청 0회 · 그대로
  {
    const d = tmpDir(); const f = fakeFetch({}); const ctx = assetCtx("tok", d, f.fn);
    const other = "![x](https://example.com/a.png) [링크](https://linear.app/snipit/issue/DEV-1)";
    assert.equal(await localizeLinearUploads(other, ctx), other);
    assert.equal(await localizeLinearUploads(null, ctx), null);
    assert.equal(await localizeLinearUploads("", ctx), "");
    assert.equal(f.calls.length, 0);
  }
  // 10 429 다음 200 — 한 번 더 시도해 받는다
  {
    const d = tmpDir(); const f = fakeFetch({ [UP("r")]: [{ status: 429, retryAfter: "0" }, { status: 200, type: "image/png" }] });
    const out = String(await localizeLinearUploads(`![r.png](${UP("r")})`, assetCtx("tok", d, f.fn)));
    assert.equal(f.calls.length, 2); assert.equal(filesIn(d).length, 1); assert.ok(out.includes(LINEAR_ASSET_ROUTE));
  }
  // 11 진행 신호 — 추적기는 15분 무출력이면 run 을 죽인다. 새로 받거나 못 받은 것이 25개 쌓일 때마다 한 번(경계 24 → 0 · 25 → 1),
  //  이미 있는 파일(요청 없음)은 세지 않는다.
  {
    const urls = (n: number, p: string): string[] => Array.from({ length: n }, (_, k) => UP(`${p}${k}`));
    const body = (us: string[]): string => us.map((u) => `![i.png](${u})`).join(" ");
    const run = async (us: string[], status: number, dir = tmpDir()): Promise<number[]> => {
      const seen: number[] = [];
      const f = fakeFetch(Object.fromEntries(us.map((u) => [u, [{ status, type: "image/png" }]])));
      await localizeLinearUploads(body(us), assetCtx("tok", dir, f.fn, (s) => seen.push(s.fetched + s.failed + s.tooLarge)));
      return seen;
    };
    assert.deepEqual(await run(urls(ASSET_PROGRESS_EVERY - 1, "a"), 200), [], "24개에서 신호를 냈다");
    const d = tmpDir();
    assert.deepEqual(await run(urls(ASSET_PROGRESS_EVERY * 2, "b"), 200, d), [ASSET_PROGRESS_EVERY, ASSET_PROGRESS_EVERY * 2]);
    assert.deepEqual(await run(urls(ASSET_PROGRESS_EVERY, "c"), 500), [ASSET_PROGRESS_EVERY], "실패도 진행이다 — 실패만 이어져도 침묵하면 안 된다");
    assert.deepEqual(await run(urls(ASSET_PROGRESS_EVERY * 2, "b"), 200, d), [], "이미 받은 파일은 세지 않는다");
  }
  console.log("ok  #5012 업로드 첨부 — 받기·재사용·실패·상한·429·진행 신호");
})();

t("#5012 댓글 작성자 — 사람 › 외부 작성자(봇 아님) › 연동(봇) › 없음", () => {
  assert.deepEqual(commentActor({ id: "1", user: { id: "u", name: "jang" }, botActor: { name: "Slack" } }), { external_id: "u", display_name: "jang", email: undefined });
  assert.deepEqual(commentActor({ id: "2", user: null, botActor: { name: "Slack", subType: "slack" }, externalUser: { name: "Sentry" } }), { display_name: "Sentry" });
  assert.deepEqual(commentActor({ id: "3", user: null, botActor: { name: "GitHub" } }), { display_name: "GitHub", is_bot: true });
  assert.equal(commentActor({ id: "4", user: null }), undefined);
  const c = commentItem("lively", { id: "u1", identifier: "DEV-725", team: { key: "DEV" } }, { id: "c", body: "x", user: null, botActor: { name: "Slack", subType: "slack" }, externalUser: { name: "Sentry" } });
  assert.equal(c.fields?.via, "slack"); assert.equal(c.actor?.display_name, "Sentry");
});
console.log(`\n${pass} passed`);
