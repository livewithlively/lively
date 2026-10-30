// 시딩 훅 소스 오프라인 sync — `kit/hooks/examples/<id>.org-hook.mjs`(리뷰 가능한 SoT)를 편집한 뒤, DB 없이
//  src/org/delivery/default-content.ts 의 DEFAULT_HOOKS[].source_code 만 다시 굳힌다. 스킬·지식은 그대로 재사용한다.
//  (지식의 sync-seed-knowledge.mjs 와 동형 — 훅 판.)
//
//  실행:  node scripts/sync-seed-hooks.mjs
//  → 예제 편집 → 이 스크립트 → `git diff src/org/delivery/default-content.ts` 확인 → 커밋.
//
//  왜 필요한가(#905 P1-②): 훅 본문의 SoT 가 여태 **라이브 DB** 였다 — capture-default-content.mjs 가 org_hook 을
//   스냅샷해 default-content.ts 를 굳힌다. 그래서 훅 로직 변경이 ①코드리뷰를 안 거치고 ②레포에 diff 로 안 남고
//   ③누가 dev 박스에서 만진 상태가 그대로 고객 디폴트로 새어 나갔다(SEED_DISABLED 가 그 사고의 흉터다).
//   예제 파일이 있는 훅은 **레포 파일이 SoT**로 뒤집는다: 이 스크립트가 파일→default-content 로 굳히고,
//   seed-content.test.ts 가 둘의 바이트 일치를 강제한다(옛 capture 가 DB 본문으로 되돌리면 npm test 가 깨진다).
//  ⚠ 라이브 DB 는 이 스크립트가 안 건드린다 — 이미 뜬 박스(우리 것 포함)의 org_hook 행은 seed 가 "없을 때만/
//   손 안 댄 것만" 갱신하므로, 운영자·에이전트가 편집한 훅은 **관리탭 ▸ 커스텀 훅** 또는 등록 스크립트로 따로 반영해야 한다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emitDefaultContentModule, parseModuleArray } from "./capture-default-content.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "..", "src", "org", "delivery", "default-content.ts");
const EX_DIR = path.join(here, "..", "kit", "hooks", "examples");

// 같은 소스를 **다른 이벤트로도** 등록하는 훅의 별칭 — 훅 행 하나는 이벤트 하나뿐이라(event 는 코드 소유 잠금
//  필드) 두 이벤트에 걸려면 행이 둘이어야 한다. 소스를 복제하면 반드시 갈라지므로 한 파일을 공유한다.
//  project-push-tool: 같은 up-sync 를 PostToolUse 에서도 돈다(#3787 — Stop 만이면 턴 하나가 통째로 싱크 지연).
//  project-push-turn·project-push-start: 같은 up-sync 를 UserPromptSubmit·SessionStart 에서도 돈다(#3787 —
//   Stop·PostToolUse 만이면 «도구를 안 쓰는 변경»(터미널 드롭·탐색기로 넣기)이 다음 턴 끝까지 안 올라간다).
//  project-pull-tool: 같은 pull 을 PostToolUse 에서도 돈다(#3787 — 사람 지시 없이 오래 도는 세션은
//   SessionStart·UserPromptSubmit 만으로는 턴 내내 새 자료를 못 받는다). 그 판은 최소 간격을 탄다.
//   훅 본문이 stdin 의 hook_event_name 으로 두 판을 구분한다(PostToolUse 판은 변경 선검사·자기제한을 탄다).
const SOURCE_ALIAS = {
  "project-push-tool": "project-push", "project-push-turn": "project-push", "project-push-start": "project-push",
  "project-pull-tool": "project-pull-turn",
};

// 예제 파일이 있는 훅만 대상 — 없는 훅(delegate-router 등)은 DB 캡처본을 그대로 둔다.
export function exampleSourceFor(id) {
  const f = path.join(EX_DIR, `${SOURCE_ALIAS[id] ?? id}.org-hook.mjs`);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
}

const src = fs.readFileSync(OUT, "utf8");
const hooks = parseModuleArray(src, "DEFAULT_HOOKS");
const skills = parseModuleArray(src, "DEFAULT_SKILLS");
const knowledge = parseModuleArray(src, "DEFAULT_KNOWLEDGE");

const synced = [];
for (const h of hooks) {
  const source = exampleSourceFor(h.id);
  if (source === null || source === h.source_code) continue;
  h.source_code = source;
  synced.push(h.id);
}

fs.writeFileSync(OUT, emitDefaultContentModule({ hooks, skills, knowledge }));
const rel = path.relative(path.join(here, ".."), OUT);
console.log(synced.length
  ? `✓ ${rel} — 훅 ${synced.length}종 소스를 kit/hooks/examples/ 에서 재동결: ${synced.join(", ")}`
  : `✓ ${rel} — 변경 없음(예제 파일과 이미 일치)`);
