// scripts/serve-sync.sh 의 계약 — 진짜 git 원격·서빙 클론을 만들고 스크립트를 실제로 돌린다(#4814).
//
// 왜: 이 잡이 남기는 logs/stage-sync.status 가 /readyz 의 stageSync 다(src/ops/stage-sync-status.ts).
//  당긴 뒤 빌드·재시작이 실패했는데 «synced» 라 말하면 dev 가 옛 프로세스로 도는 동안 아무도 모른다.
//  2026-10-16 실측: stage 의 tsc 깨짐으로 03:28 부터 13시간 재시작이 실패했는데 상태는 내내 synced 였다(#4780).
//
// 틀리면 티가 크다:
//  🔴 재시작이 실패했는데 synced — 그 사고 그대로다.
//  🔴 다음 틱(이미 최신)이 실패를 잊고 synced — 같은 사고가 한 틱 늦게 온다(실측은 이쪽이었다).
//  🔴 밀린 재시작을 잊으면 — 실패 뒤 src 를 안 건드리는 커밋이 와도 옛 프로세스가 계속 돈다.
//  🔴 실패한 단계를 매 틱 다시 돌리면 — 깨진 빌드를 1분마다 다시 빌드한다(그 컴퓨터의 CPU).
//  🔴 healthz 가 200 이 아닌데 synced.
//
// 바깥 도구는 가짜로 둔다: npm(build:web·install)·curl(healthz)은 PATH 앞의 가짜가, scripts/restart-gateway.sh 는
//  클론에 심은 가짜가 받는다. 각자 CTRL 폴더에 «<이름>.fail» 이 있으면 실패하고, 불릴 때마다 «<이름>.calls» 에 한 줄 남긴다.
//  단언은 문구가 아니라 부작용(상태 파일 · 밀린 단계 파일 · 호출 횟수 · 종료코드)으로 한다.
// 시험마다 자기 원격·클론을 따로 만들므로 서로 독립이다 — 묶음을 동시에 돌린다(프로세스를 많이 띄우는 시험이라
//  차례로 돌리면 러너의 파일당 상한(--budget)에 걸린다).
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SYNC = process.env.SERVE_SYNC_SH || join(dirname(fileURLToPath(import.meta.url)), 'serve-sync.sh');

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
delete GIT_ENV.LIVELY_SERVE_RETRY_SEC;   // 기본값(900초)을 재는 시험이 있다 — 바깥 환경이 새어 들지 않게
const pexec = promisify(execFile);
const git = async (cwd, ...args) => (await pexec('git', args, { cwd, encoding: 'utf8', env: GIT_ENV })).stdout.trim();

const FAKE_RESTART = `#!/bin/bash
echo "restart $*" >> "$SS_CTRL/restart.calls"
[ -e "$SS_CTRL/restart.fail" ] && exit 1
exit 0
`;
const FAKE_NPM = `#!/bin/bash
case "$1" in
  run) [ "$2" = "build:web" ] && { echo "$*" >> "$SS_CTRL/web.calls"; [ -e "$SS_CTRL/web.fail" ] && exit 1; } ;;
  install) echo "$*" >> "$SS_CTRL/deps.calls"; [ -e "$SS_CTRL/deps.fail" ] && exit 1 ;;
esac
exit 0
`;
// serve-sync 는 «curl -s -o /dev/null -w '%{http_code}' … /healthz» 로 코드만 읽는다.
const FAKE_CURL = `#!/bin/bash
echo x >> "$SS_CTRL/healthz.calls"
printf '%s' "$(cat "$SS_CTRL/healthz" 2>/dev/null || echo 200)"
`;

