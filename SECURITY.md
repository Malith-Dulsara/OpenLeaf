# Security Policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately through
[GitHub's security advisories](https://github.com/Maith-Dulsara/OpenLeaf/security/advisories/new).
We'll acknowledge your report as soon as we can and keep you updated while we work on a fix.

## Supported versions

Security fixes go into the latest release.

## How OpenLeaf is designed to be safe

OpenLeaf runs a small web server on your own computer. These are the protections it relies on, which are useful
to know when you assess a report:

- **Your own access is local only.** The main server listens on `127.0.0.1` and rejects requests whose
  `Host` header isn't a localhost name, which blocks DNS-rebinding attacks from web pages you visit.
- **Collaborators use a separate listener.** It starts only while at least one project is shared. Every request
  on it needs that project's invite token. The token is set as an `HttpOnly` cookie by the invite link, compared in
  constant time, and never sent back to clients in project data.
- **Guests are limited to one project.** They can't list other projects, delete the project, change sharing,
  or open folders on the host computer.
- **Resetting a link** invalidates the old token and disconnects everyone who used it. Turning sharing off
  closes the listener.
- **File paths** are resolved inside the project folder, and anything that escapes it is rejected.
- **Deletes** move files to `projects/.trash/` instead of destroying them.

**Known limitation:** invite links use plain HTTP. On untrusted networks, share over an encrypted overlay such as
[Tailscale](https://tailscale.com) instead of the local network.

Compiling runs `latexmk` on the host. A shared project's `.tex` files can therefore do anything your TeX
distribution allows. By default that is only *restricted* shell escape (a short allow-list of commands); OpenLeaf
never turns on full `--shell-escape`. Still, only share projects with people you trust.
