# Recipes

Task-first patterns for the wiring you'll reach for most. The [node reference](./node-reference.md) tells you what each node _is_; this tells you what to _wire_ to get a result. Each recipe is the goal, the nodes, and the one setting that's easy to miss — follow the links into the reference for the per-knob detail.

## Contents

- [Give an agent memory across chats](#give-an-agent-memory-across-chats)
- [Loop detector](#loop-detector)
- [Context compactor](#context-compactor)
- [Delegate to a sub-agent](#delegate-to-a-sub-agent)
- [Run an agent on a schedule](#run-an-agent-on-a-schedule)
- [Fail over between models](#fail-over-between-models)
- [Add a new tool](#add-a-new-tool)
- [Author a skill](#author-a-skill)

---

## Give an agent memory across chats

An agent forgets between dispatches by default. To carry conversation history forward, hang a [Memory](./node-reference.md#memory) node off it.

**Wire:** `memory → agent`, with:

| Dial           | Value           | Why                                              |
| -------------- | --------------- | ------------------------------------------------ |
| `storage_kind` | `kv`            | Keyed store, the one used for conversation turns |
| `handling`     | `last_n`        | Replays the last _n_ turns (default 20)          |
| `tool_access`  | `none`          | History is injected, not tool-driven             |
| storage        | `local_storage` | Survives restarts (`~/.fabritorio/memory/`)      |

**Gotcha:** `in_memory` storage looks identical until you restart the runner and the history is gone. Use `local_storage` for anything you want to keep. `last_n` bounds what the model _reads_, not what's _stored_ — the kv store keeps growing.

<!-- screenshot: memory node wired to an agent, inspector showing the dials -->

---

## Loop detector

A small model can get stuck repeating the same failing tool call. A [Checkpoint](./node-reference.md#checkpoint) in `supervisor` mode periodically hands the transcript to a separate agent that votes `continue` or `stop`.

**Wire:** drop a Checkpoint on the agent, then wire it to a strategy agent (click the Checkpoint node to pick which agent it consults). Set:

- **`mode`** = `supervisor`
- **`cadence`** = `{ kind: 'iterations', at: [4, 8, 12] }` — escalate at those loop counts

Give the strategy agent a one-job prompt:

> You are a loop-detector. You'll be shown a transcript of another agent's work. If it's making genuine progress, reply continue. If it's stuck repeating the same failing action with no progress, reply stop. Reply with only that one word.

**Gotcha:** the loop keyword-parses the reply and **fails open to `continue`**, so a chatty strategy agent that buries the word in a paragraph still works, but one that never says `stop` can't halt anything. Keep the prompt to the single word.

<!-- screenshot: checkpoint wired to a loop-detector strategy agent (see assets/checkpoint.png style) -->

---

## Context compactor

A long tool-call loop blows the context window. A [Checkpoint](./node-reference.md#checkpoint) in `mutator` mode summarizes the working buffer mid-loop and splices the summary back in, keeping the last few turns verbatim.

**Wire:** same as the loop detector — a Checkpoint consulting a strategy agent — but set:

- **`mode`** = `mutator`
- **`keep_last`** = `4` — turns left untouched at the tail (default ~4)
- **`cadence`** = when to compact, e.g. `{ kind: 'iterations', at: [10] }`

The strategy agent's job is to return a tight summary of everything before the kept tail. Prompt it as a summarizer, not a supervisor.

**Gotcha:** `mutator` _replaces_ buffer content for the rest of the dispatch — it never writes back to a Memory node. It bounds the in-loop context, not your stored history. The two are different layers.

---

## Delegate to a sub-agent

One agent can call another and await its reply, so you can split a job across specialists. The callee is exposed to the caller as an `ask_agent_<name>` tool.

**Wire — two things, both required:**

1. Wire an [`ask_agent`](./node-reference.md#built-in-tools) Tool node to the caller's handler. This is the capability grant; it is _not_ automatic.
2. Draw an event edge `caller → callee` for each agent you want reachable.

The single `ask_agent` tool then fans out to one `ask_agent_<name>` per agent the caller has an edge to. Tool but no edge → nothing to call; edge but no tool → no way to call it.

**Gotcha:** the callee's **description** becomes the tool description the caller's model sees when deciding whether to call it. A vague description means the caller never reaches for it — write the description as an instruction to the caller, not a label.

<!-- screenshot: two agents on the orchestration canvas with an ask_agent edge -->

---

## Run an agent on a schedule

To fire an agent without a human in the loop, wire a [Trigger](./node-reference.md#triggers). It dispatches one-way (no reply path) and fabricates the inbound message from its `instructions` field.

**Wire:** `trigger → agent`, with one of the live kinds:

- **`cron`** — `expression` (standard cron), e.g. `0 9 * * *` for 9am daily
- **`schedule`** — `at` for a one-shot ISO time, or `recurrence` (interval / daily / weekly), optionally bounded by `from` / `until`

**Gotcha:** the agent only ever sees the `instructions` text as its prompt — there's no live event payload yet (`webhook` / `event` / `manual` aren't wired up). Write `instructions` as a complete standing order. Set `paused` to park a trigger on the canvas without it firing.

---

## Fail over between models

To keep an agent running when its primary model is down or rate-limited, put a [Model Router](./node-reference.md#model--model-router) between the agent and several Models.

**Wire:** `router → handler`, and wire each Model into the router in priority order. On a failed call it falls over to the next.

**Gotcha:** failover is the _only_ policy today — it's not load-balancing or cost-routing. Order the wired Models by preference; the router walks them top-down until one answers.

---

## Add a new tool

When the built-in catalog doesn't have the capability you need, the [Tool Builder](./node-reference.md#system-agents) authors a runtime tool (a binary + `manifest.json`) from a plain-language brief.

**Steps:**

1. Drop the **Tool Builder** from the library and open a chat with it.
2. Describe the tool — what it does, its inputs, the API or CLI it wraps. It writes the artifact under `~/.fabritorio/tools/<name>/`.
3. The picker reads the catalog live, so the new tool appears under **Runtime** in any [Tool](./node-reference.md#tools--tool-packs) node's picker. Wire a Tool node referencing it.
4. If it needs credentials, wire a [Secrets](./node-reference.md#secrets) node to the tool rather than putting the key in its config.

**Gotcha:** the Tool Builder wraps a _binary or API call_ — a concrete capability. If what you actually want is to teach judgment (the _how_ and _when_), that's a skill, not a tool. See the next recipe.

<!-- screenshot: Tool Builder chat + the resulting Tool node in the picker -->

---

## Author a skill

A [Skill](./node-reference.md#skills--skill-packs) is a `SKILL.md` playbook that teaches an agent the _how_ and _when_ of a domain, loaded on demand by name. The payoff: two agents can share the exact same tools and differ only by a wired skill. The [Skill Builder](./node-reference.md#system-agents) authors one from a brief, or you can write it by hand.

**Steps:**

1. Drop the **Skill Builder** and chat it the domain and the judgment you want captured. It writes `~/.fabritorio/skills/<name>/SKILL.md` and probes it before reporting back.
2. Wire a [Skill](./node-reference.md#skills--skill-packs) node referencing it by name into any agent.

Or author it yourself: the Skill inspector has an embedded editor and a **+ New skill** button that scaffolds the file — see [Extending](./node-reference.md#extending--tools--skills).

**Gotcha:** a skill should never just wrap a binary call — that's a tool's job, and doing it in a skill is the shim antipattern. Skills teach judgment; tools add capability. If you find yourself describing a single command to run, hand off to the [Tool Builder](#add-a-new-tool).
