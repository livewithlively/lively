// deploy/serving-clone-guard.sh 의 계약 — 진짜 git 저장소를 만들어 훅을 실제로 돌린다.
//
// 왜 실물 git 인가: 이 가드가 지키는 사실은 전부 **git 이 훅을 언제 부르는가**에 달려 있다
//  (post-merge 는 ff 머지에도 불리는가 · squash 는 인자 1 을 주는가 · 머지 커밋이면 pre-commit 이
//  MERGE_HEAD 를 보는가). 그걸 흉내 내면 흉내가 맞는지를 검증하는 꼴이라, 실제로 머지를 시킨다.
//
// 틀리면 티가 크다:
//  🔴 post-merge 가 push 를 안 하면 — dev 가 조용히 언다(2026-08-26 실측 22분·15분, 미푸시 17커밋).
//  🔴 stage 아닌 브랜치까지 push 하면 — 남의 실험 브랜치를 대신 공개한다(serve-sync 가 안 하는 이유가 그것이다).
//  🔴 ff 로 받기만 한 머지에도 push 하면 — serve-sync 자신의 동기마다 원격에 쓸데없이 쓴다.
//  🔴 pre-commit 이 머지를 막으면 — stage 를 갱신하는 정당한 경로가 통째로 막힌다.
//  🔴 되돌리기가 내용을 지우면 — 가드가 아니라 사고다(reset --soft 인 이유).
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'serving-clone-guard.sh');

const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
}).trim();

/** 원격(bare) + 서빙 클론을 만들고 가드를 심는다. stage 는 원격을 추적한다. */
function makeWorld() {
  const root = mkdtempSync(join(tmpdir(), 'guard-'));
  const remote = join(root, 'remote.git');
  const clone = join(root, 'clone');
  execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, clone]);
  writeFileSync(join(clone, 'a.txt'), 'a\n');
  git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'init');
  git(clone, 'branch', 'stage'); git(clone, 'push', '-q', 'origin', 'main', 'stage');
  git(clone, 'checkout', '-q', 'stage');
  git(clone, 'branch', '--set-upstream-to=origin/stage', 'stage');
  execFileSync('bash', [GUARD], { env: { ...process.env, LIVELY_SERVE_CLONE: clone }, encoding: 'utf8' });
  return { root, remote, clone };
}
const ahead = (clone) => Number(git(clone, 'rev-list', '--count', '@{u}..HEAD'));
/** 시나리오를 세우는 **준비 커밋** — 가드의 대상이 아니다. `--no-verify` 는 이제 post-commit 이 되돌리므로
 *  훅 자체를 끄고(core.hooksPath) 만든다. 테스트가 재려는 것은 준비물이 아니라 그 다음 행동이다. */
const setupCommit = (clone, msg) => git(clone, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', msg);
/** 훅이 실제로 밀었는지는 **훅 자신의 말**로만 밖에서 알 수 있다(성공한 no-op push 는 원격에 자국을 안 남긴다).
 *  그래서 이 한 군데서만 문구를 본다 — 나머지 단언은 전부 ref 상태(부작용)를 본다. */
const mergeStderr = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  return (r.stderr || '') + (r.stdout || '');
};
const PUSHED = /올렸습니다/;
/** 원격에만 있는 새 커밋을 main 에 하나 만든다(다른 클론이 한 것처럼). */
function pushMainCommit(remote, root, name) {
  const tmp = join(root, 'other-' + name);
  execFileSync('git', ['clone', '-q', '-b', 'main', remote, tmp]);
  writeFileSync(join(tmp, name + '.txt'), name + '\n');
  git(tmp, 'add', '.'); git(tmp, 'commit', '-qm', 'from-main-' + name);
  git(tmp, 'push', '-q', 'origin', 'main');
}

