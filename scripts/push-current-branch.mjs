#!/usr/bin/env node
// push-current-branch — publishes the active branch's commits to a
// remote so the remote's matching branch advances to the local tip.
//
// Module: default-exports async ({ cwd?, remote?, branch?, setUpstream?, gitBin? })
//         → { pushed: true, remote, branch, root }
// CLI:    push-current-branch
//           [--cwd <dir>] [--remote <name>] [--branch <name>] [--set-upstream] [--git-bin <path>]
//
// The Git binary defaults to the system Git and may be overridden explicitly
// for tests.

import { spawnSync } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultGit = '/usr/bin/git';

function resolveGitBin(gitBin) {
  return gitBin || defaultGit;
}

function runGit(gitBin, cwd, args, { capture = true } = {}) {
  const result = spawnSync(resolveGitBin(gitBin), args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  return { code: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

export default async function pushTheCurrentBranch({ cwd, remote = 'origin', branch, setUpstream = false, gitBin } = {}) {
  const start = cwd
    ? (isAbsolute(cwd) ? cwd : resolve(process.cwd(), cwd))
    : process.cwd();

  const top = runGit(gitBin, start, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) throw new Error(`not a git repository: ${start} (${top.stderr})`);
  const root = top.stdout;

  const head = runGit(gitBin, root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (head.code !== 0) throw new Error(`git rev-parse failed in ${root}: ${head.stderr}`);
  const localBranch = head.stdout;
  if (localBranch === 'HEAD') throw new Error(`HEAD is detached in ${root}; refusing to push without an explicit branch`);
  const remoteBranch = branch ?? localBranch;

  const args = ['push', '--recurse-submodules=check'];
  if (setUpstream) args.push('-u');
  args.push(remote, `HEAD:${remoteBranch}`);
  const push = runGit(gitBin, root, args);
  if (push.code !== 0) throw new Error(`git push failed in ${root}: ${push.stderr || push.stdout}`);

  return { pushed: true, remote, branch: remoteBranch, root };
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? '')) {
  const args = process.argv.slice(2);
  let cwd = null, remote = 'origin', branch = null, setUpstream = false, gitBin = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cwd' && i + 1 < args.length) cwd = args[++i];
    else if (args[i] === '--remote' && i + 1 < args.length) remote = args[++i];
    else if (args[i] === '--branch' && i + 1 < args.length) branch = args[++i];
    else if (args[i] === '--set-upstream') setUpstream = true;
    else if (args[i] === '--git-bin' && i + 1 < args.length) gitBin = args[++i];
  }
  try {
    const out = await pushTheCurrentBranch({ cwd, remote, branch, setUpstream, gitBin });
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`push-current-branch: ${err.message}\n`);
    process.exit(1);
  }
}
