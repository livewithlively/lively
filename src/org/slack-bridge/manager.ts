// 슬랙 다리(#1782) — 흐름. 켜진 다리마다 소켓 모드 연결 하나를 쥐고(맞추기 reconcileSlackBridges), 받은 이벤트를 신원 → 동의 → 앱 백그라운드 작업으로 넘긴다.
//
// ── 어디서 도나 ──────────────────────────────────────────────────────────────────────────
//  맞추기는 테넌트 정비가 30초마다 부른다(sessions/outbox-request-sweep.ts «slack-bridge» — housekeeping 표시라 셀프호스트는 boot/housekeeping 이
//   워크스페이스마다 30초마다, 매니지드는 요청 정비표가 그 워크스페이스에 요청이 올 때 부른다(CP 틱은 깨어 있는 워크스페이스에만 5분마다 — lvly-cloud
//   control/src/tenanttick.ts). 연결은 이 프로세스의 메모리에 있다 — 게이트웨이가 다시 뜨면 다음 맞추기가 다시 붙인다. 매니지드에서 멈춘(한가한)
//   워크스페이스는 다음 요청까지 다시 붙지 않는다 — 고객사 셀프호스트가 주 사용처다.
//  ⚠ «오래 맞추지 않은 워크스페이스의 연결 내리기» 는 두지 않는다 — 매니지드의 멈춘 워크스페이스는 맞추기가 오지 않지만 슬랙으로는 계속 쓰인다
//   (웹을 열지 않고 슬랙으로만 묻는 모양). 지운 워크스페이스의 연결은 게이트웨이가 다시 뜰 때 사라지고, 그사이 이벤트는 앱이 없어 걸러진다.
//  게이트웨이가 둘이면(청/녹 두 슬롯) 둘 다 붙는다. 슬랙은 같은 앱의 연결이 여럿이면 이벤트를 그중 하나에만 주고, 재전송은 열쇠(org_slack_bridge_event)가 막는다.
//
// ── 테넌트 ───────────────────────────────────────────────────────────────────────────────
//  연결의 이벤트 처리 · 상태 쓰기는 요청 밖(소켓 콜백)에서 돈다 — 맞추기가 돌던 테넌트 컨텍스트를 연결에 적어 두고 그것으로 감싼다(withTenant).
//   단일 워크스페이스 배포는 컨텍스트가 없어(null) 그대로 부른다.
//
// ── 신원(이슈 «정할 것» 1) ────────────────────────────────────────────────────────────────
//  (a) 사람이 쓴 글 · 태그 · 버튼 — 그 슬랙 사람을 구성원으로 찾아 그 사람으로 돈다: ① 구성원 신원(person_identity system=slack · 확인된 것)
//   ② 그 사람이 [외부 앱 연결 ▸ Slack] 으로 연결한 계정(금고 slack_oauth 의 slack_user_id) ③ 슬랙 이메일(users.info — 봇에 users:read.email) = 구성원 이메일.
//   못 찾거나 · 그 사람이 앱에 동의하지 않았거나 · 동의가 앱의 지금 선언을 덮지 못하면(#1644 예전 범위) 작업을 시작하지 않는다.
//   봇을 직접 부른 것(태그 · DM · 버튼)이면 그 사람에게만 보이는 안내를 스레드에 단다.
//  (b) 워크플로 · 봇 글 — 다리의 run_as 구성원으로 돌린다. 그 작업은 «자동화» 표시를 단다(정할 것 2 — 구독은 못 쓰고 워크스페이스 API 키만).
import os from "node:os";
import crypto from "node:crypto";
import type WebSocket from "ws";
import { itemsPool } from "../../db/client.js";
import { TENANT_DEFAULT_EXPR } from "../../db/tenant-column.js";
import { logger } from "../../log.js";
import type { LivelyUser } from "../../context.js";
import { currentTenant, withTenant, type TenantContext } from "../tenant-context.js";
import { getMember } from "../store/members.js";
import { getApp, getActiveGrant } from "../store/apps.js";
import { workspaceAccessAllowed } from "../tenancy/gate.js";
import { canSeeApp } from "../../apps/visibility.js";
import { getMemberSecret } from "../credentials/member-secret-store.js";
import * as store from "./store.js";
import {
  bridgeJobBody, bridgeJobLabel, envelopeVerdict, isAppLevelToken, isBotToken, isSlackSocketUrl, shortError,
  type BotIdentity, type BridgeActor, type BridgeRow, type BridgeStatus, type EnvelopeVerdict, type SocketEnvelope, type TokenRef,
} from "./plan.js";
import { botAuthTest, liveSlackApi, openSocketUrl, slackCall, slackError, slackOk, slackUserFacts, type SlackApiDeps } from "./slack-api.js";
import { SlackSocket, type SocketState } from "./socket.js";

// ── 바꿔 끼우는 자리(시험) ───────────────────────────────────────────────────────────────
export interface BridgeDeps {
  api: SlackApiDeps;
  allowSocketUrl(url: string): boolean;
  WebSocketImpl?: typeof WebSocket;
  /** 앱 백그라운드 작업 시작(apps/app-jobs.startAppJob). */
  startJob(input: Record<string, unknown>, user: LivelyUser, ctx: { source: string; unattended?: boolean; automation?: boolean }): Promise<Record<string, unknown>>;
  readSecret(ref: TokenRef): Promise<string | null>;
  now(): number;
  holder: string;
  /** 시험용 — 다시 붙기 전 기다림. */
  delayMs?(attempt: number): number;
}

