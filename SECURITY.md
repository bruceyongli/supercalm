# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, report privately to the
maintainers (e.g. via a GitHub private security advisory on this repository). We'll acknowledge and
work with you on a fix and disclosure timeline.

## Threat model & operator responsibilities

Supercalm launches CLI coding agents with real filesystem and network access, streams their terminals, and
(optionally) auto-answers them. It is designed to run **on a single operator's private network**
(e.g. a Tailscale tailnet), bound to loopback and exposed only over an authenticated overlay — **not**
on the public internet. Keep these invariants:

- **Bind to loopback.** The server listens on `127.0.0.1`; expose it only via Tailscale Serve / a
  reverse proxy with authentication. Do not bind it to a public interface.
- **Secrets stay out of the repo.** Credentials live in gitignored files under `data/`, in
  `~/.dev.vars`, in the OS keychain, or in the model-proxy plists — never committed. `.gitignore`
  covers `data/`, `*.log`, keys, and env files; keep it that way.
- **Full-autonomy agents act on their own.** Sessions launched with `autonomy: full` pass
  `--dangerously-skip-permissions` (or the codex/agy equivalents). Run untrusted tasks in throwaway
  project dirs, and prefer the built-in git guardrails (`gitGuardrails` flag) for irreversible git ops.
- **The supervisor can send input to agents.** In auto-pilot it types into live sessions. Review the
  Supervisor tab's activity log; it is observe-only by default.
- **Untrusted content is treated as data.** Agent/terminal/repo text is never executed as instructions
  by the summarizer, supervisor, or the file viewer (rendered as escaped text).

## Supported versions

This is a single-maintainer project released as a reference implementation; only the latest `main` is
supported.
