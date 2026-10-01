// #3870 — 세션 머리줄 얼굴 줄(누가 보고 있나)의 크기 (원준 2026-10-01: «아바타 위 칸에 동그랗게 색이랑 이름 보이는 거
//  사이즈가 너무 심하게 작아 보이는데 방법 좀 없을까?»).
//
// 종전 20px 상자 · 2px 고리(색 원 16px) · 글자 10px · 6px 겹침 — 뒤 얼굴이 **앞 얼굴의 글자를 덮었다**(«JK» 의 K 가 잘림).
// 이 파일은 실제 스타일시트(public/styles 전부)를 헤드리스 크롬에 물려 **그려진 값**을 잰다(소스 문자열이 아니라):
//   S1 얼굴은 24px 이상의 원이다           🔴 되돌리면 다시 «너무 작다»
//   S2 글자는 11.5px 이상                  🔴
//   S3 뒤 얼굴이 앞 얼굴의 글자를 안 덮는다  🔴 겹침을 늘리면 두 글자 이니셜이 잘린다
//   S4 얼굴 줄이 머리줄을 높이지 않는다      🔴 키우다 머리줄이 두꺼워지면 «너무 높이 많이 차지해»(원준 2026-08-26)가 돌아온다
//                                          (데스크톱 폭에서 잰다 — 26px 묶음을 그대로 두면 40→44px. 첫 판이 CI 에서 걸린 자리다)
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬이 없어 런타임 절을 건너뜁니다"); process.exit(0); }
const STY = path.join(root, "public/styles");
const files = readdirSync(STY).filter((f) => f.endsWith(".css")).sort();

const head = (id, faces) => `<div class="sc-head" id="${id}" style="width:640px"><div class="sc-head-l"><span class="sc-title">온보딩 과정 설계</span>
${faces ? `<button class="sc-faces"><span class="sc-face" style="background:#e07a8a">원</span><span class="sc-face" style="background:#6aa0e0">JK</span><span class="sc-face" style="background:#7cc29a">MW</span><span class="sc-face sc-face-more">+2</span><span class="sc-face sc-face-add">＋</span></button>` : ""}
</div><div class="sc-head-r"><button class="sc-act">자료</button><button class="sc-act">⋯</button></div></div>`;

const page = (theme) => `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8">
${files.map((f) => `<link rel="stylesheet" href="${f}">`).join("")}</head><body>
${head("with", true)}${head("without", false)}
<pre id="out">PENDING</pre>
<script>
(function () {
  var res = {};
  try {
    var faces = [].slice.call(document.querySelectorAll('#with .sc-face'));
    var f0 = faces[0].getBoundingClientRect();
    res.w = f0.width; res.h = f0.height; res.radius = getComputedStyle(faces[0]).borderRadius;
    res.font = parseFloat(getComputedStyle(faces[0]).fontSize);
    // 글자가 다음 얼굴에 덮이나 — 사람 얼굴 셋(원·JK·MW)의 글자 오른쪽 끝 vs 다음 얼굴의 왼쪽 끝
    res.cover = [];
    for (var i = 0; i < 3; i++) {
      var r = document.createRange(); r.selectNodeContents(faces[i]);
      var glyphRight = r.getBoundingClientRect().right, nextLeft = faces[i + 1].getBoundingClientRect().left;
      res.cover.push(+(glyphRight - nextLeft).toFixed(2));
    }
    res.hWith = document.getElementById('with').getBoundingClientRect().height;
    res.hWithout = document.getElementById('without').getBoundingClientRect().height;
  } catch (e) { res.error = String(e && e.message || e); }
  document.getElementById('out').textContent = encodeURIComponent(JSON.stringify(res)) + 'END' + 'RESULT';
})();
</script></body></html>`;

let fail = 0;
const check = (ok, label, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`); if (!ok) fail++; };

for (const theme of ["light", "dark"]) {
  //  ⚠ 데스크톱 폭으로 잰다 — 기본 창은 좁아 폰 레이아웃(단추 36px, 얼굴 줄은 폰에서 숨는다)이 머리줄 높이를 정해 S4 가 늘 통과했다.
  const dom = await dumpDom(chrome, { html: page(theme), copy: files.map((f) => path.join(STY, f)), prefix: "face-size-", args: ["--window-size=1400,900"] });
  const m = dom.match(/<pre id="out">([^<]*?)ENDRESULT/);
  if (!m) { check(false, `${theme} 결과를 못 받았다`, dom.slice(0, 300)); continue; }
  const r = JSON.parse(decodeURIComponent(m[1]));
  check(!r.error, `${theme} 측정 스크립트가 끝까지 돌았다`, r.error || "");
  if (r.error) continue;
  check(r.w >= 24 && Math.abs(r.w - r.h) < 0.5 && r.radius === "50%", `${theme} S1 얼굴은 24px 이상의 원이다`, `${r.w}×${r.h} radius=${r.radius}`);
  check(r.font >= 11.5, `${theme} S2 얼굴 글자는 11.5px 이상`, `${r.font}px`);
  check(r.cover.every((c) => c <= 0.5), `${theme} S3 뒤 얼굴이 앞 얼굴의 글자를 덮지 않는다`, `덮인 폭(px) ${r.cover.join(" · ")}`);
  check(r.hWith <= r.hWithout + 0.5, `${theme} S4 얼굴 줄이 머리줄을 높이지 않는다`, `얼굴 있음 ${r.hWith}px · 없음 ${r.hWithout}px`);
}
console.log(fail ? `\n${fail} failed` : "\nall passed");
process.exit(fail ? 1 : 0);
