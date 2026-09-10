// 「지금 볼 것」 해제 + 프로젝트 카드 자리 (#3856) — 값으로 고정한다.
//  사양·엣지 표(E1~E21)는 스크래치패드 spec-3856.md — 아래 이름의 번호가 그 행이다(행 하나도 안 빠지게).
//
//  이 규칙이 두 번 틀렸다:
//   ① 첫 구현(activeHold)은 «세션에서 나오면 해제» 만 보고 «가라앉았나» 를 안 봐, 아직 작업 중인 세션을 잠깐
//     열었다 나와도 자리를 놓았다 — 프로젝트 축에서는 그 행이 카드의 첫 행이라 **카드가 통째로 이사**했다
//     (원준 2026-09-02 «질문이 끝나서 그런지 중간중간 튄다»).
//   ② `301d8234`(#2534 2차)는 해제를 «목록에서 빠질 때» 로만 좁혀 튐을 멎게 했지만, 상민님 원안(«확인하고 나오면
//     내려간다»)이 통째로 사라져 **아무것도 안 내려가는 목록**이 됐다. 카드 문제는 행 쪽에서 우회됐을 뿐이다.
//
//  ⚠ 값과 소스텍스트를 함께 보는 이유(obs-carry.test.mjs 와 같다): 규칙이 맞아도 화면이 그걸 안 부르면 그대로다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };

const { stepRowHold, stepCardHold, orderCards, pruneHolds, groupTier, PRIORITY_GROUP: PRI, PINNED_GROUP: PIN, QUIET_RANK } =
  await import(join(root, "public/app/v2/hold-rules.js"));

// ── 행 판정 도우미 ─────────────────────────────────────────────────────────
//  한 판의 사실. 기본값은 «조용한 날짜 행 · 안 봄 · 관측됨 · 고정 아님».
const facts = (o = {}) => ({ group: "오늘", rank: QUIET_RANK, hot: false, viewing: false, known: true, pinned: false, ...o });
//  볼 일이 있는 판(사실의 묶음이 곧 「지금 볼 것」). 보고 있어 점을 끈 '작업 완료' 는 hot 이지만 묶음은 날짜다.
const hotFacts = (o = {}) => facts({ group: PRI, rank: 2, hot: true, ...o });
/** 여러 판을 이어 돌리고 판마다의 묶음을 돌려준다. */
function run(steps, start) {
  let hold = start; const groups = [];
  for (const f of steps) { const r = stepRowHold(hold, f); hold = r.hold; groups.push(r.group); }
  return { hold, groups };
}

// ── E1 원안 경로 ────────────────────────────────────────────────────────────
{
  const { hold, groups } = run([
    hotFacts(),                                                // 승격(안 봄)
    facts({ hot: true, viewing: true }),                       // 열어 봄 — 점은 꺼졌지만(묶음=날짜) 아직 가라앉지 않음
    facts({ hot: false, viewing: true }),                      // 보는 중에 가라앉음
    facts({ hot: false, viewing: false }),                     // 다른 데로 감
  ]);
  assert.deepEqual(groups, [PRI, PRI, PRI, "오늘"], "마지막 판에서만 내려가야 한다");
  assert.equal(hold, undefined, "내려간 행의 자물쇠는 버려진다");
  ok("E1 원안 경로 — 올라감 → 열어 봄 → 가라앉음 → 나감, 나가는 판에서만 내려간다");
}

// ── E2 보는 중에 끝남 ───────────────────────────────────────────────────────
{
  const { hold, groups } = run([hotFacts(), facts({ hot: true, viewing: true }), facts({ hot: false, viewing: true }), facts({ hot: false, viewing: true })]);
  assert.deepEqual(groups, [PRI, PRI, PRI, PRI]);
  assert.ok(hold && hold.seen);
  ok("E2 보는 중에 끝나도 안 내려간다 — 원준 신고 «질문이 끝나서 중간중간 튄다» 의 자리");
}

// ── E3 안 열어 보고 점만 꺼짐 ───────────────────────────────────────────────
{
  const { hold, groups } = run([hotFacts(), facts({ hot: false }), facts({ hot: false })]);
  assert.deepEqual(groups, [PRI, PRI, PRI]);
  assert.ok(hold && hold.seen === false);
  ok("E3 열어 보지도 않았는데 상태만 꺼진 행은 안 내려간다 — 확인하지 않은 것은 치운 것이 아니다");
}