/** 원격(bare) + 서빙 클론(stage 체크아웃) + 가짜 도구. 클론은 원격과 같은 커밋에서 시작한다. */
async function makeWorld(t) {
  const root = mkdtempSync(join(tmpdir(), 'serve-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const w = { root, remote: join(root, 'remote.git'), clone: join(root, 'clone'), ctrl: join(root, 'ctrl'), bin: join(root, 'bin') };
  mkdirSync(w.ctrl); mkdirSync(w.bin);
  writeFileSync(join(w.bin, 'npm'), FAKE_NPM, { mode: 0o755 });
  writeFileSync(join(w.bin, 'curl'), FAKE_CURL, { mode: 0o755 });
  await git(root, 'init', '-q', '--bare', w.remote);
  await git(root, 'init', '-q', '-b', 'stage', w.clone);
  for (const d of ['scripts', 'src', 'web']) mkdirSync(join(w.clone, d));
  writeFileSync(join(w.clone, 'scripts', 'restart-gateway.sh'), FAKE_RESTART, { mode: 0o755 });
  writeFileSync(join(w.clone, 'src', 'a.ts'), 'a\n');
  writeFileSync(join(w.clone, 'web', 'a.ts'), 'a\n');
  writeFileSync(join(w.clone, 'README.md'), 'r\n');
  await git(w.clone, 'add', '.'); await git(w.clone, 'commit', '-qm', 'init');
  await git(w.clone, 'remote', 'add', 'origin', w.remote);
  await git(w.clone, 'push', '-q', '-u', 'origin', 'stage');
  return w;
}

/** 다른 사람이 stage 에 커밋 하나를 올린 것처럼 한다(파일 여럿이면 한 커밋에). */
async function pushStage(w, ...files) {
  const other = join(w.root, 'other');
  if (!existsSync(other)) await git(w.root, 'clone', '-q', '-b', 'stage', w.remote, other);
  else await git(other, 'pull', '-q', '--ff-only');
  for (const f of files) {
    mkdirSync(dirname(join(other, f)), { recursive: true });
    writeFileSync(join(other, f), `${f} ${Date.now()} ${Math.random()}\n`);
  }
  await git(other, 'add', '.'); await git(other, 'commit', '-qm', `touch ${files.join(' ')}`); await git(other, 'push', '-q', 'origin', 'stage');
}

/** 스크립트를 한 번 돌린다 — 실패(종료코드 ≠ 0)도 결과로 돌려준다. */
const run = (w, env = {}, ...args) => new Promise((resolve, reject) => {
  const p = spawn('bash', [SYNC, ...args], {
    env: { ...GIT_ENV, PATH: `${w.bin}:${process.env.PATH}`, SS_CTRL: w.ctrl, LIVELY_SERVE_CLONE: w.clone, LIVELY_SERVE_BRANCH: 'stage', ...env },
  });
  let stdout = '', stderr = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });
  p.on('error', reject);
  p.on('close', (status) => resolve({ status, stdout, stderr }));
});
const STATUS = (w) => join(w.clone, 'logs', 'stage-sync.status');
const statusOf = (w) => JSON.parse(readFileSync(STATUS(w), 'utf8'));
const PENDING = (w) => join(w.clone, 'logs', 'stage-sync.pending');
const pendingOf = (w) => (existsSync(PENDING(w)) ? readFileSync(PENDING(w), 'utf8').trim() : '');
const calls = (w, name) => {
  const f = join(w.ctrl, `${name}.calls`);
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0;
};
const setFail = (w, name, on) => (on ? writeFileSync(join(w.ctrl, `${name}.fail`), '') : rmSync(join(w.ctrl, `${name}.fail`), { force: true }));
const out = (r) => `exit=${r.status}\n${r.stdout}${r.stderr}`;
/** 마지막 시도 시각(밀린 단계 파일의 mtime)을 sec 초 전으로 — 재시도 간격을 실제로 기다리지 않는다. */
const lastTryAgo = (w, sec) => { const t = Date.now() / 1000 - sec; utimesSync(PENDING(w), t, t); };
/** 마지막 시도 시각을 epoch 초로 못 박는다 — 경계는 스크립트의 시계(LIVELY_SERVE_NOW)와 함께 고정해야 1초 단위로 잰다. */
const setLastTry = (w, epoch) => utimesSync(PENDING(w), epoch, epoch);
/** 재시작이 실패한 상태를 만든다 — 앞 틱의 synced 위에서(실측과 같은 순서). */
async function failRestart(w) {
  assert.equal((await run(w)).status, 0);
  assert.equal(statusOf(w).state, 'synced', '준비: 앞 틱은 synced');
  setFail(w, 'restart', true);
  await pushStage(w, 'src/b.ts');
  return run(w);
}

