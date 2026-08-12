// 순수 단위 체크(node:assert) — 리브 홈 카드(#1631).
//
// 이 파일이 지키는 것은 **"리브가 판정을 새로 만들지 않는다"** 이다. 무엇이 덜 됐는지는 온보딩 체크리스트가
//  정하고, 리브는 그걸 카드로 옮기며 프롬프트만 붙인다. 그래서 테스트도 "체크리스트가 이렇게 말하면 카드가
//  이렇게 나온다"만 잰다 — 여기서 파이프라인 잔량 같은 걸 다시 재기 시작하면 그게 곧 두 번째 판정이다.
//
// 사양 엣지표(행마다 시나리오 1개 이상):
//  | #  | 상태                                    | 기대                                       |
//  |----|-----------------------------------------|--------------------------------------------|
//  | 1  | 전부 done                                | 카드 0                                     |
//  | 2  | 비-admin + 조직 미완                     | 조직 카드 0 (못 하는 걸 꺼내지 않는다)      |
//  | 3  | identity 미완                            | p0 + 프롬프트                               |
//  | 4  | categories 미완                          | p0 + lively-taxonomy 프롬프트               |
//  | 5  | knowledge 미완                           | p0 + 프롬프트                               |
//  | 6  | members 미완                             | p1 + **프롬프트 없음**(사람이 정할 일)      |
//  | 7  | pipeline 미완                            | p1 + 프롬프트 + 체크리스트의 how 가 본문     |
//  | 8  | embeddings 미완(optional)                | p1                                          |
//  | 9  | **optional 인데 p0 등급 항목**            | p1 로 낮춘다(급한 것을 밀어내지 않게)       |
//  | 10 | 카드 정의가 없는 항목(dbsource) 미완      | 카드 없음                                   |
//  | 11 | org 이 null(조회 실패)                    | 조직 카드 0 (모르면 안 만든다)              |
//  | 12 | 이관 미보고 + 노드 0                      | 개인 p1 카드                                |
//  | 13 | 이관 보고함                               | 카드 없음(잔소리 금지)                      |
//  | 14 | 노드 온라인 1                             | 카드 없음                                   |
//  | 15 | 정렬                                      | p0 가 p1 보다 앞                             |
//  | 16 | 상한                                      | top(3)=3, 0=0, 부족하면 그만큼               |
//  | 17 | 문구 규약                                 | 제목이 어미로 끝난다                         |
//  | 18 | livMature                                 | 조직 카드/p0 있으면 false, 개인 권유만이면 true |
import assert from "node:assert/strict";
import { livFindings, livTopFindings, livMature, type LivSnapshot, type LivOnboardingItem } from "./liv-findings.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// 체크리스트가 '전부 됐다'고 말하는 상태. 각 테스트는 여기서 한 항목만 미완으로 뒤집는다.
const ITEMS: LivOnboardingItem[] = [
  { key: "identity", label: "회사·페르소나·업무규칙", done: true },
  { key: "categories", label: "분류축", done: true },
  { key: "knowledge", label: "지식", done: true },
  { key: "members", label: "구성원", done: true },
  { key: "pipeline", label: "맥락 파이프라인", done: true },
  { key: "embeddings", label: "의미 검색", done: true, optional: true },
  { key: "dbsource", label: "제품 DB 연결", done: true, optional: true },
];
const undone = (key: string, extra: Partial<LivOnboardingItem> = {}): LivOnboardingItem[] =>
  ITEMS.map((i) => (i.key === key ? { ...i, done: false, ...extra } : i));
const snap = (over: Partial<LivSnapshot> = {}): LivSnapshot =>
  ({ isAdmin: true, org: ITEMS, nodes: { registered: 1, online: 1 }, migrateReported: true, ...over });
const keys = (s: LivSnapshot): string[] => livFindings(s).map((f) => f.key);

t("[1] 체크리스트가 전부 done 이면 카드가 없다", () => {
  assert.deepEqual(keys(snap()), []);
});

t("[2] 비-admin 에게는 조직 카드를 꺼내지 않는다", () => {
  assert.deepEqual(keys(snap({ isAdmin: false, org: undone("categories") })), []);
});

t("[3] identity 미완 → p0 + 맡길 프롬프트", () => {
  const [c] = livFindings(snap({ org: undone("identity") }));
  assert.equal(c.key, "org.identity");
  assert.equal(c.severity, "p0");
  assert.ok(c.prompt);
});

t("[4] categories 미완 → p0 + 전담 스킬을 부르는 프롬프트", () => {
  const [c] = livFindings(snap({ org: undone("categories") }));
  assert.equal(c.severity, "p0");
  assert.ok(c.prompt?.includes("lively-taxonomy"), "분류체계는 전담 스킬이 있는데 안 부른다");
});

t("[5] knowledge 미완 → p0", () => {
  assert.equal(livFindings(snap({ org: undone("knowledge") }))[0].severity, "p0");
});

