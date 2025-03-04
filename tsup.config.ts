import { defineConfig } from 'tsup';
import fs from 'fs';
import path from 'path';

// Create entry point files for each store module
const storeModules = [
  'market-store',
  'prediction-store',
  'user-balance-store',
  'user-stats-store',
  'bug-report-store',
  'kv-store',
  'utils',
  'logger'
];

// Create entry files dynamically
storeModules.forEach(module => {
  const entryFile = path.join('src', `${module}.entry.ts`);
  if (!fs.existsSync(entryFile)) {
    fs.writeFileSync(
      entryFile,
      `// Entry point for ${module} subpath export\nexport * from './${module}.js';\n`
    );
  }
});

// Build entry configuration
const entries = {
  'index': 'src/index.ts',
  ...Object.fromEntries(
    storeModules.map(module => [
      module, 
      `src/${module}.entry.ts`
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