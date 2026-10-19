// 신원 검사 층 레이어 올리기(#4485 앱 v2-6) — 코어 판마다 검사 층(app-server-guard.ts)의 글이 바뀌면 새 레이어 판을 한 번 올린다.
//  이름 `<접두>guard`(= lvly-app-guard) — 박스 역할 정책이 lvly-app-* 레이어만 만들고 달게 한다(lively-infra app-servers.tf).
//  같은 글인지는 zip 지문(sha256)으로 가른다 — 레이어 판 설명에 지문을 싣고, 있으면 그 판을 쓴다(게이트웨이를 다시 띄워도 새로 올리지 않는다).
//  두 게이트웨이가 동시에 처음 올리면 판이 둘 생길 수 있다 — 내용이 같아 어느 쪽을 써도 된다.
import { GUARD_VERSION, guardLayerZip } from "./app-server-guard.js";
import type { LayerVersion } from "../net/aws/lambda-lite.js";

export interface LayerApi {
  listLayerVersions(layer: string): Promise<LayerVersion[]>;
  publishLayerVersion(layer: string, input: { zip: Buffer; description: string; architectures: string[] }): Promise<LayerVersion>;
}

export const guardLayerName = (prefix: string): string => `${prefix}guard`;
const tagOf = (sha256: string): string => `sha256:${sha256.slice(0, 32)}`;

const cache = new Map<string, string>();
export function resetGuardLayerCacheForTest(): void { cache.clear(); }

/** 이 코어 판의 검사 층 레이어 판 ARN — 없으면 올린다. */
export async function ensureGuardLayer(api: LayerApi, env: { region: string; prefix: string }): Promise<string> {
  const { zip, sha256 } = guardLayerZip();
  const name = guardLayerName(env.prefix);
  const key = `${env.region}|${name}|${sha256}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const tag = tagOf(sha256);
  const found = (await api.listLayerVersions(name)).filter((v) => (v.Description ?? "").includes(tag)).sort((a, b) => b.Version - a.Version)[0];
  const arn = found?.LayerVersionArn
    ?? (await api.publishLayerVersion(name, { zip, description: `lively app guard v${GUARD_VERSION} ${tag} (#4485)`, architectures: ["arm64"] })).LayerVersionArn;
  if (!arn) throw new Error(`검사 층 레이어 판을 정하지 못했습니다(${name})`);
  cache.set(key, arn);
  return arn;
}
