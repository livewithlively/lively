// 증류 프롬프트·세션 주입에 붙는 조직 서술 형식 블록 테스트.
//
//  회귀 대상 ①: 형식을 켜지 않은 조직의 증류 프롬프트가 한 바이트라도 바뀌는 것(조각화 이후 바이트 동일 계약).
//  회귀 대상 ②: 레인이 format 조각을 덮어쓰면 조직 형식이 빠지는 것 — 레인이 달라도 저장되는 글의 모양은 같아야 한다.
//  회귀 대상 ③: 거부 규칙을 쓰기 전에 알리지 않아, 에이전트가 저장한 뒤 422 로 처음 아는 것.
import assert from "node:assert/strict";
import { buildDistillerPrompt, type DistillerRow } from "./distiller.js";
import { buildWritingGuideBlock, resolveWritingFormat } from "../policies/writing-format.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const mk = (o: Partial<DistillerRow> = {}): DistillerRow => ({
  id: 1, key: "d", label: null, enabled: true, priority: 0,
  match_kinds: null, match_system: null,
  include_channels: null, exclude_channels: null, include_authors: null, exclude_authors: null,
  exclude_bots: false, min_chars: 0, lookback_days: null,
  criteria_md: null, format_md: null, target_category: null, default_type: null,
  name_prefix: null, thread_aware: false,
  prefilter_level: 0, prefilter_rules: null, prompt_sections: null,
  batch_size: 3, batch_max_msgs: 20, mode: "headless", session_ref: null, harness: null, model: null, effort: null, requester: null,
  last_run_at: null, last_status: null, last_summary: null, note: null, updated_at: null,
  ...o,
});
const rows = [{ id: 1, title: "t", body_md: "b" }];
const base = { rows, policySummary: "p" };
const ON = resolveWritingFormat({ enabled: true, rules: { local_path: "reject" }, forbid_terms: ["review-gate"] });
const HEADER = "[조직 서술 형식 — 레인 형식보다 우선]";

t("형식이 꺼져 있거나 넘기지 않으면 증류 프롬프트는 종전과 바이트 동일", () => {
  const d = mk({ format_md: "## 배경\n## 결론" });
  const plain = buildDistillerPrompt({ distiller: d, ...base });
  assert.equal(buildDistillerPrompt({ distiller: d, ...base, writingFormat: resolveWritingFormat({}) }), plain);
  assert.ok(!plain.includes(HEADER));
});
t("켜면 format 조각 바로 뒤에 조직 블록이 붙는다", () => {
  const out = buildDistillerPrompt({ distiller: mk({ format_md: "레인 형식 문구" }), ...base, writingFormat: ON });
  const iFmt = out.indexOf("레인 형식 문구");
  const iOrg = out.indexOf(HEADER);
  assert.ok(iFmt >= 0 && iOrg > iFmt, "레인 형식 뒤");
  assert.ok(out.includes(ON.guide_md.split("\n")[0]));
});
t("레인이 format 조각을 덮어써도 조직 블록은 남는다", () => {
  const d = mk({ prompt_sections: { format: "덮어쓴 형식" } });
  const out = buildDistillerPrompt({ distiller: d, ...base, writingFormat: ON });
  assert.ok(out.includes("덮어쓴 형식"));
  assert.ok(out.includes(HEADER));
});
t("가이드 블록: 꺼지면 빈 글, 켜면 가이드·거부 규칙·금지어", () => {
  assert.equal(buildWritingGuideBlock(resolveWritingFormat({})), "");
  const b = buildWritingGuideBlock(ON);
  assert.ok(b.startsWith(ON.guide_md.trim()));
  assert.match(b, /저장 거부.*local_path/);
  assert.match(b, /review-gate/);
  const noReject = buildWritingGuideBlock(resolveWritingFormat({ enabled: true }));
  assert.doesNotMatch(noReject, /저장 거부/);
  assert.doesNotMatch(noReject, /쓰지 않는 말/);
});
console.log(`distiller-writing-format: ${pass} passed`);
