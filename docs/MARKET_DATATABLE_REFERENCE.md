# Markets Datatable Reference Implementation

This document provides a reference implementation for creating a robust paginated datatable with sorting and analytics for the markets page in applications using the Wisdom SDK.

## Core Components

### 1. MarketTable Component

```tsx
// components/MarketTable.tsx
import React, { useState, useEffect } from 'react';
import { 
  Market, 
  MarketQueryOptions, 
  SortDirection, 
  SortField, 
  PaginatedResult,
  MarketStatus
} from '@charisma/wisdom';

interface MarketTableProps {
  // Function to fetch markets with query options
  fetchMarkets: (options: MarketQueryOptions) => Promise<PaginatedResult<Market>>;
  // Initial query options
  initialOptions?: MarketQueryOptions;
  // Available categories for filtering
  categories?: string[];
  // Optional loading state
  isLoading?: boolean;
  // Handle row click
  onRowClick?: (market: Market) => void;
}

export function MarketTable({ 
  fetchMarkets, 
  initialOptions, 
  categories = [],
  isLoading: externalLoading,
  onRowClick
}: MarketTableProps) {
  // State for query options
  const [queryOptions, setQueryOptions] = useState<MarketQueryOptions>(initialOptions || {
    limit: 10,
    sortBy: 'createdAt',
    sortDirection: 'desc',
    status: 'active'
  });
  
  // State for results
  const [results, setResults] = useState<PaginatedResult<Market>>({
    items: [],
    total: 0,
    hasMore: false
  });
  
  // Internal loading state
  const [loading, setLoading] = useState(false);
  
  // Cursor history for pagination
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [currentCursorIndex, setCurrentCursorIndex] = useState(-1);
  
  // Load markets when query options change
  useEffect(() => {
    async function loadMarkets() {
      setLoading(true);
      try {
        const data = await fetchMarkets(queryOptions);
        setResults(data);
        
        // Update cursor history when loading a new page
        if (queryOptions.cursor && currentCursorIndex === cursorHistory.length - 1) {
          setCursorHistory(prev => [...prev, queryOptions.cursor as string]);
          setCurrentCursorIndex(prev => prev + 1);
        }
      } catch (error) {
        console.error('Error loading markets:', error);
      } finally {
        setLoading(false);
      }
    }
    
    loadMarkets();
  }, [queryOptions, fetchMarkets]);
  
  // Handle pagination
  const handleNextPage = () => {
    if (results.nextCursor) {
      setQueryOptions(prev => ({
        ...prev,
        cursor: results.nextCursor
      }));
    }
  };
  
  const handlePrevPage = () => {
    if (currentCursorIndex > 0) {
      const prevCursor = cursorHistory[currentCursorIndex - 1];
      setQueryOptions(prev => ({
        ...prev,
        cursor: prevCursor
      }));
      setCurrentCursorIndex(prev => prev - 1);
    } else {
      // First page
      setQueryOptions(prev => ({
        ...prev,
        cursor: undefined
      }));
    }
  };
  
  // Handle sorting
  const handleSort = (field: SortField) => {
    setQueryOptions(prev => ({
      ...prev,
      sortBy: field,
      sortDirection: prev.sortBy === field && prev.sortDirection === 'desc' ? 'asc' : 'desc',
      // Reset pagination when sorting changes
      cursor: undefined
    }));
    // Reset cursor history
    setCursorHistory([]);
    setCurrentCursorIndex(-1);
  };
  
  // Handle filtering
  const handleFilterChange = (key: keyof MarketQueryOptions, value: any) => {
    setQueryOptions(prev => ({
      ...prev,
      [key]: value,
      // Reset pagination when filters change
      cursor: undefined
    }));
    // Reset cursor history
    setCursorHistory([]);
    setCurrentCursorIndex(-1);
  };
  
  // Format date for display
  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString();
  };
  
  // Format currency for display
  const formatCurrency = (amount: number) => {
    return amount.toLocaleString(undefined, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    });
  };
  
  // Determine if we're loading
  const isLoading = externalLoading || loading;
  
  // Render the table
  return (
    <div className="markets-table-container">
      {/* Filter controls */}
      <div className="markets-filters">
        {/* Status filter */}
        <div className="filter-group">
          <label htmlFor="status-filter">Status:</label>
          <select 
            id="status-filter"
            value={queryOptions.status || 'all'} 
            onChange={e => handleFilterChange('status', e.target.value)}
          >
            <option value="all">All Statuses</option>
            <option value="active">Active</option>
            <option value="resolved">Resolved</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        
        {/* Category filter */}
        <div className="filter-group">
          <label htmlFor="category-filter">Category:</label>
          <select 
            id="category-filter"
            value={queryOptions.category || ''} 
            onChange={e => handleFilterChange('category', e.target.value || undefined)}
          >
            <option value="">All Categories</option>
            {categories.map(category => (
              <option key={category} value={category}>{category}</option>
            ))}
          </select>
        </div>
        
        {/* Search box */}
        <div className="filter-group filter-group-search">
          <label htmlFor="search-filter">Search:</label>
          <input 
            id="search-filter"
            type="search"
            placeholder="Search markets..."
            value={queryOptions.search || ''} 
            onChange={e => handleFilterChange('search', e.target.value || undefined)}
          />
        </div>
      </div>
      
      {/* Results table */}
      <div className="markets-table-wrapper">
        <table className="markets-table">
          <thead>
            <tr>
              <th onClick={() => handleSort('createdAt')} className="sortable-header">
                Created {queryOptions.sortBy === 'createdAt' && (queryOptions.sortDirection === 'asc' ? '↑' : '↓')}
              </th>
              <th>Market</th>
              <th onClick={() => handleSort('endDate')} className="sortable-header">
                End Date {queryOptions.sortBy === 'endDate' && (queryOptions.sortDirection === 'asc' ? '↑' : '↓')}
              </th>
              <th>Category</th>
              <th onClick={() => handleSort('poolAmount')} className="sortable-header">
                Pool Amount {queryOptions.sortBy === 'poolAmount' && (queryOptions.sortDirection === 'asc' ? '↑' : '↓')}
              </th>
              <th onClick={() => handleSort('participants')} className="sortable-header">
                Participants {queryOptions.sortBy === 'participants' && (queryOptions.sortDirection === 'asc' ? '↑' : '↓')}
              </th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={7} className="markets-loading">Loading...</td>
              </tr>
            ) : results.items.length === 0 ? (
              <tr>
                <td colSpan={7} className="markets-no-results">No markets found</td>
              </tr>
            ) : (
              results.items.map(market => (
                <tr 
                  key={market.id} 
                  onClick={() => onRowClick && onRowClick(market)}
                  className={onRowClick ? "clickable-row" : ""}
                >
                  <td>{formatDate(market.createdAt)}</td>
                  <td>
                    <div className="market-name">{market.name}</div>
                    <div className="market-description">{market.description.substring(0, 50)}...</div>
                  </td>
                  <td>{formatDate(market.endDate)}</td>
                  <td>
                    <span className="market-category">{market.category}</span>
                  </td>
                  <td>{formatCurrency(market.poolAmount)}</td>
                  <td>{market.participants.toLocaleString()}</td>
                  <td>
                    <span className={`market-status market-status-${market.status}`}>
                      {market.status}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      
      {/* Pagination controls */}
      <div className="markets-pagination">
        <div className="pagination-info">
          Showing {results.items.length} of {results.total} markets
        </div>
        <div className="pagination-controls">
          <button 
            className="pagination-button"
            disabled={!queryOptions.cursor} 
            onClick={handlePrevPage}
          >
            Previous
          </button>
          <button 
            className="pagination-button"
            disabled={!results.hasMore} 
            onClick={handleNextPage}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
```

