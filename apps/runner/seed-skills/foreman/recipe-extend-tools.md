<!-- Foreman resource. Loaded on demand via `Skill({name:"foreman", resource:"recipe-extend-tools"})`.
     Not part of the always-loaded core playbook; pull it when you are about to extend the tool catalog via the Tool builder, or attach a ToolPack / skill. -->

## 4. Tools: built-in catalog + runtime registry

The runtime has **two** tool sources:

- **Built-in catalog** (see the reference-tool-catalog resource) — fixed, in-process tools (see the reference-tool-catalog resource) like `bash`,
  `read_file`, `edit_graph`, `ask_agent`. You can't add to this from
  Foreman; the runtime maintainer extends it in code.
- **Runtime tool registry** — open, filesystem-backed at
  `~/.fabritorio/tools/<name>/manifest.json` + `bin/<name>`. Each manifest
  declares one tool: name, description, JSON-Schema parameters, adapter
  config. The runner scans them at boot and on every `GET /tools` /
  registry miss, so new tools land without a restart.

A `tool` node's `tool_name` resolves against **both** sources — built-ins
first, then runtime. If neither resolves, the agent fails to materialize
at handler-build time. **Don't invent names.** If the capability doesn't
exist in either source, the right move is to _build it_ via tool-builder,
not work around it with `bash`+skill workarounds.

### Recipe — extend the catalog via the Tool builder

When the user asks for a capability the catalog doesn't cover — "query
Postgres", "post to Slack", "scrape a webpage", "call our internal API" —
you delegate to the **Tool builder** sub-agent.

**The Tool builder is a dedicated agent, not a skill you hand the Coder.**
It ships wired with the `tool-builder` skill and a `~/.fabritorio/` workspace,
and its system prompt already makes it load that skill before building. It
clarifies the spec when it's underspecified and builds when it's sufficient —
so you have two ways to reach it:

- **(a) Point the user at it.** Drop the Tool builder L1 on the canvas; the
  user chats with it directly and it clarifies what it needs. Foreman isn't in
  the loop. Simplest when the user wants to drive the integration themselves.
- **(b) Pre-interview, then hand over a brief via `ask_agent`.** When you're
  delegating, **you** extract the facts first and pass a complete brief —
  round-tripping clarifying questions through a single-shot `ask_agent` is
  clunky. The canonical "what to clarify" batch lives in the **tool-builder
  skill** (`Skill({name:"tool-builder"})`, its "What to clarify" section):
  verbs (one tool each), return shape per verb, auth / env var. Don't duplicate
  it here.

#### The reach gate (your call, before either path)

Decide whether this is worth a reusable runtime tool at all:

- **Reusable** — anything the user will reach for again → tool-builder path.
- **Genuinely one-off / experimental** → the `bash` + skill fallback may be
  cheaper (see the fallback note below). The fallback persists the friction
  every time; tool-builder pays it once.

Fill the answers into the brief template below for path (b) and pass it
verbatim. You can't write a spec file — you have no workspace — so the brief
_is_ the spec; make it self-contained.

```
Build a runtime tool for <integration>.

Verbs (one tool each):
  - <tool_name>: <what it does> → returns <shape: fields + JSON/text>
  - <tool_name>: ...

Auth: <ENV_VAR_NAME> (user confirms it's in secrets.env: yes/no)
Notes: <rate limits, "current cycle = Mon-Sun", anything the
        manifest description can't carry>
```

#### On-canvas wiring + dispatch (path (b))

0. **Ensure a Tool builder is on the canvas and wired to you.** Check
   `read_canvas` for a `native_agent` whose `l1_graph_id` is the Tool builder
   L1 (`…0c0004`). If there isn't one: `instantiate_composite` that L1 and
   `edit_graph` a `foreman → tool-builder` call edge (see the recipe-ask-agent resource) — or have the
   user drag the Tool builder L1 card onto the canvas and draw the same edge.
   No call edge → `ask_agent` fails.

1. **Dispatch the Tool builder via `ask_agent`** (path (b)). Pass the brief
   you pre-interviewed (integration name, one verb per tool, return shape per
   verb, env var + availability). For a trivial tool the inline shape below is
   enough. You do **not** need to tell it to load its skill — that's wired and
   prompted.

    ```
    ask_agent({
      target_agent_id: "<tool-builder node id from read_canvas>",
      brief: "Build a runtime tool `linear_query` that queries Linear
        issues by assignee/status/cycle. Returns a JSON array of
        {id, title, status, assignee, url, created_at}. LINEAR_API_KEY
        is in env.",
      inherit_session: false,
      timeout_ms: 300000
    })
    ```

    `timeout_ms: 300000` matters — a cold `go build` with module fetches
    easily takes 90-180s. The default 60s will time out mid-build and
    leave the workspace in a half-built state.

