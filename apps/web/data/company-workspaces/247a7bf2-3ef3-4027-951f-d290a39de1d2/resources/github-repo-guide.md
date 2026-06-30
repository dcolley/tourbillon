# Tourbillon GitHub Repository Guide

**Repo URL**: https://github.com/dcolley/tourbillon  
**Branch**: `main` (protected)  

---

## 1. Repository Structure

```
tourbillon/
├── apps/
│   └── web/                     # Next.js 14 web application
│       ├── app/                 # Next.js App Router (API routes)
│       ├── src/
│       │   ├── app/            # Pages, API routes, documentation
│       │   ├── components/     # React components
│       │   ├── gtag.ts         # Google Analytics
│       │   └── (other sources)
│       ├── env-config-template.txt  # Environment variables
│       ├── package.json
│       ├── tsconfig.json
│       └── next.config.js
└── README.md
```

---

## 2. Branching Strategy (Git Flow — Lite)

### Main Branches
| Branch | Purpose | Protection |
|--------|---------|------------|
| `main` | Production-ready code | Protected, requires PR review |

### Working Branches (short-lived)
| Pattern | Example | Description |
|---------|---------|-------------|
| `feature/<slug>` | `feature/user-auth` | New features |
| `fix/<slug>` | `fix/login-timeout` | Bug fixes |
| `docs/<slug>` | `docs/api-schema` | Documentation updates |
| `chore/<slug>` | `chore/update-deps` | Maintenance, config, deps |

### Branch Naming Rules
- **Lowercase** with hyphens (kebab-case)
- **Descriptive** slug (5–8 words max)
- **Prefix** indicates the type of change
- **Tie to issue**: Append `-TOUR-XX` when applicable

```
✅ feature/user-authentication
✅ fix/google-oauth-callback-TOUR-94
✅ docs/update-deployment-page
❌ Feature1
❌ fix-john
❌ Main_Update
```

---

## 3. Creating a Branch

### From Workspace (Agent Work)
Agents edit files directly in the workspace (`apps/web/...`). When ready to sync to GitHub:

```bash
# 1. Clone (if not already)
git clone https://github.com/dcolley/tourbillon.git
cd tourbillon

# 2. Ensure main is up to date
git fetch origin
git checkout main
git pull origin main

# 3. Create feature branch
git checkout -b feature/user-authentication

# 4. Stage workspace changes
git add apps/web/

# 5. Commit with convention (see §4)
git commit -m "feat: add user authentication flow"

# 6. Push and create PR
git push -u origin feature/user-authentication
```

### ⚠️ Warning: Don't Create Orphan Branches
- Always base branches off `main` (or latest `origin/main`)
- Clean up merged branches: `git branch -d feature/user-authentication`
- Limit concurrent feature branches to ≤ 5 per developer

---

## 4. Commit Message Convention (Conventional Commits)

```
<type>: <description>

[optional body]
```

### Types
| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Code style (formatting, linting) |
| `refactor` | Refactoring without behavior change |
| `perf` | Performance improvement |
| `test` | Adding or fixing tests |
| `chore` | Build, deps, tooling |
| `ci` | CI/CD pipeline changes |
| `revert` | Reverting a previous commit |

### Examples
```
feat: add Google OAuth login flow
fix: resolve session timeout on dashboard page
docs: add deployment configuration guide
refactor: extract auth utils into dedicated module
chore: update next to v14.2.0
```

---

## 5. Pull Request Workflow

### Creating a PR
1. Open PR against `main`
2. **Title**: `feat: add user authentication flow` (match commit convention)
3. **Description template**:
   ```markdown
   ## What
   Brief description of the change.

   ## Why
   Links to issue: TOUR-XX  
   Business context for the change.

   ## How
   - What was done
   - Key technical decisions
   - Any migration or config changes
   ```

4. Assign **at least one reviewer** (ideally CTO or senior dev)
5. Link issue in body: `Closes TOUR-94`

### PR Check Before Merging
- [ ] Code lints (`npm run lint`)
- [ ] Types compile (`npm run build` or `tsc --noEmit`)
- [ ] No console.log / debugger left over
- [ ] Env variables documented (if new)
- [ ] No secrets in exposed files

### Merging
- **Merge commit** (squash only if multiple WIP commits)
- Delete branch after merge
- Update issue: mark as `done` with merge commit link

---

## 6. PR Review Checklist (For Reviewers)

### Code Quality
- [ ] Logic correctness and edge cases
- [ ] Naming conventions (consistent with codebase)
- [ ] DRY — no unnecessary duplication
- [ ] Error handling and fallbacks
- [ ] Security: no hardcoded secrets, proper type checking

### Next.js Specific
- [ ] Using `src/app/` route structure
- [ ] Server vs Client components correctly tagged (`"use client"`)
- [ ] API routes follow REST pattern in `app/api/`
- [ ] Environment variables accessed via process.env with defaults

### Tests & Performance
- [ ] Relevant tests added/updated
- [ ] No unnecessary re-renders
- [ ] Images and assets optimized

---

## 7. Local Development Setup

```bash
# 1. Clone
git clone https://github.com/dcolley/tourbillon.git
cd tourbillon/apps/web

# 2. Install deps
npm install

# 3. Configure env
cp env-config-template.txt .env
# Edit .env with your values

# 4. Run locally
npm run dev          # http://localhost:3000

# 5. Type-check
npx tsc --noEmit
```

---

## 8. CI/CD (Future — GitHub Actions)

Planned workflows:
| Workflow | Trigger | Action |
|----------|---------|--------|
| `lint-and-build` | PR to `main` | `npm run lint && npm run build` |
| `deploy` | Merge to `main` | Deploy to Vercel/Netlify |
| `test` | Push to `main` | Run Jest/Vitest suite |

---

## 9. Agent-Specific Workflow

### How Agents Work With This Repo

1. **Workspace-first editing**: Agents edit files in the shared workspace (`apps/web/`)
2. **Sync to GitHub**: Periodically, push changes to GitHub branches
3. **PR creation**: Agents can create PRs via GitHub API (see `resources/github-agent-skills.md`)
4. **No direct `main` commits**: Everything goes through PR → Review → Merge

### When to Create a Branch vs Direct Edit
| Scenario | Action |
|----------|--------|
| Quick doc update | Edit in workspace, commit to `main` directly |
| Feature/fix working in progress | Create `feature/` or `fix/` branch |
| Multiple files changed | Branch + PR |
| Hotfix | `fix/` branch → fast-track PR |

---

## 10. Tags and Releases

| Convention | Format | Example |
|------------|--------|---------|
| Semantic versioning | `v<major>.<minor>.<patch` | `v0.1.0` |
| Tag on stable `main` | Git tag pushed to `main` | `v0.1.0` |

---

## Quick Reference Card

```
git checkout main && git pull
git checkout -b feature/my-change-TOUR-94
# ... edit files in workspace ...
git add -A && git commit -m "feat: add user auth"
git push -u origin feature/my-change-TOUR-94
# Create PR → Review → Merge → Delete Branch
```
