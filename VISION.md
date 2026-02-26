## PowPow Vision

PowPow is the AI that actually does things.
It runs on your devices, in your channels, with your rules.

This document explains the current state and direction of the project.
Project overview: [`README.md`](README.md)

PowPow is an educational fork of an AI gateway project, enhanced by Kannan.
The goal: learn, enhance, and experiment with multi-channel AI gateway architecture.

The current focus is:

Priority:

- Security and safe defaults
- Bug fixes and stability
- Setup reliability and first-run UX

Next priorities:

- Supporting all major model providers
- Improving support for major messaging channels
- Performance and test infrastructure
- Better computer-use and agent harness capabilities
- Ergonomics across CLI and web frontend
- Companion apps on macOS, iOS, Android, Windows, and Linux

## Security

Security in PowPow is a deliberate tradeoff: strong defaults without killing capability.
The goal is to stay powerful for real work while making risky paths explicit and operator-controlled.

## Plugins & Memory

PowPow has an extensible plugin API.
Core stays lean; optional capability ships as plugins.

Plugin docs: [`docs/tools/plugin.md`](docs/tools/plugin.md)

Memory is a special plugin slot where only one memory plugin can be active at a time.

### Skills

Skills are bundled for baseline UX in the `skills/` directory.

### Why TypeScript?

PowPow is primarily an orchestration system: prompts, tools, protocols, and integrations.
TypeScript keeps it hackable by default — widely known, fast to iterate, easy to read and extend.
