'use strict';
// AI helpers backed by the local `claude` CLI (uses the user's existing Claude Code login).
// Each call is a one-shot `claude -p` with no tools, no settings/hooks, no MCP servers,
// and a JSON schema, run from a neutral temp directory so project hooks never fire.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../public/generator.js');

const AI_MODELS = ['sonnet', 'opus', 'haiku', 'fable'];
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

function available() {
  try {
    const v = execFileSync(CLAUDE_BIN, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim();
    return { ok: true, version: v };
  } catch (e) {
    return { ok: false, error: 'The `claude` CLI was not found on PATH. Install Claude Code to use AI features.' };
  }
}

function runClaude({ system, prompt, schema, model, timeoutMs }) {
  const cwd = path.join(os.tmpdir(), 'agentviz-ai');
  fs.mkdirSync(cwd, { recursive: true });
  const args = [
    '-p',
    '--output-format', 'json',
    '--model', AI_MODELS.includes(model) ? model : 'sonnet',
    '--tools', '',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--system-prompt', system,
    '--json-schema', JSON.stringify(schema),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Claude took too long (over ' + Math.round(timeoutMs / 1000) + 's). Try again or pick a faster model.'));
    }, timeoutMs || 240000);
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error('Could not start claude: ' + e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let res;
      try {
        res = JSON.parse(out);
      } catch (_) {
        return reject(new Error('claude exited with code ' + code + ': ' + (err || out).trim().slice(0, 400)));
      }
      if (res.is_error || !res.structured_output) return reject(new Error('Claude returned an error: ' + String(res.result || res.subtype || 'no structured output').slice(0, 400)));
      resolve({ data: res.structured_output, cost: res.total_cost_usd });
    });
    child.stdin.end(prompt);
  });
}

// ------------------------------------------------------------------ shared text

const PLATFORM = `Platform facts (Claude Code):
- Subagents are markdown files with YAML frontmatter (name, description, tools, model, skills) and a system-prompt body.
- The main session is the orchestrator. Subagents cannot spawn other subagents; the orchestrator spawns all of them with the Agent tool and routes results.
- Subagents start with a fresh context: they only know what their prompt says, so instructions must be self-contained.
- Tools available: ${G.ALL_TOOLS.join(', ')}. Grant the least privilege needed: judges (planner, verifier, reviewer, researcher) do not get Edit/Write.
- Models: opus (deepest reasoning, slow, expensive), sonnet (strong default), haiku (fast/cheap for simple lookups), fable, or inherit.
- Skills are reusable instruction packs; listing a skill on an agent preloads it into that agent's context.`;

// ------------------------------------------------------------------ refine

const REFINE_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string', description: 'Short display name, 1-3 words' },
    description: { type: 'string', description: 'One or two sentences: what this agent does and when it is used. Max ~220 chars.' },
    prompt: { type: 'string', description: 'Markdown instructions body for the agent (no frontmatter, no output-contract/VERDICT section, no workflow routing).' },
    tools: { type: 'array', items: { type: 'string', enum: G.ALL_TOOLS } },
    model: { type: 'string', enum: G.MODELS },
    skills: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string', description: 'One or two sentences to the user explaining the main changes.' },
  },
  required: ['label', 'description', 'prompt', 'tools', 'model', 'skills', 'notes'],
};

const REFINE_SYSTEM = `You are an expert at writing Claude Code subagent definitions. The user drafted an agent with a short description; turn it into a precise, effective agent prompt.

${PLATFORM}

Write the "prompt" as the agent's instructions in markdown, in second person ("You ..."). Include, as fits the role:
- Mission: one paragraph, concrete.
- Method: numbered steps the agent follows, specific to its job (what to inspect first, how to decide, how to check its own work).
- Constraints: scope limits, what not to do, when to stop and report a blocker.
- Quality bar: what "done well" means for this agent.
Keep it tight (roughly 150-450 words). Do NOT add an output-format/VERDICT section or describe who it hands off to: the generator appends the workflow position and output contract automatically.
Keep the user's intent; do not invent requirements unrelated to it. Only pick skills from the provided list, and only when clearly relevant. Prefer keeping the current model unless there is a clear reason to change it.`;

