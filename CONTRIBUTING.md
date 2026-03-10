# Contributing to AnythingMCP

Thank you for your interest in contributing to AnythingMCP! This guide will help you get started.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [License](#license)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Pull Request Process](#pull-request-process)
- [Reporting Bugs](#reporting-bugs)
- [Requesting Features](#requesting-features)
- [Code Style](#code-style)

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold this code.

## License

AnythingMCP is licensed under the [Business Source License 1.1](LICENSE) (BSL-1.1). By contributing, you agree that your contributions will be licensed under the same terms. See the [License FAQ](docs/license-faq.md) for details.

**Important:** You retain copyright over your contributions. By submitting a pull request, you certify that:

1. Your contribution is your original work, or you have the right to submit it.
2. You grant helpcode.ai GmbH a perpetual, irrevocable license to use, modify, and distribute your contribution under the project's license terms.
3. You understand that your contribution may be re-licensed under Apache 2.0 on the Change Date (2030-03-04).

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally
3. **Create a branch** from `main` for your changes
4. **Make your changes** (see [Development Setup](#development-setup))
5. **Test** your changes
6. **Push** to your fork and open a **Pull Request**

## Development Setup

### Prerequisites

- Node.js 22+
- npm 9+
- Docker and Docker Compose (for PostgreSQL)

### Quick Setup

```bash
git clone https://github.com/<your-username>/anythingmcp.git
cd anythingmcp
./setup.sh    # Choose "Local development" mode
npm run dev
```

### Manual Setup

```bash
cp .env.example .env
# Edit .env with local development values

# Start PostgreSQL
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres

# Install dependencies
npm install

# Symlink .env for Prisma and Next.js
ln -sf ../../.env packages/backend/.env
ln -sf ../../.env packages/frontend/.env

# Run migrations
cd packages/backend
export $(grep -v '^#' ../../.env | grep -v '^$' | xargs)
npx prisma migrate dev
npx prisma generate
cd ../..

# Start dev servers
npm run dev
```

### Running Tests

```bash
npm test                          # All tests
cd packages/backend && npm test   # Backend only
```

## Making Changes

### Branch Naming

Use descriptive branch names:

- `fix/description` — Bug fixes
- `feat/description` — New features
- `docs/description` — Documentation changes
- `refactor/description` — Code refactoring

### Commit Messages

Write clear, concise commit messages:

- Use the imperative mood ("Add feature", not "Added feature")
- Keep the subject line under 72 characters
- Reference issues when applicable (e.g., "Fix #42")

### What We Accept

- Bug fixes with tests
- New connector engines or parsers
- Documentation improvements
- Performance improvements
- UI/UX enhancements
- New import format parsers (OpenAPI, Postman, cURL, etc.)

### What Needs Discussion First

Open an issue before starting work on:

- New connector types
- Changes to the authentication system
- Database schema changes
- Breaking API changes
- Large refactoring efforts

## Pull Request Process

1. **Update documentation** if your change affects user-facing behavior
2. **Add tests** for new functionality
3. **Ensure all tests pass** (`npm test`)
4. **Keep PRs focused** — one feature or fix per PR
5. **Fill out the PR template** with a clear description

### Review Process

- A maintainer will review your PR, usually within a few days
- You may be asked to make changes — this is normal and expected
- Once approved, a maintainer will merge your PR

## Reporting Bugs

Use the [Bug Report](https://github.com/HelpCode-ai/anythingmcp/issues/new?template=bug_report.yml) issue template. Include:

- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Node.js version, Docker version)
- Relevant logs or screenshots

## Requesting Features

Use the [Feature Request](https://github.com/HelpCode-ai/anythingmcp/issues/new?template=feature_request.yml) issue template. Include:

- The problem you're trying to solve
- Your proposed solution
- Alternatives you've considered

## Code Style

### TypeScript

- Use TypeScript strict mode
- Prefer `const` over `let`
- Use meaningful variable names
- Follow the existing NestJS patterns (modules, services, controllers)

### Backend (NestJS)

- One module per feature area
- Services handle business logic, controllers handle HTTP
- Use DTOs with `class-validator` for input validation
- Write unit tests for services (`.spec.ts` files alongside source)

### Frontend (Next.js)

- Use the App Router pattern
- Prefer server components where possible
- Use Tailwind CSS for styling
- Follow existing component patterns

### General

- No unused imports or variables
- No `console.log` in production code (use NestJS `Logger`)
- Keep functions focused and small
- Add comments only where the "why" isn't obvious

---

Thank you for contributing!
