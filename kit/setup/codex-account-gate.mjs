#!/usr/bin/env node
// Codex account boundary for Lively. This prevents accidental cross-account use at
// process/session start; it is not a security boundary against a user who can edit
// auth.json or this wrapper. Only a SHA-256 fingerprint is persisted; raw account ids
// and tokens must never be logged or written outside auth.json.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { entrypointHostEffects } from "./host-effects.mjs";

const hostEffects = entrypointHostEffects();

const AUTH_CLAIM = "https://api.openai.com/auth";

function jwtPayload(token) {
  if (typeof token !== "string") return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try { return JSON.parse(Buffer.from(part, "base64url").toString("utf8")); }
  catch { return null; }
}

function accountIdFromClaims(claims) {
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
  const ns = claims[AUTH_CLAIM];
  const candidates = [
    claims.account_id,
    claims.chatgpt_account_id,
    ns && typeof ns === "object" ? ns.account_id : null,
    ns && typeof ns === "object" ? ns.chatgpt_account_id : null,
  ];
  return candidates.find((v) => typeof v === "string" && v.trim())?.trim() || null;
}

export function inspectCodexAuthText(text) {
  let auth;
  try { auth = JSON.parse(String(text)); }
  catch { return { kind: "malformed" }; }
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return { kind: "malformed" };

  const tokens = auth.tokens;
  const direct = tokens && typeof tokens === "object" && typeof tokens.account_id === "string"
    ? tokens.account_id.trim() : "";
  if (direct) return { kind: "chatgpt", accountId: direct };

  for (const token of [tokens?.id_token, tokens?.access_token, auth.id_token, auth.access_token]) {
    const id = accountIdFromClaims(jwtPayload(token));
    if (id) return { kind: "chatgpt", accountId: id };
  }

  const mode = String(auth.auth_mode || auth.authMode || "").toLowerCase();
  if (mode.includes("api") || typeof auth.OPENAI_API_KEY === "string" || typeof auth.api_key === "string") {
    return { kind: "api-key" };
  }
  return { kind: "unknown" };
}

export const accountFingerprint = (accountId) =>
  createHash("sha256").update(String(accountId), "utf8").digest("hex");

export function evaluateCodexAccountGate({ authText, policyText }) {
  let policy;
  try { policy = JSON.parse(String(policyText)); }
  catch { return { allowed: false, reason: "policy-malformed" }; }
  const expected = policy && (policy.account_fingerprint || policy.accountFingerprint);
  if (!policy || policy.version !== 1 || !/^[a-f0-9]{64}$/.test(String(expected || ""))) {
    return { allowed: false, reason: "policy-malformed" };
  }
  const auth = inspectCodexAuthText(authText);
  if (auth.kind !== "chatgpt") return { allowed: false, reason: auth.kind };
  return accountFingerprint(auth.accountId) === expected
    ? { allowed: true, reason: "match" }
    : { allowed: false, reason: "mismatch" };
}

function currentGateAllowed(home) {
  const codexHome = process.env.CODEX_HOME || join(home, ".codex");
  let authText, policyText;
  try { authText = readFileSync(join(codexHome, "auth.json"), "utf8"); }
  catch { return false; }
  try { policyText = readFileSync(join(home, ".lively", "codex-account.json"), "utf8"); }
  catch { return false; }
  return evaluateCodexAccountGate({ authText, policyText }).allowed;
}

async function runGateCli() {
  const marker = process.argv.indexOf("--");
  const target = marker === -1 ? [] : process.argv.slice(marker + 1);
  if (!target.length) return 0;
  const home = process.env.LIVELY_HOME || process.env.HOME || process.env.USERPROFILE || "";
  if (!home) return 0;
  if (!currentGateAllowed(home)) return 0;

  const child = hostEffects.spawn(target[0], target.slice(1), {
    stdio: "inherit",
    env: process.env,
  });
  return await new Promise((resolveExit) => {
    // A running Codex process keeps the identity it had when its hooks/MCP children
    // started. Account changes take effect for the next invocation/session. Polling and
    // killing later cannot undo an already-started side effect, so do not claim that
    // stronger (and racy) guarantee here.
    child.once("error", () => resolveExit(1));
    child.once("exit", (code, signal) => {
      resolveExit(signal ? 1 : (code ?? 1));
    });
  });
}

const DIRECT_RUN = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(resolve(process.argv[1])) === realpathSync(resolve(fileURLToPath(import.meta.url))); }
  catch { return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)); }
})();
if (DIRECT_RUN) process.exit(await runGateCli());
