#!/usr/bin/env node
// styles.css 회귀 가드(#317) — working public/styles.css 가 HEAD 의 모든 톱레벨 셀렉터를 포함하는지 검사.
//  배경(2026-06-30 사고): learn-redesign 류 WIP styles.css 가 '옛 base' 기준으로 작성돼, 그 뒤 HEAD 에 추가된
//  코어 규칙들(.card-head h3 패딩수정·프로필 아바타 .pava/.prof-ava-*·프로젝트 보드 리스트 그룹 #280 .pjv-list-* 등)을
//  통째로 떨궜고, 게이트웨이가 그 working tree 를 라이브 서빙하면서 여러 UI 스타일이 조용히 깨졌다.
//  working 은 HEAD 에 '추가'만 해야지 '삭제'하면 안 된다(learn 추가분은 OK, HEAD 셀렉터 유실은 항상 버그).
//  이 가드는 배포(restart-gateway.sh) 때 그 유실을 잡아 경고한다. 드랍이 있으면 exit 1 + 목록.
import { execSync } from "node:child_process";
import fs from "node:fs";

const selectors = (css) =>
  new Set((css.match(/^[.#:a-zA-Z][^{}\n]*\{/gm) || []).map((s) => s.replace(/\s*\{$/, "").trim()));

let headCss;
try { headCss = execSync("git show HEAD:public/styles.css", { encoding: "utf8", maxBuffer: 16 << 20 }); }
catch { console.log("· check-css-drops: HEAD:public/styles.css 없음 — 스킵."); process.exit(0); }

const head = selectors(headCss);
const work = selectors(fs.readFileSync("public/styles.css", "utf8"));
const dropped = [...head].filter((s) => !work.has(s));

if (dropped.length) {
  console.error(`⚠ styles.css 회귀 — HEAD 에 있는 셀렉터 ${dropped.length}건이 working 에서 사라짐(코어 규칙 유실 가능):`);
  for (const d of dropped) console.error("   - " + d);
  console.error("  → WIP styles.css 가 옛 base 기준일 수 있음. HEAD 기준으로 재정렬해 누락 규칙을 되살려야 함.");
  process.exit(1);
}
console.log("✓ check-css-drops: HEAD 셀렉터 전부 포함(드랍 0).");