2. **Wait for the Tool builder's report.** It comes back with: tool name,
   binary path, manifest path, any env vars the user still needs to set,
   and smoke test outcome.
3. **Wire the new tool on the target agent.** `edit_graph` the L1, add a
   `tool` node with `tool_name: <new>`, and an edge from that tool node
   to the handler. The runtime tool is in the catalog the next time the
   agent dispatches — no restart needed.

    ```json
    {
        "id": "tool-linear",
        "type": "tool",
        "position": { "x": 0, "y": 0 },
        "tool_name": "linear_query"
    }
    ```

    Edge: `tool-linear → handler`.

4. **Report back to the user.** What the tool does, where the manifest +
   binary live, what env vars they need to set if any, and that the tool
   is now wired and callable.

### Worked example — Postgres-querying agent

**Old wrong:** `create_graph` a toolpack with `tool_name: 'query_postgres'`
without building the tool. The name resolves against neither built-ins
nor the registry; agent fails to materialize.

**Right (preferred):**

- Dispatch the Tool builder to produce `pg_query` (manifest + binary at
  `~/.fabritorio/tools/pg_query/`).
- L1: model + handler + workspace + a `tool` node with
  `tool_name: "pg_query"` wired to the handler. Optional `skill` node
  with behavioural guidance ("when to use cycles vs date ranges",
  "common joins") if there's content the manifest description can't
  carry.

**Right (fallback, for one-off ad-hoc work):** workspace wired read-write,
`bash` + fs tools, skill explaining the schema and a `psql` wrapper. Use
this only when the capability is genuinely one-shot or experimental —
anything the user will reach for again deserves a real runtime tool. The
fallback path persists the friction every time; the tool-builder path pays
it once.

### Judgment, not a tool? Use the Skill builder

Sometimes the gap isn't a missing _callable_ — it's missing _judgment_: a
workflow the agent should follow, when-why knowledge, which-flag intuition,
domain context no single call captures. That's a **skill**, not a tool, and
there's a dedicated **Skill builder** sub-agent for it — the judgment-side
sibling of the Tool builder. It ships wired with the `skill-builder` skill and
a `~/.fabritorio/` workspace, and authors a progressive-disclosure `SKILL.md`
(+ optional resource files) under `~/.fabritorio/skills/<name>/`.

Same channel-ownership framing as the Tool builder: whoever holds the user
channel owns the interview.

- **(a) Point the user at it.** Drop the Skill builder L1 (`…0c0005`); the user
  chats with it directly and it clarifies what it needs. Foreman isn't in the
  loop.
