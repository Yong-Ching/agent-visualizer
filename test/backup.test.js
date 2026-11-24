'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const backups = require('../lib/backup');
const { updateAgentText } = require('../lib/agentfile');
const { parseFrontmatter, scanLibrary } = require('../lib/scan');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentviz-bk-'));

const ORIGINAL = `---
name: code-reviewer
# my comment
description: >-
  Reviews diffs for bugs.
  Use after the implementer.
tools: Read, Grep, Glob
model: sonnet
memory: project
skills:
  - tdd
  - lint
---

You are a strict reviewer.
`;

test('updateAgentText changes only the given fields and keeps the rest', () => {
  const out = updateAgentText(ORIGINAL, { description: 'Reviews "diffs".', model: 'opus', skills: ['tdd'], color: 'red' });
  const { data, body } = parseFrontmatter(out);
  assert.strictEqual(data.description, 'Reviews "diffs".');
  assert.strictEqual(data.model, 'opus');
  assert.deepStrictEqual(data.skills, ['tdd']);
  assert.strictEqual(data.color, 'red');
  assert.strictEqual(data.tools, 'Read, Grep, Glob', 'untouched');
  assert.strictEqual(data.memory, 'project', 'unknown keys kept');
  assert.match(out, /# my comment/);
  assert.ok(out.indexOf('name:') < out.indexOf('description:') && out.indexOf('description:') < out.indexOf('memory:'), 'order kept');
  assert.strictEqual(body.trim(), 'You are a strict reviewer.');
});

test('updateAgentText removes keys set to defaults and replaces the body', () => {
  const out = updateAgentText(ORIGINAL, { tools: [], model: 'inherit', skills: [], body: 'New instructions.' });
  const { data, body } = parseFrontmatter(out);
  assert.ok(!('tools' in data) && !('model' in data) && !('skills' in data));
  assert.ok(!/- lint/.test(out));
  assert.strictEqual(body.trim(), 'New instructions.');
  assert.strictEqual(data.description, 'Reviews diffs for bugs. Use after the implementer.');
});

test('saves keep versions outside .claude, git-ignored, and rollback is undoable', () => {
  const dir = tmp();
  const file = path.join(dir, '.claude/agents/code-reviewer.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ORIGINAL);
  backups.save(dir, file, 'v2');
  backups.save(dir, file, 'v2'); // identical content: no extra version beyond the first change
  backups.save(dir, file, 'v3');
  let v = backups.list(dir, file);
  assert.strictEqual(v.length, 2);
  assert.ok(v[0].path.startsWith(path.join(dir, '.agent/backups/agents/code-reviewer') + path.sep));
  assert.match(fs.readFileSync(path.join(dir, '.agent/.gitignore'), 'utf8'), /^backups\/$/m);
  assert.strictEqual(backups.read(dir, file, v[1].id), ORIGINAL);
  assert.strictEqual(scanLibrary(dir).agents.length, 1, 'versions are not picked up as agents');

  backups.restore(dir, file, v[1].id);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), ORIGINAL);
  v = backups.list(dir, file);
  assert.strictEqual(fs.readFileSync(v[0].path, 'utf8'), 'v3', 'content before rollback is kept');
  assert.match(v[0].reason, /rollback/);
  assert.throws(() => backups.read(dir, file, '../../etc/passwd'));
});
