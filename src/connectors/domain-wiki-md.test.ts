// 실행: node dist/connectors/domain-wiki-md.test.js  (package.json test 체인)
import assert from "node:assert/strict";
import { wikiSlug, notionIdFromUrl, relTargetSlug, parseFrontmatter, normalizeWikiLinks } from "./domain-wiki-md.js";

function testSlug() {
  assert.equal(wikiSlug("savings-bank-operations"), "savings-bank-operations");
  assert.equal(wikiSlug("engineer-pre-assignment-2026-revision2.1"), "engineer-pre-assignment-2026-revision2-1"); // .→- (기존 이관 규칙)
  assert.equal(wikiSlug("Terminology"), "terminology");
  assert.equal(wikiSlug("a  b__c"), "a-b__c"); // 공백→-, _ 보존
}

function testNotionId() {
  assert.equal(notionIdFromUrl("https://www.notion.so/310746a5e5738002a8e4cc75b89ec108"),
    "310746a5-e573-8002-a8e4-cc75b89ec108");
  assert.equal(notionIdFromUrl("https://www.notion.so/Some-Slug-310746a5e5738002a8e4cc75b89ec108?x=1"),
    "310746a5-e573-8002-a8e4-cc75b89ec108");
  assert.equal(notionIdFromUrl("https://example.com/foo"), null);
  assert.equal(notionIdFromUrl("not a url"), null);
}

function testRelTarget() {
  assert.equal(relTargetSlug("../domain/baas/savings-bank-operations.md"), "savings-bank-operations");
  assert.equal(relTargetSlug("./external-vendors.md#aws-메가존"), "external-vendors");
  assert.equal(relTargetSlug("knowledge/domain/architecture/deployment-flow"), "deployment-flow");
}

function testFrontmatter() {
  const { title, body } = parseFrontmatter("---\ntitle: 💰 정산\ncode_sot: x/y\n---\n본문 시작\n둘째 줄");
  assert.equal(title, "💰 정산");
  assert.equal(body, "본문 시작\n둘째 줄");
  const none = parseFrontmatter("프론트매터 없음\n둘째");
  assert.equal(none.title, null);
  assert.equal(none.body, "프론트매터 없음\n둘째");
  assert.equal(parseFrontmatter('---\ntitle: "따옴표 제목"\n---\nx').title, "따옴표 제목");
}

function testNormalize() {
  const targets = new Set<string>([
    "savings-bank-operations", "credit-loan-weekly-pulse", "deployment-flow",
    "notion-310746a5-e573-8002-a8e4-cc75b89ec108",
  ]);
  // C: 상대 .md (앵커 포함) → #/k/ (basename)
  assert.equal(
    normalizeWikiLinks("보라 [상환](../domain/baas/savings-bank-operations.md#h1) 끝", targets),
    "보라 [상환](#/k/savings-bank-operations) 끝");
  // C: 미해소(레포에 없는 people 페이지) → 원형 유지
  assert.equal(
    normalizeWikiLinks("[담당자](../people/mike.md)", targets),
    "[담당자](../people/mike.md)");
  // A: 노션 URL(미러됨) → #/k/notion-…, 미미러는 유지
  assert.equal(
    normalizeWikiLinks("[온보딩](https://www.notion.so/310746a5e5738002a8e4cc75b89ec108)", targets),
    "[온보딩](#/k/notion-310746a5-e573-8002-a8e4-cc75b89ec108)");
  assert.equal(
    normalizeWikiLinks("[미미러](https://www.notion.so/999999999999999999999999999999ff)", targets),
    "[미미러](https://www.notion.so/999999999999999999999999999999ff)");
  // B: [[wikilink]] 해소 / 미해소는 평문
  assert.equal(normalizeWikiLinks("절차 [[deployment-flow]] 참고", targets), "절차 [deployment-flow](#/k/deployment-flow) 참고");
  assert.equal(normalizeWikiLinks("[[infra-raci]]", targets), "infra-raci");
  assert.equal(normalizeWikiLinks("[[deployment-flow|배포 흐름]]", targets), "[배포 흐름](#/k/deployment-flow)");
  // 외부/이미지/앵커 유지
  assert.equal(normalizeWikiLinks("[구글](https://docs.google.com/x)", targets), "[구글](https://docs.google.com/x)");
  assert.equal(normalizeWikiLinks("![img](./a.png)", targets), "![img](./a.png)");
  assert.equal(normalizeWikiLinks("[위로](#section)", targets), "[위로](#section)");
  // 코드펜스/인라인코드 내부는 불변
  const fenced = "```\n[x](../domain/baas/savings-bank-operations.md)\n```";
  assert.equal(normalizeWikiLinks(fenced, targets), fenced);
  assert.equal(
    normalizeWikiLinks("인라인 `[x](../domain/baas/savings-bank-operations.md)` 코드", targets),
    "인라인 `[x](../domain/baas/savings-bank-operations.md)` 코드");
}

function main() {
  testSlug();
  testNotionId();
  testRelTarget();
  testFrontmatter();
  testNormalize();
  console.log("domain-wiki-md.test: OK");
}
main();
