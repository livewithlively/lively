// 미리보기 준비의 두 판정(#2143) — 화면 진입 자산 · 의존성 설치의 멱등.
//
// 왜 가드가 필요한가: 이 둘이 틀리면 **오류가 아니라 정상처럼 보이는 화면**이 나온다. 진입 자산 판정이 느슨하면
//  상태는 'running' 인데 사람이 보는 건 하얀 화면이고(빌드 산출물만 404), 반대로 너무 빡빡하면 멀쩡히 돌던
//  미리보기가 오류로 뒤집힌다 — 어느 쪽도 화면을 열어보기 전에는 안 드러난다. 그래서 양방향을 다 박는다:
//  '없는 걸 없다고 하나' 뿐 아니라 **'있는 걸 없다고 하지 않나'** 까지(후자가 더 나쁜 실패다).
//
// ensureDeps 는 **설치를 실제로 돌리지 않는 두 경로**만 잰다(npm 을 띄우면 네트워크와 수 분이 이 계층에
//  들어온다). 그 두 경로가 곧 멱등성의 근거다 — 이미 깔린 워크트리에 매번 npm 을 다시 돌리면 띄우기가
//  몇 배로 느려진다.
//
// 단언은 모아서 끝에 보고한다(assert 직행 아님) — 이 파일은 엣지 표를 훑는 구조라 앞 행에서 죽으면 나머지
//  행이 아예 안 돌아 "무엇까지 깨졌는지"가 안 보인다(mutation 으로 red 를 입증할 때 특히).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { entryScriptSrcs, missingEntryAssets, ensureDeps } from "./preview-prepare.js";

const fails: string[] = [];
const eq = (a: unknown, b: unknown, msg: string): void => {
  if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(`${msg} (실제 ${JSON.stringify(a)} ≠ 기대 ${JSON.stringify(b)})`);
};

// ── E1. 무엇을 진입 자산으로 세나 — 사양 엣지 표 1~15행 ──
//  '고르지 않는다' 쪽 행이 '고른다' 쪽만큼 많은 이유: 판정할 수 없는 것을 골라 오면 그 파일은 영영 '없음'이라
//  멀쩡한 미리보기가 오류로 뒤집힌다(오탐 > 미탐).
const CASES: Array<[string, string, string[]]> = [
  ["1 모듈 진입", `<script type="module" src="./app/main.js"></script>`, ["app/main.js"]],
  ["2 defer 단독 번들", `<script defer src="page-scrollbar.js"></script>`, ["page-scrollbar.js"]],
  ["3 홑따옴표", `<script src='terminal.js'></script>`, ["terminal.js"]],
  ["4 쿼리 제거", `<script src="./app/main.js?v=3"></script>`, ["app/main.js"]],
  ["5 해시 제거", `<script src="app/main.js#x"></script>`, ["app/main.js"]],
  ["6 하위 폴더", `<script type="module" src="./app/v2/main.js"></script>`, ["app/v2/main.js"]],
  ["7 같은 파일 두 번 → 1건", `<script src="a.js"></script><script src="./a.js"></script>`, ["a.js"]],
  ["8 서로 다른 둘 → 둘 다", `<script src="a.js"></script><script src="b.js"></script>`, ["a.js", "b.js"]],
  ["9 외부 CDN(https)", `<script src="https://cdn.example.com/x.js"></script>`, []],
  ["10 프로토콜 상대", `<script src="//cdn.example.com/x.js"></script>`, []],
  ["11 루트상대(서빙 접두사를 모른다)", `<script src="/ui/app/main.js"></script>`, []],
  ["12 폴더 밖", `<script src="../outside.js"></script>`, []],
  ["13 data URI", `<script src="data:text/javascript,0"></script>`, []],
  ["14 인라인(src 없음)", `<script>var a = 1;</script>`, []],
  ["15 빈 문서(경계)", ``, []],
];
for (const [name, html, want] of CASES) eq(entryScriptSrcs(html), want, `E1 ${name}`);

