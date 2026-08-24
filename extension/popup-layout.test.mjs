import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const popupSource = fs.readFileSync(path.join(extensionDir, 'popup.html'), 'utf8');

describe('popup layout containment', () => {
    it('prevents dynamic descendants from changing the 360px popup width', () => {
        expect(popupSource).toMatch(/html\s*\{[^}]*width:\s*360px;/s);
        expect(popupSource).toMatch(/html\s*\{[^}]*min-width:\s*360px;/s);
        expect(popupSource).toMatch(/html\s*\{[^}]*max-width:\s*360px;/s);
        expect(popupSource).toMatch(/html\s*\{[^}]*overflow-x:\s*hidden;/s);
        expect(popupSource).toMatch(/body\s*\{[^}]*width:\s*360px;/s);
        expect(popupSource).toMatch(/body\s*\{[^}]*max-width:\s*360px;/s);
        expect(popupSource).toMatch(/body\s*\{[^}]*contain:\s*inline-size;/s);
        expect(popupSource).toMatch(/body\s*\{[^}]*overflow-x:\s*hidden;/s);
    });
});
