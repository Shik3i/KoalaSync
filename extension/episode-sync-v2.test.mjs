import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    CAPABILITIES,
    EPISODE_LOBBY_TIMEOUT,
    EPISODE_SYNC_V2_LOAD_TIMEOUT,
    EPISODE_SYNC_V2_PREPARE_TIMEOUT,
    EPISODE_SYNC_V2_EXECUTE_TIMEOUT,
    EPISODE_SYNC_V2_STABILITY_MS,
    EVENTS
} from '../shared/constants.js';

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const backgroundSource = fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(extensionDir, 'content.js'), 'utf8');
const offlineSource = fs.readFileSync(path.join(extensionDir, 'offline-media-intent.js'), 'utf8');
const buildSource = fs.readFileSync(path.join(extensionDir, '..', 'scripts', 'build-extension.cjs'), 'utf8');

function between(source, startNeedle, endNeedle) {
    const start = source.indexOf(startNeedle);
    const end = source.indexOf(endNeedle, start + startNeedle.length);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
}

describe('Episode Sync v2 extension contract', () => {
    it('advertises the additive capability without changing the protocol', () => {
        expect(CAPABILITIES.EPISODE_SYNC_V2).toBe('episode-sync-v2');
        expect(EVENTS.EPISODE_SYNC_V2).toBe('episode_sync_v2');
        expect(backgroundSource).toContain('CAPABILITIES.EPISODE_SYNC_V2');
        expect(backgroundSource).toContain('EVENTS.EPISODE_SYNC_V2');
    });

    it('keeps v2 live-only and provides a session-correlated legacy fallback', () => {
        expect(offlineSource).toContain('EVENTS.EPISODE_SYNC_V2');
        const episodeChanged = between(
            backgroundSource,
            "message.type === 'EPISODE_CHANGED'",
            "message.type === 'EPISODE_READY_LOCAL'"
        );
        expect(episodeChanged).toContain('serverSupports(CAPABILITIES.EPISODE_SYNC_V2)');
        expect(episodeChanged).toContain("emitLive(EVENTS.EPISODE_SYNC_V2, { phase: 'start', ...episodeIdentity })");
        expect(episodeChanged).toContain('createPendingEpisodeSyncV2Start(episodeIdentity, sender)');
        expect(episodeChanged).toContain('startLegacyEpisodeLobbyForTransition(episodeIdentity, pending)');
        expect(backgroundSource).toContain("data.reason === 'capability_mismatch'");
        expect(backgroundSource).toContain('isEpisodeSyncV2StartContextCurrent(pending');
        expect(backgroundSource).toContain("emitLive(EVENTS.EPISODE_LOBBY, { peerId, expectedTitle: lobbyTitle })");

        const fallback = between(
            backgroundSource,
            'function startLegacyEpisodeLobbyForTransition(',
            'function clearTargetTabForIdle('
        );
        expect(fallback.indexOf('if (episodeLobby && sameEpisode('))
            .toBeLessThan(fallback.indexOf('emitLive(EVENTS.EPISODE_LOBBY'));
        const rejectionFallback = between(
            backgroundSource,
            "if (phase === 'cancel' && !data.transactionId)",
            "if (phase === 'lobby' || phase === 'prepare')"
        );
        expect(rejectionFallback.indexOf('if (!matchesPending)'))
            .toBeLessThan(rejectionFallback.indexOf('episodeSyncV2PendingStart = null'));
        expect(rejectionFallback).toContain('episodeSyncV2PendingStart = null');
    });

    it('correlates content reports to the current transaction, phase, target and episode', () => {
        const handler = between(
            backgroundSource,
            "message.type === 'EPISODE_SYNC_V2_LOCAL'",
            "message.type === 'TITLE_PRIVACY_CHANGED'"
        );
        expect(handler).toContain('message.transactionId !== transaction.transactionId');
        expect(handler).toContain('transaction.phase !== expectedLocalPhase');
        expect(handler).toContain("!isCurrentContentSender(sender)");
        expect(handler).toContain('!sameEpisodeIdentity(');
        expect(handler).toContain('emitLive(EVENTS.EPISODE_SYNC_V2');
    });

    it('separates legacy and v2 loading timeouts and converts remaining duration locally', () => {
        expect(EPISODE_LOBBY_TIMEOUT).toBe(60_000);
        expect(EPISODE_SYNC_V2_LOAD_TIMEOUT).toBe(120_000);
        expect(EPISODE_SYNC_V2_PREPARE_TIMEOUT).toBe(15_000);
        expect(EPISODE_SYNC_V2_EXECUTE_TIMEOUT).toBe(10_000);
        const normalize = between(
            backgroundSource,
            'function normalizeEpisodeSyncV2(',
            'function createPendingEpisodeSyncV2Start('
        );
        expect(normalize).toContain('createLocalEpisodeDeadline(value.remainingMs, phaseTimeout)');
        expect(normalize).toContain('deadlineAt: localDeadline.deadlineAt');
        expect(normalize).not.toContain('value.deadlineAt');
        expect(normalize).toContain("phase === 'prepare' ? EPISODE_SYNC_V2_PREPARE_TIMEOUT : EPISODE_SYNC_V2_EXECUTE_TIMEOUT");
    });

    it('requires the same player and episode to remain paused, seeked, buffered and stable', () => {
        const stable = between(
            contentSource,
            'function waitForEpisodeSyncV2Stable(',
            'async function prepareEpisodeSyncV2('
        );
        expect(stable).toContain('video === findVideo()');
        expect(stable).toContain('sameEpisodeIdentity(getMediaTitle(), state.expectedTitle, state.expectedEpisodeId)');
        expect(stable).toContain('video.paused');
        expect(stable).toContain('!video.seeking');
        expect(stable).toContain('video.readyState >= 3');
        expect(stable).toContain('Math.abs(current - targetTime) < 1');
        expect(stable).toContain('Date.now() - stableSince >= EPISODE_SYNC_V2_STABILITY_MS');
        expect(EPISODE_SYNC_V2_STABILITY_MS).toBe(1000);
    });

    it('reports prepared only after awaited pause, seek and stable verification', () => {
        const prepare = between(
            contentSource,
            'async function prepareEpisodeSyncV2(',
            'function failEpisodeSyncV2ForManualAction('
        );
        const pause = prepare.indexOf('await tryMediaAction(EVENTS.PAUSE)');
        const seek = prepare.indexOf('await tryMediaAction(EVENTS.SEEK');
        const stable = prepare.indexOf('await waitForEpisodeSyncV2Stable');
        const prepared = prepare.indexOf("reportEpisodeSyncV2Local(state, 'prepared')");
        expect(pause).toBeGreaterThan(-1);
        expect(seek).toBeGreaterThan(pause);
        expect(stable).toBeGreaterThan(seek);
        expect(prepared).toBeGreaterThan(stable);
    });

    it('restores playback only when this transaction paused a playing unchanged player', () => {
        const clear = between(
            contentSource,
            'async function clearEpisodeSyncV2Content(',
            'function checkEpisodeSyncV2Loaded('
        );
        expect(clear).toContain('state.pausedByTransaction');
        expect(clear).toContain('state.wasPlayingBeforePrepare');
        expect(clear).toContain('!state.manualAction');
        expect(clear).toContain('video === findVideo()');
        expect(clear).toContain('sameEpisodeIdentity(getMediaTitle(), state.expectedTitle, state.expectedEpisodeId)');
        expect(contentSource).toContain('failEpisodeSyncV2ForManualAction(action)');
    });

    it('does not restore playback ahead of a superseding room command', () => {
        const handler = between(
            contentSource,
            "message.type === 'EPISODE_SYNC_V2'",
            '// Episode Auto-Sync: Legacy lobby notification from background'
        );
        expect(handler).toContain("transaction.reason !== 'superseded'");
    });

    it('distinguishes deliberate loading intent and settles execute failures paused', () => {
        const eventSender = between(
            contentSource,
            'function sendContentEvent(',
            'function cancelPlayPauseCoalesce('
        );
        expect(eventSender).toContain("episodeSyncIntent = episodeSyncV2State?.phase === 'lobby'");
        expect(eventSender).toContain("? 'manual'");

        const loadingClassifier = between(
            contentSource,
            'function v2LoadingEventIsChurn(',
            'function queueEpisodeTransitionEvent('
        );
        expect(loadingClassifier).toContain("hcmClassifyIntent() === 'deliberate'");

        const handler = between(
            contentSource,
            "message.type === 'EPISODE_SYNC_V2'",
            '// Episode Auto-Sync: Legacy lobby notification from background'
        );
        expect(handler).toContain("transaction.settlePlaybackState === 'paused'");
        expect(handler).toContain('await tryMediaAction(EVENTS.PAUSE)');
        expect(handler).toContain('await tryMediaAction(EVENTS.SEEK, { targetTime })');
    });

    it('revalidates the complete prepared state immediately before execute', () => {
        const handler = between(
            contentSource,
            'function executeEpisodeSyncV2(',
            'function getPlayerActionFixes('
        );
        expect(handler).toContain("state.phase === 'prepare'");
        expect(handler).toContain('video === findVideo()');
        expect(handler).toContain('video.isConnected !== false');
        expect(handler).toContain('video.paused');
        expect(handler).toContain('!video.seeking');
        expect(handler).toContain('video.readyState >= 3');
        expect(handler).toContain('Math.abs(current) < 1');
    });

    it('reports content execute outcome and retains state until relay completion', () => {
        const execute = between(
            backgroundSource,
            'async function executeEpisodeSyncV2FromRelay(',
            'function clearEpisodeSyncV2State('
        );
        expect(execute).toContain("response?.status === 'executed' ? 'executed' : 'failed_execute'");
        expect(execute).toContain('phase: reportStatus');
        expect(execute).not.toContain('clearEpisodeSyncV2State(');

        const handler = between(
            backgroundSource,
            'case EVENTS.EPISODE_SYNC_V2:',
            'case EVENTS.EPISODE_LOBBY:'
        );
        expect(handler).toContain("phase === 'execute' || phase === 'complete' || phase === 'cancel'");
        expect(handler).toContain('await executeEpisodeSyncV2FromRelay(data)');
        expect(handler).toContain("phase: 'complete'");
        expect(handler).toContain("clearEpisodeSyncV2State({ notifyContent: false, reason: 'executed' })");
    });

    it('injects the shared stability window into packaged content scripts', () => {
        expect(buildSource).toContain('EPISODE_SYNC_V2_STABILITY_MS');
        expect(buildSource).toContain('episodeSyncStabilityVal');
        expect(buildSource).toContain(".replace(/export const /g, 'const ')");
    });
});
