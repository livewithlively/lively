// 긴 본문을 원문 그대로 떼어 내는 분리 계획(planBodySplit·renderSplitParent)의 상한·무손실·선택 순서·표·코드 블록 규칙을 사양대로 잠근다.
// 실행: 빌드 후 node dist/v6/writing-split.test.js
import assert from "node:assert/strict";
import { planBodySplit, renderSplitParent, PART_TOKEN, type SplitPlan } from "./writing-split.js";

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>) => { await fn(); pass++; console.log(`ok  ${name}`); };

const cp = (s: string) => [...s].length;
const partCap = (limit: number) => Math.floor(limit * 0.9);
const stopAt = (limit: number) => Math.floor(limit * 0.75);
const trimmed = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
const counts = (ls: string[]) => {
  const m = new Map<string, number>();
  for (const l of ls) m.set(l, (m.get(l) ?? 0) + 1);
  return m;
};
const stripBlankEdges = (ls: string[]) => {
  let a = 0;
  let b = ls.length;
  while (a < b && !ls[a].trim()) a++;
  while (b > a && !ls[b - 1].trim()) b--;
  return ls.slice(a, b);
};
const isRun = (hay: string[], needle: string[]) => {
  if (!needle.length) return true;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((l, j) => hay[i + j] === l)) return true;
  }
  return false;
};
const isTableRow = (l: string) => l.trim().startsWith("|");
const isTableSep = (l: string) => /^\|[\s:|-]+\|$/.test(l.trim()) && l.includes("-");
const isFence = (l: string) => /^\s*(```|~~~)/.test(l);

const filler = (tag: string, size: number): string[] => {
  const out: string[] = [];
  let n = 0;
  let i = 0;
  while (n < size) {
    const line = `${tag} 항목 ${i} 의 설명은 결제 재시도 정책과 같은 기준을 따른다.`;
    out.push(line);
    n += cp(line) + 1;
    i++;
  }
  return out;
};

const assertPlan = (body: string, limit: number, plan: SplitPlan) => {
  assert.ok(cp(plan.parent) <= limit, `parent ${cp(plan.parent)} > limit ${limit}`);
  for (const p of plan.parts) assert.ok(cp(p.text) <= partCap(limit), `part ${cp(p.text)} > ${partCap(limit)}`);
  const have = counts([...trimmed(plan.parent), ...plan.parts.flatMap((p) => trimmed(p.text))]);
  for (const [l, n] of counts(trimmed(body))) assert.ok((have.get(l) ?? 0) >= n, `유실된 줄: ${l}`);
  const orig = body.split("\n").filter((l) => l.trim());
  for (const p of plan.parts) {
    const ls = p.text.split("\n").filter((l) => l.trim());
    const verbatim = isRun(orig, ls);
    const tableWithHead = ls.length > 2 && isTableRow(ls[0]) && isTableSep(ls[1]) && isRun(orig, ls.slice(0, 2)) && isRun(orig, ls.slice(2));
    assert.ok(verbatim || tableWithHead, `part 가 원문 연속 조각이 아니다: ${ls[0]}`);
  }
  plan.parts.forEach((_, i) => assert.ok(plan.parent.includes(PART_TOKEN(i)), `parent 에 PART_TOKEN(${i}) 없음`));
  for (const chunk of [plan.parent, ...plan.parts.map((p) => p.text)]) {
    assert.equal(chunk.split("\n").filter(isFence).length % 2, 0, "코드 블록이 쪼개졌다");
  }
};

const mustPlan = (body: string, limit: number) => {
  assert.ok(cp(body) > limit, `전제: 본문 ${cp(body)} 이 limit ${limit} 를 넘어야 한다`);
  const plan = planBodySplit(body, limit);
  assert.ok(plan, "계획이 null 이다");
  assertPlan(body, limit, plan);
  return plan;
};

await t("G limit 이하(코드포인트 기준)면 null", () => {
  const emoji = "🚀".repeat(10);
  for (const [body, limit] of [
    ["짧은 본문이다.", 100],
    ["가".repeat(50), 50],
    [emoji, 10],
  ] as Array<[string, number]>) assert.equal(planBodySplit(body, limit), null, `${cp(body)}/${limit}`);
});

await t("G 결론부가 상한을 넘거나 코드 블록 하나가 상한을 넘으면 null", () => {
  const limit = 600;
  const bigLead = [...filler("결론", 700), "", "## 부록", ...filler("부록", 300)].join("\n");
  const bigCode = [...filler("결론", 80), "", "## 코드", "아래 스크립트를 쓴다.", "```", ...filler("코드", 700), "```"].join("\n");
  for (const [name, body] of [["결론부 초과", bigLead], ["코드 블록 초과", bigCode]]) {
    assert.ok(cp(body) > limit, name);
    assert.equal(planBodySplit(body, limit), null, name);
  }
});

await t("G 이력류 헤딩 절을 큰 절보다 먼저 옮기고 parent 가 목표 이하가 되면 멈춘다", () => {
  const limit = 900;
  for (const kw of ["이력", "경과", "기록", "로그", "원장", "타임라인", "변경", "부록", "사례", "실측", "측정", "history", "log", "changelog", "appendix", "timeline"]) {
    const body = [...filler("결론", 60), "", "## 배경", ...filler("배경", 450), "", `## 운영 ${kw}`, ...filler("운영", 400)].join("\n");
    const plan = mustPlan(body, limit);
    assert.deepEqual(plan.parts.map((p) => p.heading), [`운영 ${kw}`], kw);
    assert.ok(cp(plan.parent) <= stopAt(limit), kw);
    assert.ok(trimmed(plan.parent).includes(filler("배경", 1)[0]), kw);
  }
});

