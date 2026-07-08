import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { connectionCounts, clearRateLimitMaps } from '../server/rate-limiter.js';

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
async function w(ws, evt, ms=3000) { const st=Date.now(); while(Date.now()-st<ms) { for(let i=0;i<ws._m.length;i++){const r=ws._m[i];ws._m.splice(i,1);if(r.startsWith('42')){try{const[e]=JSON.parse(r.substring(2));if(e===evt)return e}catch{/* skip */}}} await new Promise(r=>setTimeout(r,50));} throw Error(`wait:${evt}`); }
async function j(ws, rid, pid, pw=null) { s(ws,'join_room',{roomId:rid,peerId:pid,password:pw,protocolVersion:'1.0.0'}); assert.equal((await a(ws))[0],'room_data'); }
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

    // --- Capabilities: ROOM_DATA advertises server features for client detection ---
    const capClient = await c();
    s(capClient, 'join_room', { roomId: 'cap-'+Date.now(), peerId: 'capp', protocolVersion: '1.0.0' });
    const [capEv, capData] = await a(capClient);
    assert.equal(capEv, 'room_data');
    assert.ok(Array.isArray(capData.capabilities) && capData.capabilities.includes('host-control'),
        'ROOM_DATA advertises the host-control capability');
    close();
    resetConnectionRate();

    // --- Chat: capability + authoritative message relay + history ---
    const chatRid = 'chat-'+Date.now();
    const ch1 = await c(), ch2 = await c(), ch3 = await c();
    await j(ch1, chatRid, 'chatHost'); await j(ch2, chatRid, 'chatGuest');
    ch1._m.length = ch2._m.length = 0;
    s(ch1, 'chat_message', { username: 'Host', text: '<b>Hello</b>' });
    const [msgEv, msgData] = await a(ch1);
    assert.equal(msgEv, 'chat_message');
    assert.equal(msgData.senderId, 'chatHost');
    assert.equal(msgData.username, 'Host');
    assert.equal(msgData.text, '<b>Hello</b>');
    assert.ok(typeof msgData.id === 'string' && msgData.id.length > 0);
    assert.ok(typeof msgData.timestamp === 'number');
    const [peerMsgEv, peerMsgData] = await a(ch2);
    assert.equal(peerMsgEv, 'chat_message');
    assert.deepEqual(peerMsgData, msgData);
    s(ch3, 'join_room', { roomId: chatRid, peerId: 'lateJoiner', protocolVersion: '1.0.0' });
    const [historyEv, historyData] = await a(ch3);
    assert.equal(historyEv, 'room_data');
    assert.ok(historyData.capabilities.includes('chat'));
    assert.deepEqual(historyData.chatHistory, [msgData]);
    assert.deepEqual(historyData.chatBannedPeerIds, []);
    close();
    resetConnectionRate();

    // --- Chat moderation: ban/unban is chat-only and server-enforced ---
    const banRid = 'chat-ban-'+Date.now();
    const banHost = await c(), banGuest = await c();
    await j(banHost, banRid, 'banHost'); await j(banGuest, banRid, 'banGuest');
    banHost._m.length = banGuest._m.length = 0;
    s(banHost, 'chat_ban', { targetId: 'banGuest' });
    let banState = null;
    const banStart = Date.now();
    while (Date.now() - banStart < 1000 && !banState) {
        for (let i = 0; i < banGuest._m.length; i++) {
            const raw = banGuest._m[i];
            if (!raw.startsWith('42')) continue;
            const [eventName, payload] = JSON.parse(raw.substring(2));
            if (eventName === 'chat_ban') { banGuest._m.splice(i, 1); banState = payload; break; }
        }
        await new Promise(r => setTimeout(r, 30));
    }
    assert.ok(banState && banState.targetId === 'banGuest');
    banHost._m.length = banGuest._m.length = 0;
    s(banGuest, 'chat_message', { text: 'blocked' });
    let bannedMessageRelayed = false;
    try { await w(banHost, 'chat_message', 500); bannedMessageRelayed = true; } catch { bannedMessageRelayed = false; }
    assert.equal(bannedMessageRelayed, false, 'chat-banned peer cannot send messages');
    s(banHost, 'chat_unban', { targetId: 'banGuest' });
    await w(banGuest, 'chat_unban');
    banHost._m.length = banGuest._m.length = 0;
    s(banGuest, 'chat_message', { text: 'allowed' });
    await w(banHost, 'chat_message');
    close();
    resetConnectionRate();

    // --- Chat read receipts cannot cross rooms ---
    const rr1 = await c(), rr2 = await c();
    await j(rr1, 'rr-a-'+Date.now(), 'readerA');
    await j(rr2, 'rr-b-'+Date.now(), 'readerB');
    rr1._m.length = rr2._m.length = 0;
    s(rr1, 'chat_read', { targetId: 'readerB', messageId: 'msg-1' });
    let crossRoomReadRelayed = false;
    try { await w(rr2, 'chat_read', 500); crossRoomReadRelayed = true; } catch { crossRoomReadRelayed = false; }
    assert.equal(crossRoomReadRelayed, false, 'chat_read cannot cross rooms');
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
    s(mxo,'episode_lobby',{expectedTitle:'S1E1'}); await w(mxn,'episode_lobby');
    // New → old
    mxo._m.length = mxn._m.length = 0;
    s(mxn,'pause',{currentTime:2}); await w(mxo,'pause');
    s(mxn,'seek',{currentTime:50}); await w(mxo,'seek');
    s(mxn,'force_sync_execute',{}); await w(mxo,'force_sync_execute');
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
