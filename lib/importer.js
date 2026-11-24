'use strict';
// Rebuilds the agent graph of a project that has agents but no saved design.
//
// Agents come from <project>/.claude/agents. Connections are inferred from text:
//   - each agent's own definition ("receives the plan from planner", "if tests fail, send back to implementer",
//     "report to code-reviewer", "hand off to verifier"), and
//   - orchestration docs (CLAUDE.md, AGENTS.md, .claude/commands, project skills): arrows ("planner -> worker"),
//     "then"/"next" sentences, and numbered steps that each name an agent.
// Every inferred edge keeps the evidence (file + snippet) so the user can judge it.
// The main session is represented by "@main" (the orchestrator node in the editor).

const fs = require('fs');
const path = require('path');
const G = require('../public/generator.js');
const { scanLibrary } = require('./scan');

const MAIN = '@main';

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Distinctive names (hyphenated or long) match as words; short generic ones ("worker") only in
// unambiguous forms: `worker`, @worker, "worker agent", subagent_type: "worker".
function mentionRegex(name) {
  const e = escRe(name);
  const loose = e.replace(/\\?-|_/g, '[-_ ]');
  if (/[-_]/.test(name) || name.length >= 10) return new RegExp('(?<![A-Za-z0-9_-])' + loose + '(?![A-Za-z0-9_-])', 'gi');
  return new RegExp('`' + e + '`|@' + e + '\\b|\\b' + e + '\\s+(?:sub-?)?agent\\b|subagent_type\\W{0,4}' + e + '\\b|"' + e + '"', 'gi');
}

function findMentions(text, agents) {
  const out = [];
  for (const a of agents) {
    const re = mentionRegex(a.name);
    let m;
    while ((m = re.exec(text))) out.push({ name: a.name, index: m.index, end: m.index + m[0].length });
  }
  out.sort((x, y) => x.index - y.index);
  // Drop overlaps (e.g. "code-reviewer" vs "reviewer").
  const kept = [];
  for (const m of out) if (!kept.length || m.index >= kept[kept.length - 1].end) kept.push(m);
  return kept;
}