// 실제 화면의 index.html 그대로 — 위 행들이 조합된 모습이다. 외부 폰트 <link> 나 인라인 복구 스크립트가
//  섞여 있어도 **빌드 산출물 둘만** 남아야 한다(이 조합에서 헛디디면 라이브 index.html 에서 바로 오탐이 난다).
eq(entryScriptSrcs(
  `<link rel="stylesheet" href="https://cdn.example.com/font.css">
   <script>(function(){try{}catch(e){}})();</script>
   <script type="module" src="./app/main.js"></script>
   <script defer src="./page-scrollbar.js"></script>`),
  ["app/main.js", "page-scrollbar.js"], "E1 실제 index.html 모양");

const tmp = mkdtempSync(path.join(tmpdir(), "preview-prepare-"));
try {
  // ── E2. 그 파일이 폴더에 실제로 있나 — 사양의 '존재 확인' 3상태 + 16행(index.html 부재) ──
  const pub = path.join(tmp, "public");
  mkdirSync(path.join(pub, "app"), { recursive: true });
  writeFileSync(path.join(pub, "index.html"),
    `<script type="module" src="./app/main.js"></script><script defer src="./page-scrollbar.js"></script>`);

  // 빌드 전 — 둘 다 없다. #2054 이후 프리뷰 워크트리의 실제 모습이고, 종전 판정(폴더만 확인)은 여기서
  //  통과해 'running' 을 줬다. 이 행이 곧 이번 고장 자체다.
  eq(missingEntryAssets(pub), ["app/main.js", "page-scrollbar.js"], "E2 빌드 전 — 둘 다 없다");

  // 절반만 빌드(build:web 만 돌린 경우) — 단독 번들이 빠진 것을 잡아야 한다.
  writeFileSync(path.join(pub, "app", "main.js"), "export {};");
  eq(missingEntryAssets(pub), ["page-scrollbar.js"], "E2 build:web 만 — 단독 번들이 빠졌다");

  // 온전히 빌드 — 통과. 여기서 오탐이 나면 멀쩡한 미리보기가 오류가 된다.
  writeFileSync(path.join(pub, "page-scrollbar.js"), "void 0;");
  eq(missingEntryAssets(pub), [], "E2 온전한 빌드 — 통과");

  // 16행 — index.html 이 없는 레포는 검사 대상이 아니다(판정 불가 ≠ 실패).
  const noHtml = path.join(tmp, "no-html");
  mkdirSync(noHtml, { recursive: true });
  eq(missingEntryAssets(noHtml), [], "E2 index.html 없음 — 검사 대상 아님");

  // ── E3. 설치를 '돌리지 않는' 두 경로(S2) ──
  //  배선 확인: 이 두 경로는 npm 을 띄우지 않으므로 즉시 끝나야 한다. 실제로 설치가 돌면 여기서 수 분이 걸린다.
  const noPkg = path.join(tmp, "no-pkg");
  mkdirSync(noPkg, { recursive: true });
  const t0 = Date.now();
  const r1 = await ensureDeps(noPkg);
  eq([r1.ok, r1.action, r1.out], [true, "no-package-json", ""], "E3 package.json 없음 — 통과하고 아무것도 안 돈다");

  const installed = path.join(tmp, "installed");
  mkdirSync(path.join(installed, "node_modules"), { recursive: true });
  writeFileSync(path.join(installed, "package.json"), "{}");
  const r2 = await ensureDeps(installed);
  eq([r2.ok, r2.action, r2.out], [true, "already-installed", ""], "E3 이미 설치됨 — 다시 돌지 않는다(멱등)");
  if (Date.now() - t0 > 5_000) fails.push("E3 두 경로가 5초를 넘겼다 — 설치가 실제로 돌았다는 뜻이다");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (fails.length) { console.error("preview-prepare 가드 실패:\n - " + fails.join("\n - ")); process.exit(1); }
console.log(`✓ preview-prepare 가드 (${CASES.length + 7}건)`);
