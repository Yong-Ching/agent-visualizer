'use strict';
// Updates the fields of an existing agent file while keeping everything else as written:
// unknown frontmatter keys, comments and key order are preserved; only the keys being
// changed are replaced (including their multi-line values), and the body is replaced only
// when a new one is given.

const FIELD_ORDER = ['name', 'description', 'tools', 'model', 'skills', 'isolation', 'color'];

function yamlString(s) {
  s = String(s).replace(/\r?\n+/g, ' ').trim();
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function renderKey(key, value) {
  if (Array.isArray(value)) {
    if (key === 'tools') return [key + ': ' + value.join(', ')];
    return [key + ':'].concat(value.map((v) => '  - ' + v));
  }
  if (key === 'description') return [key + ': ' + yamlString(value)];
  return [key + ': ' + String(value).trim()];
}

// fields: { description, tools, model, skills, color, isolation, body }.
// A value of null / '' / [] (or model 'inherit') removes the key. undefined leaves it untouched.
function updateAgentText(text, fields) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  if (!m) throw new Error('The agent file has no frontmatter block');
  const lines = m[1].split(/\r?\n/);

  // Find each top-level key's line range [start, end).
  const ranges = {};
  let cur = null;
  lines.forEach((line, i) => {
    const k = /^([A-Za-z_][\w-]*):/.exec(line);
    if (k) {
      if (cur) cur.end = i;
      cur = ranges[k[1]] = { start: i, end: lines.length };
    }
  });

  const remove = (v, key) => v === null || v === '' || (Array.isArray(v) && !v.length) || (key === 'model' && v === 'inherit') || (key === 'isolation' && v === 'none');
  const replace = {}; // start index -> new lines
  const drop = new Set();
  const append = [];
  for (const key of FIELD_ORDER) {
    if (key === 'name' || fields[key] === undefined) continue;
    const v = fields[key];
    const r = ranges[key];
    if (remove(v, key)) {
      if (r) for (let i = r.start; i < r.end; i++) drop.add(i);
      continue;
    }
    const out = renderKey(key, v);
    if (r) {
      replace[r.start] = out;
      for (let i = r.start + 1; i < r.end; i++) drop.add(i);
    } else append.push(...out);
  }

  const next = [];
  lines.forEach((line, i) => {
    if (replace[i]) next.push(...replace[i]);
    else if (!drop.has(i)) next.push(line);
  });
  // Keep trailing blank lines of a dropped multi-line value from piling up.
  while (next.length && !next[next.length - 1].trim()) next.pop();
  next.push(...append);

  let body = text.slice(m[0].length);
  if (typeof fields.body === 'string') {
    const marker = /^(<!--[^\n]*-->\s*\n)/.exec(body); // keep a leading HTML comment (e.g. a generator marker)
    body = (marker ? marker[1] : '\n') + fields.body.replace(/\s+$/, '') + '\n';
  }
  return '---\n' + next.join('\n') + '\n---\n' + body;
}

module.exports = { updateAgentText };
