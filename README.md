# Wisdom SDK

Core business logic and data access layer for prediction markets.

## Installation

```bash
npm install wisdom-sdk
# or
yarn add wisdom-sdk
# or
pnpm add wisdom-sdk
```

## Usage

```typescript
// Import the entire library
import { marketStore, predictionStore } from 'wisdom-sdk';

// Or import specific modules for better tree-shaking
import { marketStore } from 'wisdom-sdk/market-store';
import { predictionStore } from 'wisdom-sdk/prediction-store';

// Create a new market
const market = await marketStore.createMarket({
  name: 'Will Bitcoin hit $100k in 2025?',
  description: 'Market resolves YES if...',
  type: 'binary',
  outcomes: [
    { id: 0, name: 'No' },
    { id: 1, name: 'Yes' }
  ],
  createdBy: 'user_123'
});

// Create a prediction
const prediction = await predictionStore.createPrediction({
  marketId: market.id,
  userId: 'user_456',
  prediction: 'Yes',
  confidence: 0.8
});
```

## Features

- TypeScript-first design with full type safety
- Data access layer with Vercel KV store integration
- Support for prediction markets, user balances, and stats
- Built for both ESM and CommonJS environments
- Structured logging and error handling
- Tree-shakable modules for optimal bundle size

## Module Structure

The library is organized into independent modules that can be imported separately:

- `@op-predict/lib/market-store` - Market creation and management
- `@op-predict/lib/prediction-store` - Prediction operations and NFT receipts
- `@op-predict/lib/user-balance-store` - User balance tracking
- `@op-predict/lib/user-stats-store` - User statistics for leaderboards
- `@op-predict/lib/bug-report-store` - Bug report management
- `@op-predict/lib/kv-store` - Low-level KV store operations
- `@op-predict/lib/logger` - Structured logging utilities
- `@op-predict/lib/utils` - Shared utilities

## Documentation

For detailed API documentation, see the [API Reference](./docs/API.md).

## Development

```bash
# Install dependencies
pnpm install

# Start development mode with watch
pnpm dev

# Build the package
pnpm build

# Run tests
pnpm test

# Run type checks
pnpm typecheck

# Run linter
pnpm lint
```

## Technical Notes

This library uses modern JavaScript features and build tooling:

- Built with tsup (based on esbuild) for ultra-fast builds
- Dual ESM/CJS output formats for maximum compatibility
- Source maps for improved debugging
- Full tree-shaking support
- Proper subpath exports for individual modules
- Structured logging with Pino

## License

MIT