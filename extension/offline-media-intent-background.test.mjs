import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const backgroundSource = fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8');

function functionBody(name, nextName) {
    const start = backgroundSource.indexOf(`function ${name}(`);
    const end = backgroundSource.indexOf(`function ${nextName}(`, start + 1);
    return backgroundSource.slice(start, end === -1 ? backgroundSource.length : end);
}

describe('offline media intent background integration', () => {
    it('keeps online sends immediate and defers reconnect work only while ROOM_DATA is pending', () => {
        const emit = functionBody('emit', 'emitLive');
        expect(emit).toContain('mustWaitForRoomData');
        expect(emit).toContain('&& !flushInProgress');
        expect(emit).toContain('socket.send(msg)');
        expect(emit).toContain('queueEvent(event, data)');
        expect(emit).not.toContain('setTimeout');
        expect(backgroundSource).toMatch(/awaitingRoomData = true;[\s\S]*emit\(EVENTS\.JOIN_ROOM/);
    });

    it('restores and migrates the persisted MV3 queue with a monotonic local sequence', () => {
        expect(backgroundSource).toContain('normalizePersistedEventQueue(');
        expect(backgroundSource).toContain('localSeq = Math.max(localSeq, maxQueuedSequence(eventQueue))');
        expect(backgroundSource).toContain('chrome.storage.session.set({ eventQueue, localSeq })');
        expect(backgroundSource).not.toContain('storage.sync.set({ eventQueue');
        expect(backgroundSource).toContain('if (restorationTimedOut) return');
    });

    it('reconciles Host Control, Episode Lobby and solo mode before canonical recovery and replay', () => {
        const roomDataStart = backgroundSource.indexOf('case EVENTS.ROOM_DATA:');
        const roomDataEnd = backgroundSource.indexOf('case EVENTS.CONTROL_MODE:', roomDataStart);
        const roomData = backgroundSource.slice(roomDataStart, roomDataEnd);
        expect(roomData.indexOf('applyQueuedRoomPolicy(data.roomId'))
            .toBeLessThan(roomData.indexOf('handleCanonicalRoomData(data, queuePolicy.hasPendingLocalIntent)'));
        expect(roomData.indexOf('handleCanonicalRoomData(data, queuePolicy.hasPendingLocalIntent)'))
            .toBeLessThan(roomData.indexOf('flushEventQueue(replaySettings)'));
        expect(roomData).toContain('activeLobby: !!episodeLobby');
        expect(roomData).toContain('desynced: hcmDesynced');
        expect(roomData).toContain('if (!data?.activeLobby && episodeLobby && !hasQueuedLocalLobby)');
        expect(roomData).toContain('authoritativeLobby: !!data.activeLobby');
    });

    it('clears queued room intent on failed join, leave and room switch paths', () => {
        expect(functionBody('clearFailedJoinCredentials', 'invalidateChatSession')).toContain('clearEventQueue()');
        expect(functionBody('forceDisconnect', 'persistRoomIdleState')).toContain('eventQueue = []');
        expect(functionBody('leaveOldRoomIfSwitching', 'resetAudioProcessingInTab')).toContain('forceDisconnect()');
        const leaveHandler = backgroundSource.slice(
            backgroundSource.indexOf("message.type === 'LEAVE_ROOM'"),
            backgroundSource.indexOf("message.type === 'CLEAR_LOGS'")
        );
        expect(leaveHandler).toContain('forceDisconnect()');
        const retryHandler = backgroundSource.slice(
            backgroundSource.indexOf("message.type === 'RETRY_CONNECT'"),
            backgroundSource.indexOf("message.type === 'GET_STATUS'")
        );
        expect(retryHandler).toContain('forceDisconnect({ preserveEventQueue: true })');
    });

    it('paces actual frames through a failure-retaining logical drain', () => {
        const flush = functionBody('flushEventQueue', 'addToHistory');
        expect(flush).toContain('drainQueuedBatch(drainSource');
        expect(flush).toContain('maxWireEvents: FLUSH_BATCH_SIZE');
        expect(flush).toContain('return emitLive(frame.event, payload)');
        expect(flush).toContain('if (eventQueueVersion === drainVersion)');
        expect(flush).toContain('const consumedEntries = new Set(drainSource.slice(0, consumedCount))');
        expect(flush).toContain('eventQueue = eventQueue.filter(entry => !consumedEntries.has(entry))');
        expect(flush).toContain('flushConnectionGeneration !== connectionGeneration');
        expect(flush).not.toMatch(/eventQueue\.shift\(\)[\s\S]*emit\(/);
    });

    it('generation-scopes socket callbacks and stale ROOM_DATA work', () => {
        expect(backgroundSource).toContain('let connectionGeneration = 0');
        expect(backgroundSource).toContain('socket !== connectionSocket');
        expect(backgroundSource).toContain('handleServerEvent(payload[0], payload[1], generation)');
        expect(backgroundSource).toContain('expectedConnectionGeneration !== connectionGeneration');
        expect(backgroundSource).toContain('data.roomId !== pendingRoomDataRoomId');
    });

    it('exposes bounded queue diagnostics without media-title content', () => {
        expect(backgroundSource).toContain('queuedLogicalEvents: eventQueue.length');
        expect(backgroundSource).toContain('queuedMediaIntents: queuedMediaIntentCount');
        expect(backgroundSource).toContain('queuedWireEvents: queuedWireCount(eventQueue)');
        expect(backgroundSource).not.toMatch(/Offline media intent[^`'\n]*mediaTitle/);
    });
});
