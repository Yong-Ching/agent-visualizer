# Agent Visualizer

A drag-and-drop designer for **multi-agent Claude Code workflows**. You draw your agent team on a canvas (who plans, who builds, who verifies, where the loops are) and describe what each agent does. It then generates everything a fresh Claude Code session needs to run that team on your project.

```
[Manager] → [Task Planner] → [Worker ×per task, worktree] → [Verifier] ─PASS→ [Reviewer] ─PASS→ [Manager]
                                    ↑                           │ FAIL ≤3          │ FAIL ≤2
                                    └───────────────────────────┴──────────────────┘
```

No dependencies. Needs Node 18+ and the `claude` CLI.

## Quick start

```bash
node server.js --project /path/to/your/project --open
# or: npm start   (targets the current directory)
```

Open http://127.0.0.1:4317 if it doesn't open by itself.

1. Pick a template (top bar) or start from a blank canvas.
2. **Drag** roles from the left palette onto the canvas.
3. **Link** agents by dragging from a node's right-hand ● handle onto another node.
4. **Click** a node to write what that agent should do, and to set its model, tools, parallel copies and worktree isolation. Click a link to set its type (handoff / on PASS / on FAIL / report), a condition, and the loop limit.
5. Press **Preview & Generate**, check the files, then **Write to project**.

### AI assists (uses your local `claude` CLI and login, no API key)

- **✨ Design from idea** (top bar): describe what the team should do. Claude proposes the agents, links, loops, parallelism and worktrees, reusing your existing agents and skills when they fit. You review the proposal, then apply it to the canvas (undo restores the old one).
- **✨ Refine with Claude** (on any agent): write a sentence about what the agent does. Claude writes a full agent prompt (mission, method, constraints, quality bar) and suggests tools, model and skills. You see current and suggested side by side, edit, then apply.

Each call is a one-shot `claude -p` with no tools, settings, hooks or MCP servers, run from a temp directory. A refine takes about 10s and a design about 15-30s (roughly $0.02-0.05 with Sonnet). You can switch the model in either dialog.

### Your own agents and skills

- **My agents** (Build tab → + New): create reusable agent types with your own name, color, base role, description, instructions, tools, model and skills. They are saved in the design and in your browser, so you can reuse them across projects. Any node can be saved as one with **Save as custom agent**.
- **Agents tab**: lists the agents Claude Code already sees (`.claude/agents/` and `~/.claude/agents/`). **Edit** opens the file. **Add to canvas** (or drag) uses the agent in the workflow as-is: the playbook references it, and generating never overwrites it. **Make editable copy** turns it into a workflow-managed agent.
- **Skills tab**: lists installed skills (`.claude/skills/`, `~/.claude/skills/`) and the agents equipped with each one, whether on the canvas or in existing agent files. Select an agent to equip or remove skills, or use the Skills field in the inspector. Equipped skills go into the agent's `skills:` frontmatter and are preloaded when it starts.

### Opening a project

When a project has a saved `.agent/workflow.json`, it loads. Otherwise its `.claude/agents` are placed on the canvas as existing agents, and their connections are inferred from the agent descriptions and from `CLAUDE.md`, `AGENTS.md`, commands and skills. Click a link to see the sentence it came from. **✨ Infer connections with Claude** asks Claude instead, and you review the result before it is applied. Agents that are missing from a saved workflow are offered with their connections.

### Editing existing agents, with rollback

Select an existing agent on the canvas to edit its file directly: description, instructions, model, color, tools and skills. **✨ Refine with Claude** fills the form for you to review. **Save to agent file** changes only those fields and keeps everything else in the file (other frontmatter keys, comments, order). **Edit raw file** opens the whole file.

Every save keeps the previous version first:

- project agents and skills: `.agent/backups/<agents|skills>/<name>/<time>.md` (git-ignored)
- user-level ones (`~/.claude/...`): `~/.agent-visualizer/backups/...`

**History & rollback** (in the inspector, the file editor, and the Agents and Skills tabs) lists the versions, shows each one's diff against the current file, and rolls back. A rollback saves the current file as a version too, so it can be undone. The last 50 versions are kept for each file. If a generated agent would replace a hand-written agent of the same name, the original goes into that history as well, and the editor warns you beforehand.

