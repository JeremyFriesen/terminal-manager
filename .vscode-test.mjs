import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.itest.js',
  workspaceFolder: 'src/test/fixture-workspace',
  launchArgs: ['--disable-extensions'],
  mocha: {
    ui: 'bdd',
    timeout: 30000,
  },
});
