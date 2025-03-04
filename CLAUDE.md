# CLAUDE.md - OP-Predict Library Guide

## Build & Test Commands
- `pnpm install` - Install dependencies
- `pnpm build` - Build the TypeScript project
- `pnpm test` - Run all tests
- `pnpm test:watch` - Run tests in watch mode
- `pnpm test:coverage` - Run tests with coverage
- `pnpm test -- tests/path/to/file.test.ts` - Run single test file
- `pnpm lint` - Run ESLint
- `pnpm clean` - Remove dist directory

## Code Style Guidelines
- **TypeScript**: Strict typing with full type annotations
- **Modules**: Use ES modules with named exports
- **Formatting**: 2-space indentation, semicolons required
- **Imports**: Group imports by external libraries then internal modules
- **Naming**: 
  - camelCase for variables, functions, methods
  - PascalCase for classes, interfaces, types
  - UPPER_SNAKE_CASE for constants
- **Error Handling**: Use try/catch with specific error logging
- **Comments**: JSDoc format for functions and complex logic
- **Architecture**: Store-based pattern for data access
- **Console Logs**: Only for errors in production code