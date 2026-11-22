/**
 * Writes the pull request comment for a CI run as Markdown on stdout.
 *
 *   node ci-comment.mjs rust <report folder>     test-output.txt, coverage.json, missing.txt
 *   node ci-comment.mjs client <report folder>   typecheck.txt, tests.json, coverage/coverage-summary.json, coverage/coverage-final.json
 *
 * Step outcomes come from the environment: TESTS and COVERAGE for rust, TYPECHECK and TESTS for client.
 * Any report file may be missing when an earlier step failed; the comment says what didn't run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const workspace = `${process.env.GITHUB_WORKSPACE ?? process.cwd()}/`;
const max_output = 20_000;

function readText(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function readJson(path) {
  const text = readText(path);
  return text === null ? null : JSON.parse(text);
}

/** Output without color codes, dependency stack frames or this machine's paths. */
function plain(text) {
  return text
    .replaceAll(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .filter((line) => !/^\s+at .*(node_modules|<anonymous>)/.test(line))
    .join('\n')
    .replaceAll(`file://${workspace}`, '')
    .replaceAll(workspace, '')
    .trim();
}

function relative(path) {
  return path.startsWith(workspace) ? path.slice(workspace.length) : path;
}

function percent(value) {
  return `${Number.isInteger(value) ? value : value.toFixed(2)}%`;
}

function block(text) {
  const clipped = text.length > max_output ? `${text.slice(0, max_output)}\n… cut at ${max_output} characters` : text;
  return `\`\`\`\`text\n${clipped}\n\`\`\`\``;
}

function details(summary, body, open = false) {
  return `<details${open ? ' open' : ''}><summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

function table(headers, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

/** Collapses sorted line numbers into ranges: 3, 4, 5, 9 becomes "3-5, 9". */
function ranges(lines) {
  const parts = [];
  for (const line of [...new Set(lines)].sort((a, b) => a - b)) {
    const last = parts.at(-1);
    if (last && line === last[1] + 1) last[1] = line;
    else parts.push([line, line]);
  }
  return parts.map(([first, last]) => (first === last ? `${first}` : `${first}-${last}`)).join(', ');
}

/** The coverage section: totals, the files under 100% with their uncovered lines, and every file folded away. */
function coverageSection(model) {
  if (model.files.length === 0) return '### Coverage\n\nCoverage wasn\'t measured.';
  const metric_names = model.metrics.map((metric) => metric.label);
  const cells = (values) => model.metrics.map((metric) => percent(values[metric.key]));
  const totals = table(['', ...metric_names], [['**Total**', ...cells(model.totals)]]);
  const short = model.files.filter((file) => model.metrics.some((metric) => file.values[metric.key] < 100));
  const short_table = short.length === 0
    ? 'Every file is fully covered.'
    : table(['File', ...metric_names, 'Uncovered lines'], short.map((file) => [`\`${file.path}\``, ...cells(file.values), file.uncovered || '—']));
  const every_file = table(['File', ...metric_names], model.files.map((file) => [`\`${file.path}\``, ...cells(file.values)]));
  return ['### Coverage', `100% is required for ${metric_names.join(', ').toLowerCase()}.`, totals, short_table, details('Every file', every_file)].join('\n\n');
}

function rustReport(folder) {
  const output = readText(join(folder, 'test-output.txt')) ?? '';
  const result = output.match(/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/m);
  const sections = [];
  if (!result) {
    sections.push('The tests didn\'t run. The end of the output:', block(plain(output.split('\n').slice(-80).join('\n'))));
  } else {
    const [, passed, failed] = result;
    sections.push(`${failed} failed, ${passed} passed.`);
    const failures = output.match(/^failures:\n\n([\s\S]*?)\n\nfailures:\n/m);
    if (failures) sections.push(details('Failures', block(plain(failures[1])), true));
  }

  const coverage = readJson(join(folder, 'coverage.json'));
  const missing = new Map();
  const missing_text = readText(join(folder, 'missing.txt')) ?? '';
  for (const line of missing_text.split('Uncovered Lines:')[1]?.trim().split('\n') ?? []) {
    const split = line.lastIndexOf(': ');
    if (split > 0) missing.set(relative(line.slice(0, split)), line.slice(split + 2));
  }
  const metrics = [
    { key: 'regions', label: 'Regions' },
    { key: 'functions', label: 'Functions' },
    { key: 'lines', label: 'Lines' },
  ];
  const valuesOf = (summary) => Object.fromEntries(metrics.map((metric) => [metric.key, summary[metric.key].percent]));
  const data = coverage?.data[0];
  sections.push(
    coverageSection({
      metrics,
      totals: data ? valuesOf(data.totals) : {},
      files: (data?.files ?? []).map((file) => ({ path: relative(file.filename), values: valuesOf(file.summary), uncovered: missing.get(relative(file.filename)) })),
    }),
  );

  const tests_failed = process.env.TESTS === 'failure';
  const coverage_failed = process.env.COVERAGE === 'failure';
  const status = tests_failed ? 'tests failed' : coverage_failed ? 'coverage is below 100%' : 'passed';
  return [`## Rust: ${status}`, ...sections].join('\n\n');
}

