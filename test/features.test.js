'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../public/generator.js');
const T = require('../public/templates.js');
const { writeProject } = require('../lib/writer.js');
const { parseFrontmatter, scanLibrary, isEditable } = require('../lib/scan.js');
const { toDesign } = require('../lib/ai.js');

const tpl = (id) => JSON.parse(JSON.stringify(T.list.find((t) => t.id === id).design));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentviz-'));

test('frontmatter parser: scalars, quotes, inline + block lists, folded scalars', () => {
  const { data, body } = parseFrontmatter('---\nname: a\ndescription: "say \\"hi\\""\ntools: Read, Grep\nskills:\n  - one\n  - two\nother: [x, \'y\']\nlong: >-\n  folded\n  text\nmodel: opus\n---\nBody here\n');
  assert.strictEqual(data.name, 'a');
  assert.strictEqual(data.description, 'say "hi"');
  assert.strictEqual(data.tools, 'Read, Grep');
  assert.deepStrictEqual(data.skills, ['one', 'two']);
  assert.deepStrictEqual(data.other, ['x', 'y']);
  assert.strictEqual(data.long, 'folded text');
  assert.strictEqual(data.model, 'opus');
  assert.strictEqual(body, 'Body here\n');
});

test('generated agents round-trip through the scanner (skills, tools, isolation, managed)', () => {
  const dir = tmp();
  const d = tpl('loop');
  d.nodes[2].skills = ['tdd', 'repo-conventions'];
  d.nodes[2].prompt = 'You implement things carefully.';
  writeProject(dir, d);
  fs.mkdirSync(path.join(dir, '.claude/skills/tdd'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude/skills/tdd/SKILL.md'), '---\nname: tdd\ndescription: Test-driven development\n---\nWrite tests first.');
  const lib = scanLibrary(dir);
  const impl = lib.agents.find((a) => a.name === 'implementer' && a.scope === 'project');
  assert.ok(impl.managed);
  assert.deepStrictEqual(impl.skills, ['tdd', 'repo-conventions']);
  assert.strictEqual(impl.isolation, 'worktree');
  assert.match(impl.body, /## Instructions\n\nYou implement things carefully\./);
  assert.ok(!/## How to work/.test(impl.body), 'custom prompt replaces role defaults');
  assert.ok(lib.skills.some((s) => s.name === 'tdd' && s.scope === 'project'));
  assert.ok(isEditable(dir, path.join(dir, '.claude/skills/tdd/SKILL.md')));
  assert.ok(!isEditable(dir, path.join(dir, 'CLAUDE.md')));
  assert.ok(!isEditable(dir, '/etc/passwd'));
});

test('existing (linked) agents are referenced in the playbook but never written', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.claude/agents'), { recursive: true });
  const mine = '---\nname: my-reviewer\ndescription: My own reviewer\n---\nHand written.';
  fs.writeFileSync(path.join(dir, '.claude/agents/my-reviewer.md'), mine);
  const d = tpl('simple');
  d.nodes.push({ id: 'x1', role: 'reviewer', label: 'My Reviewer', name: 'my-reviewer', source: 'existing', x: 0, y: 0 });
  d.edges.push({ id: 'ex', from: 'n4', to: 'x1', kind: 'handoff' });
  const r = G.generate(d);
  assert.ok(!Object.keys(r.files).some((p) => p.includes('my-reviewer')));
  assert.match(r.files['.agent/WORKFLOW.md'], /`my-reviewer` \(existing\)/);
  assert.match(r.files['.agent/WORKFLOW.md'], /subagent_type: "my-reviewer"/);
  writeProject(dir, d);
  assert.strictEqual(fs.readFileSync(path.join(dir, '.claude/agents/my-reviewer.md'), 'utf8'), mine);
});

test('existing agent names are kept exactly and win name collisions', () => {
  const d = tpl('simple');
  d.nodes.push({ id: 'x1', role: 'worker', label: 'Ext', name: 'worker', source: 'existing', x: 0, y: 0 });
  const names = G.normalize(d).nodes.map((n) => n.name);
  assert.ok(names.includes('worker'));
  assert.ok(names.includes('worker-2'), 'the designed worker is renamed, not the existing one');
  d.nodes.push({ id: 'x2', role: 'worker', label: 'Ext2', name: 'worker', source: 'existing', x: 0, y: 0 });
  assert.ok(G.validate(d).errors.some((e) => /twice/.test(e)));
});

test('writer backs up a hand-written agent before replacing it', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.claude/agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude/agents/worker.md'), '---\nname: worker\n---\nmine');
  const r = writeProject(dir, tpl('simple'));
  assert.deepStrictEqual(r.backedUp, ['.claude/agents/worker.md']);
  const versions = require('../lib/backup').list(dir, path.join(dir, '.claude/agents/worker.md'));
  assert.strictEqual(versions.length, 1);
  assert.match(fs.readFileSync(versions[0].path, 'utf8'), /mine/);
  assert.ok(!fs.existsSync(path.join(dir, '.claude/agents/worker.md.bak')), 'no .bak next to the agents');
  assert.deepStrictEqual(writeProject(dir, tpl('simple')).backedUp, [], 'second run: file is now managed');
});

test('custom color and library survive normalization', () => {
  const d = tpl('simple');
  d.nodes[2].color = 'cyan';
  d.library = [{ id: 'c1', label: 'API Designer', role: 'custom' }];
  const r = G.generate(d);
  assert.match(r.files['.claude/agents/worker.md'], /color: cyan/);
  assert.strictEqual(JSON.parse(r.files['.agent/workflow.json']).library[0].label, 'API Designer');
});

test('toDesign converts model output into a valid editor design', () => {
  const out = {
    name: 'Docs team',
    goal: '',
    rationale: 'x',
    nodes: [
      { key: 'lead', label: 'Lead', role: 'orchestrator', description: 'd', prompt: 'ignored', model: 'inherit', tools: [], runsAs: 'single', instances: 1, isolation: 'worktree', skills: [], existingAgent: '' },
      { key: 'w', label: 'Writer', role: 'worker', description: 'd', prompt: 'p', model: 'sonnet', tools: ['Read', 'Write', 'Bogus'], runsAs: 'perTask', instances: 1, isolation: 'worktree', skills: ['tdd', 'nope'], existingAgent: '' },
      { key: 'r', label: 'Rev', role: 'reviewer', description: 'd', prompt: 'p', model: 'opus', tools: ['Read'], runsAs: 'single', instances: 1, isolation: 'none', skills: [], existingAgent: 'my-reviewer' },
      { key: 'x', label: 'Second boss', role: 'orchestrator', description: 'd', prompt: '', model: 'inherit', tools: [], runsAs: 'single', instances: 1, isolation: 'none', skills: [], existingAgent: '' },
    ],
    edges: [
      { from: 'lead', to: 'w', kind: 'handoff', condition: '', maxIterations: 3 },
      { from: 'w', to: 'r', kind: 'handoff', condition: '', maxIterations: 3 },
      { from: 'r', to: 'w', kind: 'fail', condition: '', maxIterations: 2 },
      { from: 'r', to: 'lead', kind: 'pass', condition: '', maxIterations: 3 },
      { from: 'r', to: 'ghost', kind: 'pass', condition: '', maxIterations: 3 },
    ],
  };
  const d = toDesign(out, [{ name: 'my-reviewer', description: 'mine', tools: [], model: 'inherit', skills: [] }], [{ name: 'tdd' }]);
  assert.strictEqual(d.nodes[0].isolation, 'none', 'orchestrator never isolated');
  assert.deepStrictEqual(d.nodes[1].tools, ['Read', 'Write']);
  assert.deepStrictEqual(d.nodes[1].skills, ['tdd']);
  assert.ok(d.nodes[1].perTask);
  assert.strictEqual(d.nodes[2].source, 'existing');
  assert.strictEqual(d.nodes[2].name, 'my-reviewer');
  assert.strictEqual(d.nodes[3].role, 'custom', 'only one orchestrator survives');
  assert.strictEqual(d.edges.length, 4, 'edge to unknown key dropped');
  assert.deepStrictEqual(G.validate(d).errors, []);
});