await t("G 이력류가 없으면 큰 절부터 옮긴다", () => {
  const limit = 1000;
  const body = [...filler("결론", 60), "", "## 구성", ...filler("구성", 200), "", "## 설계", ...filler("설계", 500), "", "## 절차", ...filler("절차", 300)].join("\n");
  const plan = mustPlan(body, limit);
  assert.deepEqual(plan.parts.map((p) => p.heading), ["설계"]);
  assert.ok(cp(plan.parent) <= stopAt(limit));
});

await t("G 절을 통째로 옮기면 parent 에 헤딩 줄과 자리표시가 남고 part 는 헤딩 줄로 시작한다", () => {
  const limit = 1000;
  const body = [...filler("결론", 60), "", "## 구성", ...filler("구성", 200), "", "## 설계", ...filler("설계", 500), "", "## 절차", ...filler("절차", 300)].join("\n");
  const plan = mustPlan(body, limit);
  const parentLines = plan.parent.split("\n").map((l) => l.trim());
  assert.ok(parentLines.includes("## 설계"));
  assert.ok(plan.parent.includes(PART_TOKEN(0)));
  assert.equal(stripBlankEdges(plan.parts[0].text.split("\n"))[0], "## 설계");
  assert.ok(!parentLines.includes(filler("설계", 1)[0]));
});

await t("G renderSplitParent 는 PART_TOKEN(i) 를 [[names[i]]] 로 바꾼다", () => {
  const limit = 1000;
  const body = [...filler("결론", 60), "", "## 구성", ...filler("구성", 200), "", "## 설계", ...filler("설계", 500), "", "## 절차", ...filler("절차", 300)].join("\n");
  const plan = mustPlan(body, limit);
  const names = plan.parts.map((_, i) => `payment-retry-part-${i + 1}`);
  const want = plan.parts.reduce((s, _, i) => s.split(PART_TOKEN(i)).join(`[[${names[i]}]]`), plan.parent);
  assert.equal(renderSplitParent(plan, names), want);
  assert.ok(want.includes("[[payment-retry-part-1]]"));
});

await t("G 첫 ## 전 결론부는 parent 에 남는다", () => {
  const limit = 1000;
  const lead = filler("결론", 150);
  const body = [...lead, "", "## 배경", ...filler("배경", 500), "", "## 설계", ...filler("설계", 500)].join("\n");
  const plan = mustPlan(body, limit);
  const parentLines = trimmed(plan.parent);
  for (const l of lead) assert.ok(parentLines.includes(l), l);
});

await t("G 절 끝 표는 머리 두 줄을 parent 절 끝에 남기고 행만 상한 안의 여러 part 로 나누며 part 마다 표 머리를 붙인다", () => {
  const limit = 1000;
  const header = "| 회차 | 값 | 비고 |";
  const sep = "|---|---|---|";
  const rows = Array.from({ length: 90 }, (_, i) => `| ${i + 1} | 값 ${i * 7} | 비고 문구 ${i + 1} |`);
  const intro = "측정 결과는 아래 표와 같다.";
  const body = [...filler("결론", 60), "", "## 결과", intro, "", header, sep, ...rows].join("\n");
  const plan = mustPlan(body, limit);
  assert.ok(plan.parts.length >= 2);
  const moved: string[] = [];
  for (const p of plan.parts) {
    const ls = stripBlankEdges(p.text.split("\n"));
    assert.equal(ls[0], header);
    assert.equal(ls[1], sep);
    moved.push(...ls.slice(2));
  }
  assert.deepEqual(moved, rows);
  const parentLines = plan.parent.split("\n").map((l) => l.trim());
  for (const l of ["## 결과", intro, header, sep]) assert.ok(parentLines.includes(l), l);
  for (const r of rows) assert.ok(!parentLines.includes(r), r);
  assert.deepEqual(trimmed(plan.parent).slice(-2), [header, sep]);
});

