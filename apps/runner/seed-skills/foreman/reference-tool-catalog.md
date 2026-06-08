<!-- Foreman resource. Loaded on demand via `Skill({name:"foreman", resource:"reference-tool-catalog"})`.
     Not part of the always-loaded core playbook; pull it when you are about to look up the exact built-in tool names, args, and wiring requirements. -->

## 7. Built-in tool catalog

These are the **built-in** tools an agent built by Foreman can name from
a `tool` node's `tool_name` field. Names are the authoritative strings —
copy them verbatim. Source of truth:
`apps/runner/src/runtime/builtin-tools.ts` `BUILTIN_TOOL_SPECS`.

**Runtime tools** (built via tool-builder; see the recipe-extend-tools resource) are _also_ nameable
from a `tool` node — their names live at
`~/.fabritorio/tools/<name>/manifest.json`. To see the live catalog
(built-ins + runtime tools, with a `source: 'builtin' | 'runtime'`
field per entry), `curl http://localhost:4000/tools`. The runner
rescans the runtime registry on every request, so a freshly built
tool appears immediately.

### 7a. Palette — port + wiring authority

The runner serves `GET /palette` (no params). It returns the canonical
port surface for every node type, the legal-connection matrix per graph
kind, and the kind-allowlists used at save time. Source of truth:
`apps/runner/src/graphs/palette.ts`. Same payload the web canvas consumes;
the Foreman can `curl http://localhost:4000/palette` to learn which wires
are legal without inventing rules from prose.

Use cases:

- **Before wiring an unfamiliar edge**, check `connections[<kind>]` for a
  `{source, target}` row. Presence means legal; the row's `sourcePort` /
  `targetPort` are the canonical port ids to back-fill on the edge
  endpoints.
- **Before saving a composite** (`kind` of `toolpack` / `skillpack` /
  `handler` / `cli_invocation` / `l1` / `l2`), check
  `compositeKinds[<kind>].allowedNodeTypes` to confirm every node in the
  selection fits.
- **When constructing a node payload**, `nodes[<type>].requiredFields`
  lists the fields the runner won't default; `defaultedFields` lists ones
  the runner stamps automatically (drop them from the payload to keep it
  minimal).

The palette is static for the runner's process lifetime. One read per
session is enough.

### 7b. Ops endpoint — discrete intent batches (optional)

The runner also serves `POST /graphs/:id/ops` (Phase 5 of
`docs/be-owns-state.md`). The body is `{ ops: Op[] }` where each op is one
of `add_node` / `add_edge` / `update_node_config` / `delete_node` /
`delete_edge`. The runner mints ids server-side, applies Phase-3 defaults,
validates wires against the palette, cascades edge removal on delete_node,
and funnels the composed draft through the same persist pipeline
`edit_graph` uses. Atomic — the batch fails on the first bad op and
persists nothing.

Placeholder semantics: `add_node` can set `as: "$1"` (or any `$`-prefixed
token); later `add_edge` ops in the same batch use the placeholder as
`source` / `target`. The response carries `{ graph, remap, results }`
where `remap` resolves placeholders to minted ids.

Either `create_graph` / `edit_graph` (whole-graph PUT, simplest path) or
the ops endpoint works for Foreman. Whole-graph remains canonical for the
recipes in this document; the ops endpoint is an option when you only
need to mutate a small part of an existing graph without re-stating the
whole thing. Both paths run through the same BE validation.

### Filesystem (require a `workspace` wired to the handler)

- **`read_file`** — Read a UTF-8 text file from the wired Workspace.
  Use a path relative to the workspace root.
- **`write_file`** — Write a UTF-8 text file under the wired Workspace,
  creating parent directories as needed. Overwrites if the file already
  exists. Requires the Workspace to be wired with read-write permissions.
- **`edit_file`** — Replace a unique snippet of text in an existing file
  under the wired Workspace. The old_text must occur exactly once.
  Requires the Workspace to be wired with read-write permissions.
- **`list_directory`** — List the immediate entries of a directory under
  the wired Workspace. Returns one entry per line; directories are
  suffixed with `/`. Defaults to the workspace root when path is
  omitted.
- **`bash`** — Execute a bash command inside the wired Workspace.
  Working directory is the workspace root by default, or a relative
  subdirectory if `cwd` is provided. Combined stdout+stderr is returned
  (last ~500 lines / 32KB kept on overflow). Default timeout 30s, max
  300s. Requires the Workspace to be wired with read-write permissions.

