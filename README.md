# TeXlyre Cloud

TeXlyre Cloud is a self-hosted collaborative LaTeX platform with its own user interface and backend. The greenfield implementation does not embed TeXlyre.

## Current milestone

The current vertical slices provide local accounts, secure server sessions, server-owned projects, rename/duplicate, project trash/restore/permanent deletion, nested files, a CodeMirror source workspace, and validated Overleaf-style ZIP imports with binary assets. Text documents use Yjs through an authenticated Hocuspocus WebSocket endpoint, with PostgreSQL persistence, IndexedDB offline recovery, live presence, and remote cursor support. Sharing between distinct accounts, compilation, PDF output, comments, history, and Google Drive backups remain later end-to-end slices.

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
docker compose up -d --build
curl -f http://127.0.0.1:3000/api/health
```

Persistent PostgreSQL and project storage use named volumes. Do not remove volumes during upgrades. Apply schema changes only through numbered SQL migrations in `packages/database/migrations`.

## Archived implementation

The former TeXlyre-based wrapper is preserved in Git tag `legacy-texlyre-final`. Its final data and ignored worktree files are preserved outside this repository under `/home/ubuntu/texlyre-cloud-legacy-data-20260903` and `/home/ubuntu/texlyre-cloud-legacy-worktree-20260903` on the development host.
