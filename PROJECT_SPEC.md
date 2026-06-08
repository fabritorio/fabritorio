# Fabritorio — Project Spec

A local-first visual environment for composing, running, and observing AI
agents. Users assemble agents from primitive components on a node-graph
canvas, watch them execute live, and reuse compositions as drop-in
library blocks.

The system runs entirely on the user's machine. A local daemon (the
**runner**) owns all execution — LLM calls, tool use, workspace access. A
Next.js web UI on localhost provides the canvas, inspector, and event
log. The UI is a control plane only; it holds no logic.

This document is the design spec. The README covers usage; the backlog
covers planned work; `docs/layers.md` covers the mental model and design
principles.

---

## Core principles

### One unified graph (Factorio model)

The runtime stores, loads, and executes one shape: a `Graph` of
port-typed nodes connected by edges. A `kind` discriminator names the
surface (`l1` agent, `l2` orchestration, `handler`, `toolpack`,
`skillpack`, `cli_invocation`), but the runtime never branches on it.
Same loader, same bus, same persistence.

L0/L1/L2 are conversational shorthand for the _shape_ of a particular
graph, not architectural layers. See `docs/layers.md`.

### Composition is wiring

Every relationship is an edge. There are no implicit relationships from
spatial overlap or grouping, no hidden registries, no service injection.
The graph **is** the registry — a Handler reads its incoming reference
edges to discover what Tools / Skills / Model / Workspace are available.

Two wire kinds:

- **Reference wires** (Tool → Handler, Skill → Handler, Model → Handler,
  Workspace → Handler, Memory → Agent). The wire says "X is available
  to Y." The target reads its `inWires` at use time.
- **Event-flow wires** (Trigger → Agent, Channel ↔ Agent, Agent.Output
  → Agent.Gateway). Pub/sub subscriptions on the bus. `addEdge`
  registers; `removeEdge` tears down.

### Composites are by-value (drop = copy)

Saved composites — ToolPacks, SkillPacks, Handlers, full L1 agents —
live in a library (`Graph.library === true`). Dropping a library
composite onto a canvas deep-copies its contents (recursively, so a
saved L1 that uses a saved tool_pack ends up with its own private
tool_pack too). Edits to the template do not propagate to existing
drops. Each placeholder node carries a `ref_id` / `l1_graph_id` pointing
at its private copy; the 1:1 invariant is enforced at save time and on
boot via a dedupe migration.

### Always-on event bus

Process boots → bus alive → saved graphs load → edges register
subscriptions → source nodes activate (cron timers fire, channels open).
There is no per-run setup phase, no compile step, no graph traversal at
delivery time. The subscription table is the connectivity.

The bus carries two event kinds on the same stream:

- `DispatchEvent` — control plane between L1 boundaries. Carries
  `eventId` (the chain root) and optional `parentId`.
- `ObservabilityEvent` — internal records (`llm.request`, `llm.chunk`,
  `llm.response`, `tool.called`, `tool.result`, `gateway.received`,
  `output.emitted`, `workspace.file`, `chain.stopped`). Same `eventId`
  as the Dispatch they belong to, so trace-by-eventId reconstructs an
  L1 run.

A "Dispatch" is the event tree rooted at a Channel/Trigger fire.
Cancellation is by `eventId` root — a process-local registry records
cancelled roots; nodes consult it before publishing.

See `docs/event-bus-sequence.md` for the Webchat happy-path sequence.

### State belongs to the graph

Lock-while-running, busy indicators, validation errors, dirty markers —
all live on the graph (or on a node within a graph). Views project the
state; they don't own it. There is no cross-graph state-sync to wire up:
when an L2 NativeAgent is mid-Dispatch, the truth is "this graph is
running"; the collapsed-node indicator on the L2 canvas and the per-node
highlight in the expanded L1 view are two renderings of the same bit.

---

## Component model

### L0 primitives

The atoms. Each is a node with a config and a port surface.

- **Model** — an OpenAI-compatible or Gemini chat-completions endpoint.
  Fields: `provider`, `model_id`, `auth_env`, `base_url`, `temperature`,
  `max_tokens`, `system_prompt`. Provider strategy lives in
  `runtime/providers/` (`openai-compat.ts`, `gemini.ts`).
- **Tool** — references a built-in tool by name (`tool_name`). Built-in
  set: `bash`, `read_file`, `write_file`, `edit_file`, `list_directory`,
  `get_current_time`, plus the special `Skill` tool for skill invocation
  (auto-injected when at least one Skill is wired).
- **Skill** — a `SKILL.md` directory bundle (Anthropic Claude skills
  ecosystem-compatible). Field: skill `name`. Discovered at boot from
  `~/.fabritorio/skills` and any roots in `FABRITORIO_SKILL_ROOTS`.
