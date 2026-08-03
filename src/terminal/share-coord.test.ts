// 단위 체크(node:assert) — 공유 링크 좌표(#1436): rootRelOf 가 resolveRootPath 의 **역함수**인가.
// 실행: npm run build && node dist/terminal/share-coord.test.js
//
// 왜 테스트하나: 이 매핑이 어긋나면 링크가 조용히 **다른 파일**(또는 남의 개인 폴더)을 가리킨다.
//  공유 링크는 한 번 뿌리면 회수할 수 없으니, 좌표 왕복이 항등이라는 계약을 여기서 못박는다.
//  엣지 표·정책 원문은 이 변경의 사양 메모 참조(요지는 각 케이스 주석에 인라인).
//
// ⚠ ROOTS 는 **모듈 로드 시점에** env 를 읽는 상수(catalog.ts)라 import 보다 먼저 env 를 세운다 → 동적 import.
//  격리(#524)는 끈다: 켜져 있으면 베이스가 /srv/lively/shared·/home/box_* 로 갈려 임시 경로로 잴 수 없다
//  (맥에선 자동으로 꺼지지만 Linux CI 에서도 결정적이어야 한다).
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";

process.env.LIVELY_MEMBER_ISOLATION = "off";
const TMP = path.join(os.tmpdir(), "lively-share-coord");
process.env.TERMINAL_ROOT_SHARED = path.join(TMP, "shared");
process.env.TERMINAL_ROOT_PERSONAL = path.join(TMP, "box");

const { resolveRootPath, rootRelOf, pickRootCoord } = await import("./profiles.js");

const ME = { userId: "yoon", email: "yoon@lively.kr", scopes: [] } as never;
const OTHER = { userId: "wonjun", email: "wonjun@lively.kr", scopes: [] } as never;

let pass = 0;
const t = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

// ── ①②③④⑤ 왕복 항등 — 정방향으로 만든 절대경로를 역방향에 넣으면 같은 좌표가 나온다. ──
for (const [root, rel] of [
  ["shared", ""],                                  // ① 루트 자신
  ["shared", "a"],                                 // ② 하위 1단
  ["shared", "project/1436/docs/보고서.md"],        // ③ 중첩 + 한글(공유폴더는 유니코드 이름을 그대로 쓴다)
  ["personal", ""],                                // ④ 개인 루트 자신
  ["personal", "노트/todo.txt"],                    // ⑤ 개인 하위 중첩
] as Array<[string, string]>) {
  await t(`왕복 항등: ${root} / ${rel || "(루트 자신)"}`, async () => {
    const { abs } = await resolveRootPath(ME, root, rel);
    assert.deepEqual(await rootRelOf(ME, abs), { root, rel });
  });
}

// ── ⑥ 루트 밖 → 좌표 없음(원격 노드 세션·시스템 경로 등은 공유 링크를 만들 수 없다). ──
await t("루트 밖 절대경로 → null", async () => {
  assert.equal(await rootRelOf(ME, path.join(TMP, "elsewhere", "x.md")), null);
});

// ── ⑦ perUser 격벽 — 남의 개인 폴더는 잡히지 않는다. ──
//  잡힌다면 "경로만 알면 남의 개인 파일 링크를 만들 수 있다"는 뜻이다. 이 방향을 막는 회귀 테스트다.
await t("남의 개인 폴더 절대경로 → null (perUser 격벽)", async () => {
  const { abs } = await resolveRootPath(OTHER, "personal", "secret.md");
  const mine = (await resolveRootPath(ME, "personal", "")).base;
  assert.notEqual(path.dirname(abs), mine);          // 배선 확인 — 두 사람의 개인 base 가 실제로 갈려 있나
  assert.equal(await rootRelOf(ME, abs), null);
});

// ── ⑧ 프로젝트 폴더는 공유 좌표로 잡힌다(개인으로 잡히면 세 탐색기의 링크가 갈린다). ──
await t("프로젝트 폴더(legacy 포함)는 shared 좌표", async () => {
  const { abs } = await resolveRootPath(ME, "shared", "legacy-project/1436/AGENTS.md");
  assert.deepEqual(await rootRelOf(ME, abs), { root: "shared", rel: "legacy-project/1436/AGENTS.md" });
});

// ── ⑧-b 루트 **중첩** 시 어느 쪽이 이기나 — 순수 seam(pickRootCoord)으로 직접 잰다. ──
//  ROOTS 는 모듈 로드 시 env 로 고정돼 한 프로세스에서 다른 배치를 만들 수 없으므로, 이 정책만 seam 으로 확인한다.
//  ⭐ 실질 위험: 얕은 쪽(shared)이 이기면 **개인 파일에 root=shared 링크**가 나오고, shared 는 perUser 가
//   아니므로 그 링크는 전원에게 같은 파일로 열린다 = 설정 실수 하나가 개인 파일을 전원 공개로 바꾼다.
//   그래서 깊은 쪽(personal)이 이겨야 한다(fail-closed) — 목록에 얕은 쪽이 먼저 오더라도.
await t("루트가 중첩되면 더 깊은(구체적) 루트가 이긴다 — 개인 파일이 shared 링크로 새지 않게", async () => {
  const bases = [
    { root: "shared", base: "/srv/lively/shared" },
    { root: "personal", base: "/srv/lively/shared/personal/yoon" },   // 공유 루트 **안**에 개인 루트를 둔 배포
  ];
  assert.deepEqual(pickRootCoord(bases, "/srv/lively/shared/personal/yoon/일기.md"),
    { root: "personal", rel: "일기.md" });
  // 개인 루트 밖(공유 영역)은 그대로 shared — 중첩 규칙이 공유 좌표를 잡아먹지 않는다.
  assert.deepEqual(pickRootCoord(bases, "/srv/lively/shared/project/1436/a.md"),
    { root: "shared", rel: "project/1436/a.md" });
  // 목록 순서를 바꿔도 답이 같다(깊이 기준이지 순서 기준이 아니다).
  assert.deepEqual(pickRootCoord([...bases].reverse(), "/srv/lively/shared/personal/yoon/일기.md"),
    { root: "personal", rel: "일기.md" });
});

// ── ⑨ 경계값 — 루트 base 와 **이름이 겹치는 형제** 디렉터리는 루트 안이 아니다. ──
//  startsWith(base) 로만 재면 '<base>-other' 가 루트 안으로 오검출되고, 그 순간 링크가 루트 밖 파일을
//  가리킨다(그리고 그 좌표를 다시 정방향에 넣으면 전혀 다른 경로가 된다). 표에 이 행이 없으면 안 잡힌다.
await t("base 접두사만 겹치는 형제 경로 → null (경계값)", async () => {
  const shared = (await resolveRootPath(ME, "shared", "")).base;
  assert.equal(await rootRelOf(ME, shared + "-other/f.md"), null);
});

// ── ⑩ 어느 루트도 해소되지 않는 경우 — 순회가 throw 를 삼키고 끝까지 돌아 null 로 끝난다. ──
//  (허용 루트 목록이 비는 배포는 없지만, 좌표를 못 구하는 상황에서 **예외를 던지면** 파일 목록 응답 자체가
//   깨진다 — 공유 링크는 부가 기능이라 없으면 없는 대로 목록은 떠야 한다.)
await t("루트 밖 + 상대경로처럼 생긴 입력도 예외 없이 null", async () => {
  assert.equal(await rootRelOf(ME, path.join(os.tmpdir(), "..", "definitely-not-a-root")), null);
});

console.log(`\n${pass} checks passed`);
