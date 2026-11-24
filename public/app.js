/* Agent Visualizer: canvas editor. Vanilla JS, no build step. */
(function () {
  'use strict';
  const G = window.AgentGen;
  const T = window.AgentTemplates;
  const $ = (s, el) => (el || document).querySelector(s);
  const STORE_BASE = 'agentviz.design.v1';
  const storeKey = () => STORE_BASE + (server ? ':' + server.projectDir : '');
  const NODE_W = 232;

  const ROLE_COLORS = { purple: '--purple', blue: '--blue', green: '--green', orange: '--orange', pink: '--pink', cyan: '--cyan', yellow: '--yellow', red: '--red' };
  const roleColor = (role) => 'var(' + ROLE_COLORS[(G.ROLES[role] || G.ROLES.custom).color] + ')';
  const nodeColor = (n) => (n.color && ROLE_COLORS[n.color] ? 'var(' + ROLE_COLORS[n.color] + ')' : roleColor(n.role));
  const CUSTOM_KEY = 'agentviz.customAgents.v1';
  const AI_MODEL_KEY = 'agentviz.aiModel';

  let library = { agents: [], skills: [] }; // existing agents/skills found on disk
  let aiStatus = { ok: false, error: 'Local server not running' };

  function libAgent(name) {
    return library.agents.find((a) => a.name === name);
  }
  function aiModel() {
    return localStorage.getItem(AI_MODEL_KEY) || 'sonnet';
  }

  // Validation from the generator plus checks that need the on-disk library.
  function fullValidate() {
    const v = G.validate(design);
    if (!server) return v;
    const skillNames = new Set(library.skills.map((s) => s.name));
    const names = {};
    G.normalize(design).nodes.forEach((n) => (names[n.id] = n.name));
    for (const n of design.nodes) {
      for (const s of n.skills || []) if (!skillNames.has(s)) v.warnings.push('"' + n.label + '" lists skill "' + s + '", which is not installed in this project or your user skills.');
      if (n.source === 'existing' && !libAgent(n.name)) v.warnings.push('"' + n.label + '" is linked to agent "' + n.name + '", which no longer exists on disk.');
      const clash = n.source !== 'existing' && n.role !== 'orchestrator' && libAgent(names[n.id]);
      if (clash && !clash.managed && clash.scope === 'project')
        v.warnings.push('"' + n.label + '" will be written as .claude/agents/' + names[n.id] + '.md, replacing your existing agent of that name (the old version stays in its History). Rename it or link the existing agent instead.');
      if (clash && clash.scope === 'user') v.warnings.push('"' + n.label + '" has the same name as your user-level agent "' + clash.name + '"; the project version will take precedence. Set a name prefix to avoid this.');
    }
    return v;
  }

  // ------------------------------------------------------------------ state
  let design = null;
  let selection = null; // {type:'node'|'edge', id}
  let view = { x: 40, y: 40, k: 1 };
  let undoStack = [];
  let redoStack = [];
  let server = null; // /api/info result, or null when opened without the server
  const sizes = {}; // node id -> {w,h}

  const canvas = $('#canvas');
  const world = $('#world');
  const nodeLayer = $('#node-layer');
  const edgeLayer = $('#edge-layer');
  const tempEdge = $('#temp-edge');

  function uid(p) {
    return p + Math.random().toString(36).slice(2, 8);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }
  function node(id) {
    return design.nodes.find((n) => n.id === id);
  }
  function edge(id) {
    return design.edges.find((e) => e.id === id);
  }

  // --------------------------------------------------------------- history
  function snapshot() {
    undoStack.push(JSON.stringify(design));
    if (undoStack.length > 200) undoStack.shift();
    redoStack = [];
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(design));
    design = JSON.parse(undoStack.pop());
    afterLoad(false);
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(design));
    design = JSON.parse(redoStack.pop());
    afterLoad(false);
  }

  let saveTimer = null;
  function changed() {
    renderCanvas();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(storeKey(), JSON.stringify(design));
      } catch (_) {}
      updateStatus();
      renderLibrary();
    }, 150);
  }

  function afterLoad(resetView) {
    if (selection && !(selection.type === 'node' ? node(selection.id) : edge(selection.id))) selection = null;
    $('#wf-name').value = design.name || '';
    renderCanvas();
    renderInspector();
    updateStatus();
    if (resetView) requestAnimationFrame(fit);
    if (document.getElementById('custom-list')) renderCustomList();
    renderLibrary();
    try {
      localStorage.setItem(storeKey(), JSON.stringify(design));
    } catch (_) {}
  }

  function loadDesign(d, resetView) {
    design = clone(d);
    design.settings = Object.assign({ maxParallel: 4, maxRounds: 3, autoStart: true, runLog: true, mergeWorktrees: true, namePrefix: '' }, design.settings || {});
    design.nodes = design.nodes || [];
    design.edges = design.edges || [];
    design.library = design.library || [];
    for (const n of design.nodes) {
      if (typeof n.x !== 'number') n.x = 0;
      if (typeof n.y !== 'number') n.y = 0;
      if (!n.id) n.id = uid('n');
    }
    for (const e of design.edges) if (!e.id) e.id = uid('e');
    selection = null;
    afterLoad(resetView);
  }

  // ------------------------------------------------------------------ view
  function applyView() {
    world.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.k + ')';
    $('#zoom-label').textContent = Math.round(view.k * 100) + '%';
  }
  function toWorld(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k };
  }
  function zoomAt(k, cx, cy) {
    k = Math.max(0.25, Math.min(2, k));
    const r = canvas.getBoundingClientRect();
    const px = cx - r.left;
    const py = cy - r.top;
    view.x = px - ((px - view.x) / view.k) * k;
    view.y = py - ((py - view.y) / view.k) * k;
    view.k = k;
    applyView();
  }
  function fit() {
    if (!design.nodes.length) {
      view = { x: 40, y: 40, k: 1 };
      return applyView();
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of design.nodes) {
      const s = sizes[n.id] || { w: NODE_W, h: 130 };
      x0 = Math.min(x0, n.x);
      y0 = Math.min(y0, n.y - 90);
      x1 = Math.max(x1, n.x + s.w);
      y1 = Math.max(y1, n.y + s.h + 110);
    }
    const r = canvas.getBoundingClientRect();
    const k = Math.max(0.3, Math.min(1.1, Math.min((r.width - 60) / (x1 - x0), (r.height - 60) / (y1 - y0))));
    view.k = k;
    view.x = (r.width - (x1 - x0) * k) / 2 - x0 * k;
    view.y = (r.height - (y1 - y0) * k) / 2 - y0 * k;
    applyView();
  }

  // --------------------------------------------------------------- palette
  function renderPalette() {
    const list = $('#palette-list');
    list.innerHTML = '';
    for (const [role, r] of Object.entries(G.ROLES)) {
      const el = document.createElement('div');
      el.className = 'pal-item';
      el.draggable = true;
      el.dataset.role = role;
      el.style.setProperty('--c', roleColor(role));
      el.innerHTML = '<span class="dot"></span><b>' + esc(r.title) + '</b><small>' + esc(r.blurb) + '</small>';
      el.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('application/x-agent-role', role);
        ev.dataTransfer.setData('text/plain', role);
        ev.dataTransfer.effectAllowed = 'copy';
      });
      el.addEventListener('dblclick', () => {
        const r2 = canvas.getBoundingClientRect();
        addNode(role, toWorld(r2.left + r2.width / 2, r2.top + r2.height / 2));
      });
      list.appendChild(el);
    }
    const sel = $('#tpl-select');
    for (const t of T.list) {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = t.title + ' (' + t.desc + ')';
      sel.appendChild(o);
    }
  }

  function addNode(role, pt, preset) {
    snapshot();
    const r = G.ROLES[role];
    const sameRole = design.nodes.filter((n) => n.role === role).length;
    const n = {
      id: uid('n'),
      role,
      label: role === 'orchestrator' && design.nodes.some((x) => x.role === 'orchestrator') ? 'Orchestrator 2' : r.title + (sameRole ? ' ' + (sameRole + 1) : ''),
      name: '',
      description: '',
      model: 'inherit',
      tools: r.tools.slice(),
      isolation: 'none',
      instances: 1,
      perTask: false,
      x: Math.round(pt.x - NODE_W / 2),
      y: Math.round(pt.y - 40),
      skills: [],
    };
    if (preset) Object.assign(n, preset);
    design.nodes.push(n);
    selection = { type: 'node', id: n.id };
    changed();
    renderInspector();
    setTimeout(() => {
      const f = $('#f-desc');
      if (f) f.focus();
    }, 30);
  }

  // ---------------------------------------------------------------- render
  function normalizedNames() {
    const map = {};
    const norm = G.normalize(design);
    norm.nodes.forEach((n) => (map[n.id] = n.name));
    return map;
  }

  function renderCanvas() {
    $('#empty-hint').hidden = design.nodes.length > 0;
    const names = normalizedNames();
    const existing = {};
    for (const el of nodeLayer.children) existing[el.dataset.id] = el;
    for (const n of design.nodes) {
      let el = existing[n.id];
      delete existing[n.id];
      if (!el) {
        el = document.createElement('div');
        el.className = 'node';
        el.dataset.id = n.id;
        nodeLayer.appendChild(el);
      }
      const r = G.ROLES[n.role] || G.ROLES.custom;
      el.style.setProperty('--c', nodeColor(n));
      el.style.left = n.x + 'px';
      el.style.top = n.y + 'px';
      el.classList.toggle('selected', !!selection && selection.type === 'node' && selection.id === n.id);
      const badges = [];
      if (n.role === 'orchestrator') badges.push('<span class="badge main">main session</span>');
      if (n.perTask) badges.push('<span class="badge fan">× per task</span>');
      else if (n.instances > 1) badges.push('<span class="badge fan">× ' + n.instances + ' parallel</span>');
      if (n.isolation === 'worktree' && n.role !== 'orchestrator') badges.push('<span class="badge wt">worktree</span>');
      if (n.source === 'existing') badges.push('<span class="badge ex">existing agent</span>');
      if (n.prompt && n.source !== 'existing') badges.push('<span class="badge ai">custom prompt</span>');
      if (n.skills && n.skills.length) badges.push('<span class="badge sk" title="' + esc(n.skills.join(', ')) + '">⚡ ' + (n.skills.length === 1 ? esc(n.skills[0]) : n.skills.length + ' skills') + '</span>');
      if (n.model && n.model !== 'inherit') badges.push('<span class="badge">' + esc(n.model) + '</span>');
      const ro = n.tools && !n.tools.some((t) => t === 'Edit' || t === 'Write');
      if (ro) badges.push('<span class="badge">read-only</span>');
      const html =
        '<div class="node-head"><span class="dot"></span><span class="node-title">' + esc(n.label) + '</span><span class="role-badge">' + esc(r.title) + '</span></div>' +
        '<div class="node-name">' + esc(n.role === 'orchestrator' ? 'main session' : names[n.id]) + '</div>' +
        '<div class="node-desc' + (n.description ? '' : ' empty') + '">' + esc(n.description || 'No description yet. Click to describe what this agent does.') + '</div>' +
        '<div class="node-badges">' + badges.join('') + '</div>' +
        '<div class="port in" title="Input"></div><div class="port out" title="Drag to link"></div>';
      if (el._html !== html) {
        el.innerHTML = html;
        el._html = html;
      }
    }
    for (const id in existing) existing[id].remove();
    for (const el of nodeLayer.children) sizes[el.dataset.id] = { w: el.offsetWidth, h: el.offsetHeight };
    renderEdges();
  }

  function anchor(n, side) {
    const s = sizes[n.id] || { w: NODE_W, h: 120 };
    return side === 'out' ? { x: n.x + s.w, y: n.y + s.h / 2 } : { x: n.x, y: n.y + s.h / 2 };
  }

  function edgeGeometry(e, index) {
    const a = node(e.from);
    const b = node(e.to);
    const p = anchor(a, 'out');
    const q = anchor(b, 'in');
    const sa = sizes[a.id] || { h: 120 };
    const sb = sizes[b.id] || { h: 120 };
    if (q.x - p.x > 40) {
      const dx = Math.max(50, (q.x - p.x) / 2);
      const c1 = { x: p.x + dx, y: p.y };
      const c2 = { x: q.x - dx, y: q.y };
      const mid = { x: (p.x + 3 * c1.x + 3 * c2.x + q.x) / 8, y: (p.y + 3 * c1.y + 3 * c2.y + q.y) / 8 };
      return { d: 'M' + p.x + ',' + p.y + ' C' + c1.x + ',' + c1.y + ' ' + c2.x + ',' + c2.y + ' ' + q.x + ',' + q.y, mid };
    }
    // Backward link: route around, below for FAIL/handoff loops, above for reports.
    const above = e.kind === 'report' || e.kind === 'pass';
    const off = 46 + index * 26;
    const ly = above ? Math.min(a.y, b.y) - off : Math.max(a.y + sa.h, b.y + sb.h) + off;
    const mx = (p.x + q.x) / 2;
    const d =
      'M' + p.x + ',' + p.y +
      ' C' + (p.x + 70) + ',' + p.y + ' ' + (p.x + 70) + ',' + ly + ' ' + (p.x - 10) + ',' + ly +
      ' L' + (q.x + 10) + ',' + ly +
      ' C' + (q.x - 70) + ',' + ly + ' ' + (q.x - 70) + ',' + q.y + ' ' + q.x + ',' + q.y;
    return { d, mid: { x: mx, y: ly } };
  }

  function edgeText(e) {
    if (e.kind === 'fail') return 'FAIL ≤' + (e.maxIterations || 3) + (e.condition ? ' · ' + e.condition : '');
    if (e.kind === 'pass') return 'PASS' + (e.condition ? ' · ' + e.condition : '');
    if (e.kind === 'report') return 'report' + (e.condition ? ' · ' + e.condition : '');
    return e.condition || '';
  }

  function renderMarkers() {
    const defs = $('#markers');
    defs.innerHTML = ['handoff', 'pass', 'fail', 'report', 'temp']
      .map((k) => {
        const color = k === 'temp' ? 'var(--accent)' : 'var(--e-' + k + ')';
        return '<marker id="arrow-' + k + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill:' + color + '"/></marker>';
      })
      .join('');
    tempEdge.setAttribute('marker-end', 'url(#arrow-temp)');
  }

  function renderEdges() {
    const ns = 'http://www.w3.org/2000/svg';
    edgeLayer.innerHTML = '';
    const backCount = {};
    for (const e of design.edges) {
      const a = node(e.from);
      const b = node(e.to);
      if (!a || !b) continue;
      const backward = anchor(b, 'in').x - anchor(a, 'out').x <= 40;
      let idx = 0;
      if (backward) {
        const key = (e.kind === 'report' || e.kind === 'pass' ? 'up' : 'down') + ':' + Math.round(Math.min(a.x, b.x) / 50);
        idx = backCount[key] = (backCount[key] === undefined ? 0 : backCount[key] + 1);
      }
      const geo = edgeGeometry(e, idx);
      const g = document.createElementNS(ns, 'g');
      g.setAttribute('class', 'edge ' + e.kind + (selection && selection.type === 'edge' && selection.id === e.id ? ' selected' : ''));
      g.dataset.id = e.id;
      const hit = document.createElementNS(ns, 'path');
      hit.setAttribute('class', 'hit');
      hit.setAttribute('d', geo.d);
      const line = document.createElementNS(ns, 'path');
      line.setAttribute('class', 'line');
      line.setAttribute('d', geo.d);
      line.setAttribute('marker-end', 'url(#arrow-' + e.kind + ')');
      g.appendChild(line);
      g.appendChild(hit);
      const text = edgeText(e);
      if (text) {
        const lg = document.createElementNS(ns, 'g');
        lg.setAttribute('class', 'edge-label');
        const w = Math.min(220, 14 + text.length * 6.4);
        const rect = document.createElementNS(ns, 'rect');
        rect.setAttribute('x', geo.mid.x - w / 2);
        rect.setAttribute('y', geo.mid.y - 10);
        rect.setAttribute('width', w);
        rect.setAttribute('height', 20);
        rect.setAttribute('rx', 6);
        const t = document.createElementNS(ns, 'text');
        t.setAttribute('x', geo.mid.x);
        t.setAttribute('y', geo.mid.y + 1);
        t.textContent = text.length > 32 ? text.slice(0, 31) + '…' : text;
        lg.appendChild(rect);
        lg.appendChild(t);
        g.appendChild(lg);
      }
      edgeLayer.appendChild(g);
    }
  }

  // ------------------------------------------------------------- inspector
  function field(label, inner, help) {
    return '<div class="field"><label>' + label + '</label>' + inner + (help ? '<div class="help">' + help + '</div>' : '') + '</div>';
  }

  function renderInspector() {
    const el = $('#inspector');
    if (selection && selection.type === 'node' && node(selection.id)) return renderNodeInspector(el, node(selection.id));
    if (selection && selection.type === 'edge' && edge(selection.id)) return renderEdgeInspector(el, edge(selection.id));
    renderWorkflowInspector(el);
  }

  function renderNodeInspector(el, n) {
    if (n.source === 'existing') return renderExistingInspector(el, n);
    const r = G.ROLES[n.role];
    const names = normalizedNames();
    const isOrch = n.role === 'orchestrator';
    const roleOpts = Object.entries(G.ROLES).map(([k, v]) => '<option value="' + k + '"' + (k === n.role ? ' selected' : '') + '>' + esc(v.title) + '</option>').join('');
    const modelOpts = G.MODELS.map((m) => '<option' + (m === n.model ? ' selected' : '') + '>' + m + '</option>').join('');
    const tools = G.ALL_TOOLS.map((t) => '<label class="chip' + (n.tools.includes(t) ? ' on' : '') + '"><input type="checkbox" data-tool="' + t + '"' + (n.tools.includes(t) ? ' checked' : '') + '>' + t + '</label>').join('');
    const mode = n.perTask ? 'task' : n.instances > 1 ? 'multi' : 'single';
    const seg = (name, opts, cur) =>
      '<div class="seg">' + opts.map(([v, l]) => '<label class="' + (v === cur ? 'on' : '') + '"><input type="radio" name="' + name + '" value="' + v + '"' + (v === cur ? ' checked' : '') + '>' + l + '</label>').join('') + '</div>';
    const skills = n.skills || [];
    const skillChips =
      skills.map((sk) => '<span class="mchip skill' + (server && !library.skills.some((x) => x.name === sk) ? ' missing' : '') + '">⚡ ' + esc(sk) + ' <a href="#" data-unskill="' + esc(sk) + '" title="Remove">✕</a></span>').join('') ||
      '<span class="muted">None.</span>';
    const skillOpts = library.skills.filter((x) => !skills.includes(x.name) && !x.managed).map((x) => '<option value="' + esc(x.name) + '">' + esc(x.name) + (x.scope === 'user' ? ' (user)' : '') + '</option>').join('');

    const ins = design.edges.filter((e) => e.to === n.id).map((e) => node(e.from).label);
    const outs = design.edges.filter((e) => e.from === n.id).map((e) => node(e.to).label + ' (' + G.EDGE_KINDS[e.kind].label + ')');
    const aiBtn = (id, text) => '<button id="' + id + '" class="ai mini"' + (aiStatus.ok ? '' : ' disabled title="' + esc(aiStatus.error || 'AI unavailable') + '"') + '>' + text + '</button>';

    el.innerHTML =
      '<div class="insp-head" style="--c:' + nodeColor(n) + '"><span class="dot"></span><h3>' + esc(n.label) + '</h3></div>' +
      (isOrch ? '<div class="note">The orchestrator is played by the <b>main Claude Code session</b>. It spawns every other agent and routes their results, because subagents cannot spawn agents themselves.</div>' : '') +
      field('Display name', '<input id="f-label" value="' + esc(n.label) + '">') +
      '<div class="row">' + field('Role', '<select id="f-role">' + roleOpts + '</select>') + field('Model', '<select id="f-model">' + modelOpts + '</select>') + '</div>' +
      '<div class="field"><div class="lbl row-h">What should this agent do?' + (isOrch ? '' : aiBtn('a-refine', '✨ Refine with Claude')) + '</div>' +
      '<textarea id="f-desc" rows="4" placeholder="' + esc(r.blurb) + '">' + esc(n.description) + '</textarea>' +
      '<div class="help">' + (isOrch ? 'Your brief as orchestrator; written into the playbook.' : 'A sentence or two is enough. <b>Refine with Claude</b> turns it into a full agent prompt you can review.') + '</div></div>' +
      (isOrch
        ? ''
        : field(
            'Instructions (agent prompt)',
            '<textarea id="f-prompt" rows="' + (n.prompt ? 10 : 3) + '" placeholder="Optional. Leave empty to use the ' + esc(r.title) + ' role defaults.">' + esc(n.prompt || '') + '</textarea>',
            n.prompt ? 'Replaces the role defaults. The workflow position and output contract are still added automatically.' : 'Empty: the generated agent uses the ' + esc(r.title.toLowerCase()) + ' defaults.'
          ) +
          field('Agent name (subagent_type)', '<input id="f-name" class="mono" placeholder="' + esc(G.slugify(n.label)) + '" value="' + esc(n.name || '') + '">', 'Will be generated as <span class="mono">' + esc(names[n.id]) + '</span>') +
          field('Runs as', seg('mode', [['single', 'Single'], ['multi', 'N parallel'], ['task', 'One per task']], mode) +
            (mode === 'multi' ? '<div style="margin-top:6px"><input id="f-instances" type="number" min="2" max="16" value="' + n.instances + '"></div>' : ''),
            mode === 'task' ? 'The orchestrator spawns one copy per work package from the plan (parallel, capped by Max parallel).' : mode === 'multi' ? 'This many copies run in parallel and split the work.' : '') +
          field('Isolation', seg('iso', [['none', 'Shared checkout'], ['worktree', 'Git worktree']], n.isolation),
            'A worktree gives the agent its own branch and copy of the repo, so parallel agents never overwrite each other. Passing work is merged back by the orchestrator.') +
          field('Skills', '<div class="mini-chips" style="margin:0 0 6px">' + skillChips + '</div>' +
            (server ? '<select id="f-addskill"><option value="">' + (skillOpts ? '+ Equip a skill…' : 'No more skills installed') + '</option>' + skillOpts + '</select>' : ''),
            'Equipped skills are preloaded into the agent (frontmatter <span class="mono">skills:</span>).')) +
      field('Tools', '<div class="chips">' + tools + '</div>', 'Read-only roles (planner, verifier, reviewer) should not get Edit/Write.') +
      '<div class="kv"><div>Receives from: <b>' + esc(ins.join(', ') || '—') + '</b></div><div>Sends to: <b>' + esc(outs.join(', ') || '—') + '</b></div></div>' +
      '<div class="actions"><button id="a-dup">Duplicate</button>' + (isOrch ? '' : '<button id="a-save-custom" title="Add to My agents so you can reuse it">Save as custom agent</button>') + '<button id="a-del" class="danger">Delete</button></div>';

    const upd = (fn, rerenderInspector) => {
      snapshotDebounced();
      fn();
      changed();
      if (rerenderInspector) renderInspector();
    };
    $('#f-label').addEventListener('input', (ev) => upd(() => (n.label = ev.target.value)));
    $('#f-label').addEventListener('change', () => renderInspector());
    $('#f-role').addEventListener('change', (ev) =>
      upd(() => {
        const old = G.ROLES[n.role];
        n.role = ev.target.value;
        const nr = G.ROLES[n.role];
        n.tools = nr.tools.slice();
        if (!n.label || n.label === old.title) n.label = nr.title;
        if (n.role === 'orchestrator') { n.perTask = false; n.instances = 1; n.isolation = 'none'; }
      }, true)
    );
    $('#f-model').addEventListener('change', (ev) => upd(() => (n.model = ev.target.value)));
    $('#f-desc').addEventListener('input', (ev) => upd(() => (n.description = ev.target.value)));
    if (!isOrch) {
      $('#f-prompt').addEventListener('input', (ev) => upd(() => (n.prompt = ev.target.value)));
      $('#f-name').addEventListener('input', (ev) => upd(() => (n.name = ev.target.value)));
      $('#f-name').addEventListener('change', () => renderInspector());
      el.querySelectorAll('input[name=mode]').forEach((i) =>
        i.addEventListener('change', (ev) =>
          upd(() => {
            n.perTask = ev.target.value === 'task';
            n.instances = ev.target.value === 'multi' ? Math.max(2, n.instances) : 1;
          }, true)
        )
      );
      const inst = $('#f-instances');
      if (inst) inst.addEventListener('input', (ev) => upd(() => (n.instances = Math.max(1, Math.min(16, parseInt(ev.target.value, 10) || 2)))));
      el.querySelectorAll('input[name=iso]').forEach((i) => i.addEventListener('change', (ev) => upd(() => (n.isolation = ev.target.value), true)));
      const addSkill = $('#f-addskill');
      if (addSkill) addSkill.addEventListener('change', (ev) => ev.target.value && upd(() => (n.skills = (n.skills || []).concat(ev.target.value)), true));
      el.querySelectorAll('[data-unskill]').forEach((a) =>
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          upd(() => (n.skills = (n.skills || []).filter((x) => x !== a.dataset.unskill)), true);
        })
      );
      $('#a-refine').addEventListener('click', () => refineNode(n));
      $('#a-save-custom').addEventListener('click', () => openCustomEditor(customFromNode(n)));
    }
    el.querySelectorAll('input[data-tool]').forEach((i) =>
      i.addEventListener('change', (ev) =>
        upd(() => {
          const t = ev.target.dataset.tool;
          n.tools = ev.target.checked ? G.ALL_TOOLS.filter((x) => x === t || n.tools.includes(x)) : n.tools.filter((x) => x !== t);
        }, true)
      )
    );
    $('#a-dup').addEventListener('click', duplicateSelection);
    $('#a-del').addEventListener('click', deleteSelection);
  }

  // A node that points at an agent file the user already has. The workflow settings (role, runs as,
  // isolation) live in the design; the definition (description, instructions, model, tools, skills,
  // color) is edited here and saved back into the agent file, with every old version kept.
  const drafts = {}; // agent name -> unsaved edits of its file
  function draftFor(a) {
    if (!drafts[a.name]) drafts[a.name] = { description: a.description, body: a.body, model: a.model || 'inherit', tools: a.tools.slice(), skills: a.skills.slice(), color: a.color || '', dirty: false };
    return drafts[a.name];
  }

  function renderExistingInspector(el, n) {
    const a = libAgent(n.name);
    const roleOpts = Object.entries(G.ROLES).filter(([k]) => k !== 'orchestrator').map(([k, v]) => '<option value="' + k + '"' + (k === n.role ? ' selected' : '') + '>' + esc(v.title) + '</option>').join('');
    const mode = n.perTask ? 'task' : n.instances > 1 ? 'multi' : 'single';
    const seg = (name, opts, cur) =>
      '<div class="seg">' + opts.map(([v, l]) => '<label class="' + (v === cur ? 'on' : '') + '"><input type="radio" name="' + name + '" value="' + v + '"' + (v === cur ? ' checked' : '') + '>' + l + '</label>').join('') + '</div>';
    const aiBtn = (id, text) => '<button id="' + id + '" class="ai mini"' + (aiStatus.ok ? '' : ' disabled title="' + esc(aiStatus.error || 'AI unavailable') + '"') + '>' + text + '</button>';
    let defHtml = '';
    if (a && a.managed) {
      defHtml = '<div class="note">This agent file is generated by the workflow. Change it on its workflow node instead.</div>';
    } else if (a) {
      const d = draftFor(a);
      const allTools = G.ALL_TOOLS.concat(d.tools.filter((t) => !G.ALL_TOOLS.includes(t)));
      const allOn = !d.tools.length;
      const tools = allTools.map((t) => { const on = allOn ? G.ALL_TOOLS.includes(t) : d.tools.includes(t); return '<label class="chip' + (on ? ' on' : '') + '"><input type="checkbox" data-etool="' + esc(t) + '"' + (on ? ' checked' : '') + '>' + esc(t) + '</label>'; }).join('');
      const models = G.MODELS.concat(G.MODELS.includes(d.model) ? [] : [d.model]);
      const skillChips = d.skills.map((sk) => '<span class="mchip skill' + (!library.skills.some((x) => x.name === sk) ? ' missing' : '') + '">⚡ ' + esc(sk) + ' <a href="#" data-eunskill="' + esc(sk) + '" title="Remove">✕</a></span>').join('') || '<span class="muted">None.</span>';
      const skillOpts = library.skills.filter((x) => !d.skills.includes(x.name) && !x.managed).map((x) => '<option value="' + esc(x.name) + '">' + esc(x.name) + (x.scope === 'user' ? ' (user)' : '') + '</option>').join('');
      defHtml =
        '<h2 class="row-h">Agent file' + (d.dirty ? '<span class="tag dirty">unsaved</span>' : '') + '</h2>' +
        '<div class="field"><div class="lbl row-h">Description (when to use it)' + aiBtn('a-refine', '✨ Refine with Claude') + '</div><textarea id="e-desc" rows="4">' + esc(d.description) + '</textarea></div>' +
        field('Instructions (file body)', '<textarea id="e-body" rows="10" class="mono-sm">' + esc(d.body) + '</textarea>') +
        '<div class="row">' + field('Model', '<select id="e-model">' + models.map((m) => '<option' + (m === d.model ? ' selected' : '') + '>' + esc(m) + '</option>').join('') + '</select>') +
        field('Color', '<select id="e-color"><option value="">none</option>' + G.COLORS.map((c) => '<option' + (c === d.color ? ' selected' : '') + '>' + c + '</option>').join('') + '</select>') + '</div>' +
        field('Tools', '<div class="chips">' + tools + '</div>', allOn ? 'All tools (no <span class="mono">tools:</span> line in the file).' : '') +
        field('Skills', '<div class="mini-chips" style="margin:0 0 6px">' + skillChips + '</div><select id="e-addskill"><option value="">' + (skillOpts ? '+ Equip a skill…' : 'No more skills installed') + '</option>' + skillOpts + '</select>') +
        '<div class="actions"><button id="e-save" class="primary"' + (d.dirty ? '' : ' disabled') + '>Save to agent file</button><button id="e-revert"' + (d.dirty ? '' : ' disabled') + '>Discard changes</button></div>' +
        '<div class="actions"><button id="e-history">History &amp; rollback…</button><button id="a-editfile">Edit raw file</button></div>' +
        '<div class="help">Saving keeps the previous version in <span class="mono">' + (a.scope === 'user' ? '~/.agent-visualizer/backups/' : '.agent/backups/') + '</span>, so you can roll back.</div>';
    }
    el.innerHTML =
      '<div class="insp-head" style="--c:' + nodeColor(n) + '"><span class="dot"></span><h3>' + esc(n.label) + '</h3><span class="tag on">existing</span></div>' +
      '<div class="note">Linked to your agent <b class="mono">' + esc(n.name) + '</b>' + (a ? ' <span class="mono" style="word-break:break-all">(' + esc(a.path) + ')</span>' : ' <span style="color:var(--danger)">(file not found)</span>') +
      '. The workflow spawns it as-is; generating never overwrites it.</div>' +
      field('Display name', '<input id="f-label" value="' + esc(n.label) + '">') +
      field('Acts as', '<select id="f-role">' + roleOpts + '</select>', 'Tells the orchestrator how to treat its output (e.g. Verifier and Reviewer outputs are routed on a verdict).') +
      field('Runs as', seg('mode', [['single', 'Single'], ['multi', 'N parallel'], ['task', 'One per task']], mode) +
        (mode === 'multi' ? '<div style="margin-top:6px"><input id="f-instances" type="number" min="2" max="16" value="' + n.instances + '"></div>' : '')) +
      field('Isolation', seg('iso', [['none', 'Shared checkout'], ['worktree', 'Git worktree']], n.isolation)) +
      defHtml +
      '<div class="actions"><button id="a-convert" title="Copy its definition into the design so the workflow manages it">Make workflow copy</button><button id="a-del" class="danger">Remove from canvas</button></div>';
    const upd = (fn, re) => {
      snapshotDebounced();
      fn();
      changed();
      if (re) renderInspector();
    };
    $('#f-label').addEventListener('input', (ev) => upd(() => (n.label = ev.target.value)));
    $('#f-role').addEventListener('change', (ev) => upd(() => (n.role = ev.target.value), true));
    el.querySelectorAll('input[name=mode]').forEach((i) =>
      i.addEventListener('change', (ev) =>
        upd(() => {
          n.perTask = ev.target.value === 'task';
          n.instances = ev.target.value === 'multi' ? Math.max(2, n.instances) : 1;
        }, true)
      )
    );
    const inst = $('#f-instances');
    if (inst) inst.addEventListener('input', (ev) => upd(() => (n.instances = Math.max(1, Math.min(16, parseInt(ev.target.value, 10) || 2)))));
    el.querySelectorAll('input[name=iso]').forEach((i) => i.addEventListener('change', (ev) => upd(() => (n.isolation = ev.target.value), true)));

    if (a && !a.managed) {
      const d = draftFor(a);
      const touch = (fn, re) => {
        fn();
        const wasDirty = d.dirty;
        d.dirty = true;
        if (re || !wasDirty) renderInspector();
      };
      // Text fields keep focus: re-render only when the "unsaved" state first appears, then restore the caret.
      const textField = (id, key) =>
        $(id).addEventListener('input', (ev) => {
          const pos = ev.target.selectionStart;
          touch(() => (d[key] = ev.target.value));
          const t = $(id);
          if (t && document.activeElement !== t) { t.focus(); t.setSelectionRange(pos, pos); }
        });
      textField('#e-desc', 'description');
      textField('#e-body', 'body');
      $('#e-model').addEventListener('change', (ev) => touch(() => (d.model = ev.target.value), true));
      $('#e-color').addEventListener('change', (ev) => touch(() => (d.color = ev.target.value), true));
      el.querySelectorAll('input[data-etool]').forEach((i) =>
        i.addEventListener('change', () =>
          touch(() => {
            const on = Array.from(el.querySelectorAll('input[data-etool]')).filter((x) => x.checked).map((x) => x.dataset.etool);
            // Every standard tool checked and nothing extra = all tools (no tools: line).
            d.tools = G.ALL_TOOLS.every((t) => on.includes(t)) && on.length === G.ALL_TOOLS.length ? [] : on;
          }, true)
        )
      );
      $('#e-addskill').addEventListener('change', (ev) => ev.target.value && touch(() => d.skills.push(ev.target.value), true));
      el.querySelectorAll('[data-eunskill]').forEach((x) =>
        x.addEventListener('click', (ev) => {
          ev.preventDefault();
          touch(() => (d.skills = d.skills.filter((s) => s !== x.dataset.eunskill)), true);
        })
      );
      $('#e-save').addEventListener('click', () => saveAgentDraft(a));
      $('#e-revert').addEventListener('click', () => {
        delete drafts[a.name];
        renderInspector();
      });
      $('#e-history').addEventListener('click', () => openHistory(a.path, a.name));
      $('#a-editfile').addEventListener('click', () => {
        if (d.dirty && !confirm('Discard the unsaved changes and open the raw file?')) return;
        delete drafts[a.name];
        openFileEditor(a.path, a.name);
      });
      $('#a-refine').addEventListener('click', () =>
        refineNode(Object.assign({}, n, { description: d.description, prompt: d.body, model: G.MODELS.includes(d.model) ? d.model : 'inherit', tools: d.tools.length ? d.tools : G.ALL_TOOLS.slice(), skills: d.skills }), (v) => {
          Object.assign(d, { description: v.description, body: v.prompt, model: v.model, tools: G.ALL_TOOLS.every((t) => v.tools.includes(t)) ? [] : v.tools, skills: v.skills, dirty: true });
          renderInspector();
          toast('Refined text is in the form. Review it, then Save to agent file.');
        })
      );
    }
    $('#a-convert').addEventListener('click', () => {
      const src = a && !a.managed ? draftFor(a) : a;
      upd(() => {
        n.source = 'design';
        if (src) {
          n.description = src.description;
          n.prompt = src.body;
          n.model = G.MODELS.includes(src.model) ? src.model : 'inherit';
          n.tools = src.tools.length ? src.tools.filter((t) => G.ALL_TOOLS.includes(t)) : G.ALL_TOOLS.slice();
          n.skills = src.skills.slice();
        }
        n.name = n.name + '-wf';
      }, true);
      toast('Now a workflow-managed agent "' + normalizedNames()[n.id] + '". Your original file is untouched.');
    });
    $('#a-del').addEventListener('click', deleteSelection);
  }

  function syncExistingNodes() {
    for (const n of design.nodes) {
      const a = n.source === 'existing' && libAgent(n.name);
      if (a) Object.assign(n, { description: a.description, skills: a.skills.slice(), model: G.MODELS.includes(a.model) ? a.model : 'inherit', color: a.color || n.color });
    }
  }

  async function saveAgentDraft(a) {
    const d = drafts[a.name];
    if (!d) return;
    try {
      library = await api('POST', '/api/agent', { path: a.path, fields: { description: d.description, body: d.body, model: d.model, tools: d.tools, skills: d.skills, color: d.color } });
      delete drafts[a.name];
      syncExistingNodes();
      changed();
      renderLibrary();
      renderInspector();
      toast('Saved ' + a.name + ' (previous version kept in History)');
    } catch (e) {
      toast('Save failed: ' + e.message, true);
    }
  }

  // Line diff (LCS) between two small texts: [{t:' '|'+'|'-', s}]
  function lineDiff(a, b) {
    const x = a.split('\n');
    const y = b.split('\n');
    const m = x.length;
    const n = y.length;
    if (m * n > 4e6) return [{ t: ' ', s: '(too large to compare)' }];
    const L = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (x[i] === y[j]) { out.push({ t: ' ', s: x[i] }); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: '-', s: x[i++] });
      else out.push({ t: '+', s: y[j++] });
    }
    while (i < m) out.push({ t: '-', s: x[i++] });
    while (j < n) out.push({ t: '+', s: y[j++] });
    return out;
  }

  function diffHtml(oldText, newText) {
    const d = lineDiff(oldText, newText);
    if (!d.some((l) => l.t !== ' ')) return '<div class="muted">Same as the current file.</div>';
    // Show changes with 2 lines of context; collapse the rest.
    const keep = d.map((l, i) => d.slice(Math.max(0, i - 2), i + 3).some((x) => x.t !== ' '));
    let html = '';
    let skipped = 0;
    d.forEach((l, i) => {
      if (!keep[i]) return skipped++;
      if (skipped) html += '<div class="dl skip">⋯ ' + skipped + ' unchanged line' + (skipped > 1 ? 's' : '') + '</div>';
      skipped = 0;
      html += '<div class="dl ' + (l.t === '+' ? 'add' : l.t === '-' ? 'del' : '') + '">' + (l.t === ' ' ? '&nbsp;' : l.t) + ' ' + esc(l.s) + '</div>';
    });
    if (skipped) html += '<div class="dl skip">⋯ ' + skipped + ' unchanged line' + (skipped > 1 ? 's' : '') + '</div>';
    return html;
  }

  // Version history of an agent or skill file, with diff against the current file and rollback.
  async function openHistory(path, name) {
    let h, cur;
    try {
      [h, cur] = await Promise.all([api('GET', '/api/history?path=' + encodeURIComponent(path)), api('GET', '/api/file?path=' + encodeURIComponent(path))]);
    } catch (e) {
      return toast(e.message, true);
    }
    const when = (t) => new Date(t).toLocaleString();
    const body = openDialog(
      'History of ' + name,
      '<div class="kv mono" style="word-break:break-all;margin-bottom:8px">Versions are kept in ' + esc(h.dir || '') + '</div>' +
        (h.versions.length
          ? '<div class="hist"><div class="hist-list">' +
            h.versions.map((v, i) => '<button class="hist-item' + (i === 0 ? ' on' : '') + '" data-id="' + esc(v.id) + '"><b>' + esc(when(v.time)) + '</b><span>' + esc(v.reason || 'saved') + '</span></button>').join('') +
            '</div><div class="hist-view"><div class="row-h" style="margin-bottom:6px"><span class="muted">Changes from this version to the current file. <span class="dl-key add">+ current</span> <span class="dl-key del">− this version</span></span><label class="muted inline-check"><input type="checkbox" id="hv-raw">show full file</label></div><div id="hv-diff" class="diff"></div></div></div>'
          : '<div class="empty">No earlier versions yet. A version is saved each time you edit this file here.</div>'),
      '<span class="muted">Rolling back saves the current file as a new version first, so it can be undone.</span><div class="spacer"></div><button id="hv-close">Close</button>' + (h.versions.length ? '<button id="hv-restore" class="primary">Roll back to this version</button>' : ''),
      true
    );
    $('#hv-close').addEventListener('click', closeDialog);
    if (!h.versions.length) return;
    let selId = h.versions[0].id;
    let text = '';
    const show = async (id) => {
      selId = id;
      body.querySelectorAll('.hist-item').forEach((b) => b.classList.toggle('on', b.dataset.id === id));
      try {
        text = (await api('GET', '/api/history?path=' + encodeURIComponent(path) + '&id=' + encodeURIComponent(id))).content;
      } catch (e) {
        return toast(e.message, true);
      }
      $('#hv-diff').innerHTML = $('#hv-raw').checked ? '<pre>' + esc(text) + '</pre>' : diffHtml(text, cur.content);
    };
    body.querySelectorAll('.hist-item').forEach((b) => b.addEventListener('click', () => show(b.dataset.id)));
    $('#hv-raw').addEventListener('change', () => show(selId));
    $('#hv-restore').addEventListener('click', async () => {
      const v = h.versions.find((x) => x.id === selId);
      if (!confirm('Roll ' + name + ' back to the version from ' + when(v.time) + '?')) return;
      try {
        library = await api('POST', '/api/history/restore', { path, id: selId });
        const a = library.agents.find((x) => x.path === path);
        if (a) delete drafts[a.name];
        syncExistingNodes();
        closeDialog();
        changed();
        renderLibrary();
        renderInspector();
        toast('Rolled ' + name + ' back to ' + when(v.time));
      } catch (e) {
        toast('Rollback failed: ' + e.message, true);
      }
    });
    show(selId);
  }

  function renderEdgeInspector(el, e) {
    const a = node(e.from);
    const b = node(e.to);
    const kinds = Object.entries(G.EDGE_KINDS).map(([k, v]) => '<option value="' + k + '"' + (k === e.kind ? ' selected' : '') + '>' + esc(v.label) + '</option>').join('');
    el.innerHTML =
      '<div class="insp-head"><h3>Link</h3></div>' +
      '<div class="kv" style="margin-bottom:12px"><b>' + esc(a.label) + '</b> → <b>' + esc(b.label) + '</b></div>' +
      field('Type', '<select id="f-kind">' + kinds + '</select>', esc(G.EDGE_KINDS[e.kind].desc)) +
      field('Condition (optional)', '<input id="f-cond" placeholder="e.g. tests fail, security issue found" value="' + esc(e.condition || '') + '">', 'Extra routing hint written into the playbook.') +
      (e.kind === 'fail'
        ? field('Max iterations', '<input id="f-maxit" type="number" min="1" max="20" value="' + (e.maxIterations || 3) + '">', 'After this many FAIL round-trips the orchestrator stops looping and escalates.')
        : '') +
      (e.evidence && e.evidence.length
        ? '<h2>Detected from</h2>' + e.evidence.map((x) => '<div class="note"><div class="mono" style="font-size:11px;margin-bottom:3px">' + esc(x.file) + '</div>' + esc(x.text) + '</div>').join('') +
          '<div class="help">This link was inferred when the project was loaded. Check it, change it, or delete it.</div>'
        : '') +
      '<div class="actions"><button id="a-rev">Reverse</button><button id="a-del" class="danger">Delete link</button></div>';
    const upd = (fn, re) => {
      snapshotDebounced();
      fn();
      changed();
      if (re) renderInspector();
    };
    $('#f-kind').addEventListener('change', (ev) => upd(() => (e.kind = ev.target.value), true));
    $('#f-cond').addEventListener('input', (ev) => upd(() => (e.condition = ev.target.value)));
    const mi = $('#f-maxit');
    if (mi) mi.addEventListener('input', (ev) => upd(() => (e.maxIterations = Math.max(1, Math.min(20, parseInt(ev.target.value, 10) || 3)))));
    $('#a-rev').addEventListener('click', () => upd(() => ([e.from, e.to] = [e.to, e.from]), true));
    $('#a-del').addEventListener('click', deleteSelection);
  }

  function renderWorkflowInspector(el) {
    const s = design.settings;
    const v = fullValidate();
    const chk = (id, on, title, sub) => '<label class="check"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '><span>' + title + '<small>' + sub + '</small></span></label>';
    let proj = '';
    if (server) {
      proj =
        '<h2>Target project</h2>' +
        '<div class="kv mono" style="word-break:break-all;margin-bottom:6px">' + esc(server.projectDir) + '</div>' +
        '<div class="kv">' + (server.git ? (server.commits ? '✓ git repository' : '⚠ git repository without commits (worktrees need one commit)') : '⚠ not a git repository (needed for worktrees)') + '</div>' +
        '<div class="actions"><button id="a-proj">Change…</button>' + (server.git ? '' : '<button id="a-git">git init</button>') + (server.hasDesign ? '<button id="a-reload">Reload saved design</button>' : '') + '</div>';
    } else {
      proj = '<div class="note warn">Opened without the local server, so files cannot be written. Start it with <span class="mono">node server.js --project &lt;dir&gt;</span>. You can still design and export.</div>';
    }
    el.innerHTML =
      '<div class="insp-head"><h3>Workflow</h3></div>' +
      field('Default goal / task', '<textarea id="f-goal" rows="4" placeholder="Optional. e.g. Add OAuth login with Google and GitHub">' + esc(design.goal || '') + '</textarea>', 'If set, a fresh session can start it right away. Otherwise the session runs the workflow on whatever task you type.') +
      '<div class="row">' +
      field('Max parallel', '<input id="f-par" type="number" min="1" max="16" value="' + s.maxParallel + '">') +
      field('Max rounds', '<input id="f-rounds" type="number" min="1" max="10" value="' + s.maxRounds + '">') +
      '</div>' +
      field('Agent name prefix', '<input id="f-prefix" class="mono" placeholder="optional, e.g. web" value="' + esc(s.namePrefix || '') + '">', 'Avoids clashes with other agents in ~/.claude/agents.') +
      chk('f-auto', s.autoStart, 'Start the default goal on "go"', 'A fresh session starts the goal as soon as you say go.') +
      chk('f-log', s.runLog, 'Keep a run log', 'Orchestrator writes .agent/runs/&lt;time&gt;/log.md and plan.md.') +
      chk('f-merge', s.mergeWorktrees, 'Merge verified worktrees', 'Orchestrator merges passing worktree branches back automatically.') +
      proj +
      '<h2>Validation</h2>' + issuesHtml(v) +
      '<h2>Summary</h2><div class="kv">' + design.nodes.length + ' agents · ' + design.edges.length + ' links. Select a node or link to edit it.</div>';

    const upd = (fn) => {
      snapshotDebounced();
      fn();
      changed();
    };
    $('#f-goal').addEventListener('input', (ev) => upd(() => (design.goal = ev.target.value)));
    $('#f-par').addEventListener('input', (ev) => upd(() => (s.maxParallel = parseInt(ev.target.value, 10) || 4)));
    $('#f-rounds').addEventListener('input', (ev) => upd(() => (s.maxRounds = parseInt(ev.target.value, 10) || 3)));
    $('#f-prefix').addEventListener('input', (ev) => upd(() => (s.namePrefix = ev.target.value)));
    $('#f-auto').addEventListener('change', (ev) => upd(() => (s.autoStart = ev.target.checked)));
    $('#f-log').addEventListener('change', (ev) => upd(() => (s.runLog = ev.target.checked)));
    $('#f-merge').addEventListener('change', (ev) => upd(() => (s.mergeWorktrees = ev.target.checked)));
    const ap = $('#a-proj');
    if (ap) ap.addEventListener('click', changeProject);
    const ag = $('#a-git');
    if (ag) ag.addEventListener('click', async () => {
      server = await api('POST', '/api/git-init', {});
      updateProjectChip();
      renderInspector();
      toast('Initialised a git repository');
    });
    const ar = $('#a-reload');
    if (ar) ar.addEventListener('click', loadFromProject);
  }

  function issuesHtml(v) {
    if (!v.errors.length && !v.warnings.length) return '<div class="kv" style="color:var(--ok)">✓ No issues. Ready to generate.</div>';
    return '<ul class="issue-list">' + v.errors.map((x) => '<li class="e">' + esc(x) + '</li>').join('') + v.warnings.map((x) => '<li class="w">' + esc(x) + '</li>').join('') + '</ul>';
  }

  let snapTimer = null;
  let snapArmed = true;
  function snapshotDebounced() {
    // Group bursts of typing into a single undo step.
    if (snapArmed) {
      snapshot();
      snapArmed = false;
    }
    clearTimeout(snapTimer);
    snapTimer = setTimeout(() => (snapArmed = true), 700);
  }

  function updateStatus() {
    const v = fullValidate();
    const st = $('#status');
    st.className = 'status ' + (v.errors.length ? 'err' : v.warnings.length ? 'warn' : 'ok');
    st.textContent = v.errors.length ? '● ' + v.errors.length + ' error' + (v.errors.length > 1 ? 's' : '') + (v.warnings.length ? ' · ' + v.warnings.length + ' warnings' : '') : v.warnings.length ? '● ' + v.warnings.length + ' warning' + (v.warnings.length > 1 ? 's' : '') : '✓ Ready to generate';
    if (!selection) {
      const active = document.activeElement;
      if (!active || !$('#inspector').contains(active)) renderInspector();
    }
  }

  // ------------------------------------------------------------ selection
  function select(sel) {
    selection = sel;
    renderCanvas();
    renderInspector();
    renderLibrary();
  }

  function deleteSelection() {
    if (!selection) return;
    snapshot();
    if (selection.type === 'node') {
      design.nodes = design.nodes.filter((n) => n.id !== selection.id);
      design.edges = design.edges.filter((e) => e.from !== selection.id && e.to !== selection.id);
    } else {
      design.edges = design.edges.filter((e) => e.id !== selection.id);
    }
    selection = null;
    changed();
    renderInspector();
  }

  function duplicateSelection() {
    if (!selection || selection.type !== 'node') return;
    const src = node(selection.id);
    if (src.role === 'orchestrator') return toast('Only one orchestrator is allowed', true);
    snapshot();
    const n = clone(src);
    n.id = uid('n');
    n.name = '';
    n.label = src.label + ' copy';
    n.x += 30;
    n.y += 30;
    design.nodes.push(n);
    selection = { type: 'node', id: n.id };
    changed();
    renderInspector();
  }

  function guessKind(a, b) {
    if (b.role === 'orchestrator') return 'report';
    if (a.role === 'verifier' || a.role === 'reviewer') {
      const back = b.x < a.x || ['worker', 'tester', 'custom'].includes(b.role);
      const hasFail = design.edges.some((e) => e.from === a.id && e.kind === 'fail');
      return back && !hasFail ? 'fail' : 'pass';
    }
    return 'handoff';
  }

  function addEdge(from, to) {
    if (from === to) return;
    if (design.edges.some((e) => e.from === from && e.to === to)) return toast('Those agents are already linked');
    snapshot();
    const a = node(from);
    const b = node(to);
    const e = { id: uid('e'), from, to, kind: guessKind(a, b), condition: '', maxIterations: 3 };
    design.edges.push(e);
    selection = { type: 'edge', id: e.id };
    changed();
    renderInspector();
  }

  // ------------------------------------------------------------ pointer
  let drag = null;

  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    if (ev.target.closest('.zoom, .status, .notice, .empty-hint button')) return;
    canvas.focus({ preventScroll: true });
    const port = ev.target.closest('.port.out');
    const nodeEl = ev.target.closest('.node');
    const edgeEl = ev.target.closest('.edge');
    if (port && nodeEl) {
      drag = { type: 'link', from: nodeEl.dataset.id };
      canvas.classList.add('connecting');
      updateTempEdge(ev);
    } else if (nodeEl) {
      const n = node(nodeEl.dataset.id);
      const p = toWorld(ev.clientX, ev.clientY);
      drag = { type: 'node', id: n.id, dx: p.x - n.x, dy: p.y - n.y, moved: false, el: nodeEl };
      if (!selection || selection.id !== n.id) select({ type: 'node', id: n.id });
    } else if (edgeEl) {
      select({ type: 'edge', id: edgeEl.dataset.id });
      return;
    } else {
      drag = { type: 'pan', sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y, moved: false };
      canvas.classList.add('panning');
    }
    canvas.setPointerCapture(ev.pointerId);
  });

  canvas.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    if (drag.type === 'pan') {
      view.x = drag.vx + ev.clientX - drag.sx;
      view.y = drag.vy + ev.clientY - drag.sy;
      if (Math.abs(ev.clientX - drag.sx) + Math.abs(ev.clientY - drag.sy) > 3) drag.moved = true;
      applyView();
    } else if (drag.type === 'node') {
      const n = node(drag.id);
      const p = toWorld(ev.clientX, ev.clientY);
      const nx = Math.round(p.x - drag.dx);
      const ny = Math.round(p.y - drag.dy);
      if (!drag.moved && (Math.abs(nx - n.x) > 2 || Math.abs(ny - n.y) > 2)) {
        drag.moved = true;
        snapshot();
        drag.el.classList.add('dragging');
      }
      if (drag.moved) {
        n.x = nx;
        n.y = ny;
        drag.el.style.left = nx + 'px';
        drag.el.style.top = ny + 'px';
        renderEdges();
      }
    } else if (drag.type === 'link') {
      updateTempEdge(ev);
      document.querySelectorAll('.node.link-target').forEach((x) => x.classList.remove('link-target'));
      const t = targetNodeAt(ev);
      if (t && t.dataset.id !== drag.from) t.classList.add('link-target');
    }
  });

  function targetNodeAt(ev) {
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    return el && el.closest ? el.closest('.node') : null;
  }

  function endDrag(ev) {
    if (!drag) return;
    const d = drag;
    drag = null;
    canvas.classList.remove('panning', 'connecting');
    if (d.type === 'node') {
      d.el.classList.remove('dragging');
      if (d.moved) changed();
    } else if (d.type === 'pan') {
      if (!d.moved && selection) select(null);
    } else if (d.type === 'link') {
      tempEdge.setAttribute('d', '');
      document.querySelectorAll('.node.link-target').forEach((x) => x.classList.remove('link-target'));
      const t = ev && targetNodeAt(ev);
      if (t) addEdge(d.from, t.dataset.id);
    }
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', () => endDrag(null));

  function updateTempEdge(ev) {
    const a = node(drag.from);
    const p = anchor(a, 'out');
    const q = toWorld(ev.clientX, ev.clientY);
    const dx = Math.max(40, Math.abs(q.x - p.x) / 2);
    tempEdge.setAttribute('d', 'M' + p.x + ',' + p.y + ' C' + (p.x + dx) + ',' + p.y + ' ' + (q.x - dx) + ',' + q.y + ' ' + q.x + ',' + q.y);
  }

  canvas.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      if (ev.ctrlKey || ev.metaKey || Math.abs(ev.deltaY) > Math.abs(ev.deltaX) * 2) {
        zoomAt(view.k * Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0018)), ev.clientX, ev.clientY);
      } else {
        view.x -= ev.deltaX;
        view.y -= ev.deltaY;
        applyView();
      }
    },
    { passive: false }
  );

  canvas.addEventListener('dragover', (ev) => {
    const types = Array.from(ev.dataTransfer.types);
    if (['application/x-agent-role', 'application/x-agent-custom', 'application/x-agent-existing'].some((t) => types.includes(t))) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
      canvas.classList.add('drop-target');
    }
  });
  canvas.addEventListener('dragleave', () => canvas.classList.remove('drop-target'));
  canvas.addEventListener('drop', (ev) => {
    canvas.classList.remove('drop-target');
    const pt = toWorld(ev.clientX, ev.clientY);
    const customId = ev.dataTransfer.getData('application/x-agent-custom');
    const existing = ev.dataTransfer.getData('application/x-agent-existing');
    if (customId) {
      ev.preventDefault();
      const c = customTypes().find((x) => x.id === customId);
      if (c) addCustomNode(c, pt);
      return;
    }
    if (existing) {
      ev.preventDefault();
      return addExistingNode(existing, pt);
    }
    const role = ev.dataTransfer.getData('application/x-agent-role');
    if (!role || !G.ROLES[role]) return;
    ev.preventDefault();
    if (role === 'orchestrator' && design.nodes.some((n) => n.role === 'orchestrator')) toast('Only one orchestrator is allowed: change the role of one of them', true);
    addNode(role, toWorld(ev.clientX, ev.clientY));
  });

  document.addEventListener('keydown', (ev) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    const mod = ev.metaKey || ev.ctrlKey;
    if (!$('#dialog').hidden) {
      if (ev.key === 'Escape') closeDialog();
      return;
    }
    if (!$('#modal').hidden) {
      if (ev.key === 'Escape') closeModal();
      return;
    }
    if (mod && ev.key.toLowerCase() === 'z' && !typing) {
      ev.preventDefault();
      ev.shiftKey ? redo() : undo();
    } else if (mod && ev.key.toLowerCase() === 'y' && !typing) {
      ev.preventDefault();
      redo();
    } else if (mod && ev.key.toLowerCase() === 'd' && !typing) {
      ev.preventDefault();
      duplicateSelection();
    } else if ((ev.key === 'Delete' || ev.key === 'Backspace') && !typing) {
      ev.preventDefault();
      deleteSelection();
    } else if (ev.key === 'Escape' && !typing) {
      select(null);
    }
  });

  // ------------------------------------------------------------ layout
  function autoLayout() {
    if (!design.nodes.length) return;
    snapshot();
    layoutNodes();
    changed();
    requestAnimationFrame(fit);
  }

  function layoutNodes() {
    if (!design.nodes.length) return;
    const entry = G.findEntry(G.normalize(design));
    const forward = design.edges.filter((e) => e.kind !== 'fail' && e.kind !== 'report' && node(e.to).role !== 'orchestrator' && e.to !== entry.id);
    const layer = {};
    design.nodes.forEach((n) => (layer[n.id] = 0));
    // Longest-path layering over forward links (bounded relaxation handles leftover cycles).
    for (let i = 0; i < design.nodes.length; i++) {
      let moved = false;
      for (const e of forward) {
        if (layer[e.to] < layer[e.from] + 1 && layer[e.from] + 1 < design.nodes.length) {
          layer[e.to] = layer[e.from] + 1;
          moved = true;
        }
      }
      if (!moved) break;
    }
    const linked = new Set(design.edges.flatMap((e) => [e.from, e.to]));
    const isolated = design.nodes.filter((n) => !linked.has(n.id) && n.id !== entry.id && design.edges.length);
    const cols = {};
    for (const n of design.nodes) if (!isolated.includes(n)) (cols[layer[n.id]] = cols[layer[n.id]] || []).push(n);
    for (const [l, list] of Object.entries(cols)) {
      list.sort((a, b) => a.y - b.y);
      const total = list.length * 190;
      list.forEach((n, i) => {
        n.x = 40 + Number(l) * 310;
        n.y = 260 - total / 2 + i * 190 + 95;
      });
    }
    // Agents with no links yet go on their own row underneath.
    const bottom = Math.max(...design.nodes.filter((n) => !isolated.includes(n)).map((n) => n.y + (sizes[n.id] ? sizes[n.id].h : 140))) + 120;
    isolated.forEach((n, i) => {
      n.x = 40 + i * 270;
      n.y = bottom;
    });
  }

  // ------------------------------------------------------------ server I/O
  async function api(method, url, body) {
    const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error || res.statusText);
      e.details = data.details;
      e.status = res.status;
      throw e;
    }
    return data;
  }

  function updateProjectChip() {
    $('#project-path').textContent = server ? server.projectDir : 'no server: export only';
  }

  async function changeProject() {
    if (!server) return toast('Start the local server to choose a project', true);
    const dir = prompt('Target project directory (absolute path, ~ allowed):', server.projectDir);
    if (!dir) return;
    try {
      server = await api('POST', '/api/project', { dir });
      updateProjectChip();
      await loadLibrary();
      await openProjectCanvas();
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function loadFromProject() {
    try {
      const d = await api('GET', '/api/design');
      snapshot();
      loadDesign(d, true);
      toast('Loaded .agent/workflow.json from the project');
    } catch (e) {
      toast(e.message, true);
    }
  }

  // ------------------------------------------------------------ modal
  let lastGen = null;
  function openModal() {
    const r = G.generate(design);
    if (!r.errors.length) r.warnings = fullValidate().warnings;
    lastGen = r;
    const issues = $('#modal-issues');
    issues.innerHTML = r.errors.length || r.warnings.length ? issuesHtml(r) : '';
    const list = $('#file-list');
    list.innerHTML = '';
    const entries = [];
    if (!r.errors.length) {
      const groups = [
        ['Workflow (.agent)', (p) => p.startsWith('.agent/') && !p.startsWith('.agent/agents/') && !p.startsWith('.agent/skills/')],
        ['Agents', (p) => p.startsWith('.agent/agents/')],
        ['Skills', (p) => p.startsWith('.agent/skills/')],
        ['Claude Code mirrors (.claude)', (p) => p.startsWith('.claude/')],
      ];
      for (const [title, test] of groups) {
        const paths = Object.keys(r.files).filter(test).sort((a, b) => (a.endsWith('WORKFLOW.md') ? -1 : b.endsWith('WORKFLOW.md') ? 1 : a.localeCompare(b)));
        if (!paths.length) continue;
        entries.push({ group: title });
        paths.forEach((p) => entries.push({ path: p, content: r.files[p] }));
      }
      entries.push({ group: 'Merged into existing files' });
      entries.push({ path: 'CLAUDE.md', note: 'managed block only', content: '<!-- agent-visualizer:start -->\n' + r.claudeMd + '\n<!-- agent-visualizer:end -->\n\n(The rest of CLAUDE.md is left untouched.)' });
      entries.push({
        path: '.claude/settings.json',
        note: 'SessionStart hook merged in',
        content: JSON.stringify({ hooks: { SessionStart: [{ matcher: r.hook.matcher, hooks: [{ type: 'command', command: r.hook.command }] }] } }, null, 2) + '\n\n(Other settings and hooks are preserved.)',
      });
    }
    let first = null;
    for (const en of entries) {
      const li = document.createElement('li');
      if (en.group) {
        li.className = 'group';
        li.textContent = en.group;
      } else {
        li.innerHTML = esc(en.path) + (en.note ? '<small>' + esc(en.note) + '</small>' : '');
        li.addEventListener('click', () => {
          list.querySelectorAll('li.on').forEach((x) => x.classList.remove('on'));
          li.classList.add('on');
          $('#file-view').textContent = en.content;
        });
        if (!first) first = li;
      }
      list.appendChild(li);
    }
    $('#file-view').textContent = r.errors.length ? 'Fix the errors above to generate files.' : '';
    if (first) first.click();
    $('#modal-title').textContent = 'Preview generated files';
    $('#modal-target').innerHTML = server ? 'Writes into <span class="mono">' + esc(server.projectDir) + '</span>' : 'Local server not running: start it with <span class="mono">node server.js --project &lt;dir&gt;</span> to write files.';
    $('#btn-write').disabled = !!r.errors.length || !server;
    $('#btn-write').hidden = false;
    $('.modal-body').style.display = '';
    const old = $('.result');
    if (old) old.remove();
    $('#modal').hidden = false;
  }

  function closeModal() {
    $('#modal').hidden = true;
  }

  async function writeToProject() {
    if (!server || !lastGen) return;
    $('#btn-write').disabled = true;
    try {
      const res = await api('POST', '/api/generate', { design });
      server = await api('GET', '/api/info');
      loadLibrary();
      showResult(res);
    } catch (e) {
      $('#btn-write').disabled = false;
      toast(e.message + (e.details && e.details.length ? ': ' + e.details.join(' ') : ''), true);
    }
  }

  function showResult(res) {
    $('#modal-title').textContent = 'Workflow written to your project';
    $('.modal-body').style.display = 'none';
    $('#modal-issues').innerHTML = '';
    $('#btn-write').hidden = true;
    const div = document.createElement('div');
    div.className = 'result';
    const q = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
    div.innerHTML =
      '<h3>✓ ' + res.written.length + ' files written</h3>' +
      '<ul>' + res.written.map((f) => '<li class="mono">' + esc(f) + '</li>').join('') + '</ul>' +
      (res.backedUp && res.backedUp.length ? '<p class="note warn">These hand-written files had the same name as generated agents and were backed up before being replaced:</p><ul>' + res.backedUp.map((f) => '<li class="mono">' + esc(f) + '</li>').join('') + '</ul>' : '') +
      (res.removed.length ? '<p>Removed agents that are no longer in the design:</p><ul>' + res.removed.map((f) => '<li class="mono">' + esc(f) + '</li>').join('') + '</ul>' : '') +
      '<h3>Run it</h3>' +
      '<p>Open a fresh Claude Code session in the project. The SessionStart hook tells it to act as the orchestrator and run every task through your workflow:</p>' +
      '<pre>cd ' + esc(q(res.projectDir)) + '\nclaude</pre>' +
      '<p>Or start a run directly on a task:</p>' +
      '<pre>.agent/run.sh "describe the task"' + (design.goal ? '\n.agent/run.sh            # runs the default goal' : '') + '</pre>' +
      '<p>Inside any session you can also type <code>/' + G.SKILL_NAME + ' &lt;task&gt;</code>. Already-open sessions need a restart to pick up new agents.</p>' +
      (server && !server.git && design.nodes.some((n) => n.isolation === 'worktree') ? '<p class="note warn">This project is not a git repository yet. Run <code>git init &amp;&amp; git commit --allow-empty -m init</code> before using worktree agents.</p>' : '') +
      (server && server.git && !server.commits && design.nodes.some((n) => n.isolation === 'worktree') ? '<p class="note warn">Make at least one commit before using worktree agents.</p>' : '');
    $('.modal-card').insertBefore(div, $('.modal-foot'));
    toast('Generated ' + design.nodes.length + ' agents');
  }

  // ------------------------------------------------------------ dialog
  let dialogCleanup = null;
  function openDialog(title, bodyHtml, footHtml, wide) {
    if (dialogCleanup) dialogCleanup();
    dialogCleanup = null;
    $('#dialog-title').textContent = title;
    $('#dialog-body').innerHTML = bodyHtml;
    $('#dialog-foot').innerHTML = footHtml || '';
    $('.dialog-card').classList.toggle('wide', !!wide);
    $('#dialog').hidden = false;
    return $('#dialog-body');
  }
  function closeDialog() {
    if (dialogCleanup) dialogCleanup();
    dialogCleanup = null;
    $('#dialog').hidden = true;
  }

  // Shows a spinner with elapsed seconds on a button (or element) until stop() is called.
  function busy(el, text) {
    const original = el.innerHTML;
    const t0 = Date.now();
    el.disabled = true;
    el.classList.add('busy');
    const tick = () => (el.innerHTML = '<span class="spin"></span>' + esc(text) + ' ' + Math.round((Date.now() - t0) / 1000) + 's');
    tick();
    const iv = setInterval(tick, 1000);
    return () => {
      clearInterval(iv);
      el.disabled = false;
      el.classList.remove('busy');
      el.innerHTML = original;
    };
  }

  function modelSelect(id) {
    const cur = aiModel();
    return '<select id="' + id + '" style="width:auto">' + ['sonnet', 'opus', 'haiku', 'fable'].map((m) => '<option' + (m === cur ? ' selected' : '') + '>' + m + '</option>').join('') + '</select>';
  }

  // ------------------------------------------------------------ custom agent types ("My agents")
  function readGlobalCustom() {
    try {
      return JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]');
    } catch (_) {
      return [];
    }
  }
  function customTypes() {
    const map = {};
    for (const c of readGlobalCustom()) map[c.id] = c;
    for (const c of design.library || []) map[c.id] = c;
    return Object.values(map).sort((a, b) => a.label.localeCompare(b.label));
  }
  function saveCustom(c) {
    design.library = (design.library || []).filter((x) => x.id !== c.id).concat(c);
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(readGlobalCustom().filter((x) => x.id !== c.id).concat(c)));
    changed();
    renderCustomList();
  }
  function deleteCustom(id) {
    design.library = (design.library || []).filter((x) => x.id !== id);
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(readGlobalCustom().filter((x) => x.id !== id)));
    changed();
    renderCustomList();
  }
  function customFromNode(n) {
    return {
      id: uid('c'),
      label: n.label,
      role: n.role === 'orchestrator' ? 'custom' : n.role,
      color: n.color || G.ROLES[n.role].color,
      description: n.description || '',
      prompt: n.prompt || '',
      tools: (n.tools || []).slice(),
      model: n.model || 'inherit',
      skills: (n.skills || []).slice(),
    };
  }

  function renderCustomList() {
    const list = $('#custom-list');
    const items = customTypes();
    $('#custom-hint').hidden = items.length > 0;
    list.innerHTML = '';
    for (const c of items) {
      const el = document.createElement('div');
      el.className = 'pal-item';
      el.draggable = true;
      el.style.setProperty('--c', 'var(' + ROLE_COLORS[c.color || 'red'] + ')');
      el.innerHTML =
        '<span class="dot"></span><b>' + esc(c.label) + '</b><small>' + esc(c.description || G.ROLES[c.role].blurb) + '</small>' +
        '<span></span><span class="c-actions" style="display:flex;gap:4px;margin-top:4px"><button class="mini" data-act="edit">Edit</button><button class="mini" data-act="del">Delete</button></span>';
      el.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('application/x-agent-custom', c.id);
        ev.dataTransfer.setData('text/plain', c.label);
        ev.dataTransfer.effectAllowed = 'copy';
      });
      el.addEventListener('dblclick', () => {
        const r2 = canvas.getBoundingClientRect();
        addCustomNode(c, toWorld(r2.left + r2.width / 2, r2.top + r2.height / 2));
      });
      el.querySelector('[data-act=edit]').addEventListener('click', () => openCustomEditor(c));
      el.querySelector('[data-act=del]').addEventListener('click', () => {
        if (confirm('Delete the custom agent "' + c.label + '"? Nodes already on the canvas stay.')) deleteCustom(c.id);
      });
      list.appendChild(el);
    }
  }

  function addCustomNode(c, pt) {
    addNode(c.role || 'custom', pt, {
      label: c.label,
      color: c.color,
      description: c.description,
      prompt: c.prompt,
      tools: (c.tools || []).slice(),
      model: c.model || 'inherit',
      skills: (c.skills || []).slice(),
    });
  }

  function openCustomEditor(c) {
    const isNew = !customTypes().some((x) => x.id === c.id);
    c = clone(c);
    const roleOpts = Object.entries(G.ROLES).filter(([k]) => k !== 'orchestrator').map(([k, v]) => '<option value="' + k + '"' + (k === c.role ? ' selected' : '') + '>' + esc(v.title) + '</option>').join('');
    const modelOpts = G.MODELS.map((m) => '<option' + (m === c.model ? ' selected' : '') + '>' + m + '</option>').join('');
    const body = openDialog(
      isNew ? 'New custom agent' : 'Edit custom agent',
      '<div id="ce-ai"></div>' +
        '<div class="row">' + field('Name', '<input id="ce-label" value="' + esc(c.label) + '" placeholder="e.g. API Designer">') + field('Based on role', '<select id="ce-role">' + roleOpts + '</select>', 'Sets defaults and how its output is routed.') + '</div>' +
        field('Color', '<div class="swatches">' + G.COLORS.map((col) => '<button type="button" class="swatch' + (col === c.color ? ' on' : '') + '" data-color="' + col + '" style="--c:var(' + ROLE_COLORS[col] + ')" aria-label="' + col + '"></button>').join('') + '</div>') +
        '<div class="field"><div class="lbl row-h">What does this agent do?<button id="ce-refine" class="ai mini"' + (aiStatus.ok ? '' : ' disabled title="' + esc(aiStatus.error || '') + '"') + '>✨ Refine with Claude</button></div><textarea id="ce-desc" rows="3" placeholder="A sentence or two.">' + esc(c.description) + '</textarea></div>' +
        field('Instructions (agent prompt)', '<textarea id="ce-prompt" rows="9" placeholder="Optional: detailed instructions. Leave empty for role defaults, or let Claude write them.">' + esc(c.prompt) + '</textarea>') +
        '<div class="row">' + field('Model', '<select id="ce-model">' + modelOpts + '</select>') + '<div></div></div>' +
        field('Tools', '<div class="chips" id="ce-tools">' + G.ALL_TOOLS.map((t) => '<label class="chip' + (c.tools.includes(t) ? ' on' : '') + '"><input type="checkbox" value="' + t + '"' + (c.tools.includes(t) ? ' checked' : '') + '>' + t + '</label>').join('') + '</div>') +
        field('Skills', '<div class="chips" id="ce-skills">' + (library.skills.filter((s) => !s.managed).map((s) => '<label class="chip' + (c.skills.includes(s.name) ? ' on' : '') + '" title="' + esc(s.description) + '"><input type="checkbox" value="' + esc(s.name) + '"' + (c.skills.includes(s.name) ? ' checked' : '') + '>' + esc(s.name) + '</label>').join('') || '<span class="muted">No skills found.</span>') + '</div>'),
      '<span class="muted">Saved to My agents in this design and in this browser.</span><div class="spacer"></div><button id="ce-cancel">Cancel</button><button id="ce-save" class="primary">' + (isNew ? 'Create agent' : 'Save') + '</button>'
    );
    const read = () => {
      c.label = $('#ce-label').value.trim() || 'Custom agent';
      c.role = $('#ce-role').value;
      c.description = $('#ce-desc').value.trim();
      c.prompt = $('#ce-prompt').value.trim();
      c.model = $('#ce-model').value;
      c.tools = Array.from(body.querySelectorAll('#ce-tools input:checked')).map((i) => i.value);
      c.skills = Array.from(body.querySelectorAll('#ce-skills input:checked')).map((i) => i.value);
      return c;
    };
    body.querySelectorAll('.chip input').forEach((i) => i.addEventListener('change', () => i.parentElement.classList.toggle('on', i.checked)));
    body.querySelectorAll('.swatch').forEach((b) =>
      b.addEventListener('click', () => {
        body.querySelectorAll('.swatch').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        c.color = b.dataset.color;
      })
    );
    $('#ce-role').addEventListener('change', (ev) => {
      const r = G.ROLES[ev.target.value];
      body.querySelectorAll('#ce-tools input').forEach((i) => {
        i.checked = r.tools.includes(i.value);
        i.parentElement.classList.toggle('on', i.checked);
      });
    });
    $('#ce-refine').addEventListener('click', async () => {
      const cur = read();
      if (!cur.description && !cur.prompt) return toast('Describe the agent first', true);
      const stop = busy($('#ce-refine'), 'Refining…');
      try {
        const res = await api('POST', '/api/ai/refine', { node: cur, workflow: { name: design.name, goal: design.goal, note: 'Reusable custom agent type' }, model: aiModel() });
        const s = res.suggestion;
        $('#ce-label').value = s.label || cur.label;
        $('#ce-desc').value = s.description;
        $('#ce-prompt').value = s.prompt;
        $('#ce-model').value = s.model;
        body.querySelectorAll('#ce-tools input').forEach((i) => {
          i.checked = s.tools.includes(i.value);
          i.parentElement.classList.toggle('on', i.checked);
        });
        body.querySelectorAll('#ce-skills input').forEach((i) => {
          i.checked = s.skills.includes(i.value);
          i.parentElement.classList.toggle('on', i.checked);
        });
        $('#ce-ai').innerHTML = '<div class="ai-note">✨ ' + esc(s.notes) + ' <span class="muted">Review the fields below before saving.</span></div>';
      } catch (e) {
        toast('Refine failed: ' + e.message, true);
      } finally {
        stop();
      }
    });
    $('#ce-cancel').addEventListener('click', closeDialog);
    $('#ce-save').addEventListener('click', () => {
      saveCustom(read());
      closeDialog();
      toast((isNew ? 'Created' : 'Saved') + ' "' + c.label + '". Drag it from My agents onto the canvas.');
    });
    setTimeout(() => $('#ce-label').focus(), 30);
  }

  // ------------------------------------------------------------ library: existing agents & skills
  async function loadLibrary() {
    if (!server) return;
    try {
      library = await api('GET', '/api/library');
    } catch (e) {
      library = { agents: [], skills: [] };
    }
    renderLibrary();
    updateStatus();
  }

  function renderLibrary() {
    renderAgentLib();
    renderSkillLib();
    $('#agents-count').textContent = server ? library.agents.length : '';
    $('#skills-count').textContent = server ? library.skills.length : '';
  }

  function canvasNodeForAgent(name) {
    const names = normalizedNames();
    return design.nodes.find((n) => names[n.id] === name && n.role !== 'orchestrator');
  }

  function addExistingNode(name, pt) {
    const a = libAgent(name);
    if (!a) return;
    const on = canvasNodeForAgent(name);
    if (on) {
      select({ type: 'node', id: on.id });
      return toast('"' + name + '" is already on the canvas');
    }
    addNode(G.guessRole(a), pt, {
      label: a.name,
      name: a.name,
      source: 'existing',
      description: a.description,
      model: G.MODELS.includes(a.model) ? a.model : 'inherit',
      tools: a.tools.length ? a.tools.filter((t) => G.ALL_TOOLS.includes(t)) : G.ALL_TOOLS.slice(),
      skills: a.skills.slice(),
      color: G.COLORS.includes(a.color) ? a.color : '',
    });
  }

  function renderAgentLib() {
    const box = $('#agent-lib');
    if (!server) return (box.innerHTML = '<div class="empty">Start the local server to see existing agents.</div>');
    if (!library.agents.length) return (box.innerHTML = '<div class="empty">No agents in .claude/agents or ~/.claude/agents yet.</div>');
    box.innerHTML = '';
    for (const scope of ['project', 'user']) {
      const items = library.agents.filter((a) => a.scope === scope);
      if (!items.length) continue;
      const h = document.createElement('div');
      h.className = 'lib-group';
      h.textContent = scope === 'project' ? 'Project · .claude/agents' : 'User · ~/.claude/agents';
      box.appendChild(h);
      for (const a of items) {
        const on = canvasNodeForAgent(a.name);
        const el = document.createElement('div');
        el.className = 'card' + (on && selection && selection.id === on.id ? ' hl' : '');
        el.draggable = !a.managed;
        el.innerHTML =
          '<div class="c-head"><span class="dot" style="--c:var(' + (ROLE_COLORS[a.color] || '--muted') + ')"></span><span class="c-name">' + esc(a.name) + '</span>' +
          (a.managed ? '<span class="tag gen" title="Generated from this workflow">workflow</span>' : '') + (on ? '<span class="tag on">on canvas</span>' : '') + '</div>' +
          '<div class="c-desc">' + esc(a.description || 'No description.') + '</div>' +
          (a.skills.length ? '<div class="mini-chips">' + a.skills.map((s) => '<span class="mchip skill">⚡ ' + esc(s) + '</span>').join('') + '</div>' : '') +
          '<div class="c-actions">' +
          (a.managed ? (on ? '<button data-act="select">Select node</button>' : '') : '<button data-act="edit">Edit</button><button data-act="history">History</button>' + (on ? '<button data-act="select">Select node</button>' : '<button data-act="add">Add to canvas</button>')) +
          '</div>';
        el.addEventListener('dragstart', (ev) => {
          ev.dataTransfer.setData('application/x-agent-existing', a.name);
          ev.dataTransfer.setData('text/plain', a.name);
          ev.dataTransfer.effectAllowed = 'copy';
        });
        const act = (k, fn) => {
          const b = el.querySelector('[data-act=' + k + ']');
          if (b) b.addEventListener('click', fn);
        };
        act('edit', () => openFileEditor(a.path, a.name));
        act('history', () => openHistory(a.path, a.name));
        act('select', () => select({ type: 'node', id: on.id }));
        act('add', () => {
          const r2 = canvas.getBoundingClientRect();
          addExistingNode(a.name, toWorld(r2.left + r2.width / 2, r2.top + r2.height / 2));
        });
        box.appendChild(el);
      }
    }
  }

  function renderSkillLib() {
    const box = $('#skill-lib');
    if (!server) return (box.innerHTML = '<div class="empty">Start the local server to see installed skills.</div>');
    const q = $('#skill-filter').value.trim().toLowerCase();
    const sel = selection && selection.type === 'node' ? node(selection.id) : null;
    const canEquip = sel && sel.role !== 'orchestrator' && sel.source !== 'existing';
    const equipped = (name) => design.nodes.filter((n) => (n.skills || []).includes(name));
    const fromFiles = (name) => library.agents.filter((a) => !a.managed && a.skills.includes(name) && !canvasNodeForAgent(a.name));
    let items = library.skills.filter((s) => !q || (s.name + ' ' + s.description).toLowerCase().includes(q));
    // Canvas-referenced skills that are not installed still show up, flagged as missing.
    const missing = Array.from(new Set(design.nodes.flatMap((n) => n.skills || []))).filter((n) => !library.skills.some((s) => s.name === n));
    items = items.concat(missing.filter((n) => !q || n.includes(q)).map((n) => ({ name: n, description: 'Not installed: no SKILL.md found for this name.', scope: 'missing', missing: true })));
    items.sort((a, b) => equipped(b.name).length + fromFiles(b.name).length - (equipped(a.name).length + fromFiles(a.name).length) || a.name.localeCompare(b.name));
    if (!items.length) return (box.innerHTML = '<div class="empty">' + (q ? 'No skills match.' : 'No skills in .claude/skills or ~/.claude/skills.') + '</div>');
    box.innerHTML = '';
    for (const s of items) {
      const eq = equipped(s.name);
      const ff = fromFiles(s.name);
      const has = sel && (sel.skills || []).includes(s.name);
      const el = document.createElement('div');
      el.className = 'card' + (has ? ' hl' : '');
      el.innerHTML =
        '<div class="c-head"><span class="c-name">⚡ ' + esc(s.name) + '</span>' + (s.missing ? '<span class="tag" style="color:var(--danger)">missing</span>' : '<span class="tag">' + esc(s.scope) + '</span>') + (s.managed ? '<span class="tag gen">workflow</span>' : '') + '</div>' +
        '<div class="c-desc">' + esc(s.description || '') + '</div>' +
        '<div class="mini-chips">' +
        (eq.length || ff.length
          ? eq.map((n) => '<span class="mchip agentchip" data-node="' + n.id + '" style="--c:' + nodeColor(n) + '">' + esc(n.label) + '</span>').join('') + ff.map((a) => '<span class="mchip" title="Agent file ' + esc(a.path) + '">' + esc(a.name) + '</span>').join('')
          : '<span class="muted" style="font-size:11px">No agent equipped.</span>') +
        '</div>' +
        '<div class="c-actions">' + (s.missing ? '' : '<button data-act="view">' + (s.managed ? 'View' : 'View / edit') + '</button>' + (s.managed ? '' : '<button data-act="history">History</button>')) +
        (canEquip && !s.managed ? '<button data-act="toggle">' + (has ? 'Remove from ' : 'Equip ') + esc(sel.label) + '</button>' : '') + '</div>';
      el.querySelectorAll('[data-node]').forEach((c) => c.addEventListener('click', () => select({ type: 'node', id: c.dataset.node })));
      const v = el.querySelector('[data-act=view]');
      if (v) v.addEventListener('click', () => openFileEditor(s.path, s.name));
      const hb = el.querySelector('[data-act=history]');
      if (hb) hb.addEventListener('click', () => openHistory(s.path, s.name));
      const t = el.querySelector('[data-act=toggle]');
      if (t)
        t.addEventListener('click', () => {
          snapshot();
          sel.skills = has ? sel.skills.filter((x) => x !== s.name) : (sel.skills || []).concat(s.name);
          changed();
          renderInspector();
          renderSkillLib();
        });
      box.appendChild(el);
    }
  }

  async function openFileEditor(path, name) {
    let f;
    try {
      f = await api('GET', '/api/file?path=' + encodeURIComponent(path));
    } catch (e) {
      return toast(e.message, true);
    }
    const generated = f.content.includes(G.MARKER);
    openDialog(
      'Edit ' + name,
      '<div class="kv mono" style="word-break:break-all;margin-bottom:8px">' + esc(path) + '</div>' +
        (generated ? '<div class="note warn">This file is generated from the workflow design and will be overwritten the next time you generate. Change the node on the canvas instead.</div>' : '') +
        '<textarea id="fe-text" class="code" spellcheck="false">' + esc(f.content) + '</textarea>',
      '<span class="muted">Changes apply to new Claude Code sessions. The previous version is kept.</span><div class="spacer"></div><button id="fe-history">History…</button><button id="fe-cancel">Cancel</button><button id="fe-save" class="primary">Save file</button>',
      true
    );
    $('#fe-cancel').addEventListener('click', closeDialog);
    $('#fe-history').addEventListener('click', () => openHistory(path, name));
    $('#fe-save').addEventListener('click', async () => {
      try {
        library = await api('POST', '/api/file', { path, content: $('#fe-text').value });
        syncExistingNodes(); // keep linked canvas nodes in sync with the edited file
        closeDialog();
        changed();
        renderLibrary();
        renderInspector();
        toast('Saved ' + name);
      } catch (e) {
        toast(e.message, true);
      }
    });
  }

  // ------------------------------------------------------------ AI: refine one agent
  // onApply(values) is given for existing agents: the result goes into the file form instead of the node.
  async function refineNode(n, onApply) {
    if (!n.description && !n.prompt) return toast('Write a short description first, then refine it', true);
    const btn = $('#a-refine');
    const stop = busy(btn, 'Refining…');
    const ctxIn = design.edges.filter((e) => e.to === n.id).map((e) => ({ from: node(e.from).label, role: node(e.from).role, link: e.kind }));
    const ctxOut = design.edges.filter((e) => e.from === n.id).map((e) => ({ to: node(e.to).label, role: node(e.to).role, link: e.kind, condition: e.condition }));
    try {
      const res = await api('POST', '/api/ai/refine', { node: n, workflow: { name: design.name, goal: design.goal, receivesFrom: ctxIn, sendsTo: ctxOut }, model: aiModel() });
      showRefine(n, res.suggestion, res.cost, onApply);
    } catch (e) {
      toast('Refine failed: ' + e.message, true);
    } finally {
      if (document.body.contains(btn)) stop();
    }
  }

  function showRefine(n, s, cost, onApply) {
    const r = G.ROLES[n.role];
    const cur = n.prompt || (r.guidance.length ? '(' + r.title + ' role defaults)\n- ' + r.guidance.join('\n- ') : '(none: only the description is used)');
    const body = openDialog(
      'Refine "' + n.label + '"',
      '<div class="ai-note">✨ ' + esc(s.notes) + '</div>' +
        '<div class="cmp">' +
        '<div class="old"><h4>Current</h4>' +
        field('Name', '<pre>' + esc(n.label) + '</pre>') +
        field('Description', '<pre>' + esc(n.description || '—') + '</pre>') +
        field('Instructions', '<pre>' + esc(cur) + '</pre>') +
        field('Model · tools · skills', '<pre>' + esc(n.model + ' · ' + n.tools.join(', ') + ' · ' + ((n.skills || []).join(', ') || 'no skills')) + '</pre>') +
        '</div>' +
        '<div><h4>Suggested (editable)</h4>' +
        field('Name', '<input id="rf-label" value="' + esc(s.label) + '">') +
        field('Description', '<textarea id="rf-desc" rows="3">' + esc(s.description) + '</textarea>') +
        field('Instructions', '<textarea id="rf-prompt">' + esc(s.prompt) + '</textarea>') +
        field('Model', '<select id="rf-model">' + G.MODELS.map((m) => '<option' + (m === s.model ? ' selected' : '') + '>' + m + '</option>').join('') + '</select>') +
        field('Tools', '<div class="chips" id="rf-tools">' + G.ALL_TOOLS.map((t) => '<label class="chip' + (s.tools.includes(t) ? ' on' : '') + '"><input type="checkbox" value="' + t + '"' + (s.tools.includes(t) ? ' checked' : '') + '>' + t + '</label>').join('') + '</div>') +
        field('Skills', '<div class="chips" id="rf-skills">' + (Array.from(new Set(s.skills.concat(n.skills || []))).map((k) => '<label class="chip' + (s.skills.includes(k) ? ' on' : '') + '"><input type="checkbox" value="' + esc(k) + '"' + (s.skills.includes(k) ? ' checked' : '') + '>' + esc(k) + '</label>').join('') || '<span class="muted">No skills suggested.</span>') + '</div>') +
        '</div></div>',
      '<span class="muted">' + (cost ? 'Cost $' + cost.toFixed(3) + ' · ' : '') + 'model</span>' + modelSelect('rf-ai-model') + '<button id="rf-retry" class="ai">Try again</button><div class="spacer"></div><button id="rf-cancel">Discard</button><button id="rf-apply" class="primary">Apply to agent</button>',
      true
    );
    body.querySelectorAll('.chip input').forEach((i) => i.addEventListener('change', () => i.parentElement.classList.toggle('on', i.checked)));
    $('#rf-ai-model').addEventListener('change', (ev) => localStorage.setItem(AI_MODEL_KEY, ev.target.value));
    $('#rf-cancel').addEventListener('click', closeDialog);
    $('#rf-retry').addEventListener('click', async () => {
      const stop = busy($('#rf-retry'), 'Refining…');
      try {
        const res = await api('POST', '/api/ai/refine', { node: n, workflow: { name: design.name, goal: design.goal }, model: aiModel() });
        showRefine(n, res.suggestion, res.cost, onApply);
      } catch (e) {
        stop();
        toast('Refine failed: ' + e.message, true);
      }
    });
    if (onApply) $('#rf-apply').textContent = 'Use in agent file form';
    $('#rf-apply').addEventListener('click', () => {
      if (onApply) {
        const v = {
          description: $('#rf-desc').value.trim(),
          prompt: $('#rf-prompt').value.trim(),
          model: $('#rf-model').value,
          tools: Array.from(body.querySelectorAll('#rf-tools input:checked')).map((i) => i.value),
          skills: Array.from(body.querySelectorAll('#rf-skills input:checked')).map((i) => i.value),
        };
        closeDialog();
        return onApply(v);
      }
      snapshot();
      n.label = $('#rf-label').value.trim() || n.label;
      n.description = $('#rf-desc').value.trim();
      n.prompt = $('#rf-prompt').value.trim();
      n.model = $('#rf-model').value;
      n.tools = Array.from(body.querySelectorAll('#rf-tools input:checked')).map((i) => i.value);
      n.skills = Array.from(body.querySelectorAll('#rf-skills input:checked')).map((i) => i.value);
      closeDialog();
      changed();
      renderInspector();
      toast('Applied the refined prompt to "' + n.label + '" (undo with ⌘Z)');
    });
  }

  // ------------------------------------------------------------ AI: design a flow from an idea
  const IDEA_KEY = 'agentviz.idea';
  const IDEA_EXAMPLES = [
    'Ship features in a TypeScript web app: plan, build in parallel worktrees, test, and get a security review before merging.',
    'Triage and fix failing CI tests: investigate the logs, find root causes, fix, and verify the whole suite passes.',
    'Write technical docs for an existing codebase: map the code, draft docs per module, and fact-check every claim against the code.',
    'Migrate a Python 2 codebase to Python 3 module by module, with tests proving behaviour did not change.',
  ];

  function openIdeaDialog() {
    if (!aiStatus.ok) return toast(aiStatus.error || 'AI features need the local server and the claude CLI', true);
    const body = openDialog(
      '✨ Design an agent flow from an idea',
      field('Describe what you want the agent team to do', '<textarea id="idea-text" rows="6" placeholder="e.g. Build features end to end with planning, parallel implementation and strict verification.">' + esc(localStorage.getItem(IDEA_KEY) || '') + '</textarea>',
        'Mention anything that matters: parallel work, how strict verification should be, reviews, research, models to use.') +
        '<div class="idea-examples">' + IDEA_EXAMPLES.map((x, i) => '<button data-ex="' + i + '">' + esc(x.split(':')[0]) + '</button>').join('') + '</div>' +
        '<label class="check" style="margin-top:14px"><input type="checkbox" id="idea-lib" checked><span>Reuse my existing agents and skills where they fit<small>' + library.agents.filter((a) => !a.managed).length + ' agents and ' + library.skills.filter((s) => !s.managed).length + ' skills are available to Claude.</small></span></label>',
      '<span class="muted">Model</span>' + modelSelect('idea-model') + '<div class="spacer"></div><button id="idea-cancel">Cancel</button><button id="idea-go" class="ai">✨ Design it</button>'
    );
    body.querySelectorAll('[data-ex]').forEach((b) => b.addEventListener('click', () => ($('#idea-text').value = IDEA_EXAMPLES[b.dataset.ex])));
    $('#idea-model').addEventListener('change', (ev) => localStorage.setItem(AI_MODEL_KEY, ev.target.value));
    $('#idea-cancel').addEventListener('click', closeDialog);
    $('#idea-go').addEventListener('click', async () => {
      const idea = $('#idea-text').value.trim();
      if (idea.length < 10) return toast('Describe the idea in a sentence or two', true);
      localStorage.setItem(IDEA_KEY, idea);
      const useLibrary = $('#idea-lib').checked;
      const stop = busy($('#idea-go'), 'Designing…');
      $('#idea-cancel').disabled = true;
      try {
        const res = await api('POST', '/api/ai/design', { idea, model: aiModel(), useLibrary });
        showDesignPreview(res);
      } catch (e) {
        stop();
        $('#idea-cancel').disabled = false;
        toast('Design failed: ' + e.message, true);
      }
    });
    setTimeout(() => $('#idea-text').focus(), 30);
  }

  function showDesignPreview(res) {
    const d = res.design;
    const v = G.validate(d);
    const byId = {};
    d.nodes.forEach((n) => (byId[n.id] = n));
    const runs = (n) => (n.role === 'orchestrator' ? 'main session' : n.perTask ? 'one per task' : n.instances > 1 ? '×' + n.instances : 'single');
    openDialog(
      '✨ Proposed flow: ' + d.name,
      '<div class="ai-note">' + esc(res.rationale) + '</div>' +
        '<h2>Agents</h2><ul class="plan-list">' +
        d.nodes.map((n) => '<li><span class="dot" style="--c:' + nodeColor(n) + '"></span> <b>' + esc(n.label) + '</b><span class="tag">' + esc(G.ROLES[n.role].title) + '</span> <span class="tag">' + runs(n) + '</span>' + (n.isolation === 'worktree' ? ' <span class="tag">worktree</span>' : '') + (n.source === 'existing' ? ' <span class="tag on">existing agent</span>' : '') + (n.model !== 'inherit' ? ' <span class="tag">' + esc(n.model) + '</span>' : '') + (n.skills.length ? ' <span class="tag">⚡ ' + esc(n.skills.join(', ')) + '</span>' : '') + '<div class="muted" style="margin-top:3px">' + esc(n.description) + '</div></li>').join('') +
        '</ul><h2>Flow</h2><ul class="plan-list">' +
        d.edges.map((e) => '<li>' + esc(byId[e.from].label) + ' → ' + esc(byId[e.to].label) + ' <span class="tag">' + esc(G.EDGE_KINDS[e.kind].label) + (e.kind === 'fail' ? ' ≤' + e.maxIterations : '') + '</span>' + (e.condition ? ' <span class="muted">' + esc(e.condition) + '</span>' : '') + '</li>').join('') + '</ul>' +
        (v.errors.length || v.warnings.length ? '<h2>Checks</h2>' + issuesHtml(v) : ''),
      '<span class="muted">' + (res.cost ? 'Cost $' + res.cost.toFixed(3) + ' · ' : '') + 'Replaces the current canvas (undo with ⌘Z).</span><div class="spacer"></div><button id="dp-back">Back</button><button id="dp-apply" class="primary">Apply to canvas</button>',
      true
    );
    $('#dp-back').addEventListener('click', openIdeaDialog);
    $('#dp-apply').addEventListener('click', () => {
      snapshot();
      const lib = design.library || [];
      loadDesign(Object.assign({}, d, { library: lib }), false);
      layoutNodes();
      changed();
      requestAnimationFrame(fit);
      closeDialog();
      toast('Applied "' + d.name + '". Click any agent to review or refine it.');
    });
  }

  // ------------------------------------------------------------ project import (existing agents + connections)
  function projectName() {
    return server ? server.projectDir.split(/[\\/]/).filter(Boolean).pop() : 'Project';
  }

  function showNotice(html, actions) {
    const el = $('#notice');
    $('#notice-text').innerHTML = html;
    const box = $('#notice-actions');
    box.innerHTML = '';
    for (const a of actions || []) {
      const b = document.createElement('button');
      b.className = a.cls || '';
      b.textContent = a.label;
      if (a.disabled) {
        b.disabled = true;
        b.title = a.disabled;
      }
      b.addEventListener('click', () => a.run(b));
      box.appendChild(b);
    }
    el.hidden = false;
  }
  function hideNotice() {
    $('#notice').hidden = true;
  }

  // Adds the imported agents (all, or only `onlyNames`) and every inferred link whose two ends are on the canvas.
  function mergeImport(d, imp, onlyNames) {
    const names = {};
    G.normalize(d).nodes.forEach((n) => (names[n.name] = n.id));
    let main = d.nodes.find((n) => n.role === 'orchestrator');
    const added = [];
    for (const a of imp.agents) {
      if (onlyNames && !onlyNames.includes(a.name)) continue;
      if (names[a.name]) continue;
      const id = uid('n');
      d.nodes.push({
        id,
        role: a.role === 'orchestrator' ? 'custom' : a.role,
        label: a.name,
        name: a.name,
        source: 'existing',
        description: a.description,
        model: G.MODELS.includes(a.model) ? a.model : 'inherit',
        tools: a.tools.length ? a.tools.filter((t) => G.ALL_TOOLS.includes(t)) : G.ALL_TOOLS.slice(),
        skills: a.skills.slice(),
        color: G.COLORS.includes(a.color) ? a.color : '',
        isolation: 'none',
        instances: 1,
        perTask: false,
        x: 0,
        y: 0,
      });
      names[a.name] = id;
      added.push(id);
    }
    const needMain = imp.edges.some((e) => (e.from === '@main' || e.to === '@main') && (added.includes(names[e.from]) || added.includes(names[e.to])));
    if (!main && needMain) {
      main = {
        id: uid('n'),
        role: 'orchestrator',
        label: 'Main session',
        name: '',
        description: 'The main Claude Code session. It spawns the project agents and routes their results.',
        model: 'inherit',
        tools: G.ALL_TOOLS.slice(),
        skills: [],
        isolation: 'none',
        instances: 1,
        perTask: false,
        x: 0,
        y: 0,
      };
      d.nodes.unshift(main);
      added.unshift(main.id);
    }
    const resolve = (n) => (n === '@main' ? main && main.id : names[n]);
    let edgesAdded = 0;
    for (const e of imp.edges) {
      const from = resolve(e.from);
      const to = resolve(e.to);
      if (!from || !to || from === to) continue;
      if (!added.includes(from) && !added.includes(to)) continue;
      if (d.edges.some((x) => x.from === from && x.to === to)) continue;
      d.edges.push({ id: uid('e'), from, to, kind: e.kind, condition: e.condition || '', maxIterations: e.maxIterations || 3, evidence: e.evidence || [] });
      edgesAdded++;
    }
    return { added, edgesAdded };
  }

  // Builds the canvas from the project's existing agents. Returns false when the project has none.
  async function importIntoCanvas() {
    let imp;
    try {
      imp = await api('GET', '/api/import');
    } catch (_) {
      return false;
    }
    if (!imp.agents.length) return false;
    const d = { name: projectName() + ' agents', goal: '', settings: {}, nodes: [], edges: [], library: design ? design.library || [] : [] };
    const r = mergeImport(d, imp);
    loadDesign(d, false);
    layoutNodes();
    changed();
    requestAnimationFrame(fit);
    const docs = imp.scanned.filter((f) => !f.startsWith('.claude/agents/'));
    const lonely = design.nodes.filter((n) => !design.edges.some((e) => e.from === n.id || e.to === n.id)).length;
    showNotice(
      'Loaded <b>' + imp.agents.length + ' existing agents</b> from <span class="mono">.claude/agents</span> with <b>' + r.edgesAdded + ' connections</b> inferred from their definitions' +
        (docs.length ? ' and ' + docs.length + ' doc' + (docs.length > 1 ? 's' : '') : '') + '. Click a link to see what it was inferred from.' +
        (lonely ? ' ' + lonely + ' agent' + (lonely > 1 ? 's have' : ' has') + ' no detected connection.' : ''),
      [{ label: '✨ Infer connections with Claude', cls: 'ai', disabled: aiStatus.ok ? '' : aiStatus.error || 'AI unavailable', run: aiConnect }]
    );
    return true;
  }

  // On a saved design, point out project agents that are not part of it.
  function offerMissingAgents() {
    if (!server) return;
    const onCanvas = new Set(Object.values(normalizedNames()));
    const missing = library.agents.filter((a) => a.scope === 'project' && !a.managed && !onCanvas.has(a.name)).map((a) => a.name);
    if (!missing.length) return hideNotice();
    showNotice(
      '<b>' + missing.length + ' agent' + (missing.length > 1 ? 's' : '') + '</b> in this project ' + (missing.length > 1 ? 'are' : 'is') + ' not in this workflow: <span class="mono">' + esc(missing.join(', ')) + '</span>.',
      [
        {
          label: 'Add with their connections',
          cls: 'primary',
          run: async () => {
            const imp = await api('GET', '/api/import');
            snapshot();
            const bottom = Math.max(0, ...design.nodes.map((n) => n.y + (sizes[n.id] ? sizes[n.id].h : 140))) + 120;
            const r = mergeImport(design, imp, missing);
            r.added.forEach((id, i) => Object.assign(node(id), { x: 40 + i * 270, y: bottom }));
            changed();
            requestAnimationFrame(fit);
            hideNotice();
            toast('Added ' + r.added.length + ' agents and ' + r.edgesAdded + ' inferred links (undo with ⌘Z)');
          },
        },
      ]
    );
  }

  async function openProjectCanvas() {
    hideNotice();
    snapshot();
    if (server.hasDesign) {
      loadDesign(await api('GET', '/api/design'), true);
      toast('Loaded the saved workflow from .agent/workflow.json');
      offerMissingAgents();
      return;
    }
    if (await importIntoCanvas()) return;
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(storeKey()) || 'null');
    } catch (_) {}
    if (saved) {
      loadDesign(saved, true);
      toast('No agents in this project yet. Restored your last unsaved canvas for it.');
    } else {
      renderInspector();
      toast('No agents in this project yet. The current canvas is kept: generate it here, or start from a template or an idea.');
    }
  }

  async function aiConnect(btn) {
    const ex = design.nodes.filter((n) => n.source === 'existing');
    if (!ex.length) return toast('No existing agents on the canvas to connect', true);
    const stop = btn ? busy(btn, 'Inferring…') : () => {};
    try {
      const res = await api('POST', '/api/ai/connect', { names: ex.map((n) => n.name), model: aiModel() });
      stop();
      showConnectPreview(res);
    } catch (e) {
      stop();
      toast('Infer failed: ' + e.message, true);
    }
  }

  function showConnectPreview(res) {
    const label = (n) => (n === '@main' ? 'Main session' : n);
    openDialog(
      '✨ Connections inferred by Claude',
      '<div class="ai-note">' + esc(res.rationale) + '</div><ul class="plan-list">' +
        res.edges.map((e) => '<li><b>' + esc(label(e.from)) + '</b> → <b>' + esc(label(e.to)) + '</b> <span class="tag">' + esc(G.EDGE_KINDS[e.kind].label) + (e.kind === 'fail' ? ' ≤' + e.maxIterations : '') + '</span>' + (e.condition ? ' <span class="muted">' + esc(e.condition) + '</span>' : '') + '<div class="muted" style="margin-top:3px">' + esc(e.evidence[0].text) + '</div></li>').join('') +
        '</ul>',
      '<span class="muted">' + (res.cost ? 'Cost $' + res.cost.toFixed(3) + ' · ' : '') + 'Replaces the links between these agents (undo with ⌘Z).</span><div class="spacer"></div><button id="cp-cancel">Cancel</button><button id="cp-apply" class="primary">Apply links</button>',
      true
    );
    $('#cp-cancel').addEventListener('click', closeDialog);
    $('#cp-apply').addEventListener('click', () => {
      snapshot();
      const involved = new Set(design.nodes.filter((n) => n.source === 'existing' || n.role === 'orchestrator').map((n) => n.id));
      design.edges = design.edges.filter((e) => !(involved.has(e.from) && involved.has(e.to)));
      const ids = {};
      G.normalize(design).nodes.forEach((n) => (ids[n.name] = n.id));
      const main = design.nodes.find((n) => n.role === 'orchestrator');
      const resolve = (n) => (n === '@main' ? main && main.id : ids[n]);
      for (const e of res.edges) {
        const from = resolve(e.from);
        const to = resolve(e.to);
        if (!from || !to || design.edges.some((x) => x.from === from && x.to === to)) continue;
        design.edges.push({ id: uid('e'), from, to, kind: e.kind, condition: e.condition || '', maxIterations: e.maxIterations || 3, evidence: e.evidence });
      }
      layoutNodes();
      changed();
      requestAnimationFrame(fit);
      closeDialog();
      hideNotice();
      toast('Applied ' + res.edges.length + ' links from Claude (undo with ⌘Z)');
    });
  }

  // ------------------------------------------------------------ misc UI
  let toastTimer = null;
  function toast(msg, err) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (err ? ' err' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), err ? 5000 : 2600);
  }

  function exportDesign() {
    const blob = new Blob([JSON.stringify(G.normalize(design), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = G.slugify(design.name) + '.workflow.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function wire() {
    $('#wf-name').addEventListener('input', (ev) => {
      snapshotDebounced();
      design.name = ev.target.value;
      changed();
    });
    $('#tpl-select').addEventListener('change', (ev) => {
      const t = T.list.find((x) => x.id === ev.target.value);
      ev.target.value = '';
      if (!t) return;
      if (design.nodes.length && !confirm('Replace the current canvas with "' + t.title + '"? (You can undo.)')) return;
      snapshot();
      loadDesign(t.design, true);
    });
    $('#btn-layout').addEventListener('click', autoLayout);
    $('#btn-undo').addEventListener('click', undo);
    $('#btn-redo').addEventListener('click', redo);
    $('#btn-export').addEventListener('click', exportDesign);
    $('#btn-import').addEventListener('click', () => $('#file-input').click());
    $('#file-input').addEventListener('change', async (ev) => {
      const f = ev.target.files[0];
      ev.target.value = '';
      if (!f) return;
      try {
        const d = JSON.parse(await f.text());
        if (!Array.isArray(d.nodes)) throw new Error('Not a workflow file (no nodes)');
        snapshot();
        loadDesign(d, true);
        toast('Imported ' + f.name);
      } catch (e) {
        toast('Import failed: ' + e.message, true);
      }
    });
    $('#project-chip').addEventListener('click', changeProject);
    $('#btn-generate').addEventListener('click', openModal);
    $('#modal-close').addEventListener('click', closeModal);
    $('#modal').addEventListener('pointerdown', (ev) => {
      if (ev.target.id === 'modal') closeModal();
    });
    $('#btn-write').addEventListener('click', writeToProject);
    $('#zoom-in').addEventListener('click', () => {
      const r = canvas.getBoundingClientRect();
      zoomAt(view.k * 1.2, r.left + r.width / 2, r.top + r.height / 2);
    });
    $('#zoom-out').addEventListener('click', () => {
      const r = canvas.getBoundingClientRect();
      zoomAt(view.k / 1.2, r.left + r.width / 2, r.top + r.height / 2);
    });
    $('#zoom-fit').addEventListener('click', fit);
    $('#status').addEventListener('click', () => select(null));
    document.querySelectorAll('.tab').forEach((t) =>
      t.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
        document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== t.dataset.tab));
        if (t.dataset.tab !== 'build') loadLibrary();
      })
    );
    $('#btn-new-custom').addEventListener('click', () =>
      openCustomEditor({ id: uid('c'), label: '', role: 'custom', color: 'red', description: '', prompt: '', tools: G.ROLES.custom.tools.slice(), model: 'inherit', skills: [] })
    );
    $('#btn-refresh-lib').addEventListener('click', loadLibrary);
    $('#btn-refresh-lib2').addEventListener('click', loadLibrary);
    $('#skill-filter').addEventListener('input', renderSkillLib);
    $('#btn-ai-design').addEventListener('click', openIdeaDialog);
    $('#notice-close').addEventListener('click', hideNotice);
    $('#dialog-close').addEventListener('click', closeDialog);
    $('#dialog').addEventListener('pointerdown', (ev) => {
      if (ev.target.id === 'dialog') closeDialog();
    });
    window.addEventListener('resize', applyView);
  }

  async function init() {
    renderMarkers();
    renderPalette();
    wire();
    applyView();
    let initial = null;
    try {
      server = await api('GET', '/api/info');
      if (server.hasDesign) initial = await api('GET', '/api/design');
    } catch (_) {
      server = null;
    }
    updateProjectChip();
    if (server) {
      try {
        library = await api('GET', '/api/library');
      } catch (_) {}
      try {
        aiStatus = await api('GET', '/api/ai/status');
        if (!aiStatus.ok) $('#btn-ai-design').title = aiStatus.error;
      } catch (_) {}
    }
    if (initial) {
      loadDesign(initial, true);
      offerMissingAgents();
      return;
    }
    if (server && (await importIntoCanvas(false))) return;
    try {
      initial = JSON.parse(localStorage.getItem(storeKey()) || 'null');
    } catch (_) {}
    loadDesign(initial || T.list[0].design, true);
  }

  // Exposed for automated UI tests.
  window.__agentviz = {
    get design() { return design; },
    get library() { return library; },
    addNode: (role, x, y) => addNode(role, { x, y }),
    addEdge,
    select,
    generate: () => G.generate(design),
  };

  init();
})();
