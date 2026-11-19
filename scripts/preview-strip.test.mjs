// 미리보기 안 표시 · [워크스페이스로 돌아가기] (#5581) — 주소 바꾸기(순수 함수)와 화면 배선을 잰다.
//  화면 실측(브라우저 띠 · 데스크톱 타이틀바 알약 · 곁칸 끼움 · 폰 · 어두운 판)은 Playwright 로 따로 했다 — 여기는 되돌아가면 안 되는 약속만 묶는다.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "preview-strip-"));
execFileSync(path.join(root, "node_modules/.bin/tsc"),
  [path.join(root, "web/lib/preview-path.ts"), "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" });
const { previewIdOf, liveUrlOf } = await import(path.join(out, "preview-path.js"));

let pass = 0;
const eq = (got, want, name) => { assert.deepEqual(got, want, name); pass++; console.log(`ok  ${name}`); };
const read = (p) => readFileSync(path.join(root, p), "utf8");
const L = (pathname, search = "", hash = "") => liveUrlOf({ pathname, search, hash });

// ── 주소 ──────────────────────────────────────────────────────────────────────────────
eq(previewIdOf("/preview/wonjoon-5581-newtask/ui/"), "wonjoon-5581-newtask", "P1 미리보기 주소에서 id 를 읽는다");
eq([previewIdOf("/ui/"), previewIdOf("/"), previewIdOf(""), previewIdOf("/preview/")], [null, null, null, null], "P2 라이브·빈 주소는 미리보기가 아니다");
eq(previewIdOf("/preview/-bad/ui/"), null, "P3 id 모양은 서버 라우트와 같다(첫 글자 영숫자)");
eq(L("/preview/x1/ui/", "", "#/s/12"), "/ui/#/s/12", "P4 돌아가기는 같은 화면(해시 그대로)의 실제 워크스페이스로");
eq(L("/preview/x1/ui/", "?embed=1&a=b", "#/projects2"), "/ui/?a=b#/projects2", "P5 곁칸 끼움 표(embed)는 떼고 나머지 쿼리는 둔다");
eq(L("/gw/preview/x1/ui/index.html"), "/gw/ui/index.html", "P6 게이트웨이 경로 접두는 지킨다");
eq(L("/preview/x1"), "/", "P7 정규화 전 주소면 루트로(서버가 /ui/ 로 보낸다)");
eq(L("/ui/", "", "#/s/1"), null, "P8 미리보기가 아니면 돌아갈 곳도 없다");

// ── 화면 배선 ──────────────────────────────────────────────────────────────────────────
{
  const strip = read("web/v2/preview-strip.ts");
  const main = read("web/v2/main.ts");
  assert.match(strip, /if \(o\.embedded \|\| o\.solo\) return false;/); pass++;
  console.log("ok  W1 곁칸에 끼운 판·팝아웃엔 띄우지 않는다(바깥이 이미 워크스페이스다)");
  assert.match(strip, /if \(window\.top !== window\) return false;/); pass++;
  console.log("ok  W2 프레임 안에서도 띄우지 않는다");
  assert.match(strip, /location\.assign\(to\)/); pass++;
  console.log("ok  W3 돌아가기는 같은 탭 이동이다(탭을 닫지 않는다 · 뒤로 가기로 미리보기에 돌아올 수 있다)");
  assert.match(strip, /o\.titlebarHost\.insertBefore\(chip, grip\)/); pass++;
  console.log("ok  W4 데스크톱 앱은 타이틀바 줄 안(끌기 손잡이 앞)에 둔다 — 줄 위에 띠를 얹으면 창 단추와 겹친다");
  assert.match(strip, /o\.root\.before\(strip\);\s*document\.documentElement\.classList\.add\('v2-pv-on'\)/); pass++;
  console.log("ok  W5 브라우저 띠는 #v2-root 앞에 서고 높이 변수를 켠다");
  assert.match(main, /mountPreviewStrip\(\{ root, titlebarHost: titlebar \? titlebar\.host : null, embedded: EMBEDDED, solo: SOLO \}\)/); pass++;
  console.log("ok  W6 셸이 타이틀바를 정한 뒤에 붙인다");
  eq([strip.includes("'워크스페이스로 돌아가기'"), strip.includes("'미리보기'")], [true, true], "W7 문구는 짧게 — «미리보기» · «워크스페이스로 돌아가기»");
}

// ── 높이: 띠만큼 셸이 줄어야 아래 입력줄이 화면 밖으로 안 밀린다 ─────────────────────────────
{
  const v2 = read("public/styles/40-v2.css");
  const tab = read("public/styles/51-tablet.css");
  assert.match(v2, /#v2-root \{[^}]*height: calc\(100vh - var\(--v2-pv-h, 0px\)\)/); pass++;
  assert.match(v2, /#v2-root, #v2-root\.no-aside \{[^}]*height: calc\(100dvh - var\(--v2-pv-h, 0px\)\)/); pass++;
  assert.match(tab, /#v2-root:not\(\.v2-relay-landing\) \{ height: calc\(100dvh - var\(--v2-pv-h, 0px\)\)/); pass++;
  console.log("ok  H1 #v2-root 높이 규칙 셋(넓은 폭 · 폰 · 태블릿 dvh) 모두 띠 높이를 뺀다 — 하나라도 빠지면 그 폭에서 34px 넘친다(실측)");
  assert.match(v2, /html\.v2-pv-on \{ --v2-pv-h:/); pass++;
  assert.match(v2, /#v2-root\.has-topbar > \.v2-topbar > \.v2-pv-chip \{[^}]*-webkit-app-region: no-drag/); pass++;
  console.log("ok  H2 띠가 없으면 0 · 타이틀바 알약은 no-drag(창 끌기 줄 안에서도 눌린다)");
}

console.log(`\n${pass} passed`);
