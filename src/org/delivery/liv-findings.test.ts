// 순수 단위 체크(node:assert) — 리브 홈 카드 판정(#1631).
//
// 사양 엣지표(행마다 시나리오 1개 이상):
//  | #  | 상태                                   | 기대                                    |
//  |----|----------------------------------------|-----------------------------------------|
//  | 1  | 비-admin                               | 조직 카드 0 (못 하는 걸 꺼내지 않는다)   |
//  | 2  | 분류축 0개                              | p0 카드 + 실행 프롬프트                  |
//  | 3  | 분류축 있음 + 정의 빈 축 N              | p0 카드에 N 이 실린다                    |
//  | 4  | 분류축 있음 + 정의 다 참                | 분류축 카드 없음                         |
//  | 5  | 관리기 켜짐 + 실행 잡 없음(null)        | p1 "관리가 돌지 않고 있습니다"           |
//  | 6  | 관리기 켜짐 + 잡 있으나 꺼짐            | 같은 카드(꺼진 잡은 도는 게 아니다)      |
//  | 7  | 관리기 켜짐 + 잡 켜짐                   | 카드 없음                                |
//  | 8  | **관리기 0개** + 잡 없음                | 카드 없음(설정 안 한 것과 멈춘 것은 다름)|
//  | 9  | 증류 잔량>0 + 잡 없음                   | p1, 제목에 건수                          |
//  | 10 | 증류 잔량 0 + 잡 없음                   | 카드 없음(막힌 게 없다)                  |
//  | 11 | 분류 잔량>0 + 축 0개                    | 분류잡 카드 없음(축부터가 문제)          |
//  | 12 | 수집기 있는데 켜진 게 0                 | p1                                       |
//  | 13 | 임베딩 off / on / **모름(undefined)**   | 카드 1 / 0 / **0**                       |
//  | 14 | 이관 미보고 + 노드 0                    | 개인 p1 카드                             |
//  | 15 | 이관 **보고함**                         | 카드 없음(잔소리 금지)                   |
//  | 16 | 노드 온라인 1                           | 카드 없음                                |
//  | 17 | pipeline 이 통째로 null(조회 실패)      | 파이프라인 카드 0 (모르면 안 만든다)     |
//  | 18 | 정렬                                    | p0 가 p1 보다 앞                          |
//  | 19 | 상한                                    | top(3) 은 3개, 0 은 0개, 부족하면 그만큼 |
//  | 20 | 문구 규약                               | 모든 title 이 어미로 끝난다              |
import assert from "node:assert/strict";
import { livFindings, livTopFindings, type LivSnapshot } from "./liv-findings.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const JOB_ON = { enabled: true, any_enabled: true, last_status: "ok" };
const JOB_OFF = { enabled: false, any_enabled: false, last_status: null };
// 기본 스냅샷 = 아무 카드도 안 뜨는 '건강한' 조직. 각 테스트는 여기서 한 축만 흔든다.
const healthy = (over: Partial<LivSnapshot> = {}): LivSnapshot => ({
  isAdmin: true,
  org: { items: [{ key: "identity", label: "회사", done: true }, { key: "knowledge", label: "지식", done: true }] },
  pipeline: {
    collect: { configured: 1, enabled: 1 },
    distill: { configured: 1, enabled: 1, backlog: 0, job: JOB_ON },
    classify: { categories: 5, no_definition: 0, backlog: 0, job: JOB_ON },
    manage: { configured: 3, enabled: 3, job: JOB_ON },
  },
  embeddingOff: false,
  nodes: { registered: 1, online: 1 },
  migrateReported: true,
  ...over,
});
const keys = (s: LivSnapshot): string[] => livFindings(s).map((f) => f.key);

t("[기준] 건강한 조직은 카드가 하나도 없다", () => {
  assert.deepEqual(keys(healthy()), []);
});

t("[1] 비-admin 에게는 조직 카드를 꺼내지 않는다", () => {
  const broken = healthy({ isAdmin: false, pipeline: { classify: { categories: 0, no_definition: 0, backlog: 0, job: null }, manage: { configured: 3, enabled: 3, job: null } } });
  assert.deepEqual(keys(broken), [], "권한 밖 항목이 카드로 나왔다");
});