// ── E4 열어 봤지만 아직 작업 중인데 잠깐 나옴 ────────────────────────────────
{
  //  확인 필요(0)로 올라가 열어 본 행이, 나와 있는 사이 작업 중(2)으로 바뀌었다 — 볼 일은 아직 남아 있다.
  const { hold, groups } = run([hotFacts({ rank: 0 }), hotFacts({ rank: 0, viewing: true }), hotFacts({ rank: 2, viewing: false })]);
  assert.deepEqual(groups, [PRI, PRI, PRI]);
  //  ⚠ 묶음만 보면 이 조건이 안 잡힌다 — 볼 일이 남은 행은 풀려도 곧바로 다시 붙들려 같은 묶음에 서기 때문이다.
  //   풀렸다 다시 잡히면 **순위가 가라앉고 «봤다» 가 지워진다** — 그 둘로 잰다.
  assert.equal(hold.rank, 0, "볼 일이 남은 동안엔 자물쇠가 그대로다 — 풀렸다 다시 잡히면 순위가 가라앉는다");
  assert.equal(hold.seen, true, "열어 본 사실은 볼 일이 남아 있는 동안 지워지지 않는다");
  //  그 뒤 가라앉으면(여전히 나와 있음) 원안대로 내려간다 — 이미 열어 봤으므로.
  assert.equal(stepRowHold(hold, facts({ hot: false, viewing: false })).group, "오늘");
  ok("E4 아직 볼 일이 남은 행은 잠깐 나와도 안 내려가고 자물쇠(순위·«봤다»)도 그대로 — 가라앉으면 그때 내려간다");
}

// ── E5 상태를 모름 ──────────────────────────────────────────────────────────
{
  const seen = run([hotFacts(), facts({ hot: true, viewing: true })]).hold;
  const unknown = stepRowHold(seen, facts({ hot: false, viewing: false, known: false }));
  assert.equal(unknown.group, PRI, "관측 못 한 판에는 내려가지 않는다");
  assert.ok(unknown.hold);
  const known = stepRowHold(unknown.hold, facts({ hot: false, viewing: false, known: true }));
  assert.equal(known.group, "오늘", "관측이 돌아와 가라앉음이 확인되면 그때 내려간다");
  ok("E5 «모름» 은 자리를 바꾸는 사유가 아니다 — 관측이 돌아와야 내려간다");
}

// ── E6 보는 중에 승격 ───────────────────────────────────────────────────────
{
  const { hold, groups } = run([hotFacts({ viewing: true }), facts({ hot: false, viewing: true }), facts({ hot: false, viewing: false })]);
  assert.deepEqual(groups, [PRI, PRI, "오늘"]);
  assert.equal(hold, undefined);
  ok("E6 보고 있던 중에 볼 일이 생긴 행은 그 순간 이미 본 것 — 가라앉고 나가면 내려간다");
}

// ── E7 해제 뒤 재승격 ───────────────────────────────────────────────────────
{
  const released = run([hotFacts({ viewing: true }), facts({ viewing: false })]);
  assert.equal(released.hold, undefined);
  const again = run([hotFacts(), facts({ hot: false })], released.hold);
  assert.deepEqual(again.groups, [PRI, PRI], "새 볼 일은 새로 확인해야 내려간다");
  assert.equal(again.hold.seen, false);
  ok("E7 내려간 행에 다시 볼 일이 생기면 다시 올라가고, «봤다» 는 새로 시작한다");
}

// ── E8 날짜 → 볼 일 ─────────────────────────────────────────────────────────
{
  const r = stepRowHold(undefined, hotFacts({ rank: 0 }));
  assert.equal(r.group, PRI); assert.equal(r.rank, 0);
  const fromQuiet = run([facts(), facts(), hotFacts()]);
  assert.deepEqual(fromQuiet.groups, ["오늘", "오늘", PRI]);
  ok("E8 볼 일이 생기면 즉시 올라간다(위로는 즉시)");
}

// ── E9 같은 묶음 안 순위는 안 가라앉는다 ────────────────────────────────────
{
  const w = stepRowHold(undefined, hotFacts({ rank: 0 }));
  const b = stepRowHold(w.hold, hotFacts({ rank: 2 }));
  assert.equal(b.rank, 0, "확인 필요(0)로 섰던 행이 작업 중(2)이 돼도 뒤로 안 밀린다");
  ok("E9 「지금 볼 것」 안에서 뒤로 밀리는 것도 이사다 — 순위는 좋아지기만 한다");
}

