// #5170 — 자료 앱은 **제 화면이 서 있는 칸에만** 다시 그린다.
//
//  원준 2026-10-30 실측(셀프서브 새 워크스페이스, 파일 75개 올린 뒤): 홈 사이드바의 세션 줄을 누르면 세션 대신
//  「모든 자료 · 지식이 된 것만 · 왼쪽에서 자료를 고르세요」 가 떴다. 목록은 회색 뼈대에서 멈춰 있었다.
//  ① 셸은 탭마다 그릇(tab.center) 한 벌을 숨겼다 보였다 한다 — 탭이 다른 화면으로 옮겨 가도 그릇은 문서에 남는다.
//  ② 자료 → 홈 → 세션으로 같은 탭에서 이어 간 뒤 다시 자료를 열면, 자료 앱의 주소 듣개가 «그릇이 문서에 있나» 만 물어
//     그 세션 화면을 자료로 덮었다. 셸은 자료를 새 탭에 따로 그리므로 덮인 쪽은 버려진 목록(뼈대)으로 남는다.
//  분류체계(#4179 T3) · 가이드 · 앱빌더는 이미 «칸의 주인» 을 묻는다. 자료도 같은 잣대를 쓴다.
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
let pass = 0, fail = 0;
const check = (cond, n, why = "기대와 다르다") => {
  if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} — ${why}`); }
};
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const cut = (src, from, to) => { const i = src.indexOf(from); return i < 0 ? "" : src.slice(i, src.indexOf(to, i) + to.length); };

const SRC = code(readFileSync(path.join(root, "web/v2/sources.ts"), "utf8"));

// ── H. 칸의 주인 잣대 — 요소 흉내 위에서 실제로 부른다
{
  const fn = cut(SRC, "function ownsHost(", "\n}");
  let ownsHost = null;
  try { ownsHost = new Function("return (" + fn.replace(/^function ownsHost\(host: HTMLElement\): boolean/, "function (host)") + ")")(); } catch { /* 아래 H0 가 빨간불 */ }
  check(typeof ownsHost === "function", "H0 칸의 주인을 묻는 잣대(ownsHost)가 있다");
  if (ownsHost) {
    const hostOf = (connected, kids) => ({ isConnected: connected, querySelector: (sel) => (sel === ":scope > .v2-src" && kids.includes("v2-src") ? {} : null) });
    check(ownsHost(hostOf(true, ["v2-src"])) === true, "H1 칸의 바로 아래에 자료 화면이 있으면 주인이다");
    check(ownsHost(hostOf(true, ["v2-panes"])) === false, "H2 ★★ 같은 칸에 세션 화면이 섰으면 주인이 아니다(문서에 남아 있어도)");
    check(ownsHost(hostOf(true, [])) === false, "H3 칸이 비었으면 주인이 아니다");
    check(ownsHost(hostOf(false, ["v2-src"])) === false, "H4 칸이 문서에서 떨어졌으면 주인이 아니다");
  }
}

// ── D. 다시 그리는 세 길이 모두 그 잣대를 묻는다
{
  const hc = cut(SRC, "window.addEventListener('hashchange'", "\n});");
  check(/if \(!mounted \|\| !ownsHost\(mounted\)\) \{ mounted = null; view = null; return; \}/.test(hc),
    "D1 ★★ 주소 변화는 칸의 주인일 때만 스스로 그린다(아니면 셸에 맡기고 손을 뗀다)");
  const kd = cut(SRC, "window.addEventListener('keydown'", "\n});");
  check(/ownsHost\(mounted\)/.test(kd) && /mounted\.closest\('\[hidden\]'\)/.test(kd),
    "D2 ↑↓ 훑기는 칸의 주인이고 보이는 탭일 때만(숨은 탭이 다른 탭의 키를 가로채지 않는다)");
  const up = cut(SRC, "async function uploadFiles(", "\n}");
  check(/if \(view && mounted && ownsHost\(mounted\)\)/.test(up), "D3 올린 뒤 다시 그리기도 칸의 주인일 때만");
  check(!/document\.contains\(mounted\)/.test(SRC), "D4 «문서에 있나» 만 묻는 옛 잣대가 남아 있지 않다");
}

console.log(`\n#5170 자료 앱 칸의 주인: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
if (fail) process.exit(1);
