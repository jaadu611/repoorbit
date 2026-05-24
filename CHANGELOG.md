# Changelog

All notable changes to the **RepoOrbit** extension will be documented in this file.

## [1.0.0] - 2026-05-25

### Added
- **Real-Time Trajectory Inspector**: Added a live dashboard showing current step execution status (Running, Done, Error, Waiting), active tool names, thinking logs, and JSON parameters.
- **Auto-Approval Retries**: Integrated a robust 3-attempt backoff retry mechanism (every 5 seconds) for confirmation bypass sequences to prevent hangs when the IDE panel is out of focus.
- **GitHub Issue Noise Filtering**: Enhanced issue reference resolution to strip comments, "+1" remarks, emojis, and meta-chatter, producing clean requirements sections.
- **Clone Target Validation**: Added validation that checks if the destination directory is empty before executing git clone, avoiding execution conflicts.
- **Automatic Rule Bootstrapping**: Generates default `.repoorbit/queries.md` templates and `.agents/rules/MASTER.md` constitution rules inside cloned workspaces.

### Changed
- **UI/UX Aesthetics Overhaul**: Refactored the Webview style scheme to a solid, flat dark-mode theme, completely removing shadows, glows, gradients, and redundant transitions.

## [0.1.2] - 2026-05-10
- Initial beta testing release.
- Added self-healing loop feedback rating integration.
- Added model selection parameters.
