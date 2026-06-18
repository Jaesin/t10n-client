import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'react/index': 'src/react/index.tsx',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // Never bundle React — a duplicate copy in the app tree throws "invalid hook call".
  external: ['react', 'react-dom'],
});