export async function readSecretOf(ref: TokenRef): Promise<string | null> {
  const r = await getMemberSecret(ref.owner, ref.kind, ref.scope_key);
  return r?.secret ? r.secret.trim() : null;
}

let depsOverride: BridgeDeps | null = null;
/** 시험 전용 — 다리 흐름의 바깥(슬랙 · 작업 시작 · 시계)을 바꿔 끼운다. 관리 도구가 부르는 맞추기도 이것을 쓴다. null 이면 되돌린다. */
export function setSlackBridgeDepsForTest(d: BridgeDeps | null): void { depsOverride = d; }

export function liveBridgeDeps(): BridgeDeps {
  if (depsOverride) return depsOverride;
  return {
    api: liveSlackApi(),
    allowSocketUrl: isSlackSocketUrl,
    startJob: async (input, user, ctx) => (await import("../../apps/app-jobs.js")).startAppJob(input, user, ctx),
    readSecret: readSecretOf,
    now: () => Date.now(),
    holder: `${os.hostname()}:${process.pid}`,
  };
}

// ── 연결 ────────────────────────────────────────────────────────────────────────────────
interface Conn {
  key: string;
  tenantKey: string;
  tenant: TenantContext | null;
  bridge: BridgeRow;
  /** 토큰 참조 + 토큰 값 지문 — 바뀌면(금고에서 토큰을 갈았거나 다른 칸을 가리키면) 다시 붙는다. */
  fingerprint: string;
  appTokenHash: string;
  socket: SlackSocket;
  bot: BotIdentity & { team: string | null };
  /** 봇 토큰 — 메모리에만(반응 · 안내 · users.info). 응답 · 로그 · 상태에 싣지 않는다. */
  botToken: string;
  status: BridgeStatus;
  flushTimer: NodeJS.Timeout | null;
  deps: BridgeDeps;
  /** 같은 슬랙 앱을 다른 다리가 쥐고 있어 스스로 내린 시각 — 5분 뒤 맞추기가 다시 붙여 본다(그 다리가 내려갔을 수 있다). */
  halted: number | null;
  /** 처리 줄 — 글이 몰려도 연결마다 동시에 MAX_INFLIGHT 개까지만 처리한다(DB · users.info 가 한꺼번에 몰리지 않게). */
  queue: SocketEnvelope[];
  inflight: number;
  /** 내린 연결 — 상태를 더 적지 않는다(같은 다리의 새 연결이 적는다). 다시 붙이느라 내린 것이면 이미 받은 줄은 끝까지 처리한다. */
  retired: boolean;
}

/** 연결마다 동시에 처리하는 이벤트 수 · 기다리는 줄의 상한(넘으면 버리고 «실패» 로 센다). */
export const BRIDGE_MAX_INFLIGHT = 4;
export const BRIDGE_MAX_QUEUE = 500;

const conns = new Map<string, Conn>();
/** 연결을 못 만든 다리의 마지막 오류(같은 오류를 30초마다 다시 적지 않게). */
const lastSetupError = new Map<string, string>();
const inflight = new Map<string, Promise<ReconcileResult>>();
const lastPrune = new Map<string, number>();

const tenantKeyOf = (t: TenantContext | null): string => t?.id ?? "_";
const connKey = (tenantKey: string, bridgeId: string): string => `${tenantKey}|${bridgeId}`;
const sha = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");
const nowIso = (d: BridgeDeps): string => new Date(d.now()).toISOString();

function inTenant<T>(c: { tenant: TenantContext | null }, fn: () => Promise<T>): Promise<T> {
  return c.tenant ? withTenant(c.tenant, fn) : fn();
}

function freshStatus(prev: BridgeStatus | undefined, d: BridgeDeps): BridgeStatus {
  return {
    connected: false, state: "connecting", since: nowIso(d), last_event_at: prev?.last_event_at ?? null,
    received: prev?.received ?? 0, forwarded: prev?.forwarded ?? 0, filtered: prev?.filtered ?? 0, duplicates: prev?.duplicates ?? 0, failed: prev?.failed ?? 0,
    last_filtered: prev?.last_filtered ?? null, last_error: null, last_error_at: prev?.last_error_at ?? null, slack: prev?.slack ?? {}, holder: d.holder, updated_at: nowIso(d),
  };
}

/** 상태를 곧(1초 뒤 한 번에) DB 에 적는다 — 이벤트가 몰려도 쓰기는 1초에 한 번. */
function scheduleFlush(c: Conn): void {
  if (c.flushTimer) return;
  c.flushTimer = setTimeout(() => {
    c.flushTimer = null;
    void flush(c);
  }, 1000);
  c.flushTimer.unref?.();
}
async function flush(c: Conn): Promise<void> {
  if (c.retired) return;
  c.status.updated_at = nowIso(c.deps);
  c.status.holder = c.deps.holder;
  await inTenant(c, () => store.saveBridgeStatus(c.bridge.id, c.status))
    .catch((e) => logger.warn({ bridge: c.bridge.id, err: shortError(e) }, "[slack-bridge] 상태를 적지 못했다(비치명)"));
}