### 2. Market Analytics Component

```tsx
// components/MarketAnalytics.tsx
import React, { useMemo } from 'react';
import { Market } from '@charisma/wisdom';

interface MarketAnalyticsProps {
  markets: Market[];
  isLoading?: boolean;
}

export function MarketAnalytics({ markets, isLoading }: MarketAnalyticsProps) {
  // Calculate analytics data using memoization to prevent recalculation on re-renders
  const analytics = useMemo(() => {
    // Exit early if loading or no markets
    if (isLoading || markets.length === 0) {
      return {
        totalPoolAmount: 0,
        totalParticipants: 0,
        averagePoolPerMarket: 0,
        averageParticipantsPerMarket: 0,
        categoryDistribution: [],
        statusDistribution: [],
        typesDistribution: []
      };
    }
    
    const totalPoolAmount = markets.reduce((sum, market) => sum + market.poolAmount, 0);
    const totalParticipants = markets.reduce((sum, market) => sum + market.participants, 0);
    const averagePoolPerMarket = markets.length > 0 ? totalPoolAmount / markets.length : 0;
    const averageParticipantsPerMarket = markets.length > 0 ? totalParticipants / markets.length : 0;
    
    // Group by category
    const categoryCounts = markets.reduce((acc, market) => {
      const category = market.category || 'Uncategorized';
      acc[category] = (acc[category] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    // Calculate category distribution
    const categoryDistribution = Object.entries(categoryCounts)
      .map(([category, count]) => ({
        category,
        count,
        percentage: Math.round((count / markets.length) * 100)
      }))
      .sort((a, b) => b.count - a.count);
    
    // Group by status
    const statusCounts = markets.reduce((acc, market) => {
      acc[market.status] = (acc[market.status] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    // Calculate status distribution
    const statusDistribution = Object.entries(statusCounts)
      .map(([status, count]) => ({
        status,
        count,
        percentage: Math.round((count / markets.length) * 100)
      }))
      .sort((a, b) => b.count - a.count);
    
    // Group by type
    const typeCounts = markets.reduce((acc, market) => {
      acc[market.type] = (acc[market.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    // Calculate type distribution
    const typesDistribution = Object.entries(typeCounts)
      .map(([type, count]) => ({
        type,
        count,
        percentage: Math.round((count / markets.length) * 100)
      }))
      .sort((a, b) => b.count - a.count);
    
    return {
      totalPoolAmount,
      totalParticipants,
      averagePoolPerMarket,
      averageParticipantsPerMarket,
      categoryDistribution,
      statusDistribution,
      typesDistribution
    };
  }, [markets, isLoading]);
  
  // Format currency for display
  const formatCurrency = (amount: number) => {
    return amount.toLocaleString(undefined, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    });
  };
  
  if (isLoading) {
    return <div className="markets-analytics-loading">Loading analytics...</div>;
  }
  
  if (markets.length === 0) {
    return <div className="markets-analytics-empty">No data available for analytics</div>;
  }
  
  return (
    <div className="markets-analytics">
      <h3>Market Analytics</h3>
      
      <div className="analytics-cards">
        <div className="analytics-card">
          <div className="card-value">{markets.length}</div>
          <div className="card-label">Total Markets</div>
        </div>
        
        <div className="analytics-card">
          <div className="card-value">{formatCurrency(analytics.totalPoolAmount)}</div>
          <div className="card-label">Total Pool Amount</div>
        </div>
        
        <div className="analytics-card">
          <div className="card-value">{analytics.totalParticipants.toLocaleString()}</div>
          <div className="card-label">Total Participants</div>
        </div>
        
        <div className="analytics-card">
          <div className="card-value">{formatCurrency(analytics.averagePoolPerMarket)}</div>
          <div className="card-label">Avg Pool per Market</div>
        </div>
      </div>
      
      <div className="analytics-distributions">
        <div className="distribution-section">
          <h4>Category Distribution</h4>
          <div className="category-distribution">
            {analytics.categoryDistribution.map(({ category, count, percentage }) => (
              <div key={category} className="distribution-item">
                <div className="distribution-label">{category}</div>
                <div className="distribution-bar-container">
                  <div className="distribution-bar" style={{ width: `${percentage}%` }}></div>
                </div>
                <div className="distribution-count">{count} ({percentage}%)</div>
              </div>
            ))}
          </div>
        </div>
        
        <div className="distribution-section">
          <h4>Status Distribution</h4>
          <div className="status-distribution">
            {analytics.statusDistribution.map(({ status, count, percentage }) => (
              <div key={status} className="distribution-item">
                <div className="distribution-label">{status}</div>
                <div className="distribution-bar-container">
                  <div className={`distribution-bar status-${status}`} style={{ width: `${percentage}%` }}></div>
                </div>
                <div className="distribution-count">{count} ({percentage}%)</div>
              </div>
            ))}
          </div>
        </div>
        
        <div className="distribution-section">
          <h4>Market Type Distribution</h4>
          <div className="type-distribution">
            {analytics.typesDistribution.map(({ type, count, percentage }) => (
              <div key={type} className="distribution-item">
                <div className="distribution-label">{type}</div>
                <div className="distribution-bar-container">
                  <div className="distribution-bar" style={{ width: `${percentage}%` }}></div>
                </div>
                <div className="distribution-count">{count} ({percentage}%)</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
```

