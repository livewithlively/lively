// 지식 이력(#1546) op 분류 가드 — 기록되는 감사 op 이 전부 CONTENT_OPS ∪ META_OPS 에 들어 있는지.
// 실행: npm run build && node dist/v6/knowledge-history-store.test.js
//
//  왜: 이력 화면은 op 화이트리스트(`a.op = ANY(...)`)로 조회한다. 나중에 누가
//   auditKnowledge(name, "set_visibility", …) 같은 op 을 새로 추가하면서 이 두 목록을 안 고치면,
//   그 변경은 '메타 변경도 보기'를 켜도 **화면에서 그냥 사라진다**. 에러도 안 난다 — 조용한 구멍이다.
//   그래서 목록을 손으로 베끼지 않고 **소스에서 op 리터럴을 뽑아** 대조한다(새 호출부가 새 파일에
//   생겨도 잡힌다). 감사 기록 자체는 정상이고 org_audit_list 로는 보이므로 데이터 유실은 아니지만,
//   '이 문서가 어떻게 변해왔나'는 그만큼 거짓이 된다.
//  사양: scratchpad/spec.md (#1546) — 엣지 8행.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTENT_OPS, META_OPS, HISTORY_ENTITIES } from "./knowledge-history-store.js";
import { LIFECYCLE_SWEEP_OP } from "./mirror/mirror-common.js";
import { lineDelta } from "./knowledge-revision-store.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ── 추출기 — auditKnowledge(<지식키>, <op>, …) 의 **두 번째 인자**에서 문자열 리터럴을 뽑는다. ──
//  단순형("set_wiki")과 삼항형(before ? "update" : "insert")을 모두 받는다.
export function opsInSource(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/auditKnowledge\(\s*[^,]+,\s*([^,]+),/g)) {
    for (const s of m[1].matchAll(/"([a-z_]+)"/g)) out.push(s[1]);
  }
  return out;
}

// ── 추출기 단위 검증(사양 표 1~6행) — 합성 픽스처. 실소스 스캔이 맞는지는 이게 살아 있어야 말할 수 있다. ──
t("① 단순형 호출에서 op 추출", () => {
  assert.deepEqual(opsInSource(`await auditKnowledge(name, "set_wiki", before, after, ctx);`), ["set_wiki"]);
});
t("② 삼항형 호출에서 op 둘 다 추출", () => {
  assert.deepEqual(opsInSource(`await auditKnowledge(name, before ? "update" : "insert", before, after, ctx);`),
    ["update", "insert"]);
});
t("③ 줄바꿈으로 나뉜 호출에서도 추출", () => {
  assert.deepEqual(opsInSource(`await auditKnowledge(\n      name, "move",\n      before, after, ctx);`), ["move"]);
});
t("④ 세 번째 인자 이후의 문자열은 op 이 아니다", () => {
  assert.deepEqual(
    opsInSource(`auditKnowledge(name, "link_category", null, { category_id: id, mapped_by: "llm" }, ctx);`),
    ["link_category"]);
});
t("⑤ 함수 정의부는 op 을 내지 않는다", () => {
  assert.deepEqual(opsInSource(
    `export const auditKnowledge = (name: string, op: string, before: unknown) => auditOrgContent("knowledge", name, op, before);`),
  []);
});
t("⑥ 호출이 없는 코드는 빈 결과", () => {
  assert.deepEqual(opsInSource(`const x = 1; await audit("project", key, "update", a, b);`), []);
});

