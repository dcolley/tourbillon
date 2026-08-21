# Tourbillon Documentation Site

This directory contains the static documentation site for Tourbillon, hosted on GitHub Pages at:

**https://dcolley.github.io/tourbillon/**

## Structure

- `index.html` — Home page
- `examples.html` — Usage examples and patterns
- `docs.html` — Documentation and quick start
- `architecture.html` — System architecture (HTML version)
- `architecture.md` — System architecture (Markdown source, linked from README)
- `style.css` — Shared styles
- `README.md` — This file

## Local Preview

To preview the site locally before pushing to GitHub Pages:

### Option 1: Python HTTP Server

```bash
cd docs
python3 -m http.server 8000
```

Then open http://localhost:8000

### Option 2: Node HTTP Server (npx)

```bash
cd docs
npx http-server -p 8000
```

Then open http://localhost:8000

### Option 3: VS Code Live Server

Install the Live Server extension and right-click `index.html` → "Open with Live Server"

## GitHub Pages Configuration

**Source:** Deploy from branch `main` → `/docs` folder

**Base path:** The site is configured to work at `/tourbillon/` (not root). All links use relative paths or the `<base href="./">` tag to ensure proper resolution.

## No Paperclip

All content in this directory is written specifically for Tourbillon and contains zero references to Paperclip or paperclipai.

## Maintenance

- Keep all internal links relative (using `./` prefix)
- Use only factual information from the codebase (README.md, AGENTS.md, existing code)
- No fake screenshots or invented features
- Document WakeRunner + Mastra Schedules (not BullMQ) for heartbeat orchestration