t("[6] members 미완 → p1 이고 **실행 버튼이 없다**(초대·토큰은 사람이 정할 일)", () => {
  const [c] = livFindings(snap({ org: undone("members") }));
  assert.equal(c.severity, "p1");
  assert.equal(c.prompt, undefined, "리브가 대신 못 하는 일에 맡기기 버튼을 그리면 버튼이 거짓말한다");
});

t("[7] pipeline 미완 → p1 + 체크리스트의 how 가 카드 본문으로 그대로 온다", () => {
  const how = "멈춘 단계: 증류 · 관리. 자동 실행을 켜지 않으면 자료가 지식이 되지 않습니다.";
  const [c] = livFindings(snap({ org: undone("pipeline", { how, href: "#/context" }) }));
  assert.equal(c.severity, "p1");
  assert.equal(c.detail, how, "어디가 막혔는지는 체크리스트가 이미 말한다 — 리브가 다시 쓰면 두 판정이 된다");
  assert.equal(c.href, "#/context");
  assert.ok(c.prompt);
});

t("[8] embeddings 미완 → p1", () => {
  const [c] = livFindings(snap({ org: undone("embeddings") }));
  assert.equal(c.key, "org.embeddings");
  assert.equal(c.severity, "p1");
});

t("[9] optional 항목은 등급을 낮춘다 — 해당 없을 수 있는 게 급한 것을 밀어내면 안 된다", () => {
  // identity 는 원래 p0 인데 optional 로 표시돼 오면 p1 로 내려간다.
  const [c] = livFindings(snap({ org: undone("identity", { optional: true }) }));
  assert.equal(c.severity, "p1");
});

t("[10] 카드 정의가 없는 항목은 미완이어도 카드가 없다", () => {
  // 제품 DB 연결은 해당 조직만이라 홈을 차지할 이유가 없다.
  assert.deepEqual(keys(snap({ org: undone("dbsource") })), []);
});

t("[11] 체크리스트 조회 실패(null)면 조직 카드를 만들지 않는다", () => {
  assert.deepEqual(keys(snap({ org: null })), []);
});

t("[12] 이관 미보고 + 노드 없음 → 개인 카드", () => {
  const [c] = livFindings(snap({ migrateReported: false, nodes: { registered: 0, online: 0 } }));
  assert.equal(c.key, "member.local-import");
  assert.equal(c.scope, "member");
});

t("[13] 이미 보고했으면 다시 묻지 않는다 (잔소리 금지)", () => {
  assert.deepEqual(keys(snap({ migrateReported: true, nodes: { registered: 0, online: 0 } })), []);
});

t("[14] 노드가 이미 붙어 있으면 묻지 않는다", () => {
  assert.deepEqual(keys(snap({ migrateReported: false, nodes: { registered: 1, online: 1 } })), []);
});

t("[15] p0 가 p1 보다 앞에 온다", () => {
  const f = livFindings(snap({
    org: ITEMS.map((i) => (["categories", "pipeline", "embeddings"].includes(i.key) ? { ...i, done: false } : i)),
  }));
  const lastP0 = f.map((x) => x.severity).lastIndexOf("p0");
  const firstP1 = f.findIndex((x) => x.severity === "p1");
  assert.ok(lastP0 < firstP1, `정렬이 섞였다: ${f.map((x) => `${x.severity}:${x.key}`).join(", ")}`);
});

t("[16] 상한 — 3개까지만 꺼낸다(급한 것부터 남는다)", () => {
  const f = livFindings(snap({
    migrateReported: false, nodes: { registered: 0, online: 0 },
    org: ITEMS.map((i) => ({ ...i, done: false })),
  }));
  assert.ok(f.length > 3);
  assert.equal(livTopFindings(f).length, 3);
  assert.equal(livTopFindings(f, 0).length, 0);
  assert.equal(livTopFindings(f.slice(0, 2)).length, 2);
  assert.equal(livTopFindings(f)[0].severity, "p0");
});

t("[17] 모든 카드 제목이 어미까지 끝맺는다", () => {
  const f = livFindings(snap({
    migrateReported: false, nodes: { registered: 0, online: 0 },
    org: ITEMS.map((i) => ({ ...i, done: false })),
  }));
  assert.ok(f.length >= 5);
  for (const c of f) assert.match(c.title, /다\.$/, `제목이 명사 종결이다: ${c.title}`);
});

t("[18] livMature — 조직 카드가 있으면 아직 아니고, 개인 권유만 남으면 성숙", () => {
  assert.equal(livMature([]), true);
  assert.equal(livMature(livFindings(snap({ org: undone("pipeline") }))), false, "p1 이어도 조직 카드면 리브가 필요하다");
  const onlyMember = livFindings(snap({ migrateReported: false, nodes: { registered: 0, online: 0 } }));
  assert.deepEqual(onlyMember.map((x) => x.key), ["member.local-import"]);
  assert.equal(livMature(onlyMember), true);
  assert.equal(livMature([{ key: "x", severity: "p0", scope: "member", title: "막혔습니다.", detail: "" }]), false);
});

console.log(`\n${pass} passed`);