function setError(c: Conn, msg: string): void {
  c.status.last_error = msg;
  c.status.last_error_at = nowIso(c.deps);
  scheduleFlush(c);
}

function onSocketState(c: Conn, state: SocketState, detail?: { error?: string; slackAppId?: string | null }): void {
  c.status.state = state;
  c.status.connected = state === "connected";
  c.status.since = nowIso(c.deps);
  if (state === "connected") {
    c.status.last_error = null;
    c.status.slack = { ...(c.status.slack ?? {}), app_id: detail?.slackAppId ?? c.status.slack?.app_id ?? null };
    //  한 슬랙 앱에 다리 둘이 붙으면 슬랙이 이벤트를 둘 중 한 연결에만 줘 서로 반씩 잃는다 — 같은 테넌트의 다른 다리가 같은 슬랙 앱이면 이쪽을 내린다.
    const appId = detail?.slackAppId ?? null;
    if (appId) {
      for (const o of conns.values()) {
        if (o !== c && o.tenantKey === c.tenantKey && o.status.slack?.app_id === appId && o.status.connected) {
          c.socket.stop();
          c.halted = c.deps.now();
          c.status.state = "error";
          c.status.connected = false;
          setError(c, `같은 슬랙 앱(${appId})을 다리 '${o.bridge.id}' 가 이미 씁니다 — 슬랙은 한 앱의 이벤트를 연결 하나에만 줍니다. 다리마다 다른 슬랙 앱(앱 수준 토큰)을 쓰세요`);
          return;
        }
      }
    }
    logger.info({ bridge: c.bridge.id, app: c.bridge.app_id, slack_app: appId }, "[slack-bridge] 슬랙에 붙었다(#1782)");
  }
  if (state === "waiting" && detail?.error) {
    setError(c, detail.error);
    logger.warn({ bridge: c.bridge.id, err: detail.error }, "[slack-bridge] 연결이 끊겨 다시 붙는다(#1782)");
    return;
  }
  scheduleFlush(c);
}

function filtered(c: Conn, why: string): void {
  c.status.filtered = (c.status.filtered ?? 0) + 1;
  c.status.last_filtered = why.slice(0, 200);
  scheduleFlush(c);
}

// ── 맞추기 ──────────────────────────────────────────────────────────────────────────────
export interface ReconcileResult { active: number; started: number; stopped: number; restarted: number; errors: number }

/**
 * 이 테넌트의 켜진 다리와 이 프로세스의 연결을 맞춘다 — 없으면 붙이고 · 꺼졌거나 지웠으면 내리고 · 토큰이 바뀌었으면 다시 붙이고 · 거르기 칸은 그 자리에서 바꾼다.
 *  같은 테넌트의 맞추기가 겹치면 앞의 것을 기다린다(연결이 둘로 늘지 않게).
 */
export function reconcileSlackBridges(deps: BridgeDeps = liveBridgeDeps(), o: { fresh?: boolean } = {}): Promise<ReconcileResult> {
  const tk = tenantKeyOf(currentTenant());
  const running = inflight.get(tk);
  //  fresh — 방금 저장한 다리를 반드시 보는 맞추기(관리 도구). 돌던 맞추기는 저장 전에 목록을 읽었을 수 있어, 끝나기를 기다렸다 한 번 더 돈다.
  if (running) return o.fresh ? running.catch(() => undefined).then(() => reconcileSlackBridges(deps, o)) : running;
  const p = reconcileOnce(deps).finally(() => inflight.delete(tk));
  inflight.set(tk, p);
  return p;
}

