#!/usr/bin/env node
// 공유 워크스페이스의 **비정규(NFD) 파일·폴더 이름을 NFC 로 1회 정리**한다 (#1278b).
//
// 왜 필요한가: 저장 이름의 정본은 NFC 다(업로드 경로가 NFC 로 정규화한다). 그 이전에 맥에서 올라와
//  NFD 로 저장된 이름이 남아 있으면, 그 파일을 맥에서 고쳐 다시 올릴 때 **NFC 사본이 하나 더 생긴다**
//  (리눅스·NTFS 는 NFC/NFD 를 다른 이름으로 본다 — 실측). 그래서 배포 전후로 한 번 접어 준다.
//
// 안전선:
//  · 기본은 **dry-run**. 실제 변경은 --apply.
//  · **충돌은 절대 덮어쓰지 않는다** — NFC 이름이 이미 있으면 건너뛰고 보고한다(사람이 판단할 일).
//  · 이름만 바꾼다(내용·mtime·소유자·권한 무관). 깊은 곳부터 바꿔 상위 폴더 rename 이 하위 경로를 깨지 않게 한다.
//  · 심링크는 건너뛴다.
//
// 사용:
//   node scripts/normalize-shared-filenames.mjs [루트경로]            # 미리보기
//   node scripts/normalize-shared-filenames.mjs [루트경로] --apply    # 실제 적용
//   (루트 기본값: $LIVELY_SHARED_DIR 또는 /srv/lively/shared)
//
// ⚠ rename 은 그 경로를 참조하던 것(열려 있는 세션·문서 링크·클라이언트 원장)을 어긋나게 할 수 있다.
//   동기화가 도는 중이 아닐 때 한 번에 돌리고, 끝난 뒤 각 클라이언트는 다음 턴에 자연히 수렴한다
//   (훅이 비교 키를 NFC 로 접으므로 로컬 이름이 NFD 여도 중복·삭제가 나지 않는다).
import fs from "node:fs";
import path from "node:path";

const root = process.argv.find((a) => !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1])
  || process.env.LIVELY_SHARED_DIR || "/srv/lively/shared";
const apply = process.argv.includes("--apply");

/** 깊이 우선으로 모든 항목을 모은다(깊은 것 먼저 반환 — 상위를 먼저 바꾸면 하위 경로가 깨진다). */
function collect(dir, out = [], depth = 0) {
  if (depth > 40) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;                  // 링크는 건드리지 않는다
    if (e.isDirectory()) collect(p, out, depth + 1);
    out.push({ dir, name: e.name, abs: p, isDir: e.isDirectory() });
  }
  return out;
}

const items = collect(root);
const targets = items.filter((i) => i.name.normalize("NFC") !== i.name);
let renamed = 0, collided = 0, failed = 0;

console.log(`루트: ${root}`);
console.log(`전체 항목 ${items.length}개 · 비정규(NFD) 이름 ${targets.length}개 · 모드 ${apply ? "APPLY" : "dry-run"}\n`);

for (const t of targets) {
  const to = path.join(t.dir, t.name.normalize("NFC"));
  const shortFrom = path.relative(root, t.abs);
  const bytes = `${Buffer.byteLength(t.name)}B→${Buffer.byteLength(t.name.normalize("NFC"))}B`;
  if (fs.existsSync(to)) {
    collided++;
    console.log(`  [충돌·건너뜀] ${shortFrom}\n      NFC 이름이 이미 존재합니다 — 두 파일 중 무엇을 남길지 사람이 정해야 합니다.`);
    continue;
  }
  if (!apply) { console.log(`  [예정] ${shortFrom}  (${bytes})`); continue; }
  try { fs.renameSync(t.abs, to); renamed++; console.log(`  [변경] ${shortFrom}  (${bytes})`); }
  catch (e) { failed++; console.log(`  [실패] ${shortFrom} — ${e.message}`); }
}

console.log(`\n대상 ${targets.length} · ${apply ? `변경 ${renamed}` : "미적용(dry-run)"} · 충돌 ${collided} · 실패 ${failed}`);
if (!apply && targets.length) console.log("실제 적용하려면 --apply 를 붙여 다시 실행하세요.");
process.exit(failed ? 1 : 0);