// ── lineDelta 의 '빈 쪽' 경계(#1546) ──
//  이력 타임라인은 insert(before=null)·delete(after=null) 행을 그린다. 빈 쪽을 [""] 로 세면 문서 생성이
//  `+2/−1`(1줄이 삭제됐다?)로 표시된다 — 실측으로 잡힌 거짓이다. 빈 쪽 = 0줄이어야 한다.
t("생성(before=null): 삭제 0줄", () => assert.deepEqual(lineDelta(null, "a\nb"), { added: 2, removed: 0 }));
t("빈 본문에서 시작(before=''): 삭제 0줄", () => assert.deepEqual(lineDelta("", "a\nb"), { added: 2, removed: 0 }));
t("삭제(after=null): 추가 0줄", () => assert.deepEqual(lineDelta("a\nb", null), { added: 0, removed: 2 }));
t("본문을 비움(after=''): 추가 0줄", () => assert.deepEqual(lineDelta("a\nb", ""), { added: 0, removed: 2 }));
t("양쪽 다 빔: 0/0", () => assert.deepEqual(lineDelta(null, null), { added: 0, removed: 0 }));
t("평범한 추가는 종전대로(회귀)", () => assert.deepEqual(lineDelta("a\nb", "a\nb\nc"), { added: 1, removed: 0 }));
t("줄 순서만 바뀌면 0/0 — 집합 근사의 알려진 한계(정확한 diff 는 상세 화면)", () =>
  assert.deepEqual(lineDelta("a\nb", "b\na"), { added: 0, removed: 0 }));

// ── 실소스 스캔 ──
// dist/v6/<this>.js → 레포 루트는 ".."×2. (이 파일이 옮겨지면 여기도 고칠 것 — 어긋나면 ⑦ 이 터진다.)
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const found = new Set<string>();
for (const file of walk(SRC)) {
  const src = fs.readFileSync(file, "utf8");
  if (src.includes("export const auditKnowledge")) continue;   // 정의부 파일은 건너뛴다(⑤와 같은 이유)
  for (const op of opsInSource(src)) found.add(op);
}

// ⑦⑧ 배선 — 관측 장치가 죽으면 아래 커버리지 단언은 "미분류 0건"으로 **통과하면서 아무것도 안 본다**.
t("⑦ 실소스에서 op 을 실제로 찾았다(경로·스캔이 살아 있다)", () => {
  assert.ok(found.size >= 10,
    `찾은 op 이 너무 적다(${found.size}) — SRC 경로나 추출기가 깨졌을 수 있다: ${[...found]}`);
});
t("⑧ 대표 4형태(단순·삼항·링크·정션)가 모두 잡힌다", () => {
  for (const anchor of ["set_wiki", "update", "link_knowledge", "link_category"]) {
    assert.ok(found.has(anchor), `대표 op '${anchor}' 을 못 찾았다 — 추출 로직 점검 필요`);
  }
});

// ── 정책 본체 ──
const content = new Set<string>(CONTENT_OPS);
const meta = new Set<string>(META_OPS);

t("CONTENT_OPS 와 META_OPS 는 겹치지 않는다", () => {
  const dup = [...content].filter((o) => meta.has(o));
  assert.deepEqual(dup, [], `양쪽에 든 op: ${dup}`);
});

t("기록되는 모든 op 이 둘 중 한 쪽에 분류돼 있다(미분류 = 화면에서 조용히 사라짐)", () => {
  const unclassified = [...found].filter((o) => !content.has(o) && !meta.has(o));
  assert.deepEqual(unclassified, [],
    `미분류 op: ${unclassified} — knowledge-history-store.ts 의 CONTENT_OPS/META_OPS 에 추가하세요. `
    + "안 하면 그 변경은 '메타 변경도 보기'를 켜도 이력에 안 나옵니다.");
});

t("분류 목록에 실재하지 않는 op 이 없다(오타·폐기 op 잔존)", () => {
  const ghosts = [...content, ...meta].filter((o) => !found.has(o));
  assert.deepEqual(ghosts, [], `소스에 없는 op 이 목록에 남아 있다: ${ghosts}`);
});

