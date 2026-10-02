#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sandboxEnv } from '../testlib/os-sandbox.mjs';

import {
  accountFingerprint,
  evaluateCodexAccountGate,
  inspectCodexAuthText,
} from './codex-account-gate.mjs';

const modulePath = fileURLToPath(new URL('./codex-account-gate.mjs', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'codex-account-gate-test-'));

function allowed(result) {
  return typeof result === 'boolean' ? result : result?.allowed;
}

function policyFor(accountId) {
  return JSON.stringify({
    version: 1,
    accountFingerprint: accountFingerprint(accountId),
  });
}

function evaluate(authText, policyText) {
  return allowed(evaluateCodexAccountGate({ authText, policyText }));
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

  assert.ok(inspectCodexAuthText(acceptedAuth), 'account-id authentication must be recognized');
  assert.equal(evaluate(acceptedAuth, policyFor(acceptedId)), true, 'the enrolled account may run');
  assert.equal(
    evaluate(JSON.stringify({ tokens: { account_id: otherId } }), policyFor(acceptedId)),
    false,
    'a different account must be suppressed',
  );
  assert.equal(evaluate('{not json', policyFor(acceptedId)), false, 'malformed auth must be suppressed');
  assert.equal(
    evaluate(JSON.stringify({ tokens: { access_token: 'sk-test-api-key' } }), policyFor(acceptedId)),
    false,
    'API-key authentication must be suppressed',
  );

  const encodedClaims = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { account_id: acceptedId },
  })).toString('base64url');
  const jwtAuth = JSON.stringify({ tokens: { access_token: `header.${encodedClaims}.signature` } });
  assert.ok(inspectCodexAuthText(jwtAuth), 'a namespaced JWT account claim must be recognized');
  assert.equal(evaluate(jwtAuth, policyFor(acceptedId)), true, 'the namespaced JWT account may run');
  assert.equal(evaluate(acceptedAuth, '{bad policy'), false, 'malformed policy must be suppressed');
  assert.equal(evaluate(acceptedAuth, undefined), false, 'missing policy must be suppressed');

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

  // Account choice is bound when each target process starts. A later session under the
  // personal login must be suppressed; already-running children are not retroactively
  // claimed to be revocable because their external side effects cannot be undone.
  write(join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { account_id: otherId } }));
  const nextMarker = join(work, 'next-session-ran');
  const nextSession = spawnSync(process.execPath, [modulePath, '--', process.execPath, target, nextMarker], {
    env: childEnv(), encoding: 'utf8',
  });
  assert.equal(nextSession.status, 0, 'a personal-account invocation must be quietly suppressed');
  assert.equal(existsSync(nextMarker), false, 'a later personal-account session must not execute the target');

  console.log('codex account gate tests passed');
} finally {
  rmSync(work, { recursive: true, force: true });
}