async function refine({ node, workflow, skills, model }) {
  const ctx = {
    agent: {
      label: node.label,
      role: node.role,
      roleTitle: (G.ROLES[node.role] || G.ROLES.custom).title,
      roleDefaults: (G.ROLES[node.role] || G.ROLES.custom).guidance,
      description: node.description || '',
      currentPrompt: node.prompt || '',
      tools: node.tools || [],
      model: node.model || 'inherit',
      skills: node.skills || [],
      runsAs: node.perTask ? 'one copy per work package, in parallel' : node.instances > 1 ? node.instances + ' parallel copies' : 'single',
      isolation: node.isolation === 'worktree' ? 'own git worktree' : 'shared checkout',
    },
    workflow: workflow || {},
    availableSkills: (skills || []).map((s) => ({ name: s.name, description: String(s.description || '').slice(0, 200) })),
  };
  const prompt = 'Refine this agent definition.\n\n```json\n' + JSON.stringify(ctx, null, 2) + '\n```';
  const { data, cost } = await runClaude({ system: REFINE_SYSTEM, prompt, schema: REFINE_SCHEMA, model, timeoutMs: 180000 });
  const known = new Set((skills || []).map((s) => s.name));
  data.skills = (data.skills || []).filter((s) => known.has(s));
  data.tools = (data.tools || []).filter((t) => G.ALL_TOOLS.includes(t));
  return { suggestion: data, cost };
}

// ------------------------------------------------------------------ design

const ROLE_KEYS = Object.keys(G.ROLES);

const DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Workflow name, 2-6 words' },
    goal: { type: 'string', description: 'Default task if the idea states a concrete one, else empty string' },
    rationale: { type: 'string', description: '2-4 sentences explaining the design to the user' },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Unique short id, e.g. "plan"' },
          label: { type: 'string' },
          role: { type: 'string', enum: ROLE_KEYS },
          description: { type: 'string', description: 'One or two sentences' },
          prompt: { type: 'string', description: 'Markdown instructions for the agent (no output contract, no routing). Empty for the orchestrator and for existing agents.' },
          model: { type: 'string', enum: G.MODELS },
          tools: { type: 'array', items: { type: 'string', enum: G.ALL_TOOLS } },
          runsAs: { type: 'string', enum: ['single', 'parallel', 'perTask'] },
          instances: { type: 'integer', minimum: 1, maximum: 8 },
          isolation: { type: 'string', enum: ['none', 'worktree'] },
          skills: { type: 'array', items: { type: 'string' } },
          existingAgent: { type: 'string', description: 'Name of an existing agent to reuse as-is, or empty string' },
        },
        required: ['key', 'label', 'role', 'description', 'prompt', 'model', 'tools', 'runsAs', 'instances', 'isolation', 'skills', 'existingAgent'],
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          kind: { type: 'string', enum: Object.keys(G.EDGE_KINDS) },
          condition: { type: 'string' },
          maxIterations: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['from', 'to', 'kind', 'condition', 'maxIterations'],
      },
    },
  },
  required: ['name', 'goal', 'rationale', 'nodes', 'edges'],
};

