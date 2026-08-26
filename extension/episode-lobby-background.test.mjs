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
        const guardIndex = handler.indexOf('if (!isCurrentLobbyContext() || settings.roomId !== lobbyRoomId)');
        const mutationIndex = handler.indexOf('lobby.readyPeers.push(peerId)');

        expect(handler).toContain('const lobby = episodeLobby');
        expect(handler).toContain('const isCurrentLobbyContext = () => episodeLobby === lobby');
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

    it('validates restored and authoritative lobby state before using readyPeers', () => {
        expect(backgroundSource).toContain('function normalizeEpisodeLobby(value, fallbackCreatedAt = Date.now(), allowedPeerIds = null)');
        expect(backgroundSource).toContain('data.currentRoom.activeLobby,');
        expect(backgroundSource).toContain('const authoritativeLobby = normalizeEpisodeLobby(');
        expect(backgroundSource).toContain('new Set(currentRoom.peers.map(candidate => candidate.peerId))');
    });

    it('rejects stale or unknown ready senders and correlates new ready frames to the lobby', () => {
        const remoteReady = sourceBetween('case EVENTS.EPISODE_READY:', 'case EVENTS.EPISODE_LOBBY_CANCEL:');
        expect(remoteReady).toContain('const senderPresent = currentRoom?.peers?.some');
        expect(remoteReady).toContain('!sameEpisode(data.expectedTitle, lobby.expectedTitle)');

        const localReady = sourceBetween("message.type === 'EPISODE_READY_LOCAL'", "message.type === 'TITLE_PRIVACY_CHANGED'");
        expect(localReady).toContain('expectedTitle: lobby.expectedTitle');
    });

    it('adopts authoritative correction data after the relay rejects a competing lobby', () => {
        const remoteLobby = sourceBetween('case EVENTS.EPISODE_LOBBY:', 'case EVENTS.EPISODE_READY:');
        expect(remoteLobby).toContain('data.authoritative === true && Array.isArray(data.readyPeers)');
        expect(remoteLobby).toContain('currentRoom.activeLobby = incomingLobby');
    });

    it('counts only ready peers who still participate in lobby completion', () => {
        const completion = sourceBetween('function checkEpisodeLobbyCompletion()', 'function checkEpisodeLobbyPeerDeparture()');
        expect(completion).toContain('const participatingPeerIds = new Set(peers');
        expect(completion).toContain('participatingPeerIds.has(candidate)');
        expect(completion).toContain('readyParticipatingCount >= participatingPeerIds.size');
    });

    it('re-evaluates or cancels a lobby when the local peer enters solo mode', () => {
        const desync = sourceBetween("message.type === 'HCM_DESYNC_STATE'", "message.type === 'LEAVE_ROOM'");
        expect(desync).toContain("cancelEpisodeLobby('Initiator entered solo mode')");
        expect(desync).toContain('checkEpisodeLobbyCompletion()');
    });
});
