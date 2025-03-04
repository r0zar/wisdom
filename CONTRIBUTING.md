# Contributing to Wisdom SDK

Thank you for considering contributing to the Wisdom SDK! This document outlines the process for contributing to this project.

## Code of Conduct

By participating in this project, you agree to abide by its Code of Conduct.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/your-username/wisdom.git`
3. Set up the project:
   ```bash
   cd wisdom
   pnpm install
   ```

## Development Workflow

1. Create a new branch for your changes:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes

3. Run tests to make sure everything works:
   ```bash
   pnpm test
   pnpm typecheck
   pnpm lint
   ```

4. Commit your changes using conventional commit messages:
   ```bash
   git commit -m "feat: add new feature"
   ```

5. Push to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```

6. Create a pull request

## Pull Request Guidelines

- Include tests for any new functionality
- Update documentation if needed
- Follow the existing code style
- Keep pull requests focused on a single concern
- Write a descriptive title and explanation

## Development Commands

- `pnpm dev` - Start development mode with watch
- `pnpm build` - Build the package
- `pnpm test` - Run tests
- `pnpm lint` - Run linter
- `pnpm typecheck` - Run TypeScript type checker

## Release Process

Releases are managed by the maintainers. We follow semantic versioning.

## Questions?

If you have any questions, please open an issue with the "question" label.