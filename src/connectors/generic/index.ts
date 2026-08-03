// 범용 드라이버 해소(#1419 T2) — 프리셋 하나를 받아 **커넥터처럼 행동하는 것**을 돌려준다.
//
//  run-sync 는 종전에 `connectors[name]`(코드 레지스트리) 하나만 알았다. 이제 그 앞에 이 해소가 선다:
//   내장·복제 프리셋 → 기존 커넥터 모듈 그대로 · http/rss/webhook 프리셋 → 설정으로 조립한 커넥터.
//  어느 쪽이든 반환 타입이 같은 Connector 라, run-sync 의 오케스트레이션(커서·배치·후처리)은 무변경이다.
import type { Connector } from "../types.js";
import { connectors } from "../index.js";
import { resolvePreset, moduleNameOf, type ResolvedPreset } from "../../org/store/collector-presets.js";
import { makeHttpConnector, type HttpDriverConfig } from "./http-driver.js";
import { makeRssConnector, type RssDriverConfig } from "./rss-driver.js";
import { makeWebhookConnector, type WebhookDriverConfig } from "./webhook-driver.js";

/**
 * 프리셋 + 해소된 수집기 설정 → Connector.
 *  collectorId 는 웹훅 드라이버에만 필요하다(자기 수신함을 찾아야 하므로).
 */
export function connectorForPreset(
  preset: ResolvedPreset, settings: Record<string, string | undefined>, collectorId: number,
): Connector {
  const mod = moduleNameOf(preset);
  if (mod) {
    const c = connectors[mod];
    if (!c) throw new Error(`프리셋 '${preset.key}' 가 가리키는 커넥터 모듈이 없습니다: ${mod}`);
    return c;
  }
  // 파서는 프리셋에 저장되지만 드라이버 설정으로 흘러야 한다 — 두 곳에 적게 하지 않으려고 여기서 합친다.
  const cfg = { ...preset.driverConfig, parserScript: preset.parserScript ?? undefined };
  switch (preset.driver) {
    case "http": return makeHttpConnector(preset.key, cfg as HttpDriverConfig, settings);
    case "rss": return makeRssConnector(preset.key, cfg as RssDriverConfig, settings);
    case "webhook": return makeWebhookConnector(preset.key, collectorId, cfg as WebhookDriverConfig, settings);
    default: throw new Error(`알 수 없는 수집 방식: ${preset.driver}`);
  }
}

/** run-sync 진입 편의 — 프리셋 key 로 바로 해소. 없는 프리셋은 던진다(조용히 no-op 하지 않는다). */
export async function connectorForPresetKey(
  presetKey: string, settings: Record<string, string | undefined>, collectorId: number,
): Promise<{ connector: Connector; preset: ResolvedPreset }> {
  const preset = await resolvePreset(presetKey);
  if (!preset) throw new Error(`알 수 없는 프리셋: ${presetKey}`);
  if (!preset.enabled) throw new Error(`프리셋 '${presetKey}' 가 꺼져 있습니다`);
  return { connector: connectorForPreset(preset, settings, collectorId), preset };
}
