#!/usr/bin/env node
// 검색 품질 재기(#4530, 원준 2026-10-05) — 돌고 있는 서버의 **실제 세션**을 과녁으로, 사람이 흔히 치는 변형마다 «찾는가 · 몇 째인가» 를 잰다.
//
//  왜 — 검색을 고칠 때마다 «좋아졌나» 를 감으로 말하지 않으려고. 2026-10-05 첫 측정(매니지드, 세션 50개 · 변형 229개)이 이 도구의 원형이다:
//   그대로 96% · 붙여 쓰기 6% · 한 글자 틀림 0% · 군말 한 낱말 더 48% · 영어↔한글 58%(20위 안). 판을 바꾸기 전후로 돌려 표를 견준다.
//  무엇을 — 내 세션 목록에서 과녁을 고르고(첫 지시가 30자 이상인 것), 첫 지시의 낱말 둘로 검색어를 만든 뒤 다섯 가지로 바꾼다:
//   그대로 / 붙여 쓰기(나란한 두 낱말을 붙임) / 한 글자 틀림(끝 두 글자 자리 바꿈) / 군말 한 낱말 더 / 영어↔한글.
//   과녁이 «맞는 결과» 로 섰는지와 «덜 맞는 결과» 까지 넣으면 섰는지를 따로 센다.
//  읽기만 한다(GET). 시험이 아니라 도구다 — CI 는 돌리지 않는다.
//
//  쓰는 법:  LIVELY_TOKEN=… node scripts/search-quality-eval.mjs [--url https://<게이트웨이>] [--n 50] [--json out.json] [--replay 전.json]
//   --replay — 앞서 --json 으로 남긴 파일의 **같은 과녁 · 같은 검색어**로 다시 잰다. 판을 바꾸기 전후를 견줄 때는 이걸 쓴다
//   (과녁을 새로 고르면 그사이 생긴 세션 때문에 검색어가 달라진다).
//   (기본 url = LIVELY_URL 환경변수. 토큰은 화면에 찍지 않는다.)
import fs from "node:fs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = String(arg("--url", process.env.LIVELY_URL || "")).replace(/\/$/, "");
const N = Number(arg("--n", 50));
const OUT = arg("--json", "");
const REPLAY = arg("--replay", "");
const TOKEN = process.env.LIVELY_TOKEN || "";
if (!BASE || !TOKEN) { console.error("LIVELY_URL(또는 --url)과 LIVELY_TOKEN 이 필요합니다."); process.exit(2); }
const H = { authorization: "Bearer " + TOKEN };
const get = async (p) => {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(BASE + p, { headers: H }); if (r.status === 200) return await r.json(); if (r.status < 500) return { __status: r.status }; } catch { /* 다시 */ }
    await new Promise((z) => setTimeout(z, 800));
  }
  return { __status: 0 };
};

const JOSA = /(으로써|으로서|에서는|에게서|으로|에서|에게|까지|부터|처럼|보다|이라|이나|하고|은|는|이|가|을|를|에|의|로|와|과|도|만|나)$/;
const stem = (t) => { if (!/[가-힣]$/.test(t)) return t; const s = t.replace(JOSA, ""); return s.length >= 2 ? s : t; };
const toks = (text) => String(text || "").split(/[^0-9A-Za-z가-힣._-]+/).map((t) => t.replace(/^[._-]+|[._-]+$/g, "")).filter(Boolean);
const isHan = (t) => /^[가-힣]+$/.test(t);
const good = (t) => (isHan(t) ? t.length >= 2 : /^[A-Za-z][A-Za-z0-9._-]{2,}$/.test(t));
const KOEN = [["배포", "deploy"], ["검색", "search"], ["세션", "session"], ["프로젝트", "project"], ["지식", "knowledge"], ["로그인", "login"], ["사이드바", "sidebar"], ["터미널", "terminal"],
  ["알림", "notification"], ["미리보기", "preview"], ["색인", "index"], ["권한", "permission"], ["온보딩", "onboarding"], ["설정", "settings"], ["대시보드", "dashboard"], ["워크스페이스", "workspace"],
  ["분류", "category"], ["태스크", "task"], ["댓글", "comment"], ["업로드", "upload"], ["토큰", "token"], ["위젯", "widget"], ["빌드", "build"], ["캐시", "cache"], ["머지", "merge"],
  ["브랜치", "branch"], ["커밋", "commit"], ["디자인", "design"], ["임베딩", "embedding"], ["리뷰", "review"], ["모바일", "mobile"], ["버튼", "button"], ["모달", "modal"], ["메뉴", "menu"]];
