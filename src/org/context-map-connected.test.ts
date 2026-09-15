// #1631 (원준 2026-09-15) — 맥락 관리 흐름 지도의 «외부 앱» 역은 **실제로 연결된** 수집기만 센다.
//
//  신고: «슬랙은 연결도 안 돼 있는데 외부 앱에 아이콘이 나온다». 원인 — 매니지드는 워크스페이스마다 노션·슬랙 등 수집기 껍데기를
//  enabled:false 로 심어 두는데, 지도가 그 껍데기까지 세어 제 색 로고로 그렸다. 연결의 조건은 «켜짐 + 자격(인라인 시크릿 또는 token_source)».
//  DOM 바운드라 유닛으로 못 돌린다 — 구조를 소스에서 못박는다(레포 선례).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const MAP = readFileSync("web/context-map.ts", "utf8");

test("★★ «외부 앱» 역이 켜지고 자격 있는 수집기만 센다 — enabled:false 껍데기는 «연결됨» 이 아니다", () => {
  const m = MAP.match(/const collectors: any\[\] =([\s\S]*?);/);
  assert.ok(m, "collectors 를 만드는 자리를 못 찾았다 — 검사가 헛돈다");
  const block = m[1];
  assert.match(block, /\.filter\(/, "★ 수집기를 거르지 않는다 — 껍데기까지 «연결된 앱» 으로 센다");
  assert.match(block, /c\.enabled === true/, "★ enabled 를 안 본다 — 꺼진 껍데기가 아이콘으로 뜬다");
  assert.match(block, /secretsSet/, "자격(시크릿)을 안 본다");
  assert.match(block, /token_source/, "금고 연결(token_source)을 안 본다 — 그걸로 연결한 수집기가 사라진다");
});
