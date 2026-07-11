// KoalaSync Landing Page Logic

document.addEventListener('DOMContentLoaded', () => {
    // Mockup Video Title Randomization on Load
    const SERIES_NAMES = [
        'Stranger Things',
        'Wednesday',
        'The Boys',
        'Loki',
        'Arcane',
        'Dark',
        'One Piece',
        'Lupin'
    ];

    try {
        const chosenSeries = SERIES_NAMES[Math.floor(Math.random() * SERIES_NAMES.length)];
        const startEp = Math.floor(Math.random() * 7) + 1; // Random episode between 1 and 7
        const ep1 = `${chosenSeries} - S1E${startEp}`;
        const ep2 = `${chosenSeries} - S1E${startEp + 1}`;

        document.querySelectorAll('.demo-title-text-ep1').forEach(el => {
            el.textContent = ep1;
        });
        document.querySelectorAll('.demo-title-text-ep2').forEach(el => {
            el.textContent = ep2;
        });
    } catch (err) {
        console.warn(err);
    }

    // Scroll Progress Indicator
    try {
        const progressBar = document.querySelector('.scroll-progress-bar');
        if (progressBar) {
            window.addEventListener('scroll', () => {
                const winScroll = document.body.scrollTop || document.documentElement.scrollTop;
                const height = document.documentElement.scrollHeight - document.documentElement.clientHeight;
                const scrolled = height > 0 ? (winScroll / height) * 100 : 0;
                progressBar.style.width = scrolled + '%';
            }, { passive: true });
        }
    } catch (err) {
        console.warn(err);
    }

    const safeGetLocalStorage = (key) => {
        try {
            return localStorage.getItem(key);
        } catch (_) {
            return null;
        }
    };

    const safeSetLocalStorage = (key, val) => {
        try {
            localStorage.setItem(key, val);
        } catch (_) {
            return;
        }
    };

    // Theme toggle (saved preference wins; otherwise follows system preference,
    // pre-paint class is applied by lang-init.js to avoid a flash)
    const themeToggle = document.getElementById('theme-toggle');
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    const themeStorageKey = 'koala_theme';
    const systemThemeQuery = (() => {
        try {
            return window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
        } catch (_) {
            return null;
        }
    })();
    const getSystemTheme = () => systemThemeQuery && systemThemeQuery.matches ? 'light' : 'dark';
    const getSavedTheme = () => {
        const savedTheme = safeGetLocalStorage(themeStorageKey);
        return savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : null;
    };
    const getCurrentTheme = () => document.documentElement.classList.contains('theme-light') ? 'light' : 'dark';
    const applyTheme = (theme) => {
        document.documentElement.classList.toggle('theme-light', theme === 'light');
    };

    applyTheme(getSavedTheme() || getSystemTheme());

    const syncThemeMeta = () => {
        if (themeMeta) {
            themeMeta.setAttribute('content', document.documentElement.classList.contains('theme-light') ? '#f1f5f9' : '#0f172a');
        }
    };
    syncThemeMeta();
    const syncSystemTheme = () => {
        if (getSavedTheme()) return;
        applyTheme(getSystemTheme());
        syncThemeMeta();
    };
    if (systemThemeQuery) {
        if (typeof systemThemeQuery.addEventListener === 'function') {
            systemThemeQuery.addEventListener('change', syncSystemTheme);
        } else if (typeof systemThemeQuery.addListener === 'function') {
            systemThemeQuery.addListener(syncSystemTheme);
        }
    }
    if (themeToggle) {
        themeToggle.addEventListener('click', () => {
            const nextTheme = getCurrentTheme() === 'light' ? 'dark' : 'light';
            applyTheme(nextTheme);
            safeSetLocalStorage(themeStorageKey, nextTheme);
            syncThemeMeta();
        });
    }

    // Highlight the CTA for the visitor's browser: it expands to the full
    // "Add to X" label while the others stay compact. Unknown browsers keep
    // all three compact.
    try {
        const ua = navigator.userAgent;
        let detected = null;
        if (/Firefox\//.test(ua) && !/Seamonkey\//.test(ua)) {
            detected = 'firefox';
        } else if (/Chrome\//.test(ua) || /Chromium\//.test(ua) || /Edg\//.test(ua) || /OPR\//.test(ua)) {
            detected = 'chrome';
        }
        if (detected) {
            const btn = document.querySelector('.btn-install[data-browser="' + detected + '"]');
            if (btn) btn.classList.add('is-detected');
        }
    } catch (_) { /* leave all buttons compact */ }

    // Keep the look-down koala anchored above the highlighted install button
    // when the CTA row wraps on tablet/mobile.
    const syncHeroMascotAnchor = () => {
        const heroText = document.querySelector('.hero-text');
        const mascot = heroText ? heroText.querySelector('.hero-mascot-container') : null;
        const ctaGroup = heroText ? heroText.querySelector('.cta-group') : null;
        if (!heroText || !mascot || !ctaGroup) return;

        const target = ctaGroup.querySelector('.btn-install.is-detected') ||
            ctaGroup.querySelector('.btn-install[data-browser="chrome"]') ||
            ctaGroup.querySelector('.btn-install');
        if (!target) return;

        const mascotRect = mascot.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        if (!mascotRect.width || !targetRect.width) return;

        const mascotCenter = mascotRect.left + mascotRect.width / 2;
        const targetCenter = targetRect.left + targetRect.width / 2;
        mascot.style.setProperty('--hero-mascot-offset', Math.round(targetCenter - mascotCenter) + 'px');
    };

    const scheduleHeroMascotAnchor = () => requestAnimationFrame(syncHeroMascotAnchor);
    window.addEventListener('load', scheduleHeroMascotAnchor, { once: true });
    window.addEventListener('resize', scheduleHeroMascotAnchor, { passive: true });
    if ('ResizeObserver' in window) {
        const heroText = document.querySelector('.hero-text');
        const ctaGroup = heroText ? heroText.querySelector('.cta-group') : null;
        const mascot = heroText ? heroText.querySelector('.hero-mascot-container') : null;
        const mascotObserver = new window.ResizeObserver(scheduleHeroMascotAnchor);
        if (ctaGroup) mascotObserver.observe(ctaGroup);
        if (mascot) mascotObserver.observe(mascot);
    }

    // Open collapsed section blocks when the URL directly targets them
    const hashCollapseMap = { '#faq': 'faq-collapse', '#self-hosting': 'selfhost-collapse' };
    const collapseId = hashCollapseMap[window.location.hash];
    if (collapseId) {
        const collapseEl = document.getElementById(collapseId);
        if (collapseEl) collapseEl.open = true;
    }

    // Scroll Reveal Logic (IntersectionObserver for performance)
    const revealElements = document.querySelectorAll('[data-reveal]');

    if ('IntersectionObserver' in window) {
        const revealObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('revealed');
                    revealObserver.unobserve(entry.target);
                }
            });
        }, {
            rootMargin: '0px 0px -30px 0px',
            threshold: 0.05
        });

        revealElements.forEach(el => revealObserver.observe(el));
    } else {
        // Fallback: without IntersectionObserver support, reveal everything
        // immediately so no content can ever stay hidden.
        revealElements.forEach(el => el.classList.add('revealed'));
    }

    // Auto-update URL hash as user scrolls through sections
    // (preserves position across language switches)
    if ('IntersectionObserver' in window) {
        const sectionObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    history.replaceState(null, null, '#' + entry.target.id);
                }
            });
        }, { threshold: 0.3 });
        document.querySelectorAll('section[id], header[id]').forEach(el => sectionObserver.observe(el));
    }

    // Navbar scroll effect (class-based so it follows the active theme)
    const nav = document.querySelector('nav');
    window.addEventListener('scroll', () => {
        nav.classList.toggle('nav-scrolled', window.scrollY > 50);
    }, { passive: true });

    // Invite Detection & Bridge
    const checkInvite = () => {
        const isJoinPage = window.location.pathname.includes('join');
        
        // Dev Simulation Mode via URL Search Parameter (?dev=success) or Hash (#dev=success / #devsuccess)
        const urlParams = new URLSearchParams(window.location.search);
        let devMode = urlParams.get('dev'); 
        
        if (!devMode) {
            const hashClean = window.location.hash.startsWith('#') ? window.location.hash.substring(1) : window.location.hash;
            const hashParams = new URLSearchParams(hashClean);
            devMode = hashParams.get('dev');
        }
        
        if (!devMode) {
            if (window.location.hash.includes('devsuccess') || window.location.search.includes('devsuccess')) devMode = 'success';
            if (window.location.hash.includes('devfailure') || window.location.search.includes('devfailure')) devMode = 'failure';
        }
        
        if (isJoinPage && devMode) {
            setTimeout(() => {
                const displayRoom = document.getElementById('display-room-id');
                const actions = document.getElementById('join-actions');
                if (displayRoom) displayRoom.textContent = 'DEV-ROOM';
                
                if (actions) {
                    actions.innerHTML = `
                        <div class="joining-spinner" style="text-align:center; padding: 1rem;">
                            <div class="join-spinner"></div>
                            <div style="font-weight: 600; color: var(--accent);">
                                <span lang="en">Simulating connection (DEV)...</span><span lang="de">Verbindung wird simuliert (DEV)...</span>
                            </div>
                            <p style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.5rem;">
                                <span lang="en">Simulating status event in 1.5 seconds.</span><span lang="de">Status-Event wird in 1,5 Sekunden simuliert.</span>
                            </p>
                        </div>
                    `;
                    setTimeout(() => {
                        window.dispatchEvent(new CustomEvent('KOALASYNC_STATUS', {
                            detail: { 
                                success: devMode === 'success',
                                message: devMode === 'failure' ? 'Simulated Connection Timeout!' : ''
                            }
                        }));
                    }, 1500);
                }
            }, 600);
            return;
        }
        
        // Use a short timeout to let the bridge script initialize its dataset attribute
        setTimeout(() => {
            const isInstalled = document.documentElement.dataset.koalasyncInstalled === 'true';
            
            if (window.location.hash.startsWith('#join:')) {
                const parts = window.location.hash.split(':');
                if (parts.length >= 3) {
                    const roomId = parts[1];
                    const password = parts[2];
                    const serverFlag = parts[3] || '0';
                    const serverUrl = parts[4] ? decodeURIComponent(parts[4]) : '';
                    
                    if (isJoinPage) {
                        const displayRoom = document.getElementById('display-room-id');
                        const actions = document.getElementById('join-actions');
                        if (displayRoom) displayRoom.textContent = roomId;
                        
                        if (actions) {
                            if (!isInstalled) {
                                const isFirefox = navigator.userAgent.includes('Firefox');
                                if (isFirefox) {
                                    actions.innerHTML = `
                                        <div class="join-card-actions">
                                            <a href="https://addons.mozilla.org/de/firefox/addon/koalasync/" class="btn btn-primary btn-firefox">
                                                <img src="assets/firefox.svg" alt="Firefox" width="20" style="display: block;">
                                                <span lang="en">GET IT ON MOZILLA ADD-ONS</span><span lang="de">IM FIREFOX ADD-ON STORE HERUNTERLADEN</span>
                                            </a>
                                            <a href="https://github.com/shik3i/KoalaSync" target="_blank" class="btn btn-secondary">
                                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true" style="display: block;"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
                                                <span lang="en">Download via GitHub</span><span lang="de">Über GitHub herunterladen</span>
                                            </a>
                                        </div>
                                        <p style="text-align:center; font-size:0.8rem; opacity:0.7; margin-top: 1.2rem; color: var(--text-muted);">
                                            <span lang="en">The extension is required to join and sync videos.</span>
                                            <span lang="de">Die Erweiterung ist erforderlich, um beizutreten und Videos zu synchronisieren.</span>
                                        </p>
                                    `;
                                } else {
                                    actions.innerHTML = `
                                        <div class="join-card-actions">
                                            <a href="https://chromewebstore.google.com/detail/koalasync/obbnmkmlaaddodakcbdljknjpagklifc" class="btn btn-primary">
                                                <img src="assets/chrome.svg" alt="Chrome" width="20" style="display: block;">
                                                <span lang="en">GET IT ON CHROME WEBSTORE</span><span lang="de">IM CHROME WEB STORE HERUNTERLADEN</span>
                                            </a>
                                            <a href="https://github.com/shik3i/KoalaSync" target="_blank" class="btn btn-secondary">
                                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true" style="display: block;"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
                                                <span lang="en">Download via GitHub</span><span lang="de">Über GitHub herunterladen</span>
                                            </a>
                                        </div>
                                        <p style="text-align:center; font-size:0.8rem; opacity:0.7; margin-top: 1.2rem; color: var(--text-muted);">
                                            <span lang="en">The extension is required to join and sync videos.</span>
                                            <span lang="de">Die Erweiterung ist erforderlich, um beizutreten und Videos zu synchronisieren.</span>
                                        </p>
                                    `;
                                }
                            } else {
                                actions.innerHTML = `
                                    <div class="joining-spinner" style="text-align:center; padding: 1rem;">
                                        <div class="join-spinner"></div>
                                        <div style="font-weight: 600; color: var(--accent);">
                                            <span lang="en">Joining room automatically...</span><span lang="de">Raum wird automatisch betreten...</span>
                                        </div>
                                        <p style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.5rem;">
                                            <span lang="en">Your extension is taking care of it.</span><span lang="de">Deine Erweiterung kümmert sich darum.</span>
                                        </p>
                                    </div>
                                `;
                                
                                // AUTO-TRIGGER JOIN
                                setTimeout(() => {
                                    window.dispatchEvent(new CustomEvent('KOALASYNC_JOIN_REQUEST', {
                                        detail: { 
                                            roomId, 
                                            password,
                                            useCustomServer: serverFlag === '1',
                                            serverUrl: serverUrl
                                        }
                                    }));
                                }, 500);
                            }
                        }
                    } else {
                        // Fallback banner for index.html
                        if (!document.getElementById('koala-banner')) {
                            const banner = document.createElement('div');
                            banner.className = 'invite-banner';
                            banner.id = 'koala-banner';

                            const container = document.createElement('div');
                            container.className = 'container';
                            container.style.cssText = 'display:flex; justify-content:space-between; align-items:center;';

                            const inviteSpan = document.createElement('span');
                            inviteSpan.appendChild(document.createTextNode('🎫 Invitation for '));
                            const boldRoom = document.createElement('b');
                            boldRoom.textContent = roomId;
                            inviteSpan.appendChild(boldRoom);
                            inviteSpan.appendChild(document.createTextNode(' detected!'));

                            const joinLink = document.createElement('a');
                            joinLink.href = 'join' + window.location.hash;
                            joinLink.className = 'btn-banner';
                            joinLink.textContent = 'OPEN JOIN PAGE';

                            container.appendChild(inviteSpan);
                            container.appendChild(joinLink);
                            banner.appendChild(container);
                            document.body.prepend(banner);
                        }
                    }

                    // Global listener for Join Button
                    document.addEventListener('click', (e) => {
                        if (e.target && e.target.id === 'webJoinBtn') {
                            e.target.textContent = 'JOINING...';
                            e.target.disabled = true;
                            window.dispatchEvent(new CustomEvent('KOALASYNC_JOIN_REQUEST', {
                                detail: { 
                                    roomId, 
                                    password,
                                    useCustomServer: serverFlag === '1',
                                    serverUrl: serverUrl
                                }
                            }));
                        }
                    });
                }
            }
        }, 600); // 600ms delay to ensure bridge.js has set the dataset
    };

    // Listen for status from Extension
    window.addEventListener('KOALASYNC_STATUS', (e) => {
        const { success, message } = e.detail;
        const isJoinPage = window.location.pathname.includes('join');
        
        if (isJoinPage) {
            const icon = document.getElementById('join-status-icon');
            const title = document.getElementById('join-title');
            const actions = document.getElementById('join-actions');
            const desc = document.getElementById('join-desc');
            const ring = document.getElementById('status-ring');

            if (success) {
                if (ring) {
                    ring.classList.remove('active-pulse');
                    ring.style.display = 'none';
                }
                if (icon) {
                    icon.innerHTML = '<img src="assets/KoalaThumbsUp.webp" alt="Success" class="join-status-mascot">';
                    icon.style.transform = 'scale(1)';
                }
                const isDE = document.documentElement.classList.contains('lang-de');
                title.textContent = isDE ? 'Erfolgreich!' : 'Success!';
                desc.innerHTML = isDE
                    ? 'Verbunden! <br><span style="color:var(--accent); font-weight:bold;">Wähle jetzt einen Video-Tab in der Erweiterung aus.</span>'
                    : 'Connected! <br><span style="color:var(--accent); font-weight:bold;">Now select a video tab in the extension.</span>';
                
                let count = 3;
                const updateCountdown = () => {
                    if (count <= 0) {
                        window.close();
                        desc.textContent = isDE ? 'Beitritt erfolgreich! Du kannst diesen Tab jetzt manuell schließen.' : 'Joined successfully! You can close this tab manually.';
                    } else {
                        count--;
                        setTimeout(updateCountdown, 1000);
                    }
                };
                setTimeout(updateCountdown, 1000);
                
                const closeLabel = isDE ? 'TAB JETZT SCHLIESSEN' : 'CLOSE TAB NOW';
                actions.innerHTML = `
                    <div class="join-card-actions">
                        <button class="btn btn-success" onclick="window.close()">${closeLabel}</button>
                    </div>
                `;
            } else {
                if (ring) {
                    ring.classList.remove('active-pulse');
                    ring.style.display = 'none';
                }
                if (icon) {
                    icon.innerHTML = '<img src="assets/KoalaThumbsDown.webp" alt="Error" class="join-status-mascot" onerror="this.outerHTML=\'❌\'">';
                    icon.style.transform = 'scale(1)';
                }
                const isDE = document.documentElement.classList.contains('lang-de');
                title.textContent = isDE ? 'Fehler' : 'Error';
                desc.textContent = isDE ? `Beitritt fehlgeschlagen: ${message}` : `Join failed: ${message}`;
                const retryLabel = isDE ? 'ERNEUT VERSUCHEN' : 'TRY AGAIN';
                actions.innerHTML = `
                    <div class="join-card-actions">
                        <button class="btn btn-primary" onclick="location.reload()">${retryLabel}</button>
                    </div>
                `;
            }
        } else {
            const banner = document.getElementById('koala-banner');
            if (banner) {
                if (success) {
                    banner.style.background = 'var(--success)';
                    banner.innerHTML = '<div class="container">✅ Joined! This tab will close in 2s...</div>';
                    setTimeout(() => window.close(), 2000);
                } else {
                    banner.style.background = 'var(--error)';
                    banner.innerHTML = '';
                    const errDiv = document.createElement('div');
                    errDiv.className = 'container';
                    errDiv.textContent = '❌ Error: ' + message;
                    banner.appendChild(errDiv);
                }
            }
        }
    });

    // Version and release date are baked in at build time; only the relative
    // "x days ago" needs to be computed at view time so it never goes stale.
    const updateDynamicVersion = () => {
        const bubble = document.querySelector('.koala-speech-bubble');
        if (!bubble || !bubble.dataset.release) return;
        const releaseDate = new Date(bubble.dataset.release);
        if (isNaN(releaseDate)) return;

        const diffMs = Date.now() - releaseDate.getTime();
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffMins = Math.floor(diffMs / (1000 * 60));

        let relativeTimeEn;
        let relativeTimeDe;
        if (diffDays > 0) {
            relativeTimeEn = `${diffDays} ${diffDays === 1 ? 'day' : 'days'} ago`;
            relativeTimeDe = `vor ${diffDays} ${diffDays === 1 ? 'Tag' : 'Tagen'}`;
        } else if (diffHours > 0) {
            relativeTimeEn = `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`;
            relativeTimeDe = `vor ${diffHours} ${diffHours === 1 ? 'Stunde' : 'Stunden'}`;
        } else if (diffMins > 0) {
            relativeTimeEn = `${diffMins} ${diffMins === 1 ? 'minute' : 'minutes'} ago`;
            relativeTimeDe = `vor ${diffMins} ${diffMins === 1 ? 'Minute' : 'Minuten'}`;
        } else {
            relativeTimeEn = 'just now';
            relativeTimeDe = 'gerade eben';
        }

        bubble.querySelectorAll('.bubble-ago').forEach(el => {
            // Nearest [lang] ancestor is the bubble's own language wrapper span
            // (not the <html> element, which also carries a lang attribute).
            const langWrap = el.closest('[lang]');
            const isDe = !!langWrap && langWrap.getAttribute('lang') === 'de';
            el.textContent = (isDe ? relativeTimeDe : relativeTimeEn) + ' \u00b7 ';
        });
    };

    // Extension Mockup Tab Switcher
    const mockTabs = document.querySelectorAll('.mock-tab');
    const mockScreens = document.querySelectorAll('.mock-screen');
    
    mockTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            mockTabs.forEach(t => t.classList.remove('active'));
            mockScreens.forEach(s => s.classList.remove('active'));
            
            tab.classList.add('active');
            const targetId = tab.getAttribute('data-target');
            const targetScreen = document.getElementById(targetId);
            if (targetScreen) {
                targetScreen.classList.add('active');
            }
        });
    });

    // The hero demo is a decorative, self-playing illustration; the real,
    // accessible walkthrough is the #how-it-works section. Hide the fake
    // extension UI from the accessibility tree and drop its controls from the
    // tab order so screen readers are not confused and it does not trip
    // contrast/label audits. Mouse interaction is unaffected.
    const heroDemoScene = document.getElementById('hero-demo');
    if (heroDemoScene) {
        heroDemoScene.setAttribute('aria-hidden', 'true');
        heroDemoScene.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')
            .forEach(el => el.setAttribute('tabindex', '-1'));
    }

    // --- Hero Live Demo (two synced video tabs + extension popup) ---
    // The same scene is used inline on desktop and mounted into a modal on
    // mobile, so the demo behavior stays in one place.
    const initHeroDemo = () => {
        const scene = document.getElementById('hero-demo');
        if (!scene) return;

        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        const launcher = scene.querySelector('#demo-launcher');
        const chip = scene.querySelector('#demo-sync-chip');
        const cursor = scene.querySelector('#demo-cursor');
        const hint = document.getElementById('demo-hint');
        const playBtn = scene.querySelector('#demo-play-btn');
        const pauseBtn = scene.querySelector('#demo-pause-btn');
        const forceSyncBtn = scene.querySelector('#demo-force-sync');
        const syncTabBtn = scene.querySelector('.mock-tab[data-target="mock-sync"]');
        const roomEmpty = scene.querySelector('#demo-room-empty');
        const roomJoined = scene.querySelector('#demo-room-joined');
        const createRoomBtn = scene.querySelector('#demo-create-room');
        const inviteCopyBtn = scene.querySelector('#demo-invite-copy');
        const videoSelect = scene.querySelector('#demo-video-select');
        const peerBs = scene.querySelectorAll('.demo-peer-b');
        const inviteFly = scene.querySelector('#demo-invite-fly');
        const toastB = scene.querySelector('#demo-toast-b');
        if (!launcher || !chip || !cursor || !playBtn || !pauseBtn) return;

        const EP_LEN = 2537;   // fake 42:17 episode
        const RATE = 1;        // realtime: 1 wall-clock second = 1 video second
        const START_T = 754;   // 12:34

        const tabs = {};
        ['a', 'b'].forEach(k => {
            const root = scene.querySelector('#demo-tab-' + k);
            tabs[k] = {
                root,
                fill: root.querySelector('.demo-progress-fill'),
                time: root.querySelector('.demo-time'),
                t: START_T,
                playing: false
            };
        });

        const fmt = (s) => {
            s = Math.floor(s);
            return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
        };

        const renderTab = (tab) => {
            tab.fill.style.width = ((tab.t / EP_LEN) * 100).toFixed(2) + '%';
            tab.time.textContent = fmt(tab.t);
            
            // Frame-locked parallax offsets
            const t = tab.t;
            const backOffset = (t * -8) % 160;
            const midOffset = (t * -24) % 160;
            const foreOffset = (t * -48) % 160;
            
            // Bouncing ball logic (bounce Y is computed as parabolic arc)
            const bouncePeriod = 0.8;
            const bounceProgress = (t % bouncePeriod) / bouncePeriod;
            const bounceHeight = 16;
            const bounceY = 4 * bounceProgress * (1 - bounceProgress) * -bounceHeight;
            
            tab.root.style.setProperty('--scroll-back', backOffset.toFixed(2) + 'px');
            tab.root.style.setProperty('--scroll-mid', midOffset.toFixed(2) + 'px');
            tab.root.style.setProperty('--scroll-fore', foreOffset.toFixed(2) + 'px');
            tab.root.style.setProperty('--bounce-y', bounceY.toFixed(2) + 'px');
        };

        const updateSyncUI = () => {
            scene.classList.toggle('streaming', tabs.a.playing && tabs.b.playing);
        };

        // Playback clock (runs only while at least one tab is playing)
        let rafId = null;
        let lastTs = null;

        const tick = (ts) => {
            rafId = null;
            const dt = lastTs === null ? 0 : Math.min((ts - lastTs) / 1000, 0.5);
            lastTs = ts;
            let anyPlaying = false;
            ['a', 'b'].forEach(k => {
                const tab = tabs[k];
                if (!tab.playing) return;
                anyPlaying = true;
                tab.t = (tab.t + dt * RATE) % EP_LEN;
                renderTab(tab);
            });
            updateSyncUI();
            if (anyPlaying) rafId = requestAnimationFrame(tick);
            else lastTs = null;
        };

        const ensureLoop = () => {
            if (rafId === null && (tabs.a.playing || tabs.b.playing)) {
                lastTs = null;
                rafId = requestAnimationFrame(tick);
            }
        };

        const setPlaying = (k, playing) => {
            const tab = tabs[k];
            tab.playing = playing;
            tab.root.classList.toggle('playing', playing);
            tab.root.setAttribute('aria-pressed', playing ? 'true' : 'false');
            ensureLoop();
            updateSyncUI();
        };

        const sceneLocalPoint = (rect, fx, fy) => {
            const sceneRect = scene.getBoundingClientRect();
            const scaleX = scene.offsetWidth ? sceneRect.width / scene.offsetWidth : 1;
            const scaleY = scene.offsetHeight ? sceneRect.height / scene.offsetHeight : scaleX;
            const safeScaleX = scaleX || 1;
            const safeScaleY = scaleY || safeScaleX;
            const xFactor = typeof fx === 'number' ? fx : 0.5;
            const yFactor = typeof fy === 'number' ? fy : 0.5;

            return {
                x: (rect.left - sceneRect.left) / safeScaleX + (rect.width / safeScaleX) * xFactor,
                y: (rect.top - sceneRect.top) / safeScaleY + (rect.height / safeScaleY) * yFactor
            };
        };

        const pulse = (key) => {
            const el = tabs[key].root;
            el.classList.remove('sync-pulse');
            void el.offsetWidth; // restart the CSS animation
            el.classList.add('sync-pulse');
        };

        const NAMES = { a: '🐱 ChillCat', b: '🐶 HappyDog' };
        const chipEvent = chip.querySelector('.demo-chip-event');

        let eventTimer = null;
        const showEvent = (text) => {
            if (!chipEvent) return;
            chipEvent.textContent = text;
            chip.classList.add('event');
            clearTimeout(eventTimer);
            eventTimer = setTimeout(() => chip.classList.remove('event'), 1600);
        };

        // Core of the demo: play/pause on EITHER side is broadcast to the peer
        // tab — exactly what the extension does. The popup is just a remote
        // control on top, never a requirement.
        let broadcasting = false;
        const broadcast = (sourceKey, playing) => {
            if (broadcasting) return;
            broadcasting = true;
            const peerKey = sourceKey === 'a' ? 'b' : 'a';
            setPlaying(sourceKey, playing);
            showEvent((playing ? '▶ ' : '❚❚ ') + NAMES[sourceKey]);
            // the peer follows near-instantly — that is the whole point
            setTimeout(() => {
                tabs[peerKey].t = tabs[sourceKey].t;
                setPlaying(peerKey, playing);
                renderTab(tabs[peerKey]);
                pulse(peerKey);
                broadcasting = false;
            }, 90);
        };

        // Seeking works the same way: scrub one tab, the peer jumps along
        const seekTo = (sourceKey, fraction) => {
            if (broadcasting) return;
            broadcasting = true;
            const peerKey = sourceKey === 'a' ? 'b' : 'a';
            tabs[sourceKey].t = fraction * EP_LEN;
            renderTab(tabs[sourceKey]);
            showEvent('» ' + NAMES[sourceKey]);
            // visible "cut" so the jump reads as a real seek, not a silent update
            flashSeek(tabs[sourceKey].root);
            setTimeout(() => {
                tabs[peerKey].t = tabs[sourceKey].t;
                renderTab(tabs[peerKey]);
                flashSeek(tabs[peerKey].root);
                pulse(peerKey);
                broadcasting = false;
            }, 90);
        };

        // Restart the film animations mid-stride + trigger the sweep overlay
        let seekFlashTimers = [];
        const flashSeek = (root) => {
            if (!root) return;
            root.classList.remove('demo-seeking');
            // Restart every animated layer from frame zero so the jump is visible
            const film = root.querySelector('.demo-film');
            if (film) {
                film.classList.add('demo-reset');
                void film.offsetWidth; // force reflow so the browser commits the reset
                film.classList.remove('demo-reset');
            }
            void root.offsetWidth;
            root.classList.add('demo-seeking');
            const t = setTimeout(() => root.classList.remove('demo-seeking'), 360);
            seekFlashTimers.push(t);
        };

        const setPopupOpen = (open) => {
            scene.classList.toggle('popup-open', open);
            launcher.setAttribute('aria-expanded', open ? 'true' : 'false');
        };

        // Manual controls (the automated walkthrough drives these same handlers)
        launcher.addEventListener('click', () => setPopupOpen(!scene.classList.contains('popup-open')));

        // The popup remote control acts as 🐱 ChillCat (tab A's user)
        playBtn.addEventListener('click', () => {
            if (tabs.a.playing && tabs.b.playing) { pulse('b'); return; }
            broadcast('a', true);
        });
        pauseBtn.addEventListener('click', () => {
            if (!tabs.a.playing && !tabs.b.playing) { pulse('b'); return; }
            broadcast('a', false);
        });
        if (forceSyncBtn) forceSyncBtn.addEventListener('click', () => {
            tabs.b.t = tabs.a.t = Math.max(tabs.a.t, tabs.b.t);
            renderTab(tabs.a);
            renderTab(tabs.b);
            pulse('a');
            pulse('b');
        });

        ['a', 'b'].forEach(k => {
            const root = tabs[k].root;
            const toggle = () => broadcast(k, !tabs[k].playing);
            // the toolbar extension icon lives inside card A — its clicks
            // toggle the popup, not playback
            root.addEventListener('click', (e) => {
                if (e.target.closest('.demo-ext-launcher')) return;
                toggle();
            });
            root.addEventListener('keydown', (e) => {
                if (e.target.closest('.demo-ext-launcher')) return;
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggle();
                }
            });

            const progress = root.querySelector('.demo-progress');
            if (progress) {
                progress.addEventListener('click', (e) => {
                    e.stopPropagation(); // a scrub must not toggle play/pause
                    const r = progress.getBoundingClientRect();
                    seekTo(k, Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1));
                });
            }
        });

        chip.addEventListener('click', () => {
            pulse('a');
            pulse('b');
        });

        // --- Story state (room creation -> invite -> connected) ---
        const setRoomJoined = (joined) => {
            if (roomEmpty) roomEmpty.style.display = joined ? 'none' : 'flex';
            if (roomJoined) roomJoined.style.display = joined ? '' : 'none';
        };

        const setConnected = (connected) => {
            scene.classList.toggle('connected', connected);
            peerBs.forEach(el => { el.style.display = connected ? '' : 'none'; });
        };

        let toastTimer = null;
        const showToastB = (text) => {
            if (!toastB || !text) return;
            toastB.textContent = '✓ ' + text;
            toastB.classList.add('show');
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => toastB.classList.remove('show'), 1700);
        };

        // The invite link visibly travels from the popup to the friend's window
        const flyInvite = () => new Promise((resolve) => {
            if (!inviteFly || !inviteCopyBtn) { resolve(); return; }
            const from = inviteCopyBtn.getBoundingClientRect();
            const to = tabs.b.root.querySelector('.demo-tab-titlebar').getBoundingClientRect();
            const fromPoint = sceneLocalPoint(from, 0, 0);
            const toPoint = sceneLocalPoint(to, 0.5, 0);
            inviteFly.style.transition = 'none';
            inviteFly.style.left = fromPoint.x + 'px';
            inviteFly.style.top = fromPoint.y + 'px';
            inviteFly.style.opacity = '1';
            void inviteFly.offsetWidth;
            inviteFly.style.transition = '';
            inviteFly.style.left = (toPoint.x - 40) + 'px';
            inviteFly.style.top = (toPoint.y + 2) + 'px';
            setTimeout(() => {
                inviteFly.style.opacity = '0';
                resolve();
            }, 800);
        });

        const flashSelect = () => {
            if (!videoSelect) return;
            // Actually pick the Stranger Things tab so the placeholder reads as chosen
            if (videoSelect.options.length > 1) {
                videoSelect.selectedIndex = 1;
            }
            videoSelect.classList.remove('demo-attn');
            void videoSelect.offsetWidth;
            videoSelect.classList.add('demo-attn');
        };

        if (createRoomBtn) createRoomBtn.addEventListener('click', () => setRoomJoined(true));

        renderTab(tabs.a);
        renderTab(tabs.b);
        updateSyncUI();

        // JS is active: start with the popup tucked away and, if the scripted
        // story is going to run, rewind to the "before" state (no transitions
        // on load).
        scene.classList.add('demo-no-anim');
        if (!reduceMotion) {
            setPopupOpen(false);
            setConnected(false);
            setRoomJoined(false);
        }
        void scene.offsetWidth;
        scene.classList.remove('demo-no-anim');

        const showHint = () => {
            if (hint) hint.classList.add('show');
        };

        // Automated walkthrough; any interaction aborts it and jumps
        // straight to the finished end state, then the user's click applies.
        let userTookOver = false;
        let demoStarted = false;
        let demoFinished = false;
        let demoRunId = 0;

        const resetDemo = () => {
            demoStarted = false;
            demoFinished = false;
            userTookOver = false;
            demoRunId++;

            // Reset DOM states:
            scene.classList.add('demo-no-anim');
            setPopupOpen(false);
            setConnected(false);
            setRoomJoined(false);
            cursor.classList.remove('visible', 'clicking');
            scene.classList.remove('demo-complete', 'streaming');
            if (hint) hint.classList.remove('show');

            // Rewind tab playback times to START_T, paused:
            ['a', 'b'].forEach(k => {
                const tab = tabs[k];
                tab.t = START_T;
                setPlaying(k, false);
                renderTab(tab);
            });

            // Clear any sync-pulse or seeking classes:
            ['a', 'b'].forEach(k => {
                tabs[k].root.classList.remove('sync-pulse', 'demo-seeking');
            });

            // Clean up any pending flash timers:
            seekFlashTimers.forEach(clearTimeout);
            seekFlashTimers = [];

            // Force reflow and remove demo-no-anim:
            void scene.offsetWidth;
            scene.classList.remove('demo-no-anim');
        };
        const finishDemo = () => {
            if (demoFinished) return;
            demoFinished = true;
            setRoomJoined(true);
            setConnected(true);
            cursor.classList.remove('visible');
            scene.classList.add('demo-complete');
            showHint();
        };

        const takeOver = (e) => {
            userTookOver = true;
            finishDemo();
            // Clicks outside the popup (and not on its launcher icon) always collapse the popup
            if (e && e.target &&
                !e.target.closest('.extension-mockup') &&
                !e.target.closest('.demo-ext-launcher')) {
                setPopupOpen(false);
            }
        };
        scene.addEventListener('pointerdown', takeOver, true);
        scene.addEventListener('keydown', takeOver, true);

        // Clicking anywhere else on the page also closes the popup, like a
        // real browser extension popup would.
        document.addEventListener('pointerdown', (e) => {
            if (!scene.classList.contains('popup-open')) return;
            if (scene.contains(e.target)) return; // in-scene clicks are handled by takeOver
            userTookOver = true;
            finishDemo();
            setPopupOpen(false);
        }, true);

        // Explicit close button in the popup header
        const popupCloseBtn = scene.querySelector('#demo-popup-close');
        if (popupCloseBtn) {
            popupCloseBtn.addEventListener('click', () => {
                userTookOver = true;
                finishDemo();
                setPopupOpen(false);
            });
        }

        // Escape closes the popup as well
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (!scene.classList.contains('popup-open')) return;
            userTookOver = true;
            finishDemo();
            setPopupOpen(false);
        });

        const runDemo = async () => {
            if (demoStarted || userTookOver || reduceMotion) return;
            // Prevent inline demo animations from running on tablet/mobile if windows are hidden:
            if (window.innerWidth < 1024 && !scene.closest('.mobile-demo-stage')) {
                finishDemo();
                return;
            }
            demoRunId++;
            const myRunId = demoRunId;
            demoStarted = true;

            const wait = (ms) => new Promise(r => setTimeout(r, ms));
            const cursorHotspot = { x: 5, y: 2 };
            const moveTo = async (el, fx) => {
                if (demoRunId !== myRunId) return;
                const er = el.getBoundingClientRect();
                const point = sceneLocalPoint(er, fx, 0.5);
                cursor.style.left = (point.x - cursorHotspot.x) + 'px';
                cursor.style.top = (point.y - cursorHotspot.y) + 'px';
                await wait(700);
            };
            const step = async (el, pause, action, fx) => {
                if (userTookOver || demoRunId !== myRunId || !el) return false;
                await moveTo(el, fx);
                if (userTookOver || demoRunId !== myRunId) return false;
                cursor.classList.remove('clicking');
                void cursor.offsetWidth;
                cursor.classList.add('clicking');
                await wait(180);
                if (userTookOver || demoRunId !== myRunId) return false;
                if (action) action(); else el.click();
                await wait(320 + (pause || 0));
                return !userTookOver && demoRunId === myRunId;
            };

            await wait(500);
            if (userTookOver || demoRunId !== myRunId) return;
            cursor.classList.add('visible');
            await wait(400);
            if (userTookOver || demoRunId !== myRunId) return;

            const progressA = tabs.a.root.querySelector('.demo-progress');

            // Act 1: open the extension and create a room
            if (!await step(launcher, 300)) return;
            if (demoRunId !== myRunId) return;
            if (!await step(createRoomBtn, 500)) return;
            if (demoRunId !== myRunId) return;

            // Act 2: the invite link travels to the friend's browser
            if (!await step(inviteCopyBtn, 0)) return;
            if (demoRunId !== myRunId) return;
            await flyInvite();
            if (userTookOver || demoRunId !== myRunId) return;
            setConnected(true);
            showToastB(toastB ? toastB.dataset.joined : '');
            pulse('b');
            await wait(900);
            if (userTookOver || demoRunId !== myRunId) return;

            // Act 3: both sides pick the video tab to sync
            if (!await step(syncTabBtn, 250)) return;
            if (demoRunId !== myRunId) return;
            if (!await step(videoSelect, 150, flashSelect)) return;
            if (demoRunId !== myRunId) return;
            showToastB(toastB ? toastB.dataset.selected : '');
            await wait(700);
            if (userTookOver || demoRunId !== myRunId) return;

            // Act 4: play for everyone, then tuck the popup away
            if (!await step(playBtn, 1800)) return;
            if (demoRunId !== myRunId) return;
            if (!await step(launcher, 500)) return;
            if (demoRunId !== myRunId) return;

            // Act 5: any side can control — pause there, seek here, play again
            if (!await step(tabs.b.root, 1000)) return;
            if (demoRunId !== myRunId) return;
            if (!await step(progressA, 1300, () => seekTo('a', 0.62), 0.62)) return;
            if (demoRunId !== myRunId) return;
            if (!await step(tabs.a.root, 700)) return;
            if (demoRunId !== myRunId) return;

            finishDemo();
        };

        scene.__koalaStartDemo = reduceMotion ? finishDemo : runDemo;
        scene.__koalaFinishDemo = finishDemo;
        scene.__koalaResetDemo = resetDemo;

        if ('IntersectionObserver' in window && !reduceMotion) {
            const demoObserver = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        demoObserver.disconnect();
                        setTimeout(runDemo, 900);
                    }
                });
            }, { threshold: 0.45 });
            demoObserver.observe(scene);
        } else {
            finishDemo();
        }
    };

    initHeroDemo();

    const initMobileDemoModal = () => {
        const openBtn = document.getElementById('mobile-demo-open');
        const modal = document.getElementById('mobile-demo-modal');
        const stage = document.getElementById('mobile-demo-stage');
        const closeBtn = document.getElementById('mobile-demo-close');
        const wrapper = document.querySelector('.hero-grid > .hero-mockup-wrapper');
        if (!openBtn || !modal || !stage || !closeBtn || !wrapper) return;

        const originalParent = wrapper.parentNode;
        const originalNext = wrapper.nextSibling;
        let previousFocus = null;

        const openModal = () => {
            previousFocus = document.activeElement && typeof document.activeElement.focus === 'function'
                ? document.activeElement
                : null;
            modal.hidden = false;
            document.body.classList.add('mobile-demo-open');
            openBtn.setAttribute('aria-expanded', 'true');
            stage.appendChild(wrapper);
            requestAnimationFrame(() => {
                closeBtn.focus({ preventScroll: true });
                const scene = wrapper.querySelector('#hero-demo');
                if (scene) {
                    if (typeof scene.__koalaResetDemo === 'function') {
                        scene.__koalaResetDemo();
                    }
                    if (typeof scene.__koalaStartDemo === 'function') {
                        scene.__koalaStartDemo();
                    }
                }
            });
        };

        const closeModal = () => {
            if (modal.hidden) return;
            modal.hidden = true;
            document.body.classList.remove('mobile-demo-open');
            openBtn.setAttribute('aria-expanded', 'false');

            const scene = wrapper.querySelector('#hero-demo');
            if (scene && typeof scene.__koalaResetDemo === 'function') {
                scene.__koalaResetDemo();
            }
            if (originalNext && originalNext.parentNode === originalParent) {
                originalParent.insertBefore(wrapper, originalNext);
            } else {
                originalParent.appendChild(wrapper);
            }
            if (previousFocus && typeof previousFocus.focus === 'function') {
                previousFocus.focus({ preventScroll: true });
            }
        };

        openBtn.setAttribute('aria-expanded', 'false');
        openBtn.addEventListener('click', openModal);
        closeBtn.addEventListener('click', closeModal);
        modal.querySelectorAll('[data-mobile-demo-close]').forEach(el => {
            el.addEventListener('click', closeModal);
        });
        document.addEventListener('keydown', (e) => {
            if (modal.hidden) return;
            if (e.key === 'Escape') closeModal();
            if (e.key === 'Tab') {
                e.preventDefault();
                closeBtn.focus({ preventScroll: true });
            }
        });
    };

    initMobileDemoModal();

    // Terminal Tab Switcher
    const termTabBtns = document.querySelectorAll('.terminal-tab-btn');
    const termPanes = document.querySelectorAll('.terminal-pane');
    
    termTabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            termTabBtns.forEach(b => b.classList.remove('active'));
            termPanes.forEach(p => p.classList.remove('active'));
            
            btn.classList.add('active');
            const targetPaneId = btn.getAttribute('data-tab');
            const targetPane = document.getElementById(targetPaneId);
            if (targetPane) {
                targetPane.classList.add('active');
            }
        });
    });

    // Terminal Clipboard Copy
    const copyBtn = document.querySelector('.terminal-copy-btn');
    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            const activePane = document.querySelector('.terminal-pane.active');
            if (!activePane) return;
            const codeElement = activePane.querySelector('code');
            if (!codeElement) return;
            
            const textToCopy = codeElement.innerText || codeElement.textContent;
            
            navigator.clipboard.writeText(textToCopy).then(() => {
                const isDE = document.documentElement.classList.contains('lang-de');
                const originalHTML = copyBtn.innerHTML;
                
                copyBtn.innerHTML = isDE ? '✅ Kopiert!' : '✅ Copied!';
                copyBtn.disabled = true;
                
                setTimeout(() => {
                    copyBtn.innerHTML = originalHTML;
                    copyBtn.disabled = false;
                }, 2000);
            }).catch(err => {
                console.error('Failed to copy text: ', err);
            });
        });
    }

    // Mobile Hamburger Menu Toggle
    const hamburger = document.querySelector('.hamburger');
    const navLinks = document.querySelector('#primary-nav');
    if (hamburger && navLinks) {
        hamburger.setAttribute('aria-expanded', 'false');

        const open = () => {
            navLinks.classList.add('open');
            hamburger.setAttribute('aria-expanded', 'true');
            document.addEventListener('keydown', onEsc);
        };
        const close = () => {
            navLinks.classList.remove('open');
            hamburger.setAttribute('aria-expanded', 'false');
            document.removeEventListener('keydown', onEsc);
        };
        const toggle = () => navLinks.classList.contains('open') ? close() : open();
        const onEsc = (e) => { if (e.key === 'Escape') close(); };

        hamburger.addEventListener('click', toggle);
        navLinks.querySelectorAll('a').forEach(a => a.addEventListener('click', close));
    }

    // Dynamically localize home links on root dynamic pages (impressum, datenschutz, join)
    const localizeHomeLinks = () => {
        const activeLang = safeGetLocalStorage('koala_lang') || (navigator.language.startsWith('de') ? 'de' : 'en');
        const path = window.location.pathname;
        const pathSegments = path.split('/');
        const isSubdir = pathSegments.some(seg => ['de', 'fr', 'es', 'it', 'nl', 'pl', 'pt', 'pt-BR', 'tr', 'ru', 'ja', 'ko', 'zh', 'uk'].includes(seg));

        // Only need to do this dynamic rewrite if we are NOT already inside a localized subdirectory
        if (!isSubdir) {
            const homeLinks = document.querySelectorAll('a[href="./"], a[href="de/"], a[href="fr/"], a[href="es/"], a[href="it/"], a[href="nl/"], a[href="pl/"], a[href="pt/"], a[href="pt-BR/"], a[href="tr/"], a[href="ru/"], a[href="ja/"], a[href="ko/"], a[href="zh/"], a[href="uk/"]');
            homeLinks.forEach(link => {
                link.href = (activeLang === 'en') ? './' : `${activeLang}/`;
            });

            const altLinks = document.querySelectorAll('a[href*="alternatives"]');
            altLinks.forEach(link => {
                const attr = link.getAttribute('href');
                if (attr === 'alternatives' || attr.startsWith('alternatives/') || attr.endsWith('/alternatives')) {
                    link.href = (activeLang === 'en') ? attr : `${activeLang}/${attr}`;
                }
            });
        }
    };

    // Modern Language Selector Navigation and State Toggling
    const handleLanguageChange = (e) => {
        const select = e.currentTarget;
        const newLang = select.value;
        const path = window.location.pathname;
        
        // Save the user's preference
        safeSetLocalStorage('koala_lang', newLang);
        
        const isLegalImprint = path.includes('impressum') || path.includes('imprint');
        const isLegalPrivacy = path.includes('datenschutz') || path.includes('privacy');
        
        if (isLegalImprint) {
            let target;
            const hasHtml = path.endsWith('.html');
            if (newLang === 'de') {
                target = hasHtml ? 'de/impressum.html' : 'de/impressum';
                if (path.includes('/de/')) target = hasHtml ? 'impressum.html' : 'impressum';
            } else {
                target = hasHtml ? 'imprint.html' : 'imprint';
                if (path.includes('/de/')) target = hasHtml ? '../imprint.html' : '../imprint';
            }
            window.location.href = target + window.location.hash;
            return;
        } else if (isLegalPrivacy) {
            let target;
            const hasHtml = path.endsWith('.html');
            if (newLang === 'de') {
                target = hasHtml ? 'de/datenschutz.html' : 'de/datenschutz';
                if (path.includes('/de/')) target = hasHtml ? 'datenschutz.html' : 'datenschutz';
            } else {
                target = hasHtml ? 'privacy.html' : 'privacy';
                if (path.includes('/de/')) target = hasHtml ? '../privacy.html' : '../privacy';
            }
            window.location.href = target + window.location.hash;
            return;
        }
        
        const pathSegments = path.split('/');
        const isAlternative = pathSegments.includes('alternatives');
        if (isAlternative) {
            let target;
            const firstSeg = pathSegments[1];
            const isLangSubdir = ['de', 'fr', 'es', 'it', 'nl', 'pl', 'pt', 'pt-BR', 'tr', 'ru', 'ja', 'ko', 'zh', 'uk'].includes(firstSeg);
            
            if (newLang === 'en') {
                if (isLangSubdir) {
                    pathSegments.splice(1, 1);
                }
            } else {
                if (isLangSubdir) {
                    pathSegments[1] = newLang;
                } else {
                    pathSegments.splice(1, 0, newLang);
                }
            }
            target = pathSegments.join('/');
            window.location.href = target + window.location.hash;
            return;
        }
        
        // Determine if we are on a static landing page versus a dynamic utility page
        const isIndex = !path.includes('join');
        
        if (isIndex) {
            // Static navigation: Route to correct subdirectory
            const pathSegments = path.split('/');
            const isSubdir = pathSegments.some(seg => ['de', 'fr', 'es', 'it', 'nl', 'pl', 'pt', 'pt-BR', 'tr', 'ru', 'ja', 'ko', 'zh', 'uk'].includes(seg));
            
            let targetPath;
            if (newLang === 'en') {
                if (isSubdir) {
                    targetPath = '../';
                } else {
                    targetPath = './';
                }
            } else {
                if (isSubdir) {
                    // Switching from one language subdirectory to another (e.g., /de/ to /fr/)
                    targetPath = '../' + newLang + '/';
                } else {
                    // Switching from root (English) to a language subdirectory (e.g., / to /fr/)
                    targetPath = newLang + '/';
                }
            }
            
            window.location.href = targetPath + window.location.hash;
        } else {
            // Dynamic page: Toggle classes and update elements dynamically without navigating away
            const html = document.documentElement;
            html.classList.remove('lang-en', 'lang-de', 'lang-fr', 'lang-es', 'lang-it', 'lang-nl', 'lang-pl', 'lang-pt', 'lang-pt-br', 'lang-tr', 'lang-ru', 'lang-ja', 'lang-ko', 'lang-zh', 'lang-uk');
            
            // Fallback dynamic pages to 'en' if 'de' is not chosen (since fr/es markup is not present)
            const activeDisplayLang = (newLang === 'de') ? 'de' : 'en';
            html.classList.add('lang-' + activeDisplayLang);
            html.lang = activeDisplayLang;
            
            // Sync all selects on the page to the new value
            document.querySelectorAll('.lang-dropdown').forEach(sel => {
                sel.value = newLang;
            });
            
            // Update titles dynamically
            const isJoin = path.includes('join');
            if (isJoin) {
                const titles = { en: 'Join Room | KoalaSync', de: 'Raum beitreten | KoalaSync' };
                document.title = titles[activeDisplayLang] || titles.en;
            }
            
            // Localize home links dynamically
            localizeHomeLinks();
        }
    };
    
    // Dynamically adjust language select width to fit the selected option's text length
    const adjustDropdownWidth = () => {
        document.querySelectorAll('.lang-dropdown').forEach(select => {
            const tempSpan = document.createElement('span');
            const style = window.getComputedStyle(select);
            tempSpan.style.fontFamily = style.fontFamily;
            tempSpan.style.fontSize = style.fontSize;
            tempSpan.style.fontWeight = style.fontWeight;
            tempSpan.style.visibility = 'hidden';
            tempSpan.style.position = 'absolute';
            tempSpan.style.whiteSpace = 'nowrap';
            
            const activeOption = select.options[select.selectedIndex];
            if (activeOption) {
                tempSpan.textContent = activeOption.textContent;
                document.body.appendChild(tempSpan);
                const textWidth = tempSpan.getBoundingClientRect().width;
                select.style.width = (textWidth + 18) + 'px';
                document.body.removeChild(tempSpan);
            }
        });
    };

    // Register change event listener for the dropdowns
    document.querySelectorAll('.lang-dropdown').forEach(select => {
        select.addEventListener('change', (e) => {
            handleLanguageChange(e);
            adjustDropdownWidth();
        });
    });

    // Initialize language select elements to show the current preferred language
    const initLanguageSelectorValue = () => {
        const savedLang = safeGetLocalStorage('koala_lang');
        const browserLang = navigator.language.startsWith('de') ? 'de' : 'en';
        const activePref = savedLang || browserLang;
        
        document.querySelectorAll('.lang-dropdown').forEach(select => {
            select.value = activePref;
        });
        adjustDropdownWidth();
    };

    // Impressum Email Obfuscation Click Reveal
    document.querySelectorAll('.email-reveal').forEach(el => {
        el.addEventListener('click', function() {
            const user = this.getAttribute('data-user');
            const domain = this.getAttribute('data-domain');
            if (user && domain) {
                this.textContent = `${user}@${domain}`;
            }
        });
    });

    // Automated Store/Local Badge Linking based on User-Agent
    const detectBrowserAndElevateBadge = () => {
        const isFirefox = navigator.userAgent.includes('Firefox');
        const isChrome = navigator.userAgent.includes('Chrome') || navigator.userAgent.includes('Chromium');
        const chromeBtns = document.querySelectorAll('.btn-primary');
        const firefoxBtns = document.querySelectorAll('.btn-firefox');

        if (isFirefox && chromeBtns.length > 0 && firefoxBtns.length > 0) {
            // User is on Firefox: Elevate Firefox button to primary, make Chrome secondary
            chromeBtns.forEach(btn => {
                btn.classList.remove('btn-primary');
                btn.classList.add('btn-secondary');
            });
            
            firefoxBtns.forEach(btn => {
                // Put Firefox first in visual order
                btn.style.order = '-1';
                
                // Add subtle focus scale effect
                btn.style.transform = 'scale(1.05)';
                btn.addEventListener('mouseleave', () => {
                    btn.style.transform = 'scale(1)';
                });
                btn.addEventListener('mouseenter', () => {
                    btn.style.transform = 'scale(1.05) translateY(-2px)';
                });
            });
        } else if (isChrome && chromeBtns.length > 0 && firefoxBtns.length > 0) {
            // User is on Chrome: Make Firefox secondary
            firefoxBtns.forEach(btn => {
                btn.classList.remove('btn-firefox');
                btn.classList.add('btn-secondary', 'btn-firefox-secondary');
                btn.style.color = 'var(--text)';
                btn.style.background = 'var(--card)';
                btn.style.border = '1px solid var(--glass-border)';
                btn.style.boxShadow = 'none';
            });
        }

        // Handle Step 1 Landing Page Download Badges & Nav Badge
        setTimeout(() => {
            const isInstalled = document.documentElement.dataset.koalasyncInstalled === 'true';
            
            // Nav Badge Logic
            const navBadge = document.getElementById('nav-extension-status');
            if (isInstalled && navBadge) {
                navBadge.style.display = 'inline-flex';
            }

            const illusChrome = document.querySelectorAll('.illus-store-btn.chrome');
            const illusFirefox = document.querySelectorAll('.illus-store-btn.firefox');
            
            if (isFirefox && illusFirefox.length > 0) {
                illusFirefox.forEach(btn => {
                    btn.style.order = '-1';
                    if (!isInstalled) {
                        btn.classList.add('install-breathe');
                        btn.style.cursor = 'pointer';
                        btn.onclick = () => window.open('https://addons.mozilla.org/de/firefox/addon/koalasync/', '_blank', 'noopener');
                    }
                });
                illusChrome.forEach(btn => {
                    btn.style.opacity = '0.5';
                    btn.style.transform = 'scale(0.95)';
                });
            } else if (isChrome && illusChrome.length > 0) {
                illusChrome.forEach(btn => {
                    btn.style.order = '-1';
                    if (!isInstalled) {
                        btn.classList.add('install-breathe');
                        btn.style.cursor = 'pointer';
                        btn.onclick = () => window.open('https://chromewebstore.google.com/detail/koalasync/obbnmkmlaaddodakcbdljknjpagklifc', '_blank', 'noopener');
                    }
                });
                illusFirefox.forEach(btn => {
                    btn.style.opacity = '0.5';
                    btn.style.transform = 'scale(0.95)';
                });
            }

            // Pulse main hero CTA buttons via Web Animations API
            // (avoids CSS transition/inline-style conflicts from mouse handlers)
            if (!isInstalled) {
                const heroBtns = document.querySelectorAll(isFirefox ? '.btn-firefox' : (isChrome ? '.btn-primary' : null));
                if (heroBtns && heroBtns.length > 0) {
                    heroBtns.forEach(btn => {
                        const isFF = btn.classList.contains('btn-firefox');
                        const glowColor = isFF ? 'rgba(249, 115, 22, ' : 'rgba(99, 102, 241, ';
                        btn.animate([
                            { transform: 'scale(1)', boxShadow: `0 0 15px ${glowColor}0.2)` },
                            { transform: 'scale(1.05)', boxShadow: `0 0 25px ${glowColor}0.5)` },
                            { transform: 'scale(1)', boxShadow: `0 0 15px ${glowColor}0.2)` }
                        ], {
                            duration: 2500,
                            iterations: Infinity,
                            easing: 'ease-in-out'
                        });
                    });
                }
            }
        }, 600);
    };

    detectBrowserAndElevateBadge();
    checkInvite();
    updateDynamicVersion();
    localizeHomeLinks();
    initLanguageSelectorValue();
    // FAQ Accordion Transition (Web Animations API for smooth vertical spring height collapse/expand)
    try {
        document.querySelectorAll('.faq-item').forEach(details => {
            const summary = details.querySelector('summary');
            let isAnimating = false;

            summary.addEventListener('click', (e) => {
                e.preventDefault();
                if (isAnimating) return;

                const startHeight = details.offsetHeight;

                if (details.hasAttribute('open')) {
                    isAnimating = true;
                    const computed = window.getComputedStyle(details);
                    const padY = parseInt(computed.paddingTop) + parseInt(computed.paddingBottom);
                    const borderY = parseInt(computed.borderTopWidth) + parseInt(computed.borderBottomWidth);
                    const closedHeight = summary.offsetHeight + padY + (isNaN(borderY) ? 0 : borderY);

                    const animation = details.animate([
                        { height: startHeight + 'px' },
                        { height: closedHeight + 'px' }
                    ], {
                        duration: 250,
                        easing: 'cubic-bezier(0.16, 1, 0.3, 1)'
                    });

                    animation.onfinish = () => {
                        details.removeAttribute('open');
                        details.style.height = '';
                        isAnimating = false;
                    };
                } else {
                    isAnimating = true;
                    details.setAttribute('open', '');
                    const openHeight = details.offsetHeight;

                    const computed = window.getComputedStyle(details);
                    const padY = parseInt(computed.paddingTop) + parseInt(computed.paddingBottom);
                    const borderY = parseInt(computed.borderTopWidth) + parseInt(computed.borderBottomWidth);
                    const closedHeight = summary.offsetHeight + padY + (isNaN(borderY) ? 0 : borderY);

                    const animation = details.animate([
                        { height: closedHeight + 'px' },
                        { height: openHeight + 'px' }
                    ], {
                        duration: 250,
                        easing: 'cubic-bezier(0.16, 1, 0.3, 1)'
                    });

                    animation.onfinish = () => {
                        details.style.height = '';
                        isAnimating = false;
                    };
                }
            });
        });
    } catch (err) {
        console.warn(err);
    }
});
