# Changelog

All notable changes to this project will be documented in this file.

## [2.1.0] - 2025-03-04

### Added
- Standardized error handling across all store modules
- Improved error tracking with structured error messages
- Transaction tracking for KV store operations

### Changed
- Enhanced type safety across all store modules
- Fixed method signatures to match interfaces consistently
- Renamed methods for better clarity and consistency
- Updated error handling to use AppError class throughout
- Improved error messages with more context and details

### Fixed
- Type discrepancies between interfaces and implementations
- Missing methods in service interfaces
- Inconsistent method naming conventions

## [2.0.0] - 2023-03-04

### Added
- Dual ESM/CJS module format support
- Subpath exports for individual store modules 
- Structured logging with Pino
- AppError class for better error handling
- Source maps for improved debugging
- Path aliases in TypeScript configuration

### Changed
- Migrated from direct tsc to tsup for bundling
- Improved package.json exports configuration
- Fixed circular dependencies between modules
- Upgraded TypeScript target to ES2022
- Enhanced TypeScript configuration with stricter type checking

### Removed
- Direct dependency on specific Vercel KV implementation details
- Outdated documentation references

## [1.0.0] - 2023-02-15

Initial stable release

### Features
- Market creation and management
- Prediction operations with NFT receipts
- User balance tracking
- User statistics for leaderboards
- Bug report management
- Vercel KV store integration