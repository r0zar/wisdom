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

### Basic Operations

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

### Market Search and Query

```typescript
import { marketStore, MarketQueryOptions } from 'wisdom-sdk';

// Find active markets in the crypto category with pagination
const queryOptions: MarketQueryOptions = {
  status: 'active',
  category: 'crypto',
  limit: 20,
  sortBy: 'createdAt',
  sortDirection: 'desc'
};

const result = await marketStore.getMarkets(queryOptions);
console.log(`Found ${result.total} markets, showing ${result.items.length}`);

// Search for markets containing specific terms
const searchResult = await marketStore.searchMarkets('bitcoin price', {
  status: 'active',
  limit: 10
});

// Get markets by category with automatic sorting
const cryptoMarkets = await marketStore.getMarketsByCategory('crypto', {
  sortBy: 'poolAmount',
  sortDirection: 'desc'
});

// Find trending markets (highest pool amount)
const trendingMarkets = await marketStore.getTrendingMarkets(5);

// Get related markets
const relatedMarkets = await marketStore.getRelatedMarkets('market-id', 3);

// Load more results with cursor-based pagination
if (result.hasMore && result.nextCursor) {
  const nextPage = await marketStore.getMarkets({
    ...queryOptions,
    cursor: result.nextCursor
  });
}
```

## Features

- TypeScript-first design with full type safety
- Data access layer with Vercel KV store integration
- Support for prediction markets, user balances, and stats
- Advanced market search and filtering capabilities
- On-chain market creation and resolution via Stacks blockchain
- Pagination, sorting, and efficient data retrieval
- Built for both ESM and CommonJS environments
- Structured logging and error handling
- Tree-shakable modules for optimal bundle size

## Module Structure

The library is organized into independent modules that can be imported separately:

- `wisdom-sdk/market-store` - Market creation and management
- `wisdom-sdk/prediction-store` - Prediction operations and NFT receipts
- `wisdom-sdk/user-balance-store` - User balance tracking
- `wisdom-sdk/user-stats-store` - User statistics for leaderboards
- `wisdom-sdk/bug-report-store` - Bug report management
- `wisdom-sdk/kv-store` - Low-level KV store operations
- `wisdom-sdk/logger` - Structured logging utilities
- `wisdom-sdk/utils` - Shared utilities

## Documentation

For detailed API documentation, see the GitHub repository at [github.com/r0zar/wisdom](https://github.com/r0zar/wisdom).

### Reference Implementations

We provide reference implementations to help you build robust UIs with the Wisdom SDK:

- **[Markets Datatable Reference](/docs/MARKET_DATATABLE_REFERENCE.md)** - A comprehensive implementation of a paginated datatable with sorting, filtering, and analytics for markets

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