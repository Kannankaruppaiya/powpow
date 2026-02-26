# Contributing to PowPow

Thank you for your interest in contributing to PowPow!

## Getting Started

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes
4. Run tests: `pnpm test`
5. Submit a Pull Request

## Development Setup

```bash
pnpm install
cp .env.example .env
# Fill in your API keys in .env
node powpow.mjs gateway
```

## Code Style

- TypeScript strict mode is enforced
- Run `pnpm format` before committing
- Run `pnpm lint` to check for issues

## Pull Request Guidelines

- One PR = one issue/topic
- PRs over ~5,000 changed lines are reviewed only in exceptional circumstances
- Write tests for new features where possible

## Project Structure

- `src/` — Core TypeScript source
- `extensions/` — Plugin extensions
- `skills/` — AI skill definitions
- `ui/` — Web UI components
- `apps/` — Native client apps
