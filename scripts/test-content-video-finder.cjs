const fs = require('fs');
const path = require('path');
const assert = require('assert');

const contentPath = path.join(__dirname, '..', 'extension', 'content.js');
const source = fs.readFileSync(contentPath, 'utf8');

function extractFunction(name, text) {
  const start = text.indexOf(`function ${name}`);
  assert.notStrictEqual(start, -1, `${name} not found`);

  const bodyStart = text.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}') depth--;
    if (depth === 0) return text.slice(start, i + 1);
  }
  throw new Error(`${name} body did not terminate`);
}

function makeSeekable(ranges = []) {
  return {
    length: ranges.length,
    start(i) { return ranges[i][0]; },
    end(i) { return ranges[i][1]; }
  };
}

function makeVideo(name, width, height, options = {}) {
  return {
    name,
    tagName: 'VIDEO',
    videoWidth: width,
    videoHeight: height,
    offsetWidth: width,
    offsetHeight: height,
    muted: options.muted ?? true,
    controls: options.controls ?? true,
    paused: options.paused ?? true,
    ended: options.ended ?? false,
    currentSrc: options.currentSrc ?? 'fixture.mp4',
    duration: options.duration ?? 0,
    currentTime: options.currentTime ?? 0,
    seekable: options.seekable ?? makeSeekable()
  };
}

const lightPreview = makeVideo('light-preview', 160, 90, { muted: false, duration: 30 });
const shadowPlayer = makeVideo('shadow-player', 1920, 1080, { muted: false, duration: 3600 });

const shadowRoot = {
  querySelectorAll(selector) {
    if (selector === 'video') return [shadowPlayer];
    return [];
  }
};

const shadowHost = { shadowRoot };

const fakeDocument = {
  querySelectorAll(selector) {
    if (selector === 'video') return [lightPreview];
    return [shadowHost];
  }
};

// findVideo delegates to a small set of ranking helpers; they have to be lifted
// together or this would silently test a stale shape of the finder.
const VIDEO_FINDER_PARTS = [
  'findVideo',
  'collectVideoCandidates',
  'getElementRenderBox',
  'elementStylesAllowRendering',
  'isElementRendered',
  'getRenderedVideoArea',
  'getVideoSizeBucket',
  'isVideoRendered',
  'hasPlayableVideoSource',
  'isBackgroundVideo',
  'isVideoPlaying',
  'isShortUncontrolledVideo',
  'compareVideoRanks',
  'pickBestVideo'
];

function extractRankingTable(text) {
  const start = text.indexOf('const VIDEO_RANKING_SIGNALS');
  assert.notStrictEqual(start, -1, 'VIDEO_RANKING_SIGNALS not found');
  const end = text.indexOf('];', start);
  assert.notStrictEqual(end, -1, 'VIDEO_RANKING_SIGNALS did not terminate');
  return text.slice(start, end + 2);
}

const fnSource = [
  ...VIDEO_FINDER_PARTS.map(name => extractFunction(name, source)),
  extractRankingTable(source)
].join('\n');
const findVideo = Function('document', `${fnSource}; return findVideo;`)(fakeDocument);

const selected = findVideo(fakeDocument);
assert.strictEqual(
  selected,
  shadowPlayer,
  'findVideo should score Shadow DOM videos together with light DOM videos'
);

// A hidden preload must not become the active controller merely because it is
// the only video currently present. The media-frame monitor re-runs discovery
// if its geometry becomes visible later.
const lonelyBadCandidate = makeVideo('lonely', 0, 0, { muted: true, duration: 0 });
lonelyBadCandidate.loop = true;
lonelyBadCandidate.controls = false;
lonelyBadCandidate.offsetWidth = 0;
lonelyBadCandidate.offsetHeight = 0;

const lonelyDocument = {
  querySelectorAll(selector) {
    if (selector === 'video') return [lonelyBadCandidate];
    return [];
  }
};

assert.strictEqual(
  findVideo(lonelyDocument),
  null,
  'a hidden single candidate is not returned as an active player'
);

function attachRenderEnvironment(documentNode, elements, {
  frameElement = null,
  scrollWidth = 1000,
  scrollHeight = 700,
  scrollX = 0,
  scrollY = 0
} = {}) {
  const view = {
    innerWidth: 1000,
    innerHeight: 700,
    scrollX,
    scrollY,
    frameElement,
    getComputedStyle(element) {
      return element._style || { display: 'block', visibility: 'visible', opacity: '1' };
    }
  };
  documentNode.defaultView = view;
  documentNode.documentElement = { scrollWidth, scrollHeight };
  for (const element of elements) {
    element.ownerDocument = documentNode;
    element.getBoundingClientRect = () => element._rect || {
      width: element.offsetWidth,
      height: element.offsetHeight,
      top: 0,
      left: 0,
      right: element.offsetWidth,
      bottom: element.offsetHeight
    };
  }
  return view;
}

