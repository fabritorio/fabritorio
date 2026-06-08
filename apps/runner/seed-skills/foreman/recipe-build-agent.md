<!-- Foreman resource. Loaded on demand via `Skill({name:"foreman", resource:"recipe-build-agent"})`.
     Not part of the always-loaded core playbook; pull it when you are about to build an L1 agent body and wire it onto an L2 canvas. -->

## 2. Recipe — build a live L1 agent

The minimal L1 is **gateway → handler → output**, with a **model**
reference-wired to the handler. That's enough to dispatch through and get
a model reply. Add `tool_pack`, `skill_pack` (or a single `skill` node),
`workspace`, `memory` as needed. The differentiator between agents is
almost always **skill + workspace + system_prompt** — the toolpack is
typically a stock subset of the catalog, shared across many agents.

### Shortcut — use `STARTER_L1_ID` when you don't need full control

Before hand-building from scratch, consider:

```json
// instantiate_composite args
{ "template_id": "00000000-0000-4000-8000-0000000a0002" }
// → returns { "id": "<NEW_L1_ID>", "remap": {...} }
```

You now have a live L1 with gateway → handler → model + output already
wired. `edit_graph` the result to add `skill` / `tool_pack` / `workspace`
and update the model's `system_prompt` to the agent's persona. Saves you
the L1 wiring boilerplate when the user just needs "a coder with bash".

Prefer this when the differentiator really is just skill + workspace +
prompt. Drop back to the from-scratch recipe below when you need an
unusual topology (multiple models, a custom handler graph, etc.).

### Field reference (what each node carries)

- `gateway` — `{ id, type: 'gateway', position }`. No config.
- `handler` — `{ id, type: 'handler', position, max_iterations?, ref_id?, name? }`.
    - `ref_id` points at a saved `kind: 'handler'` graph. Leave unset to
      fall back to the in-code SimpleHandler ReAct loop (default).
    - `max_iterations` caps the ReAct loop. Omit to accept the
      server-applied default (8); only set it to override.
- `output` — `{ id, type: 'output', position, ports? }`. Default ports
  are `result` / `error`. Usually you can leave `ports` unset.
- `model` — `{ id, type: 'model', position, provider, model_id, auth_env?, base_url?, temperature?, max_tokens?, system_prompt? }`.
    - `provider` is e.g. `'anthropic'`, `'openai'`. `model_id` is e.g.
      `'sonnet'`, `'gpt-4o-mini'`.
    - `auth_env` names the env var (`'ANTHROPIC_API_KEY'`,
      `'OPENAI_API_KEY'`).
    - `system_prompt` is the agent's persona / instructions.
- `tool_pack` — `{ id, type: 'tool_pack', position, ref_id?, pack_name? }`.
  `ref_id` points at a `kind: 'toolpack'` graph (see the recipe-extend-tools resource).
- `skill_pack` — `{ id, type: 'skill_pack', position, ref_id?, pack_name? }`.
- `workspace` — `{ id, type: 'workspace', position, path, permissions }`
  with `permissions: 'read' | 'read-write'`. `path` should be absolute.
- `permission` — `{ id, type: 'permission', position, strategy?, label? }`.
  Optional gate; tools wired through it get a HITL allow/deny prompt.

### Edges (reference wires) for an L1

- `gateway → handler` — entry into the loop (event wire).
- `handler → model` — handler reads its model (reference wire).
- `handler → output` — exit of the loop (event wire).
- `tool_pack → handler` / `skill_pack → handler` — attachments.
- `workspace → handler` — bind built-in fs/bash tools to a directory.
- `memory → handler` (or `memory → native_agent` at L2) — scratchpad /
  session / context store.

### Positions

**Do not pick coordinates.** Every write tool runs the graph through
auto-layout before persisting. You can omit `position` entirely; the
runner fills it in. The examples below include positions only because
the type still requires the field — `{ x: 0, y: 0 }` is fine, the
helper will reposition.

### Ids — server-minted

**Do not pick node or edge ids either.** As of the BE-owned-state
rollout, `create_graph` and `edit_graph` mint canonical ids server-side:
`<prefix>-<short-uuid>` (e.g. `gateway-x3k9p2`, `channel-7f3a2b`). Omit
the `id` field on nodes and edges and the runner fills it in.

The examples below still show readable placeholder ids like `gateway-1`
and `handler-1` so the wiring is human-readable, but these are
**placeholders** — the runner rewrites them and returns a `remap` field
alongside the persisted graph: `{ id, graph, remap }`. The remap is
`{ "gateway-1": "gateway-x3k9p2", ... }` for every id that was
rewritten. Use it if you need to capture the canonical id for a node
you'll wire from a later call.

In practice for a single `create_graph` / `edit_graph` build: pick any
unique-within-payload placeholder ids so edges resolve correctly, send
the payload, and read the canonical ids back from `graph.nodes[i].id`
(or via `remap`). Don't try to reuse placeholder ids across calls —
they only exist for the duration of one payload.

### Defaults — server-applied

The runner stamps node-kind defaults onto incoming payloads, so a node
that omits an optional field still arrives back fully formed. Omit
these and let the runner fill them:

- `handler.max_iterations` → `8`
- `model.temperature` → `0.3`
- `memory.n` (when `handling: 'last_n'`) → `20`
- `memory.token_budget` (when `handling: 'last_within_tokens'`) → `8192`
- `debug_gateway.mode` → `'live'`
- `debug_probe.haltOn` → `'both'`, `debug_probe.enabled` → `true`
- `permission.strategy` → `'call_user'`

