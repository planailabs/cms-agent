#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const packagePath = resolve(root, 'package.json');
const buildInfoPath = resolve(root, 'src/lib/buildInfo.ts');
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
const buildInfo = readFileSync(buildInfoPath, 'utf8');
const match = buildInfo.match(/APP_VERSION = 'v(\d+\.\d+\.\d+)'/);

if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || !match) {
  throw new Error('Expected semantic versions in package.json and src/lib/buildInfo.ts');
}

if (process.argv[2] === 'check') {
  if (pkg.version !== match[1]) throw new Error(`Version mismatch: ${pkg.version} != ${match[1]}`);
  console.log(`v${pkg.version}`);
} else if (process.argv[2] === 'bump') {
  if (pkg.version !== match[1]) throw new Error('Refusing to bump mismatched versions; reconcile them first');
  const parts = pkg.version.split('.').map(Number);
  parts[2] += 1;
  const version = parts.join('.');
  const packageText = readFileSync(packagePath, 'utf8').replace(
    /("version"\s*:\s*")\d+\.\d+\.\d+("\s*,)/,
    `$1${version}$2`,
  );
  writeFileSync(packagePath, packageText);
  writeFileSync(buildInfoPath, buildInfo.replace(`APP_VERSION = 'v${pkg.version}'`, `APP_VERSION = 'v${version}'`));
  console.log(`v${version}`);
} else {
  throw new Error('Usage: version.mjs check|bump');
}
