#!/usr/bin/env node
// Launcher so the tool can be run as `rugwatch` after `npm link`. The CLI module
// only self-executes when it is the process entry point, so the launcher calls
// run() explicitly.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
try { register('tsx/esm', pathToFileURL('./')); } catch { /* a built dist/ is used instead */ }
const { run } = await import('../src/cli/index.ts');
run();
