import { describe, expect, it, vi } from 'vitest';
import {
    MEDIA_FRAME_ACCESS_REQUIRED,
    inspectMediaFrame,
    resolveMediaContentTarget,
    selectMediaFrame
} from './media-frame-target.js';

function video(overrides = {}) {
    const candidate = {
        hasSource: true,
        rendered: true,
        background: false,
        shortUncontrolled: false,
        sizeBucket: 18,
        playing: false,
        controls: true,
        readyState: 4,
        duration: 1200,
        renderedArea: 830 * 498,
        ...overrides
    };
    candidate.shortUncontrolled = overrides.shortUncontrolled ?? (
        !candidate.controls && candidate.duration > 0 && candidate.duration < 300
    );
    return candidate;
}

function frame(frameId, overrides = {}) {
    return {
        frameId,
        documentId: `document-${frameId}`,
        result: {
            href: `https://player-${frameId}.example/embed`,
            origin: `https://player-${frameId}.example`,
            isTop: frameId === 0,
            videoCount: 1,
            bestVideo: video(),
            frameArea: 830 * 498,
            parentFrameVisible: true,
            parentFrameArea: 830 * 498,
            embeddedFrames: [],
            ...overrides
        }
    };
}

describe('cross-origin media-frame targeting', () => {
    it('selects a visible cross-origin player over a hidden loaded copy', () => {
        const selected = selectMediaFrame([
            frame(4),
            frame(5, { parentFrameVisible: false, bestVideo: video({ playing: true }) })
        ]);
        expect(selected.frameId).toBe(4);
    });

    it('does not select a video hidden inside a same-origin descendant', () => {
        expect(selectMediaFrame([
            frame(0, { bestVideo: video({ rendered: false }) }),
            frame(6, {
                parentFrameVisible: false,
                bestVideo: video({ rendered: true, playing: true })
            })
        ])).toBeNull();
    });

    it('keeps a real player ahead of a larger muted looping background video', () => {
        const selected = selectMediaFrame([
            frame(2, { bestVideo: video({ sizeBucket: 24, background: true, controls: false }) }),
            frame(7, { bestVideo: video({ sizeBucket: 18 }) })
        ]);
        expect(selected.frameId).toBe(7);
    });

    it('keeps an active long player ahead of a larger ordinary ad video', () => {
        const selected = selectMediaFrame([
            frame(2, { bestVideo: video({ sizeBucket: 24, duration: 30, playing: false, controls: false }) }),
            frame(7, { bestVideo: video({ sizeBucket: 18, duration: 1200, playing: true, controls: true }) })
        ]);
        expect(selected.frameId).toBe(7);
    });

    it('keeps a paused long player ahead of a playing short uncontrolled ad', () => {
        const selected = selectMediaFrame([
            frame(2, { bestVideo: video({
                sizeBucket: 24,
                duration: 30,
                playing: true,
                controls: false,
                shortUncontrolled: true
            }) }),
            frame(7, { bestVideo: video({
                sizeBucket: 18,
                duration: 1200,
                playing: false,
                controls: true
            }) })
        ]);
        expect(selected.frameId).toBe(7);
    });

    it('keeps same-origin reachable media under the top-frame controller', () => {
        const sharedVideo = video();
        const selected = selectMediaFrame([
            frame(0, { bestVideo: sharedVideo, videoCount: 1 }),
            frame(6, { bestVideo: sharedVideo, videoCount: 1 })
        ]);
        expect(selected.frameId).toBe(0);
    });

    it('ignores a hidden srcless ad slot that resolves to another frame url', () => {
        // An iframe without src resolves to its parent document's URL. A hidden
        // ad slot must therefore never be able to declare a real player hidden.
        const selected = selectMediaFrame([
            frame(0, {
                bestVideo: null,
                videoCount: 0,
                embeddedFrames: [{
                    href: 'https://player-5.example/embed',
                    explicitSrc: false,
                    visible: false,
                    area: 0,
                    width: 0,
                    height: 0,
                    depth: 1,
                    mediaHint: false
                }]
            }),
            frame(5, { parentFrameVisible: null })
        ]);
        expect(selected?.frameId).toBe(5);
    });

    it('drops a player parked inside a collapsed same-origin wrapper', () => {
        const selected = selectMediaFrame([
            frame(0, {
                bestVideo: null,
                videoCount: 0,
                embeddedFrames: [
                    {
                        href: 'https://player-5.example/embed',
                        explicitSrc: true,
                        visible: true,
                        area: 830 * 498,
                        width: 830,
                        height: 498,
                        depth: 2,
                        mediaHint: true
                    },
                    {
                        href: 'https://player-6.example/embed',
                        explicitSrc: true,
                        visible: false,
                        area: 0,
                        width: 0,
                        height: 0,
                        depth: 2,
                        mediaHint: true
                    }
                ]
            }),
            frame(5, { parentFrameVisible: null }),
            frame(6, { parentFrameVisible: null })
        ]);
        expect(selected?.frameId).toBe(5);
    });

    it('refuses to guess between equally-ranked frames without visibility evidence', () => {
        expect(selectMediaFrame([
            frame(3, { parentFrameVisible: null }),
            frame(4, { parentFrameVisible: null })
        ])).toBeNull();
    });

    it('returns the exact selected frame and document after probing', async () => {
        const results = [frame(0, { bestVideo: null, videoCount: 0 }), frame(8)];
        const executeScript = vi.fn().mockResolvedValue(results);
        await expect(resolveMediaContentTarget(
            { scripting: { executeScript } },
            42,
            { attempts: 1, probeDelayMs: 0 }
        )).resolves.toEqual({
            frameId: 8,
            documentId: 'document-8',
            frameUrl: 'https://player-8.example/embed',
            hasVideo: true,
            visibilityConfirmed: true,
            // Reported back so the caller can address these frames directly when
            // a later all-frames sweep is rejected wholesale.
            discoveredFrameIds: [0, 8],
            scriptTarget: { tabId: 42, documentIds: ['document-8'] }
        });
        const visibilityDispatches = executeScript.mock.calls.filter(([options]) => (
            options.func?.name === 'dispatchParentFrameVisibilityProbe'
        ));
        // Two passes — the floor — across both discovered frames, each addressed
        // on its own so a frame that never answers cannot cancel the others.
        // These fixtures report no nesting, so the depth-scaled pass count must
        // not spend the worst-case four round trips here.
        expect(visibilityDispatches).toHaveLength(4);
        expect(visibilityDispatches.every(([options]) => options.target.allFrames !== true)).toBe(true);
    });

    it('skips the visibility handshake when no frame has a video yet', async () => {
        // Selecting an anime tab before playback must be immediate: there is
        // nothing to rank, so the handshake and the retry budget are pure delay.
        const results = [
            frame(0, { bestVideo: null, videoCount: 0 }),
            frame(3, { bestVideo: null, videoCount: 0 }),
            frame(4, { bestVideo: null, videoCount: 0 })
        ];
        const executeScript = vi.fn().mockResolvedValue(results);
        await expect(resolveMediaContentTarget(
            { scripting: { executeScript } },
            42,
            { probeDelayMs: 0, retryDelayMs: 0 }
        )).resolves.toMatchObject({ frameId: 0, hasVideo: false });

        expect(executeScript.mock.calls.filter(([options]) => (
            options.func?.name === 'dispatchParentFrameVisibilityProbe'
                || options.func?.name === 'installParentFrameVisibilityProbe'
        ))).toHaveLength(0);
        // And it must not burn all eight attempts waiting for a video that no
        // frame has: the injected monitor reports one the moment it appears.
        const inspections = executeScript.mock.calls.filter(([options]) => (
            options.func?.name === 'inspectMediaFrame'
        ));
        expect(inspections.length).toBeLessThanOrEqual(4);
    });

    it('keeps the top target inactive when the only discovered video is hidden', async () => {
        const results = [
            frame(0, { bestVideo: video({ rendered: false }) }),
            frame(6, { parentFrameVisible: false })
        ];
        const executeScript = vi.fn().mockResolvedValue(results);
        await expect(resolveMediaContentTarget(
            { scripting: { executeScript } },
            42,
            { attempts: 1, probeDelayMs: 0 }
        )).resolves.toEqual({
            frameId: 0,
            documentId: null,
            frameUrl: null,
            hasVideo: false,
            visibilityConfirmed: false,
            discoveredFrameIds: [0, 6],
            scriptTarget: { tabId: 42 }
        });
    });

    it('uses all-frame probing without a navigation permission', async () => {
        const executeScript = vi.fn().mockResolvedValue([frame(8)]);

        await expect(resolveMediaContentTarget(
            { scripting: { executeScript } },
            42,
            { attempts: 1, probeDelayMs: 0 }
        )).resolves.toMatchObject({
            frameId: 8,
            hasVideo: true,
            scriptTarget: { tabId: 42, documentIds: ['document-8'] }
        });
        expect(executeScript.mock.calls[0][0].target).toEqual({ tabId: 42, allFrames: true });
    });

    it('does not trust parent visibility from an older probe token', () => {
        const originalWindow = globalThis.window;
        const originalDocument = globalThis.document;
        const fakeWindow = {
            top: {},
            location: { href: 'https://player.example/embed', origin: 'https://player.example' },
            innerWidth: 800,
            innerHeight: 450,
            __koalaParentFrameVisibility: { token: 'old-token', visible: true, area: 360000 }
        };
        const fakeDocument = {
            location: fakeWindow.location,
            defaultView: fakeWindow,
            querySelectorAll: () => []
        };
        globalThis.window = fakeWindow;
        globalThis.document = fakeDocument;
        try {
            expect(inspectMediaFrame('new-token')).toMatchObject({
                parentFrameVisible: null,
                parentFrameArea: null
            });
        } finally {
            if (originalWindow === undefined) delete globalThis.window;
            else globalThis.window = originalWindow;
            if (originalDocument === undefined) delete globalThis.document;
            else globalThis.document = originalDocument;
        }
    });

    it('recognizes the current Google Drive youtube.googleapis.com player', async () => {
        const top = frame(0, {
            href: 'https://drive.google.com/drive/u/0/search?q=video',
            origin: 'https://drive.google.com',
            bestVideo: null,
            videoCount: 0,
            embeddedFrames: [{
                href: 'https://youtube.googleapis.com/embed/drive-file-id?origin=https%3A%2F%2Fdrive.google.com',
                origin: 'https://youtube.googleapis.com',
                area: 280 * 157,
                width: 280,
                height: 157,
                visible: true,
                depth: 1,
                mediaHint: false
            }]
        });
        const executeScript = vi.fn()
            .mockResolvedValueOnce([top])
            .mockResolvedValueOnce([top]);

        await expect(resolveMediaContentTarget(
            { scripting: { executeScript } },
            42,
            { attempts: 1, probeDelayMs: 0 }
        )).rejects.toMatchObject({
            code: MEDIA_FRAME_ACCESS_REQUIRED,
            host: 'youtube.googleapis.com',
            originPattern: 'https://youtube.googleapis.com/*'
        });
    });

    it('recognizes a YummyAnime-style nested inaccessible player origin', async () => {
        const top = frame(0, {
            href: 'https://yummyanime.tv/show.html',
            origin: 'https://yummyanime.tv',
            bestVideo: null,
            videoCount: 0,
            embeddedFrames: [{
                href: 'https://absciss.thealloha.club/?token=redacted',
                origin: 'https://absciss.thealloha.club',
                area: 830 * 498,
                width: 830,
                height: 498,
                visible: true,
                depth: 2,
                mediaHint: true
            }]
        });
        const executeScript = vi.fn()
            .mockResolvedValueOnce([top])
            .mockResolvedValueOnce([top]);

        await expect(resolveMediaContentTarget(
            { scripting: { executeScript } },
            43,
            { attempts: 1, probeDelayMs: 0 }
        )).rejects.toMatchObject({
            code: MEDIA_FRAME_ACCESS_REQUIRED,
            host: 'absciss.thealloha.club',
            originPattern: 'https://absciss.thealloha.club/*'
        });
    });

    it('requests the inaccessible player instead of selecting an accessible background video', async () => {
        const top = frame(0, {
            bestVideo: video({ background: true, controls: false, renderedArea: 900 * 506 }),
            embeddedFrames: [{
                href: 'https://player.external.example/watch',
                origin: 'https://player.external.example',
                area: 900 * 506,
                width: 900,
                height: 506,
                visible: true,
                mediaHint: true
            }]
        });
        const executeScript = vi.fn().mockResolvedValue([top]);
        await expect(resolveMediaContentTarget(
            { scripting: { executeScript } },
            44,
            { attempts: 1, probeDelayMs: 0 }
        )).rejects.toMatchObject({
            code: MEDIA_FRAME_ACCESS_REQUIRED,
            originPattern: 'https://player.external.example/*'
        });
    });

    it('requests the inaccessible main player instead of selecting a larger short ad', async () => {
        const top = frame(0, {
            bestVideo: video({
                playing: true,
                controls: false,
                duration: 30,
                renderedArea: 500 * 281,
                sizeBucket: 24
            }),
            embeddedFrames: [{
                href: 'https://player.external.example/watch',
                origin: 'https://player.external.example',
                area: 900 * 506,
                width: 900,
                height: 506,
                visible: true,
                mediaHint: true
            }]
        });
        const executeScript = vi.fn().mockResolvedValue([top]);
        await expect(resolveMediaContentTarget(
            { scripting: { executeScript } },
            44,
            { attempts: 1, probeDelayMs: 0 }
        )).rejects.toMatchObject({
            code: MEDIA_FRAME_ACCESS_REQUIRED,
            originPattern: 'https://player.external.example/*'
        });
    });

    it('keeps a paused long custom player over a larger inaccessible heuristic frame', async () => {
        const top = frame(0, {
            bestVideo: video({
                playing: false,
                controls: false,
                duration: 7200,
                renderedArea: 600 * 338
            }),
            embeddedFrames: [{
                href: 'https://widget.external.example/watch',
                origin: 'https://widget.external.example',
                area: 900 * 506,
                width: 900,
                height: 506,
                visible: true,
                mediaHint: true
            }]
        });
        const executeScript = vi.fn().mockResolvedValue([top]);
        await expect(resolveMediaContentTarget(
            { scripting: { executeScript } },
            44,
            { attempts: 1, probeDelayMs: 0 }
        )).resolves.toMatchObject({ frameId: 0, hasVideo: true });
    });

    it('uses Firefox-compatible portless match patterns for embedded origins', async () => {
        const top = frame(0, {
            bestVideo: null,
            videoCount: 0,
            embeddedFrames: [{
                href: 'http://127.0.0.1:4173/player',
                origin: 'http://127.0.0.1:4173',
                area: 900 * 506,
                width: 900,
                height: 506,
                visible: true,
                mediaHint: true
            }]
        });
        const executeScript = vi.fn().mockResolvedValue([top]);
        await expect(resolveMediaContentTarget(
            { scripting: { executeScript } },
            45,
            { attempts: 1, probeDelayMs: 0 }
        )).rejects.toMatchObject({ originPattern: 'http://127.0.0.1/*' });
    });

    it('does not request access for one large non-media iframe', async () => {
        const top = frame(0, {
            bestVideo: null,
            videoCount: 0,
            embeddedFrames: [{
                href: 'https://maps.example/view',
                origin: 'https://maps.example',
                area: 900 * 506,
                width: 900,
                height: 506,
                visible: true,
                mediaHint: false
            }]
        });
        const executeScript = vi.fn().mockResolvedValue([top]);
        await expect(resolveMediaContentTarget(
            { scripting: { executeScript } },
            46,
            { attempts: 1, probeDelayMs: 0 }
        )).resolves.toMatchObject({ frameId: 0, hasVideo: false });
    });

    it('does not retain a permission prompt for a player frame that disappeared', async () => {
        const withPlayer = frame(0, {
            bestVideo: null,
            videoCount: 0,
            embeddedFrames: [{
                href: 'https://player.external.example/watch',
                origin: 'https://player.external.example',
                area: 900 * 506,
                width: 900,
                height: 506,
                visible: true,
                mediaHint: true
            }]
        });
        const withoutPlayer = frame(0, { bestVideo: null, videoCount: 0, embeddedFrames: [] });
        const executeScript = vi.fn()
            .mockResolvedValueOnce([withPlayer])
            .mockResolvedValueOnce([withoutPlayer]);
        await expect(resolveMediaContentTarget(
            { scripting: { executeScript } },
            46,
            { attempts: 2, retryDelayMs: 0, probeDelayMs: 0 }
        )).resolves.toMatchObject({ frameId: 0, hasVideo: false });
    });

    it('does not request access for small or ambiguously-sized embedded frames', async () => {
        const top = frame(0, {
            bestVideo: null,
            videoCount: 0,
            embeddedFrames: [
                { href: 'https://ad-one.example', origin: 'https://ad-one.example', area: 300 * 250, width: 300, height: 250, visible: true },
                { href: 'https://ad-two.example', origin: 'https://ad-two.example', area: 300 * 250, width: 300, height: 250, visible: true }
            ]
        });
        const executeScript = vi.fn()
            .mockResolvedValueOnce([top])
            .mockResolvedValueOnce([top]);
        await expect(resolveMediaContentTarget(
            { scripting: { executeScript } },
            44,
            { attempts: 1, probeDelayMs: 0 }
        )).resolves.toMatchObject({ frameId: 0, scriptTarget: { tabId: 44 } });
    });

    it('holds the top frame instead of guessing between equal players', async () => {
        const results = [
            frame(3, { parentFrameVisible: null }),
            frame(4, { parentFrameVisible: null })
        ];
        const executeScript = vi.fn().mockResolvedValue(results);
        // Equally-ranked mirrors are an ordinary anime-site layout. Refusing to
        // activate made those pages unusable; the tab stays selected on its top
        // frame until one of the players starts and breaks the tie.
        await expect(resolveMediaContentTarget(
            { scripting: { executeScript } },
            45,
            { attempts: 1, probeDelayMs: 0 }
        )).resolves.toMatchObject({
            frameId: 0,
            hasVideo: false,
            ambiguous: true,
            scriptTarget: { tabId: 45 }
        });
    });
});