// ── E10 고정 ────────────────────────────────────────────────────────────────
{
  const held = stepRowHold(undefined, hotFacts()).hold;
  const r = stepRowHold(held, facts({ group: PIN, pinned: true, hot: true }));
  assert.equal(r.hold, undefined); assert.equal(r.group, PIN);
  ok("E10 고정한 행은 자물쇠와 무관하다 — 풀렸을 때 낡은 자물쇠가 남지 않는다");
}

// ── E11 목록에서 빠진 것의 자물쇠는 버린다 ──────────────────────────────────
{
  const m = new Map([["sess:a", 1], ["sess:b", 2], ["sess:c", 3]]);
  pruneHolds(m, new Set(["sess:a", "sess:c"]));
  assert.deepEqual([...m.keys()], ["sess:a", "sess:c"]);
  const cards = new Map([["p:1", { bucket: PRI, rank: 0, at: 1 }], ["p:2", { bucket: "오늘", rank: 9, at: 2 }]]);
  pruneHolds(cards, new Map([["p:2", {}]]));
  assert.deepEqual([...cards.keys()], ["p:2"]);
  ok("E11 목록에서 빠진 행·카드의 자물쇠는 버리고 남은 것은 지킨다(누수 없음)");
}

// ══ 카드 — 세션 축 정렬(사양 그대로) 위에 카드 규칙을 올려 판을 이어 그린다 ══════════
//  세션 축: 층 → 「지금 볼 것」은 순위 → 최신 · 날짜 묶음끼리는 최신 묶음 먼저 → 같은 묶음은 최신.
function sessionAxis(rows) {
  const dayOf = new Map();
  for (const r of rows) if (groupTier(r.group) === 2) dayOf.set(r.group, Math.max(dayOf.get(r.group) || 0, r.at));
  return [...rows].sort((a, b) => {
    const t = groupTier(a.group) - groupTier(b.group); if (t) return t;
    if (groupTier(a.group) === 1) return a.rank - b.rank || b.at - a.at;
    if (a.group !== b.group) return (dayOf.get(b.group) || 0) - (dayOf.get(a.group) || 0);
    return b.at - a.at;
  });
}
/** 한 판의 카드 목록 — 프로젝트 축(side.ts projGroups)과 같은 순서로 규칙을 부른다. */
function paintCards(rows, mem) {
  const sorted = sessionAxis(rows);
  const cards = []; const by = new Map();
  for (const r of sorted) {
    let c = by.get(r.proj);
    if (!c) { c = { key: r.proj, bucket: r.group, rank: r.rank, at: r.at, active: false }; by.set(r.proj, c); cards.push(c); }
    if (r.active) c.active = true;
  }
  for (const c of cards) {
    const s = stepCardHold(mem.get(c.key), { bucket: c.bucket, rank: c.rank, at: c.at, viewing: c.active, pinned: false });
    if (s.hold) mem.set(c.key, s.hold); else mem.delete(c.key);
    Object.assign(c, { bucket: s.bucket, rank: s.rank, at: s.at });
  }
  pruneHolds(mem, by);
  const seq = []; for (const r of sorted) if (!seq.includes(r.group)) seq.push(r.group);
  return orderCards(cards, seq);
}
const row = (proj, group, rank, at, active = false) => ({ proj, group, rank, at, active });
const layout = (cards) => cards.map((c) => `${c.key}@${c.bucket}`);

// ── E12 첫 행이 해제돼도 다른 붙든 행이 있으면 카드는 그대로 ────────────────
{
  const mem = new Map();
  paintCards([row("p:1", PRI, 0, 100), row("p:1", PRI, 2, 90), row("p:2", "오늘", 9, 80)], mem);
  const after = paintCards([row("p:1", "오늘", 9, 100), row("p:1", PRI, 2, 90), row("p:2", "오늘", 9, 80)], mem);
  assert.deepEqual(layout(after), [`p:1@${PRI}`, "p:2@오늘"]);
  ok("E12 카드 첫 행이 해제돼도 같은 카드에 붙든 행이 남아 있으면 카드는 「지금 볼 것」에 머문다");
}

