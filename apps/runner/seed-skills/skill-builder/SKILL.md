---
name: skill-builder
description: How to author a progressive-disclosure SKILL.md (+ optional resource .md siblings) that teaches an agent the judgment — when/why/which-flag/workflow — for some capability, and wire it as a `skill` node any Fabritorio agent can load. Use when the request is "teach an agent how to think about X", "write a skill / playbook for X", "give the agent the judgment to do X". NOT for making a binary callable as a gated tool — that's the tool-builder's job; hand off.
---

# skill-builder — turn a capability into a behavioural playbook

You're a coder agent reading this because someone handed you a request shaped like _"write a skill for X"_ — a workflow you want an agent to follow, the judgment for when to reach for one approach over another, the domain context a generic model lacks. The request may come from a human you're chatting with or from a calling agent. Your output is a **skill** on disk: a progressive-disclosure `SKILL.md` (plus optional sibling resource files) that teaches an agent the _judgment_ for the task — not a recipe for invoking a binary.

**Clarify when the spec is underspecified; build when it's sufficient.** If the request leaves out something you genuinely can't default, ask for the missing pieces in your reply — to whoever sent the request — before building. If it's clear, build it and report. (See "What to clarify" below for the exact batch.)

## The ontology boundary — read this before doing anything else

**A skill is a playbook. It teaches judgment; it never wraps a call.**

The one mistake that defeats the purpose: writing a `SKILL.md` whose body is _"to do X, call `mytool` via `bash` like this: `mytool --flag value`."_ That is a **capability shim**, not a skill. It smuggles an ungated, untyped invocation back in through `bash` — exactly the antipattern Fabritorio's runtime-tools design exists to kill. A capability that should be a first-class, permission-gated, typed tool must be **built as a tool**, not narrated in prose an agent then shells out from.

So, before you write a line:

- If the real request is _"make this binary / API callable as a gated tool"_ → **stop and hand off to the tool-builder.** It produces a `manifest.json` + adapter that registers the binary as a runtime tool, selectable from a `tool` node and called natively. Say so in your reply; don't author a shim skill.
- If the real request is _"teach the agent the judgment / workflow / when-why for X"_ → **proceed.** That's a skill.

A binary's `--help` / man page is **source material for judgment** — read it to learn which flags matter for which situations, what the failure modes are, what the sane defaults are. It is **never** a transcribed invocation recipe to paste into the skill. "Use `--depth 1` when you only need the latest commit; full history is rarely worth the bandwidth" is judgment. "Run `git clone --depth 1 <url>`" is a shim.

## Path discipline — write to the right place

**Your workspace root is `~/.fabritorio/` (real path: `/Users/<user>/.fabritorio/`).** Skills live under `skills/<name>/` relative to that root (absolute: `~/.fabritorio/skills/<name>/`). Note the spelling — `~/.fabritorio`, **not** the older `~/.fabtorio`.

Use workspace-relative paths in `write_file` / `edit_file` (e.g. `skills/<name>/SKILL.md`) — those tools do **not** expand `~`, so a leading `~` creates a literal `~` directory inside the workspace, and an absolute `/Users/...` path is rejected by the workspace gate. The `bash` tool expands `~` correctly (real shell), so absolutes are fine there and in the _contents_ of files you write.

## What to clarify

**If the spec is underspecified, don't guess — ask for the missing pieces in your reply, to whoever sent the request** (a human you're chatting with, or the calling agent). A skill built on a guessed capability or a wrong trigger phrase trains the agent to do the wrong thing confidently; a one-line question is cheaper than the rewrite.

Ask in **one batch**, not one question at a time:

