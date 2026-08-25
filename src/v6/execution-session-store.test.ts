// DB 쓰기와 같은 순수 전이 규칙: 동일 지정은 멱등, 전환·해제는 revision/epoch가 정확히 1 증가한다.
import assert from "node:assert/strict";
import { executionBindingTransition } from "./execution-session-store.js";

let pass = 0;
const ok = (name: string): void => { pass++; console.log(`ok  ${name}`); };

{
  const next = executionBindingTransition({ project_id: null, desired_revision: 0, applied_revision: 0, binding_epoch: 0 }, 11);
  assert.deepEqual(next, { changed: true, project_id: 11, desired_revision: 1, applied_revision: 0, binding_epoch: 1 });
  ok("첫 바인딩 0→1");
}
{
  const next = executionBindingTransition({ project_id: 11, desired_revision: 1, applied_revision: 1, binding_epoch: 1 }, 22);
  assert.deepEqual(next, { changed: true, project_id: 22, desired_revision: 2, applied_revision: 1, binding_epoch: 2 });
  ok("프로젝트 전환 1→2");
}
{
  const next = executionBindingTransition({ project_id: 22, desired_revision: 2, applied_revision: 2, binding_epoch: 2 }, null);
  assert.deepEqual(next, { changed: true, project_id: null, desired_revision: 3, applied_revision: 2, binding_epoch: 3 });
  ok("해제도 새 epoch");
}
{
  const next = executionBindingTransition({ project_id: 22, desired_revision: 2, applied_revision: 1, binding_epoch: 2 }, 22);
  assert.deepEqual(next, { changed: false, project_id: 22, desired_revision: 2, applied_revision: 1, binding_epoch: 2 });
  ok("같은 프로젝트 재지정은 멱등");
}

console.log(`\n${pass} passed`);