/** The source lines with a statement, function or branch path that never ran, from Istanbul's coverage-final.json. */
function uncoveredLines(file) {
  const lines = [];
  for (const [key, count] of Object.entries(file.s)) if (count === 0) lines.push(file.statementMap[key].start.line);
  for (const [key, count] of Object.entries(file.f)) if (count === 0) lines.push(file.fnMap[key].loc.start.line);
  for (const [key, counts] of Object.entries(file.b)) {
    const branch = file.branchMap[key];
    counts.forEach((count, index) => {
      if (count === 0) lines.push((branch.locations[index] ?? branch.loc).start.line ?? branch.loc.start.line);
    });
  }
  return ranges(lines);
}

function clientReport(folder) {
  const sections = [];
  if (process.env.TYPECHECK === 'failure') {
    sections.push(details('Typecheck errors', block(plain(readText(join(folder, 'typecheck.txt')) ?? '')), true));
  }

  const tests = readJson(join(folder, 'tests.json'));
  if (!tests) {
    sections.push('The tests didn\'t run.');
  } else {
    sections.push(`${tests.numFailedTests} failed, ${tests.numPassedTests} passed.`);
    const failures = [];
    for (const result of tests.testResults) {
      const failed = result.assertionResults.filter((assertion) => assertion.status === 'failed');
      if (result.status === 'failed' && failed.length === 0) failures.push(`${relative(result.name)}\n${result.message}`);
      for (const assertion of failed) failures.push(`${relative(result.name)} › ${assertion.fullName}\n${assertion.failureMessages.join('\n')}`);
    }
    if (failures.length > 0) sections.push(details('Failures', block(plain(failures.join('\n\n'))), true));
  }

  const summary = readJson(join(folder, 'coverage', 'coverage-summary.json'));
  const final = readJson(join(folder, 'coverage', 'coverage-final.json')) ?? {};
  const metrics = [
    { key: 'lines', label: 'Lines' },
    { key: 'branches', label: 'Branches' },
    { key: 'functions', label: 'Functions' },
    { key: 'statements', label: 'Statements' },
  ];
  const valuesOf = (entry) => Object.fromEntries(metrics.map((metric) => [metric.key, entry[metric.key].pct]));
  const files = Object.entries(summary ?? {})
    .filter(([path]) => path !== 'total')
    .map(([path, entry]) => ({ path: relative(path), values: valuesOf(entry), uncovered: final[path] ? uncoveredLines(final[path]) : '' }));
  sections.push(coverageSection({ metrics, totals: summary ? valuesOf(summary.total) : {}, files }));

  const below = summary !== null && metrics.some((metric) => summary.total[metric.key].pct < 100);
  const status = process.env.TYPECHECK === 'failure'
    ? 'typecheck failed'
    : tests?.numFailedTests > 0 || !tests
      ? 'tests failed'
      : below
        ? 'coverage is below 100%'
        : 'passed';
  return [`## Client: ${status}`, ...sections].join('\n\n');
}

const [kind, folder] = process.argv.slice(2);
const reports = { rust: rustReport, client: clientReport };
if (!reports[kind] || !folder) {
  console.error('usage: node ci-comment.mjs <rust|client> <report folder>');
  process.exit(2);
}
console.log(reports[kind](folder));
