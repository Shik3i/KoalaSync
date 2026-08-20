import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const backgroundSource = fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(extensionDir, 'content.js'), 'utf8');

function functionBody(source, name, nextName) {
    const start = source.indexOf(`function ${name}`);
    const end = source.indexOf(`function ${nextName}`, start + 1);
    return source.slice(start, end === -1 ? source.length : end);
}

describe('canonical ROOM_DATA recovery contract', () => {
    it('is capability-gated and treats absent/null media state as the old-relay path', () => {
        const handler = functionBody(backgroundSource, 'handleCanonicalRoomData', 'handleServerEvent');
        expect(handler).toContain('canonicalMediaStateFromRoomData(data)');
        expect(handler).toContain("canonicalSnapshot.status === 'unsupported'");
        expect(handler).toContain("canonicalSnapshot.status === 'empty'");
        expect(handler.indexOf('canonicalMediaStateFromRoomData(data)'))
            .toBeLessThan(handler.indexOf('canonicalMediaStateTracker.receive'));
    });

    it('keeps legacy PLAY/PAUSE/SEEK, Force Sync, Episode Lobby, and Host Control handlers independent of canonical recovery', () => {
        const serverHandler = functionBody(backgroundSource, 'handleServerEvent', 'executeForceSync');
        expect(serverHandler).toContain('case EVENTS.PLAY:');
        expect(serverHandler).toContain('case EVENTS.PAUSE:');
        expect(serverHandler).toContain('case EVENTS.SEEK:');
        expect(serverHandler).toContain('case EVENTS.FORCE_SYNC_PREPARE:');
        expect(serverHandler).toContain('case EVENTS.FORCE_SYNC_EXECUTE:');
        expect(serverHandler).toContain('case EVENTS.EPISODE_LOBBY:');
        expect(serverHandler).toContain('case EVENTS.CONTROL_MODE:');
        expect(serverHandler).not.toMatch(/case EVENTS\.(?:PLAY|PAUSE|SEEK):[\s\S]{0,500}MEDIA_STATE_V1/);
    });

    it('uses a dedicated internal apply message without action/history/ACK machinery', () => {
        const apply = functionBody(backgroundSource, 'tryApplyPendingCanonicalMediaState', 'handleCanonicalRoomData');
        expect(apply).toContain("type: 'APPLY_CANONICAL_MEDIA_STATE'");
        expect(apply).not.toContain('routeToContent(');
        expect(apply).not.toContain('emit(');
        expect(apply).not.toContain('addToHistory(');
        expect(apply).not.toContain('EVENT_ACK');

        const contentHandlerStart = contentSource.indexOf("message.type === 'APPLY_CANONICAL_MEDIA_STATE'");
        const serverCommandStart = contentSource.indexOf("message.type === 'SERVER_COMMAND'", contentHandlerStart);
        const internalHandler = contentSource.slice(contentHandlerStart, serverCommandStart);
        expect(internalHandler).toContain('applyCanonicalMediaState(message.mediaState)');
        expect(internalHandler).not.toContain('CMD_ACK');
        expect(internalHandler).not.toContain('CONTENT_EVENT');
    });

    it('keeps pending recovery room-scoped and retries on target lifecycle signals', () => {
        expect(backgroundSource).toContain("'canonicalMediaRecovery'");
        expect(backgroundSource).toContain('canonicalMediaStateTracker.restore(');
        expect(backgroundSource).toContain('tryApplyPendingCanonicalMediaState().catch(() => {})');
        expect(backgroundSource).toMatch(/currentTargetHasVideo\) \{\s*await tryApplyPendingCanonicalMediaState\(\)/);
        expect(backgroundSource.match(/clearCanonicalMediaRecovery\(\)/g)?.length).toBeGreaterThanOrEqual(4);
        const apply = functionBody(backgroundSource, 'tryApplyPendingCanonicalMediaState', 'handleCanonicalRoomData');
        expect(apply).toContain('getPendingProjected(roomId)');
        expect(apply).toContain('targetActivationGeneration');
        expect(apply).toContain("return { status: 'stale_target' }");
    });

    it('protects intentional desync, active Episode Lobby and queued reconnect intent', () => {
        const apply = functionBody(backgroundSource, 'tryApplyPendingCanonicalMediaState', 'handleCanonicalRoomData');
        const roomData = functionBody(backgroundSource, 'handleCanonicalRoomData', 'handleServerEvent');
        expect(apply).toContain('if (hcmDesynced)');
        expect(apply).toContain('if (episodeLobby)');
        expect(roomData).toContain('if (hasPendingLocalIntent)');
        expect(backgroundSource).toContain('awaitingRoomData = true');
        expect(backgroundSource).toContain('await handleCanonicalRoomData(data, queuePolicy.hasPendingLocalIntent)');
        expect(backgroundSource).toContain('await flushEventQueue(replaySettings)');
    });

    it('reuses existing seek abstractions, suppression and drift tolerance', () => {
        const apply = functionBody(contentSource, 'applyCanonicalMediaState', 'pollSeekReady');
        expect(apply).toContain('Math.abs(drift) >= MIN_SEEK_DELTA');
        expect(apply).toContain("_setSuppress('seek')");
        expect(apply).toContain('seekVideo(video, mediaState.currentTime)');
        expect(apply).toContain('tryMediaAction(EVENTS.PAUSE)');
        expect(apply).toContain('tryMediaAction(EVENTS.PLAY)');
        expect(apply).toContain('if (hcmDesynced)');
    });
});