- **Workspace** — filesystem scope. Fields: `path`, `permissions`
  (`read` / `read-write`). Wired into a Handler binds the built-in fs
  tools to that directory; without a Workspace they fall back to the
  runner's cwd.
- **ToolPack** — composite of Tool nodes. Drilling in opens the inner
  `kind: "toolpack"` graph.
- **SkillPack** — composite of Skill nodes. Drilling in opens the inner
  `kind: "skillpack"` graph.

### L1 — agent graph

A `kind: "l1"` graph forms a single agent's body. Boundary nodes:

- **Gateway** — the entrance node. Receives Dispatch events from L2.
- **Output** — the exit node. Emitting publishes back onto the bus;
  pub/sub delivers to whatever wired the agent. Named ports `result`
  (normal) and `error` (max-iterations / tool failure).
- **Handler** — the central engine. Has two modes:
    - `ref_id` set → references a saved `kind: "handler"` graph; the
      `GraphHandler` interpreter walks that graph's primitives at
      Dispatch time.
    - `ref_id` unset → falls back to the in-code `SimpleHandler`
      factory selected by `name` (default `"SimpleHandler"`). Bootstrap
      fallback for graphs authored without a `ref_id`.

L0 primitives wire as references into the Handler.

### Handler primitives (L0 / `kind: "handler"`)

The four-primitive ReAct loop, exposed as composable nodes. Live in a
saved handler graph that an L1 `HandlerNode.ref_id` points at:

- `handler_input` / `handler_output` — boundary nodes.
- `prompt_builder` — assembles the messages buffer for the loop. Fires
  once per Dispatch.
- `model_call` — calls the wired Model with the current buffer; appends
  the assistant message and any tool calls.
- `tool_exec` — runs each `tool_call` from the last assistant message;
  appends `role: "tool"` results and routes back to `model_call`.
- `evaluator` — branches on the last assistant message: `tools` port if
  there are tool calls, `done` port otherwise.

Default topology (seeded on first boot, stable id):

```
handler_input → prompt_builder → model_call → evaluator
                                       ↑           ├─(tools)→ tool_exec ─┐
                                       │           └─(done)→ handler_output
                                       └─────────────────────────────────┘
```

Saving an alternative handler graph (e.g. reflection: prompt → model →
prompt-as-critique → model → evaluator) and pointing a HandlerNode at
it swaps strategy without code changes.

### L2 — orchestration graph

A `kind: "l2"` graph wires sources (Channels, Triggers) to agent nodes
and reply paths back. Nodes:

- **Channel** — bidirectional external interface. Today: `webchat`.
  Owns its own HTTP/SSE shape under `/channels/<kind>/...`.
- **Trigger** — unidirectional event source. `trigger_kind` selects a
  strategy (`cron` is wired today; `webhook` / `manual` / `event` are
  registered points pending strategy implementations). `instructions`
  is the prompt fired on each tick.
- **NativeAgent** — references a saved L1 graph (`l1_graph_id`).
  Embeds it as a single node on the L2 canvas; double-click drills
  into its body.
- **CliAgent** — generic external-CLI wrapper. Spawns a configured
  command, pipes inbound messages in, captures the reply.
