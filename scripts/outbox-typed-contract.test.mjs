// «다 쳤다» 알림(outbox.typed)의 머리 — 서버와 화면이 **같은 글자**를 만드나 (#4794).
//
//  서버(src/sessions/session-outbox.ts typedHead)는 사람의 말을 다 치고 Enter 까지 누른 순간 그 말의 머리를 세션 상태 통로로 보내고,
//   화면(web/session-chat.ts onOutboxTyped)은 기다리던 말의 머리를 web/lib/outbox-echo.ts promptHead 로 만들어 글자 그대로 견준다.
//   두 함수가 갈리면 긴 말·공백이 섞인 말이 안 맞아 넘김이 에코(제출 훅 뒤 몇 초)나 유예(8초)로 밀린다 — 같은 표로 맞춘다.
//  엣지: 짧은 말 · 줄바꿈 · 탭 · 연속 공백 · 앞뒤 공백 · 정확히 160자 · 161자 · 160번째 글자가 공백(잘린 머리를 다시 다듬으면 갈리는 자리)
//   · 긴 말인데 160자 뒤만 다름(같은 말로 친다 — 같은 말 판정과 같다) · 160자 안에서 한 글자 다름(다른 말).
// 실행: npm run build && node scripts/outbox-typed-contract.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.env.SRC_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const ok = (cond, name, detail = "") => { assert.ok(cond, `${name}${detail ? " — " + detail : ""}`); pass++; console.log(`ok  ${name}`); };
const tmp = mkdtempSync(path.join(tmpdir(), "outbox-typed-"));
try {
  execFileSync(path.join(distRoot, "node_modules/.bin/tsc"),
    [path.join(root, "web/lib/outbox-echo.ts"), "--outDir", tmp, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
    { stdio: "inherit" });
  const { promptHead, PROMPT_HEAD } = await import(pathToFileURL(path.join(tmp, "outbox-echo.js")).href);
  const serverJs = path.join(distRoot, "dist/sessions/session-outbox.js");
  ok(existsSync(serverJs), "전제 — 서버 모듈이 빌드돼 있다(npm run build)", serverJs);
  const { typedHead, ECHO_HEAD_CHARS } = await import(pathToFileURL(serverJs).href);
  ok(typeof promptHead === "function" && typeof typedHead === "function", "두 함수가 있다(화면 promptHead · 서버 typedHead)");
  ok(PROMPT_HEAD === ECHO_HEAD_CHARS && PROMPT_HEAD === 160, "머리 길이가 같다(160)", `${PROMPT_HEAD} · ${ECHO_HEAD_CHARS}`);

  const long = (n, at = -1) => Array.from({ length: n }, (_, i) => (i === at ? " " : "가나다라마바사"[i % 7])).join("");
  const SAME = [
    ["짧은 말", "짧은 말"],
    ["줄바꿈", "되살리며 보낸 말\n둘째 줄"],
    ["탭·연속 공백", "a\t\tb   c"],
    ["앞뒤 공백", "   앞뒤에 공백   "],
    ["정확히 160자", long(160)],
    ["161자", long(161)],
    ["160번째 글자가 공백", long(300, 159)],
    ["161번째 글자가 공백", long(300, 160)],
    ["긴 말 · 줄바꿈 섞임", "첫 줄\n\n" + long(400)],
    ["빈 말", ""],
  ];
  for (const [name, text] of SAME) {
    const s = typedHead(text), w = promptHead(text);
    ok(s === w, `C1 ${name} — 서버와 화면의 머리가 같은 글자다`, JSON.stringify({ s, w }));
    ok(s.length <= 160, `C2 ${name} — 머리는 160자를 넘지 않는다`, String(s.length));
  }
  //  긴 말인데 160자 뒤만 다르다 — 같은 말로 친다(같은 말 판정 samePrompt 와 같다)
  ok(typedHead(long(200) + "끝A") === promptHead(long(200) + "끝B"), "C3 160자 뒤만 다른 긴 말은 같은 말로 본다(같은 말 판정과 같다)");
  //  160자 안에서 한 글자라도 다르면 다른 말
  ok(typedHead("보낸 말 A") !== promptHead("보낸 말 B"), "C4 짧은 말이 한 글자 다르면 다른 말이다");
  ok(typedHead(long(100) + "X" + long(100)) !== promptHead(long(100) + "Y" + long(100)), "C5 160자 안에서 한 글자 다르면 다른 말이다");
  //  앞 말의 머리가 뒤 말의 머리의 앞부분일 뿐이면 다른 말(접두 일치로 맞추지 않는다)
  ok(typedHead("보낸 말") !== promptHead("보낸 말 더 길게"), "C6 한 말이 다른 말의 앞부분일 뿐이면 다른 말이다");
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log(`\noutbox-typed-contract: ${pass} 통과`);
