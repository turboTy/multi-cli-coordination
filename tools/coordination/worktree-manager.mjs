import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const worktreeRoot = path.resolve(repoRoot, '..', 'wsc-worktrees', 'active');
const activeLimit = 5;

function fail(message) {
  throw new Error(message);
}

function absolutePath(value) {
  return path.resolve(value);
}

function relativeToRoot(value) {
  return path.relative(worktreeRoot, absolutePath(value));
}

function isUnderRoot(value, allowRoot = false) {
  const relative = relativeToRoot(value);
  return (allowRoot && relative === '') || (relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertUnderRoot(value, label) {
  if (!isUnderRoot(value)) fail(`${label} must be inside ${worktreeRoot}`);
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim();
    fail(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
}

function parseWorktrees() {
  const output = git(repoRoot, ['worktree', 'list', '--porcelain']);
  const records = [];
  let record = null;
  const flush = () => {
    if (record?.path) records.push(record);
    record = null;
  };

  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      flush();
      continue;
    }
    const separator = line.indexOf(' ');
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1);
    if (key === 'worktree') {
      flush();
      record = { path: value };
    } else if (record) {
      if (key === 'HEAD') record.head = value;
      if (key === 'branch') record.branch = value.replace(/^refs\/heads\//, '');
      if (key === 'detached') record.detached = true;
      if (key === 'locked') record.locked = value || true;
      if (key === 'prunable') record.prunable = value || true;
    }
  }
  flush();
  return records.map((record) => ({
    ...record,
    path: absolutePath(record.path),
    isMain: absolutePath(record.path) === absolutePath(repoRoot),
  }));
}

function isClean(worktreePath) {
  return git(worktreePath, ['status', '--porcelain']).trim() === '';
}

function inspect(records) {
  return records.map((record) => ({
    ...record,
    exists: fs.existsSync(record.path),
    clean: record.isMain || !fs.existsSync(record.path) ? null : isClean(record.path),
    location: record.isMain ? 'main' : isUnderRoot(record.path) ? 'active' : 'legacy',
  }));
}

function activeRecords(records) {
  return records.filter((record) => !record.isMain && !record.prunable);
}

function printRecords(records) {
  for (const record of records) {
    const state = record.isMain ? 'main' : record.prunable ? 'prunable' : record.clean === null ? 'missing' : record.clean ? 'clean' : 'dirty';
    console.log(`${record.location}\t${state}\t${record.branch || '(detached)'}\t${record.path}`);
  }
  const count = activeRecords(records).length;
  console.log(`active_count=${count} limit=${activeLimit}`);
  if (count > activeLimit) {
    console.error(`ALERT active worktrees exceed ${activeLimit}: ${count}`);
    process.exitCode = 2;
  }
}

function findRecord(records, value) {
  const candidate = absolutePath(value);
  const activeCandidate = absolutePath(path.join(worktreeRoot, value));
  const record = records.find((item) => item.path === candidate || item.path === activeCandidate);
  if (!record) fail(`worktree is not registered: ${value}`);
  return record;
}

function requireNonMain(record) {
  if (record.isMain) fail('the main integration worktree cannot be managed by this command');
}

function moveWorktree(sourceValue, destinationValue) {
  const source = findRecord(parseWorktrees(), sourceValue);
  requireNonMain(source);
  const destination = path.isAbsolute(destinationValue)
    ? absolutePath(destinationValue)
    : absolutePath(path.join(worktreeRoot, destinationValue));
  assertUnderRoot(destination, 'destination');
  if (fs.existsSync(destination)) fail(`destination already exists: ${destination}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  git(repoRoot, ['worktree', 'move', source.path, destination]);
  console.log(`moved\t${source.path}\t${destination}`);
}

function removeWorktree(value) {
  const record = findRecord(parseWorktrees(), value);
  requireNonMain(record);
  if (!fs.existsSync(record.path)) fail(`worktree directory does not exist: ${record.path}`);
  if (!isClean(record.path)) fail(`worktree is dirty; commit or review changes before removal: ${record.path}`);
  git(repoRoot, ['worktree', 'remove', record.path]);
  console.log(`removed\t${record.path}\tbranch=${record.branch || '(detached)'}`);
}

function pruneWorktrees() {
  console.log(git(repoRoot, ['worktree', 'prune']).trim() || 'pruned');
}

function usage() {
  console.log('Usage: node tools/coordination/worktree-manager.mjs <list|audit|move|remove|prune> ...');
  console.log(`Managed root: ${worktreeRoot}`);
}

function main() {
  fs.mkdirSync(worktreeRoot, { recursive: true });
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    usage();
    return;
  }
  if (command === 'list' || command === 'audit') {
    printRecords(inspect(parseWorktrees()));
    return;
  }
  if (command === 'move' && args.length === 2) {
    moveWorktree(args[0], args[1]);
    return;
  }
  if (command === 'remove' && args.length === 1) {
    removeWorktree(args[0]);
    return;
  }
  if (command === 'prune' && args.length === 0) {
    pruneWorktrees();
    return;
  }
  usage();
  process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
