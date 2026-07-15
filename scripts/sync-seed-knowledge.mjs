// 시딩 지식 오프라인 sync — `src/org/seed-knowledge/<name>.md`(각색 SoT)를 편집한 뒤, DB 없이
//  src/org/default-content.ts 의 DEFAULT_KNOWLEDGE 만 다시 굳힌다. 훅·스킬은 기존 파일 그대로 재사용한다.
//  (전체 재생성=capture-default-content.mjs 는 훅·스킬을 위해 canonical DB 가 필요하다. 지식만 고칠 땐 이걸 써라.)
//
//  실행:  node scripts/sync-seed-knowledge.mjs
//  → seed-knowledge 편집 → 이 스크립트 → `git diff src/org/default-content.ts` 확인 → 커밋.
//  seed-content.test.ts 가 default-content.ts 의 지식 본문 == seed-knowledge/*.md 를 강제하므로,
//   편집 후 sync 를 빠뜨리면 `npm test` 가 깨져 알려준다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emitDefaultContentModule, readSeedKnowledge, parseModuleArray } from "./capture-default-content.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "..", "src", "org", "default-content.ts");

const src = fs.readFileSync(OUT, "utf8");
const hooks = parseModuleArray(src, "DEFAULT_HOOKS");
const skills = parseModuleArray(src, "DEFAULT_SKILLS");
const knowledge = readSeedKnowledge();

fs.writeFileSync(OUT, emitDefaultContentModule({ hooks, skills, knowledge }));
console.log(`✓ ${path.relative(path.join(here, ".."), OUT)} — 지식 ${knowledge.length}종을 seed-knowledge/ 에서 재생성(훅 ${hooks.length}·스킬 ${skills.length} 유지)`);