describe('serve-sync — 실패 상태와 밀린 단계 (#4814)', { concurrency: 8 }, () => {
  it('E1 평상시 — src 커밋을 당겨 다시 띄우면 synced, 밀린 단계는 남지 않는다', async (t) => {
    const w = await makeWorld(t);
    await pushStage(w, 'src/b.ts');
    const r = await run(w);
    assert.equal(r.status, 0, out(r));
    assert.equal(statusOf(w).state, 'synced');
    assert.equal(calls(w, 'restart'), 1, '배선: 가짜 재시작이 실제로 불렸다');
    assert.equal(calls(w, 'healthz'), 1, '배선: 가짜 healthz 가 실제로 불렸다');
    assert.equal(existsSync(PENDING(w)), false, '🔴 다 끝냈는데 밀린 단계가 남았다');
  });

  it('E2 ★ 재시작이 실패하면 failed(restart) — synced 라 말하지 않는다', async (t) => {
    const w = await makeWorld(t);
    const r = await failRestart(w);
    assert.equal(r.status, 1, out(r));
    assert.equal(calls(w, 'restart'), 1);
    const st = statusOf(w);
    assert.equal(st.state, 'failed', '🔴 재시작이 실패했는데 synced 가 남았다 — 그 사고 그대로다');
    assert.equal(st.code, 'restart');
    assert.equal(pendingOf(w), 'restart', '🔴 밀린 재시작을 적어 두지 않았다');
  });

  it('E3·E8 ★ 다음 틱(이미 최신 · 기본 간격 전) — 실패를 잊지 않고, 깨진 빌드를 다시 돌리지 않는다', async (t) => {
    const w = await makeWorld(t);
    await failRestart(w);
    const first = statusOf(w);
    const r = await run(w);                    // LIVELY_SERVE_RETRY_SEC 없음 = 기본 900초
    assert.equal(r.status, 0, out(r));
    const st = statusOf(w);
    assert.equal(st.state, 'failed', '🔴 다음 틱이 실패를 잊고 synced 를 찍었다 — 실측은 이쪽이었다');
    assert.equal(st.code, 'restart');
    assert.equal(st.since, first.since, '🔴 막힌 시작 시각을 이어 가지 않았다 — 얼마나 오래 막혔는지 모른다');
    assert.equal(calls(w, 'restart'), 1, '🔴 간격도 안 지났는데 다시 빌드·재시작했다 — 매 틱 깨진 빌드를 돌린다');
    assert.equal(pendingOf(w), 'restart');
  });

  it('E4·E5 간격이 지나면 다시 시도한다 — 또 실패하면 시도 시각을 새로 잡고, 고쳐졌으면 synced', async (t) => {
    const w = await makeWorld(t);
    await failRestart(w);
    lastTryAgo(w, 901);
    const again = await run(w);
    assert.equal(again.status, 1, out(again));
    assert.equal(calls(w, 'restart'), 2);
    assert.equal(statusOf(w).state, 'failed');
    await run(w);
    assert.equal(calls(w, 'restart'), 2, '🔴 실패한 재시도 바로 다음 틱이 또 돌렸다 — 시도 시각을 새로 잡지 않았다');
    setFail(w, 'restart', false);
    lastTryAgo(w, 901);
    const r = await run(w);
    assert.equal(r.status, 0, out(r));
    assert.equal(calls(w, 'restart'), 3);
    assert.equal(statusOf(w).state, 'synced');
    assert.equal(existsSync(PENDING(w)), false, '🔴 고쳐졌는데 밀린 단계가 남았다');
  });

  it('E6·E7·E9 재시도 간격의 경계 — 정확히 지났으면 한다(≥), 1초 모자라면 안 한다, 0 이면 곧바로', async (t) => {
    const w = await makeWorld(t);
    await failRestart(w);
    const T0 = Math.floor(Date.now() / 1000) - 1000;   // 못 박은 «마지막 시도» 시각
    setLastTry(w, T0);
    await run(w, { LIVELY_SERVE_RETRY_SEC: '100', LIVELY_SERVE_NOW: String(T0 + 99) });
    assert.equal(calls(w, 'restart'), 1, '🔴 간격(100초)에서 1초 모자란데 다시 돌렸다');
    setLastTry(w, T0);
    await run(w, { LIVELY_SERVE_RETRY_SEC: '100', LIVELY_SERVE_NOW: String(T0 + 100) });
    assert.equal(calls(w, 'restart'), 2, '🔴 정확히 간격만큼 지났는데 다시 시도하지 않았다(> 와 ≥ 의 차이)');
    setLastTry(w, T0);
    await run(w, { LIVELY_SERVE_RETRY_SEC: '0', LIVELY_SERVE_NOW: String(T0) });   // 방금 시도했어도 0 이면 바로 — 손으로 다시 돌리는 길
    assert.equal(calls(w, 'restart'), 3, '🔴 LIVELY_SERVE_RETRY_SEC=0 인데 다시 시도하지 않았다');
  });

  it('E10 밀린 단계 파일이 없거나 비어 있으면 — 밀린 것이 없다(synced, 아무것도 안 돌린다)', async (t) => {
    const w = await makeWorld(t);
    assert.equal((await run(w)).status, 0);
    assert.equal(statusOf(w).state, 'synced');
    mkdirSync(dirname(PENDING(w)), { recursive: true });
    writeFileSync(PENDING(w), '\n');
    const r = await run(w);
    assert.equal(r.status, 0, out(r));
    assert.equal(statusOf(w).state, 'synced', '🔴 빈 밀린 단계 파일을 실패로 읽었다');
    assert.equal(calls(w, 'restart'), 0);
    assert.equal(calls(w, 'web'), 0);
  });

  it('E11 ★ 밀린 재시작은 다음 커밋이 src 를 안 건드려도 한다', async (t) => {
    const w = await makeWorld(t);
    await failRestart(w);
    setFail(w, 'restart', false);
    await pushStage(w, 'README.md');           // 문서만 바꾼 커밋 — 종전엔 이 커밋으로는 다시 띄우지 않았다
    const r = await run(w);
    assert.equal(r.status, 0, out(r));
    assert.equal(calls(w, 'restart'), 2, '🔴 밀린 재시작을 잊었다 — 옛 프로세스가 계속 돈다');
    assert.equal(statusOf(w).state, 'synced');
    assert.equal(existsSync(PENDING(w)), false);
  });

  it('E12·E13 웹 빌드가 실패하면 failed(web) — 재시작까지 밀리고, 고쳐지면 둘 다 한다', async (t) => {
    const w = await makeWorld(t);
    setFail(w, 'web', true);
    await pushStage(w, 'web/b.ts', 'src/b.ts');
    const r = await run(w);
    assert.equal(r.status, 1, out(r));
    assert.equal(statusOf(w).state, 'failed');
    assert.equal(statusOf(w).code, 'web');
    assert.equal(pendingOf(w), 'web restart');
    assert.equal(calls(w, 'restart'), 0, '웹 빌드가 실패한 채로 다시 띄우지 않는다(종전 순서 그대로)');
    setFail(w, 'web', false);
    lastTryAgo(w, 901);
    const r2 = await run(w);
    assert.equal(r2.status, 0, out(r2));
    assert.equal(calls(w, 'web'), 2);
    assert.equal(calls(w, 'restart'), 1);
    assert.equal(statusOf(w).state, 'synced');
  });

  it('E14 사유가 바뀌어도 실패가 이어지면 시작 시각은 처음 실패 그대로다', async (t) => {
    const w = await makeWorld(t);
    setFail(w, 'web', true);
    await pushStage(w, 'web/b.ts', 'src/b.ts');
    await run(w);
    const first = statusOf(w);
    assert.equal(first.code, 'web');
    setFail(w, 'web', false);
    setFail(w, 'restart', true);
    lastTryAgo(w, 901);
    await run(w);
    const st = statusOf(w);
    assert.equal(st.state, 'failed');
    assert.equal(st.code, 'restart');
    assert.equal(st.since, first.since, '🔴 사유가 바뀌자 막힌 시간을 0 부터 다시 셌다');
    assert.equal(pendingOf(w), 'restart', '끝낸 웹 빌드는 밀린 단계에서 빠진다');
  });

  it('E15 healthz 가 200 이 아니면 synced 가 아니다', async (t) => {
    const w = await makeWorld(t);
    writeFileSync(join(w.ctrl, 'healthz'), '000');
    await pushStage(w, 'src/b.ts');
    const r = await run(w);
    assert.equal(r.status, 1, out(r));
    assert.equal(statusOf(w).state, 'failed', '🔴 dev 가 응답하지 않는데 synced 라 했다');
    assert.equal(statusOf(w).code, 'healthz');
  });

  it('E16 의존성 설치가 실패하면 failed(deps) — 그 커밋이 요구한 단계는 남고, 설치가 되면 이어서 한다', async (t) => {
    const w = await makeWorld(t);
    setFail(w, 'deps', true);
    await pushStage(w, 'package-lock.json', 'src/b.ts');
    const r = await run(w);
    assert.equal(r.status, 1, out(r));
    assert.equal(calls(w, 'deps'), 1, '배선: 가짜 npm install 이 실제로 불렸다');
    assert.equal(statusOf(w).state, 'failed');
    assert.equal(statusOf(w).code, 'deps');
    assert.equal(pendingOf(w), 'restart', '🔴 설치가 실패하자 이 커밋이 요구한 재시작을 잊었다');
    assert.equal(calls(w, 'restart'), 0);
    setFail(w, 'deps', false);
    const r2 = await run(w);                   // 새 커밋 없음 — 설치는 매 틱 다시 시도하는 종전 규칙 그대로
    assert.equal(r2.status, 0, out(r2));
    assert.equal(calls(w, 'deps'), 2);
    assert.equal(calls(w, 'web'), 1);
    assert.equal(calls(w, 'restart'), 1);
    assert.equal(statusOf(w).state, 'synced');
  });

  it('E17 당기기(ff)가 실패하면 failed(ff)', async (t) => {
    const w = await makeWorld(t);
    assert.equal((await run(w)).status, 0);
    writeFileSync(join(w.clone, 'proto.html'), 'local\n');   // 서빙 클론에 놓인 미추적 파일 — 들어올 커밋과 이름이 같다
    await pushStage(w, 'proto.html');
    const r = await run(w);
    assert.equal(r.status, 1, out(r));
    assert.equal(statusOf(w).state, 'failed', '🔴 당기지도 못했는데 앞 상태(synced)가 그대로였다');
    assert.equal(statusOf(w).code, 'ff');
  });

  it('E18 건너뜀(dirty)은 종전대로 skipped — 시작 시각을 이어 가고, 밀린 단계는 그대로 둔다', async (t) => {
    const w = await makeWorld(t);
    await failRestart(w);
    writeFileSync(join(w.clone, 'README.md'), 'WIP\n');   // 누군가 서빙 클론에서 손대는 중
    await run(w);
    const first = statusOf(w);
    assert.equal(first.state, 'skipped');
    assert.equal(first.code, 'dirty');
    await run(w);
    assert.equal(statusOf(w).since, first.since);
    assert.equal(pendingOf(w), 'restart', '🔴 건너뛰는 동안 밀린 재시작을 잃었다');
    assert.equal(calls(w, 'restart'), 1);
  });

  it('E19 --check 는 아무것도 바꾸지 않고, 밀린 단계가 있으면 그 이름을 말한다', async (t) => {
    const w = await makeWorld(t);
    await failRestart(w);
    const before = readFileSync(STATUS(w), 'utf8');
    lastTryAgo(w, 901);
    const r = await run(w, {}, '--check');
    assert.equal(r.status, 0, out(r));
    assert.match(r.stdout, /restart/, '🔴 밀린 단계가 있는데 판정에서 말하지 않았다');
    assert.equal(readFileSync(STATUS(w), 'utf8'), before, '🔴 판정만 한다더니 상태를 바꿨다');
    assert.equal(calls(w, 'restart'), 1, '🔴 판정만 한다더니 다시 띄웠다');
  });
});
