---
name: add-project-op
description: Add a new edit operation (op) to GreanTeaDawy's project model so the UI, MCP and REST can make a new kind of change with live sync, undo and deterministic replay.
---

# Add a project op

All project changes are ops applied by `applyOps` (`packages/core/src/ops.js`) on the client (optimistic), the server
(authoritative) and other tabs (broadcast). Replicas only stay identical if ops are **deterministic**.

## Steps

1. Add the type to `OP_TYPES` and a `case` in `applyOp(d, op)` (`d` is an immer draft):
   - validate with `req(cond, 'message')` — a throw rejects the whole batch (nothing is applied);
   - clamp numbers with `num(value, fallback, min, max)`; strings with `str()`;
   - look things up with `chan(d, id)`, `pat(d, id)`, `insert(d, index)`;
   - make "add" ops **idempotent** (`if (op.x?.id && exists) return;`) — ops may be re-sent after a reconnect.
2. If the op creates anything with an id or random value, fill it in `prepareOps()` so the value travels inside the op.
   Never call `uid()` / `Math.random()` inside `applyOp` for persisted data.
3. Add a line to `describeOps()` (activity log shown in the studio's Claude tab).
4. If the op changes the project shape, update `normalizeProject()` in `model.js` (repair old/malformed data) and
   bump nothing else — projects are normalised on every load.
5. Use it:
   - UI: `useStore.getState().dispatch([{ type: 'x/y', … }], { coalesce: 'key' })` (coalesce merges rapid edits into
     one undo step);
   - MCP: `backend.applyOps(projectId, ops)`.
6. Tests (`packages/core/test/core.test.js`): apply, invalid input rejected, idempotent re-apply, and
   `applyOps(p, prepareOps(ops))` twice gives identical JSON.
7. `npm run lint && npm test && npm run test:e2e`.
