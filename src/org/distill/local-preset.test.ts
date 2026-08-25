// #1881 L3 내 컴퓨터 자료 증류기 프리셋 — 순수 초안 회귀(distiller-authoring 함정 잠금). DB 불요.
//   실행: npm run build && node dist/org/distill/local-preset.test.js
import assert from "node:assert/strict";
import { localFilesDistillerDraft, LOCAL_DISTILLER_KEY, LOCAL_DISTILL_JOB_ID } from "./local-preset.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const d = localFilesDistillerDraft();

t("catch-all 스코프 — match_system=local · kind=local_file · 채널/작성자 제한 없음 · 낮은 priority", () => {
  assert.equal(d.key, LOCAL_DISTILLER_KEY);
  assert.equal(d.match_system, "local");
  assert.deepEqual(d.match_kinds, ["local_file"]);
  assert.equal(d.include_channels, null); assert.equal(d.exclude_channels, null);
  assert.equal(d.include_authors, null); assert.equal(d.exclude_authors, null);
  assert.ok((d.priority ?? 0) < 0);
});
t("꺼진 채로 만든다 · 파일 단위(thread_aware=false) · 사전필터 0 · headless", () => {
  assert.equal(d.enabled, false);
  assert.equal(d.thread_aware, false);
  assert.equal(d.prefilter_level, 0);
  assert.equal(d.mode, "headless");
  assert.ok((d.batch_size ?? 0) >= 1 && (d.batch_size ?? 0) <= 200);
});
t("기준: 형태별 규칙·제외·절대 기준·[BINARY]/hwp 안내·중복 규약 포함, lifecycle 지시 없음", () => {
  const c = d.criteria_md ?? "";
  for (const must of ["위키형", "회의록", "계약", "저널", "코드 문서", "개인 노트", "[BINARY]", "source_artifact", "hwp", "knowledge_similar", "source_link_knowledge", "백분위"]) {
    assert.ok(c.includes(must), `criteria_md 에 '${must}' 없음`);
  }
  assert.ok(!/lifecycle\s*[:=]\s*['"]?(pending|active)/.test(c), "lifecycle 을 직접 지정하면 안 된다");
  assert.ok(c.includes("lifecycle 을 직접 지정하지 마라"));
});
t("형식: 출처 한 줄·자료 id 나열 금지·인용 규칙", () => {
  const f = d.format_md ?? "";
  assert.ok(f.includes("출처") && f.includes("자료 id 를 본문에 나열하지 마라") && f.includes("원문 표현 그대로"));
});
t("잡 id 는 증류기 전용 네임스페이스", () => { assert.equal(LOCAL_DISTILL_JOB_ID, "distill-local-files"); });

console.log(`\n${pass} passed (local-files 증류기 프리셋)`);