await t("G 펜스 코드 블록 안의 ## 는 헤딩이 아니고 코드 블록은 쪼개지 않는다", () => {
  const limit = 800;
  const code = ["```sh", ...filler("코드 앞", 250), "## 가짜 헤딩", ...filler("코드 뒤", 250), "```"].join("\n");
  const body = [...filler("결론", 60), "", "## 설계", "설계 스크립트는 아래와 같다.", code, "", "## 운영", ...filler("운영", 200)].join("\n");
  const plan = mustPlan(body, limit);
  assert.deepEqual(plan.parts.map((p) => p.heading), ["설계"]);
  assert.ok(plan.parts[0].text.includes(code));
});

await t("G 열린 펜스 안의 정보 문자열 붙은 ``` 줄은 펜스를 닫지 않는다 — 그 뒤 ## 를 헤딩으로 보지 않는다", () => {
  const limit = 800;
  const code = ["```md", ...filler("코드 앞", 200), "```python", "## 가짜 헤딩", ...filler("코드 뒤", 200), "```"].join("\n");
  const body = [...filler("결론", 60), "", "## 설계", "설계 문서는 아래와 같다.", code, "", "## 운영", ...filler("운영", 200)].join("\n");
  //  mustPlan 의 펜스 짝 검사는 정보 문자열 붙은 ``` 줄도 펜스로 세므로 여기선 쓰지 않는다.
  const plan = planBodySplit(body, limit);
  assert.ok(plan, "계획이 선다");
  assert.ok(plan.parts.every((p) => p.heading !== "가짜 헤딩"), JSON.stringify(plan.parts.map((p) => p.heading)));
  assert.ok(plan.parts.some((p) => p.text.includes(code)), "코드 블록이 통째로 옮겨진다");
});

await t("G 머리(구분줄) 없는 | 행 덩어리는 표로 다루지 않는다 — 앞 두 행을 조각마다 복제하지 않는다", () => {
  const rows = Array.from({ length: 40 }, (_, i) => `| 항목 ${i} | ${"값".repeat(20)} |`);
  const body = ["결론은 이 문장이다.", "", ...rows].join("\n");
  const plan = planBodySplit(body, 800);
  if (plan) {
    const all = plan.parts.flatMap((p) => p.text.split("\n")).concat(plan.parent.split("\n"));
    for (const r of rows.slice(0, 2)) assert.equal(all.filter((l) => l === r).length, 1, r);
  }
});

await t("G 헤딩이 없는 글은 첫 문단을 parent 에 남기고 나머지를 heading null 로 옮긴다", () => {
  const limit = 1000;
  const first = filler("결론", 300);
  const rest = [filler("둘째", 250), filler("셋째", 250), filler("넷째", 250)];
  const body = [first, ...rest].map((p) => p.join("\n")).join("\n\n");
  const plan = mustPlan(body, limit);
  assert.ok(plan.parts.length >= 1);
  for (const p of plan.parts) assert.equal(p.heading, null);
  const parentLines = trimmed(plan.parent);
  for (const l of first) assert.ok(parentLines.includes(l), l);
  for (const l of rest.flat()) assert.ok(!parentLines.includes(l), l);
});

await t("G heading 은 헤딩 줄에서 #·이모지·** 를 뗀 글자다", () => {
  const limit = 900;
  const body = [...filler("결론", 60), "", "## 배경", ...filler("배경", 300), "", "## 🚀 **변경 이력**", ...filler("이력", 600)].join("\n");
  const plan = mustPlan(body, limit);
  assert.deepEqual(plan.parts.map((p) => p.heading?.trim()), ["변경 이력"]);
});

const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};
const WORDS = ["결제", "재시도", "정책", "배치", "정산", "대출", "상환", "한도", "검증", "설정", "기준", "모듈", "서버", "지표"];
const KEY_HEADINGS = ["변경 이력", "운영 로그", "장애 타임라인", "부록", "실측 결과", "history", "changelog"];
const PLAIN_HEADINGS = ["배경", "설계", "구성", "정책", "절차", "운영 방침", "의존성", "보안"];
const isKeyHeading = (h: string) => KEY_HEADINGS.some((k) => h.startsWith(k));