Then start a fresh session in your project:

```bash
cd /path/to/your/project
claude                                # any task you give it now runs through the workflow
.agent/run.sh "add OAuth login"       # or start a run on a task directly
```

Inside a session you can also type `/run-agent-workflow <task>`.

## Building blocks

| Concept | What it does |
|---|---|
| **Orchestrator** | Played by the main Claude Code session (subagents can't spawn agents, so all spawning happens here). It follows the playbook, routes results and writes the final report. Only one is allowed. |
| **Planner / Worker / Verifier / Reviewer / Researcher / Tester / Custom** | Roles with sensible default instructions, tools and output contracts. Your description becomes the agent's core instructions. |
| **Runs as** | *Single*, *N parallel* copies, or *One per task*: one copy per work package from the planner, run in parallel up to *Max parallel*. |
| **Git worktree** | The agent works in its own worktree and branch (`isolation: "worktree"`), so parallel workers never clash. The orchestrator merges branches after they pass verification (you can turn that off). |
| **handoff** link | Output flows to the next agent. Several outgoing handoffs fan out in parallel. Several incoming handoffs join: the step waits for all of them. |
| **on PASS / on FAIL** links | Routed on the source agent's `VERDICT: PASS` / `VERDICT: FAIL` line. FAIL links form verification loops, capped by *max iterations*, after which the orchestrator escalates. |
| **report** link | Results go back up, usually to the orchestrator. |
| **Max rounds** | Caps any other cycle, such as returning to the orchestrator and going around again. |

The editor checks your design as you go: two orchestrators, unreachable agents, loops with no FAIL guard, parallel editors without worktrees, missing descriptions and more.

## What gets generated

| Path | Purpose |
|---|---|
| `.agent/workflow.json` | The design itself. The GUI reloads it from the project. |
| `.agent/WORKFLOW.md` | The playbook the orchestrator follows: mermaid diagram, agent roster, execution protocol, and step-by-step routing with loop guards. |
| `.agent/agents/<name>.md` | One definition per agent (canonical copy). |
| `.agent/skills/run-agent-workflow/SKILL.md` | The skill that starts a run. |
| `.agent/session-context.md` | Injected into every fresh session by the hook below. |
| `.agent/run.sh` | Launcher: `claude "/run-agent-workflow <task>"`. |
| `.claude/agents/<name>.md`, `.claude/skills/run-agent-workflow/` | Mirrors in the places Claude Code discovers agents and skills. |
| `CLAUDE.md` | A marker-delimited managed block. The rest of your file is untouched. |
| `.claude/settings.json` | One `SessionStart` hook (startup/clear) that prints `.agent/session-context.md`. Your other settings and hooks are preserved. |
| `.agent/manifest.json` | Tracks generated files. When you remove an agent from the design and regenerate, its old files are deleted. Files without the generator marker are never deleted. |

During a run the orchestrator keeps a log in `.agent/runs/<time>/` (ignored by git).

Regenerating is idempotent. Edit the design, not the generated files.

## Notes

- **Permissions.** Verifiers and testers need to run commands (tests, builds). In an interactive session Claude Code asks you. For headless runs (`claude -p`), allow the commands they need, for example `--allowedTools "Bash(npm test:*)"`, or they will report that they could not verify.
- **Worktrees** need a git repository with at least one commit. The GUI offers `git init` when the project isn't one.
- **Name clashes.** If you already have user-level agents in `~/.claude/agents` with the same names, set an *Agent name prefix* in the workflow settings.
- Sessions that are already open need a restart to pick up new or changed agents.

## Headless generation

```bash
node server.js --project /path/to/project --generate my-workflow.json
```

## Development

```bash
npm test          # generator + writer tests (node:test)
```

Layout: `server.js` (local HTTP server, 127.0.0.1 only), `lib/writer.js` (safe file writing and merging), `lib/scan.js` (finds existing agents and skills; the file editor can only touch those files), `lib/ai.js` (Claude CLI calls for refine, design and connect), `lib/importer.js` (rebuilds a workflow from existing agents and docs), `lib/agentfile.js` (field-level agent file edits), `lib/backup.js` (version history and rollback), `public/generator.js` (design → files, shared by browser and Node), `public/templates.js`, `public/app.js` (canvas editor).
