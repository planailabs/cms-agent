#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const buildInfoPath = resolve(root, 'src/lib/buildInfo.ts');
const buildInfo = readFileSync(buildInfoPath, 'utf8');
const match = buildInfo.match(/APP_VERSION = 'v(\d+\.\d+\.\d+)'/);

if (!match) throw new Error('Expected APP_VERSION in src/lib/buildInfo.ts');

if (process.argv[2] === 'check') {
  console.log(`v${match[1]}`);
} else if (process.argv[2] === 'bump') {
  const parts = match[1].split('.').map(Number);
  parts[2] += 1;
  const version = parts.join('.');
  writeFileSync(buildInfoPath, buildInfo.replace(`APP_VERSION = 'v${match[1]}'`, `APP_VERSION = 'v${version}'`));
  console.log(`v${version}`);
} else {
  throw new Error('Usage: version.mjs check|bump');
}
