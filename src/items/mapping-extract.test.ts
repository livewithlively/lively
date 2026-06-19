// 순수 추출기 단위 체크 — 테스트 러너 없이 node:assert 로 자급(빌드+typecheck 가 게이트).
// 실행: npm run build && node dist/items/mapping-extract.test.js
import assert from "node:assert/strict";
import {
  BODY_SCAN_CAP, capText,
  extractIssueKeys, extractHashRefs, extractCloseRefs,
  extractEntityTokens, extractDomainSlugTokens,
  parseDiscordDeepLink, parseNotionPageId, extractUrls,
} from "./mapping-extract.js";

let pass = 0;
const t = (name: string, fn: () => void) => { fn(); pass++; console.log(`ok  ${name}`); };

// ── extractIssueKeys ──
t("issueKeys: deny-prefix(라이선스/모델/표준) 전부 드롭", () => {
  const refs = extractIssueKeys("AGPL-3 GPT-4 NC-4 ERC-721 ORP-512 AI-335 ISO-8601 RFC-2616");
  assert.equal(refs.length, 0);
});
t("issueKeys: 트래커 URL 없으면 corroborated:false", () => {
  const refs = extractIssueKeys("작업 PROJ-123 진행중");
  assert.deepEqual(refs, [{ key: "PROJ-123", corroborated: false }]);
});
t("issueKeys: jira URL 동반 시 corroborated:true", () => {
  const refs = extractIssueKeys("PROJ-123 https://x.atlassian.net/browse/PROJ-123");
  assert.equal(refs[0].corroborated, true);
});
t("issueKeys: close-keyword 동반 시 corroborated:true", () => {
  const refs = extractIssueKeys("fixes PROJ-99");
  assert.equal(refs.find((r) => r.key === "PROJ-99")?.corroborated, true);
});

// ── extractHashRefs ──
t("hashRefs: github repo URL 동반 #번호 corroborated:true", () => {
  const refs = extractHashRefs("close #1447 see github.com/owner/repo/issues/1447");
  assert.equal(refs.find((r) => r.num === 1447)?.corroborated, true);
});
t("hashRefs: bare #번호(Daon#3352 같은 태그) 는 절대 corroborated 아님", () => {
  const refs = extractHashRefs("Daon#3352 안녕 #99");
  // Daon#3352 는 식별자 뒤라 제외, 순수 #99 만 잡히되 corroboration 없음.
  assert.deepEqual(refs, [{ num: 99, corroborated: false }]);
});

// ── extractCloseRefs ──
t("closeRefs: close/fix/resolve + 참조", () => {
  const refs = extractCloseRefs("This closes #45 and fixes PROJ-12");
  assert.equal(refs.length, 2);
  assert.equal(refs[0].keyword, "closes");
});

// ── extractEntityTokens (\b 경계, 대소문자 구분) ──
t("entityTokens: 정확 토큰만 매치(부분일치 X)", () => {
  assert.deepEqual(extractEntityTokens("우리는 Campaign 을 한다", ["Campaign"]), ["Campaign"]);
  assert.deepEqual(extractEntityTokens("CampaignParticipation 로그", ["Campaign"]), []);
});
t("entityTokens: 단일 lowercase 영단어 vocab(snake 스키마)은 D3 스킵 — D6 위임", () => {
  // repo=productivity 사후검증: 'domain'/'project'/'item' 같은 메타 vocab 이 임의 문서에서 conf 0.7 오매핑 양산.
  const text = "this domain has a project with an item for the client";
  assert.deepEqual(extractEntityTokens(text, ["domain", "project", "item", "repo", "person"]), []);
});
t("entityTokens: 복합 식별자(언더스코어/하이픈)는 고유 토큰으로 유지", () => {
  assert.deepEqual(extractEntityTokens("item_domain 테이블을 고친다", ["item_domain", "domain"]), ["item_domain"]);
  assert.deepEqual(extractEntityTokens("lively-product-db 읽기전용", ["lively-product-db"]), ["lively-product-db"]);
});
t("entityTokens: AMBIGUOUS 일반명은 대소문자 무시로 스킵('Item' 도 'item' 도)", () => {
  assert.deepEqual(extractEntityTokens("an Item in the cart", ["Item"]), []);
  assert.deepEqual(extractEntityTokens("an item in the cart", ["item"]), []);
});
t("capText: BODY_SCAN_CAP 초과 본문 truncate", () => {
  const big = "x".repeat(BODY_SCAN_CAP + 5000) + "Campaign";
  assert.equal(capText(big).length, BODY_SCAN_CAP);
  // cap 뒤의 Campaign 은 스캔 대상에서 빠진다.
  assert.deepEqual(extractEntityTokens(big, ["Campaign"]), []);
});

// ── extractDomainSlugTokens ──
t("domainSlug: 하이픈 슬러그 매치, 무관 토큰 미매치", () => {
  assert.deepEqual(extractDomainSlugTokens("commerce-shop 관련", ["commerce-shop", "feed-posts"], []), ["commerce-shop"]);
  assert.deepEqual(extractDomainSlugTokens("#회의 잡담", ["commerce-shop"], []), []);
});

// ── parseDiscordDeepLink / parseNotionPageId ──
t("discordDeepLink: externalId = channel:message (discord.ts 와 동일)", () => {
  const dl = parseDiscordDeepLink("https://discord.com/channels/100/200/300");
  assert.deepEqual(dl, { guild: "100", channel: "200", message: "300", externalId: "200:300" });
  assert.equal(parseDiscordDeepLink("https://example.com/x"), null);
});
t("notionPageId: 32-hex 추출(하이픈 정규화)", () => {
  assert.equal(parseNotionPageId("https://notion.so/Page-349a9ddde7768195bb7ccf606ecfd9fb"), "349a9ddde7768195bb7ccf606ecfd9fb");
  assert.equal(parseNotionPageId("https://example.com/no-id"), null);
});
t("extractUrls: 본문 URL 추출", () => {
  const u = extractUrls("see https://a.com/x and https://b.com");
  assert.deepEqual(u.sort(), ["https://a.com/x", "https://b.com"]);
});

console.log(`\n${pass} checks passed`);
