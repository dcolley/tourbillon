# Agent Skills for GitHub & Code Review Management

This document outlines the necessary skills sets for agents to effectively manage GitHub-related workflows, including code review and test execution.

## Required Skills

### 1. GitHub API Integration
- **Authentication**: Proficiency with GitHub apps or Personal Access Tokens (PATs).
- **Task Automation**: Ability to create, list, comment on, and merge Pull Requests.
- **Issue Management**: Managing GitHub issues, labels, and milestones.
- **Branch Strategy**: Creating, switching, and deleting branches safely.

### 2. Code Analysis & Quality Assurance
- **Static Analysis**: Understanding and configuring linters (ESLint, Prettier) and static analyzers.
- **Code Review logic**: Identifying code smells, logic errors, and adherence to style guides.
- **Security Scanning**: Identifying vulnerabilities in dependencies or hardcoded secrets.

### 3. Testing Orchestration
- **Test Execution**: Running test suites (Jest, Vitest).
- **Result Interpretation**: Interpreting test reports, coverage metrics, and failure logs.
- **Regression Testing**: Ensuring new changes do not break existing functionality.

### 4. CI/CD Pipeline Management
- **GitHub Actions**: Writing, maintaining, and debugging `.github/workflows` YAML files.
- **Environment Management**: Managing secrets and environment variables within CI environments.

## Recommended Toolset
- **Mastra Code**: For agent-code interaction and orchestration.
- **Octokit**: For deep integration with the GitHub platform.
- **Docker**: For containerized testing environments.