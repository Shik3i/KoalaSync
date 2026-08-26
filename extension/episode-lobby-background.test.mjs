import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const backgroundSource = fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8');

function sourceBetween(startNeedle, endNeedle) {
    const start = backgroundSource.indexOf(startNeedle);
    const end = backgroundSource.indexOf(endNeedle, start + startNeedle.length);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return backgroundSource.slice(start, end);
}

describe('episode lobby completion races', () => {
    it('does not read the cleared lobby after a remote ready completes it', () => {
        const handler = sourceBetween('case EVENTS.EPISODE_READY:', 'case EVENTS.EPISODE_LOBBY_CANCEL:');
        const snapshotIndex = handler.indexOf('const readyPeers = [...lobby.readyPeers]');
        const roomUpdateIndex = handler.indexOf('currentRoom.activeLobby.readyPeers = readyPeers');
        const completionIndex = handler.indexOf('checkEpisodeLobbyCompletion()');

        expect(snapshotIndex).toBeGreaterThan(-1);
        expect(roomUpdateIndex).toBeGreaterThan(snapshotIndex);
        expect(completionIndex).toBeGreaterThan(roomUpdateIndex);
        expect(handler.slice(completionIndex)).not.toContain('episodeLobby.readyPeers');
    });

    it('revalidates the lobby after awaiting settings for a local ready', () => {
        const handler = sourceBetween("message.type === 'EPISODE_READY_LOCAL'", "message.type === 'TITLE_PRIVACY_CHANGED'");
        const awaitIndex = handler.indexOf('const settings = await getSettings()');
        const guardIndex = handler.indexOf('if (episodeLobby !== lobby)');
        const mutationIndex = handler.indexOf('lobby.readyPeers.push(peerId)');

        expect(handler).toContain('const lobby = episodeLobby');
        expect(awaitIndex).toBeGreaterThan(-1);
        expect(guardIndex).toBeGreaterThan(awaitIndex);
        expect(mutationIndex).toBeGreaterThan(guardIndex);
    });

    it('clears the persisted room lobby when completion starts Force Sync', () => {
        const execute = sourceBetween('function executeEpisodeLobby()', 'function checkEpisodeLobbyCompletion()');
        const roomClearIndex = execute.indexOf('currentRoom.activeLobby = null');
        const lobbyClearIndex = execute.indexOf('clearEpisodeLobbyState()');

        expect(roomClearIndex).toBeGreaterThan(-1);
        expect(lobbyClearIndex).toBeGreaterThan(roomClearIndex);
        expect(execute).toContain('chrome.storage.session.set({ currentRoom })');
    });
});
