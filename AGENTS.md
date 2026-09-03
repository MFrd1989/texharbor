# Repository Guidelines

## Project Structure & Module Organization

This repository is an npm workspace. Browser code lives in `apps/web`, the HTTP API in `apps/api`, shared request schemas in `packages/contracts`, and PostgreSQL migrations/database utilities in `packages/database`. Infrastructure belongs in `infra/`, while cross-service and browser tests belong in `tests/`. Keep feature code close to its owning application; move code into a package only when at least two applications use it.

## Build, Test, and Development Commands

- `npm install` installs all workspace dependencies.
- `npm run dev` starts the API and Vite development servers.
- `npm run build` type-checks and builds every workspace.
- `npm test` runs unit and API tests.
- `npm run test:e2e` runs Playwright browser workflows.
- `docker compose up -d --build` builds and starts the production stack.
- `docker compose logs -f app` follows application logs.

Copy `.env.example` to `.env` before local or Docker development. Never commit secrets.

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation, semicolons, and single quotes. Name React components in `PascalCase`, functions and variables in `camelCase`, and database columns in `snake_case`. Route modules should describe resources, such as `projects.ts`. Validate all external input with Zod. Prefer small modules over broad utility files.

## Testing Guidelines

Use Vitest for unit tests and API authorization tests, and Playwright for end-to-end workflows. Name tests `*.test.ts` and browser tests `*.spec.ts`. Every private endpoint needs owner, collaborator, and unauthenticated coverage. Bug fixes should include a regression test that fails without the fix.

## Commit & Pull Request Guidelines

Use imperative Conventional Commit subjects, for example `feat: add project trash restore` or `fix: reject viewer file edits`. Keep commits scoped to one vertical slice. Pull requests must explain behavior, migrations, security implications, and verification commands. Include screenshots for UI changes and link relevant issues. Never combine generated artifacts or unrelated formatting with functional changes.

## Security & Data Safety

Treat project content as untrusted. Enforce authentication and roles server-side, normalize file paths, and never authorize access from a client-supplied user ID. Add schema changes through migrations; do not reset persistent databases to apply them.

