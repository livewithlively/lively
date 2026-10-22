// 분기에서 여는 라이블리 도구 — **실제 표면**에 대어 본다(#4489 · 격리 리뷰). 실행: npm run build && node dist/agent-jobs/fork-tools.test.js
//  이게 틀리면: 목록의 도구 이름이 바뀌거나 쓰기로 바뀌었는데 아무도 모른 채 분기에서 조용히 빠지거나(목록과 표면이 어긋남),
//  누가 목록에 밖으로 나가는 도구를 더해도 검토 없이 열린다.
import assert from "node:assert/strict";
import { capMutates, isToolExposed, registry } from "../capabilities/index.js";
import { FORK_LIVELY_READ_TOOLS, forkLivelyReadTools } from "./fork-guard.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };

const surface = [...registry.values()].filter((cap) => isToolExposed(cap, undefined)).map((cap) => ({ name: cap.name, mutates: capMutates(cap) }));
assert.ok(surface.length > 100, `표면이 비었다(${surface.length}) — 아래 단언이 vacuous 해진다`);

//  T1 — 목록의 도구는 전부 지금 MCP 로 노출된 읽기 도구다(이름이 바뀌었거나 쓰기로 바뀌면 빨강).
assert.deepEqual(forkLivelyReadTools(surface), [...FORK_LIVELY_READ_TOOLS].sort(), "목록과 표면이 어긋났다 — 이름 · 읽기 판정을 확인하고 목록을 고친다");
ok("T1 목록의 도구는 전부 노출된 읽기 도구");

//  T2 — 밖으로 나가거나 · 서명 주소를 내주거나 · 파일을 만들거나 · 자격을 돌려주는 이름은 목록에 없다(늘릴 때 다시 보게).
//  people · member — 구성원 이메일 · 초대 대기 이메일을 주는 도구(workspace_people · org_members — 재검토: 업무 맥락이 아니다).
const RISKY = /(credential|secret|token|password|unmask|_url$|preview|pull|discover|github|gitlab|google|slack|notion|figma|linear|oauth|broker|delegate|db_query|org_|people|member)/;
assert.deepEqual(FORK_LIVELY_READ_TOOLS.filter((n) => RISKY.test(n)), []);
ok("T2 밖으로 나가는 · 자격 · 서명 주소 · 관리 설정 · 구성원 연락처 이름은 없다");

console.log(`agent-jobs fork-tools.test: ${pass} passed`);
