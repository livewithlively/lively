#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sandboxEnv } from '../testlib/os-sandbox.mjs';

import {
  accountFingerprint,
  evaluateCodexAccountGate,
  gateHome,
  inspectCodexAuthText,
} from './codex-account-gate.mjs';

const modulePath = fileURLToPath(new URL('./codex-account-gate.mjs', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'codex-account-gate-test-'));

function policyFor(accountId) {
  return JSON.stringify({
    version: 1,
    account_fingerprint: accountFingerprint(accountId),
  });
}

function evaluate(authText, policyText) {
  return evaluateCodexAccountGate({ authText, policyText }).allowed;
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { mode: 0o600 });
}

try {
  const acceptedId = 'accepted-account-id';
  const otherId = 'other-account-id';
  const acceptedAuth = JSON.stringify({ tokens: { account_id: acceptedId } });

  assert.equal(
    accountFingerprint(acceptedId),
    createHash('sha256').update(acceptedId).digest('hex'),
    'account fingerprints must be SHA-256 hex digests',
  );
  assert.notEqual(accountFingerprint(acceptedId), acceptedId, 'fingerprints must not expose account ids');

  assert.deepEqual(inspectCodexAuthText(acceptedAuth), { kind: 'chatgpt', accountId: acceptedId },
    'account-id authentication must be recognized');
  assert.equal(evaluate(acceptedAuth, policyFor(acceptedId)), true, 'the enrolled account may run');
  assert.equal(
    evaluate(JSON.stringify({ tokens: { account_id: otherId } }), policyFor(acceptedId)),
    false,
    'a different account must be suppressed',
  );
  assert.equal(evaluate('{not json', policyFor(acceptedId)), false, 'malformed auth must be suppressed');
  const apiKeyAuth = JSON.stringify({ OPENAI_API_KEY: 'sk-x' });
  assert.equal(inspectCodexAuthText(apiKeyAuth).kind, 'api-key', 'API-key authentication must be recognized as such');
  assert.equal(evaluate(apiKeyAuth, policyFor(acceptedId)), false, 'API-key authentication must be suppressed');

  const encodedClaims = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { account_id: acceptedId },
  })).toString('base64url');
  const jwtAuth = JSON.stringify({ tokens: { access_token: `header.${encodedClaims}.signature` } });
  assert.deepEqual(inspectCodexAuthText(jwtAuth), { kind: 'chatgpt', accountId: acceptedId },
    'a namespaced JWT account claim must be recognized');
  assert.equal(evaluate(jwtAuth, policyFor(acceptedId)), true, 'the namespaced JWT account may run');
  assert.equal(evaluate(acceptedAuth, '{bad policy'), false, 'malformed policy must be suppressed');
  assert.equal(evaluate(acceptedAuth, undefined), false, 'missing policy must be suppressed');

  // 설치기(user-install.mjs 의 HOME)가 정책 파일을 쓴 자리와 같은 홈을 읽어야 한다. Windows 는 os.homedir() 가
  // USERPROFILE 을 따르므로 HOME 이 따로 잡힌 셸(git-bash 등)에서 HOME 을 먼저 보면 정책을 못 찾아 영구 미실행된다.
  const osHome = () => 'C:/Profiles/member';
  assert.equal(gateHome({ HOME: '/c/msys-home', USERPROFILE: 'C:/Profiles/member' }, osHome), 'C:/Profiles/member',
    'gate home must follow os.homedir() like the installer, not HOME');
  assert.equal(gateHome({ LIVELY_HOME: '/sandbox', HOME: '/c/msys-home' }, osHome), '/sandbox', 'LIVELY_HOME overrides the OS home');

  const home = join(work, 'home');
  const childEnv = (extra = {}) => ({ ...process.env, ...sandboxEnv({ home, tmp: work }), LIVELY_HOME: home, LIVELY_HOST_EFFECTS_TEST_MODE: 'sandbox', ...extra });
  const marker = join(work, 'target-ran');
  const target = join(work, 'target.mjs');
  write(target, "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], 'ran');\n");
  write(join(home, '.codex', 'auth.json'), acceptedAuth);
  write(join(home, '.lively', 'codex-account.json'), policyFor(acceptedId));

  const run = spawnSync(process.execPath, [modulePath, '--', process.execPath, target, marker], {
    env: childEnv(),
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, 'a matching account gate invocation must exit successfully');
  assert.equal(readFileSync(marker, 'utf8'), 'ran', 'a matching account must execute the target');

  rmSync(marker);
  write(join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { account_id: otherId } }));
  const suppressed = spawnSync(process.execPath, [modulePath, '--', process.execPath, target, marker], {
    env: childEnv(),
    encoding: 'utf8',
  });
  assert.equal(suppressed.status, 0, 'a suppressed invocation must exit successfully');
  assert.equal(suppressed.stdout, '', 'a suppressed invocation must be quiet');
  assert.equal(suppressed.stderr, '', 'a suppressed invocation must be quiet');
  assert.equal(Boolean(suppressed.error), false, 'a suppressed invocation must not error');
  assert.throws(() => readFileSync(marker), /ENOENT/, 'a different account must not execute the target');

  const alternateCodexHome = join(work, 'alternate-codex');
  write(join(alternateCodexHome, 'auth.json'), acceptedAuth);
  const altMarker = join(work, 'alternate-ran');
  const alternate = spawnSync(process.execPath, [modulePath, '--', process.execPath, target, altMarker], {
    env: childEnv({ CODEX_HOME: alternateCodexHome }),
    encoding: 'utf8',
  });
  assert.equal(alternate.status, 0, 'CODEX_HOME account must be evaluated');
  assert.equal(readFileSync(altMarker, 'utf8'), 'ran', 'matching CODEX_HOME account may execute');

  console.log('codex account gate tests passed');
} finally {
  rmSync(work, { recursive: true, force: true });
}