t("[2] 분류축 0개 → p0 + 실행 프롬프트", () => {
  const f = livFindings(healthy({ pipeline: { ...healthy().pipeline, classify: { categories: 0, no_definition: 0, backlog: 0, job: JOB_ON } } }));
  const c = f.find((x) => x.key === "classify.no-category");
  assert.ok(c, "분류축 0인데 카드가 없다");
  assert.equal(c.severity, "p0");
  assert.ok(c.prompt && c.prompt.includes("lively-taxonomy"), "맡길 프롬프트가 없거나 전담 스킬을 안 부른다");
});

t("[3] 정의 빈 축이 있으면 그 수가 제목에 실린다", () => {
  const f = livFindings(healthy({ pipeline: { ...healthy().pipeline, classify: { categories: 5, no_definition: 2, backlog: 0, job: JOB_ON } } }));
  const c = f.find((x) => x.key === "classify.no-definition");
  assert.ok(c && c.title.includes("2개"), `제목에 건수가 없다: ${c?.title}`);
});

t("[4] 축도 있고 정의도 다 차 있으면 분류축 카드는 없다", () => {
  assert.ok(!keys(healthy()).some((k) => k.startsWith("classify.no-")));
});

t("[5] 관리기 켜짐 + 실행 잡 없음 → 관리가 돌지 않는다", () => {
  const f = livFindings(healthy({ pipeline: { ...healthy().pipeline, manage: { configured: 3, enabled: 3, job: null } } }));
  const c = f.find((x) => x.key === "manage.no-job");
  assert.ok(c && c.severity === "p1", "#1618 이 8일 정지로 잡은 바로 그 상태인데 카드가 없다");
});

t("[6] 잡이 있어도 꺼져 있으면 도는 게 아니다", () => {
  const f = keys(healthy({ pipeline: { ...healthy().pipeline, manage: { configured: 3, enabled: 3, job: JOB_OFF } } }));
  assert.ok(f.includes("manage.no-job"));
});

t("[7] 잡이 켜져 있으면 카드 없음", () => {
  assert.ok(!keys(healthy()).includes("manage.no-job"));
});

t("[8] 관리기를 아예 안 만든 조직엔 '멈췄다'고 하지 않는다", () => {
  // 설정 안 한 것과 설정해 놓고 멈춘 것은 다른 상태다. 전자에 '멈췄다'를 띄우면 거짓말이다.
  const f = keys(healthy({ pipeline: { ...healthy().pipeline, manage: { configured: 0, enabled: 0, job: null } } }));
  assert.ok(!f.includes("manage.no-job"));
});

t("[9] 증류 잔량이 있는데 잡이 없으면 건수와 함께 알린다", () => {
  const f = livFindings(healthy({ pipeline: { ...healthy().pipeline, distill: { configured: 1, enabled: 1, backlog: 560, job: null } } }));
  const c = f.find((x) => x.key === "distill.no-job");
  assert.ok(c && c.title.includes("560"), `건수가 안 실렸다: ${c?.title}`);
});

t("[10] 증류 잔량이 0이면 잡이 없어도 막힌 게 아니다", () => {
  const f = keys(healthy({ pipeline: { ...healthy().pipeline, distill: { configured: 1, enabled: 1, backlog: 0, job: null } } }));
  assert.ok(!f.includes("distill.no-job"));
});

t("[11] 분류축이 0이면 분류 잡 카드 대신 축 카드만 (원인이 앞에 있다)", () => {
  const f = keys(healthy({ pipeline: { ...healthy().pipeline, classify: { categories: 0, no_definition: 0, backlog: 100, job: null } } }));
  assert.ok(f.includes("classify.no-category"));
  assert.ok(!f.includes("classify.no-job"), "축이 없는데 잡부터 만들라고 하면 순서가 거꾸로다");
});

t("[12] 수집기는 있는데 켜진 게 하나도 없다", () => {
  const f = keys(healthy({ pipeline: { ...healthy().pipeline, collect: { configured: 2, enabled: 0 } } }));
  assert.ok(f.includes("collect.none-enabled"));
});

