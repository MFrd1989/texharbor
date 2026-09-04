# LaTeX Workspace

LaTeX Workspace is a self-hosted collaborative LaTeX platform with its own user interface and backend. The greenfield implementation does not embed TeXlyre.

## Current milestone

The current vertical slices provide local accounts, rolling 180-day server sessions, server-owned projects, rename/duplicate, project trash/restore/permanent deletion, nested files, a CodeMirror source workspace, and validated Overleaf-style ZIP imports with binary assets. Text documents use Yjs through an authenticated Hocuspocus WebSocket endpoint, with PostgreSQL persistence, IndexedDB offline recovery, live presence, and remote cursor support. Email-bound invitation links, owner/editor/viewer roles, live role changes, and revocation are enforced by the API and collaboration server. Persistent comment threads support replies, resolve/reopen, deletion, and Yjs-relative source anchors.

LaTeX compilation runs asynchronously in disposable, network-disabled Docker sandboxes. pdfLaTeX, XeLaTeX, and LuaLaTeX are supported through `latexmk`; the workspace includes build status, logs, compiler/main-document settings, and an authenticated PDF viewer. Recoverable LaTeX errors retain the newly generated PDF and are reported as `completed with errors`; fatal builds without a PDF remain failed. History and Google Drive backups remain later end-to-end slices.

## Development

```bash
cp .env.example .env
npm install
docker compose up -d db
npm run dev
```

The Vite development server runs at `http://localhost:5173` and proxies `/api` to the API at port 3000.

## Production

```bash
docker compose --profile build-only build compiler
docker compose build app worker
docker compose up -d app worker
curl -f http://127.0.0.1:3000/api/health
```

The worker needs access to the Docker socket so it can launch tightly constrained compiler containers; compiler containers receive no application secrets or network access. Persistent PostgreSQL and project storage use named volumes. Do not remove volumes during upgrades. Apply schema changes only through numbered SQL migrations in `packages/database/migrations`.

## Archived implementation

The former TeXlyre-based wrapper is preserved in Git tag `legacy-texlyre-final`. Its final data and ignored worktree files are preserved outside this repository under `/home/ubuntu/texlyre-cloud-legacy-data-20260903` and `/home/ubuntu/texlyre-cloud-legacy-worktree-20260903` on the development host.