// ── E13 마지막 붙든 행 해제 + 카드 안 봄 → 내려감 ───────────────────────────
{
  const mem = new Map();
  paintCards([row("p:1", PRI, 2, 100), row("p:2", "오늘", 9, 80)], mem);
  const after = paintCards([row("p:1", "오늘", 9, 100), row("p:2", "오늘", 9, 80)], mem);
  assert.deepEqual(layout(after), ["p:1@오늘", "p:2@오늘"]);
  ok("E13 카드 안 마지막 붙든 행이 해제되고 그 카드를 안 보고 있으면 카드도 내려간다");
}

// ── E14 마지막 붙든 행 해제 + 같은 카드의 다른 행을 보는 중 → 안 내려감 ──────
{
  const mem = new Map();
  paintCards([row("p:1", PRI, 2, 100), row("p:1", "오늘", 9, 60), row("p:2", "오늘", 9, 80)], mem);
  const viewing = paintCards([row("p:1", "오늘", 9, 100), row("p:1", "오늘", 9, 60, true), row("p:2", "오늘", 9, 80)], mem);
  assert.deepEqual(layout(viewing), [`p:1@${PRI}`, "p:2@오늘"], "그 카드 안을 보고 있는 동안엔 카드가 발밑에서 안 빠진다");
  const left = paintCards([row("p:1", "오늘", 9, 100), row("p:1", "오늘", 9, 60), row("p:2", "오늘", 9, 80)], mem);
  assert.deepEqual(layout(left), ["p:1@오늘", "p:2@오늘"], "나오면 그때 내려간다");
  ok("E14 카드 안을 보는 동안엔 카드가 안 내려가고, 나오면 내려간다");
}

// ── E15 같은 묶음 두 카드 — 뒤 카드의 첫 행 시각이 갱신돼도 순서 그대로 ──────
{
  const mem = new Map();
  const first = paintCards([row("p:A", "오늘", 9, 200), row("p:B", "오늘", 9, 100)], mem);
  assert.deepEqual(first.map((c) => c.key), ["p:A", "p:B"]);
  const later = paintCards([row("p:A", "오늘", 9, 200), row("p:B", "오늘", 9, 100), row("p:B", "오늘", 9, 300)], mem);
  assert.deepEqual(later.map((c) => c.key), ["p:A", "p:B"], "카드는 그 묶음에 들어온 순간의 시각으로 선다");
  ok("E15 카드끼리 순서가 행 시각 갱신으로 흔들리지 않는다");
}

// ── E16 날짜 카드가 「지금 볼 것」으로 — 즉시, 새 시각으로 다시 얼림 ─────────
{
  const mem = new Map();
  paintCards([row("p:A", "오늘", 9, 200), row("p:B", "오늘", 9, 100)], mem);
  const up = paintCards([row("p:A", "오늘", 9, 200), row("p:B", PRI, 2, 500)], mem);
  assert.deepEqual(layout(up), [`p:B@${PRI}`, "p:A@오늘"]);
  assert.equal(mem.get("p:B").at, 500);
  ok("E16 카드가 위 묶음으로 가는 것은 즉시다 — 그 묶음에 들어온 순간으로 시각을 다시 얼린다");
}

// ── E17 같은 「지금 볼 것」 안에서 순위가 좋아지면 즉시 앞으로, 나빠지진 않는다 ─
{
  const mem = new Map();
  const a = paintCards([row("p:A", PRI, 2, 100), row("p:B", PRI, 1, 50)], mem);
  assert.deepEqual(a.map((c) => c.key), ["p:B", "p:A"]);
  const better = paintCards([row("p:A", PRI, 0, 100), row("p:B", PRI, 1, 50)], mem);
  assert.deepEqual(better.map((c) => c.key), ["p:A", "p:B"], "확인 필요가 생긴 카드는 즉시 앞으로");
  const worse = paintCards([row("p:A", PRI, 2, 100), row("p:B", PRI, 1, 50)], mem);
  assert.deepEqual(worse.map((c) => c.key), ["p:A", "p:B"], "순위가 나빠져도 뒤로 안 밀린다");
  ok("E17 카드 순위는 좋아지기만 한다 — 좋아지면 즉시 앞으로, 나빠져도 제자리");
}

