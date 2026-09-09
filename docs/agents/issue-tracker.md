# Issue Tracker: Local Markdown

Specs and tickets live under `.scratch/<feature-slug>/`.
Publishing means writing local files, not creating remote issues.

- Spec: `spec.md` within the feature directory.
- Tickets: `issues/<NN>-<slug>.md`, one file per ticket.
- Number tickets from `01` in dependency order, blockers first.
- Record `Status:` near the top, using `triage-labels.md`.
- Record `Blocked by:` with ticket numbers and titles, or `None`.
- Readiness does not imply that blockers are complete.
- Append discussion under `## Comments`.
- Fetch a ticket by reading its referenced file. Resolve bare numbers
  within the current feature; ask if the feature is ambiguous.

Create directories when publishing approved work.
