import { describe, expect, it } from 'vitest';
import { generateUsername, getAvatarForName, USERNAME_ADJECTIVES, USERNAME_NOUNS } from './names.js';

describe('generated peer names', () => {
    it.each([
        ['Koala', '🐨'],
        ['koala', '🐨'],
        ['MyKoalaUser', '🐨'],
        ['Tiger', '🐯'],
        ['Panda', '🐼'],
        ['Fox', '🦊'],
        ['CaterpillarCat', '🐛'],
        ['Cat', '🐱'],
        ['Polar', '🐻\u200D❄️'],
        ['Crow', '🐦\u200D⬛'],
        ['Ninja', '🥷'],
        ['Wizard', '🧙'],
        ['Pirate', '🏴'],
        ['Alien', '👾'],
        ['Robot', '🤖']
    ])('maps %s to %s', (name, avatar) => {
        expect(getAvatarForName(name)).toBe(avatar);
    });

    it.each(['', 'Xyzzy123', null, undefined])('uses the fallback for %j', name => {
        expect(getAvatarForName(name)).toBe('👤');
    });

    it('generates only adjective-noun combinations', () => {
        for (let sample = 0; sample < 100; sample++) {
            const name = generateUsername();
            expect(name).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+$/);
            expect(USERNAME_ADJECTIVES.some(adjective => name.startsWith(adjective))).toBe(true);
            expect(USERNAME_NOUNS.some(noun => name.endsWith(noun))).toBe(true);
        }
    });

    it('defines an avatar for every generated noun', () => {
        for (const noun of USERNAME_NOUNS) expect(getAvatarForName(noun)).not.toBe('👤');
    });
});
