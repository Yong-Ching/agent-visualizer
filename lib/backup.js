'use strict';
// Version history for agent and skill files edited through the GUI.
//
// Every save first copies the file's current content into a backup store, outside the
// folders Claude Code loads agents and skills from:
//   <project>/.claude/agents/foo.md     -> <project>/.agent/backups/agents/foo/<stamp>.md
//   ~/.claude/agents/foo.md             -> ~/.agent-visualizer/backups/agents/foo/<stamp>.md
// <project>/.agent/backups/ is git-ignored. Rolling back to a version backs up the
// current content first, so a rollback can itself be undone.

const fs = require('fs');
const os = require('os');
const path = require('path');

const KEEP = 50; // versions kept per file

function within(dir, file) {
  return file === dir || file.startsWith(dir + path.sep);
}

// Where versions of `file` are stored, or null if the file is not under a .claude folder we know.
function storeFor(projectDir, file) {
  const abs = path.resolve(file);
  const proj = path.resolve(projectDir);
  const projClaude = path.join(proj, '.claude');
  const homeClaude = path.join(os.homedir(), '.claude');
  if (within(projClaude, abs)) return { root: path.join(proj, '.agent', 'backups'), key: path.relative(projClaude, abs).replace(/\.md$/i, ''), project: proj };
  if (within(homeClaude, abs)) return { root: path.join(os.homedir(), '.agent-visualizer', 'backups'), key: path.relative(homeClaude, abs).replace(/\.md$/i, '') };
  if (within(proj, abs)) return { root: path.join(proj, '.agent', 'backups'), key: path.join('other', path.relative(proj, abs).replace(/\.md$/i, '')), project: proj };
  return null;
}

function dirFor(projectDir, file) {
  const s = storeFor(projectDir, file);
  if (!s) throw new Error('No backup location for ' + file);
  return { dir: path.join(s.root, s.key), store: s };
}

function stamp(d) {
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '-' + p(d.getMilliseconds(), 3);
}

function ensureIgnored(projectRoot) {
  const gi = path.join(projectRoot, '.agent', '.gitignore');
  let text = '';
  try {
    text = fs.readFileSync(gi, 'utf8');
  } catch (_) {}
  if (/^backups\/?\s*$/m.test(text)) return;
  fs.mkdirSync(path.dirname(gi), { recursive: true });
  fs.writeFileSync(gi, (text && !text.endsWith('\n') ? text + '\n' : text) + 'backups/\n');
}

function list(projectDir, file) {
  const { dir } = dirFor(projectDir, file);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d{8}-\d{6}-\d{3}(-\d+)?\.md$/.test(n));
  } catch (_) {
    return [];
  }
  return names
    .sort()
    .reverse()
    .map((n) => {
      const p = path.join(dir, n);
      const st = fs.statSync(p);
      const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(n);
      const time = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toISOString();
      let reason = '';
      try {
        reason = fs.readFileSync(p + '.why', 'utf8').trim();
      } catch (_) {}
      return { id: n.replace(/\.md$/, ''), time, size: st.size, reason, path: p };
    });
}

function read(projectDir, file, id) {
  if (!/^\d{8}-\d{6}-\d{3}(-\d+)?$/.test(String(id))) throw new Error('Bad version id');
  const { dir } = dirFor(projectDir, file);
  const p = path.join(dir, id + '.md');
  if (!fs.existsSync(p)) throw new Error('Version not found');
  return fs.readFileSync(p, 'utf8');
}

// Saves the current content of `file` as a version (skipped if identical to the latest one).
function backup(projectDir, file, reason) {
  if (!fs.existsSync(file)) return null;
  const content = fs.readFileSync(file, 'utf8');
  const { dir, store } = dirFor(projectDir, file);
  const latest = list(projectDir, file)[0];
  if (latest && fs.readFileSync(latest.path, 'utf8') === content) return latest.id;
  fs.mkdirSync(dir, { recursive: true });
  if (store.project) ensureIgnored(store.project);
  let id = stamp(new Date());
  for (let i = 2; fs.existsSync(path.join(dir, id + '.md')); i++) id = id.replace(/(-\d+)?$/, '') + '-' + i;
  const p = path.join(dir, id + '.md');
  fs.writeFileSync(p, content);
  if (reason) fs.writeFileSync(p + '.why', String(reason).slice(0, 200));
  for (const old of list(projectDir, file).slice(KEEP)) {
    fs.rmSync(old.path, { force: true });
    fs.rmSync(old.path + '.why', { force: true });
  }
  return id;
}

// Writes new content, backing up the current content first.
function save(projectDir, file, content, reason) {
  const id = backup(projectDir, file, reason || 'before edit');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return id;
}

function restore(projectDir, file, id) {
  const content = read(projectDir, file, id);
  save(projectDir, file, content, 'before rollback to ' + id);
  return content;
}

module.exports = { storeFor, list, read, backup, save, restore, KEEP };