- **(b) Pre-interview, then hand a brief via `ask_agent`.** When you delegate,
  extract the facts first and pass a complete brief (the clarify batch lives in
  the `skill-builder` skill — don't duplicate it here).

**The tool/skill gate:** if the real request is "make this binary or API
callable as a gated tool," that's the **Tool builder**, not the Skill builder —
a SKILL.md that just narrates a `bash` invocation is a shim, not a skill.

**Post-build wiring** (parallel to wiring a built tool): a finished skill needs
a `skill` node wired to the target agent — `edit_graph` the L1, add
`{ "type": "skill", "name": "<skill name>" }`, edge `skill-node → handler`. The
SkillRegistry rescans on `GET /skills`, so it's loadable on the next dispatch
with no restart. (Wiring shapes — single skill vs SkillPack — are in "Wiring a
skill" below.)

### When the built-in catalog actually expands

Only the runtime maintainer (the engineer, not you) extends the built-in
catalog, and only for capabilities that need in-process access — substrate
reflection (`read_canvas`, `edit_graph`), permission gating tied to graph
wiring, things subprocess-via-binary fundamentally can't express. The
runtime tool registry handles everything else; you should reach for
tool-builder before you ever feel tempted to ask for a built-in.

A ToolPack is still a different **subset** of the available catalog (mix
of built-ins and runtime tools) — picking which tools an agent gets is
the only legitimate reason to spin up a fresh toolpack.

### Wiring a skill (the actual customization axis)

Skills are how a generic agent (gateway → handler → output + bash)
becomes domain-specific. Two wiring shapes:

**Single skill, by name** — the simplest case. Matches the pattern the
Foreman seed uses for itself:

```json
{
    "id": "skill-pg",
    "type": "skill",
    "position": { "x": 0, "y": 0 },
    "name": "postgres"
}
```

Wire `skill-pg → handler`. `name` must match the `name:` frontmatter of
a SKILL.md the runner already discovered on disk
(`~/.fabritorio/skills/<name>/SKILL.md`, or anywhere in
`FABRITORIO_SKILL_ROOTS`).

**Multiple skills, via a SkillPack** — when an agent needs a bundle:

```json
// create_graph args
{
    "kind": "skillpack",
    "name": "Postgres rig",
    "nodes": [
        { "id": "s-schema", "type": "skill", "name": "pg-schema", "position": { "x": 0, "y": 0 } },
        { "id": "s-queries", "type": "skill", "name": "pg-recipes", "position": { "x": 0, "y": 0 } }
    ],
    "edges": []
}
// → returns { "id": "<SKILLPACK_ID>" }
```

Then in the L1:

```json
{
    "id": "skillpack-1",
    "type": "skill_pack",
    "position": { "x": 0, "y": 0 },
    "ref_id": "<SKILLPACK_ID>",
    "pack_name": "Postgres rig"
}
```

Wire `skillpack-1 → handler`. The handler exposes the wired skills via
the `Skill` tool; the agent reads each skill on demand.

**Foreman doesn't author skill files.** The SKILL.md must already exist
under `~/.fabritorio/skills/` (or the user authors it before wiring). If
a skill the user is asking for doesn't exist yet, say so and ask them
to create it — don't reach for `write_file` to fabricate one inside an
agent build flow.

## 5. Recipe — attach a ToolPack

A ToolPack is a separate graph (`kind: 'toolpack'`) containing `tool`
nodes (and optionally nested `tool_pack` nodes). An L1's `tool_pack`
node references it by `ref_id`. You always need both: the toolpack
graph itself, and a `tool_pack` node inside the L1 pointing at it.

### Step 1 — create the toolpack graph

A "fresh toolpack" is just a fresh **selection** from the closed catalog
(see the reference-tool-catalog resource). You're choosing _which built-ins
this agent gets_ —
not authoring new tools. There's no `list_graphs` to find an existing
toolpack to reuse, so unless the user gave you a specific toolpack id,
create a new one with the catalog subset you want. The selection is
typically the same across many agents (e.g. the "fs + bash" subset
below); the per-agent customization lives in the **skill**, not here.

```json
// create_graph args
{
    "kind": "toolpack",
    "name": "Coder tools",
    "description": "fs + bash for editing source.",
    "nodes": [
        {
            "id": "t-read",
            "type": "tool",
            "position": { "x": 0, "y": 0 },
            "tool_name": "read_file"
        },
        {
            "id": "t-write",
            "type": "tool",
            "position": { "x": 0, "y": 0 },
            "tool_name": "write_file"
        },
        {
            "id": "t-edit",
            "type": "tool",
            "position": { "x": 0, "y": 0 },
            "tool_name": "edit_file"
        },
        {
            "id": "t-list",
            "type": "tool",
            "position": { "x": 0, "y": 0 },
            "tool_name": "list_directory"
        },
        { "id": "t-bash", "type": "tool", "position": { "x": 0, "y": 0 }, "tool_name": "bash" }
    ],
    "edges": []
}
// → returns { "id": "<TOOLPACK_ID>", "graph": {...} }
```

`tool_name` must be one of the built-in names from the catalog in the
reference-tool-catalog resource. Toolpacks have no edges between their tool nodes — the bag
shape is implicit from membership.

### Step 2 — reference the toolpack from the L1

In the L1 graph (see the recipe-build-agent resource), include a `tool_pack` node and wire it to
the handler:

```json
{
    "id": "toolpack-1",
    "type": "tool_pack",
    "position": { "x": 0, "y": 0 },
    "ref_id": "<TOOLPACK_ID>",
    "pack_name": "Coder tools"
}
```

```json
{
    "id": "e-toolpack-handler",
    "source": { "node_id": "toolpack-1" },
    "target": { "node_id": "handler-1" }
}
```

### Step 3 — workspace gating for fs/bash tools

The fs tools (`read_file`, `write_file`, `edit_file`, `list_directory`,
`bash`) only work when a `workspace` node is wired to the handler. The
write/bash tools additionally require `permissions: 'read-write'`.
Without a workspace, read tools fall back to the runner cwd; writes
refuse outright.

If the user asks for a coder agent in a directory, **always** add the
`workspace` node and wire `workspace → handler` — otherwise the tools
will load but every call will refuse.
