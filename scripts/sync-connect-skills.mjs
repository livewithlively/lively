// 외부 앱 연결 스킬 원본 sync — `src/org/delivery/connect-skills/*.md`(리뷰 가능한 SoT)를 편집한 뒤, DB 없이
//  src/org/delivery/connect-skills.sources.ts 를 다시 굳힌다(#4970). 시드 훅의 sync-seed-hooks.mjs 와 같은 모델.
//
//  실행:  node scripts/sync-connect-skills.mjs
//  → 원본 편집 → 이 스크립트 → `git diff src/org/delivery/connect-skills.sources.ts` 확인 → 커밋.
//  connect-skills.test.ts 가 sources.ts == 원본 파일을 강제하므로, 편집 뒤 sync 를 빠뜨리면 `npm test` 가 깨져 알려준다.
//
//  파일 이름 규칙: `<키>.md`(두 배포 방식 공용) · `<키>.managed.md` / `<키>.selfhost.md`(판이 다를 때).
//   `_common`(모든 연결 스킬 끝에 붙는 공통 부분) · `_router`(입구 liv-connect) · 그 밖은 앱 키(slack·notion …).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(here, "..", "src", "org", "delivery", "connect-skills");
const OUT = path.join(here, "..", "src", "org", "delivery", "connect-skills.sources.ts");

export function readConnectSources(dir = SRC_DIR) {
  const out = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
    out[f.slice(0, -3)] = fs.readFileSync(path.join(dir, f), "utf8");
  }
  return out;
}

export function emitConnectSourcesModule(sources) {
  const lines = Object.keys(sources).sort().map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(sources[k])},`);
  return "// ⚠ 자동 생성물 — 손으로 고치지 말 것(#4970).\n"
    + "//  원본: src/org/delivery/connect-skills/*.md → `node scripts/sync-connect-skills.mjs` 로 다시 굳힌다.\n"
    + "//  connect-skills.test.ts 가 이 파일 == 원본 파일을 강제한다.\n"
    + "export const CONNECT_SKILL_SOURCES: Record<string, string> = {\n"
    + lines.join("\n") + "\n};\n";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sources = readConnectSources();
  const next = emitConnectSourcesModule(sources);
  const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (prev === next) {
    console.log(`✓ ${path.relative(path.join(here, ".."), OUT)} — 변경 없음(원본 ${Object.keys(sources).length}개와 이미 일치)`);
  } else {
    fs.writeFileSync(OUT, next);
    console.log(`✓ ${path.relative(path.join(here, ".."), OUT)} — 원본 ${Object.keys(sources).length}개에서 다시 굳힘: ${Object.keys(sources).join(", ")}`);
  }
}