async function reconcileOnce(deps: BridgeDeps): Promise<ReconcileResult> {
  const tenant = currentTenant();
  const tk = tenantKeyOf(tenant);
  const out: ReconcileResult = { active: 0, started: 0, stopped: 0, restarted: 0, errors: 0 };
  //  ⚠ 이 워크스페이스의 연결만 만진다 — 다른 워크스페이스의 연결은 그 워크스페이스의 맞추기가 맡는다(머리말 «오래 맞추지 않은 …» 참조).
  let rows: BridgeRow[];
  try {
    rows = await store.listBridges();
  } catch (e) {
    if ((e as { code?: string })?.code === "42P01") return out;   // 표가 아직 없다(스키마 전) — 다음 맞추기
    throw e;
  }
  const enabled = rows.filter((r) => r.enabled);
  const want = new Set(enabled.map((r) => r.id));

  //  꺼졌거나 지운 다리 — 내린다.
  for (const [k, c] of [...conns]) {
    if (c.tenantKey !== tk || want.has(c.bridge.id)) continue;
    stopConn(c);
    conns.delete(k);
    out.stopped++;
    if (rows.some((r) => r.id === c.bridge.id)) {
      await store.saveBridgeStatus(c.bridge.id, { ...c.status, connected: false, state: "stopped", since: nowIso(deps), holder: deps.holder, updated_at: nowIso(deps) }).catch(() => {});
    }
  }

  //  같은 앱 수준 토큰을 다른 칸에 넣어 다리 둘이 같은 슬랙 앱을 가리키는 것 — 값의 지문으로 가른다(먼저 온 id 가 쥔다).
  const appTokenOwner = new Map<string, string>();
  for (const r of enabled) {
    const key = connKey(tk, r.id);
    let app: string | null = null, bot: string | null = null;
    try { [app, bot] = await Promise.all([deps.readSecret(r.app_token_ref), deps.readSecret(r.bot_token_ref)]); }
    catch (e) { await setupError(r, deps, `금고를 읽지 못했습니다: ${shortError(e)}`, out); continue; }
    const problem = !app ? `앱 수준 토큰이 금고 칸(${refLabel(r.app_token_ref)})에 없습니다 — org_credential_set 으로 xapp- 토큰을 넣으세요`
      : !isAppLevelToken(app) ? `금고 칸(${refLabel(r.app_token_ref)})의 값이 앱 수준 토큰(xapp-)이 아닙니다 — 슬랙 앱 ▸ Basic Information ▸ App-Level Tokens(connections:write)에서 만든 토큰을 넣으세요`
      : !bot ? `봇 토큰이 금고 칸(${refLabel(r.bot_token_ref)})에 없습니다 — xoxb- 토큰을 넣으세요`
      : !isBotToken(bot) ? `금고 칸(${refLabel(r.bot_token_ref)})의 값이 봇 토큰(xoxb-)이 아닙니다 — 슬랙 앱 ▸ OAuth & Permissions 의 Bot User OAuth Token 을 넣으세요`
      : null;
    if (problem || !app || !bot) {
      const c = conns.get(key);
      if (c) { stopConn(c); conns.delete(key); out.stopped++; }
      await setupError(r, deps, problem ?? "토큰이 없습니다", out);
      continue;
    }
    const appHash = sha(app);
    const holderOfApp = appTokenOwner.get(appHash);
    if (holderOfApp) {
      const c = conns.get(key);
      if (c) { stopConn(c); conns.delete(key); out.stopped++; }
      await setupError(r, deps, `다리 '${holderOfApp}' 와 같은 앱 수준 토큰입니다 — 슬랙은 한 앱의 이벤트를 연결 하나에만 줍니다. 다리마다 다른 슬랙 앱을 쓰세요`, out);
      continue;
    }
    appTokenOwner.set(appHash, r.id);
    const fp = sha(JSON.stringify([r.app_token_ref, r.bot_token_ref, appHash, sha(bot)]));
    let c = conns.get(key);
    if (c && (c.fingerprint !== fp || (c.halted !== null && deps.now() - c.halted > 5 * 60_000))) { stopConn(c, false); conns.delete(key); c = undefined; out.restarted++; }
    if (c) {
      c.bridge = r;            // 거르기 · 라우트 · run_as 같은 칸은 그 자리에서 바꾼다(다시 붙을 필요가 없다)
      c.botToken = bot;
      out.active++;
      continue;
    }
    lastSetupError.delete(key);
    c = await startConn(r, tenant, tk, app, bot, fp, appHash, deps);
    conns.set(key, c);
    out.started++;
    out.active++;
  }

  //  보존 정리 — 테넌트마다 한 시간에 한 번.
  const lp = lastPrune.get(tk) ?? 0;
  if (deps.now() - lp > 3_600_000) {
    lastPrune.set(tk, deps.now());
    await store.pruneBridgeRecords().catch((e) => logger.warn({ err: shortError(e) }, "[slack-bridge] 보존 정리 실패(비치명)"));
  }
  return out;
}

const refLabel = (r: TokenRef): string => `${r.owner === "gateway" ? "" : r.owner + " · "}${r.kind}${r.scope_key ? ":" + r.scope_key : ""}`;

async function setupError(r: BridgeRow, deps: BridgeDeps, msg: string, out: ReconcileResult): Promise<void> {
  out.errors++;
  const key = connKey(tenantKeyOf(currentTenant()), r.id);
  if (lastSetupError.get(key) === msg && r.status?.last_error === msg) return;
  lastSetupError.set(key, msg);
  await store.saveBridgeStatus(r.id, {
    ...r.status, connected: false, state: "error", since: nowIso(deps), last_error: msg, last_error_at: nowIso(deps), holder: deps.holder, updated_at: nowIso(deps),
  }).catch(() => {});
}

/**
 * 연결을 내린다. drop — 기다리던 줄도 버린다(다리를 껐거나 지웠다). 다시 붙이느라 내리는 것(토큰 교체 · 같은 앱 충돌)이면 drop=false 로,
 *  이미 ack 해 슬랙이 다시 보내지 않는 이벤트를 옛 연결이 끝까지 처리한다(상태는 새 연결이 적는다 — retired).
 */
function stopConn(c: Conn, drop = true): void {
  c.retired = true;
  try { c.socket.stop(); } catch { /* 이미 내림 */ }
  if (c.flushTimer) { clearTimeout(c.flushTimer); c.flushTimer = null; }
  if (drop) c.queue.length = 0;
}

