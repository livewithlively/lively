#!/usr/bin/env node
// styles 회귀 가드(#317) — working 스타일시트가 HEAD 의 모든 톱레벨 셀렉터를 포함하는지 검사.
//  배경(2026-06-30 사고): learn-redesign 류 WIP styles.css 가 '옛 base' 기준으로 작성돼, 그 뒤 HEAD 에 추가된
//  코어 규칙들(.card-head h3 패딩수정·프로필 아바타 .pava/.prof-ava-*·프로젝트 보드 리스트 그룹 #280 .pjv-list-* 등)을
//  통째로 떨궜고, 게이트웨이가 그 working tree 를 라이브 서빙하면서 여러 UI 스타일이 조용히 깨졌다.
//  working 은 HEAD 에 '추가'만 해야지 '삭제'하면 안 된다(learn 추가분은 OK, HEAD 셀렉터 유실은 항상 버그).
//  이 가드는 배포(restart-gateway.sh) 때 그 유실을 잡아 경고한다. 드랍이 있으면 exit 1 + 목록.
//  #1313 R50 — 스타일시트가 단일 public/styles.css 에서 화면별 public/styles/*.css 세트로 분할됐다.
//  가드는 **합본 기준**으로 본다(분할 세트를 전부 이어붙인 문자열 = 옛 단일 파일과 같은 셀렉터 집합).
//  분할 전/후 커밋을 오가며 돌아도 되도록 양쪽 배치를 모두 읽는다(styles/ 우선, 없으면 옛 단일 파일).
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const selectors = (css) =>
  new Set((css.match(/^[.#:a-zA-Z][^{}\n]*\{/gm) || []).map((s) => s.replace(/\s*\{$/, "").trim()));

const git = (cmd) => execSync(cmd, { encoding: "utf8", maxBuffer: 64 << 20 });

// HEAD 합본 — 분할 세트(public/styles/*.css)를 이름순으로 이어붙인다. 없으면 옛 단일 파일.
const headCss = () => {
  let names = [];
  try {
    names = git("git ls-tree --name-only HEAD public/styles/").split("\n")
      .filter((n) => n.endsWith(".css")).sort();
  } catch { /* styles/ 없음 → 옛 배치 폴백 */ }
  if (names.length) return names.map((n) => git(`git show HEAD:${n}`)).join("");
  return git("git show HEAD:public/styles.css");
};

// working 합본 — 같은 규칙(styles/ 우선, 없으면 옛 단일 파일).
const workCss = () => {
  const dir = "public/styles";
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".css")).sort(); } catch { /* noop */ }
  if (names.length) return names.map((n) => fs.readFileSync(path.join(dir, n), "utf8")).join("");
  return fs.readFileSync("public/styles.css", "utf8");
};

let head, work;
try { head = selectors(headCss()); }
catch { console.log("· check-css-drops: HEAD 스타일시트 없음 — 스킵."); process.exit(0); }
try { work = selectors(workCss()); }
catch { console.log("· check-css-drops: working 스타일시트 없음 — 스킵."); process.exit(0); }

const dropped = [...head].filter((s) => !work.has(s));

if (dropped.length) {
  console.error(`⚠ styles 회귀 — HEAD 에 있는 셀렉터 ${dropped.length}건이 working 에서 사라짐(코어 규칙 유실 가능):`);
  for (const d of dropped) console.error("   - " + d);
  console.error("  → WIP 스타일시트가 옛 base 기준일 수 있음. HEAD 기준으로 재정렬해 누락 규칙을 되살려야 함.");
  process.exit(1);
}
console.log(`✓ check-css-drops: HEAD 셀렉터 전부 포함(드랍 0, 합본 셀렉터 ${work.size}건).`);