t("[13] 임베딩 — 꺼짐이면 카드, 켜짐/모름이면 없음", () => {
  assert.ok(keys(healthy({ embeddingOff: true })).includes("search.embedding-off"));
  assert.ok(!keys(healthy({ embeddingOff: false })).includes("search.embedding-off"));
  // 모름(undefined)을 '꺼짐'으로 뭉개면 조회 실패가 곧 거짓 경고가 된다.
  assert.ok(!keys(healthy({ embeddingOff: undefined })).includes("search.embedding-off"));
});

t("[14] 이관 미보고 + 노드 없음 → 개인 카드", () => {
  const f = livFindings(healthy({ migrateReported: false, nodes: { registered: 0, online: 0 } }));
  const c = f.find((x) => x.key === "member.local-import");
  assert.ok(c && c.scope === "member");
});

t("[15] 이미 보고했으면 다시 묻지 않는다 (잔소리 금지)", () => {
  const f = keys(healthy({ migrateReported: true, nodes: { registered: 0, online: 0 } }));
  assert.ok(!f.includes("member.local-import"));
});

t("[16] 노드가 이미 온라인이면 묻지 않는다", () => {
  const f = keys(healthy({ migrateReported: false, nodes: { registered: 1, online: 1 } }));
  assert.ok(!f.includes("member.local-import"));
});

t("[17] 파이프라인 조회가 실패(null)하면 그 축 카드는 만들지 않는다", () => {
  const f = keys(healthy({ pipeline: null }));
  for (const k of f) assert.ok(!/^(classify|distill|manage|collect)\./.test(k), `모르는 축에 카드를 만들었다: ${k}`);
});

t("[18] p0 가 p1 보다 앞에 온다", () => {
  const f = livFindings(healthy({
    embeddingOff: true,
    pipeline: { ...healthy().pipeline, classify: { categories: 0, no_definition: 0, backlog: 0, job: JOB_ON }, manage: { configured: 3, enabled: 3, job: null } },
  }));
  const firstP1 = f.findIndex((x) => x.severity === "p1");
  const lastP0 = f.map((x) => x.severity).lastIndexOf("p0");
  assert.ok(lastP0 < firstP1, `정렬이 섞였다: ${f.map((x) => `${x.severity}:${x.key}`).join(", ")}`);
});

t("[19] 상한 — 3개까지만 꺼낸다", () => {
  const many = livFindings(healthy({
    embeddingOff: true, migrateReported: false, nodes: { registered: 0, online: 0 },
    org: { items: [{ key: "identity", label: "회사", done: false }, { key: "knowledge", label: "지식", done: false }] },
    pipeline: { collect: { configured: 2, enabled: 0 }, distill: { configured: 1, enabled: 1, backlog: 9, job: null },
      classify: { categories: 0, no_definition: 0, backlog: 0, job: null }, manage: { configured: 3, enabled: 3, job: null } },
  }));
  assert.ok(many.length > 3, "이 조합이면 카드가 3개보다 많아야 한다");
  assert.equal(livTopFindings(many).length, 3);
  assert.equal(livTopFindings(many, 0).length, 0);
  assert.equal(livTopFindings(many.slice(0, 2)).length, 2); // 부족하면 있는 만큼
  assert.equal(livTopFindings(many)[0].severity, "p0", "상한을 잘라도 급한 것부터 남아야 한다");
});

t("[20] 모든 카드 문구가 어미까지 끝맺는다", () => {
  const many = livFindings(healthy({
    embeddingOff: true, migrateReported: false, nodes: { registered: 0, online: 0 },
    org: { items: [{ key: "identity", label: "회사", done: false }, { key: "knowledge", label: "지식", done: false }] },
    pipeline: { collect: { configured: 2, enabled: 0 }, distill: { configured: 1, enabled: 1, backlog: 9, job: null },
      classify: { categories: 3, no_definition: 1, backlog: 5, job: null }, manage: { configured: 3, enabled: 3, job: null } },
  }));
  assert.ok(many.length >= 5);
  for (const f of many) {
    assert.match(f.title, /다\.$|까\?$/, `제목이 명사 종결이다: ${f.title}`);
    assert.match(f.detail, /다\.$/, `설명이 명사 종결이다: ${f.detail}`);
  }
});

console.log(`\n${pass} passed`);
