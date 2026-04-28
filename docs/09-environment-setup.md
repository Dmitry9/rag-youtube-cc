# 09 — Environment Setup (Windows / WSL2)

If you're developing on Windows, **use WSL2.** This doc explains why and how
to set it up correctly.

## TL;DR

- Native Windows technically works, but the toolchain (Postgres + pgvector,
  Node native bindings, bash scripts) is built for Linux. You'll fight
  environment-specific weirdness instead of building.
- WSL2 just works. Cap its memory at 8GB if you're worried.
- **Keep the project inside WSL2's filesystem (`/home/you/...`)**, not on
  `/mnt/c/...`. The cross-FS performance penalty is 5–10× on operations
  like `npm install`.

## Component-by-component verdict

| Component | Native Windows | WSL2 |
|---|---|---|
| Postgres + pgvector | Painful (build from source against MSVC) | `apt install` or `docker run` |
| Node.js | Fine, but native bindings sometimes break | Fine |
| Docker | Runs inside a hidden WSL2 VM anyway | Direct, faster, less RAM |
| Bash scripts (most docs/tutorials) | PowerShell translation | Just works |
| VS Code / Cursor | Fine | Seamless via "WSL" remote extension |
| File system perf (project in WSL FS) | n/a | Fast |
| File system perf (project on `/mnt/c/`) | n/a | **Slow — avoid** |

## Setup

### 1. Make sure WSL2 is installed and current

PowerShell (admin):
```powershell
wsl --install              # if not installed
wsl --update
wsl --set-default-version 2
wsl --list --verbose       # confirm Ubuntu (or your distro) is on v2
```

### 2. Cap WSL2 memory (optional but recommended)

Create `C:\Users\<you>\.wslconfig`:

```ini
[wsl2]
memory=8GB
processors=4
swap=2GB
```

Restart WSL: `wsl --shutdown`. WSL2 will no longer balloon past 8GB.

For this project 4–8GB is plenty:
- Postgres at 500 chunks: ~50MB RAM
- Node dev server: ~200MB
- Everything else: trivial

### 3. Put the project inside WSL's filesystem

```bash
# Inside WSL:
cd ~                              # /home/you
git clone <repo>
cd <repo>
```

**Don't** put it at `/mnt/c/Users/you/projects/...`. The WSL↔Windows
filesystem boundary is slow.

### 4. Open with VS Code's WSL remote extension

```bash
# Inside WSL, in the project directory:
code .
```

This launches VS Code on Windows but runs the language server, terminal,
and tools inside WSL. Best of both worlds.

If `code` isn't found: install VS Code on Windows first, then install the
"WSL" extension from inside VS Code, then re-open.

### 5. Install Postgres + pgvector

Two options. Pick one.

**Option A: Native install in WSL (lower overhead)**

```bash
sudo apt update
sudo apt install -y postgresql-16 postgresql-16-pgvector
sudo systemctl start postgresql

sudo -u postgres psql -c "CREATE DATABASE rag;"
sudo -u postgres psql -c "CREATE USER rag WITH PASSWORD 'rag';"
sudo -u postgres psql -c "GRANT ALL ON DATABASE rag TO rag;"
sudo -u postgres psql -d rag -c "CREATE EXTENSION IF NOT EXISTS vector;"

# .env:
# DATABASE_URL=postgresql://rag:rag@localhost:5432/rag
```

**Option B: Docker container (cleaner, easier to reset)**

```bash
docker run -d --name pg \
  -e POSTGRES_PASSWORD=rag \
  -e POSTGRES_USER=rag \
  -e POSTGRES_DB=rag \
  -p 5432:5432 \
  pgvector/pgvector:pg16

docker exec -it pg psql -U rag -d rag -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

Tip: install the **Docker engine** directly inside WSL2 rather than Docker
Desktop on Windows. Saves memory and avoids an indirection layer. Docker
Desktop is fine if you prefer the GUI; either works.

### 6. Install Node.js

Use `nvm` so you can switch versions per-project:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
# Restart shell, then:
nvm install 20
nvm use 20
```

Confirm:
```bash
node --version    # v20.x
npm --version
```

### 7. Project quickstart

```bash
npm install
cp .env.example .env
# Fill in OPENAI_API_KEY, COHERE_API_KEY, ANTHROPIC_API_KEY, DATABASE_URL
npm run db:migrate
npm run ingest -- data/transcripts/
npm run eval
npm run ask -- "how do I update state in react?"
```

## Common gotchas on Windows/WSL2

- **`localhost` from Windows → WSL services.** WSL2 forwards `localhost`
  automatically in recent versions. If a Windows-side tool (e.g. a database
  GUI) can't connect to Postgres-in-WSL, run `wsl hostname -I` to get the
  WSL VM's IP and use that, or add `localhostForwarding=true` to
  `.wslconfig` under `[wsl2]`.

- **Line endings (CRLF vs LF).** Configure git globally:
  ```bash
  git config --global core.autocrlf input
  ```
  Otherwise shell scripts checked in with CRLF will fail with cryptic
  `\r: command not found` errors inside WSL.

- **File watching limits.** If `npm run dev` complains about ENOSPC on file
  watchers:
  ```bash
  echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf
  sudo sysctl -p
  ```

- **WSL "out of memory" on big eval runs.** Bump `.wslconfig` memory to
  12GB. Eval re-ingest sweeps multiple tables and can spike.

- **`sudo` prompt every time.** Inside WSL only — Windows isn't asking. Set
  a passwordless sudo entry if it's tedious during dev.

## When native Windows would actually be the right call

A few scenarios — none apply to this project:

- Less than 8GB total system RAM (WSL2 feels cramped).
- Need to integrate with Windows-only enterprise tooling (AD, specific
  Office automation, Windows-native GUI frameworks).
- Local GPU model inference. WSL2 has GPU passthrough but it's more setup,
  and we're using API-based models — no GPU needed.

## What an interviewer should hear

> Project runs on Node 20 in WSL2 Ubuntu, with Postgres + pgvector either
> as an apt package inside WSL or a Docker container exposed on
> `localhost:5432`. Project files live in the WSL filesystem, not on
> `/mnt/c/`, to avoid the cross-FS performance penalty. WSL2 memory is
> capped at 8GB via `.wslconfig`. VS Code connects via the WSL remote
> extension so the editor runs on Windows but tooling runs inside Linux.