async function startConn(r: BridgeRow, tenant: TenantContext | null, tk: string, appToken: string, botToken: string, fp: string, appHash: string, deps: BridgeDeps): Promise<Conn> {
  const c: Conn = {
    key: connKey(tk, r.id), tenantKey: tk, tenant, bridge: r, fingerprint: fp, appTokenHash: appHash,
    socket: null as unknown as SlackSocket, bot: { user_id: null, bot_id: null, team_id: null, team: null }, botToken,
    status: freshStatus(r.status, deps), flushTimer: null, deps, halted: null, queue: [], inflight: 0, retired: false,
  };
  //  봇 신원 — 봇 자신의 글을 거르는 데 꼭 필요하다(모르면 앱의 답이 다시 이벤트로 돌아와 끝없는 고리가 된다). 못 읽으면 붙지 않고 다음 연결 시도에 다시 읽는다.
  const auth = async (): Promise<void> => {
    if (c.bot.user_id || c.bot.bot_id) return;
    const a = await botAuthTest(c.botToken, deps.api);
    c.bot = { user_id: a.user_id, bot_id: a.bot_id, team_id: a.team_id, team: a.team };
    c.status.slack = { ...(c.status.slack ?? {}), team_id: a.team_id, team: a.team, bot_user_id: a.user_id, bot_id: a.bot_id };
  };
  c.socket = new SlackSocket({
    openUrl: async () => { await auth(); return openSocketUrl(appToken, deps.api); },
    allowUrl: deps.allowSocketUrl,
    onEnvelope: (env) => enqueue(c, env),
    onState: (state, detail) => onSocketState(c, state, detail),
    ...(deps.WebSocketImpl ? { WebSocketImpl: deps.WebSocketImpl } : {}),
    ...(deps.delayMs ? { delayMs: deps.delayMs } : {}),
    now: deps.now,
  });
  c.socket.start();
  return c;
}

// ── 받은 이벤트 → 작업 ─────────────────────────────────────────────────────────────────────
/** 받은 envelope 을 처리 줄에 넣는다(ack 는 소켓이 이미 보냈다). 줄이 가득 차면 버리고 «실패» 로 센다. */
function enqueue(c: Conn, env: SocketEnvelope): void {
  c.status.received = (c.status.received ?? 0) + 1;
  c.status.last_event_at = nowIso(c.deps);
  if (c.queue.length >= BRIDGE_MAX_QUEUE) {
    c.status.failed = (c.status.failed ?? 0) + 1;
    setError(c, `처리 줄이 가득 차(${BRIDGE_MAX_QUEUE}) 이벤트를 버렸습니다 — 슬랙 글이 처리보다 빨리 들어온다`);
    return;
  }
  c.queue.push({ ...env, received_at_ms: c.deps.now() } as SocketEnvelope);
  pump(c);
}

function pump(c: Conn): void {
  while (c.inflight < BRIDGE_MAX_INFLIGHT && c.queue.length) {
    const env = c.queue.shift()!;
    c.inflight++;
    void inTenant(c, () => handleEnvelope(c, env))
      .catch((e) => logger.warn({ bridge: c.bridge.id, err: shortError(e) }, "[slack-bridge] 이벤트 처리 실패"))
      .finally(() => { c.inflight--; pump(c); });
  }
}

async function handleEnvelope(c: Conn, env: SocketEnvelope): Promise<void> {
  const d = c.deps;
  const at = (env as { received_at_ms?: unknown }).received_at_ms;
  const receivedAt = new Date(typeof at === "number" ? at : d.now());
  const v = envelopeVerdict(env, c.bridge, c.bot);
  if (!v.forward) { filtered(c, v.reason ?? "거름"); return; }
  //  한 번만 넘기기 — 이벤트 열쇠, 그리고 글 · 태그면 같은 글 열쇠(슬랙이 태그된 글을 두 이벤트로 보낸다). 열쇠를 못 적으면 «실패» 로 센다(넘기지 않는다).
  try {
    if (!(await store.claimBridgeEvent(c.bridge.id, v.key!, v.kind))) {
      c.status.duplicates = (c.status.duplicates ?? 0) + 1;
      scheduleFlush(c);
      return;
    }
    if (v.alt_key && !(await store.claimBridgeEvent(c.bridge.id, v.alt_key, v.kind))) {
      c.status.duplicates = (c.status.duplicates ?? 0) + 1;
      scheduleFlush(c);
      await store.markBridgeEvent(c.bridge.id, v.key!, "duplicate:같은 글").catch(() => {});
      return;
    }
  } catch (e) {
    c.status.failed = (c.status.failed ?? 0) + 1;
    setError(c, `한 번만 넘기기 열쇠를 적지 못했습니다: ${shortError(e)}`);
    //  이벤트 열쇠는 적었고 같은 글 열쇠에서 실패했으면 그 행에 까닭을 남긴다(이 역시 실패할 수 있다 — 최선).
    await store.markBridgeEvent(c.bridge.id, v.key!, `failed:${shortError(e)}`).catch(() => {});
    return;
  }
  //  열쇠를 쥔 뒤의 예외(DB · 슬랙 일시 오류)는 그 이벤트를 «실패» 로 남긴다 — ack 를 이미 보내 슬랙은 다시 보내지 않으니, 남기지 않으면 조용히 사라진다.
  try {
    await forwardClaimed(c, env, v, receivedAt);
  } catch (e) {
    const why = shortError(e);
    c.status.failed = (c.status.failed ?? 0) + 1;
    setError(c, `이벤트를 넘기다 실패했습니다: ${why}`);
    await store.markBridgeEvent(c.bridge.id, v.key!, `failed:${why}`).catch(() => {});
    logger.warn({ bridge: c.bridge.id, err: why }, "[slack-bridge] 이벤트를 넘기다 실패(#1782)");
  }
}

