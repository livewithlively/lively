#!/usr/bin/env node
// 노드 에이전트 번들에 **누가 무엇을 끌어들이는가** (#2165) — 드리프트를 고칠 때 쓰는 지도.
//
// 왜 필요한가: 빌드 가드(`build-node-agent.mjs`)는 "목록 밖 모듈 N개"라고만 말한다. N 이 70이면 사람은
//  70개를 하나씩 들여다보다 포기한다. 실제로는 **몇 개의 경계 간선**이 그 대부분을 끌고 온다 —
//  2026-08-27 실측: 침입 70개가 **12개 간선**으로 접혔고, 그중 하나(`project-provision → github-app-git`)가
//  혼자 11개(전부 OAuth 자격 계열)를 끌고 있었다. 지도가 있으면 고칠 자리가 열두 곳으로 줄어든다.
//
// 쓰기: node scripts/node-agent-bundle-map.mjs            # 요약(간선 표)
//       node scripts/node-agent-bundle-map.mjs --json     # 기계용 전문(체인 포함)
// 전제: npm run build(tsc)로 dist/ 가 먼저 있어야 한다. **레포 안에서 실행하라**(esbuild 해소).
//
// ⚠ 실측으로 못박아 둘 것 — **`await import()` 로는 번들에서 빠지지 않는다.** esbuild 는 outfile 하나(코드
//  분할 없음)면 동적 import 를 같은 번들에 인라인한다. 그래서 '나중에 부르니 괜찮다'는 착각이 통하지 않는다.
//  번들에서 빼는 유일한 길은 **모듈을 가르는 것**이다(무거운 것과 가벼운 것을 다른 파일로).
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const asJson = process.argv.includes("--json");

const r = await build({
  entryPoints: [join(root, "dist/node/agent.js")],
  bundle: true, platform: "node", format: "esm", target: "node20",
  external: ["node-pty"], write: false, metafile: true, logLevel: "silent",
});
const inputs = r.metafile.inputs;
const ours = Object.keys(inputs).filter((p) => p.startsWith("dist/")).sort();

const read = (f) => { try { return new Set(JSON.parse(readFileSync(join(root, "scripts", f), "utf8"))); } catch { return new Set(); } };
const allowed = read("node-agent-allowed-modules.json");
const debt = read("node-agent-known-debt.json");
const known = new Set([...allowed, ...debt]);
const intruders = ours.filter((p) => !known.has(p));

// entry 로부터 최단 import 체인(BFS) — '어떻게 들어왔나'.
const ENTRY = "dist/node/agent.js";
const prev = new Map([[ENTRY, null]]);
for (const q = [ENTRY]; q.length; ) {
  const cur = q.shift();
  for (const im of inputs[cur]?.imports ?? []) {
    if (!im.path || prev.has(im.path)) continue;
    prev.set(im.path, cur); q.push(im.path);
  }
}
const chain = (p) => { const out = []; for (let c = p; c; c = prev.get(c)) out.push(c); return out.reverse(); };

// 경계 간선 = 체인에서 '알려진 모듈 → 아직 안 갈린 모듈' 로 넘어가는 첫 자리.
//  여기를 끊으면 그 아래가 통째로 빠진다 = 고칠 자리.
const target = [...debt, ...intruders];
const gates = new Map();
for (const p of target) {
  const c = chain(p);
  for (let i = 1; i < c.length; i++) {
    if (target.includes(c[i])) {
      const key = `${c[i - 1]}\u0000${c[i]}`;   // NUL 구분 — 경로엔 못 들어간다(소스엔 이스케이프로 적어 파일을 텍스트로 유지)
      (gates.get(key) ?? gates.set(key, []).get(key)).push(p);
      break;
    }
  }
}
const rows = [...gates.entries()]
  .map(([k, v]) => { const [from, to] = k.split("\u0000"); return { from, to, pulls: v.length, modules: v }; })
  .sort((a, b) => b.pulls - a.pulls);

if (asJson) {
  console.log(JSON.stringify({ ours: ours.length, allowed: allowed.size, debt: debt.size, intruders, gates: rows,
    chains: Object.fromEntries(target.map((p) => [p, chain(p)])) }, null, 1));
} else {
  const s = (p) => p.replace(/^dist\//, "");
  console.log(`우리 모듈 ${ours.length} · 승인 ${allowed.size} · 알려진 부채 ${debt.size} · **미분류 침입 ${intruders.length}**`);
  if (intruders.length) console.log(`\n미분류(둘 중 어느 목록에도 없음 — 빌드가 여기서 실패한다):\n  ${intruders.map(s).join("\n  ")}`);
  console.log(`\n경계 간선 — 여기를 끊으면 딸린 것이 함께 빠진다 (상위 ${Math.min(rows.length, 15)}):`);
  for (const g of rows.slice(0, 15)) console.log(`  ${String(g.pulls).padStart(3)}건  ${s(g.from)}\n         └→ ${s(g.to)}`);
  console.log(`\n간선 ${rows.length}개가 모듈 ${target.length}개를 끌고 있다.`);
}
