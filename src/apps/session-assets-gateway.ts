// 앱 하네스 자산을 **조직 저장소에서 읽어** 물질화하는 게이트웨이 전용 조각 (#2165 에서 분리).
//
// 왜 갈랐나: 이 둘만 DB 를 탄다(`listComponents`·`getOrgHarnessAsset`). 형제들(`writeAppHome`·
//  `materializePreparedAppAssets`·`appPluginArgs`…)은 순수/fs 라 **노드도 쓴다** — 노드는 게이트웨이가
//  미리 뽑아 실어 보낸 자산(`prepareAppAssets` 결과)을 그대로 쓴다(terminal/sessions.ts 의 appSession 경로).
//  한 모듈에 있는 동안엔 노드가 형제를 쓰는 것만으로 `org/store/*` 가 노드 번들에 실렸다.
import { HttpError } from "../http-error.js";
import { listComponents } from "../org/store/apps.js";
import { getOrgHarnessAsset } from "../org/store/harness-assets.js";
import { assetDiskPath, assertOrigNameSafe, composeAssetFile, directFsWriter, materializePreparedAppAssets,
  appPluginManifest, APP_PLUGIN_MANIFEST_REL, type AppFsWriter, type PreparedAppAsset } from "./session-assets.js";

/**
 * 앱 하네스 자산 물질화(D4) — listComponents(appId) 중 kind='harness_asset' 을 골라 각 org_harness_asset 을 읽어
 *  private app home 의 session-local plugin 에 원명(orig_name)으로 기록한다. **앱 세션 hard-fail**: 자산 없는 앱 세션은 틀린 상태다.
 *  경로안전: orig_name 이 STRICT_SLUG(`/`·`.`·`..`·절대경로·공백 원천차단)가 아니면 거부(traversal 2차 방어).
 */
export async function materializeAppAssets(sessionHome: string, appId: string, writer: AppFsWriter = directFsWriter): Promise<void> {
  await materializePreparedAppAssets(sessionHome, await prepareAppAssets(appId), writer);
}

/** 정책/DB 쪽(게이트웨이)이 앱 자산을 직렬화 가능한 번들로 준비한다. plugin manifest 가 첫 항목이다. */
export async function prepareAppAssets(appId: string): Promise<PreparedAppAsset[]> {
  const out: PreparedAppAsset[] = [{ path: APP_PLUGIN_MANIFEST_REL, body: appPluginManifest(appId), mode: 0o644 }];
  const comps = (await listComponents(appId)).filter((c) => c.kind === "harness_asset");
  for (const c of comps) {
    const origName = assertOrigNameSafe(appId, c.orig_name);
    const asset = await getOrgHarnessAsset(c.ref);
    if (!asset) throw new HttpError(500, `앱 '${appId}' 자산 행 없음: ${c.ref}`);
    const rel = assetDiskPath(asset.kind, origName);
    if (!rel) continue; // harness_asset 인데 kind 가 skill/subagent/command 가 아님(있을 수 없지만 방어) — skip
    out.push({ path: rel, body: composeAssetFile(asset, origName), mode: 0o644 });
  }
  return out;
}