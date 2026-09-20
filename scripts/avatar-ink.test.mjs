#!/usr/bin/env node
// 아바타 글자색 — 배경 휘도로 흰 글자/어두운 글자를 고르는 규칙 (#4108)
//
// 왜 생겼나: 프로필 배경색을 **표 밖에서 아무 색이나** 고를 수 있게 되면서(원준 2026-09-20),
//  노랑처럼 밝은 색에서 기본 흰 글자가 아예 안 보이게 됐다.
//
// 사양(행 = 색 → 기대):
//  A1  밝은 노랑(#ffe08a)은 어두운 글자
//  A2  어두운 남색(#22305a)은 흰 글자(빈 문자열 = 스타일시트 기본)
//  A3  흰색·검정 양끝
//  A4  ★ 12색 표 중 **흰 글자가 3:1 아래인 여섯**만 뒤집힌다 — 나머지 여섯은 그대로 흰 글자.
//      («표는 다 어두우니 안 닿는다» 가 틀렸다는 것을 여기 박아 둔다 — 실제로 절반이 닿는다.)
//  A5  경계는 L=0.30(= 흰 글자 대비 3:1). 0.2148(대비가 같아지는 점)이 아니다 — 그걸 쓰면 흰 글자가
//      멀쩡한 파랑·보라까지 뒤집혀 쓰던 사람의 얼굴이 이유 없이 바뀐다.
//  A6  hex 가 아니면 규칙 밖(빈 문자열) — 이름에서 뽑는 hsl 자동색은 건드리지 않는다.
//      ⚠ 여기서 «#fffff»(다섯 자리) 를 함께 재는 이유: 그냥 `if (!hex)` 로 바꿔도 hsl·빈 값은 NaN 을
//      타고 우연히 같은 답이 나온다(변이로 확인했다 — 그 줄이 죽었는데 테스트가 초록이었다). 자리 수가
//      모자란 값은 **파싱이 되면서 엉뚱하게 밝은 색**이 되므로, 그 한 칸이 이 가드를 실제로 붙잡는다.
//  A7  뒤집은 색은 **실제로 더 잘 보인다**(어두운 글자 대비 > 흰 글자 대비).
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = buildSync({
  entryPoints: [path.join(ROOT, "web/lib/avatar.ts")],
  bundle: true, format: "cjs", platform: "node", target: "es2020", write: false, logLevel: "silent",
}).outputFiles[0].text;
// 잎 모듈이 import 시점에 건드리는 브라우저 전역만 최소로 세운다(DOM 을 쓰는 함수는 여기서 안 부른다).
globalThis.window = { matchMedia: () => ({ matches: false }), addEventListener() {} };
globalThis.location = { origin: "http://x", pathname: "/", href: "http://x/", hash: "" };
globalThis.document = { createElement: () => ({ style: {}, setAttribute() {}, append() {} }), documentElement: {}, addEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const mod = { exports: {} };
new Function("module", "exports", "require", src)(mod, mod.exports, (m) => { throw new Error("예상 못 한 require: " + m); });
const { avatarInk } = mod.exports;

const DARK = "#15233b";
const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const l = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
};
const onWhite = (hex) => 1.05 / (lum(hex) + 0.05);                 // 흰 글자 대비
const onDark = (hex) => (lum(hex) + 0.05) / (lum(DARK) + 0.05);    // 어두운 글자 대비

// 프로필 편집기의 12칸 표와 **같은 목록**이어야 한다(web/me-profile.ts AVA_COLORS).
const PRESETS = ["#6c8cff", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#06b6d4",
  "#ec4899", "#64748b", "#0ea5e9", "#14b8a6", "#f97316", "#8b5cf6"];

let pass = 0;
const ok = (cond, name, detail = "") => { assert.ok(cond, `${name}${detail ? " — " + detail : ""}`); pass++; console.log(`ok  ${name}`); };

ok(avatarInk("#ffe08a") === DARK, "A1 밝은 노랑은 어두운 글자", `흰 글자 대비 ${onWhite("#ffe08a").toFixed(2)}`);
ok(avatarInk("#22305a") === "", "A2 어두운 남색은 흰 글자 그대로");
ok(avatarInk("#ffffff") === DARK && avatarInk("#000000") === "", "A3 흰색·검정 양끝");

const flipped = PRESETS.filter((c) => avatarInk(c) === DARK);
const kept = PRESETS.filter((c) => avatarInk(c) === "");
ok(flipped.length === 6 && kept.length === 6, "A4a 12색 중 여섯만 뒤집힌다", `뒤집힘 ${flipped.length} · 유지 ${kept.length}`);
ok(flipped.every((c) => onWhite(c) < 3), "A4b 뒤집힌 여섯은 전부 흰 글자가 3:1 미만이었다", flipped.join(" "));
ok(kept.every((c) => onWhite(c) >= 3), "A4c 유지된 여섯은 전부 흰 글자가 3:1 이상이다", kept.join(" "));
ok(avatarInk("#6c8cff") === "", "A5a 기본 파랑은 흰 글자를 지킨다(3.07:1)");
ok(avatarInk("#a855f7") === "", "A5b 보라도 지킨다 — 0.2148 경계였다면 뒤집혔을 색이다", `L=${lum("#a855f7").toFixed(4)}`);
ok(avatarInk("#0ea5e9") === DARK, "A5c 하늘색은 뒤집힌다(2.77:1)");

ok(avatarInk("hsl(200, 50%, 60%)") === "" && avatarInk("") === "" && avatarInk(null) === "" && avatarInk("#abc") === "",
  "A6a hex 가 아니면 규칙 밖 — 이름에서 뽑는 자동색은 안 건드린다");
ok(avatarInk("#fffff") === "" && avatarInk("#ffffff") === DARK,
  "A6b 자리 수가 모자란 값은 색으로 읽지 않는다 — 여섯 자리라야 규칙을 탄다");
ok(flipped.every((c) => onDark(c) > onWhite(c)), "A7 뒤집은 색은 실제로 더 잘 보인다",
  flipped.map((c) => `${c} ${onWhite(c).toFixed(2)}→${onDark(c).toFixed(2)}`).join(" · "));

console.log(`\n✓ 아바타 글자색 ${pass}건 통과`);