// ── #1560 후속 가드 — '기록은 되는데 이력에선 안 보이는' 구멍의 재발 방지. ──
//  이 프로젝트가 실제로 발견한 결함이 그 모양이었다: 항상-주입 섹션은 편집 경로가 둘이라 감사가 두 축으로
//  갈라져 쌓이는데 이력은 한 축만 읽었다 → org-defaults 는 6건 중 2건만, 그것도 **최신 편집을 뺀 옛것만**
//  보였다. 에러도 안 나고 목록이 조금 짧아 보일 뿐이라 눈으로는 못 잡는 종류의 거짓이다.
//  사양: scratchpad/spec.md (#1560) — 엣지 8행(A1~A4·B1·B2·C1·C2).

// A1·A2·C1 — 섹션 스토어가 쓰는 감사 축은 **전부** 이력 조회 대상이어야 한다(하나라도 빠지면 그 편집이 사라진다).
t("⑨ 섹션 스토어가 쓰는 감사 entity 는 전부 이력 조회 대상이다", () => {
  const src = fs.readFileSync(path.join(SRC, "org", "store", "sections.ts"), "utf8");
  // audit("<entity>", …) 의 **첫 인자**. 이 스토어는 knowledge 행을 고치므로 여기서 쌓는 감사는 곧 그 문서의 이력이다.
  const entities = [...new Set([...src.matchAll(/\baudit\(\s*"([a-z_]+)"/g)].map((m) => m[1]))];
  // C1(배선) — 0건이면 '위반 없음'이 아니라 '추출기가 스테일하다'. 그 구분이 없으면 가드가 죽은 채로 통과한다.
  assert.ok(entities.length, "섹션 스토어에서 audit() 호출을 못 찾았다 — 추출기가 스테일하다(가드가 죽었다)");
  for (const e of entities) {
    assert.ok(HISTORY_ENTITIES.includes(e),
      `섹션 스토어가 entity='${e}' 로 감사하는데 이력이 그 축을 안 읽는다 — HISTORY_ENTITIES 에 추가하세요. `
      + "안 하면 그 화면에서 한 편집은 문서 이력에서 통째로 사라집니다.");
  }
});

// A3·A4 — 축마다 스냅샷 **모양이 다르다**. org_section 스냅샷은 SECTION_COLS 뿐이라 injection·provenance·type 이
//  없고, 그대로 지식 upsert 에 넘기면 injection='always' 가 풀려 전 구성원의 세션에서 그 규칙이 조용히 사라진다.
t("⑩ 지식 축 외의 이력 entity 마다 되돌리기 경로가 갈려 있다", () => {
  const others = HISTORY_ENTITIES.filter((x) => x !== "knowledge");
  // A4(배선) — 대상이 0건이면 아래 루프가 공허하게 통과한다. 그 상태를 통과로 두지 않는다.
  assert.ok(others.length, "지식 축 외의 이력 entity 가 없다 — 합집합 조회(#1562)가 되돌려졌거나 가드가 스테일하다");
  const src = fs.readFileSync(path.join(SRC, "capabilities", "knowledge", "history.ts"), "utf8");
  for (const e of others) {
    assert.ok(src.includes(`entity === "${e}"`),
      `'${e}' 축 스냅샷의 되돌리기 분기가 없다 — 지식 upsert 로 흘러 injection·type 같은 facet 이 조용히 지워집니다.`);
  }
});

// B1·C2 — 미러 스윕은 auditKnowledge 가 아니라 raw INSERT 로 감사한다(대량 스윕을 한 문장에 넣으려고).
//  그래서 위 소스 스캔(found)이 못 잡는다 → 상수로 직접 대조한다.
t("⑪ 미러 스윕 감사가 쓰는 op 이 이력 분류에 들어 있다", () => {
  assert.ok(LIFECYCLE_SWEEP_OP, "스윕 op 상수가 비었다 — 대조할 대상이 없다(가드가 죽었다)");   // C2(배선)
  assert.ok(content.has(LIFECYCLE_SWEEP_OP) || meta.has(LIFECYCLE_SWEEP_OP),
    `스윕 op '${LIFECYCLE_SWEEP_OP}' 이 CONTENT_OPS/META_OPS 어디에도 없다 — 커넥터 아카이브가 이력에서 사라집니다.`);
});

// A5 — **분기가 있다 ≠ 분기에 도달한다.** 축마다 스냅샷의 키 이름 자체가 달라서, 지식용 검사(`name` 이
//  문자열인가)가 섹션 분기보다 앞에 있으면 섹션 되돌리기가 400 으로 튕긴다. 코드는 멀쩡히 있는데 죽은 가지가 된다.
//  라이브 검증에서 실제로 그렇게 나왔다(#1560) — ⑩(존재 검사)만으로는 못 잡는 종류라 순서까지 본다.
t("⑬ 섹션 되돌리기 분기가 지식용 스냅샷 검사보다 앞에 온다", () => {
  const src = fs.readFileSync(path.join(SRC, "capabilities", "knowledge", "history.ts"), "utf8");
  const branch = src.indexOf('entity === "org_section"');
  const nameCheck = src.indexOf('typeof snapshot.name !== "string"');
  assert.ok(branch >= 0 && nameCheck >= 0, "가드 앵커를 못 찾았다 — 되돌리기 구조가 바뀌었다(가드 스테일)");
  assert.ok(branch < nameCheck,
    "섹션 분기가 지식용 name 검사 뒤에 있다 — 섹션 스냅샷엔 name 키가 없어 그 검사에 먼저 걸려 400 이 된다.");
});

t("⑭ 섹션 스냅샷에는 지식의 name 키가 없다(⑬ 순서가 필요한 이유)", () => {
  const src = fs.readFileSync(path.join(SRC, "org", "store", "sections.ts"), "utf8");
  const m = src.match(/export interface OrgSection \{([^}]*)\}/);
  assert.ok(m, "OrgSection 인터페이스를 못 찾았다 — 가드가 스테일하다");
  assert.ok(!/^\s*name\s*[?:]/m.test(m[1]),
    "OrgSection 에 name 키가 생겼다 — ⑬ 의 전제(키 이름이 달라 순서가 중요하다)가 바뀌었으니 되돌리기 분기를 다시 보라.");
});

