import { defineConfig } from 'tsup';

// Store modules to build
const storeModules = [
  'market-store',
  'prediction-store',
  'custody-store',
  'prediction-contract-store',
  'user-balance-store',
  'user-stats-store',
  'bug-report-store',
  'kv-store',
  'utils',
  'logger'
];

// Build entry configuration - use direct file paths
const entries = {
  'index': 'src/index.ts',
  ...Object.fromEntries(
    storeModules.map(module => [
      module,
      `src/${module}.ts`
    ])
  )
};

export default defineConfig({
  entry: entries,
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  tsconfig: './tsconfig.json',
  treeshake: true,
  minify: false, // Start without minification for easier debugging
});