const swapKoEn = (t) => { const low = t.toLowerCase(); for (const [k, e] of KOEN) { if (t === k) return e; if (low === e) return k; } return null; };
const FILL = ["방법", "어떻게", "관련", "문제", "정리"];
const typo = (t) => { if (t.length < 3) return null; const a = [...t]; const i = a.length - 2; [a[i], a[i + 1]] = [a[i + 1], a[i]]; const o = a.join(""); return o === t ? null : o; };

function variants(text, seed) {
  const all = toks(text);
  const cand = [...new Set(all.map(stem).filter(good))];
  if (cand.length < 2) return null;
  const [a, b] = [...cand].sort((x, y) => y.length - x.length);
  const out = { base: `${a} ${b}` };
  for (let i = 0; i + 1 < all.length; i++) {
    const x = all[i], y = stem(all[i + 1]);
    if (isHan(x) && isHan(y) && x.length >= 2 && x.length <= 4 && y.length >= 2 && y.length <= 4 && stem(x) === x) { const other = [a, b].find((p) => p !== x && p !== y); out.joined = x + y + (other ? " " + other : ""); break; }
  }
  const ty = typo(a); if (ty) out.typo = `${ty} ${b}`;
  out.filler = `${a} ${b} ${FILL[seed % FILL.length]}`;
  const sa = swapKoEn(a), sb = swapKoEn(b);
  if (sa || sb) out.koen = `${sa || a} ${sb || b}`;
  return out;
}

const jobs = [];
if (REPLAY) {
  for (const r of JSON.parse(fs.readFileSync(REPLAY, "utf8"))) if (r && r.kind && r.q && r.id) jobs.push({ kind: r.kind, q: r.q, id: r.id });
  console.error(`앞서 잰 검색어 ${jobs.length}개를 그대로 다시 잽니다 (${BASE})`);
} else {
  const list = await get("/api/ui/v6/sessions?limit=2000");
  const S = (list.sessions || []).filter((s) => String(s.title || "").length >= 30 && Number(s.bytes) > 20000);
  if (!S.length) { console.error("과녁으로 삼을 세션이 없습니다(목록 응답:", JSON.stringify(list).slice(0, 120), ")"); process.exit(1); }
  const targets = S.filter((_, i) => i % Math.max(1, Math.floor(S.length / N)) === 0).slice(0, N);
  targets.forEach((s, i) => { const v = variants(String(s.title).slice(0, 220), i); if (!v) return; for (const [kind, q] of Object.entries(v)) jobs.push({ kind, q, id: s.session_id }); });
  console.error(`과녁 세션 ${targets.length}개 · 검색 ${jobs.length}번 (${BASE})`);
}

const res = [];
let next = 0;
async function worker() {
  for (;;) {
    const j = jobs[next++]; if (!j) return;
    const t0 = Date.now();
    const r = await get(`/api/ui/v6/session-search?sort=recent&limit=20&q=${encodeURIComponent(j.q)}`);
    const rows = r.results || [];
    const strong = rows.filter((x) => x.tier !== "weak").map((x) => x.session_id), all = rows.map((x) => x.session_id);
    res.push({ ...j, ms: Date.now() - t0, n: strong.length, nAll: all.length, rank: strong.indexOf(j.id) + 1, rankAll: all.indexOf(j.id) + 1 });
    if (res.length % 50 === 0) console.error("  …", res.length);
  }
}
await Promise.all([worker(), worker()]);
if (OUT) fs.writeFileSync(OUT, JSON.stringify(res));

const NAME = { base: "그대로(낱말 둘)", joined: "붙여 쓰기", typo: "한 글자 틀림", filler: "군말 한 낱말 더", koen: "영어↔한글" };
const pct = (n, d) => (d ? String(Math.round((n / d) * 100)).padStart(3) + "%" : "   -");
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
console.log("변형              | 검색 | 맞는 결과: 20위 안 · 5위 안 · 1위 | 덜 맞는 결과까지: 20위 안 | 0건 | 걸린 시간(가운뎃값)");
for (const k of Object.keys(NAME)) {
  const xs = res.filter((r) => r.kind === k); if (!xs.length) continue;
  const c = (f) => xs.filter(f).length;
  console.log(`${NAME[k].padEnd(16)} | ${String(xs.length).padStart(4)} | ${pct(c((r) => r.rank > 0), xs.length)} · ${pct(c((r) => r.rank > 0 && r.rank <= 5), xs.length)} · ${pct(c((r) => r.rank === 1), xs.length)}`
    + `           | ${pct(c((r) => r.rankAll > 0), xs.length)}                    | ${pct(c((r) => r.nAll === 0), xs.length)} | ${med(xs.map((r) => r.ms))}ms`);
}
