import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, EVENTS, EPISODE_SYNC_V2_STABILITY_MS } from '../shared/constants.js';

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

    it('never queues v2 coordination or auto-falls back to a client-owned legacy lobby', () => {
        expect(offlineSource).toContain('EVENTS.EPISODE_SYNC_V2');
        const episodeChanged = between(
            backgroundSource,
            "message.type === 'EPISODE_CHANGED'",
            "message.type === 'EPISODE_READY_LOCAL'"
        );
        expect(episodeChanged).toContain('serverSupports(CAPABILITIES.EPISODE_SYNC_V2)');
        expect(episodeChanged).toContain("emitLive(EVENTS.EPISODE_SYNC_V2, { phase: 'start'");
        expect(episodeChanged).not.toContain('PAUSE_FOR_LOBBY');
        expect(episodeChanged).not.toContain('emit(EVENTS.EPISODE_LOBBY');
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
        expect(handler).toContain('!sameEpisodeStrict(localTitle, transaction.expectedTitle)');
        expect(handler).toContain('emitLive(EVENTS.EPISODE_SYNC_V2');
    });

    it('requires the same player and episode to remain paused, seeked, buffered and stable', () => {
        const stable = between(
            contentSource,
            'function waitForEpisodeSyncV2Stable(',
            'async function prepareEpisodeSyncV2('
        );
        expect(stable).toContain('video === findVideo()');
        expect(stable).toContain('sameEpisodeStrict(getMediaTitle(), state.expectedTitle)');
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
        expect(clear).toContain('sameEpisodeStrict(getMediaTitle(), state.expectedTitle)');
        expect(contentSource).toContain('failEpisodeSyncV2ForManualAction(action)');
    });

    it('does not restore playback ahead of a superseding room command', () => {
        const handler = between(
            contentSource,
            "message.type === 'EPISODE_SYNC_V2'",
            '// Episode Auto-Sync: Legacy lobby notification from background'
        );
        expect(handler).toContain("resume: transaction.reason !== 'superseded'");
    });

    it('revalidates the complete prepared state immediately before execute', () => {
        const handler = between(
            contentSource,
            "transaction.phase === 'execute'",
            "transaction.phase === 'cancel'"
        );
        expect(handler).toContain("state.phase === 'prepare'");
        expect(handler).toContain('video === findVideo()');
        expect(handler).toContain('video.isConnected !== false');
        expect(handler).toContain('video.paused');
        expect(handler).toContain('!video.seeking');
        expect(handler).toContain('video.readyState >= 3');
        expect(handler).toContain('Math.abs(current) < 1');
    });

    it('injects the shared stability window into packaged content scripts', () => {
        expect(buildSource).toContain('EPISODE_SYNC_V2_STABILITY_MS');
        expect(buildSource).toContain('episodeSyncStabilityVal');
    });
});