type GenSection = { heading: string; lines: string[]; tableIntro?: string; rows?: string[] };
type GenDoc = { body: string; limit: number; lead: string[]; sections: GenSection[]; headless: boolean };

const genDoc = (seed: number): GenDoc => {
  const r = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  let uid = 0;
  const sentence = () => `${Array.from({ length: 4 + Math.floor(r() * 8) }, () => pick(WORDS)).join(" ")} 기준을 따른다 (L${uid++})`;
  const para = (size: number) => {
    const out: string[] = [];
    let n = 0;
    while (n < size) { const s = sentence(); out.push(s); n += cp(s) + 1; }
    return out;
  };
  const limit = pick([1200, 2000, 3000]);
  const scale = limit / 2000;
  if (r() < 0.2) {
    const paras = [para(300 * scale + r() * 200 * scale)];
    const k = 2 + Math.floor(r() * 5);
    for (let i = 0; i < k; i++) paras.push(para(100 * scale + r() * 350 * scale));
    return { body: paras.map((p) => p.join("\n")).join("\n\n"), limit, lead: paras[0], sections: [], headless: true };
  }
  const lead = para(40 * scale + r() * 140 * scale);
  const sections: GenSection[] = [];
  const n = 1 + Math.floor(r() * 6);
  let tables = 0;
  for (let i = 0; i < n; i++) {
    const heading = `${r() < 0.35 ? pick(KEY_HEADINGS) : pick(PLAIN_HEADINGS)} ${i + 1}`;
    const kind = r();
    if (kind < 0.25 && tables < 2) {
      tables++;
      const tableIntro = sentence();
      const rows = Array.from({ length: 5 + Math.floor(r() * 75 * scale) }, () => `| ${uid++} | ${pick(WORDS)} | ${pick(WORDS)} ${pick(WORDS)} |`);
      sections.push({ heading, tableIntro, rows, lines: [`## ${heading}`, tableIntro, "", "| 번호 | 항목 | 비고 |", "|---|---|---|", ...rows] });
    } else if (kind < 0.45) {
      const code: string[] = [];
      let size = 0;
      const target = 100 * scale + r() * 400 * scale;
      while (size < target) {
        const l = r() < 0.15 ? `## 코드 안 헤딩 ${uid++}` : `echo ${pick(WORDS)} ${uid++}`;
        code.push(l);
        size += cp(l) + 1;
      }
      sections.push({ heading, lines: [`## ${heading}`, sentence(), "```sh", ...code, "```", sentence()] });
    } else {
      const lines: string[] = [`## ${heading}`];
      const k = 1 + Math.floor(r() * 3);
      for (let j = 0; j < k; j++) lines.push(...para(50 * scale + r() * 350 * scale), "");
      lines.push(sentence());
      sections.push({ heading, lines });
    }
  }
  const body = [...lead, "", ...sections.flatMap((s) => [...s.lines, ""])].join("\n").trimEnd();
  return { body, limit, lead, sections, headless: false };
};

await t("G 속성: 무작위 문서 300건에서 상한·무손실·결론부 잔류·표 머리·코드 펜스·이력류 우선·null 조건을 지킨다", () => {
  let planned = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const d = genDoc(seed);
    const plan = planBodySplit(d.body, d.limit);
    const ctx = `seed=${seed} limit=${d.limit} len=${cp(d.body)}`;
    if (cp(d.body) <= d.limit) { assert.equal(plan, null, ctx); continue; }
    if (d.headless) {
      if (!plan) continue;
      assertPlan(d.body, d.limit, plan);
      for (const p of plan.parts) assert.equal(p.heading, null, ctx);
      const parentLines = trimmed(plan.parent);
      for (const l of d.lead) assert.ok(parentLines.includes(l), `${ctx} 첫 문단 유실 ${l}`);
      continue;
    }
    assert.ok(plan, `${ctx} 계획이 null`);
    planned++;
    assertPlan(d.body, d.limit, plan);
    const parentLines = trimmed(plan.parent);
    for (const l of d.lead) assert.ok(parentLines.includes(l), `${ctx} 결론부 유실 ${l}`);
    for (const p of plan.parts) {
      assert.ok(!(p.heading ?? "").includes("코드 안 헤딩"), `${ctx} 코드 안 ## 를 헤딩으로 봤다`);
      const ls = stripBlankEdges(p.text.split("\n"));
      if (ls[0].startsWith("## ")) assert.ok(parentLines.includes(ls[0].trim()), `${ctx} parent 에 헤딩 줄 없음 ${ls[0]}`);
      else if (ls.some(isTableRow)) {
        assert.ok(isTableRow(ls[0]) && isTableSep(ls[1]), `${ctx} 표 part 에 머리 두 줄이 없다`);
      }
    }
    for (const s of d.sections) {
      if (!s.rows || !s.tableIntro) continue;
      if (parentLines.includes(s.tableIntro) && !parentLines.includes(s.rows[0].trim())) {
        const at = parentLines.indexOf(`## ${s.heading}`);
        const after = parentLines.slice(at);
        assert.ok(after.includes("| 번호 | 항목 | 비고 |") && after.includes("|---|---|---|"), `${ctx} 표 머리가 parent 절 끝에 없다`);
      }
    }
    const moved = (s: GenSection) => !parentLines.includes(s.lines[s.lines.length - 1].trim());
    if (d.sections.some((s) => !isKeyHeading(s.heading) && moved(s))) {
      for (const s of d.sections.filter((x) => isKeyHeading(x.heading))) {
        assert.ok(moved(s), `${ctx} 이력류 '${s.heading}' 보다 일반 절을 먼저 옮겼다`);
      }
    }
  }
  assert.ok(planned >= 50, `헤딩 있는 초과 문서가 너무 적다: ${planned}`);
});

