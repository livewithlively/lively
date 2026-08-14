// 저장소 관리 ▸ '선택 정리' 대상 집합 계산 — 회귀 가드 (web/admin-storage-plan.ts).
//
// 왜 이 테스트가 있나: 서버의 `remove_worktree` 는 **요청 단위** 플래그라 한 배치에 섞을 수 없다.
// 그래서 선택을 두 묶음(파생물만 / 워크트리까지)으로 가르는데, 이 가르기가 틀리면 **에러 하나 없이
// 대상이 조용히 빠진다.** 화면엔 '제거 가능'이라 떠 있는데 버튼만 안 먹는 형태라 아무도 버그로 신고하지 않는다.
//
// 실제로 그랬다: 종전 코드가 `reclaimable_bytes > 0` 으로만 걸러서, **파생물을 이미 회수해 둔 폴더**
// (= 정확히 워크트리만 남은 폴더)가 영영 선택되지 않았다. 이 박스 실측 164개·5.01GB.
//
// 러너는 web/ 을 수집하지 않으므로(src/**/*.test.ts 와 kit|scripts|deploy/**/*.test.mjs 만) 컴파일
// 산출물을 import 한다. 이 모듈은 DOM·전역 의존이 없어 그대로 부를 수 있다 — 그 성질도 여기서 강제된다
// (전역을 잡는 순간 이 import 가 터진다).
import { strict as assert } from "node:assert";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOD = path.join(ROOT, "public/app/admin-storage-plan.js");
const { planReclaimBatches, wtRemovable } = await import(pathToFileURL(MOD).href);

/** 분석 결과 픽스처 — recl=회수 가능 바이트, wt=워크트리별 removable 배열. */
const pr = (recl, wt = []) => ({ reclaimable_bytes: recl, results: wt.map((w) => ({ worktree_removable: w })) });
const plan = (sel, wtSel, entries) =>
  planReclaimBatches(new Set(sel), new Set(wtSel), new Map(Object.entries(entries)));

// ── P1 파생물만 ──
{
  const r = plan(["A"], [], { A: pr(100, [false]) });
  assert.deepEqual(r.actFolders, ["A"], "P1 actFolders");
  assert.deepEqual(r.derivedOnly, ["A"], "P1 derivedOnly");
  assert.deepEqual(r.wtFolders, [], "P1 wtFolders");
  assert.equal(r.selBytes, 100, "P1 selBytes");
}

// ── P2 ★ 파생물 0인데 워크트리 옵트인 — 이번 수정의 본체 ──
{
  const r = plan([], ["B"], { B: pr(0, [true]) });
  assert.deepEqual(r.actFolders, ["B"],
    "P2: 파생물이 0이어도 워크트리 옵트인만으로 대상이어야 한다 — 이게 빠지면 화면에 '제거 가능'이라 " +
    "띄우면서 버튼은 안 먹는 상태로 돌아간다(실측 164개·5.01GB 가 영영 안 지워진다)");
  assert.deepEqual(r.wtFolders, ["B"], "P2 wtFolders");
  assert.deepEqual(r.derivedOnly, [], "P2 derivedOnly — 파생물 배치엔 안 들어간다");
  assert.equal(r.selBytes, 0, "P2 selBytes");
}

// ── P3 둘 다 켬 → 워크트리 묶음에만 (두 번 정리 방지) ──
{
  const r = plan(["A"], ["A"], { A: pr(100, [true]) });
  assert.deepEqual(r.actFolders, ["A"], "P3 actFolders — 중복 없음");
  assert.deepEqual(r.wtFolders, ["A"], "P3 wtFolders");
  assert.deepEqual(r.derivedOnly, [],
    "P3: 둘 다 켜진 폴더가 양쪽 배치에 들어가면 같은 폴더를 두 번 정리한다");
  assert.equal(r.selBytes, 100, "P3 selBytes");
}

// ── P4 경계값: reclaimable_bytes === 0 은 파생물 대상이 아니다 ──
{
  const r = plan(["A"], [], { A: pr(0, [false]) });
  assert.deepEqual(r.selFolders, [], "P4 selFolders — 0 은 '> 0' 이 아니다");
  assert.deepEqual(r.actFolders, [], "P4 actFolders");
  assert.equal(r.selBytes, 0, "P4 selBytes");
}

// ── P5 스테일 옵트인: 재분석으로 판정이 뒤집힘 ──
{
  const r = plan([], ["C"], { C: pr(0, [false]) });
  assert.deepEqual(r.wtFolders, [],
    "P5: 더 이상 제거 가능이 아닌 폴더의 옛 옵트인을 그대로 보내면, 서버가 거부할 요청을 매번 쏜다");
  assert.deepEqual(r.actFolders, [], "P5 actFolders");
}

// ── P6 아직 분석 안 된 폴더의 옵트인 ──
{
  const r = plan([], ["D"], {});
  assert.deepEqual(r.wtFolders, [], "P6: 분석 결과가 없으면 제거 가능 여부를 모른다 — 대상 아님");
  assert.deepEqual(r.actFolders, [], "P6 actFolders");
}

// ── P7 혼합: 파생물 2개 중 1개는 워크트리까지 ──
{
  const r = plan(["A", "B"], ["B"], { A: pr(100, [false]), B: pr(50, [true]) });
  assert.deepEqual(r.actFolders.sort(), ["A", "B"], "P7 actFolders");
  assert.deepEqual(r.derivedOnly, ["A"], "P7 derivedOnly");
  assert.deepEqual(r.wtFolders, ["B"], "P7 wtFolders");
  assert.equal(r.selBytes, 150, "P7 selBytes — 파생물 대상 합");
}

// ── P8 빈 입력 (관측 장치가 죽지 않았는지) ──
{
  const r = plan([], [], { A: pr(100, [true]) });
  assert.deepEqual(r.actFolders, [], "P8: 아무것도 안 골랐으면 대상 0");
  assert.deepEqual(r.derivedOnly, [], "P8 derivedOnly");
  assert.deepEqual(r.wtFolders, [], "P8 wtFolders");
  assert.equal(r.selBytes, 0, "P8 selBytes");
}

// ── P9 레포 여럿 중 하나만 제거 가능 → 폴더는 대상 ──
{
  const r = plan([], ["E"], { E: pr(0, [false, true, false]) });
  assert.deepEqual(r.wtFolders, ["E"],
    "P9: 폴더에 레포가 여럿이면 하나라도 제거 가능할 때 보낸다 — 나머지는 서버가 사유를 남기고 유지한다");
}

// ── wtRemovable 단독 (새 헬퍼의 '비었음' 엣지) ──
assert.equal(wtRemovable(undefined), false, "wtRemovable(undefined)");
assert.equal(wtRemovable(null), false, "wtRemovable(null)");
assert.equal(wtRemovable({}), false, "wtRemovable({}) — results 부재");
assert.equal(wtRemovable({ results: [] }), false, "wtRemovable — results 빈 배열");
assert.equal(wtRemovable({ results: [{ worktree_removable: true }] }), true, "wtRemovable — true 하나");

console.log("ok  선택 정리 대상 집합 — 9개 시나리오 + wtRemovable 5건");