describe('embedded player access diagnosis', () => {
    function driveTop() {
        return frame(0, {
            href: 'https://drive.google.com/file/d/abc/view',
            origin: 'https://drive.google.com',
            bestVideo: null,
            videoCount: 0,
            embeddedFrames: [{
                href: 'https://youtube.googleapis.com/embed/abc?origin=https%3A%2F%2Fdrive.google.com',
                origin: 'https://youtube.googleapis.com',
                area: 640 * 360,
                width: 640,
                height: 360,
                visible: true,
                depth: 1,
                mediaHint: true
            }]
        });
    }

    it('does not demand access for a player origin the extension already holds', async () => {
        const executeScript = vi.fn().mockResolvedValue([driveTop()]);
        const contains = vi.fn().mockResolvedValue(true);

        // The player frame never answered the probe, but the grant exists. That
        // is a loading race, not a user decision, so the tab stays selected on
        // its top frame instead of raising a permission prompt.
        await expect(resolveMediaContentTarget(
            { scripting: { executeScript }, permissions: { contains } },
            42,
            { attempts: 1, probeDelayMs: 0 }
        )).resolves.toEqual({
            frameId: 0,
            documentId: null,
            frameUrl: null,
            hasVideo: false,
            visibilityConfirmed: false,
            discoveredFrameIds: [0],
            scriptTarget: { tabId: 42 }
        });
        expect(contains).toHaveBeenCalledWith({
            origins: ['https://youtube.googleapis.com/*']
        });
    });

    it('demands access only when the browser confirms the origin is withheld', async () => {
        const executeScript = vi.fn().mockResolvedValue([driveTop()]);
        const contains = vi.fn().mockResolvedValue(false);

        await expect(resolveMediaContentTarget(
            { scripting: { executeScript }, permissions: { contains } },
            42,
            { attempts: 1, probeDelayMs: 0 }
        )).rejects.toMatchObject({
            code: MEDIA_FRAME_ACCESS_REQUIRED,
            host: 'youtube.googleapis.com'
        });
    });

    it('keeps demanding access when the browser cannot answer', async () => {
        const executeScript = vi.fn().mockResolvedValue([driveTop()]);
        const contains = vi.fn().mockRejectedValue(new Error('unavailable'));

        await expect(resolveMediaContentTarget(
            { scripting: { executeScript }, permissions: { contains } },
            42,
            { attempts: 1, probeDelayMs: 0 }
        )).rejects.toMatchObject({ code: MEDIA_FRAME_ACCESS_REQUIRED });
    });

    it('resolves instead of hanging when a frame probe never settles', async () => {
        const executeScript = vi.fn()
            .mockImplementationOnce(() => new Promise(() => {}))
            .mockResolvedValue([frame(0, { bestVideo: null, videoCount: 0 })]);

        await expect(resolveMediaContentTarget(
            { scripting: { executeScript } },
            42,
            { attempts: 1, probeDelayMs: 0, probeTimeoutMs: 20 }
        )).resolves.toMatchObject({ frameId: 0, scriptTarget: { tabId: 42 } });
    });

    it('prefers a real accessible player over a Drive embed', async () => {
        const top = frame(0, {
            href: 'https://drive.google.com/file/d/abc/view',
            origin: 'https://drive.google.com',
            bestVideo: video({ controls: true, duration: 2400, renderedArea: 900 * 506 }),
            embeddedFrames: [{
                href: 'https://youtube.googleapis.com/embed/abc?origin=https%3A%2F%2Fdrive.google.com',
                origin: 'https://youtube.googleapis.com',
                area: 320 * 180,
                width: 320,
                height: 180,
                visible: true,
                depth: 1,
                mediaHint: true
            }]
        });
        const executeScript = vi.fn().mockResolvedValue([top]);
        const contains = vi.fn().mockResolvedValue(false);

        await expect(resolveMediaContentTarget(
            { scripting: { executeScript }, permissions: { contains } },
            42,
            { attempts: 1, probeDelayMs: 0 }
        )).resolves.toMatchObject({ frameId: 0, hasVideo: true });
    });
});