async function forwardClaimed(c: Conn, env: SocketEnvelope, v: EnvelopeVerdict, receivedAt: Date): Promise<void> {
  const d = c.deps;
  const actor = await resolveActor(c, v);
  if ("error" in actor) {
    filtered(c, actor.error);
    await store.markBridgeEvent(c.bridge.id, v.key!, `filtered:${actor.error}`).catch(() => {});
    if (actor.notice) await notify(c, v, actor.notice);
    return;
  }
  const gate = await runnable(c.bridge.app_id, actor.member);
  if (gate) {
    filtered(c, gate.reason);
    await store.markBridgeEvent(c.bridge.id, v.key!, `filtered:${gate.reason}`).catch(() => {});
    if (gate.notice && actor.via !== "run_as") await notify(c, v, await gate.notice());
    return;
  }
  const member = await getMember(actor.member);
  const user: LivelyUser = { userId: actor.member, email: member?.email ?? "", scopes: member?.scopes ?? [], projects: ["*"] };
  const automation = actor.via === "run_as";
  try {
    const job = await d.startJob(
      //  사람 주체(앱 토큰이 아니다)로 시작하므로 앱을 입력에 싣는다 — startAppJob 은 앱 화면 · 앱 서버가 아닌 호출에 app_id 를 요구한다.
      { app_id: c.bridge.app_id, route: c.bridge.route, body: bridgeJobBody(env, v, c.bridge.id, actor, receivedAt), label: bridgeJobLabel(v) },
      user, { source: "slack-bridge", ...(automation ? { unattended: true, automation: true } : {}) });
    const jobId = typeof job.id === "number" ? job.id : Number(job.id) || null;
    c.status.forwarded = (c.status.forwarded ?? 0) + 1;
    scheduleFlush(c);
    await store.markBridgeEvent(c.bridge.id, v.key!, "forwarded", jobId).catch(() => {});
    logger.info({ bridge: c.bridge.id, app: c.bridge.app_id, job: jobId, type: v.type, via: actor.via }, "[slack-bridge] 앱 작업으로 넘겼다(#1782)");
    if (c.bridge.react && v.kind === "events_api" && v.channel && v.ts && (v.type === "message" || v.type === "app_mention")) {
      await react(c, v.channel, v.ts, c.bridge.react);
    }
  } catch (e) {
    const why = shortError(e);
    c.status.failed = (c.status.failed ?? 0) + 1;
    setError(c, `작업을 시작하지 못했습니다: ${why}`);
    await store.markBridgeEvent(c.bridge.id, v.key!, `failed:${why}`).catch(() => {});
    logger.warn({ bridge: c.bridge.id, app: c.bridge.app_id, err: why }, "[slack-bridge] 앱 작업을 시작하지 못했다(#1782)");
    if (v.explicit && actor.via !== "run_as") await notify(c, v, `앱 작업을 시작하지 못했습니다 — ${why}`);
  }
}

// ── 신원 ────────────────────────────────────────────────────────────────────────────────
type ActorResult = BridgeActor | { error: string; notice: string | null };

/** 슬랙 사람 → 구성원 이메일 매핑의 짧은 기억(같은 사람의 글이 몰려도 users.info 를 매번 부르지 않게). */
const userFactsCache = new Map<string, { at: number; email: string | null; bad: string | null }>();
const USER_CACHE_MS = 10 * 60_000;

