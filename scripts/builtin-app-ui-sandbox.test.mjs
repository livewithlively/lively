// 앱 화면 iframe 의 sandbox 정책 — #4482 앱 v2-3 «iframe 제한 완화 · click·keydown 규칙 삭제».
//
//  종전(#4225): 앱 화면은 `sandbox="allow-scripts"` 뿐이라 브라우저가 폼 제출을 **submit 이벤트를 쏘기 전에** 막았다
//   (실측 2026-09-29 매니지드 «Blocked form submission … 'allow-forms' permission is not set»). 그래서 «폼 금지 · 버튼 click ·
//   입력칸 keydown 으로 받아라» 가 앱 화면 규칙이었고, 이 시험이 그 규칙을 빌트인 앱 전부에 걸었다.
//  #4482: 두 길(앱 주소 iframe · 종전 srcdoc) 모두 allow-forms · allow-modals · allow-downloads 를 받는다 — 평범한 <form> 과
//   confirm() · print() · 내려받기가 돈다. 그래서 «폼 금지» 규칙은 걷고, 대신 **무엇을 열고 무엇을 끝까지 막는지**를 여기서 고정한다:
//   · 어느 길도 최상위 창 이동(allow-top-navigation*)을 받지 않는다 — 앱이 라이블리 탭을 다른 주소로 바꾸지 못하게(설계 §2 ④).
//   · 어느 길도 팝업의 sandbox 벗기(allow-popups-to-escape-sandbox)를 받지 않는다 — 벗긴 팝업은 opener.top 으로 라이블리 탭을 옮길 수 있다.
//   · srcdoc 은 출처(allow-same-origin)가 없다 — 있으면 라이블리와 같은 출처가 되어 토큰 · API 에 닿는다(sandbox 를 스스로 지운다, MDN).
//   · srcdoc 은 팝업도 없다 — 불투명 출처라 열린 창이 쿠키 · 저장소 없는 깨진 창이 된다(새 창은 lively.ui.openExternal).
//  이게 틀리면: 폼 앱이 라이블리 안에서 조용히 안 돌거나(allow-forms 빠짐), 앱이 라이블리 탭을 피싱 주소로 옮기거나, srcdoc 앱이 라이블리 토큰을 읽는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const ok = (cond, name, detail = "") => { assert.ok(cond, detail ? `${name}\n${detail}` : name); pass++; console.log(`ok  ${name}`); };

// ① 배선 — 호스트(web/v2/app-ui.ts)의 두 iframe 이 이 정책 함수를 쓴다(문자열을 따로 적어 정책을 비켜 가지 않는다).
const HOST = readFileSync(join(root, "web/v2/app-ui.ts"), "utf8");
ok(/sandbox:\s*frameSandbox\('srcdoc'\)/.test(HOST), "srcdoc iframe 은 frameSandbox('srcdoc')");
ok(/sandbox:\s*frameSandbox\('address'\)/.test(HOST), "앱 주소 iframe 은 frameSandbox('address')");
ok(/allow:\s*frameAllow\(launch\?\.devices\)/.test(HOST), "앱 주소 iframe 의 장치 권한은 frameAllow(서버가 준 선언)");
ok(!/sandbox:\s*'allow-/.test(HOST), "sandbox 값을 글자로 따로 적은 iframe 이 없다");

// ② 정책 값 — 소스(web/lib/app-address.ts — 가져오는 것 없는 순수 모듈)를 esbuild 로 그 자리에서 옮겨 돌린다.
//  빌드 산출물에 기대면 부분 실행(빌드 없음)에서 가장 중요한 값 단언이 조용히 건너뛰어졌다(격리 리뷰 10).
{
  const { transformSync } = await import("esbuild");
  const js = transformSync(readFileSync(join(root, "web/lib/app-address.ts"), "utf8"), { loader: "ts", format: "esm" }).code;
  const F = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
  const flags = (s) => new Set(String(s).split(/\s+/).filter(Boolean));
  const src = flags(F.frameSandbox("srcdoc"));
  const addr = flags(F.frameSandbox("address"));
  for (const f of ["allow-scripts", "allow-forms", "allow-modals", "allow-downloads"]) {
    ok(src.has(f), `srcdoc 에 ${f}`);
    ok(addr.has(f), `앱 주소에 ${f}`);
  }
  ok(!src.has("allow-same-origin"), "srcdoc 에 allow-same-origin 없음(라이블리 출처가 되면 토큰에 닿는다)");
  ok(!src.has("allow-popups"), "srcdoc 에 allow-popups 없음(불투명 출처의 깨진 창)");
  ok(addr.has("allow-same-origin") && addr.has("allow-popups"), "앱 주소에 출처 · 팝업(다른 사이트라 라이블리에 못 닿는다)");
  for (const [name, set] of [["srcdoc", src], ["앱 주소", addr]]) {
    ok(![...set].some((f) => f.startsWith("allow-top-navigation")), `${name}: 최상위 창 이동 없음`);
    ok(!set.has("allow-popups-to-escape-sandbox"), `${name}: 팝업 sandbox 벗기기 없음`);
    ok([...set].every((f) => /^allow-[a-z-]+$/.test(f)), `${name}: 값 모양`);
  }
  // 장치 권한 — 늘 주는 것(사람이 누를 때만 도는 것)과 선언한 것만. 모르는 값 · 모양 밖 입력은 버린다.
  const allow = (v) => new Set(String(F.frameAllow(v)).split(/;\s*/).filter(Boolean));
  const base = allow(undefined);
  ok(["clipboard-write", "fullscreen", "web-share"].every((f) => base.has(f)) && base.size === 3, "선언 없으면 클립보드 쓰기 · 전체 화면 · 공유만");
  ok(!["microphone", "camera", "clipboard-read", "geolocation"].some((f) => base.has(f)), "선언 없으면 마이크 · 카메라 · 클립보드 읽기 · 위치 없음");
  const decl = allow(["microphone", "camera", "usb", "microphone; camera *", 7]);
  ok(decl.has("microphone") && decl.has("camera") && !decl.has("usb") && decl.size === 5, "선언한 것만 · 모르는 값(usb) · 꼴 밖 값은 버린다");
  ok(allow("microphone").size === 3, "배열이 아니면 선언 없음");
  //  서버 선언 목록(src/apps/manifest.ts APP_DEVICES)과 화면의 위임 목록이 같다 — 한쪽만 늘면 선언이 저장은 되는데 위임이 안 되거나 그 반대다
  const man = readFileSync(join(root, "src/apps/manifest.ts"), "utf8");
  const m = /export const APP_DEVICES = \[([^\]]*)\] as const;/.exec(man);
  const serverList = m ? m[1].split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean) : [];
  ok(serverList.length > 0 && JSON.stringify(serverList) === JSON.stringify(F.FRAME_DEVICES), `서버 APP_DEVICES == 화면 FRAME_DEVICES (${serverList.join(",")} / ${F.FRAME_DEVICES.join(",")})`);
}
console.log(`\n${pass} passed`);