await t("G 행 사이에 빈 줄이 낀 원장 표도 표로 본다 — 머리는 남고 행은 빈 줄 없이 옮겨진다", () => {
  const limit = 2000;
  const rows = Array.from({ length: 40 }, (_, k) => `| 2026-11-${String((k % 28) + 1).padStart(2, "0")} | r${k} | ${"v".repeat(40)} |`);
  const body = ["관측 로그다.", "", "## 발동 로그", "", "| date | id | note |", "|---|---|---|", "", ...rows.slice(0, 20), "", ...rows.slice(20)].join("\n");
  const plan = planBodySplit(body, limit)!;
  assert.ok(plan, "계획이 선다");
  const parentLines = plan.parent.trimEnd().split("\n");
  assert.deepEqual(parentLines.slice(-2), ["| date | id | note |", "|---|---|---|"]);
  for (const p of plan.parts) {
    const ls = p.text.split("\n");
    assert.deepEqual(ls.slice(0, 2), ["| date | id | note |", "|---|---|---|"]);
    assert.ok(ls.every((l) => l.trim()), "옮긴 표 안에 빈 줄이 없다");
  }
  assert.deepEqual(plan.parts.flatMap((p) => p.text.split("\n").slice(2)), rows, "행이 순서대로 전부 옮겨진다");
});

await t("G 절 끝에 표가 둘이면 표 행 경로를 쓰지 않는다 — 두 번째 표의 머리가 첫 표의 행이 되지 않는다", () => {
  const limit = 1500;
  const rowsA = Array.from({ length: 30 }, (_, k) => `| a${k} | ${"v".repeat(40)} |`);
  const rowsB = Array.from({ length: 30 }, (_, k) => `| b${k} | c | ${"w".repeat(40)} |`);
  const body = ["결론이다.", "", "## 기록", "", "| a | v |", "|---|---|", ...rowsA, "", "| b | c | w |", "|---|---|---|", ...rowsB].join("\n");
  assert.ok([...body].length > limit);
  const plan = planBodySplit(body, limit);
  for (const p of plan?.parts ?? []) {
    const ls = p.text.split("\n");
    const i = ls.indexOf("| b | c | w |");
    if (i > 0) assert.ok(!ls[i - 1].startsWith("| a"), "두 번째 표의 머리가 첫 표 행 바로 뒤에 붙지 않는다");
  }
});

await t("G 헤딩 없는 글의 맨 앞 H1 은 결론 문단으로 치지 않는다 — 결론 문장이 남는다", () => {
  const body = ["# 제목", "", "결론 문장이다.", "", ...Array.from({ length: 30 }, (_, k) => `문단 ${k} ${"가".repeat(80)}`.concat("\n"))].join("\n");
  const plan = planBodySplit(body, 1500)!;
  assert.ok(plan.parent.includes("결론 문장이다."), plan.parent.slice(0, 200));
});

await t("G 남는 본문의 상한은 자리표시가 아니라 최대 길이 이름(64자)을 채운 뒤의 길이로 잰다", () => {
  const limit = 1000;
  const body = ["결".repeat(935), "", "## 이력", "", ...Array.from({ length: 6 }, (_, k) => `기록 ${k} ${"나".repeat(40)}`)].join("\n");
  const plan = planBodySplit(body, limit);
  assert.ok(plan === null || [...renderSplitParent(plan, plan.parts.map(() => "n".repeat(64)))].length <= limit);
});
console.log(`writing-split: ${pass} passed`);