function sentences(text) {
  // Split on newlines and sentence ends, but keep list items / arrows on one line intact.
  return text
    .replace(/```[\s\S]*?```/g, (blk) => blk.replace(/\n/g, ' ; '))
    .split(/\n|(?<=[.!?])\s+(?=[A-Z`*])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const CUE = {
  inbound: /\b(receives?|received|from|spawned by|invoked by|called by|triggered by|after|once|output of|results? of|provided by|given by|produced by|written by|handed (?:to you )?by)\b/i,
  fail: /\b(fail(?:s|ed|ure|ing)?|reject(?:s|ed)?|does not pass|doesn't pass|not pass|blocking issues?|issues? (?:are )?found|send(?:s)? (?:it )?back|loop(?:s)? back|re-?run|rework|fix(?:es)? required)\b/i,
  pass: /\b(pass(?:es|ed)?|approve[sd]?|approval|lgtm|succeed(?:s|ed)?|green|all (?:checks|tests) pass)\b/i,
  report: /\b(report(?:s|ing)?|return(?:s|ing)?|repl(?:y|ies)|respond(?:s)?|summari[sz]e(?:s)?|escalate(?:s)?|back to)\b/i,
  flow: /(->|→|=>|\bthen\b|\bnext\b|\bfollowed by\b|\bhand(?:s|ed)? (?:it )?off\b|\bhand(?:s)? (?:it )?to\b|\bpass(?:es)? (?:it|this|the \w+) to\b|\bsend(?:s)? (?:it|this|the \w+) to\b|\bdelegate(?:s)? to\b|\buse (?:the )?\S+ (?:sub-?)?agent\b|\bspawn(?:s)?\b|\binvoke(?:s)?\b|\bpipeline\b|\bflow\b|\bchain\b)/i,
};

function classify(segment) {
  if (CUE.fail.test(segment)) return 'fail';
  if (CUE.pass.test(segment)) return 'pass';
  if (CUE.report.test(segment)) return 'report';
  return 'handoff';
}

function snippet(s) {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 160 ? s.slice(0, 157) + '…' : s;
}

// Edges stated inside agent A's own definition. Each mention is judged by the clause around it:
//   inbound  "use after X", "receives the plan from X", "a fix that X has pinned down"  → X → A
//   outbound "before X", "X applies the fix", "hand it to X", "report back to X"        → A → X
// FAIL/PASS kinds are only used for agents whose output is a verdict (reviewers, verifiers, testers).
const MAIN_RE = /\b(?:the manager|main session|main agent|the orchestrator|chief of staff|the lead agent)\b/gi;
const VERDICT_ROLES = new Set(['reviewer', 'verifier']);
const PRODUCED_BY = /^[^,.;]*?\b(?:has|have|had)\s+(?:\w+\s+)?(?:produced|found|pinned|identified|written|created|flagged|reported|returned|given|made|proposed|approved|rejected)\b|^\s*(?:produced|found|pinned|identified|written|created|flagged|reported|returned|proposed)\b/i;
const SUBJECT_ACTS = /^\s*(?:then\s+)?(?:applies|apply|takes|receives|uses|implements|gets|picks up|continues|fixes|handles|reviews|verifies|checks)\b/i;

function clauseBefore(text) {
  return text.split(/[,;:()]|\s[-–—]\s/).pop();
}

function edgesFromAgent(a, agents, rel) {
  const edges = [];
  const others = agents.filter((x) => x.name !== a.name);
  const aVerdict = VERDICT_ROLES.has(a.role);
  const roleOf = (n) => (agents.find((x) => x.name === n) || {}).role;
  const text = a.description + '\n' + a.body;
  for (const s of sentences(text)) {
    const ev = { file: rel, text: snippet(s) };
    const ms = findMentions(s, others);
    // References to the main session ("the manager's check run").
    let mm;
    MAIN_RE.lastIndex = 0;
    while ((mm = MAIN_RE.exec(s))) ms.push({ name: MAIN, index: mm.index, end: mm.index + mm[0].length });
    ms.sort((x, y) => x.index - y.index);
    for (const m of ms) {
      const before = clauseBefore(s.slice(0, m.index));
      const after = s.slice(m.end);
      const afterClause = after.split(/[.;]/)[0];
      const fromVerdict = m.name !== MAIN && VERDICT_ROLES.has(roleOf(m.name));
      const inbound = /\b(?:after|from|by|once|following|output of|results? of|spawned by|invoked by|called by|triggered by)\s+(?:the\s+|a\s+|an\s+)?$/i.test(before) || /\b(?:receives?|gets?)\b/i.test(before) || PRODUCED_BY.test(after);
      if (inbound) {
        const kind = fromVerdict && /\b(?:fix|finding|reject|fail|issue|blocking)/i.test(s) ? 'fail' : 'handoff';
        edges.push({ from: m.name, to: a.name, kind, evidence: ev, weight: 2 });
        continue;
      }
      if (m.name === MAIN) {
        if (CUE.report.test(before + afterClause)) edges.push({ from: a.name, to: MAIN, kind: 'report', evidence: ev, weight: 2 });
        continue;
      }
      const outbound = /\bbefore\s+(?:the\s+|a\s+|an\s+)?$/i.test(before) || SUBJECT_ACTS.test(after) || /\b(?:to|into|for|with)\s+(?:the\s+|a\s+|an\s+)?$/i.test(before) || CUE.flow.test(s);
      let kind = classify(before + ' ' + afterClause);
      if ((kind === 'fail' || kind === 'pass') && !aVerdict) kind = 'handoff';
      if (kind === 'report') kind = 'handoff'; // "report" is reserved for results going back to the main session
      edges.push({ from: a.name, to: m.name, kind, evidence: ev, weight: outbound || kind !== 'handoff' ? 2 : 1 });
    }
  }
  return edges;
}

// Edges stated in orchestration docs: arrows / "then" chains within a sentence, and numbered steps.
function edgesFromDoc(text, agents, rel) {
  const edges = [];
  const chains = [];
  for (const s of sentences(text)) {
    const ms = findMentions(s, agents);
    if (ms.length < 2 || !CUE.flow.test(s)) continue;
    for (let i = 0; i + 1 < ms.length; i++) {
      if (ms[i].name === ms[i + 1].name) continue;
      const between = s.slice(ms[i].end, ms[i + 1].index);
      const k = classify(between);
      edges.push({ from: ms[i].name, to: ms[i + 1].name, kind: k === 'report' ? 'handoff' : k, evidence: { file: rel, text: snippet(s) }, weight: 3 });
    }
    chains.push(ms.map((m) => m.name));
  }
  // Numbered steps: "1. Use the planner agent ... 2. Run implementer ..." (one agent per step).
  const lines = text.split('\n');
  let block = [];
  const flush = () => {
    const seq = block.map((l) => findMentions(l, agents)[0]).filter(Boolean);
    for (let i = 0; i + 1 < seq.length; i++)
      if (seq[i].name !== seq[i + 1].name) {
        const line = block.find((l) => findMentions(l, agents)[0] === seq[i + 1]) || '';
        edges.push({ from: seq[i].name, to: seq[i + 1].name, kind: CUE.fail.test(line) ? 'fail' : 'handoff', evidence: { file: rel, text: snippet(seq.map((m) => m.name).filter((n, k, arr) => n !== arr[k - 1]).join(' → ') + ' (numbered steps)') }, weight: 3 });
      }
    if (seq.length > 1) chains.push(seq.map((m) => m.name));
    block = [];
  };
  for (const l of lines) {
    // Numbered list items ("1. ...") and numbered table rows ("| 1 | Plan | `planner` | ...").
    if (/^\s*\d+[.)]\s/.test(l) || /^\s*\|\s*\d+\s*\|/.test(l)) block.push(l);
    else if (/^\s*\|[\s|:-]*$/.test(l) || /^\s*\|/.test(l) && !block.length) continue;
    else if (l.trim() && !/^\s{2,}/.test(l)) flush();
  }
  flush();
  return { edges, chains };
}

function collectDocs(projectDir, lib) {
  const docs = [];
  const add = (abs) => {
    try {
      const t = fs.readFileSync(abs, 'utf8');
      if (t.includes(G.MARKER) && !abs.endsWith('CLAUDE.md')) return;
      // Ignore our own managed block in CLAUDE.md; it only lists agent names.
      docs.push({ rel: path.relative(projectDir, abs), text: t.replace(/<!-- agent-visualizer:start -->[\s\S]*?<!-- agent-visualizer:end -->/, '') });
    } catch (_) {}
  };
  for (const f of ['CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md']) add(path.join(projectDir, f));
  const cmdDir = path.join(projectDir, '.claude', 'commands');
  const walk = (d, depth) => {
    let es = [];
    try {
      es = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {}
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth > 0) walk(p, depth - 1);
      else if (e.isFile() && e.name.endsWith('.md')) add(p);
    }
  };
  walk(cmdDir, 2);
  for (const s of lib.skills) if (s.scope === 'project' && !s.managed) add(s.path);
  return docs;
}

function importProject(projectDir) {
  const lib = scanLibrary(projectDir);
  const agents = lib.agents.filter((a) => a.scope === 'project');
  const raw = [];
  const chains = [];
  for (const a of agents) a.role = G.guessRole(a);
  for (const a of agents) raw.push(...edgesFromAgent(a, agents, path.relative(projectDir, a.path)));
  const docs = collectDocs(projectDir, lib);
  for (const d of docs) {
    const r = edgesFromDoc(d.text, agents, d.rel);
    raw.push(...r.edges);
    chains.push(...r.chains);
  }

  // Merge duplicates: one edge per (from,to); the most specific kind with the most evidence wins.
  const rank = { fail: 3, pass: 3, report: 2, handoff: 1 };
  const byPair = {};
  for (const e of raw) {
    const k = e.from + '>' + e.to;
    const cur = byPair[k];
    if (!cur) byPair[k] = { from: e.from, to: e.to, kind: e.kind, weight: e.weight, evidence: [e.evidence] };
    else {
      cur.weight += e.weight;
      if (rank[e.kind] > rank[cur.kind]) cur.kind = e.kind;
      if (cur.evidence.length < 3 && !cur.evidence.some((x) => x.text === e.evidence.text)) cur.evidence.push(e.evidence);
    }
  }
  let edges = Object.values(byPair);
  // Opposite handoffs (A→B and B→A) usually mean "B returns to A": keep the stronger as handoff,
  // turn the weaker into a report (or fail if it was one).
  for (const e of edges) {
    const back = byPair[e.to + '>' + e.from];
    if (back && e.kind === 'handoff' && back.kind === 'handoff' && !e._seen) {
      const weak = e.weight >= back.weight ? back : e;
      weak.kind = 'report';
      e._seen = back._seen = true;
    }
  }
  // Weak single mentions alone are not enough.
  edges = edges.filter((e) => e.weight >= 2);
  // "@main → X" is implied for every agent; keep it only where X has no other upstream agent.
  edges = edges.filter((e) => !(e.from === MAIN && e.kind === 'handoff' && edges.some((o) => o.to === e.to && o.from !== MAIN && o.kind === 'handoff')));

  // The main session drives everything in Claude Code: connect it to the start of each chain
  // and let chain ends report back to it.
  const names = new Set(agents.map((a) => a.name));
  const connected = new Set(edges.flatMap((e) => [e.from, e.to]));
  if (connected.size) {
    const incoming = new Set(edges.filter((e) => e.kind !== 'fail' && e.kind !== 'report').map((e) => e.to));
    const outgoing = new Set(edges.filter((e) => e.kind !== 'fail').map((e) => e.from));
    for (const n of names) {
      if (!connected.has(n)) continue;
      if (!incoming.has(n) && !edges.some((e) => e.from === MAIN && e.to === n)) edges.push({ from: MAIN, to: n, kind: 'handoff', weight: 1, evidence: [{ file: '(Claude Code)', text: 'The main session spawns the first agent of the chain.' }] });
      if (!outgoing.has(n) && !edges.some((e) => e.from === n && e.to === MAIN)) edges.push({ from: n, to: MAIN, kind: 'report', weight: 1, evidence: [{ file: '(Claude Code)', text: 'Subagent results return to the main session.' }] });
    }
  }

  return {
    agents: agents.map((a) => ({
      name: a.name,
      description: a.description,
      role: a.role,
      tools: a.tools,
      model: a.model,
      skills: a.skills,
      color: a.color,
      managed: a.managed,
      path: a.path,
    })),
    edges: edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind, condition: '', maxIterations: 3, evidence: e.evidence })),
    scanned: docs.map((d) => d.rel).concat(agents.map((a) => path.relative(projectDir, a.path))),
  };
}

module.exports = { importProject, collectDocs, mentionRegex, findMentions, edgesFromAgent, edgesFromDoc, MAIN };
