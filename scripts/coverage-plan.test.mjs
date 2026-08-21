import { describe, expect, it } from 'vitest';
import { validateCoverageInventory } from './check-coverage-inventory.mjs';

describe('coverage inventory', () => {
    it('accepts an exact, unique classification', () => {
        expect(() => validateCoverageInventory(
            ['covered.js', 'browser.js'],
            ['covered.js'],
            ['browser.js']
        )).not.toThrow();
    });

    it('rejects unclassified, stale, and duplicate assignments', () => {
        expect(() => validateCoverageInventory(['new.js'], [], []))
            .toThrow('unclassified sources: new.js');
        expect(() => validateCoverageInventory([], ['deleted.js'], []))
            .toThrow('stale assignments: deleted.js');
        expect(() => validateCoverageInventory(['same.js'], ['same.js'], ['same.js']))
            .toThrow('assigned more than once: same.js');
    });
});