// A6 — 없는 값을 빈 문자열로 뭉개면 화면이 '본문이 빈 버전'과 '본문을 안 남기는 변경'을 구분 못 한다.
//  실측(#1560): 분류 지정 행이 '이 시점에 문서가 처음 만들어졌습니다'로 표시됐다. 타입이 null 을 표현하지
//  못하면 그 구분이 애초에 불가능하므로, 타입 자체를 가드로 고정한다.
t("⑮ 이력 단건의 본문은 '없음'(null)을 표현할 수 있다", () => {
  const src = fs.readFileSync(path.join(SRC, "v6", "knowledge-history-store.ts"), "utf8");
  const m = src.match(/export interface KnowledgeHistoryEntry \{[\s\S]*?\n\}/);
  assert.ok(m, "KnowledgeHistoryEntry 를 못 찾았다 — 가드가 스테일하다");
  assert.ok(/body_md: string \| null/.test(m[0]),
    "before/after 의 body_md 가 null 을 못 담는다 — 본문 없는 op(link_category 등)이 빈 본문으로 뭉개진다.");
});

// B2 — 이번에 새로 도입한 op 이 실제로 스캐너에 걸리는지(= 위 미분류 검사가 이 변경을 실제로 덮는지) 확인.
//  이게 없으면 "새 op 을 추가해도 가드가 잡는다"는 주장이 이 변경에 대해선 검증되지 않은 채로 남는다.
t("⑫ 접근범위 잠금 op 이 스캔에 잡히고 분류돼 있다", () => {
  assert.ok(found.has("set_visibility"),
    "set_visibility 를 소스에서 못 찾았다 — 잠금 경로가 지식 감사 헬퍼를 안 쓰고 있다(그러면 이력에 안 남는다)");
  assert.ok(meta.has("set_visibility"), "set_visibility 가 META_OPS 에 없다");
});

console.log(`\n${pass} passed  (스캔한 op ${found.size}종: ${[...found].sort().join(", ")})`);
