import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { connectionCounts, clearRateLimitMaps } from '../server/rate-limiter.js';
import {
    enqueueQueuedEvent,
    materializeMediaIntent,
    reserveLatestMediaIntentSequence
} from '../extension/offline-media-intent.js';
import { FORCE_SYNC_TARGET_DELAY_WARNING, FORCE_SYNC_TIMEOUT } from '../shared/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(__dirname, '..', 'server', 'package.json'));
const WebSocket = require('ws');

let port, mod, clients = [];

function wsu() { return `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket&version=2.4.0&token=62170b705234c4f4807a9b22420bb93cf1a2aacfa4c5d3b47804482babb8eb50`; }
async function c() {
    const ws = new WebSocket(wsu()); clients.push(ws); ws._m = []; ws.on('message', d => ws._m.push(d.toString()));
    await new Promise((r, j) => { const t = setTimeout(() => j(Error('connect')), 5e3); ws.on('open', () => { clearTimeout(t); r(); }); });
    ws.send('40'); const s = Date.now(); while (ws._m.length < 2 && Date.now()-s < 5e3) await new Promise(r => setTimeout(r, 50));
    if (ws._m.length < 2) throw Error('handshake');
    ws._m.length = 0; return ws;
}
function s(ws, evt, d={}) { ws.send(`42${JSON.stringify([evt,d])}`); }
function a(ws) { if (ws._m.length) { const r=ws._m.shift(); return r.startsWith('42') ? JSON.parse(r.substring(2)) : r; } return new Promise((resolve, reject) => { const t=setTimeout(()=>reject(Error('timeout')),3e3); const h=(d)=>{clearTimeout(t);ws.removeListener('message',h);const r=d.toString();resolve(r.startsWith('42')?JSON.parse(r.substring(2)):r);};ws.on('message',h);}); }
async function w(ws, evt, ms=3000) { const st=Date.now(); while(Date.now()-st<ms) { for(let i=0;i<ws._m.length;i++){const r=ws._m[i];ws._m.splice(i,1);if(r.startsWith('42')){try{const[e,d]=JSON.parse(r.substring(2));if(e===evt)return d}catch{/* skip */}}} await new Promise(r=>setTimeout(r,50));} throw Error(`wait:${evt}`); }
async function j(ws, rid, pid, pw=null, clientCapabilities=undefined) {
    s(ws,'join_room',{roomId:rid,peerId:pid,password:pw,protocolVersion:'1.0.0',clientCapabilities});
    const [event, data] = await a(ws);
    assert.equal(event,'room_data');
    return data;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function close() { clients.forEach(w=>{try{w.close()}catch{/* ignore */}}); clients.length=0; }
// Test suite opens >10 connections/min — clear the IP connection counter so the
// connection rate limiter doesn't mask test failures (test-only, never at runtime).
function resetConnectionRate() { connectionCounts.clear(); clearRateLimitMaps(); }

try {
    process.env.ADMIN_METRICS_TOKEN = 'ws-integration-test-32chars-minimum!';
    mod = await import('../server/index.js');
    await mod.startServer(0,'127.0.0.1');
    port = mod.httpServer.address().port;

    // --- Pool: 2 peers in 1 room, test everything ---
    const rid = 't-'+Date.now();
    const p1 = await c(), p2 = await c();

    // Room + join
    await j(p1, rid, 'a'); await j(p2, rid, 'b'); p1._m.length = p2._m.length = 0;

    // Relay
    s(p1,'play',{currentTime:10}); await w(p2,'play');
    s(p1,'pause',{currentTime:20}); await w(p2,'pause');
    s(p1,'seek',{currentTime:30}); await w(p2,'seek');

    // Force Sync
    s(p1,'force_sync_prepare',{targetTime:0}); await w(p2,'force_sync_prepare');
    s(p1,'force_sync_ack',{}); await w(p2,'force_sync_ack');
    s(p1,'force_sync_execute',{}); await w(p2,'force_sync_execute');

    // EVENT_ACK
    s(p2,'event_ack',{targetId:'a',actionTimestamp:Date.now()}); await w(p1,'event_ack');

    // Lobby
    s(p1,'episode_lobby',{expectedTitle:'S01E01'}); await w(p2,'episode_lobby');

    // Leave
    s(p1,'leave_room',{}); const [ev,d]=await a(p2); assert.equal(ev,'peer_status');assert.equal(d.status,'left');

    close();
    resetConnectionRate();

    // --- Combined reconnect model: compacted new-client intent over legacy wire ---
    // The queue is entirely client-side. Feed its materialized PLAY/PAUSE/SEEK
    // frames through the real relay and an old-client-like receiver to prove the
    // optimization needs no new event, capability or ACK.
    const coalescedRid = 'coalesced-media-'+Date.now();
    const legacyReceiver = await c(), coalescingSender = await c();
    await j(legacyReceiver, coalescedRid, 'legacy-receiver');
    await j(coalescingSender, coalescedRid, 'coalesce-sender', null, ['chat-v1', 'media-state-v1']);
    legacyReceiver._m.length = coalescingSender._m.length = 0;

    s(legacyReceiver, 'play', { currentTime: 100, seq: 1, actionTimestamp: 1 });
    await w(coalescingSender, 'play');
    const canonicalBeforeReplay = { ...mod.rooms.get(coalescedRid).mediaState };

    let compactedQueue = enqueueQueuedEvent([], 'play', {
        currentTime: 500,
        seq: 10,
        actionTimestamp: 10
    }, { roomId: coalescedRid }).queue;
    compactedQueue = reserveLatestMediaIntentSequence(compactedQueue, coalescedRid, 11).queue;
    for (const [targetTime, seq] of [[540, 12], [600, 13]]) {
        compactedQueue = enqueueQueuedEvent(compactedQueue, 'seek', {
            currentTime: targetTime,
            targetTime,
            seq,
            actionTimestamp: seq
        }, { roomId: coalescedRid }).queue;
    }
    compactedQueue = enqueueQueuedEvent(compactedQueue, 'pause', {
        currentTime: 605,
        seq: 14,
        actionTimestamp: 14
    }, { roomId: coalescedRid }).queue;
    assert.equal(compactedQueue.length, 1, 'offline playback burst is one logical queue entry');
    const replayFrames = materializeMediaIntent(compactedQueue[0]);
    assert.deepEqual(replayFrames.map(frame => frame.event), ['seek', 'pause'],
        'compacted intent uses only the minimum existing legacy events');

    const legacyReplayPayloads = [];
    for (const frame of replayFrames) {
        s(coalescingSender, frame.event, frame.data);
        legacyReplayPayloads.push([frame.event, await w(legacyReceiver, frame.event)]);
    }
    assert.equal(legacyReplayPayloads[0][1].targetTime, 605);
    assert.equal(legacyReplayPayloads[1][1].currentTime, 605);
    for (const [event, payload] of legacyReplayPayloads) {
        assert.ok(event === 'seek' || event === 'pause');
        assert.equal(payload.mediaState, undefined);
        assert.equal(payload.revision, undefined);
    }
    const canonicalAfterReplay = mod.rooms.get(coalescedRid).mediaState;
    assert.equal(canonicalAfterReplay.revision, canonicalBeforeReplay.revision + replayFrames.length);
    assert.equal(canonicalAfterReplay.playbackState, 'paused');
    assert.equal(canonicalAfterReplay.currentTime, 605);
    assert.equal(canonicalAfterReplay.updatedBy, 'coalesce-sender');

    const coalescedLateJoiner = await c();
    const coalescedLateRoom = await j(coalescedLateJoiner, coalescedRid, 'coalesced-late');
    assert.equal(coalescedLateRoom.mediaState.revision, canonicalAfterReplay.revision);
    assert.equal(coalescedLateRoom.mediaState.playbackState, 'paused');
    assert.equal(coalescedLateRoom.mediaState.currentTime, 605);
    assert.equal(coalescedLateRoom.mediaState.updatedBy, 'coalesce-sender');
    // --- Stale peer reaper: terminal timeout + clean rejoin ---
    const staleClient = await c();
    const staleRoomId = 'stale-'+Date.now();
    await j(staleClient, staleRoomId, 'stale-peer');
    staleClient._m.length = 0;
    const staleRoom = mod.rooms.get(staleRoomId);
    staleRoom.peerData.values().next().value.lastSeen = 1;
    mod.cleanupInactiveRooms(Date.now());
    const [staleEvent, staleData] = await a(staleClient);
    assert.equal(staleEvent, 'error');
    assert.equal(staleData.code, 'peer_timed_out');
    assert.equal(staleData.message, 'Removed from room after inactivity');
    assert.equal(mod.rooms.has(staleRoomId), false, 'stale peer room is deleted');
    staleClient._m.length = 0;
    await j(staleClient, staleRoomId, 'stale-peer');
    assert.equal(mod.rooms.has(staleRoomId), true, 'stale peer can rejoin cleanly');
    close();
    resetConnectionRate();

    // --- Capabilities: ROOM_DATA advertises server features for client detection ---
    const capClient = await c();
    s(capClient, 'join_room', { roomId: 'cap-'+Date.now(), peerId: 'capp', protocolVersion: '1.0.0' });
    const [capEv, capData] = await a(capClient);
    assert.equal(capEv, 'room_data');
    assert.ok(Array.isArray(capData.capabilities) && capData.capabilities.includes('host-control'),
        'ROOM_DATA advertises the host-control capability');
    assert.ok(capData.capabilities.includes('chat'), 'ROOM_DATA advertises the chat capability');
    assert.ok(capData.capabilities.includes('chat-v1'), 'ROOM_DATA advertises the versioned chat capability');
    assert.ok(capData.capabilities.includes('media-state-v1'), 'ROOM_DATA advertises canonical media state v1');
    assert.equal(capData.mediaState, null, 'a new room starts without invented canonical media state');
    assert.equal(capData.chatHistory, undefined, 'ROOM_DATA never contains chat history');
    close();
    resetConnectionRate();

    // --- Mixed-version rollout: pre-media-state extension + current extension ---
    // Legacy intentionally omits clientCapabilities entirely and uses only the
    // pre-feature JOIN/PLAY/PAUSE/SEEK/Force Sync wire contract. The current
    // Current clients additionally advertise that they maintain canonical state
    // while solo. Recovery itself remains relay-gated and legacy clients still
    // omit clientCapabilities entirely.
    const mixedMediaRid = 'mixed-media-'+Date.now();
    const legacyMedia = await c(), currentMedia = await c();
    const legacyRoomData = await j(legacyMedia, mixedMediaRid, 'legacy-media');
    const currentRoomData = await j(currentMedia, mixedMediaRid, 'current-media', null, ['chat-v1', 'media-state-v1']);
    assert.equal(legacyRoomData.roomId, mixedMediaRid, 'legacy ROOM_DATA keeps roomId type/meaning');
    assert.ok(Array.isArray(legacyRoomData.peers), 'legacy ROOM_DATA keeps peers array');
    assert.equal(typeof legacyRoomData.controlMode, 'string', 'legacy ROOM_DATA keeps controlMode type');
    assert.ok(Array.isArray(legacyRoomData.controllers), 'legacy ROOM_DATA keeps controllers array');
    assert.equal(legacyRoomData.mediaState, null, 'new ROOM_DATA field is additive and initially null');
    assert.ok(currentRoomData.capabilities.includes('media-state-v1'), 'current client sees relay capability');
    legacyMedia._m.length = currentMedia._m.length = 0;

    const assertUnchangedMediaWire = (payload, label) => {
        for (const field of ['revision', 'mediaState', 'updatedAt', 'updatedBy']) {
            assert.equal(payload[field], undefined, `${label} does not add canonical field ${field}`);
        }
    };

    // Legacy -> current: ordinary live relay is unchanged while internal state advances.
    s(legacyMedia, 'play', { currentTime: 100, seq: 1, actionTimestamp: 1001 });
    const legacyPlayRelay = await w(currentMedia, 'play');
    assert.equal(legacyPlayRelay.currentTime, 100);
    assert.equal(legacyPlayRelay.senderId, 'legacy-media');
    assertUnchangedMediaWire(legacyPlayRelay, 'legacy PLAY relay');
    assert.deepEqual(mod.rooms.get(mixedMediaRid).mediaState, {
        revision: 1,
        playbackState: 'playing',
        currentTime: 100,
        updatedAt: mod.rooms.get(mixedMediaRid).mediaState.updatedAt,
        updatedBy: 'legacy-media'
    }, 'legacy PLAY canonicalizes without a media-state client capability');

    s(legacyMedia, 'seek', { currentTime: 1200, targetTime: 1200, seq: 2, actionTimestamp: 1002 });
    const legacySeekRelay = await w(currentMedia, 'seek');
    assert.equal(legacySeekRelay.currentTime, 1200);
    assert.equal(legacySeekRelay.targetTime, 1200);
    assertUnchangedMediaWire(legacySeekRelay, 'legacy SEEK relay');
    assert.deepEqual(mod.rooms.get(mixedMediaRid).mediaState, {
        revision: 2,
        playbackState: 'playing',
        currentTime: 1200,
        updatedAt: mod.rooms.get(mixedMediaRid).mediaState.updatedAt,
        updatedBy: 'legacy-media'
    });

    s(legacyMedia, 'pause', { currentTime: 1200, seq: 3, actionTimestamp: 1003 });
    const legacyPauseRelay = await w(currentMedia, 'pause');
    assert.equal(legacyPauseRelay.currentTime, 1200);
    assertUnchangedMediaWire(legacyPauseRelay, 'legacy PAUSE relay');
    assert.deepEqual(mod.rooms.get(mixedMediaRid).mediaState, {
        revision: 3,
        playbackState: 'paused',
        currentTime: 1200,
        updatedAt: mod.rooms.get(mixedMediaRid).mediaState.updatedAt,
        updatedBy: 'legacy-media'
    });

    // Current -> legacy: old receive path sees the same ordinary events and fields.
    s(currentMedia, 'play', { currentTime: 1300, seq: 1, actionTimestamp: 2001 });
    const currentPlayRelay = await w(legacyMedia, 'play');
    assert.equal(currentPlayRelay.currentTime, 1300);
    assertUnchangedMediaWire(currentPlayRelay, 'current PLAY relay to legacy client');
    s(currentMedia, 'seek', { currentTime: 1400, targetTime: 1400, seq: 2, actionTimestamp: 2002 });
    const currentSeekRelay = await w(legacyMedia, 'seek');
    assert.equal(currentSeekRelay.targetTime, 1400);
    assertUnchangedMediaWire(currentSeekRelay, 'current SEEK relay to legacy client');

    // Legacy Force Sync needs no new target on EXECUTE, event or ACK. Canonical
    // bookkeeping remains internal and commits only after the existing execute.
    const beforeLegacyPrepare = { ...mod.rooms.get(mixedMediaRid).mediaState };
    s(legacyMedia, 'force_sync_prepare', { targetTime: 1600, seq: 4, actionTimestamp: 1004 });
    const legacyPrepareRelay = await w(currentMedia, 'force_sync_prepare');
    assert.equal(legacyPrepareRelay.targetTime, 1600);
    assertUnchangedMediaWire(legacyPrepareRelay, 'legacy Force Sync PREPARE relay');
    assert.deepEqual(mod.rooms.get(mixedMediaRid).mediaState, beforeLegacyPrepare,
        'legacy PREPARE remains choreography and does not commit canonical state');
    s(currentMedia, 'force_sync_ack', { seq: 3 });
    const currentAckRelay = await w(legacyMedia, 'force_sync_ack');
    assert.equal(currentAckRelay.senderId, 'current-media');
    assertUnchangedMediaWire(currentAckRelay, 'existing Force Sync ACK relay');
    s(legacyMedia, 'force_sync_execute', { seq: 5, actionTimestamp: 1005 });
    const legacyExecuteRelay = await w(currentMedia, 'force_sync_execute');
    assert.equal(legacyExecuteRelay.targetTime, undefined, 'legacy EXECUTE still requires no target field');
    assertUnchangedMediaWire(legacyExecuteRelay, 'legacy Force Sync EXECUTE relay');
    assert.deepEqual(mod.rooms.get(mixedMediaRid).mediaState, {
        revision: beforeLegacyPrepare.revision + 1,
        playbackState: 'playing',
        currentTime: 1600,
        updatedAt: mod.rooms.get(mixedMediaRid).mediaState.updatedAt,
        updatedBy: 'legacy-media'
    }, 'legacy Force Sync EXECUTE commits only internal canonical state');

    // Host Control remains the sole authorization chokepoint, independent of
    // media-state client knowledge.
    s(legacyMedia, 'set_control_mode', { controlMode: 'host-only' });
    await w(legacyMedia, 'control_mode');
    await w(currentMedia, 'control_mode');
    legacyMedia._m.length = currentMedia._m.length = 0;
    const mixedHostBaseline = { ...mod.rooms.get(mixedMediaRid).mediaState };
    s(currentMedia, 'seek', { currentTime: 1650, targetTime: 1650, seq: 4, actionTimestamp: 2004 });
    let mixedGuestRejected = false;
    try { await w(legacyMedia, 'seek', 600); } catch { mixedGuestRejected = true; }
    assert.ok(mixedGuestRejected, 'current guest command remains rejected in mixed host-only room');
    assert.deepEqual(mod.rooms.get(mixedMediaRid).mediaState, mixedHostBaseline,
        'rejected mixed-version guest command does not mutate or revise canonical state');

    s(legacyMedia, 'seek', { currentTime: 1700, targetTime: 1700, seq: 6, actionTimestamp: 1006 });
    const legacyHostSeek = await w(currentMedia, 'seek');
    assert.equal(legacyHostSeek.targetTime, 1700, 'allowed legacy controller command relays normally');
    assert.equal(mod.rooms.get(mixedMediaRid).mediaState.updatedBy, 'legacy-media');
    assert.equal(mod.rooms.get(mixedMediaRid).mediaState.currentTime, 1700);

    // Make the final stable intent legacy-owned, then reconnect only the current client.
    s(legacyMedia, 'pause', { currentTime: 1700, seq: 7, actionTimestamp: 1007 });
    await w(currentMedia, 'pause');
    const legacyFinalRevision = mod.rooms.get(mixedMediaRid).mediaState.revision;
    const currentMediaRejoin = await c();
    const mixedRejoinData = await j(currentMediaRejoin, mixedMediaRid, 'current-media', null, ['chat-v1', 'media-state-v1']);
    assert.equal(mixedRejoinData.mediaState.revision, legacyFinalRevision);
    assert.equal(mixedRejoinData.mediaState.playbackState, 'paused');
    assert.equal(mixedRejoinData.mediaState.currentTime, 1700);
    assert.equal(mixedRejoinData.mediaState.updatedBy, 'legacy-media',
        'current reconnect snapshot reflects the legacy client latest accepted intent');
    assert.equal(legacyMedia._m.some(raw => raw.includes('media_state')), false,
        'legacy client receives no new canonical event or ACK requirement');
    currentMediaRejoin.close();
    await delay(100);
    assert.equal(mod.rooms.get(mixedMediaRid).mediaState, null,
        'canonical state is cleared when only a legacy solo-suppressing client remains');
    close();
    resetConnectionRate();

    // The inverse must remain true: a capable solo client keeps publishing
    // PLAY/PAUSE/SEEK, so removing a legacy peer must not discard valid state.
    const capableSoloRid = 'capable-solo-'+Date.now();
    const capableSolo = await c(), transientLegacy = await c();
    await j(capableSolo, capableSoloRid, 'capable-solo', null, ['chat-v1', 'media-state-v1']);
    await j(transientLegacy, capableSoloRid, 'transient-legacy');
    capableSolo._m.length = transientLegacy._m.length = 0;
    s(capableSolo, 'play', { currentTime: 42, mediaTitle: 'Series S03E04' });
    await w(transientLegacy, 'play');
    const capableSoloState = { ...mod.rooms.get(capableSoloRid).mediaState };
    transientLegacy.close();
    await delay(100);
    assert.deepEqual(mod.rooms.get(capableSoloRid).mediaState, capableSoloState,
        'canonical state remains valid when the sole remaining client advertises media-state-v1');
    close();
    resetConnectionRate();

    // --- Canonical Media State v1: late join, pause, seek and reconnect ---
    const msrid = 'media-state-'+Date.now();
    const msa = await c();
    const initialMediaRoom = await j(msa, msrid, 'msa');
    assert.equal(initialMediaRoom.mediaState, null, 'media state is initially null');

    s(msa, 'play', {
        currentTime: 100,
        mediaTitle: 'Series S01E02',
        revision: 999,
        updatedBy: 'spoofed'
    });
    await delay(120);
    const msb = await c();
    const playingJoin = await j(msb, msrid, 'msb');
    assert.equal(playingJoin.mediaState.revision, 1, 'first accepted PLAY creates revision 1');
    assert.equal(playingJoin.mediaState.playbackState, 'playing');
    assert.equal(playingJoin.mediaState.mediaTitle, 'Series S01E02');
    assert.ok(playingJoin.mediaState.currentTime >= 100.08 && playingJoin.mediaState.currentTime < 101,
        `playing late join receives projected position (${playingJoin.mediaState.currentTime})`);
    assert.equal(playingJoin.mediaState.updatedBy, 'msa', 'updatedBy is server-tracked identity');

    s(msa, 'pause', { currentTime: 150 });
    await delay(40);
    const pausedRevision = mod.rooms.get(msrid).mediaState.revision;
    await delay(100);
    const msc = await c();
    const pausedJoin = await j(msc, msrid, 'msc');
    assert.equal(pausedJoin.mediaState.revision, pausedRevision);
    assert.equal(pausedJoin.mediaState.playbackState, 'paused');
    assert.equal(pausedJoin.mediaState.currentTime, 150, 'paused late join position does not advance');

    s(msa, 'seek', { currentTime: 500, targetTime: 600 });
    await delay(40);
    const seekState = mod.rooms.get(msrid).mediaState;
    assert.equal(seekState.currentTime, 600, 'SEEK uses targetTime rather than currentTime');
    assert.equal(seekState.playbackState, 'paused', 'SEEK preserves canonical playback state');

    s(msa, 'play', { currentTime: 1800 });
    await delay(60);
    const reconnect1 = await c();
    const reconnectFirst = await j(reconnect1, msrid, 'reconnect');
    reconnect1.close();
    await delay(120);
    const beforePeerDedupe = { ...mod.rooms.get(msrid).mediaState };
    const reconnect2 = await c();
    const reconnectSecond = await j(reconnect2, msrid, 'reconnect');
    assert.equal(reconnectSecond.mediaState.revision, reconnectFirst.mediaState.revision,
        'lazy clock projection does not increment revision');
    assert.ok(reconnectSecond.mediaState.currentTime > reconnectFirst.mediaState.currentTime,
        'reconnect receives a newly projected playing position');
    assert.deepEqual(mod.rooms.get(msrid).mediaState, beforePeerDedupe,
        'peer dedupe/reconnect does not reset or revise canonical state');

    const beforeOrderingRevision = mod.rooms.get(msrid).mediaState.revision;
    s(msa, 'seek', { targetTime: 100 });
    await delay(30);
    s(msb, 'seek', { targetTime: 200 });
    await delay(40);
    const orderedState = mod.rooms.get(msrid).mediaState;
    assert.equal(orderedState.revision, beforeOrderingRevision + 2, 'accepted controllers increment revision in server order');
    assert.equal(orderedState.currentTime, 200, 'last accepted controller wins');
    assert.equal(orderedState.updatedBy, 'msb');
    s(msb, 'seek', { targetTime: 300 });
    await delay(30);
    s(msa, 'seek', { targetTime: 400 });
    await delay(40);
    const reverseOrderedState = mod.rooms.get(msrid).mediaState;
    assert.equal(reverseOrderedState.revision, orderedState.revision + 2);
    assert.equal(reverseOrderedState.currentTime, 400, 'reversing server order reverses the winning controller');
    assert.equal(reverseOrderedState.updatedBy, 'msa');

    // Heartbeats remain observations and cannot rewrite canonical intent.
    const beforeHeartbeat = { ...reverseOrderedState };
    s(msa, 'peer_status', { playbackState: 'paused', currentTime: 999 });
    await delay(40);
    assert.deepEqual(mod.rooms.get(msrid).mediaState, beforeHeartbeat, 'PEER_STATUS does not mutate canonical state');

    // Force Sync PREPARE is choreography; matching EXECUTE commits its final target.
    s(msa, 'force_sync_prepare', { targetTime: 700 });
    await delay(40);
    assert.deepEqual(mod.rooms.get(msrid).mediaState, beforeHeartbeat, 'Force Sync PREPARE does not mutate canonical state');
    s(msa, 'force_sync_execute', {});
    await delay(40);
    const forceSyncState = mod.rooms.get(msrid).mediaState;
    assert.equal(forceSyncState.revision, beforeHeartbeat.revision + 1);
    assert.equal(forceSyncState.playbackState, 'playing');
    assert.equal(forceSyncState.currentTime, 700);

    // The legacy wire exposes one room-wide prepared target. A later PREPARE
    // replaces what every peer has just sought to; any currently authorized
    // EXECUTE must commit that visible target instead of clearing it unmatched.
    s(msa, 'force_sync_prepare', { targetTime: 800 });
    await w(msb, 'force_sync_prepare');
    s(msb, 'force_sync_prepare', { targetTime: 900 });
    await w(msa, 'force_sync_prepare');
    const beforeCompetingExecute = { ...mod.rooms.get(msrid).mediaState };
    s(msa, 'force_sync_execute', {});
    await w(msb, 'force_sync_execute');
    const competingForceState = mod.rooms.get(msrid).mediaState;
    assert.equal(competingForceState.revision, beforeCompetingExecute.revision + 1);
    assert.equal(competingForceState.currentTime, 900,
        'authorized EXECUTE commits the latest target visible to legacy peers');
    assert.equal(competingForceState.updatedBy, 'msa');

    // The initiator's normal ACK timeout stays below the relay's delayed-target
    // warning boundary and commits normally.
    s(msa, 'force_sync_prepare', { targetTime: 925 });
    await w(msb, 'force_sync_prepare');
    mod.rooms.get(msrid).forceSyncTarget.preparedAt = Date.now() - FORCE_SYNC_TIMEOUT;
    s(msa, 'force_sync_execute', {});
    await w(msb, 'force_sync_execute');
    assert.equal(mod.rooms.get(msrid).mediaState.currentTime, 925,
        'relay grace accepts EXECUTE at the client ACK-timeout boundary');

    // Even beyond the warning boundary, a target that no newer room action
    // superseded remains the only safe way to release already-paused peers.
    s(msa, 'force_sync_prepare', { targetTime: 950 });
    await w(msb, 'force_sync_prepare');
    const beforeExpiredExecute = { ...mod.rooms.get(msrid).mediaState };
    mod.rooms.get(msrid).forceSyncTarget.preparedAt = Date.now() - FORCE_SYNC_TARGET_DELAY_WARNING - 1;
    msa._m.length = msb._m.length = 0;
    s(msa, 'force_sync_execute', {});
    await w(msb, 'force_sync_execute');
    assert.equal(mod.rooms.get(msrid).mediaState.revision, beforeExpiredExecute.revision + 1);
    assert.equal(mod.rooms.get(msrid).mediaState.currentTime, 950,
        'a delayed EXECUTE still releases peers and commits its unsuperseded prepared target');
    assert.equal(mod.rooms.get(msrid).forceSyncTarget, null);

    // A relay restart cannot recover transient PREPARE state. Preserve the old
    // wire liveness fallback without inventing a canonical target.
    const beforeUntrackedExecute = { ...mod.rooms.get(msrid).mediaState };
    msa._m.length = msb._m.length = 0;
    s(msa, 'force_sync_execute', {});
    await w(msb, 'force_sync_execute');
    assert.deepEqual(mod.rooms.get(msrid).mediaState, beforeUntrackedExecute,
        'an untracked compatibility EXECUTE relays without canonical mutation');

    s(msa, 'force_sync_prepare', { targetTime: 975 });
    await w(msb, 'force_sync_prepare');
    s(msb, 'seek', { targetTime: 'invalid' });
    await w(msa, 'seek');
    assert.equal(mod.rooms.get(msrid).forceSyncTarget.targetTime, 975,
        'a sanitized no-op SEEK does not supersede an in-flight prepared target');
    s(msa, 'force_sync_execute', {});
    await w(msb, 'force_sync_execute');
    assert.equal(mod.rooms.get(msrid).mediaState.currentTime, 975);

    msa._m.length = msb._m.length = 0;
    s(msa, 'force_sync_prepare', { targetTime: 1_000 });
    await w(msb, 'force_sync_prepare');
    s(msb, 'pause', { currentTime: 1_100 });
    await w(msa, 'pause');
    const supersedingMediaState = { ...mod.rooms.get(msrid).mediaState };
    msa._m.length = msb._m.length = 0;
    s(msa, 'force_sync_execute', {});
    let orphanExecuteDropped = false;
    try { await w(msb, 'force_sync_execute', 500); } catch { orphanExecuteDropped = true; }
    assert.ok(orphanExecuteDropped, 'an action that supersedes PREPARE makes delayed EXECUTE invalid');
    assert.deepEqual(mod.rooms.get(msrid).mediaState, supersedingMediaState);

    // Active Episode Lobby is additive ROOM_DATA state and does not rewrite mediaState.
    s(msa, 'episode_lobby', { expectedTitle: 'S02E03' });
    await delay(40);
    const beforeLobbyJoin = { ...mod.rooms.get(msrid).mediaState };
    const msLobbyJoiner = await c();
    const lobbyRoomData = await j(msLobbyJoiner, msrid, 'ms-lobby');
    assert.equal(lobbyRoomData.activeLobby.expectedTitle, 'S02E03');
    assert.equal(lobbyRoomData.mediaState.revision, beforeLobbyJoin.revision);
    assert.deepEqual(mod.rooms.get(msrid).mediaState, beforeLobbyJoin, 'Episode Lobby does not mutate canonical state');
    s(msa, 'leave_room', {});
    await delay(50);
    assert.deepEqual(mod.rooms.get(msrid).mediaState, beforeLobbyJoin,
        'host disconnect/reassignment preserves canonical state and revision');
    close();
    resetConnectionRate();

    // --- Canonical Media State v1: Host Control and validation chokepoints ---
    const msgateRid = 'media-gate-'+Date.now();
    const msgHost = await c(), msgGuest = await c(), msgUnjoined = await c();
    await j(msgHost, msgateRid, 'msg-host');
    await j(msgGuest, msgateRid, 'msg-guest');
    s(msgHost, 'play', { currentTime: 10 });
    await delay(40);
    s(msgHost, 'set_control_mode', { controlMode: 'host-only' });
    await w(msgGuest, 'control_mode');
    msgHost._m.length = msgGuest._m.length = 0;
    const gatedBaseline = { ...mod.rooms.get(msgateRid).mediaState };

    s(msgGuest, 'seek', { targetTime: 900 });
    await delay(80);
    assert.deepEqual(mod.rooms.get(msgateRid).mediaState, gatedBaseline,
        'host-only rejected guest cannot mutate canonical state or revision');

    s(msgHost, 'seek', { targetTime: 800 });
    await delay(40);
    assert.equal(mod.rooms.get(msgateRid).mediaState.revision, gatedBaseline.revision + 1);
    assert.equal(mod.rooms.get(msgateRid).mediaState.currentTime, 800);

    // Current receivers ignore duplicate/regressing seq. The relay must make the
    // same decision before canonical mutation so late joiners see the same truth.
    msgHost._m.length = msgGuest._m.length = 0;
    s(msgHost, 'play', { currentTime: 820, seq: 10 });
    await w(msgGuest, 'play');
    const sequencedBaseline = { ...mod.rooms.get(msgateRid).mediaState };
    const sequencedPeerBaseline = {
        ...Array.from(mod.rooms.get(msgateRid).peerData.values())
            .find(peer => peer.peerId === 'msg-host')
    };
    s(msgHost, 'pause', { currentTime: 1, playbackState: 'paused', seq: 10 });
    let duplicateSequenceDropped = false;
    try { await w(msgGuest, 'pause', 500); } catch { duplicateSequenceDropped = true; }
    assert.ok(duplicateSequenceDropped, 'duplicate media seq is not relayed');
    s(msgHost, 'seek', { targetTime: 5, seq: 9 });
    let staleSequenceDropped = false;
    try { await w(msgGuest, 'seek', 500); } catch { staleSequenceDropped = true; }
    assert.ok(staleSequenceDropped, 'regressing media seq is not relayed');
    assert.deepEqual(mod.rooms.get(msgateRid).mediaState, sequencedBaseline,
        'regressing media seq cannot revise canonical state');
    assert.deepEqual(
        Array.from(mod.rooms.get(msgateRid).peerData.values())
            .find(peer => peer.peerId === 'msg-host'),
        sequencedPeerBaseline,
        'duplicate/regressing media seq cannot alter peer state used by later canonical updates');
    const msgLateJoiner = await c();
    const msgLateRoom = await j(msgLateJoiner, msgateRid, 'msg-late');
    assert.equal(msgLateRoom.mediaState.revision, sequencedBaseline.revision);
    assert.equal(msgLateRoom.mediaState.playbackState, sequencedBaseline.playbackState);
    assert.ok(msgLateRoom.mediaState.currentTime >= sequencedBaseline.currentTime
        && msgLateRoom.mediaState.currentTime < sequencedBaseline.currentTime + 5,
        'late joiner receives the accepted playing state with normal snapshot projection');

    const validationBaseline = { ...mod.rooms.get(msgateRid).mediaState };
    for (const invalidPayload of [{ targetTime: null }, { targetTime: '50' }, { targetTime: {} }, {}]) {
        s(msgHost, 'seek', invalidPayload);
    }
    s(msgUnjoined, 'seek', { roomId: msgateRid, targetTime: 999, updatedBy: 'msg-host', revision: 999999 });
    await delay(80);
    assert.deepEqual(mod.rooms.get(msgateRid).mediaState, validationBaseline,
        'invalid and unjoined/cross-room payloads cannot corrupt canonical state');

    s(msgHost, 'leave_room', {});
    s(msgGuest, 'leave_room', {});
    s(msgLateJoiner, 'leave_room', {});
    await delay(80);
    assert.equal(mod.rooms.has(msgateRid), false, 'empty-room cleanup removes canonical state with the room');
    // --- Terminal room timeout: coded error + complete membership cleanup ---
    const timeoutClient = await c();
    const timeoutRoomId = 'timeout-'+Date.now();
    await j(timeoutClient, timeoutRoomId, 'timeout-peer');
    timeoutClient._m.length = 0;
    mod.rooms.get(timeoutRoomId).lastActivity = 0;
    mod.cleanupInactiveRooms(Date.now());
    const [timeoutEvent, timeoutData] = await a(timeoutClient);
    assert.equal(timeoutEvent, 'error');
    assert.equal(timeoutData.code, 'room_closed');
    assert.equal(timeoutData.message, 'Room closed');
    assert.equal(mod.rooms.has(timeoutRoomId), false, 'inactive room is deleted');
    timeoutClient._m.length = 0;

    // The same connected socket must be able to join that room again. This
    // proves timeout cleanup removed its stale socketToRoom membership.
    await j(timeoutClient, timeoutRoomId, 'timeout-peer');
    assert.equal(mod.rooms.has(timeoutRoomId), true, 'timed-out peer can rejoin cleanly');
    close();
    resetConnectionRate();

    // --- Encrypted chat is a live-only canonical relay ---
    const chatRoom = 'chat-'+Date.now();
    const chat1 = await c(), chat2 = await c();
    await j(chat1, chatRoom, 'alice', null, ['chat-v1']);
    await j(chat2, chatRoom, 'bob', null, ['chat-v1']);
    chat1._m.length = chat2._m.length = 0;
    const ciphertext = Buffer.alloc(64, 7).toString('base64url');
    s(chat1, 'chat_message', {
        ciphertext,
        id: 'spoofed-id', senderId: 'mallory', timestamp: 1, text: 'plaintext'
    });
    const [chat1Event, chat1Data] = await a(chat1);
    const [chat2Event, chat2Data] = await a(chat2);
    assert.equal(chat1Event, 'chat_message', 'sender receives canonical chat envelope');
    assert.equal(chat2Event, 'chat_message', 'peer receives canonical chat envelope');
    assert.deepEqual(chat2Data, chat1Data, 'all peers receive the same canonical envelope');
    assert.equal(chat1Data.senderId, 'alice', 'relay stamps senderId');
    assert.equal(chat1Data.ciphertext, ciphertext, 'relay preserves ciphertext');
    assert.equal(chat1Data.text, undefined, 'relay drops plaintext fields');
    assert.notEqual(chat1Data.id, 'spoofed-id', 'relay replaces client IDs');
    assert.ok(Number.isFinite(chat1Data.timestamp) && chat1Data.timestamp > 1, 'relay stamps timestamp');

    const late = await c();
    s(late, 'join_room', { roomId: chatRoom, peerId: 'late', protocolVersion: '1.0.0' });
    const [lateEvent, lateRoomData] = await a(late);
    assert.equal(lateEvent, 'room_data');
    assert.equal(lateRoomData.chatHistory, undefined, 'late joiner gets no chat backlog');
    assert.equal(late._m.some(raw => raw.includes('chat_message')), false, 'late joiner receives no old message');
    close();
    resetConnectionRate();

    // --- Mixed rollout: old non-chat clients never receive unknown chat events ---
    const mixedChatRoom = 'chat-mixed-'+Date.now();
    const newChat = await c(), oldNoChat = await c();
    await j(newChat, mixedChatRoom, 'new-chat', null, ['chat-v1', 'chat-v1', 'future-chat', 42]);
    await j(oldNoChat, mixedChatRoom, 'old-no-chat', null, ['chat-v2']);
    newChat._m.length = oldNoChat._m.length = 0;
    s(newChat, 'chat_message', { ciphertext });
    await w(newChat, 'chat_message');
    let oldReceivedChat = false;
    try { await w(oldNoChat, 'chat_message', 500); oldReceivedChat = true; } catch { /* expected */ }
    assert.equal(oldReceivedChat, false, 'old client receives no unknown chat event');

    // The same old client remains fully usable for the pre-chat protocol.
    newChat._m.length = oldNoChat._m.length = 0;
    s(oldNoChat, 'play', { currentTime: 12 });
    await w(newChat, 'play');
    s(newChat, 'pause', { currentTime: 13 });
    await w(oldNoChat, 'pause');

    // First chat beta compatibility: sending a valid chat frame dynamically
    // proves receive support even when that beta omitted clientCapabilities.
    const firstBeta = await c();
    await j(firstBeta, mixedChatRoom, 'first-beta');
    firstBeta._m.length = newChat._m.length = 0;
    s(firstBeta, 'chat_message', { ciphertext });
    await w(firstBeta, 'chat_message');
    await w(newChat, 'chat_message');
    close();
    resetConnectionRate();

    // --- Default 'everyone' mode does NOT gate anyone (host-control OFF = unchanged) ---
    // Confirms that with host-only off, a non-host guest can still drive every
    // room-moving event exactly like before the feature existed.
    const erid = 'every-'+Date.now();
    const e1 = await c(), e2 = await c();        // e1 = creator/host, e2 = guest
    await j(e1, erid, 'ehost'); await j(e2, erid, 'eguest'); e1._m.length = e2._m.length = 0;
    s(e2,'play',{currentTime:1});                 await w(e1,'play');
    s(e2,'pause',{currentTime:2});                await w(e1,'pause');
    s(e2,'seek',{currentTime:3});                 await w(e1,'seek');
    s(e2,'force_sync_prepare',{targetTime:0});    await w(e1,'force_sync_prepare');
    s(e2,'episode_lobby',{expectedTitle:'S1E1'}); await w(e1,'episode_lobby');
    // (reaching here without a wait timeout == nothing was gated)
    close();
    resetConnectionRate();

    // --- Host Control Mode ---
    const hrid = 'host-'+Date.now();
    const h1 = await c(), h2 = await c();          // h1 = host (first joiner), h2 = guest
    await j(h1, hrid, 'host1'); await j(h2, hrid, 'guest1'); h1._m.length = h2._m.length = 0;

    // Host enables host-only -> both peers get the control_mode broadcast
    s(h1,'set_control_mode',{controlMode:'host-only'});
    await w(h1,'control_mode'); await w(h2,'control_mode');
    h1._m.length = h2._m.length = 0;

    // Guest's room-moving event (pause) is dropped -> host must NOT receive it
    s(h2,'pause',{currentTime:5});
    let guestPauseDropped = false; try { await w(h1,'pause',600); } catch { guestPauseDropped = true; }
    assert.ok(guestPauseDropped, 'guest pause dropped in host-only');

    // Host's own pause still relays to the guest
    s(h1,'pause',{currentTime:7}); await w(h2,'pause');
    h1._m.length = h2._m.length = 0;

    // desynced flag is relayed through PEER_STATUS heartbeats so the host's UI
    // can show "Solo" for guests watching on their own.
    s(h2,'peer_status',{status:'heartbeat',desynced:true,currentTime:42,playbackState:'playing'});
    let hbData = null; const hbStart = Date.now();
    while (Date.now()-hbStart < 600 && !hbData) {
        for (let i=0;i<h1._m.length;i++){ const r=h1._m[i]; if(r.startsWith('42')){ const [e,dd]=JSON.parse(r.substring(2)); if(e==='peer_status'){ h1._m.splice(i,1); hbData=dd; break; } } }
        await new Promise(r=>setTimeout(r,30));
    }
    assert.ok(hbData && hbData.desynced === true, 'desynced=true relayed in heartbeat');
    h1._m.length = h2._m.length = 0;

    // Guest cannot change the control mode -> host must NOT receive a broadcast.
    // The rejected sender gets a unicast of the *actual* state so any optimistic
    // UI reverts (H-5); assert both halves.
    s(h2,'set_control_mode',{controlMode:'everyone'});
    let guestSetBlocked = false; try { await w(h1,'control_mode',600); } catch { guestSetBlocked = true; }
    assert.ok(guestSetBlocked, 'non-host cannot set control mode');
    let rejectSync = null; const rsStart = Date.now();
    while (Date.now()-rsStart < 600 && !rejectSync) {
        for (let i=0;i<h2._m.length;i++){ const r=h2._m[i]; if(r.startsWith('42')){ const [e,dd]=JSON.parse(r.substring(2)); if(e==='control_mode'){ h2._m.splice(i,1); rejectSync=dd; break; } } }
        await new Promise(r=>setTimeout(r,30));
    }
    assert.ok(rejectSync && rejectSync.controlMode==='host-only' && rejectSync.hostPeerId==='host1',
        'rejected sender is re-synced to actual state');
    h1._m.length = h2._m.length = 0;

    // Host leaves -> room falls back to 'everyone' and reassigns host to the guest
    s(h1,'leave_room',{});
    let fb = null; const fbStart = Date.now();
    while (Date.now()-fbStart < 2000 && !fb) {
        for (let i=0;i<h2._m.length;i++){ const r=h2._m[i]; if(r.startsWith('42')){ const [e,dd]=JSON.parse(r.substring(2)); if(e==='control_mode'){ h2._m.splice(i,1); fb=dd; break; } } }
        await new Promise(r=>setTimeout(r,50));
    }
    assert.ok(fb && fb.controlMode==='everyone' && fb.hostPeerId==='guest1', 'host leave -> fallback everyone + new host');
    close();

    // --- M-4: rapid control-mode toggles are debounced per-room ---
    const drid = 'debounce-'+Date.now();
    const db1 = await c(), db2 = await c();
    await j(db1, drid, 'dhost'); await j(db2, drid, 'dguest'); db1._m.length = db2._m.length = 0;

    // First toggle (everyone → host-only) goes through.
    s(db1,'set_control_mode',{controlMode:'host-only'});
    await w(db1,'control_mode'); await w(db2,'control_mode');
    db1._m.length = db2._m.length = 0;

    // Immediate second toggle (host-only → everyone) should be debounced:
    // broadcast goes to neither peer, but sender gets a re-sync unicast.
    s(db1,'set_control_mode',{controlMode:'everyone'});
    let dGuestGotIt = false; try { await w(db2,'control_mode',600); } catch { dGuestGotIt = true; }
    assert.ok(dGuestGotIt, 'rapid control-mode toggle is debounced (no broadcast)');
    let dSenderResync = null; const dsStart = Date.now();
    while (Date.now()-dsStart < 600 && !dSenderResync) {
        for (let i=0;i<db1._m.length;i++){ const r=db1._m[i]; if(r.startsWith('42')){ const [e,dd]=JSON.parse(r.substring(2)); if(e==='control_mode'){ db1._m.splice(i,1); dSenderResync=dd; break; } } }
        await new Promise(r=>setTimeout(r,30));
    }
    assert.ok(dSenderResync && dSenderResync.controlMode==='host-only',
        'debounced toggle re-syncs sender to actual state');
    close();
    resetConnectionRate();

    // --- Host role survives peerId dedup (reconnect / second tab) ---
    const hdrid = 'dedup-host-'+Date.now();
    const hd1 = await c(), hd2 = await c();
    await j(hd1, hdrid, 'dhost'); await j(hd2, hdrid, 'dguest'); hd1._m.length = hd2._m.length = 0;
    s(hd1,'set_control_mode',{controlMode:'host-only'});
    await w(hd1,'control_mode'); await w(hd2,'control_mode');
    hd1._m.length = hd2._m.length = 0;
    // The host's peerId re-joins on a fresh socket → server dedupes the old socket.
    // This must NOT demote the host or reset the mode (a network blip / second tab).
    const hd3 = await c();
    s(hd3,'join_room',{roomId:hdrid,peerId:'dhost',protocolVersion:'1.0.0'});
    const hdrd = await a(hd3);
    assert.equal(hdrd[0],'room_data');
    assert.ok(hdrd[1].controlMode === 'host-only' && hdrd[1].hostPeerId === 'dhost',
        'host role + host-only mode survive peerId dedup (reconnect/second tab)');
    close();
    resetConnectionRate();

    // --- Co-Host: owner promotes a guest to controller (can drive); demote re-gates ---
    const crid = 'cohost-'+Date.now();
    const co1 = await c(), co2 = await c(), co3 = await c(); // owner / to-promote / stays guest
    await j(co1, crid, 'owner'); await j(co2, crid, 'cohost'); await j(co3, crid, 'guestx');
    co1._m.length = co2._m.length = co3._m.length = 0;
    s(co1,'set_control_mode',{controlMode:'host-only'});
    await w(co1,'control_mode'); await w(co2,'control_mode'); await w(co3,'control_mode');
    co1._m.length = co2._m.length = co3._m.length = 0;
    // before promotion the co-host is gated
    s(co2,'pause',{currentTime:1});
    let coGatedBefore=false; try { await w(co1,'pause',500); } catch { coGatedBefore=true; }
    assert.ok(coGatedBefore, 'co-host gated before promotion');
    // owner promotes co-host → controllers broadcast includes owner + cohost
    s(co1,'set_peer_role',{peerId:'cohost',controller:true});
    let promo=null; const pps=Date.now();
    while(Date.now()-pps<800 && !promo){ for(let i=0;i<co2._m.length;i++){const r=co2._m[i];if(r.startsWith('42')){const[e,dd]=JSON.parse(r.substring(2));if(e==='control_mode'){co2._m.splice(i,1);promo=dd;break;}}} await new Promise(r=>setTimeout(r,30)); }
    assert.ok(promo && Array.isArray(promo.controllers) && promo.controllers.includes('cohost') && promo.controllers.includes('owner'),
        'promotion broadcasts controllers (owner + cohost)');
    co1._m.length = co2._m.length = co3._m.length = 0;
    // promoted co-host can now drive; a plain guest still cannot
    s(co2,'pause',{currentTime:2}); await w(co1,'pause');
    s(co3,'play',{currentTime:3});
    let plainGuestGated=false; try { await w(co1,'play',500); } catch { plainGuestGated=true; }
    assert.ok(plainGuestGated, 'plain guest still gated after a co-host is promoted');
    co1._m.length = co2._m.length = co3._m.length = 0;
    // a non-owner (the co-host) cannot promote anyone
    s(co2,'set_peer_role',{peerId:'guestx',controller:true});
    let nonOwnerBlocked=false; try { await w(co3,'control_mode',500); } catch { nonOwnerBlocked=true; }
    assert.ok(nonOwnerBlocked, 'non-owner cannot promote (no room broadcast)');
    co1._m.length = co2._m.length = co3._m.length = 0;
    // owner demotes the co-host → gated again
    s(co1,'set_peer_role',{peerId:'cohost',controller:false});
    await w(co2,'control_mode');
    co1._m.length = co2._m.length = co3._m.length = 0;
    s(co2,'seek',{currentTime:4});
    let coGatedAfter=false; try { await w(co1,'seek',500); } catch { coGatedAfter=true; }
    assert.ok(coGatedAfter, 'demoted co-host is gated again');
    close();
    resetConnectionRate();

    // --- H-1: a demoted co-host's FORCE_SYNC_EXECUTE still relays when they
    //     initiated the in-flight PREPARE. Without the initiator exemption, the
    //     EXECUTE would be dropped by the host-only gate and every peer would be
    //     left stuck paused. ---
    const h1rid = 'h1-'+Date.now();
    const ho = await c(), hc = await c(), hg = await c();   // owner / co-host / guest
    await j(ho, h1rid, 'owner'); await j(hc, h1rid, 'cohost'); await j(hg, h1rid, 'guest');
    ho._m.length = hc._m.length = hg._m.length = 0;
    s(ho,'set_control_mode',{controlMode:'host-only'});
    await w(ho,'control_mode'); await w(hc,'control_mode'); await w(hg,'control_mode');
    ho._m.length = hc._m.length = hg._m.length = 0;
    // owner promotes co-host; co-host initiates force sync
    s(ho,'set_peer_role',{peerId:'cohost',controller:true});
    await w(hc,'control_mode');
    ho._m.length = hc._m.length = hg._m.length = 0;
    s(hc,'force_sync_prepare',{targetTime:0});
    await w(ho,'force_sync_prepare'); await w(hg,'force_sync_prepare');
    ho._m.length = hc._m.length = hg._m.length = 0;
    // owner demotes the co-host mid-flight — the EXECUTE must still go through.
    // Wait out the per-room role-change debounce (M-4) so this demote broadcasts:
    // in real usage the host can't promote, run a force-sync, and demote inside 500ms.
    await new Promise(r => setTimeout(r, 550));
    s(ho,'set_peer_role',{peerId:'cohost',controller:false});
    await w(hc,'control_mode');
    ho._m.length = hc._m.length = hg._m.length = 0;
    s(hc,'force_sync_execute',{});
    await w(ho,'force_sync_execute'); await w(hg,'force_sync_execute');
    // After the EXECUTE, the initiator slot is cleared: a fresh EXECUTE from the
    // (now plain guest) co-host is gated again, confirming the exemption is scoped.
    ho._m.length = hc._m.length = hg._m.length = 0;
    s(hc,'force_sync_execute',{});
    let reGated=false; try { await w(ho,'force_sync_execute',500); } catch { reGated=true; }
    assert.ok(reGated, 'initiator exemption is cleared after the EXECUTE relayes');
    close();
    resetConnectionRate();

    // A valid PREPARE remains executable if the room changes from everyone to
    // host-only before EXECUTE. An invalid PREPARE grants no such exemption.
    const transitionRid = 'force-transition-'+Date.now();
    const transitionHost = await c(), transitionGuest = await c();
    await j(transitionHost, transitionRid, 'transition-host');
    await j(transitionGuest, transitionRid, 'transition-guest');
    transitionHost._m.length = transitionGuest._m.length = 0;
    s(transitionGuest, 'force_sync_prepare', { targetTime: 321 });
    await w(transitionHost, 'force_sync_prepare');
    s(transitionHost, 'set_control_mode', { controlMode: 'host-only' });
    await w(transitionGuest, 'control_mode');
    transitionHost._m.length = transitionGuest._m.length = 0;
    s(transitionGuest, 'force_sync_execute', {});
    await w(transitionHost, 'force_sync_execute');
    assert.equal(mod.rooms.get(transitionRid).mediaState.currentTime, 321);

    await delay(550);
    s(transitionHost, 'set_peer_role', { peerId: 'transition-guest', controller: true });
    await w(transitionGuest, 'control_mode');
    transitionHost._m.length = transitionGuest._m.length = 0;
    s(transitionGuest, 'force_sync_prepare', { targetTime: 'invalid' });
    let invalidPrepareRelayed = false;
    try { await w(transitionHost, 'force_sync_prepare', 500); } catch { invalidPrepareRelayed = true; }
    assert.ok(invalidPrepareRelayed, 'invalid PREPARE is not relayed');
    await delay(550);
    s(transitionHost, 'set_peer_role', { peerId: 'transition-guest', controller: false });
    await w(transitionGuest, 'control_mode');
    transitionHost._m.length = transitionGuest._m.length = 0;
    s(transitionGuest, 'force_sync_execute', {});
    let invalidExecuteGated = false;
    try { await w(transitionHost, 'force_sync_execute', 500); } catch { invalidExecuteGated = true; }
    assert.ok(invalidExecuteGated, 'invalid PREPARE grants no post-demotion EXECUTE exemption');
    close();
    resetConnectionRate();

    // A transient disconnect removes the co-host role but not the validated
    // room target. The same PREPARE initiator may still finish that already
    // visible transaction after reconnecting as a host-only guest.
    const forceReconnectRid = 'force-reconnect-'+Date.now();
    const forceReconnectHost = await c(), forceReconnectPeer = await c();
    await j(forceReconnectHost, forceReconnectRid, 'force-host');
    await j(forceReconnectPeer, forceReconnectRid, 'force-peer');
    forceReconnectHost._m.length = forceReconnectPeer._m.length = 0;
    s(forceReconnectHost, 'set_control_mode', { controlMode: 'host-only' });
    await w(forceReconnectHost, 'control_mode');
    await w(forceReconnectPeer, 'control_mode');
    forceReconnectHost._m.length = forceReconnectPeer._m.length = 0;
    s(forceReconnectHost, 'set_peer_role', { peerId: 'force-peer', controller: true });
    await w(forceReconnectPeer, 'control_mode');
    forceReconnectHost._m.length = forceReconnectPeer._m.length = 0;
    s(forceReconnectPeer, 'force_sync_prepare', { targetTime: 444 });
    await w(forceReconnectHost, 'force_sync_prepare');
    forceReconnectPeer.close();
    await delay(100);
    const forceReconnectReplacement = await c();
    await j(forceReconnectReplacement, forceReconnectRid, 'force-peer');
    forceReconnectHost._m.length = forceReconnectReplacement._m.length = 0;
    s(forceReconnectReplacement, 'force_sync_execute', {});
    await w(forceReconnectHost, 'force_sync_execute');
    assert.equal(mod.rooms.get(forceReconnectRid).mediaState.currentTime, 444);
    assert.equal(mod.rooms.get(forceReconnectRid).mediaState.playbackState, 'playing');
    close();
    resetConnectionRate();

    // --- A guest's stray EXECUTE (no matching PREPARE they initiated) is still gated ---
    const grid = 'h1b-'+Date.now();
    const go = await c(), gg = await c();
    await j(go, grid, 'own'); await j(gg, grid, 'gst');
    go._m.length = gg._m.length = 0;
    s(go,'set_control_mode',{controlMode:'host-only'});
    await w(go,'control_mode'); await w(gg,'control_mode');
    go._m.length = gg._m.length = 0;
    s(gg,'force_sync_execute',{});
    let uninitGated=false; try { await w(go,'force_sync_execute',500); } catch { uninitGated=true; }
    assert.ok(uninitGated, 'guest FORCE_SYNC_EXECUTE without a matching PREPARE is gated');
    close();
    resetConnectionRate();

    // =====================================================================
    // BACKWARD COMPATIBILITY — old clients (pre-HCM build) against new server.
    // These tests simulate an old client by deliberately omitting fields the
    // new feature added (desynced in heartbeats, capabilities expectation)
    // and by ignoring CONTROL_MODE broadcasts. The wire format for existing
    // events must stay byte-compatible: the relay must accept old payloads
    // and must not inject new fields old clients would misread.
    // =====================================================================

    // --- BC-1: Old-client heartbeat (no `desynced` field) is accepted and
    //     relayed without injecting `desynced`. Old clients never sent the
    //     field; the relay must strip it from the wire so we don't surprise
    //     them with unexpected keys. ---
    const bcrid = 'bc-'+Date.now();
    const bco = await c(), bcn = await c();    // bco = "old", bcn = "new"
    await j(bco, bcrid, 'oldp'); await j(bcn, bcrid, 'newp');
    bco._m.length = bcn._m.length = 0;
    // Old-client heartbeat: every field an old build would send, NO `desynced`.
    s(bco,'peer_status',{
        status:'heartbeat', username:'old', tabTitle:'t', mediaTitle:'m',
        playbackState:'playing', currentTime:42, volume:0.5, muted:false
    });
    let bcRelay = null; const bcStart = Date.now();
    while (Date.now()-bcStart < 800 && !bcRelay) {
        for (let i=0;i<bcn._m.length;i++){ const r=bcn._m[i]; if(r.startsWith('42')){ const [e,dd]=JSON.parse(r.substring(2)); if(e==='peer_status'){ bcn._m.splice(i,1); bcRelay=dd; break; } } }
        await new Promise(r=>setTimeout(r,30));
    }
    assert.ok(bcRelay, 'old-style heartbeat relayed');
    assert.ok(bcRelay.desynced === undefined, 'old-client heartbeat has no desynced on the wire (stripped)');
    assert.equal(bcRelay.currentTime, 42, 'old-client currentTime preserved');
    assert.equal(bcRelay.senderId, 'oldp', 'old-client senderId preserved');
    close();
    resetConnectionRate();

    // --- BC-2: Old client in a host-only room — server still gates its events
    //     even though the client has no awareness of the mode. This is the
    //     key guarantee for mixed rooms during rollout: an old client can't
    //     drive a host-only room just because it ignores CONTROL_MODE. ---
    const hmrid = 'hcmix-'+Date.now();
    const hmo = await c(), hmg = await c();    // hmo = host (new), hmg = "old" guest
    await j(hmo, hmrid, 'hmixhost'); await j(hmg, hmrid, 'hmixold');
    hmo._m.length = hmg._m.length = 0;
    s(hmo,'set_control_mode',{controlMode:'host-only'});
    await w(hmo,'control_mode'); await w(hmg,'control_mode');   // old client's socket still receives it; old client would ignore
    hmo._m.length = hmg._m.length = 0;
    // "Old" guest tries to drive — server must drop. Host must NOT receive it.
    s(hmg,'pause',{currentTime:5});
    let oldGated=false; try { await w(hmo,'pause',600); } catch { oldGated=true; }
    assert.ok(oldGated, 'old-client pause dropped in host-only (server enforces regardless of client awareness)');
    // Host's own command still relays to the old client's socket — old client
    // applies it via its existing PLAY/PAUSE handler.
    s(hmo,'pause',{currentTime:7}); await w(hmg,'pause');
    close();
    resetConnectionRate();

    // --- BC-3: Mixed room with old + new client in 'everyone' mode — every
    //     event flows identically to pre-HCM. Confirms no regression in the
    //     default-mode relay path that could fragment a rolling-update room. ---
    const mxrid = 'mix-'+Date.now();
    const mxo = await c(), mxn = await c();    // mxo = old, mxn = new
    await j(mxo, mxrid, 'oldmx'); await j(mxn, mxrid, 'newmx');
    mxo._m.length = mxn._m.length = 0;
    // Old → new
    s(mxo,'play',{currentTime:1}); await w(mxn,'play');
    s(mxo,'seek',{currentTime:99}); await w(mxn,'seek');
    s(mxo,'force_sync_prepare',{targetTime:5}); await w(mxn,'force_sync_prepare');
    // New → old
    mxo._m.length = mxn._m.length = 0;
    s(mxn,'force_sync_execute',{}); await w(mxo,'force_sync_execute');
    s(mxo,'episode_lobby',{expectedTitle:'S1E1'}); await w(mxn,'episode_lobby');
    s(mxn,'pause',{currentTime:2}); await w(mxo,'pause');
    s(mxn,'seek',{currentTime:50}); await w(mxo,'seek');
    s(mxn,'episode_lobby_cancel',{}); await w(mxo,'episode_lobby_cancel');
    close();
    resetConnectionRate();

    // --- BC-4: New-client heartbeat WITH `desynced` does not break an old
    //     client's receive path. The field is appended but old clients ignore
    //     unknown keys — verify the relay preserves every pre-HCM field and
    //     only adds `desynced`. ---
    const b4rid = 'bc4-'+Date.now();
    const b4old = await c(), b4new = await c();
    await j(b4old, b4rid, 'b4o'); await j(b4new, b4rid, 'b4n');
    b4old._m.length = b4new._m.length = 0;
    s(b4new,'peer_status',{status:'heartbeat', desynced:true, currentTime:7, playbackState:'paused', username:'newp'});
    let b4Relay = null; const b4Start = Date.now();
    while (Date.now()-b4Start < 800 && !b4Relay) {
        for (let i=0;i<b4old._m.length;i++){ const r=b4old._m[i]; if(r.startsWith('42')){ const [e,dd]=JSON.parse(r.substring(2)); if(e==='peer_status'){ b4old._m.splice(i,1); b4Relay=dd; break; } } }
        await new Promise(r=>setTimeout(r,30));
    }
    assert.ok(b4Relay, 'new-client heartbeat relayed to old client');
    assert.equal(b4Relay.desynced, true, 'desynced preserved for new recipients');
    assert.equal(b4Relay.currentTime, 7, 'old fields preserved on the same relay');
    assert.equal(b4Relay.senderId, 'b4n', 'senderId preserved');
    close();
    resetConnectionRate();

    // --- Password room ---
    const prid = 'pw-'+Date.now();
    const pw1 = await c(); await j(pw1, prid, 'admin', 's3cret');
    const pw2 = await c();
    s(pw2,'join_room',{roomId:prid,password:'BAD',peerId:'bad',protocolVersion:'1.0.0'});
    assert.equal((await a(pw2))[0],'error','wrong pw');
    const pw3 = await c();
    s(pw3,'join_room',{roomId:prid,password:'s3cret',peerId:'good',protocolVersion:'1.0.0'});
    assert.equal((await a(pw3))[0],'room_data','correct pw');
    close();

    // --- Protocol check + Ping + GET_ROOMS + Health ---
    const x = await c();
    s(x,'join_room',{roomId:'v-'+Date.now(),peerId:'old',protocolVersion:'0.0.1'});
    await w(x,'error'); // version mismatch
    x._m.length = 0;
    s(x,'ping',{t:Date.now()}); await w(x,'pong');
    await j(x,'lst-'+Date.now(),'l1');
    x._m.length = 0;
    s(x,'get_rooms',{}); await w(x,'room_list');
    close();

    // Dedup
    const did = 'dup-'+Date.now();
    const d1 = await c(), d2 = await c();
    await j(d1, did, 'dup'); d1._m.length = 0;
    s(d2,'join_room',{roomId:did,peerId:'dup',protocolVersion:'1.0.0'});
    assert.equal((await a(d2))[0],'room_data','dedup');
    close();

    // Health HTTP (no conn needed)
    const [st,body] = await new Promise(r => http.get(`http://127.0.0.1:${port}/`, res => {
        let d=''; res.on('data',c=>d+=c); res.on('end',()=>r([res.statusCode,JSON.parse(d)])); }));
    assert.equal(st,200); assert.equal(body.status,'online');

    console.log('All WebSocket integration tests passed (incl. host control mode)');
} catch(e) {
    console.error('FAILED:', e.message);
    process.exitCode=1;
} finally {
    close();
    if (mod?.stopServerForTests) await mod.stopServerForTests();
}
