import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    workspace: {
      include: ['packages/*'],
    },
    entry: ['src/index.ts'],
    format: 'esm',
    platform: 'node',
    fixedExtension: false,
    dts: true,
    clean: true,
    tsconfig: './tsconfig.json',
  },
  {
    workspace: {
      include: ['apps/server'],
    },
    entry: ['src/main.ts', 'src/index.ts'],
    format: 'esm',
    platform: 'node',
    fixedExtension: false,
    dts: true,
    clean: true,
    tsconfig: './tsconfig.json',
  },
]);