const DESIGN_SYSTEM = `You are an expert at designing multi-agent workflows for Claude Code. The user describes an idea; design the agent team and how work flows between them.

${PLATFORM}

Building blocks:
- Roles: ${ROLE_KEYS.map((k) => k + ' (' + G.ROLES[k].blurb + ')').join('; ')}.
- Exactly ONE node with role "orchestrator": it is the main session, the entry point, and receives the final results.
- Edge kinds: "handoff" (output flows on; several outgoing handoffs fan out in parallel; several incoming handoffs join), "pass"/"fail" (routed on the source's VERDICT: PASS/FAIL line; a "fail" edge usually loops back to the agent that must fix things and needs maxIterations), "report" (results go back up, normally to the orchestrator).
- runsAs: "single", "parallel" (fixed number of copies = instances), or "perTask" (one copy per planned work package; needs a planner upstream).
- isolation "worktree": the agent edits code in its own git branch; use it for parallel code-editing agents. The orchestrator merges passing branches.

Design principles:
- Use as few agents as the idea needs (typically 3-7). Every agent must have a distinct job; do not add agents for show.
- Add verification where mistakes are costly: an independent verifier/reviewer with a fail loop back to the implementer.
- Make sure every node is reachable from the orchestrator and the flow ends by reporting back to the orchestrator.
- Use parallelism when work splits naturally (parallel research, perTask implementers in worktrees).
- If an existing agent fits a step well, reuse it by setting existingAgent to its exact name (its own definition is then used as-is).
- Only reference skills from the provided list, and only when clearly useful.
- Write a concrete, self-contained "prompt" for every new non-orchestrator agent (roughly 80-250 words): mission, method steps, constraints. No output-format section.
- Use maxIterations 3 for fail edges unless the idea suggests otherwise; for other edges set it to 3 (ignored). Use an empty condition string when no extra condition is needed.`;

async function design({ idea, agents, skills, model }) {
  const ctx = {
    idea,
    existingAgents: (agents || []).filter((a) => !a.managed).map((a) => ({ name: a.name, description: String(a.description || '').slice(0, 200), tools: a.tools })),
    availableSkills: (skills || []).filter((s) => !s.managed).map((s) => ({ name: s.name, description: String(s.description || '').slice(0, 200) })),
  };
  const prompt = 'Design the agent workflow for this idea.\n\n```json\n' + JSON.stringify(ctx, null, 2) + '\n```';
  const { data, cost } = await runClaude({ system: DESIGN_SYSTEM, prompt, schema: DESIGN_SCHEMA, model, timeoutMs: 300000 });
  return { design: toDesign(data, agents || [], skills || []), rationale: data.rationale, cost };
}

// Convert the model's output into an editor design (ids, positions, field names).
function toDesign(data, agents, skills) {
  const knownSkills = new Set(skills.map((s) => s.name));
  const knownAgents = {};
  for (const a of agents) knownAgents[a.name] = a;
  const idOf = {};
  const nodes = [];
  let orchSeen = false;
  (data.nodes || []).forEach((n, i) => {
    let role = ROLE_KEYS.includes(n.role) ? n.role : 'custom';
    if (role === 'orchestrator') {
      if (orchSeen) role = 'custom';
      orchSeen = true;
    }
    const id = 'n' + (i + 1);
    idOf[n.key] = id;
    const ex = n.existingAgent && knownAgents[n.existingAgent] && role !== 'orchestrator' ? knownAgents[n.existingAgent] : null;
    nodes.push({
      id,
      role,
      label: n.label || G.ROLES[role].title,
      name: ex ? ex.name : '',
      source: ex ? 'existing' : 'design',
      description: ex ? ex.description : n.description || '',
      prompt: ex || role === 'orchestrator' ? '' : n.prompt || '',
      model: ex ? (G.MODELS.includes(ex.model) ? ex.model : 'inherit') : G.MODELS.includes(n.model) ? n.model : 'inherit',
      tools: ex ? (ex.tools.length ? ex.tools.filter((t) => G.ALL_TOOLS.includes(t)) : G.ALL_TOOLS.slice()) : (n.tools || []).filter((t) => G.ALL_TOOLS.includes(t)),
      skills: ex ? ex.skills : (n.skills || []).filter((s) => knownSkills.has(s)),
      isolation: role !== 'orchestrator' && n.isolation === 'worktree' ? 'worktree' : 'none',
      perTask: role !== 'orchestrator' && n.runsAs === 'perTask',
      instances: role !== 'orchestrator' && n.runsAs === 'parallel' ? Math.max(2, n.instances || 2) : 1,
      x: 0,
      y: 0,
    });
  });
  const edges = [];
  (data.edges || []).forEach((e, i) => {
    const from = idOf[e.from];
    const to = idOf[e.to];
    if (!from || !to || from === to) return;
    edges.push({ id: 'e' + (i + 1), from, to, kind: G.EDGE_KINDS[e.kind] ? e.kind : 'handoff', condition: e.condition || '', maxIterations: e.maxIterations || 3 });
  });
  return {
    name: data.name || 'Agent workflow',
    goal: data.goal || '',
    settings: { maxParallel: 4, maxRounds: 3, autoStart: true, runLog: true, mergeWorktrees: true, namePrefix: '' },
    nodes,
    edges,
  };
}