### 3. Markets Page Implementation

```tsx
// app/markets/page.tsx
import React, { Suspense } from 'react';
import { MarketTable } from '@/components/MarketTable';
import { MarketAnalytics } from '@/components/MarketAnalytics';
import { getMarkets, getMarketCategories } from '@/app/actions/market-actions';
import type { MarketQueryOptions } from '@charisma/wisdom';

// This loads the initial data server-side
async function MarketsPage({ 
  searchParams 
}: { 
  searchParams: Record<string, string> 
}) {
  // Parse query parameters from URL
  const status = searchParams.status || 'active';
  const category = searchParams.category;
  const search = searchParams.search;
  const sortBy = (searchParams.sortBy || 'createdAt') as any;
  const sortDirection = (searchParams.sortDirection || 'desc') as 'asc' | 'desc';
  const limit = parseInt(searchParams.limit || '10', 10);
  const cursor = searchParams.cursor;
  
  // Build initial query options
  const queryOptions: MarketQueryOptions = {
    status: status as any,
    sortBy,
    sortDirection,
    limit
  };
  
  if (category) queryOptions.category = category;
  if (search) queryOptions.search = search;
  if (cursor) queryOptions.cursor = cursor;
  
  // Fetch data in parallel
  const [initialMarketsResult, categories] = await Promise.all([
    getMarkets(queryOptions),
    getMarketCategories()
  ]);
  
  return (
    <div className="markets-page">
      <div className="markets-header">
        <h1>Markets</h1>
        <p>Explore and discover prediction markets</p>
      </div>
      
      <div className="markets-analytics-section">
        <MarketAnalytics markets={initialMarketsResult.items} />
      </div>
      
      <div className="markets-table-section">
        <h2>Markets Table</h2>
        <MarketTable 
          fetchMarkets={getMarkets}
          initialOptions={queryOptions}
          categories={categories}
          onRowClick={(market) => {
            // Handle row click - can be used for navigation
            window.location.href = `/markets/${market.id}`;
          }}
        />
      </div>
    </div>
  );
}

// Wrap in Suspense for streaming
export default function MarketsPageWrapper(props: { searchParams: Record<string, string> }) {
  return (
    <Suspense fallback={<div>Loading markets...</div>}>
      <MarketsPage searchParams={props.searchParams} />
    </Suspense>
  );
}
```