async function resolveActor(c: Conn, v: EnvelopeVerdict): Promise<ActorResult> {
  if (v.bot_authored) {
    if (!c.bridge.run_as) return { error: "봇 · 워크플로가 쓴 글인데 다리에 run_as(돌릴 구성원)가 없습니다", notice: null };
    return { slack_user: null, member: c.bridge.run_as, via: "run_as" };
  }
  const su = v.slack_user!;
  const linkHint = "라이블리 계정을 찾지 못했어요 — 라이블리 구성원 이메일이 슬랙 이메일과 같거나, 라이블리 [외부 앱 연결 ▸ Slack] 으로 이 슬랙 계정을 연결해야 슬랙에서 앱을 쓸 수 있어요.";
  //  ① 구성원 신원 — 관리자가 확인한 것만(관찰로 제안된 것은 믿지 않는다).
  //   구성원 행은 지금 워크스페이스의 것만 — getMember 와 같은 조건(매니지드는 구성원 행이 워크스페이스마다 따로다. 접기가 남긴 짝이 있으면
  //   조건 없는 조회는 남의 워크스페이스 행을 집는다 · 워크스페이스 둘 시험이 잡았다).
  const pi = await itemsPool.query(
    `SELECT DISTINCT om.id FROM person_identity pi JOIN org_member om ON om.id = pi.person_id AND om.tenant_id = ${TENANT_DEFAULT_EXPR}
      WHERE pi.system = 'slack' AND pi.external_id = $1 AND pi.state = 'confirmed' AND om.state = 'active' LIMIT 2`, [su]);
  if (pi.rows.length === 1) return { slack_user: su, member: String((pi.rows[0] as { id: string }).id), via: "identity" };
  //  ② [Slack 연결] 한 계정 — 금고 slack_oauth 칸. ⚠ 그 칸의 meta 는 구성원이 me_credential_set 으로 마음대로 적을 수 있다(격리 리뷰 막을 것 1) —
  //   meta 의 slack_user_id 는 «후보» 일 뿐이다. 그 칸의 토큰으로 슬랙에 물어(auth.test) 정말 이 사람 · 이 워크스페이스의 토큰일 때만 믿는다.
  const so = await itemsPool.query(
    `SELECT DISTINCT owner FROM member_secret WHERE kind = 'slack_oauth' AND scope_key = '' AND meta->>'slack_user_id' = $1 AND owner LIKE 'member:%' ORDER BY owner LIMIT 10`, [su]);
  const proven: string[] = [];
  for (const row of so.rows as Array<{ owner: string }>) {
    if (await slackLoginProves(c, row.owner, su)) proven.push(row.owner.slice("member:".length));
  }
  if (proven.length === 1) {
    const m = await getMember(proven[0]!);
    if (m && m.state === "active") return { slack_user: su, member: proven[0]!, via: "slack_login" };
  }
  //  ③ 슬랙 이메일 = 구성원 이메일(하나일 때만).
  const ck = `${c.key}|${su}`;
  let facts = userFactsCache.get(ck);
  if (!facts || c.deps.now() - facts.at > USER_CACHE_MS) {
    try {
      const f = await slackUserFacts(c.botToken, su, c.deps.api);
      const bad = f.deleted ? "슬랙에서 비활성화된 사람" : f.is_bot ? "봇 계정" : f.email_confirmed === false ? "슬랙 이메일이 확인되지 않은 사람" : null;
      facts = { at: c.deps.now(), email: f.email, bad };
    } catch (e) {
      return { error: `슬랙 사람 정보를 읽지 못했습니다: ${shortError(e)}`, notice: v.explicit ? linkHint : null };
    }
    if (userFactsCache.size > 5000) userFactsCache.clear();
    userFactsCache.set(ck, facts);
  }
  if (facts.bad) return { error: facts.bad, notice: null };
  if (!facts.email) return { error: "구성원 매핑 없음(슬랙 이메일을 읽지 못함 — 봇에 users:read.email 이 있나)", notice: v.explicit ? linkHint : null };
  const em = await itemsPool.query(
    `SELECT id FROM org_member WHERE lower(email) = $1 AND email <> '' AND state = 'active' AND kind = 'human' AND tenant_id = ${TENANT_DEFAULT_EXPR} LIMIT 2`, [facts.email]);
  if (em.rows.length === 1) return { slack_user: su, member: String((em.rows[0] as { id: string }).id), via: "email" };
  return { error: em.rows.length > 1 ? "같은 이메일의 구성원이 둘 이상" : "구성원 매핑 없음", notice: v.explicit ? linkHint : null };
}

/** [Slack 연결] 칸이 정말 그 슬랙 사람의 것인가 — 칸의 토큰으로 auth.test(같은 사람 · 같은 워크스페이스). 10분 기억(맞음 · 아님 모두). 못 물으면 아님. */
const loginProofCache = new Map<string, { at: number; ok: boolean }>();
async function slackLoginProves(c: Conn, owner: string, su: string): Promise<boolean> {
  const k = `${c.key}|${owner}|${su}`;
  const hit = loginProofCache.get(k);
  if (hit && c.deps.now() - hit.at < USER_CACHE_MS) return hit.ok;
  let ok = false;
  try {
    const r = await getMemberSecret(owner, "slack_oauth", "");
    let token: string | null = null;
    if (r?.secret) { try { const t = JSON.parse(r.secret) as { access_token?: unknown }; token = typeof t.access_token === "string" ? t.access_token : null; } catch { token = r.secret.startsWith("xox") ? r.secret : null; } }
    if (token) {
      const a = await slackCall(token, "auth.test", {}, { json: false }, c.deps.api);
      const b = a.body ?? {};
      ok = slackOk(a) && b.user_id === su && (!c.bot.team_id || b.team_id === c.bot.team_id);
    }
  } catch { ok = false; }
  if (loginProofCache.size > 5000) loginProofCache.clear();
  loginProofCache.set(k, { at: c.deps.now(), ok });
  return ok;
}