const hiddenPlayingVideo = makeVideo('hidden-playing', 900, 506, {
  controls: true,
  paused: false,
  duration: 1200
});
hiddenPlayingVideo._style = { display: 'block', visibility: 'hidden', opacity: '1' };
const visiblePausedVideo = makeVideo('visible-paused', 800, 450, {
  controls: true,
  paused: true,
  duration: 1200
});
const visibilityDocument = {
  querySelectorAll(selector) {
    if (selector === 'video') return [hiddenPlayingVideo, visiblePausedVideo];
    return [];
  }
};
attachRenderEnvironment(visibilityDocument, [hiddenPlayingVideo, visiblePausedVideo]);
assert.strictEqual(
  findVideo(visibilityDocument),
  visiblePausedVideo,
  'a hidden playing preload must not outrank the visible paused player'
);

// Crunchyroll wraps its Bitmovin player in `display: contents`. Such a wrapper
// has no box of its own and checkVisibility() returns false for the wrapper,
// even though the descendant video is fully visible.
const displayContentsPlayer = makeVideo('display-contents-player', 1920, 1080, {
  controls: false,
  paused: true,
  duration: 1420
});
const displayContentsWrapper = {
  _style: { display: 'contents', visibility: 'visible', opacity: '1' },
  checkVisibility() { return false; },
  parentElement: null
};
displayContentsPlayer.parentElement = displayContentsWrapper;
displayContentsPlayer.checkVisibility = () => true;
const displayContentsDocument = {
  querySelectorAll(selector) {
    if (selector === 'video') return [displayContentsPlayer];
    return [];
  }
};
attachRenderEnvironment(
  displayContentsDocument,
  [displayContentsPlayer, displayContentsWrapper]
);
assert.strictEqual(
  findVideo(displayContentsDocument),
  displayContentsPlayer,
  'a visible player inside a display: contents wrapper must remain selectable'
);

const belowFoldPlayer = makeVideo('below-fold-player', 800, 450, {
  controls: true,
  duration: 1200
});
belowFoldPlayer._rect = {
  width: 800, height: 450, top: 900, left: 0, right: 800, bottom: 1350
};
const offscreenDecoy = makeVideo('offscreen-decoy', 900, 506, {
  controls: true,
  paused: false,
  duration: 1200
});
offscreenDecoy._rect = {
  width: 900, height: 506, top: 0, left: -2000, right: -1100, bottom: 506
};
const scrollableDocument = {
  querySelectorAll(selector) {
    if (selector === 'video') return [offscreenDecoy, belowFoldPlayer];
    return [];
  }
};
attachRenderEnvironment(scrollableDocument, [offscreenDecoy, belowFoldPlayer], { scrollHeight: 1500 });
assert.strictEqual(
  findVideo(scrollableDocument),
  belowFoldPlayer,
  'a player below the fold remains eligible while a positioned offscreen decoy does not'
);

const scrolledPastPlayer = makeVideo('scrolled-past-player', 800, 450, {
  controls: true,
  duration: 1200
});
scrolledPastPlayer._rect = {
  width: 800, height: 450, top: -800, left: 0, right: 800, bottom: -350
};
const scrolledDocument = {
  querySelectorAll(selector) {
    if (selector === 'video') return [scrolledPastPlayer];
    return [];
  }
};
attachRenderEnvironment(scrolledDocument, [scrolledPastPlayer], {
  scrollHeight: 1500,
  scrollY: 900
});
assert.strictEqual(
  findVideo(scrolledDocument),
  scrolledPastPlayer,
  'a player above the current viewport remains eligible when it is inside the document layout'
);

const framedHiddenVideo = makeVideo('framed-hidden', 900, 506, {
  controls: true,
  paused: false,
  duration: 1200
});
const hiddenFrameDocument = {
  querySelectorAll(selector) {
    if (selector === 'video') return [framedHiddenVideo];
    return [];
  }
};
const hiddenAncestorFrame = {
  offsetWidth: 900,
  offsetHeight: 506,
  _style: { display: 'block', visibility: 'hidden', opacity: '1' },
  contentDocument: hiddenFrameDocument
};
const hiddenFrameTopDocument = {
  querySelectorAll(selector) {
    if (selector === 'video') return [];
    if (selector === 'iframe, frame') return [hiddenAncestorFrame];
    return [];
  }
};
attachRenderEnvironment(hiddenFrameTopDocument, [hiddenAncestorFrame]);
attachRenderEnvironment(hiddenFrameDocument, [framedHiddenVideo], { frameElement: hiddenAncestorFrame });
assert.strictEqual(
  findVideo(hiddenFrameTopDocument),
  null,
  'a video inside a hidden same-origin ancestor frame must not be selected'
);

// Same-origin player iframe (jkanime.net): the top document has no <video>,
// the real player lives inside the frame document.
const framedPlayer = makeVideo('framed-player', 1280, 720, { muted: false, duration: 1400 });

const frameDocument = {
  querySelectorAll(selector) {
    if (selector === 'video') return [framedPlayer];
    return [];
  }
};

