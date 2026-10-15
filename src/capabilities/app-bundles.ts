// 앱 판 묶음 상한 · 쓰는 양(#4481 앱 v2-2) — 배포 없이 고치는 자리(상민 2026-10-15 «상한도 동적으로 수정 가능하게»).
//  보기는 구성원 누구나(판 저장이 413 으로 막혔을 때 까닭을 확인), 고치기는 관리자. 값은 org_runtime_config.app_bundle_policy 한 칸이다.
//  천장(APP_BUNDLE_POLICY_MAX)은 공용 게이트웨이를 지키는 값이라 설정으로 넘지 못한다 — 표면 검증과 정규화가 같은 상수를 쓴다.
import { z } from "zod";
import type { Capability } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "./rest-util.js";
import { APP_BUNDLE_POLICY_MAX, MIB, envAppBundlePolicy, normalizeAppBundlePolicy, type AppBundlePolicy } from "../apps/app-bundle-policy.js";
import { appBundlePolicy, appBundlePolicyRow, setAppBundlePolicy } from "../apps/app-version-files.js";
import { blobBytesUsed, defaultBlobStoreKind, referencedBytes } from "../apps/app-blob-store.js";

const KEYS = ["version_max_mb", "file_max_mb", "files_max", "workspace_max_mb"] as const;

async function snapshot(): Promise<Record<string, unknown>> {
  const [policy, row, used, stored] = await Promise.all([appBundlePolicy(), appBundlePolicyRow(), referencedBytes(), blobBytesUsed()]);
  return {
    policy,                                   // 이 워크스페이스에서 지금 쓰는 값
    workspace_setting: row,                   // 관리자가 이 워크스페이스에 적은 값(비면 플랫폼 기본을 따른다)
    platform_default: envAppBundlePolicy(),   // env LIVELY_APP_BUNDLE_POLICY → 코드 기본값
    ceiling: APP_BUNDLE_POLICY_MAX,           // 설정으로 넘지 못하는 천장
    used_mb: Math.round((used / MIB) * 10) / 10,      // 판들이 가리키는 파일(지문마다 한 벌) — 워크스페이스 상한이 재는 양
    stored_mb: Math.round((stored / MIB) * 10) / 10,  // 저장소에 실제로 있는 양(지운 판의 파일은 하루 뒤 정리된다)
    store: defaultBlobStoreKind(),            // 새 판 파일이 가는 곳('s3' · 'db' — 자가호스팅)
  };
}

const appBundleLimits: Capability = {
  name: "app_bundle_limits",
  title: "앱 파일 상한 보기",
  description: "워크스페이스 앱의 판 파일 상한과 쓰는 양 — policy(지금 쓰는 값: version_max_mb 판 하나 · file_max_mb 파일 하나 · files_max 판의 파일 수 · " +
    "workspace_max_mb 워크스페이스 전체) · workspace_setting(관리자가 적은 값) · platform_default · ceiling(천장) · used_mb · stored_mb · store. " +
    "app_save 가 413 으로 막혔을 때 까닭을 확인한다. 고치기는 관리자 app_bundle_limits_set. 구성원 누구나.",
  scope: null,
  input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/app-bundle-limits"], parse: () => ({}) }] },
  handler: async () => snapshot(),
};

const appBundleLimitsSet: Capability = {
  name: "app_bundle_limits_set",
  title: "앱 파일 상한 고치기",
  description: "이 워크스페이스의 앱 판 파일 상한을 고친다(배포 없이 바로 먹는다). 준 값만 바뀌고, reset:true 면 플랫폼 기본으로 되돌린다. " +
    `천장: 판 하나 ${APP_BUNDLE_POLICY_MAX.version_max_mb}MB · 파일 하나 ${APP_BUNDLE_POLICY_MAX.file_max_mb}MB · 파일 수 ${APP_BUNDLE_POLICY_MAX.files_max}개 · ` +
    `워크스페이스 ${APP_BUNDLE_POLICY_MAX.workspace_max_mb}MB. 관리자.`,
  scope: "admin",
  input: {
    version_max_mb: z.number().int().min(1).max(APP_BUNDLE_POLICY_MAX.version_max_mb).optional().describe("판 하나(파일 묶음 전체) 상한 MiB"),
    file_max_mb: z.number().int().min(1).max(APP_BUNDLE_POLICY_MAX.file_max_mb).optional().describe("파일 하나 상한 MiB"),
    files_max: z.number().int().min(1).max(APP_BUNDLE_POLICY_MAX.files_max).optional().describe("판 하나의 파일 수 상한"),
    workspace_max_mb: z.number().int().min(1).max(APP_BUNDLE_POLICY_MAX.workspace_max_mb).optional().describe("워크스페이스 전체(판들이 가리키는 파일, 지문마다 한 벌) 상한 MiB"),
    reset: z.boolean().optional().describe("true 면 워크스페이스 값을 지워 플랫폼 기본으로"),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/app-bundle-limits"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of [...KEYS, "reset"] as const) if (b[k] !== undefined) out[k] = b[k];
      return out;
    } }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx) => {
    let next: Record<string, number> = {};
    if (input.reset !== true) {
      const cur = await appBundlePolicyRow();
      for (const k of KEYS) if (typeof cur[k] === "number") next[k] = cur[k] as number;
      for (const k of KEYS) {
        if (input[k] === undefined) continue;
        const n = Number(input[k]);
        if (!Number.isInteger(n) || n < 1 || n > APP_BUNDLE_POLICY_MAX[k]) throw new HttpError(400, `${k} 는 1~${APP_BUNDLE_POLICY_MAX[k]} 정수여야 합니다`);
        next[k] = n;
      }
      //  정규화(천장 · 잡값)를 거친 값만 적는다 — 적은 칸만 남긴다(안 적은 칸은 플랫폼 기본을 따라가게).
      const norm: AppBundlePolicy = normalizeAppBundlePolicy(next, envAppBundlePolicy());
      next = Object.fromEntries(Object.keys(next).map((k) => [k, norm[k as keyof AppBundlePolicy]]));
    }
    await setAppBundlePolicy(next, { actor: user?.userId || user?.email || "unknown", source: ctx?.source ?? "web" });
    return { ok: true, ...(await snapshot()) };
  },
};

export const appBundleCapabilities: Capability[] = [appBundleLimits, appBundleLimitsSet];