Only set these fields when you need to override the default — e.g. a
tight loop with `max_iterations: 3`, or a deterministic model run with
`temperature: 0`. Required fields (`model.provider`, `model.model_id`,
`workspace.path`, etc.) are still the caller's responsibility.

### Worked example — `edit_graph` payload

Build flow: call `create_graph` with `kind: 'l1'` to reserve an id,
then `edit_graph` with the full body. Splitting it this way means you
get the new graph id back before you have to commit to ids inside.

```json
// 1. create_graph args
{
    "kind": "l1",
    "name": "Coder agent",
    "description": "Reads/writes ~/Projects/foo with bash."
}
// → returns { "id": "<L1_ID>", "graph": {...} }
```

```json
// 2. edit_graph args (using the returned <L1_ID>)
{
    "id": "<L1_ID>",
    "graph": {
        "kind": "l1",
        "name": "Coder agent",
        "description": "Reads/writes ~/Projects/foo with bash.",
        "nodes": [
            { "id": "gateway-1", "type": "gateway", "position": { "x": 0, "y": 0 } },
            {
                "id": "handler-1",
                "type": "handler",
                "position": { "x": 0, "y": 0 }
            },
            {
                "id": "model-1",
                "type": "model",
                "position": { "x": 0, "y": 0 },
                "provider": "anthropic",
                "model_id": "sonnet",
                "auth_env": "ANTHROPIC_API_KEY",
                "system_prompt": "You are a coding assistant. Use the wired tools to read, edit, and run code in the workspace."
            },
            {
                "id": "workspace-1",
                "type": "workspace",
                "position": { "x": 0, "y": 0 },
                "path": "/Users/me/Projects/foo",
                "permissions": "read-write"
            },
            {
                "id": "toolpack-1",
                "type": "tool_pack",
                "position": { "x": 0, "y": 0 },
                "ref_id": "<TOOLPACK_ID>",
                "pack_name": "Coder tools"
            },
            { "id": "output-1", "type": "output", "position": { "x": 0, "y": 0 } }
        ],
        "edges": [
            {
                "id": "e-gateway-handler",
                "source": { "node_id": "gateway-1" },
                "target": { "node_id": "handler-1" }
            },
            {
                "id": "e-handler-model",
                "source": { "node_id": "handler-1" },
                "target": { "node_id": "model-1" }
            },
            {
                "id": "e-workspace-handler",
                "source": { "node_id": "workspace-1" },
                "target": { "node_id": "handler-1" }
            },
            {
                "id": "e-toolpack-handler",
                "source": { "node_id": "toolpack-1" },
                "target": { "node_id": "handler-1" }
            },
            {
                "id": "e-handler-output",
                "source": { "node_id": "handler-1" },
                "target": { "node_id": "output-1" }
            }
        ]
    }
}
```

`<TOOLPACK_ID>` is the id of a `kind: 'toolpack'` graph. Build that
first (see the recipe-extend-tools resource), or omit the `tool_pack` node entirely if the agent
doesn't need tools yet.

## 3. Recipe — wire an L2 channel

L2 is the orchestration layer. The minimal chat-driven setup is one
`channel` node bidirectionally wired to one `native_agent`:

```
channel(webchat)  ⇄  native_agent
```

The webchat channel is the same node in both directions: incoming
publishes from the user fan out via `channel → agent`; the agent's
reply travels back via `agent → channel` and the channel's SSE
listeners deliver it to the browser.

**Convention, not enforced:** the recommended shape is one channel
bidirectionally wired to one agent — keeps the session id
(`source = channel:<channel_node_id>`) unambiguous. The validator does
not currently reject the older two-`channel` (channel-in + channel-out)
shape; both work at runtime. Prefer one-channel for new graphs you build.

### Field reference

- `channel` — `{ id, type: 'channel', position, channel_kind, display_name? }`.
  `channel_kind: 'webchat'` is the only kind in v0.
- `native_agent` — `{ id, type: 'native_agent', position, l1_graph_id, display_name?, description? }`.
  `l1_graph_id` must be the id of an existing `kind: 'l1'` graph. `description`
  is model-facing: when this agent is wired as a callee, it becomes that
  callee's `ask_agent_<name>` tool description. Dropping a library L1 card
  seeds it from the L1's description; override it here when delegation needs
  more specific guidance.
- `trigger` — for cron / webhook / manual / event sources. See `orchestration.ts`.
- `memory` — wire `memory → native_agent` for scratchpad / session / context.

### Worked example — `edit_graph` payload for L2

```json
{
    "id": "<L2_ID>",
    "graph": {
        "kind": "l2",
        "name": "Coder canvas",
        "nodes": [
            {
                "id": "ch-1",
                "type": "channel",
                "position": { "x": 0, "y": 0 },
                "channel_kind": "webchat",
                "display_name": "Coder chat"
            },
            {
                "id": "agent-1",
                "type": "native_agent",
                "position": { "x": 0, "y": 0 },
                "l1_graph_id": "<L1_ID>",
                "display_name": "Coder"
            }
        ],
        "edges": [
            {
                "id": "e-channel-to-agent",
                "source": { "node_id": "ch-1" },
                "target": { "node_id": "agent-1" }
            },
            {
                "id": "e-agent-to-channel",
                "source": { "node_id": "agent-1" },
                "target": { "node_id": "ch-1" }
            }
        ]
    }
}
```

The runtime activates channels automatically when the L2 graph loads.
After this `edit_graph` returns, the user can talk to the agent by
POSTing to `ch-1` from the webchat UI. If you (Foreman) need to talk
to the agent yourself mid-turn, wire a Foreman→agent edge and use
`ask_agent` (see the recipe-ask-agent resource).