test('설치 — 훅 셋이 다 깔린다(실행권한 포함)', () => {
  const w = makeWorld();
  try {
    for (const h of ['pre-commit', 'post-merge', 'post-commit']) {
      assert.ok(existsSync(join(w.clone, '.git/hooks', h)), `🔴 ${h} 미설치`);
    }
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('pre-commit — 일반 커밋은 막는다', () => {
  const w = makeWorld();
  try {
    writeFileSync(join(w.clone, 'b.txt'), 'b\n');
    git(w.clone, 'add', '.');
    assert.throws(() => git(w.clone, 'commit', '-qm', 'direct'), /./, '🔴 서빙 클론 직접 커밋이 통과했다');
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('★ post-merge — main→stage 머지커밋이 생기면 자동으로 push 된다', () => {
  const w = makeWorld();
  try {
    pushMainCommit(w.remote, w.root, 'x');
    git(w.clone, 'fetch', '-q', 'origin');
    // 진짜 머지커밋이 나게 stage 쪽에도 갈래를 만든다(--no-verify: 이 준비 커밋은 가드의 대상이 아니다)
    writeFileSync(join(w.clone, 'c.txt'), 'c\n');
    git(w.clone, 'add', '.'); setupCommit(w.clone, 'stage-side');
    git(w.clone, 'push', '-q', 'origin', 'stage');
    git(w.clone, 'merge', '--no-edit', '-q', 'origin/main');
    assert.equal(ahead(w.clone), 0, '🔴 머지 뒤 push 가 안 됐다 — serve-sync 가 여기서 영구 스킵한다');
    assert.equal(git(w.clone, 'rev-parse', 'HEAD'), git(w.clone, 'rev-parse', 'origin/stage'));
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('post-merge — ff 로 받기만 한 머지는 push 하지 않는다(serve-sync 자신의 동기)', () => {
  const w = makeWorld();
  try {
    // 다른 클론이 stage 를 앞서 놓는다 → 여기서 ff 로 따라간다
    const tmp = join(w.root, 'other-ff');
    execFileSync('git', ['clone', '-q', '-b', 'stage', w.remote, tmp]);
    writeFileSync(join(tmp, 'd.txt'), 'd\n');
    git(tmp, 'add', '.'); git(tmp, 'commit', '-qm', 'ahead'); git(tmp, 'push', '-q', 'origin', 'stage');
    const before = git(w.clone, 'rev-parse', 'origin/stage');
    git(w.clone, 'fetch', '-q', 'origin');
    const out = mergeStderr(w.clone, 'merge', '--ff-only', '-q', 'origin/stage');
    assert.equal(ahead(w.clone), 0);
    assert.notEqual(before, git(w.clone, 'rev-parse', 'HEAD'), '🔴 ff 가 안 일어났다 — 시나리오가 성립 안 함');
    assert.ok(!PUSHED.test(out), '🔴 올릴 것이 없는데 push 를 했다 — 동기 60초마다 원격에 헛물을 켠다');
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('★ post-merge — stage 가 아닌 브랜치는 남의 것이라 push 하지 않는다', () => {
  const w = makeWorld();
  try {
    pushMainCommit(w.remote, w.root, 'y');
    git(w.clone, 'fetch', '-q', 'origin');
    git(w.clone, 'checkout', '-q', '-b', 'someones-wip');
    // ⚠ 추적 원격을 **일부러 붙인다** — 안 붙이면 훅이 '추적 원격 없음'에서 먼저 빠져나가, 정작 재려던
    //  브랜치 게이트가 한 번도 실행되지 않는다(그 상태로는 게이트를 지워도 테스트가 초록이었다).
    git(w.clone, 'push', '-q', '-u', 'origin', 'someones-wip:refs/heads/someones-wip-remote');
    writeFileSync(join(w.clone, 'e.txt'), 'e\n');
    git(w.clone, 'add', '.'); setupCommit(w.clone, 'wip');
    const before = git(w.clone, 'ls-remote', '--heads', 'origin');
    git(w.clone, 'merge', '--no-edit', '-q', 'origin/main');
    // 판정은 **원격 ref 가 그대로인가** — 커밋 수를 세면 시나리오를 바꿀 때마다 숫자를 다시 맞춰야 한다.
    assert.equal(git(w.clone, 'ls-remote', '--heads', 'origin'), before, '🔴 남의 작업 브랜치를 대신 원격에 올렸다');
    assert.ok(ahead(w.clone) > 0, '🔴 올릴 것이 남아있지 않다 — 시나리오가 성립 안 함(게이트를 재지 못한다)');
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('★ pre-commit — 충돌을 해결하고 마무리하는 머지 커밋은 통과한다', () => {
  // `git merge` 자체는 pre-commit 을 부르지 않는다(pre-merge-commit 을 부른다). 그래서 가드의 MERGE_HEAD
  //  줄이 의미를 갖는 자리는 **충돌 난 머지를 사람이 해결하고 `git commit` 으로 마무리할 때** 하나뿐이다.
  //  여기가 막히면 stage 갱신의 정당한 경로가 충돌 한 번에 통째로 막힌다.
  const w = makeWorld();
  try {
    // 같은 파일을 양쪽이 다르게 고쳐 충돌을 만든다
    const tmp = join(w.root, 'other-conflict');
    execFileSync('git', ['clone', '-q', '-b', 'main', w.remote, tmp]);
    writeFileSync(join(tmp, 'a.txt'), 'from-main\n');
    git(tmp, 'add', '.'); git(tmp, 'commit', '-qm', 'main-side'); git(tmp, 'push', '-q', 'origin', 'main');
    writeFileSync(join(w.clone, 'a.txt'), 'from-stage\n');
    git(w.clone, 'add', '.'); setupCommit(w.clone, 'stage-side');
    git(w.clone, 'push', '-q', 'origin', 'stage');
    git(w.clone, 'fetch', '-q', 'origin');
    assert.throws(() => git(w.clone, 'merge', '--no-edit', '-q', 'origin/main'), /./, '🔴 충돌이 안 났다 — 시나리오 불성립');
    assert.ok(existsSync(join(w.clone, '.git/MERGE_HEAD')), '🔴 MERGE_HEAD 가 없다 — 시나리오 불성립');
    writeFileSync(join(w.clone, 'a.txt'), 'resolved\n');
    git(w.clone, 'add', '.');
    git(w.clone, 'commit', '--no-edit', '-q');   // ← 가드가 여기서 막으면 throw 한다
    // ⚠ ahead 만 재면 안 된다 — 머지를 **되돌려도** ahead 는 0 이 된다(직전 tip 이 이미 원격에 있으므로).
    //  그래서 '머지 커밋이 살아 있고, 그것이 원격의 stage 다' 를 직접 잰다.
    assert.equal(git(w.clone, 'rev-list', '--no-walk', '--count', '--merges', 'HEAD'), '1',
      '🔴 머지 커밋이 사라졌다 — post-commit 이 머지를 새 작업으로 보고 되돌렸다');
    assert.equal(git(w.clone, 'rev-parse', 'origin/stage'), git(w.clone, 'rev-parse', 'HEAD'),
      '🔴 충돌 해결 머지가 원격에 안 올라갔다');
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('★ post-commit — --no-verify 로 낸 직접 커밋은 되돌려진다(탈출구 차단)', () => {
  const w = makeWorld();
  try {
    const head0 = git(w.clone, 'rev-parse', 'HEAD');
    writeFileSync(join(w.clone, 'f.txt'), 'f\n');
    git(w.clone, 'add', '.');
    git(w.clone, 'commit', '-qm', 'someones direct work', '--no-verify');
    assert.equal(git(w.clone, 'rev-parse', 'HEAD'), head0, '🔴 --no-verify 커밋이 그대로 남았다 — 탈출구가 열려 있다');
    assert.equal(ahead(w.clone), 0, '🔴 미푸시 커밋이 남았다 — serve-sync 가 여기서 막힌다');
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('★ post-commit — 되돌려도 **내용은 하나도 안 잃는다**(staged 로 남는다)', () => {
  // 되돌리기가 사람의 일을 지우면 그건 가드가 아니라 사고다. reset --soft 인 이유가 이것이다.
  const w = makeWorld();
  try {
    writeFileSync(join(w.clone, 'f.txt'), 'precious\n');
    git(w.clone, 'add', '.');
    git(w.clone, 'commit', '-qm', 'work', '--no-verify');
    assert.equal(readFileSync(join(w.clone, 'f.txt'), 'utf8'), 'precious\n', '🔴 파일 내용이 사라졌다');
    assert.equal(git(w.clone, 'diff', '--cached', '--name-only'), 'f.txt', '🔴 staged 로 안 남았다 — 사람이 되찾을 길이 없다');
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('★ post-commit — 체리픽 진행 중에는 되돌리지 않는다(절차가 깨진다)', () => {
  const w = makeWorld();
  try {
    // 다른 브랜치에 커밋을 하나 만들어 두고 stage 로 체리픽한다
    git(w.clone, 'checkout', '-q', '-b', 'src-branch');
    writeFileSync(join(w.clone, 'g.txt'), 'g\n');
    git(w.clone, 'add', '.'); setupCommit(w.clone, 'to-pick');
    const pick = git(w.clone, 'rev-parse', 'HEAD');
    git(w.clone, 'checkout', '-q', 'stage');
    const head0 = git(w.clone, 'rev-parse', 'HEAD');
    git(w.clone, 'cherry-pick', pick);
    assert.notEqual(git(w.clone, 'rev-parse', 'HEAD'), head0, '🔴 체리픽 결과를 되돌렸다 — 절차가 깨진다');
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('--remove — 훅 셋을 다 걷는다', () => {
  const w = makeWorld();
  try {
    execFileSync('bash', [GUARD, '--remove'], { env: { ...process.env, LIVELY_SERVE_CLONE: w.clone }, encoding: 'utf8' });
    for (const h of ['pre-commit', 'post-merge', 'post-commit']) {
      assert.ok(!existsSync(join(w.clone, '.git/hooks', h)), `🔴 ${h} 가 남았다`);
    }
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});
