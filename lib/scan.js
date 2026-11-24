'use strict';
// Discovers the agents and skills Claude Code would see for a project:
//   agents: <project>/.claude/agents/**.md, ~/.claude/agents/**.md
//   skills: <project>/.claude/skills/<name>/SKILL.md, ~/.claude/skills/**/<name>/SKILL.md
// and lets the GUI read/edit exactly those files (nothing else).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { MARKER } = require('../public/generator.js');

// Minimal YAML frontmatter parser: scalars, quoted strings, inline [a, b] lists, block "- item" lists.
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  let listKey = null;
  let block = null; // { key, fold, lines } for ">" / "|" block scalars
  const flush = () => {
    if (!block) return;
    data[block.key] = block.fold ? block.lines.join(' ').replace(/\s+/g, ' ').trim() : block.lines.join('\n').trim();
    block = null;
  };
  for (const raw of m[1].split(/\r?\n/)) {
    if (block) {
      if (/^\s+\S/.test(raw) || !raw.trim()) {
        block.lines.push(raw.trim());
        continue;
      }
      flush();
    }
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const bs = /^([A-Za-z_][\w-]*):\s*([>|])[-+]?\s*$/.exec(raw);
    if (bs) {
      listKey = null;
      block = { key: bs[1], fold: bs[2] === '>', lines: [] };
      continue;
    }
    const item = /^\s+-\s+(.*)$/.exec(raw) || /^-\s+(.*)$/.exec(raw);
    if (item && listKey) {
      data[listKey].push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const [, key, val] = kv;
    listKey = null;
    if (val === '') {
      data[key] = [];
      listKey = key;
    } else if (/^\[.*\]$/.test(val.trim())) {
      data[key] = val.trim().slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean);
    } else {
      data[key] = unquote(val.trim());
    }
  }
  flush();
  return { data, body: text.slice(m[0].length) };
}

function unquote(s) {
  s = String(s).trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length > 1) return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (s.startsWith("'") && s.endsWith("'") && s.length > 1) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function list(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function walk(dir, depth, out, test) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) walk(p, depth - 1, out, test);
    else if (e.isFile() && test(e.name)) out.push(p);
  }
  return out;
}

function readAgents(dir, scope) {
  return walk(dir, 3, [], (n) => n.endsWith('.md')).map((file) => {
    const text = fs.readFileSync(file, 'utf8');
    const { data, body } = parseFrontmatter(text);
    return {
      name: data.name || path.basename(file, '.md'),
      description: data.description || '',
      tools: list(data.tools),
      model: data.model || 'inherit',
      skills: list(data.skills),
      color: data.color || '',
      isolation: data.isolation || '',
      body: body.replace(/^<!--[^\n]*-->\s*/, '').trim(),
      path: file,
      scope,
      managed: text.includes(MARKER),
    };
  });
}

function readSkills(dir, scope) {
  return walk(dir, 3, [], (n) => n === 'SKILL.md').map((file) => {
    const text = fs.readFileSync(file, 'utf8');
    const { data } = parseFrontmatter(text);
    return {
      name: data.name || path.basename(path.dirname(file)),
      description: data.description || '',
      path: file,
      scope,
      managed: text.includes(MARKER),
    };
  });
}

function scanLibrary(projectDir) {
  const home = os.homedir();
  const agents = readAgents(path.join(projectDir, '.claude', 'agents'), 'project').concat(readAgents(path.join(home, '.claude', 'agents'), 'user'));
  const skills = readSkills(path.join(projectDir, '.claude', 'skills'), 'project').concat(readSkills(path.join(home, '.claude', 'skills'), 'user'));
  // Project definitions win over user ones with the same name (Claude Code precedence).
  const dedupe = (arr) => {
    const seen = new Set();
    return arr.filter((x) => {
      if (seen.has(x.name)) return false;
      seen.add(x.name);
      return true;
    });
  };
  return {
    agents: dedupe(agents).sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'project' ? -1 : 1)),
    skills: dedupe(skills).sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'project' ? -1 : 1)),
  };
}

// Only files that the scanner reports may be read or written through the API.
function isEditable(projectDir, file) {
  const lib = scanLibrary(projectDir);
  const abs = path.resolve(file);
  return lib.agents.some((a) => a.path === abs) || lib.skills.some((s) => s.path === abs);
}

module.exports = { scanLibrary, parseFrontmatter, isEditable };