const playerFrame = { contentDocument: frameDocument };

const framedTopDocument = {
  querySelectorAll(selector) {
    if (selector === 'video') return [];
    if (selector === 'iframe, frame') return [playerFrame];
    return [];
  }
};

assert.strictEqual(
  findVideo(framedTopDocument),
  framedPlayer,
  'findVideo should descend into same-origin player iframes'
);

// A cross-origin frame throws on contentDocument and must not break the scan.
const crossOriginFrame = {
  get contentDocument() { throw new Error('blocked by same-origin policy'); }
};

const crossOriginTopDocument = {
  querySelectorAll(selector) {
    if (selector === 'video') return [lightPreview];
    if (selector === 'iframe, frame') return [crossOriginFrame];
    return [];
  }
};

assert.strictEqual(
  findVideo(crossOriginTopDocument),
  lightPreview,
  'findVideo should skip unreachable cross-origin frames'
);

function makeDocument(nodes = []) {
  return {
    querySelectorAll() { return nodes; }
  };
}

function loadTimelineFns(hostname, document = makeDocument(), pageApiTime = null) {
  const disneyPageApiTime = pageApiTime
    ? `let disneyPageApiTime = { position: ${pageApiTime.position}, duration: ${pageApiTime.duration}, at: Date.now() - ${pageApiTime.ageMs || 0} };`
    : 'let disneyPageApiTime = null;';
  return Function('window', 'document', [
    disneyPageApiTime,
    extractFunction('hostMatchesUrl', source),
    extractFunction('matchesPlayerUrls', source),
    extractFunction('isDisneyPlusHost', source),
    extractFunction('getDisneyPlusTimeline', source),
    extractFunction('getSiteQuirkAdapters', source),
    extractFunction('getActiveSiteQuirk', source),
    extractFunction('getSiteQuirkTimeline', source),
    extractFunction('getSiteQuirkDebug', source),
    extractFunction('getSyncCurrentTime', source),
    extractFunction('getSyncDuration', source),
    extractFunction('toNativeSeekTime', source),
    'return { getActiveSiteQuirk, getSyncCurrentTime, getSyncDuration, toNativeSeekTime };'
  ].join('\n'))({ location: { hostname } }, document);
}

function loadPlayerFixFns(hostname) {
  return Function('window', [
    extractFunction('hostMatchesUrl', source),
    extractFunction('matchesPlayerUrls', source),
    extractFunction('getPlayerActionFixes', source),
    extractFunction('getActivePlayerActionFix', source),
    'return { getPlayerActionFixes, getActivePlayerActionFix };'
  ].join('\n'))({ location: { hostname } });
}

const disneyFns = loadTimelineFns('www.disneyplus.com', makeDocument(), {
  position: 9,
  duration: 10800
});
assert.equal(disneyFns.getActiveSiteQuirk().name, 'disneyplus-page-api');
assert.deepEqual(disneyFns.getActiveSiteQuirk().urls, ['disneyplus.com']);
const disneyVideo = makeVideo('disney-offset', 1920, 1080, {
  currentTime: 29,
  duration: 0,
  seekable: makeSeekable([[0, 32400]])
});
assert.equal(disneyFns.getSyncCurrentTime(disneyVideo), 9);
assert.equal(disneyFns.getSyncDuration(disneyVideo), 10800);
assert.equal(disneyFns.toNativeSeekTime(disneyVideo, 39), 39);
assert.equal(disneyFns.getSyncCurrentTime(makeVideo('disney-native-broken', 1920, 1080, {
  currentTime: Number.NaN,
  duration: 0
})), 9);

const disneyNoPageApiFns = loadTimelineFns('www.disneyplus.com');
const disneyOffsetVideo = makeVideo('disney-offset', 1920, 1080, {
  currentTime: 29,
  duration: 0,
  seekable: makeSeekable([[20, 10820]])
});
assert.equal(disneyNoPageApiFns.getSyncCurrentTime(disneyOffsetVideo), null);
assert.equal(disneyNoPageApiFns.getSyncDuration(disneyOffsetVideo), 0);
assert.equal(disneyNoPageApiFns.toNativeSeekTime(disneyOffsetVideo, 39), 39);

const genericFns = loadTimelineFns('example.com');
assert.equal(genericFns.getActiveSiteQuirk(), null);
assert.equal(genericFns.getSyncCurrentTime(disneyVideo), 29);
assert.equal(genericFns.getSyncDuration(disneyVideo), 0);
assert.equal(genericFns.toNativeSeekTime(disneyVideo, 39), 39);

const twitchFixFns = loadPlayerFixFns('player.twitch.tv');
assert.equal(twitchFixFns.getActivePlayerActionFix().name, 'twitch-player-buttons');
assert.deepEqual(twitchFixFns.getActivePlayerActionFix().urls, ['twitch.tv']);

const genericFixFns = loadPlayerFixFns('example.com');
assert.equal(genericFixFns.getActivePlayerActionFix(), null);

console.log('content video finder tests passed');
