# Next Steps for Wisdom SDK

This document outlines planned improvements and features for the Wisdom SDK.

## Search and Query Enhancements

Recently implemented:
- Basic query filtering for markets by category, status, and text search
- Pagination with offset/limit and cursor support
- Sorting by various fields (creation date, end date, participants, pool amount)
- Simple secondary indexes for categories and status

Future improvements:

### Short-term (1-2 weeks)
- [ ] Cache expensive query results to improve performance
- [ ] Add case-insensitive search for market fields beyond name/description
- [ ] Implement tag-based search for markets (allowing multiple tags per market)
- [ ] Add date range filters for creation date and end date
- [ ] Expose search and query functionality in new SDK entry points

### Medium-term (1-2 months)
- [ ] Implement more sophisticated text search with tokenization, stemming, and stop word removal
- [ ] Create time-series data storage for market activity metrics (predictions over time, pool growth)
- [ ] Add support for complex boolean queries (AND/OR combinations of filters)
- [ ] Extend Redis indexes for optimal performance with large datasets
- [ ] Add faceted search to allow aggregating results by category, type, etc.

### Long-term (2+ months)
- [ ] Consider dedicated search service implementation (Elasticsearch)
- [ ] Add personalized search based on user preferences and past activity
- [ ] Implement real-time search updates
- [ ] Develop analytics dashboard with sophisticated querying capabilities
- [ ] Design a query DSL for advanced search needs

## Performance Optimizations

- [ ] Benchmark and optimize the most common query patterns
- [ ] Implement connection pooling for Redis operations
- [ ] Add intelligent query result caching
- [ ] Consider denormalization strategies for frequently accessed data
- [ ] Profile and optimize memory usage for large result sets

## Developer Experience

- [ ] Improve error messages for query-related operations
- [ ] Better TypeScript typing for query parameters and results
- [ ] Add examples and documentation for search and query features
- [ ] Create helper utilities for common search patterns
- [ ] Develop query builder tools to simplify complex searches