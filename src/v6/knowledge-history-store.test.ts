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
import { CONTENT_OPS, META_OPS } from "./knowledge-history-store.js";
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

console.log(`\n${pass} passed  (스캔한 op ${found.size}종: ${[...found].sort().join(", ")})`);
