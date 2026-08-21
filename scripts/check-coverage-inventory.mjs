#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTERNALLY_GATED_SOURCES, VITEST_COVERAGE_INCLUDE } from './coverage-plan.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOTS = Object.freeze(['extension', 'scripts', 'server', 'shared', 'website']);
const SOURCE_EXTENSION = /\.(?:cjs|js|mjs)$/u;
const TEST_FILE = /\.test\.(?:cjs|js|mjs)$/u;
const GENERATED_OR_DEPENDENCY_DIRECTORIES = new Set(['extension/shared', 'server/node_modules', 'website/www']);

export function validateCoverageInventory(discoveredSources, coveredSources, externallyGatedSources) {
    const discovered = new Set(discoveredSources);
    const assignments = [...coveredSources, ...externallyGatedSources];
    const assigned = new Set();
    const duplicates = new Set();
    for (const source of assignments) {
        if (assigned.has(source)) duplicates.add(source);
        assigned.add(source);
    }
    const unclassified = [...discovered].filter(source => !assigned.has(source)).sort();
    const stale = [...assigned].filter(source => !discovered.has(source)).sort();
    if (duplicates.size || unclassified.length || stale.length) {
        const details = [];
        if (duplicates.size) details.push(`assigned more than once: ${[...duplicates].sort().join(', ')}`);
        if (unclassified.length) details.push(`unclassified sources: ${unclassified.join(', ')}`);
        if (stale.length) details.push(`stale assignments: ${stale.join(', ')}`);
        throw new Error(details.join('; '));
    }
}

function collectSources(directory, output = []) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            const relativeDirectory = path.relative(repoRoot, absolutePath).split(path.sep).join('/');
            if (!GENERATED_OR_DEPENDENCY_DIRECTORIES.has(relativeDirectory)) collectSources(absolutePath, output);
        } else if (SOURCE_EXTENSION.test(entry.name) && !TEST_FILE.test(entry.name)) {
            output.push(path.relative(repoRoot, absolutePath).split(path.sep).join('/'));
        }
    }
    return output;
}

function main() {
    const discoveredSources = SOURCE_ROOTS.flatMap(root => collectSources(path.join(repoRoot, root))).sort();
    const externallyGatedSources = Object.values(EXTERNALLY_GATED_SOURCES).flat();
    validateCoverageInventory(discoveredSources, VITEST_COVERAGE_INCLUDE, externallyGatedSources);
    console.log(`Coverage inventory passed: ${VITEST_COVERAGE_INCLUDE.length} V8-covered, ${externallyGatedSources.length} externally gated`);
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
    try {
        main();
    } catch (error) {
        console.error(`Coverage inventory failed: ${error.message}`);
        process.exitCode = 1;
    }
}
