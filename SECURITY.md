# Security Policy

## Reporting a vulnerability

Please report security issues privately by creating a GitHub Security Advisory
on this repository (Security → Report a vulnerability). Do not open a public
issue for a security problem.

## Scope

- Permanent deletion of subagent sessions, including their session-log
  directories and projection rows.
- Stopping / releasing live subagent agents.
- Listing descendant subagents of the caller's session.
- The bundled web client component that refreshes the open UI after deletion.

## Security properties

- **Ownership checks first.** Every mutation verifies that the target subagent
  is a descendant of the caller's session tree before any process is stopped
  or any file is removed. Unknown or foreign ids are rejected.
- **Files first, accounting second.** On-disk session artifacts are removed and
  verified before workspace / projection accounting is stripped. A failed
  filesystem operation cannot produce a half-deleted row.
- **Bounded teardown.** Live agents are cancelled with a 15 second quiescence
  bound before filesystem removal is attempted.
- **No secrets or network egress.** The plugin does not collect credentials,
  send telemetry, or contact remote services. It only operates on the local
  DSH home directory.

## Permanent deletion warning

`delete_subagent` and the HTTP `delete` route are **permanent**. Transcripts,
events, and projection rows are removed from the local DSH home. Make sure
that is intended before calling them.
