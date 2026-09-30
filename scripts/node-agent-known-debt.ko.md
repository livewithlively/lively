# 노드 에이전트 번들 — 남은 부채 5 (#2165)

`node-agent-known-debt.json` 은 기계가 읽는 목록이라 이유를 담을 수 없다. 여기 적는다.
**줄어들기만 해야 한다** — `scripts/node-agent-bundle-boundary.test.mjs` 의 `DEBT_CEILING` 이 래칫이다.
고칠 자리는 `node scripts/node-agent-bundle-map.mjs` 가 경계 간선으로 보여 준다.

⚠ `await import()` 로는 못 뺀다 — esbuild 는 outfile 하나면 동적 import 를 같은 번들에 인라인한다(실측).
 **모듈을 가르거나(무거운 쪽/가벼운 쪽), 의존을 뒤집어야 한다**(`sessions/gateway-capabilities.ts`).

| 모듈 | 어떻게 들어오나 | 왜 아직 못 뺐나 |
|---|---|---|
| `sessions/session-outbox.js` | `terminal/sessions.js` 가 **동적** import(2곳) | 이미 동적인데도 남는다 — 위 ⚠ 그대로다. `itemsPool` 을 직접 쓰므로(14곳) 가르려면 큐 저장소와 전달 로직을 분리해야 한다. 노드에선 실행되지 않는다(게이트웨이가 큐를 읽어 전달). |
| `terminal/member-kit-seed.js` | `terminal/sessions.js` | 무거운 의존(`org/store`·`org/delivery/publish`)은 이미 게이트웨이 능력으로 뺐다. 모듈 자체는 세션 생성 경로가 직접 부르므로 남는다 — 노드에선 `memberExecConfigured()` 가 false 라 즉시 반환한다. |
| `gateway-url.js` | `terminal/sessions.js` | `org/store/profile` 하나만 탄다(배럴은 이미 끊었다). 게이트웨이 주소는 노드도 알아야 해서 완전 분리가 애매하다 — 캐시된 값을 주입받는 형태로 바꾸는 게 다음 수. |
| `org/tenant-context.js` | `v6/embedding-provider.js` | 순수(AsyncLocalStorage)라 DB 는 안 탄다. 노드에선 컨텍스트가 늘 비어 기본값으로 동작한다. 크기·표면 문제이지 계약 위반은 아니다. |
| `db/tenant-column.js` | `org/store/audit.js` | `itemsPool` 을 탄다. audit 경로가 노드에서 도달 가능한지부터 확인해야 한다(도달 못 하면 그 간선을 끊는 것으로 끝난다). |

## 이미 승인으로 간 것 중 헷갈리기 쉬운 둘

`sessions/session-desired.js` · `v6/execution-session-store.js` 는 `org/`·`v6/` 네임스페이스지만
**모듈 안에 `ON_NODE` 가드가 있어 노드에서 명시적으로 no-op** 한다(#1791 설계). 부채가 아니라 설계다 —
네임스페이스 규칙은 'DB 를 타는가'의 대리지표이지 그 자체가 목적이 아니다.
