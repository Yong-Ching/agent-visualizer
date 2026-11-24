'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../public/generator.js');
const T = require('../public/templates.js');
const { writeProject, mergeClaudeMd, mergeSettings } = require('../lib/writer.js');

const tpl = (id) => JSON.parse(JSON.stringify(T.list.find((t) => t.id === id).design));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentviz-'));

test('every template generates without errors', () => {
  for (const t of T.list.filter((x) => x.id !== 'blank')) {
    const r = G.generate(t.design);
    assert.deepStrictEqual(r.errors, [], t.id);
    assert.ok(r.files['.agent/WORKFLOW.md'].includes('```mermaid'));
  }
});

test('simple pipeline: 3 spawnable agents + orchestrator kept in .agent only', () => {
  const r = G.generate(tpl('simple'));
  const claudeAgents = Object.keys(r.files).filter((p) => p.startsWith('.claude/agents/'));
  assert.deepStrictEqual(claudeAgents.sort(), ['.claude/agents/task-planner.md', '.claude/agents/verifier.md', '.claude/agents/worker.md']);
  assert.ok(r.files['.agent/agents/manager.md']);
  assert.ok(!r.files['.claude/agents/manager.md']);
  const v = r.files['.claude/agents/verifier.md'];
  assert.match(v, /^---\nname: verifier\ndescription: "/);
  assert.match(v, /tools: Read, Grep, Glob, Bash/);
  assert.match(v, /VERDICT: PASS/);
});

test('frontmatter is valid-ish YAML: description is one quoted line', () => {
  const d = tpl('simple');
  d.nodes[1].description = 'Plan "carefully".\nSecond line: with colon';
  const f = G.generate(d).files['.claude/agents/task-planner.md'];
  const fm = f.split('---')[1];
  const desc = fm.split('\n').find((l) => l.startsWith('description:'));
  assert.match(desc, /^description: ".*\\"carefully\\"\..*"$/);
});

test('loop template: worktree + per-task fan-out + loop guards in playbook', () => {
  const r = G.generate(tpl('loop'));
  const w = r.files['.agent/WORKFLOW.md'];
  assert.match(w, /isolation: "worktree"/);
  assert.match(w, /one instance per work package/);
  assert.match(w, /at most \*\*3\*\* attempt/);
  assert.match(w, /at most \*\*2\*\* attempt/);
  assert.match(w, /git merge --no-ff/);
  assert.match(r.files['.claude/agents/implementer.md'], /own git worktree/);
  assert.match(r.files['.claude/agents/code-reviewer.md'], /model: opus/);
});

test('validation: two orchestrators is an error, self-link is an error', () => {
  const d = tpl('simple');
  d.nodes[1].role = 'orchestrator';
  assert.ok(G.validate(d).errors.some((e) => /Only one Orchestrator/.test(e)));
  const d2 = tpl('simple');
  d2.edges.push({ id: 'x', from: 'n2', to: 'n2', kind: 'handoff' });
  assert.ok(G.validate(d2).errors.some((e) => /itself/.test(e)));
  assert.ok(G.generate({ nodes: [], edges: [] }).errors.length);
});

test('validation: unguarded loop and unreachable node are warnings', () => {
  const d = tpl('simple');
  d.edges.push({ id: 'x', from: 'n4', to: 'n3', kind: 'handoff' });
  d.nodes.push({ id: 'n9', role: 'researcher', label: 'Lonely', x: 0, y: 0 });
  const v = G.validate(d);
  assert.ok(v.warnings.some((w) => /Loop without a guard/.test(w)));
  assert.ok(v.warnings.some((w) => /Lonely.*cannot be reached/.test(w)));
});

test('duplicate labels get unique agent names; prefix applies', () => {
  const d = tpl('simple');
  d.nodes[3].label = 'Worker';
  d.settings.namePrefix = 'Web App';
  const n = G.normalize(d).nodes.map((x) => x.name);
  assert.deepStrictEqual(n, ['web-app-manager', 'web-app-task-planner', 'web-app-worker', 'web-app-worker-2']);
});

test('writer: writes files, merges CLAUDE.md and settings, preserves user content', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# My project\n\nKeep me.\n');
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
  const r = writeProject(dir, tpl('loop'));
  assert.ok(r.written.length > 8);
  const md = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.match(md, /Keep me\./);
  assert.match(md, /agent-visualizer:start/);
  const s = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'));
  assert.deepStrictEqual(s.permissions, { allow: ['Bash(ls)'] });
  assert.strictEqual(s.hooks.SessionStart.length, 2);
  assert.ok(fs.statSync(path.join(dir, '.agent/run.sh')).mode & 0o100);
  // Regenerating is idempotent: still one managed block, one hook of ours.
  writeProject(dir, tpl('loop'));
  const md2 = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.strictEqual(md2.split('agent-visualizer:start').length, 2);
  const s2 = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'));
  assert.strictEqual(s2.hooks.SessionStart.length, 2);
});

test('writer: removes agents dropped from the design but never hand-written files', () => {
  const dir = tmp();
  writeProject(dir, tpl('loop'));
  fs.writeFileSync(path.join(dir, '.claude/agents/mine.md'), '---\nname: mine\n---\nhand written');
  const d = tpl('loop');
  d.nodes = d.nodes.filter((n) => n.id !== 'n5');
  d.edges = d.edges.filter((e) => e.from !== 'n5' && e.to !== 'n5');
  const r = writeProject(dir, d);
  assert.ok(r.removed.includes('.claude/agents/code-reviewer.md'));
  assert.ok(!fs.existsSync(path.join(dir, '.claude/agents/code-reviewer.md')));
  assert.ok(fs.existsSync(path.join(dir, '.claude/agents/mine.md')));
});

test('writer: refuses a design with errors', () => {
  assert.throws(() => writeProject(tmp(), { nodes: [], edges: [] }), /errors/);
});

test('hook command prints the session context', () => {
  const dir = tmp();
  writeProject(dir, Object.assign(tpl('simple'), { goal: 'Build a todo app' }));
  const out = require('child_process').execSync(G.HOOK_COMMAND, { env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: dir }), shell: '/bin/sh' }).toString();
  assert.match(out, /orchestrator/);
  assert.match(out, /Build a todo app/);
  const empty = require('child_process').execSync(G.HOOK_COMMAND, { env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: tmp() }), shell: '/bin/sh' }).toString();
  assert.strictEqual(empty, '');
});

test('mergeClaudeMd / mergeSettings handle empty inputs', () => {
  assert.match(mergeClaudeMd('', 'X'), /^<!-- agent-visualizer:start -->\nX\n<!-- agent-visualizer:end -->\n$/);
  const s = mergeSettings(null, { event: 'SessionStart', matcher: 'startup', command: 'cat .agent/session-context.md' });
  assert.strictEqual(s.hooks.SessionStart.length, 1);
});
