import * as kvStore from '../src/kv-store';
import { marketStore } from '../src/market-store';
import { custodyStore } from '../src/custody-store';
import { describe, it, expect, beforeEach } from 'vitest';

/**
 * This test file serves as a utility to query and log KV records
 * to help debug the transition from using ALL_USERS to using markets
 * for transaction lookup.
 * 
 * Run this test with: pnpm test -- tests/kv-debug.test.ts
 */

describe('KV Debug Utilities', () => {

  // Test to get and log market IDs
  it('should log all market IDs', async () => {
    const marketIds = await kvStore.getSetMembers('MARKET_IDS', '');
    console.log('----------------------------------------------');
    console.log(`Found ${marketIds.length} markets in MARKET_IDS set`);
    console.log('Sample market IDs:', marketIds.slice(0, 5));
    console.log('----------------------------------------------');

    expect(marketIds).toBeDefined();
  });

  // Test to get and log markets
  it('should log all markets from marketStore.getMarkets()', async () => {
    const marketsResult = await marketStore.getMarkets();
    const markets = marketsResult.items;

    console.log('----------------------------------------------');
    console.log(`Found ${markets.length} markets from marketStore.getMarkets()`);
    console.log('Sample market objects:', markets.slice(0, 2).map(m => ({
      id: m.id,
      name: m.name,
      outcomes: m.outcomes.length
    })));
    console.log('----------------------------------------------');

    expect(markets).toBeDefined();
  });

  // Test to get and log market transactions
  it('should log transactions for each market', async () => {
    const marketsResult = await marketStore.getMarkets();
    const markets = marketsResult.items;

    console.log('----------------------------------------------');
    console.log(`Found ${markets.length} markets to check for transactions`);

    let totalTransactions = 0;
    let marketsWithTransactions = 0;

    // Process markets in smaller batches to avoid overwhelming the console
    const batchSize = 5;
    for (let i = 0; i < markets.length; i += batchSize) {
      const marketBatch = markets.slice(i, i + batchSize);

      for (const market of marketBatch) {
        const transactions = await custodyStore.getMarketTransactions(market.id);
        if (transactions.length > 0) {
          console.log(`Market ${market.id} (${market.name}): ${transactions.length} transactions`);
          marketsWithTransactions++;
          totalTransactions += transactions.length;

          // Log first transaction as a sample
          if (transactions.length > 0) {
            console.log('Sample transaction:', {
              id: transactions[0].id,
              type: transactions[0].type,
              status: transactions[0].status,
              userId: transactions[0].userId,
              takenCustodyAt: transactions[0].takenCustodyAt
            });
          }
        }
      }
    }

    console.log('----------------------------------------------');
    console.log(`Total: ${totalTransactions} transactions across ${marketsWithTransactions} markets`);
    console.log('----------------------------------------------');

    expect(totalTransactions).toBeGreaterThanOrEqual(0);
  });
});