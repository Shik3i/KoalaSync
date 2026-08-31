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

describe('async room-session guards', () => {
    it('normalizes persisted room, peer, lobby and Force Sync state before restoration', () => {
        const restore = sourceBetween('function ensureState()', '// Start restoration immediately');
        expect(restore).toContain("typeof data.currentRoom.roomId === 'string'");
        expect(restore).toContain('.map(createPeerData)');
        expect(restore).toContain('data.currentRoom.activeLobby,');
        expect(restore).toContain('Array.isArray(data.forceSyncAcks)');
        expect(restore).toContain('currentRoom && Number.isFinite(data.forceSyncDeadline)');
        expect(restore).toContain('const restoredEpisodeLobby = currentRoom');
        expect(restore).toContain('data.episodeLobby,');
    });

    it('revalidates ROOM_DATA after every asynchronous join boundary', () => {
        const roomData = sourceBetween('case EVENTS.ROOM_DATA:', 'case EVENTS.CONTROL_MODE:');
        expect(roomData.match(/currentRoom\?\.roomId !== data\.roomId/g)?.length).toBeGreaterThanOrEqual(2);
        expect(roomData).toContain('const authoritativeLobby = normalizeEpisodeLobby(');
    });

    it('does not return chat context after its room or target changed', () => {
        const handler = sourceBetween("message.type === 'GET_CHAT_CONTEXT'", "message.type === 'CHAT_SEND'");
        expect(handler).toContain('const roomId = currentRoom.roomId');
        expect(handler).toContain('const isCurrentSession = () =>');
        expect(handler.indexOf('if (!isCurrentSession() || settings.roomId !== roomId)'))
            .toBeGreaterThan(handler.indexOf('await loadLocale'));
        expect(handler).not.toContain('roomId: currentRoom.roomId');
    });

    it('drops heartbeats and episode transitions that cross a room or target switch', () => {
        const heartbeat = sourceBetween("message.type === 'HEARTBEAT'", "message.type === 'INJECT_CONTENT_SCRIPT'");
        expect(heartbeat).toContain('const heartbeatRoomId = currentRoom?.roomId || null');
        expect(heartbeat).toContain("status: 'ignored_stale_session'");
        expect(heartbeat.indexOf('currentRoom?.roomId !== heartbeatRoomId'))
            .toBeLessThan(heartbeat.indexOf('emit(EVENTS.PEER_STATUS'));

        const episode = sourceBetween("message.type === 'EPISODE_CHANGED'", "message.type === 'EPISODE_READY_LOCAL'");
        expect(episode).toContain('const isCurrentEpisodeContext = () =>');
        expect(episode.match(/if \(!isCurrentEpisodeContext\(\)/g)?.length).toBeGreaterThanOrEqual(2);

        const ready = sourceBetween("message.type === 'EPISODE_READY_LOCAL'", "message.type === 'TITLE_PRIVACY_CHANGED'");
        expect(ready).toContain('settings.roomId !== lobbyRoomId');

        const privacy = sourceBetween("message.type === 'TITLE_PRIVACY_CHANGED'", "message.type === 'MEDIA_FRAME_CANDIDATE_CHANGED'");
        expect(privacy).toContain('currentRoom?.roomId !== privacyRoomId');
    });

    it('resolves content-event awaits before mutating canonical or room state', () => {
        const handler = sourceBetween("message.type === 'CONTENT_EVENT'", "message.type === 'FORCE_SYNC_ACK'");
        const processEventIndex = handler.indexOf('const processEvent = async () =>');
        const videoStateIndex = handler.indexOf('await getReadyTabVideoState(tabId)', processEventIndex);
        const settingsIndex = handler.indexOf('const settings = await getSettings()', videoStateIndex);
        const contextGuardIndex = handler.indexOf("sendResponse({ status: 'ignored_stale_session' })", settingsIndex);
        const supersedeIndex = handler.indexOf('supersedeCanonicalMediaRecovery(`local ${message.action}`)', contextGuardIndex);
        expect(videoStateIndex).toBeGreaterThan(-1);
        expect(settingsIndex).toBeGreaterThan(videoStateIndex);
        expect(contextGuardIndex).toBeGreaterThan(settingsIndex);
        expect(handler).toContain('(eventRoomId && settings.roomId !== eventRoomId)');
        expect(supersedeIndex).toBeGreaterThan(contextGuardIndex);
    });

    it('serializes new connection attempts behind terminal room teardown', () => {
        const teardown = sourceBetween('async function endRoomSession', 'async function leaveRoomAfterIdleGrace');
        expect(teardown).toContain('if (roomTeardownPromise) return roomTeardownPromise');
        expect(teardown).toContain('performRoomSessionTeardown(options)');

        for (const [start, end] of [
            ["message.type === 'CONNECT'", "message.type === 'RETRY_CONNECT'"],
            ["message.type === 'RETRY_CONNECT'", "message.type === 'GET_STATUS'"],
            ["message.type === 'WEB_JOIN_REQUEST'", "message.type === 'REGENERATE_ID'"],
            ["message.type === 'SET_TARGET_TAB'", "message.type === 'LOG'"]
        ]) {
            expect(sourceBetween(start, end)).toContain('await waitForRoomTeardown()');
        }
    });
});
