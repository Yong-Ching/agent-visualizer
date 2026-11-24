/* Starter workflow designs. Shared by the browser (window.AgentTemplates) and Node tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgentTemplates = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ALL = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookEdit'];
  const RO = ['Read', 'Grep', 'Glob', 'Bash'];

  function n(id, role, label, x, y, description, extra) {
    return Object.assign({ id, role, label, name: '', x, y, description, model: 'inherit', tools: role === 'worker' || role === 'tester' || role === 'orchestrator' || role === 'custom' ? ALL.slice() : RO.slice(), isolation: 'none', instances: 1, perTask: false }, extra || {});
  }
  function e(id, from, to, kind, extra) {
    return Object.assign({ id, from, to, kind, condition: '', maxIterations: 3 }, extra || {});
  }

  const simple = {
    name: 'Simple pipeline',
    goal: '',
    settings: { maxParallel: 4, maxRounds: 3, autoStart: true, runLog: true, mergeWorktrees: true },
    nodes: [
      n('n1', 'orchestrator', 'Manager', 60, 200, 'Chief of staff. Clarify the task, hand it to the planner, and make sure the verified result is reported back to the user.'),
      n('n2', 'planner', 'Task Planner', 360, 200, 'Plan how the work should be delegated: split the task into concrete work packages with acceptance criteria.'),
      n('n3', 'worker', 'Worker', 660, 200, 'Implement the planned work packages in the codebase and run the tests.'),
      n('n4', 'verifier', 'Verifier', 960, 200, 'Verify the implementation against the acceptance criteria and report the verdict back to the manager.'),
    ],
    edges: [e('e1', 'n1', 'n2', 'handoff'), e('e2', 'n2', 'n3', 'handoff'), e('e3', 'n3', 'n4', 'handoff'), e('e4', 'n4', 'n1', 'report')],
  };

  const loop = {
    name: 'Parallel build with verification loop',
    goal: '',
    settings: { maxParallel: 4, maxRounds: 3, autoStart: true, runLog: true, mergeWorktrees: true },
    nodes: [
      n('n1', 'orchestrator', 'Chief of Staff', 40, 220, 'Owns the outcome. Gets the task, sends it to the planner, runs the workers in parallel worktrees, routes failures back, merges passing branches and reports to the user.'),
      n('n2', 'planner', 'Task Planner', 320, 220, 'Read the codebase and split the task into independent work packages (no two packages edit the same file), each with acceptance criteria and the test command to prove it.'),
      n('n3', 'worker', 'Implementer', 600, 220, 'Implement exactly one work package inside its own git worktree. Add or update tests for it, run them, and commit.', { isolation: 'worktree', perTask: true }),
      n('n4', 'verifier', 'Verifier', 880, 120, 'Check out each worker\'s worktree, run the tests and the acceptance criteria independently, and return PASS or FAIL with precise fix instructions.'),
      n('n5', 'reviewer', 'Code Reviewer', 1160, 120, 'Review the combined diff for bugs, security problems and needless complexity. Block only on issues that matter.', { model: 'opus' }),
    ],
    edges: [
      e('e1', 'n1', 'n2', 'handoff'),
      e('e2', 'n2', 'n3', 'handoff'),
      e('e3', 'n3', 'n4', 'handoff'),
      e('e4', 'n4', 'n3', 'fail', { maxIterations: 3 }),
      e('e5', 'n4', 'n5', 'pass'),
      e('e6', 'n5', 'n3', 'fail', { maxIterations: 2, condition: 'blocking issues found' }),
      e('e7', 'n5', 'n1', 'pass'),
    ],
  };

  const research = {
    name: 'Research, build, test',
    goal: '',
    settings: { maxParallel: 3, maxRounds: 3, autoStart: true, runLog: true, mergeWorktrees: true },
    nodes: [
      n('n1', 'orchestrator', 'Lead', 40, 260, 'Coordinates the team and decides when the work is good enough to ship.'),
      n('n2', 'researcher', 'Codebase Researcher', 320, 140, 'Map the code involved in the task: entry points, data flow, existing tests, conventions.', { model: 'haiku' }),
      n('n3', 'researcher', 'Docs Researcher', 320, 380, 'Look up library/API documentation and known pitfalls relevant to the task.', { tools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'], model: 'haiku' }),
      n('n4', 'planner', 'Planner', 600, 260, 'Combine both research reports into a plan of work packages with acceptance criteria.'),
      n('n5', 'worker', 'Builder', 880, 260, 'Implement the plan.', { instances: 2, isolation: 'worktree' }),
      n('n6', 'tester', 'Tester', 1160, 260, 'Write tests for the acceptance criteria and run the whole suite.'),
      n('n7', 'verifier', 'Verifier', 1440, 260, 'Run everything and judge the result against the acceptance criteria.'),
    ],
    edges: [
      e('e1', 'n1', 'n2', 'handoff'),
      e('e2', 'n1', 'n3', 'handoff'),
      e('e3', 'n2', 'n4', 'handoff'),
      e('e4', 'n3', 'n4', 'handoff'),
      e('e5', 'n4', 'n5', 'handoff'),
      e('e6', 'n5', 'n6', 'handoff'),
      e('e7', 'n6', 'n7', 'handoff'),
      e('e8', 'n7', 'n5', 'fail', { maxIterations: 3 }),
      e('e9', 'n7', 'n1', 'pass'),
    ],
  };

  return {
    list: [
      { id: 'simple', title: 'Simple pipeline', desc: 'Manager → Planner → Worker → Verifier → Manager', design: simple },
      { id: 'loop', title: 'Parallel build + verification loop', desc: 'Workers per task in worktrees, verifier & reviewer loops', design: loop },
      { id: 'research', title: 'Research → Build → Test', desc: 'Parallel research, join, build, test, verify loop', design: research },
      { id: 'blank', title: 'Blank canvas', desc: 'Start from scratch', design: { name: 'My agent workflow', goal: '', settings: {}, nodes: [], edges: [] } },
    ],
  };
});