/** 그 구성원으로 이 앱 작업을 돌릴 수 있나 — 못 돌리면 까닭(+ 사람에게 보일 안내). startAppJob 도 다시 보지만, 여기서 먼저 보면 안내를 가를 수 있다. */
async function runnable(appId: string, memberId: string): Promise<{ reason: string; notice: (() => Promise<string>) | null } | null> {
  const m = await getMember(memberId);
  if (!m || m.state !== "active") return { reason: `구성원 '${memberId}' 이 활성 상태가 아닙니다`, notice: null };
  if (!(await workspaceAccessAllowed(m.id))) return { reason: `구성원 '${memberId}' 이 이 워크스페이스에 들어올 수 없습니다`, notice: null };
  const app = await getApp(appId);
  if (!app || app.status !== "active" || !app.enabled) return { reason: `앱 '${appId}' 이 없거나 꺼져 있습니다`, notice: null };
  if (!canSeeApp(app, { userId: m.id, scopes: m.scopes ?? [] })) return { reason: `구성원 '${memberId}' 에게 보이지 않는 앱`, notice: null };
  if (!(await getActiveGrant(appId, m.id))) {
    return {
      reason: `구성원 '${memberId}' 이 앱에 동의하지 않았습니다`,
      notice: async () => `「${app.title || appId}」 앱을 아직 동의하지 않았어요 — 라이블리에서 앱을 한 번 열어 동의한 뒤 다시 해 주세요.${await grantLink(appId, "pub")}`,
    };
  }
  //  #1644 — 동의가 앱의 지금 선언 전체를 덮나(앱 선언 MCP 도구와 같은 판정). 앱이 동의한 뒤에 권한을 넓혔으면 그 사람의 예전 동의로 도는 앱 코드 ·
  //   작업 AI 는 새로 얻은 권한에서 막히거나 새 기능만 조용히 빠진다 — 앱 코드가 무엇을 부를지 미리 알 수 없으니 작업을 시작하지 않고 다시 동의를 안내한다.
  //   구성원에게 없는 scope 는 세지 않는다(다시 동의해도 못 얻는다). 판은 그 사람이 보는 판(작업도 그 판으로 돈다 — startAppJob).
  //   판정을 읽지 못하면 종전대로 시작한다 — 안내를 위한 판정이고 권한의 경계는 작업의 토큰(그 사람 ∩ 동의)이 그대로 지킨다.
  const { consentCoverage } = await import("../../apps/app-consent-gap.js");
  const { describeGrantGap, grantGapEmpty } = await import("../../apps/grant.js");
  const cov = await consentCoverage(appId, m.id, { installed: app }).catch((e: unknown) => {
    logger.warn({ app: appId, member: m.id, err: shortError(e) }, "[slack-bridge] 동의 덮음 판정을 읽지 못했다 — 종전대로 시작한다(#1644)");
    return null;
  });
  if (cov && !grantGapEmpty(cov.gap)) {
    return {
      reason: `구성원 '${memberId}' 의 앱 동의가 예전 범위입니다(동의에 없는 것: ${describeGrantGap(cov.gap)})`,
      notice: async () => `「${app.title || appId}」 앱의 사용 동의가 예전 범위예요(앱이 지금 쓰는 권한을 다 덮지 못해요) — 라이블리에서 다시 동의한 뒤 다시 해 주세요.${await grantLink(appId, cov.variant)}`,
    };
  }
  return null;
}

/** 안내에 붙일 동의 자리 링크(앞에 빈칸 하나) — 공개 주소(org 프로필 gateway_url > PUBLIC_URL)를 모르면 빈 글. 동의 뒤 화면이 그 앱 주소로 돌아간다(from 없음). */
async function grantLink(appId: string, variant: "pub" | "draft"): Promise<string> {
  const { gatewayUrl } = await import("../../gateway-url.js");
  const { appConsentUrl } = await import("../../apps/app-mcp-decl.js");
  const url = appConsentUrl(await gatewayUrl().catch(() => null), appId, variant, null);
  return url ? ` ${url}` : "";
}

// ── 슬랙에 남기기(안내 · 반응) ─────────────────────────────────────────────────────────────
/** 같은 사람에게 같은 안내를 10분에 한 번만. */
const noticeSeen = new Map<string, number>();
const NOTICE_EVERY_MS = 10 * 60_000;

async function notify(c: Conn, v: EnvelopeVerdict, text: string): Promise<void> {
  if (!v.channel || !v.slack_user) return;   // 채널이 없는 상호작용(모달 등) — 남길 자리가 없다
  const k = `${c.key}|${v.slack_user}|${text}`;
  const at = noticeSeen.get(k) ?? 0;
  if (c.deps.now() - at < NOTICE_EVERY_MS) return;
  noticeSeen.set(k, c.deps.now());
  if (noticeSeen.size > 5000) noticeSeen.clear();
  try {
    const r = await slackCall(c.botToken, "chat.postEphemeral",
      { channel: v.channel, user: v.slack_user, text, ...(v.thread_ts ? { thread_ts: v.thread_ts } : {}) }, { json: true }, c.deps.api);
    if (!slackOk(r)) logger.warn({ bridge: c.bridge.id, err: slackError(r) }, "[slack-bridge] 안내를 남기지 못했다");
  } catch (e) { logger.warn({ bridge: c.bridge.id, err: shortError(e) }, "[slack-bridge] 안내를 남기지 못했다"); }
}

async function react(c: Conn, channel: string, ts: string, name: string): Promise<void> {
  try {
    const r = await slackCall(c.botToken, "reactions.add", { channel, timestamp: ts, name }, { json: true }, c.deps.api);
    if (!slackOk(r) && slackError(r) !== "already_reacted") setError(c, `받음 표시(reactions.add)를 달지 못했습니다: ${slackError(r)}${slackError(r) === "missing_scope" ? " — 봇에 reactions:write 를 더하세요" : ""}`);
  } catch (e) { setError(c, `받음 표시를 달지 못했습니다: ${shortError(e)}`); }
}

// ── 바깥에서 보는 자리 ────────────────────────────────────────────────────────────────────
/** 이 프로세스가 쥔 그 다리의 지금 상태(이 테넌트) — 없으면 null(다른 게이트웨이가 쥐었거나 아무도 안 쥠 · DB 의 status 를 본다). */
export function liveBridgeStatus(bridgeId: string): BridgeStatus | null {
  const c = conns.get(connKey(tenantKeyOf(currentTenant()), bridgeId));
  return c ? { ...c.status } : null;
}

/** 시험 · 내리기 — 이 프로세스의 연결을 전부 내린다. */
export function stopAllSlackBridges(): void {
  for (const c of conns.values()) stopConn(c);
  conns.clear();
  lastSetupError.clear();
  userFactsCache.clear();
  loginProofCache.clear();
  noticeSeen.clear();
  lastPrune.clear();
}
