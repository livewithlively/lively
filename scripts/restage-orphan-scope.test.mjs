// restage.sh §2 고아 검사의 **판정 범위** 계약 — 진짜 git 저장소를 만들어 스크립트를 실제로 돌린다.
//
// 이 검사가 답하려는 질문은 하나다: «stage 를 재조립하면 이 커밋이 영영 사라지나?»
//  그 답은 «이 커밋의 내용이 **다른 곳에도** 살아 있나» 이고, 여기서 «다른 곳» 은 정본이 될 수 있는 자리
//  (main · 작업 브랜치)를 말한다. **stage 자신의 사본은 그 자리가 아니다.**
//
// 왜 실물 git 인가: 판정이 전부 `git cherry`·`git patch-id`(=내용 동등성)에 달려 있다. 흉내 내면
//  흉내가 맞는지를 검증하는 꼴이라, 실제로 커밋을 만들고 실제로 스크립트를 돌린다.
//
// 틀리면 티가 크다 (2026-09-03 실측, #2615):
//  🔴 stage 사본을 «다른 곳» 으로 세면 — stage-guard(#2457)가 push 마다 stage 를 통째로
//     `stage-snapshot/<날짜>` 에 밀어 넣으므로 **모든 직접 커밋이 자기 사본 덕에 «안전» 이 된다.**
//     고아 검사가 통째로 죽고, 재조립이 «잃을 것 없음» 이라 말하며 남의 작업을 지운다.
//     실측: `cb69da04`(정본이 어디에도 없던 커밋)가 «안전» 으로 나왔다.
//  🔴 반대로 진짜 작업 브랜치를 «다른 곳» 에서 빼면 — 옮겨 둔 커밋까지 고아로 잡혀,
//     안내대로 브랜치로 옮겨도 검사를 빠져나갈 수 없다(막다른 가드).
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RESTAGE = join(dirname(fileURLToPath(import.meta.url)), 'restage.sh');
const ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ENV } }).trim();

/** 원격 + 작업 클론. main 과 stage 가 같은 자리에서 출발한다. */
function makeWorld() {
  const root = mkdtempSync(join(tmpdir(), 'restage-'));
  const remote = join(root, 'remote.git');
  const clone = join(root, 'clone');
  execFileSync('git', ['init', '--bare', '-b', 'main', remote], { env: { ...process.env, ...ENV } });
  execFileSync('git', ['clone', '-q', remote, clone], { env: { ...process.env, ...ENV } });
  writeFileSync(join(clone, 'a.txt'), 'a\n');
  git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'init');
  git(clone, 'branch', 'stage'); git(clone, 'push', '-q', 'origin', 'main', 'stage');
  return { root, clone };
}

/** stage 에 직접 커밋 하나를 얹고 그 sha 를 준다. */
function directCommitOnStage(clone, name) {
  git(clone, 'checkout', '-q', 'stage');
  writeFileSync(join(clone, `${name}.txt`), `${name}\n`);
  git(clone, 'add', '.'); git(clone, 'commit', '-qm', `직접 커밋 ${name}`);
  git(clone, 'push', '-q', 'origin', 'stage');
  return git(clone, 'rev-parse', 'HEAD');
}

/** 그 커밋의 **내용 사본**을 다른 ref 로 만든다(SHA 는 달라진다 — 실제 운영이 그렇다). */
function copyTo(clone, sha, ref, base) {
  git(clone, 'checkout', '-q', '-B', '_tmp', base);
  git(clone, 'cherry-pick', sha);
  git(clone, 'push', '-q', 'origin', `HEAD:refs/heads/${ref}`);
  git(clone, 'checkout', '-q', 'stage');
  git(clone, 'branch', '-qD', '_tmp');
}

/** restage --dry-run 을 돌려 «고아로 중단했나» 를 본다. */
function orphanBlocked(clone) {
  const r = execFileSync('bash', [RESTAGE, '--dry-run'], {
    cwd: clone, encoding: 'utf8', env: { ...process.env, ...ENV }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return /재조립하면 사라집니다/.test(r);
}

const cases = [
  // 사본이 있는 자리                        고아로 막아야 하나
  { where: '(아무 데도 없음)', ref: null, base: null, blocked: true },
  { where: 'main',                    ref: 'main',                  base: 'origin/main',  blocked: false },
  { where: '작업 브랜치',             ref: 'feat/x',                base: 'origin/main',  blocked: false },
  { where: 'stage-snapshot/<날짜>',   ref: 'stage-snapshot/2026-09-03', base: 'origin/main', blocked: true },
  { where: 'backup/…',                ref: 'backup/stage-local',    base: 'origin/main',  blocked: true },
  { where: 'stage-orphans/…',         ref: 'stage-orphans/2026-09-03', base: 'origin/main', blocked: true },
];

for (const c of cases) {
  test(`고아 판정 — 사본이 ${c.where} 에 있으면 ${c.blocked ? '막는다' : '통과한다'}`, () => {
    const { root, clone } = makeWorld();
    try {
      const sha = directCommitOnStage(clone, 'work');
      if (c.ref) copyTo(clone, sha, c.ref, c.base);
      assert.equal(orphanBlocked(clone), c.blocked,
        c.blocked
          ? `🔴 ${c.where} 사본을 «정본이 있는 곳» 으로 셌다 — 재조립이 이 커밋을 지운다`
          : `🔴 ${c.where} 에 옮겨 둔 커밋을 고아로 잡았다 — 안내를 따라도 빠져나갈 수 없다`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
