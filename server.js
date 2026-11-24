#!/usr/bin/env node
'use strict';
// Agent Visualizer: local server for the workflow designer GUI.
//
//   node server.js [--project <dir>] [--port 4317]        start the GUI
//   node server.js --project <dir> --generate <file.json>  generate without the GUI
//
// Listens on 127.0.0.1 only. No dependencies.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const { writeProject } = require('./lib/writer');
const { scanLibrary, isEditable } = require('./lib/scan');
const ai = require('./lib/ai');
const { importProject } = require('./lib/importer');
const backups = require('./lib/backup');
const { updateAgentText } = require('./lib/agentfile');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

let projectDir = path.resolve(arg('project', process.env.AGENT_PROJECT || process.cwd()));
const port = parseInt(arg('port', process.env.PORT || '4317'), 10);
const PUBLIC = path.join(__dirname, 'public');

if (process.argv.includes('--generate')) {
  const file = arg('generate');
  try {
    const design = JSON.parse(fs.readFileSync(file, 'utf8'));
    const r = writeProject(projectDir, design);
    console.log('Wrote to ' + r.projectDir + ':\n  ' + r.written.join('\n  '));
    if (r.removed.length) console.log('Removed stale:\n  ' + r.removed.join('\n  '));
    if (r.warnings.length) console.log('Warnings:\n  - ' + r.warnings.join('\n  - '));
    process.exit(0);
  } catch (e) {
    console.error('Generation failed: ' + e.message + (e.details ? '\n  - ' + e.details.join('\n  - ') : ''));
    process.exit(1);
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5e6) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

function projectInfo() {
  const exists = fs.existsSync(projectDir) && fs.statSync(projectDir).isDirectory();
  let git = false;
  let commits = false;
  if (exists) {
    try {
      execFileSync('git', ['-C', projectDir, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
      git = true;
      execFileSync('git', ['-C', projectDir, 'rev-parse', 'HEAD'], { stdio: 'ignore' });
      commits = true;
    } catch (_) {}
  }
  const designPath = path.join(projectDir, '.agent', 'workflow.json');
  return { projectDir, exists, git, commits, hasDesign: exists && fs.existsSync(designPath) };
}

function isLocalRequest(req) {
  // Basic CSRF / DNS-rebinding guard: only accept requests addressed to localhost.
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return false;
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) return false;
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!isLocalRequest(req)) return send(res, 403, { error: 'Forbidden' });
  try {
    if (url.pathname === '/api/info' && req.method === 'GET') return send(res, 200, projectInfo());

    if (url.pathname === '/api/project' && req.method === 'POST') {
      const body = await readBody(req);
      const dir = path.resolve(String(body.dir || '').replace(/^~(?=$|\/)/, require('os').homedir()));
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return send(res, 400, { error: 'Not a directory: ' + dir });
      projectDir = dir;
      return send(res, 200, projectInfo());
    }

    if (url.pathname === '/api/design' && req.method === 'GET') {
      const p = path.join(projectDir, '.agent', 'workflow.json');
      if (!fs.existsSync(p)) return send(res, 404, { error: 'No design saved in this project yet' });
      return send(res, 200, fs.readFileSync(p, 'utf8'));
    }

    if (url.pathname === '/api/generate' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        return send(res, 200, writeProject(projectDir, body.design));
      } catch (e) {
        return send(res, 400, { error: e.message, details: e.details || [] });
      }
    }

    if (url.pathname === '/api/library' && req.method === 'GET') return send(res, 200, scanLibrary(projectDir));

    if (url.pathname === '/api/file' && req.method === 'GET') {
      const file = path.resolve(url.searchParams.get('path') || '');
      if (!isEditable(projectDir, file)) return send(res, 403, { error: 'Only agent and skill files can be opened here' });
      return send(res, 200, { path: file, content: fs.readFileSync(file, 'utf8') });
    }

    if (url.pathname === '/api/file' && req.method === 'POST') {
      const body = await readBody(req);
      const file = path.resolve(String(body.path || ''));
      if (!isEditable(projectDir, file)) return send(res, 403, { error: 'Only agent and skill files can be edited here' });
      if (typeof body.content !== 'string' || !/^---\r?\n[\s\S]*?\r?\n---/.test(body.content)) return send(res, 400, { error: 'The file must start with a YAML frontmatter block (--- ... ---)' });
      backups.save(projectDir, file, body.content, 'before edit in file editor');
      return send(res, 200, scanLibrary(projectDir));
    }

    // Structured edit of an existing agent: only the given fields change, the rest of the file is kept.
    if (url.pathname === '/api/agent' && req.method === 'POST') {
      const body = await readBody(req);
      const file = path.resolve(String(body.path || ''));
      if (!isEditable(projectDir, file) || !scanLibrary(projectDir).agents.some((a) => a.path === file)) return send(res, 403, { error: 'Only agent files can be edited here' });
      const f = body.fields || {};
      const fields = {};
      if (typeof f.description === 'string') fields.description = f.description;
      if (typeof f.body === 'string') fields.body = f.body;
      if (typeof f.model === 'string') fields.model = /^[\w.-]+$/.test(f.model) ? f.model : 'inherit';
      if (typeof f.color === 'string') fields.color = /^[a-z]*$/.test(f.color) ? f.color : '';
      if (Array.isArray(f.tools)) fields.tools = f.tools.map(String).filter((t) => /^[\w()*:.\/ -]+$/.test(t));
      if (Array.isArray(f.skills)) fields.skills = f.skills.map(String).filter((t) => /^[\w:.-]+$/.test(t));
      const next = updateAgentText(fs.readFileSync(file, 'utf8'), fields);
      backups.save(projectDir, file, next, 'before edit in inspector');
      return send(res, 200, scanLibrary(projectDir));
    }

    if (url.pathname === '/api/history' && req.method === 'GET') {
      const file = path.resolve(url.searchParams.get('path') || '');
      if (!isEditable(projectDir, file)) return send(res, 403, { error: 'Only agent and skill files have a history here' });
      const id = url.searchParams.get('id');
      if (id) return send(res, 200, { id, content: backups.read(projectDir, file, id) });
      const store = backups.storeFor(projectDir, file);
      return send(res, 200, { versions: backups.list(projectDir, file).map(({ id, time, size, reason }) => ({ id, time, size, reason })), dir: store && path.join(store.root, store.key) });
    }

    if (url.pathname === '/api/history/restore' && req.method === 'POST') {
      const body = await readBody(req);
      const file = path.resolve(String(body.path || ''));
      if (!isEditable(projectDir, file)) return send(res, 403, { error: 'Only agent and skill files can be rolled back here' });
      backups.restore(projectDir, file, String(body.id || ''));
      return send(res, 200, scanLibrary(projectDir));
    }

    if (url.pathname === '/api/import' && req.method === 'GET') return send(res, 200, importProject(projectDir));

    if (url.pathname === '/api/ai/connect' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        return send(res, 200, await ai.connect({ projectDir, names: Array.isArray(body.names) ? body.names : null, model: body.model }));
      } catch (e) {
        return send(res, 502, { error: e.message });
      }
    }

    if (url.pathname === '/api/ai/status' && req.method === 'GET') return send(res, 200, ai.available());

    if (url.pathname === '/api/ai/refine' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.node) return send(res, 400, { error: 'Missing node' });
      try {
        return send(res, 200, await ai.refine({ node: body.node, workflow: body.workflow, skills: scanLibrary(projectDir).skills, model: body.model }));
      } catch (e) {
        return send(res, 502, { error: e.message });
      }
    }

    if (url.pathname === '/api/ai/design' && req.method === 'POST') {
      const body = await readBody(req);
      const idea = String(body.idea || '').trim();
      if (idea.length < 10) return send(res, 400, { error: 'Describe the idea in a sentence or two' });
      try {
        const lib = scanLibrary(projectDir);
        const useLib = body.useLibrary !== false;
        return send(res, 200, await ai.design({ idea, agents: useLib ? lib.agents : [], skills: useLib ? lib.skills : [], model: body.model }));
      } catch (e) {
        return send(res, 502, { error: e.message });
      }
    }

    if (url.pathname === '/api/git-init' && req.method === 'POST') {
      execFileSync('git', ['-C', projectDir, 'init'], { stdio: 'ignore' });
      return send(res, 200, projectInfo());
    }

    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

server.listen(port, '127.0.0.1', () => {
  const link = 'http://127.0.0.1:' + port;
  console.log('Agent Visualizer running at ' + link);
  console.log('Target project: ' + projectDir);
  if (process.argv.includes('--open')) execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [link], () => {});
});
