// 매니페스트 JSON Schema 생성기 — src/apps/manifest.ts 의 zod 가 유일한 진실이고, 이 스크립트는 그걸 그대로 옮긴다.
//  산출물 public/lively-app.schema.json 은 정적으로 서빙된다(<게이트웨이>/ui/lively-app.schema.json) →
//  앱 개발자가 lively-app.json 에 "$schema" 로 걸면 편집기에서 자동완성·검증이 즉시 된다.
//  실행: npm run build 후  node scripts/gen-app-schema.mjs
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { appManifestSchema } from "../dist/apps/manifest.js";

const schema = zodToJsonSchema(appManifestSchema, { name: "LivelyAppManifest", $refStrategy: "none" });
schema.title = "라이블리 앱 매니페스트 (lively-app.json)";
writeFileSync(new URL("../public/lively-app.schema.json", import.meta.url), JSON.stringify(schema, null, 2) + "\n");
console.log("✓ public/lively-app.schema.json 생성 (zod 단일 출처)");
void z;
