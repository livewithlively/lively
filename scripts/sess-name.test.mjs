// 세션 이름 규칙 한 벌(web/lib/sess-name.ts) — 사이드바 행과 세션 머리줄이 같은 이름을 쓰는가 (#3870, 원준 2026-09-30).
//
//  신고: «사이드바에 보이는 세션이름이랑 세션 위에 보이는 세션이름이 다른 경우가 있음». 실측 세션
//   box-wonjoon-jang-4b1b4cd6 — 이름 없음(label = id) · pane 제목 «우측 곁칸 AI세션 창 크기 및 상태 개선».
//   사이드바(side.ts sessText)는 pane 제목을, 머리줄(session-chat.ts)은 첫 지시 60자 + «…» 를 썼다.
//   머리줄이 규칙을 약하게 베껴 쓰고(프로젝트명 되풀이는 완전 일치만 · 기계 이름 판정 없음), 이름 없는 세션에
//   첫 지시를 이름으로 박아 두어 그 값이 pane 제목을 이겼다.
//  약속: 두 자리가 **같은 함수**를 부른다(S1~S4) · 그 함수의 값(N1~N13).
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const eq = (got, want, what) => { assert.deepEqual(got, want, what); pass++; };
const ok = (cond, what) => { assert.ok(cond, what); pass++; };

const { sessNameFace, isIdLabel } = await import(join(root, "public/app/lib/sess-name.js"));
const face = (label, work, proj = "", harness = "claude") => sessNameFace({ label, work, harness }, proj);
const main = (...a) => face(...a).main;

// ── 값 (N1~N13) ──────────────────────────────────────────────────────────────
const ID = "box-wonjoon-jang-4b1b4cd6";
const PANE = "우측 곁칸 AI세션 창 크기 및 상태 개선";
eq(face(ID, PANE, "곁칸 앱 칸"), { main: PANE, sub: "", named: false, untitled: false },
  "N1 ★신고 사례 — 이름이 id 꼴이면 pane 제목이 이름 자리를 받는다(첫 지시가 아니다)");
eq(face("곁칸 세션 카드", "곁칸 리사이징 UI 개선"), { main: "곁칸 세션 카드", sub: "곁칸 리사이징 UI 개선", named: true, untitled: false },
  "N2 사람·에이전트가 지은 이름이 있으면 그 이름 — pane 제목은 둘째 줄");
eq(main("UI 버그 해결", "레일 수정", "UI 버그 해결"), "레일 수정", "N3 이름이 프로젝트명 그대로면 pane 제목");
eq(main("UI 버그 해결 - 레일", "레일 수정", "UI 버그 해결"), "레일", "N4 '프로젝트명 + 꼬리'면 꼬리만");
eq(main("app.lvly.io 와이어프레임", "화면 짜는 중", "APP. lvly. io 셀프서브 방식 와이어프레임"), "화면 짜는 중",
  "N5 ★프로젝트명 조각을 이어붙인 변형도 되풀이 — 머리줄의 옛 사본(완전 일치만)은 이 이름을 남겼다");
eq(main("위탁 #4554", "배포 워커"), "배포 워커", "N6 기계 이름(위탁 #…)은 이름이 아니다 — 하던 일이 있으면 그것");
eq(face("위탁 #4554", ""), { main: "위탁 #4554", sub: "", named: true, untitled: false },
  "N7 기계 이름이라도 하던 일이 없으면 마지막 폴백으로 쓴다(무슨 세션인지는 말해 준다)");
eq(face(ID, "Claude Code"), { main: "claude", sub: "", named: false, untitled: true },
  "N8 pane 제목이 하네스 이름뿐이면 정보 0 — 하네스 이름으로 떨어진다(untitled)");
eq(face(ID, "", "", ""), { main: "이름 없는 세션", sub: "", named: false, untitled: true }, "N9 아무것도 없으면 «이름 없는 세션»");
eq(sessNameFace({ label: ID }, ""), { main: "이름 없는 세션", sub: "", named: false, untitled: true },
  "N10 재료 칸이 아예 없어도(undefined) 깨지지 않는다");
eq(face("결제 백오프", "결제 백오프 재시도 고치는 중"), { main: "결제 백오프", sub: "", named: true, untitled: false },
  "N11 하던 일이 이름을 되풀이만 하면 둘째 줄에 안 쓴다");
eq(main("  세션 이름  ", ""), "세션 이름", "N12 이름 앞뒤 공백은 걷는다");
eq(main("UI 버그 해결", "레일 수정", ""), "UI 버그 해결", "N13 프로젝트명이 비면 되풀이 판정을 안 한다");
ok(isIdLabel(ID) && isIdLabel("29c0b1c4-d5d7-4b05-9131-8982a7277b2e") && !isIdLabel("곁칸 세션 카드"), "N14 id 꼴 판정");

// ── 두 자리가 같은 함수를 부른다 (S1~S4) ────────────────────────────────────
const side = read("web/v2/side.ts");
const chat = read("web/session-chat.ts");
ok(/export function sessText\([^)]*\)[^{]*\{\s*return sessNameFace\(/.test(side),
  "S1 사이드바 sessText 는 lib/sess-name 의 sessNameFace 를 그대로 돌려준다(제 사본 없음)");
ok(!/function echoesProject|const HARNESS_TITLES/.test(side), "S2 사이드바에 규칙 사본이 남지 않았다");
ok(/from '\.\/lib\/sess-name\.js'/.test(chat) && /function paintTitle\(\)[\s\S]{0,400}face\(\)/.test(chat),
  "S3 ★세션 머리줄(paintTitle)이 같은 함수로 이름을 정한다");
ok(!/titleFromFirstAsk/.test(chat) && !/function cleanName/.test(chat),
  "S4 ★머리줄이 첫 지시를 이름으로 박아 두지 않고, 제 규칙 사본도 없다");

console.log(`sess-name: ${pass} passed`);