### 4. Server Actions for Data Fetching

```tsx
// app/actions/market-actions.ts
'use server'

import { marketStore, Market, MarketQueryOptions, PaginatedResult } from '@charisma/wisdom';

export async function getMarkets(options: MarketQueryOptions): Promise<PaginatedResult<Market>> {
  try {
    console.log('Fetching markets with options:', JSON.stringify(options));
    const result = await marketStore.marketStore.getMarkets(options);
    console.log(`Found ${result.items.length} markets out of ${result.total} total`);
    return result;
  } catch (error) {
    console.error('Error fetching markets:', error);
    return {
      items: [],
      total: 0,
      hasMore: false
    };
  }
}

export async function getMarketCategories(): Promise<string[]> {
  try {
    // This could be optimized to use a separate categories index in the future
    const allMarkets = await marketStore.marketStore.getMarkets({ limit: 1000 });
    const categories = new Set(allMarkets.items.map(market => market.category).filter(Boolean));
    return Array.from(categories);
  } catch (error) {
    console.error('Error fetching categories:', error);
    return [];
  }
}

export async function getMarketById(id: string): Promise<Market | null> {
  try {
    const market = await marketStore.marketStore.getMarket(id);
    return market || null;
  } catch (error) {
    console.error(`Error fetching market ${id}:`, error);
    return null;
  }
}
```

## CSS Styling

You'll need to add CSS styling for the datatable and analytics components. Here's a basic styling template:

