# pushing-current-branch-service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Pushes the current Git branch to a remote.

Before publishing a parent, the service reads the exact outgoing commit and
its committed `.gitmodules`. Every selected child and transitive descendant
must be fetched from its declared supplier, not merely exist in a local checkout
or another configured remote. Historical ancestor pins remain unchanged.
Native Git resolves relative submodule URLs against the intended destination.
No child code is executed. Admission uses disposable repositories and does not
modify the source checkout, its index, working files, or child remote refs.

The default export and CLI retain current-branch operation. The named
`pushCommit({cwd, remoteUrl, commit, branch, timeoutMs, maxRepositories})`
operation accepts an immutable commit and an already-authorized effective
destination URL for callers that must not substitute a mutable `HEAD` or remote.
Defaults are a 60-second total Git-operation budget and 256 repositories.
Missing, unreadable, ambiguous, or over-budget graphs hold the parent push;
they do not authorize automatic child publication, resets, or new credentials.
Only SSH, HTTPS, and file Git transports are enabled by the operation; native
environment restrictions still apply. `--recurse-submodules=check` remains an
additional native defense, not the declared-supplier proof.

Transport errors during admission carry `stage: source-admission` and
`code: GIT_SOURCE_UNAVAILABLE`; absence is not inferred from an access or
transport failure. A push transport failure carries `stage: push` and either
`GIT_PUSH_REJECTED` for an explicit non-fast-forward rejection or
`GIT_PUSH_UNCERTAIN`. An uncertain push needs remote readback before retrying.
Validation/budget failures also hold the operation before push and must not be
treated as permission to follow/reset the local branch.

Run `npm run verify`. The native suite uses real temporary bare repositories,
including wrong-remote, unpublished descendant, historical-pin, and independent
recursive-clone receiving cases. It does not establish production installation.

