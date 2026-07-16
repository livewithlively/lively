// 공유폴더 pull 훅(project-pull · project-pull-turn) 소스를 이 박스의 org_hook 에 반영 — #905 P1-②.
//  소스는 kit/hooks/examples/<id>.org-hook.mjs 에서 읽어 content_hash(sha256)와 함께 박는다
//  (run-custom.mjs 가 content_hash 무결성 게이트로 검증하므로 정확히 일치해야 한다).
//
//  왜 이 스크립트가 필요한가 — seed 로는 안 닿는 박스가 있다:
//   seed-content.ts 는 훅을 "신규 삽입 + **손 안 댄 시드(updated_by='system')만** 갱신"한다. 운영자·에이전트가
//   한 번이라도 훅을 편집한 박스는 그 행이 영구 보존돼 **안전 픽스가 영영 안 닿는다**. (실측: 라이블리 canonical
//   박스의 project-pull 은 updated_by='daon', project-pull-turn 은 'yoon' — 둘 다 seed 경로 밖이다.)
//   이 훅들은 **사용자 폴더를 무음으로 덮어쓸 수 있는** 코드라, 그 낙후를 방치하면 안 된다.
//
//  하는 일 / 안 하는 일:
//   · source_code + content_hash 갱신(= 쓰기 자격 게이트 주입).
//   · **enabled·target_members 는 절대 안 건드린다** — 운영자 토글(마스터킬)·타깃 지정은 그 박스의 결정이다.
//   · **updated_by 를 'system' 으로 되돌린다(입양)** — 이러면 그 행이 seed 자동갱신 생애주기로 복귀해 **앞으로의
//     안전픽스는 이 스크립트 없이 자동으로 닿는다**. 정당한 이유: updated_by 는 '커스터마이즈했다'가 아니라 그저
//     '누가 등록/토글했나'를 담는다 — 실측(2026-07-16)으로 라이블리 박스의 두 훅은 레포 stock 과 **바이트 동일**이었다.
//     ⚠ 그래서 이 스크립트는 **로컬 커스터마이즈가 있으면 그걸 레포 판으로 교체**한다. --dry-run 이 바이트 차이를
//     보여주니 먼저 확인하라(커스터마이즈한 박스라면 관리탭에서 손으로 게이트를 이식하는 편이 맞다).
//   · 행이 없으면 아무것도 안 한다(신규 설치는 seed 의 몫 — 여기서 만들면 enabled 기본값을 이 스크립트가 정하게 된다).
//
//  사용: node --env-file=.env scripts/register-project-pull-hooks.mjs            # dry-run(기본) — 차이만 출력
//        node --env-file=.env scripts/register-project-pull-hooks.mjs --apply     # 실제 반영
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const IDS = ["project-pull", "project-pull-turn"];
const apply = process.argv.includes("--apply");

if (!process.env.ITEMS_DATABASE_URL) {
  console.error("ITEMS_DATABASE_URL 미설정 — `node --env-file=.env scripts/register-project-pull-hooks.mjs` 로 실행하세요");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: process.env.ITEMS_DATABASE_URL, max: 2 });

let changed = 0;
for (const id of IDS) {
  const source = fs.readFileSync(path.join(here, "..", "kit", "hooks", "examples", `${id}.org-hook.mjs`), "utf8");
  const hash = crypto.createHash("sha256").update(source).digest("hex");
  const cur = (await pool.query("SELECT id, enabled, version, updated_by, source_code FROM org_hook WHERE id=$1", [id])).rows[0];
  if (!cur) { console.log(`· ${id}: 이 박스에 행 없음 — 건너뜀(신규 설치는 seed 가 심는다)`); continue; }

  const gated = /function syncMode\(/.test(cur.source_code);
  if (cur.source_code === source) { console.log(`· ${id}: 이미 최신(게이트 ${gated ? "있음" : "없음"}) — 변경 없음`); continue; }
  changed++;
  console.log(`${apply ? "→" : "·"} ${id}: 갱신 ${apply ? "함" : "필요"} — 현재 updated_by=${cur.updated_by} enabled=${cur.enabled} `
    + `쓰기자격게이트=${gated ? "있음" : "**없음(사용자 폴더 무음 파괴 위험)**"} · ${cur.source_code.length}B → ${source.length}B`);
  if (!apply) continue;

  // enabled·target_members 는 SET 에서 제외 — 운영자 토글·타깃은 그 박스의 결정이라 보존.
  // updated_by='system' 입양 — 이후 안전픽스가 seed 자동갱신으로 닿게(위 헤더 근거).
  const r = await pool.query(
    `UPDATE org_hook
        SET source_code=$2, content_hash=$3, version=version+1, updated_at=now(), updated_by='system'
      WHERE id=$1
      RETURNING id, enabled, version, updated_by`, [id, source, hash]);
  console.log(`   ✓ ${JSON.stringify(r.rows[0])} (enabled 보존 · updated_by=system 입양 → 이후 seed 자동갱신)`);
}
await pool.end();

if (!apply && changed) {
  console.log(`\n${changed}종이 갱신 대상입니다. 실제 반영: --apply`);
  console.log("반영 후 새 세션부터 게이트가 적용됩니다(run-custom 이 매 세션 fetch).");
}