```css
/* styles/markets.css */
.markets-page {
  max-width: 1200px;
  margin: 0 auto;
  padding: 20px;
}

.markets-header {
  margin-bottom: 30px;
}

.markets-analytics-section {
  margin-bottom: 40px;
  background: #f8f9fa;
  border-radius: 8px;
  padding: 20px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.05);
}

.markets-table-section {
  background: white;
  border-radius: 8px;
  padding: 20px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.05);
}

/* Filters */
.markets-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 15px;
  margin-bottom: 20px;
  padding-bottom: 15px;
  border-bottom: 1px solid #eee;
}

.filter-group {
  display: flex;
  flex-direction: column;
  min-width: 150px;
}

.filter-group label {
  font-size: 14px;
  margin-bottom: 5px;
  color: #555;
}

.filter-group select,
.filter-group input {
  padding: 8px 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 14px;
}

.filter-group-search {
  flex-grow: 1;
}

/* Table */
.markets-table-wrapper {
  overflow-x: auto;
  margin-bottom: 20px;
}

.markets-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

.markets-table th,
.markets-table td {
  padding: 12px 15px;
  text-align: left;
  border-bottom: 1px solid #eee;
}

.markets-table th {
  background-color: #f8f9fa;
  font-weight: 600;
}

.markets-table th.sortable-header {
  cursor: pointer;
}

.markets-table th.sortable-header:hover {
  background-color: #e9ecef;
}

.markets-table tbody tr:hover {
  background-color: #f8f9fa;
}

.markets-table .clickable-row {
  cursor: pointer;
}

.markets-table .market-name {
  font-weight: 600;
  margin-bottom: 5px;
}

.markets-table .market-description {
  color: #666;
  font-size: 13px;
}

.markets-table .market-category {
  display: inline-block;
  padding: 3px 8px;
  background: #e9ecef;
  border-radius: 4px;
  font-size: 12px;
}

.markets-table .market-status {
  display: inline-block;
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 12px;
  text-transform: capitalize;
}

.markets-table .market-status-active {
  background: #d4edda;
  color: #155724;
}

.markets-table .market-status-resolved {
  background: #cce5ff;
  color: #004085;
}

.markets-table .market-status-cancelled {
  background: #f8d7da;
  color: #721c24;
}

.markets-loading,
.markets-no-results {
  text-align: center;
  padding: 30px;
  color: #666;
}

/* Pagination */
.markets-pagination {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 15px;
  border-top: 1px solid #eee;
}

.pagination-info {
  color: #666;
  font-size: 14px;
}

.pagination-controls {
  display: flex;
  gap: 10px;
}

.pagination-button {
  padding: 8px 15px;
  border: 1px solid #ddd;
  background: white;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
}

.pagination-button:hover:not(:disabled) {
  background: #f8f9fa;
}

.pagination-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Analytics */
.markets-analytics h3 {
  margin-top: 0;
  margin-bottom: 20px;
}

.analytics-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 15px;
  margin-bottom: 30px;
}

.analytics-card {
  background: white;
  border-radius: 8px;
  padding: 20px;
  text-align: center;
  box-shadow: 0 2px 4px rgba(0,0,0,0.05);
}

.analytics-card .card-value {
  font-size: 24px;
  font-weight: 600;
  margin-bottom: 5px;
  color: #2c3e50;
}

.analytics-card .card-label {
  color: #666;
  font-size: 14px;
}

.analytics-distributions {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 20px;
}

.distribution-section h4 {
  margin-top: 0;
  margin-bottom: 15px;
}

.distribution-item {
  display: flex;
  align-items: center;
  margin-bottom: 10px;
}

.distribution-label {
  width: 100px;
  font-size: 14px;
}

.distribution-bar-container {
  flex-grow: 1;
  height: 20px;
  background: #eee;
  border-radius: 4px;
  overflow: hidden;
  margin: 0 10px;
}

.distribution-bar {
  height: 100%;
  background: #4299e1;
  border-radius: 4px;
}

.status-active {
  background: #48bb78;
}

.status-resolved {
  background: #4299e1;
}

.status-cancelled {
  background: #f56565;
}

.distribution-count {
  width: 80px;
  font-size: 12px;
  text-align: right;
  color: #666;
}

.markets-analytics-loading,
.markets-analytics-empty {
  padding: 20px;
  text-align: center;
  color: #666;
}
```

## Responsive Design

These components are designed to be responsive:

1. The table will scroll horizontally on small screens
2. The filters stack on mobile devices
3. The analytics cards and distributions adjust their layout based on screen size

## Integration with Next.js App Router

The implementation uses Next.js App Router with React Server Components:

1. The initial data is loaded server-side for fast page loads and SEO
2. Server Actions handle data fetching 
3. The MarketTable component handles client-side filtering and sorting
4. URL search params keep track of the current filters for bookmarking and sharing

## Customization

The implementation can be customized in several ways:

1. Change the styling to match your application's design system
2. Add additional filters for more specific searches
3. Extend the analytics component with charts and graphs
4. Add export functionality for CSV/Excel downloads
5. Implement saved searches or filter presets

## Performance Considerations

1. The MarketAnalytics component uses useMemo to avoid recalculating analytics on re-renders
2. Server-side rendering of initial data improves perceived performance
3. Pagination keeps network requests lightweight
4. Cursor-based pagination provides efficient navigation through large datasets

This reference implementation provides a solid foundation for building a robust market datatable in any application using the Wisdom SDK.