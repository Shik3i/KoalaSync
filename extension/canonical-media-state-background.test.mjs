import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const backgroundSource = fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(extensionDir, 'content.js'), 'utf8');

function functionBody(source, name, nextName) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf(`function ${nextName}(`, start + 1);
    expect(start).toBeGreaterThan(-1);
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
        expect(backgroundSource).toMatch(/CLIENT_CAPABILITIES[\s\S]{0,160}CAPABILITIES\.MEDIA_STATE_V1/);
        expect(backgroundSource).toContain('!serverSupports(CAPABILITIES.MEDIA_STATE_V1)');
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
        const apply = functionBody(backgroundSource, 'performPendingCanonicalMediaStateApply', 'tryApplyPendingCanonicalMediaState');
        expect(apply).toContain("type: 'APPLY_CANONICAL_MEDIA_STATE'");
        expect(apply).toContain('enqueueContentCommand(async () =>');
        expect(apply).toContain('canonicalMediaStateTracker.getPending(roomId)');
        expect(apply).not.toContain('routeToContent(');
        expect(apply).not.toContain('emit(');
        expect(apply).not.toContain('addToHistory(');
        expect(apply).not.toContain('EVENT_ACK');

        const contentHandlerStart = contentSource.indexOf("message.type === 'APPLY_CANONICAL_MEDIA_STATE'");
        const serverCommandStart = contentSource.indexOf("message.type === 'SERVER_COMMAND'", contentHandlerStart);
        const internalHandler = contentSource.slice(contentHandlerStart, serverCommandStart);
        expect(internalHandler).toContain('const applyGeneration = beginCanonicalMediaApply()');
        expect(internalHandler).toContain('applyCanonicalMediaState(message.mediaState, applyGeneration)');
        expect(internalHandler).not.toContain('CMD_ACK');
        expect(internalHandler).not.toContain('CONTENT_EVENT');
    });

    it('keeps pending recovery room-scoped and retries on target lifecycle signals', () => {
        expect(backgroundSource).toContain("'canonicalMediaRecovery'");
        expect(backgroundSource).toContain('canonicalMediaStateTracker.restore(');
        expect(backgroundSource).toContain('CANONICAL_RECOVERY_RETRY_DELAYS');
        expect(backgroundSource).toContain('requestCanonicalMediaRecoveryAttempt()');
        expect(backgroundSource).toMatch(/message\.type === 'HEARTBEAT'[\s\S]*requestCanonicalMediaRecoveryAttempt\(\)/);
        expect(backgroundSource).toMatch(/message\.type === 'CONTENT_BOOT'[\s\S]*requestCanonicalMediaRecoveryAttempt\(\)/);
        expect(backgroundSource).toMatch(/currentTargetHasVideo\) \{\s*await tryApplyPendingCanonicalMediaState\(\)/);
        expect(backgroundSource.match(/clearCanonicalMediaRecovery\(\)/g)?.length).toBeGreaterThanOrEqual(4);
        const apply = functionBody(backgroundSource, 'performPendingCanonicalMediaStateApply', 'tryApplyPendingCanonicalMediaState');
        expect(apply).toContain('getPendingProjected(roomId)');
        expect(apply).toContain('targetActivationGeneration');
        expect(apply).toContain("return { status: 'stale_target' }");
        const retry = functionBody(backgroundSource, 'scheduleCanonicalMediaRecoveryRetry', 'requestCanonicalMediaRecoveryAttempt');
        expect(retry).toContain('canonicalRecoveryRetryAttempt >= CANONICAL_RECOVERY_RETRY_DELAYS.length');
        expect(retry).toContain('latest?.mediaState.revision !== expectedRevision');
        const clear = functionBody(backgroundSource, 'clearCanonicalMediaRecovery', 'invalidateChatSession');
        expect(clear).toContain('canonicalRecoveryApplyInProgress = null');
    });

    it('protects intentional desync, active Episode Lobby and queued reconnect intent', () => {
        const apply = functionBody(backgroundSource, 'performPendingCanonicalMediaStateApply', 'tryApplyPendingCanonicalMediaState');
        const roomData = functionBody(backgroundSource, 'handleCanonicalRoomData', 'handleServerEvent');
        expect(apply).toContain('if (hcmDesynced)');
        expect(apply).toContain('if (episodeLobby || episodeSyncV2)');
        expect(roomData).toContain('if (hasPendingLocalIntent)');
        expect(backgroundSource).toContain('awaitingRoomData = true');
        expect(backgroundSource).toContain('await handleCanonicalRoomData(data, queuePolicy.hasPendingLocalIntent)');
        expect(backgroundSource).toContain('await flushEventQueue(replaySettings)');
    });

    it('supersedes pending recovery only after newer local or accepted remote room control', () => {
        const supersede = functionBody(backgroundSource, 'supersedeCanonicalMediaRecovery', 'performPendingCanonicalMediaStateApply');
        expect(supersede).toContain('canonicalMediaStateTracker.getPending(roomId)');
        expect(supersede).toContain('markCanonicalMediaStateHandled(roomId, pending.mediaState.revision)');
        expect(supersede).toContain("type: 'CANCEL_CANONICAL_MEDIA_STATE'");
        expect(supersede).toContain('action,');
        expect(supersede).toContain('payload');
        expect(backgroundSource).toContain('function isCanonicalSupersedingControl(event, data)');
        expect(backgroundSource).toContain('supersedeCanonicalMediaRecovery(`newer ${event}`)');
        expect(backgroundSource).toContain('supersedeCanonicalMediaRecovery(`local ${message.action}`)');
        expect(backgroundSource.indexOf("sendResponse({ status: 'blocked_host_only' })"))
            .toBeLessThan(backgroundSource.indexOf('supersedeCanonicalMediaRecovery(`local ${message.action}`)'));
    });

    it('awaits media actions and verifies playback plus drift before acknowledging recovery', () => {
        const apply = functionBody(contentSource, 'applyCanonicalMediaState', 'pollSeekReady');
        expect(apply).toContain('Math.abs(drift) >= MIN_SEEK_DELTA');
        expect(apply).toContain("_setSuppress('seek')");
        expect(apply).toContain('await tryMediaAction(EVENTS.SEEK');
        expect(apply).toContain('await tryMediaAction(EVENTS.PAUSE)');
        expect(apply).toContain('await tryMediaAction(EVENTS.PLAY)');
        expect(apply).toContain('await pollCanonicalMediaState(mediaState, startedAt, applyGeneration)');
        expect(apply.indexOf("status: 'applied'"))
            .toBeGreaterThan(apply.indexOf('await pollCanonicalMediaState(mediaState, startedAt, applyGeneration)'));
        expect(apply).toContain('isCanonicalMediaApplyCurrent(applyGeneration)');
        expect(apply).toContain('restoreSupersedingLocalState(video)');
        expect(apply).toContain('if (hcmDesynced)');
        expect(apply).toContain('isDifferentEpisode(mediaState.mediaTitle, localMediaTitle)');
        expect(apply).toContain("status: 'ignored_episode_mismatch'");
        const contentHandlerStart = contentSource.indexOf("message.type === 'APPLY_CANONICAL_MEDIA_STATE'");
        const serverCommandStart = contentSource.indexOf("message.type === 'SERVER_COMMAND'", contentHandlerStart);
        expect(contentSource.slice(contentHandlerStart, serverCommandStart))
            .toContain('applyCanonicalMediaState(message.mediaState, applyGeneration).then(sendResponse)');
        expect(contentSource).toContain("message.type === 'CANCEL_CANONICAL_MEDIA_STATE'");
        expect(contentSource).toContain('cancelCanonicalMediaApply(action, findVideo(), false, payload)');
        expect(contentSource).toContain('restorationGeneration !== canonicalMediaApplyGeneration');
        expect(contentSource).toContain('holdCanonicalRestorePlaySuppression()');
        expect(contentSource).toContain('consumeCanonicalRestorePlaySuppression()');
        expect(contentSource).toContain('cancelCanonicalMediaApply(EVENTS.SEEK, video)');
    });
});