- **GoClaudeAgent** / **PiAgent** — concrete CLI peers pinned to
  [go-claude](https://github.com/eduardlikwong/go-claude) and
  [pi-coding-agent](https://github.com/badlogic/pi-mono). Both speak
  their CLI's session protocol — first turn opens a session, follow-up
  turns resume by id (persisted in wired Memory keyed by
  `dispatch.source`).
- **Memory** — state primitive, three purposes today (`session`,
  `context`, `scratchpad`); future split into pure-storage Memory +
  policy-owning MemoryManager. Full model in `docs/memory.md`.
    - `purpose: "session"` (default) — KV store keyed by
      `dispatch.source`. Native agents use it for full `Message[]`
      conversation history; CLI agents use it for resumable session ids.
    - `purpose: "context"` — static text injected into the prompt
      before each Dispatch.
    - `purpose: "scratchpad"` — agent-writable markdown via
      `memory_read` / `memory_write` builtins.

Attachment surface for CLI-wrapping agents (`CliAgent`, `GoClaudeAgent`,
`PiAgent`) is restricted: only `Skill`/`Workspace`/`Memory` accepted.
`Tool`/`Model`/`Handler` rejected at edge-validate time — the wrapped
CLI owns them. A `kind: "cli_invocation"` sub-graph (drilled into via
`ref_id`) declares the per-agent Model / Workspace / Skill bundle as a
config-only graph.

### Debug nodes

- **DebugGateway** — drop on any L1 canvas to send messages without
  needing an L2 wiring; the Inspector panel speaks to it via
  `/debug/:graphId/:nodeId/*`. Picks up the parent NativeAgent's wired
  Memory when run inside a parented L1 (so debugging an L1 sees the
  same context as the L2).
- **DebugProbe** — pause per-edge delivery for inspection. SSE feed of
  pending halts; resume / enable / disable controls.

---

## Runtime model

### Graph lifecycle

1. **Configure** — author the graph on the canvas. Edits auto-save
   (debounced 250 ms PUT to `/graphs/:id`).
2. **Load** — `POST /graphs/:id/load` activates source bindings:
   channels open, triggers schedule, agents ready their L1 runtime.
   Reference wires resolve at use time, not at load time. Topic
   subscriptions are registered for event-flow wires.
3. **Dispatch** — a Channel or Trigger fabricates a `DispatchEvent`
   and publishes on its outgoing edge topic. Wired sinks receive,
   process synchronously, and emit a child Dispatch (`parentId`
   chained) on every outgoing edge.
4. **Unload** — `POST /graphs/:id/unload` tears down subscriptions,
   stops triggers, closes channels.

### Edit semantics

- A PUT that changes only positional fields (drag a node) skips the
  runtime rebind so auto-save doesn't churn channels/agents.
- A PUT that changes the runtime-relevant subset (nodes/edges/configs)
  triggers an unload + reload of the affected graph and any loaded
  dependents (an L2 wrapping the saved L1, an L0 referenced by a
  ToolPack inside that L1).
- Reloads with an in-flight Dispatch defer until end-of-Dispatch (the
  registry tracks `inFlight` and applies catch-up when the listener
  drains).

### Lock semantics

While an L1 is processing a Dispatch, the agent is locked. The L2
canvas dims the corresponding NativeAgent node; the Inspector blocks
edits to that subtree. The lock bit lives on the graph runtime
registry; the FE projects it via `/graphs/:id/status/stream`.

---

## Persistence

| Path                                   | Contents                                                |
| -------------------------------------- | ------------------------------------------------------- |
| `~/.fabritorio/graphs/<id>.json`       | unified `Graph` records (l1 / l2 / handler / packs / …) |
| `~/.fabritorio/events/<eventId>.jsonl` | per-Dispatch event log; bus hydrates on boot            |
| `~/.fabritorio/memory/<nodeId>.json`   | per-Memory-node persistent map                          |

All paths are overridable via `FABRITORIO_GRAPHS_DIR` /
`FABRITORIO_EVENTS_DIR` / `FABRITORIO_MEMORY_DIR`.

API keys live in a `.env` file at the repo root. Graph files never
contain secrets — Model nodes name an env var via `auth_env` (default
`OPENAI_API_KEY`); the runner resolves it at Dispatch time.

---

## Architecture

```
┌──────────────────────────────────────┐
│            Web UI (localhost:3000)   │
│  ┌────────┐ ┌──────────┐ ┌─────────┐ │
│  │ Canvas │ │Inspector │ │Webchat  │ │
│  │(React  │ │          │ │Panel    │ │
│  │  Flow) │ │          │ │         │ │
│  └────────┘ └──────────┘ └─────────┘ │
│  ┌─────────────────────────────────┐ │
│  │       LogViewer (SSE)           │ │
│  └─────────────────────────────────┘ │
└──────────┬─────────────┬─────────────┘
           │ REST        │ SSE
           ▼             ▼
┌──────────────────────────────────────┐
│       Runner (Fastify, 4000)         │
│  ┌──────────┐ ┌────────────────────┐ │
│  │  Routes  │ │   GraphRuntime     │ │
│  │ /graphs  │ │   Registry         │ │
│  │/channels │ │  (per-graph load   │ │
│  │ /memory  │ │   state, busy,     │ │
│  │ /debug   │ │   subscriptions)   │ │
│  └──────────┘ └────────────────────┘ │
│  ┌──────────────────────────────────┐│
│  │        Always-on EventBus        ││
│  │  (Dispatch + Observability,      ││
│  │   topic pub/sub, source index)   ││
│  └──────────────────────────────────┘│
│  ┌──────────────────────────────────┐│
│  │      Node bindings registry      ││
│  │   channel · trigger · memory     ││
│  │   native_agent · cli_agent       ││
│  │   go_claude_agent · pi_agent     ││
│  │   debug_gateway · debug_probe    ││
│  └──────────────────────────────────┘│
│  ┌──────────────────────────────────┐│
│  │       GraphHandler interp        ││
│  │   (walks `kind:"handler"` graph) ││
│  └──────────────────────────────────┘│
└──────────────────────────────────────┘
```

### Layout

- `apps/runner/src/routes/` — Fastify route registrations.
- `apps/runner/src/runtime/` — bus, bindings, agents, handlers,
  triggers, providers, memory, skills, tools, debug.
- `apps/runner/src/graphs/` — store + invariants + boot migrations +
  library instantiate.
- `apps/web/components/` — Playground (the polymorphic canvas page),
  Inspector, Palette, GraphPicker, LogViewer, WebchatPanel,
  DebugGatewayPanel, ThemeToggle, nodes/.
- `apps/web/lib/` — pure helpers (edge validation, node factory,
  bundle import/export, breadcrumb stack, SSE parser, save-selection,
  webchat thread folding, …).
- `packages/types/src/graph/` — per-category type files
  (`agent.ts`, `orchestration.ts`, `handler.ts`,
  `cli-invocation.ts`, `debug.ts`, `unions.ts`, `graph.ts`).

---

## Out of scope (current state)

Tracked in `docs/backlog.md`. Headlines:

- **Permission policy nodes** — wiring is the implicit allowlist; a
  `PermissionStrategy` node + `CallUserStrategy` (human-in-the-loop
  modal) lands in MVP. Deny-list / allow-list / budget-cap strategies
  post-launch.
- **Cost & usage tracking** — MVP+1.
- **Memory tool** (markdown scratchpad) — MVP.
- **Fab agent** (agent that builds agents on the canvas) — pre-launch.
- **Sprite UI overhaul** — pre-launch differentiator.
- **Generative-app substrate** — pre-launch (slip to v1.5 if it
  threatens cut).
- **Docker container workspaces** — deferred indefinitely.
- **Multi-channel Gateway** (Slack / Discord / API) — deferred until a
  real use case.

---

## Decisions log

Durable design decisions; supersedes prior internal migration plans.

1. **Runner language**: TypeScript. Unified across the monorepo —
   shared types, one toolchain, no sync layer between runner and UI.
2. **Tool sandboxing**: wiring is the implicit allowlist (a tool not
   wired to the Handler doesn't exist for the model). A separate
   `PermissionStrategy` policy layer is planned on top.
3. **Model key management**: `.env` file at the repo root, loaded on
   runner startup. Graph files never carry secrets.
4. **Skills — ecosystem compatibility**: adopt the `SKILL.md` directory
   convention verbatim. Skills are invoked via a built-in `Skill` tool
   with progressive disclosure — not pre-injected into the system
   prompt. Default discovery root is `~/.fabritorio/skills/` (override or
   extend via `FABRITORIO_SKILL_ROOTS`). Fabritorio skills live under their
   own namespace rather than colliding with Claude Code's
   `~/.claude/skills/`.
5. **Skill node as permission gate**: unlike the ecosystem (where
   discovered skills are globally available), a Skill node on the
   canvas represents permission for a specific Handler to invoke that
   skill. Per-agent scoping makes graphs reproducible.
6. **Workspace is a wired node, not a spatial zone**: every other
   primitive composes by edge; a one-off spatial mechanic broke that
   uniformity, complicated multi-workspace semantics, and made
   composite-by-value harder.
7. **Composites are by-value**: dropping a saved composite onto a
   canvas deep-copies its contents (recursively). Each instance owns
   its private graph. Edits to the template do not propagate. The 1:1
   invariant (every `ref_id` referenced by at most one parent node) is
   enforced at save and via a boot dedupe migration.
8. **One unified graph + always-on bus**: one `Graph` substrate
   kind-tagged six ways; one process-wide event bus that lives for the
   whole runner lifetime; edges register subscriptions at `addEdge`
   time and tear them down at `removeEdge` time. No per-run setup
   phase, no compile step, no run-scoped lifecycle.
9. **Handler is a graph, not a class**: the four ReAct primitives live
   in a saved `kind: "handler"` graph that a `GraphHandler` interpreter
   walks at Dispatch time. The in-code `SimpleHandler` factory remains
   as a bootstrap fallback for graphs without a `ref_id`. Alternative
   strategies (reflection, custom routing) are saved handler graphs,
   not new node types.
10. **Multi-turn lives on Memory, not Handler**: `Handler` is `content
in → content out` for one Dispatch. Conversation history lives on a
    wired Memory node (session-purpose), keyed by `dispatch.source`.
    Static prompt context lives on a wired Memory node
    (context-purpose). Either or both can wire to the same agent.
11. **CLI-wrapped agents are atomic at L2**: `CliAgent`,
    `GoClaudeAgent`, `PiAgent` have the same boundary as `NativeAgent`
    (Gateway in, Output out) but no L1 body. Attachment surface is
    `Skill`/`Workspace`/`Memory` only — the wrapped CLI owns
    Tools/Model/Handler. A `kind: "cli_invocation"` sub-graph encodes
    the Model/Workspace/Skill bundle as config, not as an executable
    graph.
12. **Layer vocabulary is scaffolding, not architecture**: L0/L1/L2
    are conversational shorthand for the _shape_ of a graph. The
    runtime never branches on the layer label. Per-kind constraints
    live in dynamic validation, not in the type system. See
    `docs/layers.md` and the planned rename in
    `docs/layer_phaseout.md`.