### Memory (require a `memory` node with `purpose: 'scratchpad'` wired to the agent)

- **`memory_read`** — Read the agent's scratchpad markdown — long-lived
  notes the agent maintains across Dispatches. Returns the full current
  contents (may be empty on a fresh scratchpad). Pair with
  `memory_write` to update.
- **`memory_write`** — Replace the agent's scratchpad markdown with new
  contents. Use this to record what's worth remembering for future
  Dispatches. The replacement is atomic — to amend rather than rewrite,
  call `memory_read` first, edit the returned text in-process, then
  write the merged result.

### Cross-graph (Foreman's own toolset — give a sub-agent these only if you want it to also build agents)

- **`read_canvas`** — Return the user's "active canvas" — the L2
  orchestration graph that contains the NativeAgent referencing your
  L1. Takes no args. Returns the full Graph JSON. Its `nodes` are the
  canvas structure (channels, NativeAgents, triggers, memories) and
  its `id` is what you pass to `edit_graph` to add new agents/channels
  to the canvas. **Call this first** on every build/edit request.
  Errors with "no active canvas" when the agent is running standalone
  (e.g. DebugGateway); in that case ask the user to specify a target
  L2. There is intentionally no `list_graphs` — you do not browse
  other graphs ambiently; drill in only via `read_graph` from a known
  id.
- **`read_graph`** — Read a saved graph by id. Returns the full Graph
  JSON (id, kind, name, description, library, nodes, edges, timestamps).
  Use this to drill into a specific subgraph — typically the
  `l1_graph_id` from a NativeAgent on the canvas, or a `ref_id` from
  inside an L1 (tool_pack, skill_pack, handler). Also accepts ids you
  just got back from `create_graph` that aren't yet wired into the
  canvas.
- **`create_graph`** — Create a new **live** graph in the runner (the
  `library` flag is forced false — Foreman doesn't author templates).
  Pass `kind` (toolpack, skillpack, handler, cli_invocation, l1, l2) and
  optional `name`, `description`, `nodes`, `edges`. Nodes/edges may be
  omitted to reserve an id and fill in via `edit_graph` later. Node
  positions are computed automatically — you do not need to supply them.
  Returns the new graph id.
- **`edit_graph`** — Replace an existing graph's contents. Pass `id`
  (the graph to edit) and `graph` (the full new payload). The graph
  kind must match the existing kind; the library flag is immutable.
  Auto-layout fills in missing node positions; nodes that already have
  a position keep it. Mutating a loaded graph triggers a runtime
  reload. **Avoid editing `library: true` graphs** — those are palette
  templates; your edits affect future drops, not the user's canvas.
- **`instantiate_composite`** — Stamp a **library template** (palette
  entry) into a fresh **live** graph on the canvas. Pass `template_id`
  (the id of an existing graph with `library: true`). The template
  carries its own positions, so no position argument is needed; call
  `edit_graph` afterwards to relocate. Returns `{id, remap}` where `id`
  is the new live graph's id and `remap` maps each template graph id
  (root and any nested library templates walked into) to its
  freshly-persisted copy id, so the caller can wire edges or refs to
  the freshly-minted graphs. **Prefer this over hand-building when a
  matching template already exists** — it's faster and less error-prone.

### Agent-to-agent and session (in-flight Dispatch context required)

- **`ask_agent`** — Synchronously call another agent reachable via an
  outgoing edge from this agent. Awaits the callee's Output and returns
  its content as the tool result — the model integrates it like any
  other tool reply. Pass `target_agent_id` (the callee's agent node id),
  `brief` (message text). Optional `inherit_session` (default false →
  callee gets a fresh ephemeral source; true → callee shares the
  caller's session) and `timeout_ms` (default 60000). Errors cleanly
  if no outgoing edge exists from caller to target. See the recipe-ask-agent resource.
- **`prior_turns`** — Return the most recent root-Dispatch turns of the
  current session, as a JSON array of `{eventId, timestamp, role,
content}` entries (oldest first). Optional `limit` (default 10
  turns). Excludes the in-flight turn. Use at the start of a turn to
  recover prior conversation context. See the recipe-ask-agent resource.

### Misc

- **`get_current_time`** — Returns the current wall-clock time. Useful
  for time-stamping or relative-time computations.
