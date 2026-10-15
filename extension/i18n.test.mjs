import { describe, it, expect } from 'vitest';
import { getMessage } from './i18n.js';

describe('getMessage placeholders', () => {
    it('inserts values literally, including replacement patterns from peer data', () => {
        // Unknown keys fall back to the key itself, which still receives placeholders.
        expect(getMessage('Replace with {host}?', { host: 'a$&b.example' })).toBe('Replace with a$&b.example?');
        expect(getMessage('{name} joined', { name: "$'$`" })).toBe("$'$` joined");
    });
});