// ------------------------------------------------------------------ connect existing agents

const CONNECT_SCHEMA = {
  type: 'object',
  properties: {
    rationale: { type: 'string', description: '1-3 sentences on how these agents work together' },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Agent name, or "@main" for the main session' },
          to: { type: 'string', description: 'Agent name, or "@main" for the main session' },
          kind: { type: 'string', enum: Object.keys(G.EDGE_KINDS) },
          condition: { type: 'string' },
          maxIterations: { type: 'integer', minimum: 1, maximum: 10 },
          reason: { type: 'string', description: 'Short evidence or reason for this link' },
        },
        required: ['from', 'to', 'kind', 'condition', 'maxIterations', 'reason'],
      },
    },
  },
  required: ['rationale', 'edges'],
};

const CONNECT_SYSTEM = `You reverse-engineer how a project's existing Claude Code subagents work together, so the workflow can be drawn as a graph.

${PLATFORM}

You get each agent's definition and the project's orchestration docs (CLAUDE.md, commands, skills). Return the links between them:
- "@main" is the main session (orchestrator). It spawns the first agent(s) and receives the final results.
- Edge kinds: "handoff" (output flows on), "pass"/"fail" (routed on a verdict; a fail edge loops back to whoever must fix it, with maxIterations), "report" (results go back up, usually to "@main").
- Base every link on the texts. When the docs say nothing, infer the most natural flow from the agents' purposes (e.g. planner → implementer → reviewer), and say so in "reason".
- Agents that clearly stand alone (utilities the main session calls ad hoc) get a single "@main" → agent handoff and agent → "@main" report.
- Use exact agent names. Do not invent agents.`;

async function connect({ projectDir, names, model }) {
  const { scanLibrary } = require('./scan');
  const { collectDocs } = require('./importer');
  const lib = scanLibrary(projectDir);
  let agents = lib.agents.filter((a) => a.scope === 'project');
  if (names && names.length) agents = agents.filter((a) => names.includes(a.name));
  if (!agents.length) throw new Error('No project agents to connect');
  let budget = 6000;
  const docs = collectDocs(projectDir, lib).map((d) => {
    const t = d.text.slice(0, Math.max(0, Math.min(3000, budget)));
    budget -= t.length;
    return { file: d.rel, text: t };
  }).filter((d) => d.text);
  const ctx = {
    agents: agents.map((a) => ({ name: a.name, description: a.description, tools: a.tools, definition: a.body.slice(0, 1500) })),
    docs,
  };
  const prompt = 'Work out how these agents connect.\n\n```json\n' + JSON.stringify(ctx, null, 2) + '\n```';
  const { data, cost } = await runClaude({ system: CONNECT_SYSTEM, prompt, schema: CONNECT_SCHEMA, model, timeoutMs: 240000 });
  const valid = new Set(agents.map((a) => a.name).concat('@main'));
  const edges = (data.edges || [])
    .filter((e) => valid.has(e.from) && valid.has(e.to) && e.from !== e.to && G.EDGE_KINDS[e.kind])
    .map((e) => ({ from: e.from, to: e.to, kind: e.kind, condition: e.condition || '', maxIterations: e.maxIterations || 3, evidence: [{ file: 'Claude', text: e.reason || '' }] }));
  return { edges, rationale: data.rationale, cost };
}

module.exports = { available, refine, design, connect, toDesign, runClaude, AI_MODELS };