// ── E18 고정 카드 ───────────────────────────────────────────────────────────
{
  const r = stepCardHold({ bucket: PRI, rank: 0, at: 1 }, { bucket: "오늘", rank: 9, at: 9, viewing: true, pinned: true });
  assert.equal(r.hold, undefined);
  assert.deepEqual([r.bucket, r.rank, r.at], ["오늘", 9, 9]);
  ok("E18 카드째 고정한 카드는 자물쇠와 무관하다");
}

// ── E19 자물쇠가 아무것도 안 붙든 판 — 카드 순서 = 세션 축 첫 행 순서 ────────
{
  const rows = [
    row("p:3", "어제", 9, 40), row("p:1", "오늘", 9, 300), row("p:2", PRI, 1, 10), row("p:4", PRI, 0, 5),
    row("p:1", PRI, 2, 20), row("p:5", "오늘", 9, 250), row("p:3", "오늘", 9, 280), row("p:6", "9월 7일", 9, 1),
  ];
  const firstSeen = []; for (const r of sessionAxis(rows)) if (!firstSeen.includes(r.proj)) firstSeen.push(r.proj);
  const cards = paintCards(rows, new Map());
  assert.deepEqual(cards.map((c) => c.key), firstSeen);
  ok("E19 자물쇠가 아무것도 안 붙든 판에서 카드 순서는 세션 축의 첫 행 순서와 같다(두 뷰가 안 갈라진다)");
}

// ── E20 두 뷰가 같은 판정을 한다 ────────────────────────────────────────────
{
  //  같은 행을 두 뷰로: 행 판정이 준 묶음이 곧 카드의 묶음이어야 한다(한 행짜리 카드).
  const mem = new Map();
  let h;
  const seq = [hotFacts(), facts({ hot: true, viewing: true }), facts({ viewing: true }), facts()];
  const flat = []; const card = [];
  for (const f of seq) {
    const r = stepRowHold(h, f); h = r.hold; flat.push(r.group);
    card.push(paintCards([row("p:1", r.group, r.rank, 100, f.viewing)], mem)[0].bucket);
  }
  assert.deepEqual(flat, [PRI, PRI, PRI, "오늘"]);
  assert.deepEqual(card, flat, "세션 뷰에서 내려가는 판에 프로젝트 뷰의 카드도 내려가야 한다");
  ok("E20 세션 뷰와 프로젝트 뷰가 같은 판에서 같은 곳에 선다");
}

// ── E21 배선 — 화면이 실제로 이 규칙을 지난다 ───────────────────────────────
{
  const main = read("web/v2/main.ts");
  assert.match(main, /stepRowHold\(holds\.get\(key\), \{/, "put 이 행 규칙을 부른다");
  assert.match(main, /known: !unobserved\.has\(key\)/, "관측 못 한 세션을 규칙에 알린다");
  assert.match(main, /hot: !!\(stateKey && PRIORITY_ST\[stateKey\]\)/, "해제 조건 (a)는 점을 끈 표시값이 아니라 원본 상태로 잰다");
  assert.match(main, /viewing: key === activeKey/, "해제 조건 (b)(c)의 재료");
  assert.match(main, /if \(prev\) \{ group = prev\.group \|\| group; rank = prev\.rank; \}/, "같은 판 두 번째 줄기는 자물쇠를 다시 돌리지 않는다");
  assert.match(main, /pruneHolds\(holds, rows\)/);
  assert.doesNotMatch(main, /rank: _rank/, "rank 를 벗기면 카드가 붙든 행의 순위를 못 본다");
  const side = read("web/v2/side.ts");
  assert.match(side, /if \(!searching && \(hooks\.section\?\.\(\) \|\| 'home'\) === 'home'\) \{/, "카드 기억은 홈 구역·찾는 중 아님에서만 건드린다");
  assert.match(side, /stepCardHold\(cardHolds\.get\(g\.key\), \{ bucket: g\.bucket, rank: g\.rank, at: g\.at, viewing: g\.active, pinned: g\.pinned \}\)/);
  assert.match(side, /ordered = orderCards\(groups, seq\)/);
  assert.match(side, /pruneHolds\(cardHolds, byKey\)/);
  assert.match(side, /return ordered;/);
  ok("E21 main.ts put 이 행 규칙을, side.ts projGroups 가 카드 규칙을 홈 구역에서만 부른다");
}

console.log(`\n${pass} passed`);