1. **Capability + trigger.** What should the agent be able to _do_, and what user phrasings / situations should make it reach for this skill? The trigger phrasings are the raw material for the frontmatter `description` — the recall signal a model reads when deciding whether to load the skill. Vague capability → vague skill nobody loads at the right moment.
2. **Tool-or-skill gate** — _the one genuinely hard question._ Is the capability a gated/typed **invocation** (something that should be called as a tool, with arguments and permissions) → **stop, hand off to the tool-builder**? Or is it **judgment / workflow / when-why knowledge** that no single call captures → **proceed as a skill**? When it's both ("call this API _and_ here's how to think about the results"), the tool is the tool-builder's job and the skill is yours — they compose, you don't fold the invocation into the skill.
3. **Source material.** Where does the judgment come from — a binary's `--help` / man page, an existing README or doc, or the user's head? This decides how the build starts: with an **introspection step** (run `--help`, read the doc, distill) or with **pure elicitation** (interview the human for the tacit knowledge).
4. **Scope / split.** One file, or does it need resources? Default to a single `SKILL.md`. Only design a split when the core would exceed ~200 lines / ~3k tokens — then plan the resource index up front (what gets pulled when).

Reserve clarification for facts you genuinely can't default — not for things this skill already settles (file layout, frontmatter shape, the progressive-disclosure mechanics).

## The output shape

A skill is a directory under `~/.fabritorio/skills/<name>/`:

- **`SKILL.md`** — frontmatter (`name` + a trigger-rich `description`) plus a **lean** body: the mental model, the cardinal rules, the judgment. When the skill is split, the body also carries a **resource index** — a short table of which resource to load when. The core is always-loaded; keep it tight.
- **`<resource>.md` siblings** (optional) — loaded **on demand** by the agent via `Skill({name: "<name>", resource: "<resource>"})`. Each holds detail the core points at but doesn't inline: a long worked example, a reference table, a deep recipe. This is progressive disclosure — the agent pays the token cost of a resource only when it reaches for that specific thing.

**Flat-first is the safe default.** A first version is one `SKILL.md`. Split only when the single file genuinely outgrows the budget above — premature splitting buries the judgment behind indirection.

The frontmatter shape is the same every Fabritorio skill uses:

```yaml
---
name: <name>
description: <trigger-rich one line — the phrasings/situations that should load this>
---
```

The `description` is doing real work: it's the recall trigger. Write it so a model scanning skill descriptions mid-task recognizes _"this is the situation that skill is for."_ Name the capability and the trigger phrasings concretely; don't write "helps with X stuff."

The SkillRegistry rescans on every `GET /skills`, so a freshly written skill (and its resources) is visible to the runtime **without a runner restart** — you can probe it immediately.

## Verify by probe — the proof of a skill

The smoke test for a tool is `--help`. The smoke test for a skill is: **an agent given this skill can do the task.** A skill that reads well but doesn't change behaviour is a failed build.

After writing, **probe it**:

1. Spawn a probe agent via `ask_agent`, wired with the **fresh skill** and a **representative task** — one that exercises the judgment the skill is supposed to carry.
2. Confirm the probe **loads the skill** (and any resource it should, if split) and **completes the task** correctly.
3. If it fails — the agent doesn't load the skill at the right moment, loads it but still does the wrong thing, or can't find a resource — **fold the failure back into a revision** (sharpen the `description` trigger, tighten a rule, fix the resource index) and **re-probe.** Iterate until a cold agent succeeds.

A skill you wrote but never probed is unverified. Report it as such if you couldn't probe, rather than claiming it works.

## What to report back

When your caller is an orchestrator (Foreman or another agent), keep the reply factual and short:

- Skill name (the `name:` frontmatter — what a downstream `skill` node will wire).
- Skill dir path (absolute), and the resource files if you split it.
- One line on the capability the skill teaches and its trigger.
- Probe result — the task you probed with and whether a cold agent completed it; or, if you couldn't probe, say so plainly.

Don't editorialize or restate the brief. Your caller integrates this into a user-facing reply.

If the build failed or you couldn't verify: report it plainly, what you tried, and what's blocking. Don't retry indefinitely — surface the blocker so your caller can redirect or hand back to the user.
