// DriveTranslate PWA — main app logic
// Uses Web Speech API for EN speech-to-text, calls Cloudflare Worker for EN→HE translation.

const TRANSLATE_WORKER_URL = 'https://en-he-translator.dekel241.workers.dev';
const LOG_ENDPOINT = TRANSLATE_WORKER_URL + '/log';
const WARMUP_ENDPOINT = TRANSLATE_WORKER_URL + '/warmup';
const MAX_HISTORY = 12;
const CURRENT_WINDOW_SIZE = 3;  // max lines shown in the "current" card

// ============== Feature flags ==============
// SHOW_DEBUG_OVERLAY: show the on-screen debug box (the live event log overlay).
//   Turn OFF for normal use — it covers part of the translation.
// ENABLE_REPORTING: keep collecting log entries in memory AND show the
//   "Send Report" button, so the user can send a diagnostic report to Discord
//   even when the on-screen overlay is hidden.
const SHOW_DEBUG_OVERLAY = false;
const ENABLE_REPORTING = true;
const DEBUG_BUFFER_SIZE = 200;  // entries kept for "Send Report"

// ============== State ==============
let recognition = null;
let isListening = false;
let isStoppingIntentionally = false;
// Sliding window of recent FINALIZED segments (oldest first, newest last).
// Each element is an object { english, hebrew } so async translation can update
// the correct entry by reference even if it's already been rendered or evicted.
let windowSegments = [];
// The live in-progress line (what is being heard right now). Rendered as the
// green bottom line, SEPARATE from the finalized window so it never hides the
// most recent finalized line.
let interimEnglish = '';
let interimHebrew = '';
let historySegments = [];  // {english, hebrew}
const translationCache = new Map();

// ============== DOM ==============
const els = {
    status: document.getElementById('status'),
    btnToggle: document.getElementById('btn-toggle'),
    btnClear: document.getElementById('btn-clear'),
    currentEnglish: document.getElementById('current-english'),
    currentHebrew: document.getElementById('current-hebrew'),
    historyEnglish: document.getElementById('history-english'),
    historyHebrew: document.getElementById('history-hebrew'),
    tabs: document.querySelectorAll('.tab'),
    tabContents: document.querySelectorAll('.tab-content'),
    debugBox: document.getElementById('debug-box'),
    btnSendReport: document.getElementById('btn-send-report'),
    main: document.querySelector('main'),
};

// ============== Smart auto-scroll ==============
// Keep the newest translation line in view as new lines arrive, BUT only when
// the user hasn't scrolled away. If the user scrolls up (to re-read something),
// auto-scroll pauses so we don't "fight" them. It resumes automatically once
// the newest line is back in view.
let autoScrollEnabled = true;
let programmaticScroll = false;  // ignore scroll events we cause ourselves

// Is the newest current-line at least partially visible within <main>'s viewport?
function isNewestLineVisible() {
    const activeTab = document.querySelector('.tab-content.active');
    if (!activeTab || !els.main) return true;
    const lines = activeTab.querySelectorAll('.current-line');
    const newest = lines[lines.length - 1];
    if (!newest) return true;
    const mainRect = els.main.getBoundingClientRect();
    const lineRect = newest.getBoundingClientRect();
    // Any vertical overlap between the line and the viewport counts as visible.
    return lineRect.top < mainRect.bottom && lineRect.bottom > mainRect.top;
}

function maybeAutoScroll() {
    if (!autoScrollEnabled || !els.main) return;
    const activeTab = document.querySelector('.tab-content.active');
    if (!activeTab) return;
    const lines = activeTab.querySelectorAll('.current-line');
    const newest = lines[lines.length - 1];
    if (newest) {
        programmaticScroll = true;
        newest.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        setTimeout(() => { programmaticScroll = false; }, 400);
    }
}

if (els.main) {
    els.main.addEventListener('scroll', () => {
        if (programmaticScroll) return;  // ignore our own scrolling
        // A manual scroll: resume auto-scroll only if the newest line is visible.
        autoScrollEnabled = isNewestLineVisible();
    });
}

// ============== Feature flag: show/hide debug UI ==============
// The on-screen overlay is controlled by SHOW_DEBUG_OVERLAY.
// The Send Report button is controlled by ENABLE_REPORTING.
if (!SHOW_DEBUG_OVERLAY) {
    if (els.debugBox) els.debugBox.style.display = 'none';
}
if (ENABLE_REPORTING) {
    if (els.btnSendReport) {
        els.btnSendReport.addEventListener('click', sendDebugReport);
    }
} else {
    if (els.btnSendReport) els.btnSendReport.style.display = 'none';
}

// ============== Debug helper ==============
// Collects log entries into a rolling buffer whenever reporting OR the overlay
// is enabled. Renders the last few lines into the overlay only when it's shown.
const debugBuffer = [];      // full history for reports
const ON_SCREEN_LINES = 8;
function dbg(msg) {
    // Skip all work only if both the overlay and reporting are off.
    if (!SHOW_DEBUG_OVERLAY && !ENABLE_REPORTING) return;
    const t = new Date().toLocaleTimeString('he-IL', { hour12: false });
    const line = `[${t}] ${msg}`;
    debugBuffer.push(line);
    if (debugBuffer.length > DEBUG_BUFFER_SIZE) debugBuffer.shift();
    if (SHOW_DEBUG_OVERLAY && els.debugBox) {
        const tail = debugBuffer.slice(-ON_SCREEN_LINES).join('\n');
        els.debugBox.textContent = tail;
    }
    console.log(msg);
}

async function sendDebugReport() {
    if (!debugBuffer.length && windowSegments.length === 0 && historySegments.length === 0) {
        if (els.btnSendReport) {
            els.btnSendReport.textContent = '∅';
            setTimeout(() => { els.btnSendReport.textContent = '📤'; }, 1500);
        }
        return;
    }
    const originalText = '📤';
    if (els.btnSendReport) {
        els.btnSendReport.disabled = true;
        els.btnSendReport.textContent = '⏳ Sending...';
    }
    const userAgent = navigator.userAgent;
    const version = document.querySelector('.version')?.textContent || 'unknown';

    // Snapshot of what the user currently sees on screen.
    const windowSnapshot = windowSegments.map((s, i) => {
        return `  [${i}] EN: ${s.english}\n      HE: ${s.hebrew}`;
    }).join('\n');
    const interimSnapshot = interimEnglish
        ? `  [interim] EN: ${interimEnglish}\n            HE: ${interimHebrew || '...'}`
        : '  (no interim)';
    const historySnapshot = historySegments.map((s, i) =>
        `  [${i}] EN: ${s.english}\n      HE: ${s.hebrew}`
    ).join('\n');

    const header = `=== Report ${new Date().toISOString()} ===\nVersion: ${version}\nUA: ${userAgent}\n`;
    const part1 = `--- EVENT LOG (${debugBuffer.length} entries) ---\n${debugBuffer.join('\n') || '(empty)'}\n`;
    const part2 = `--- CURRENT WINDOW (${windowSegments.length}/${CURRENT_WINDOW_SIZE}) ---\n${windowSnapshot || '(empty)'}\n${interimSnapshot}\n`;
    const part3 = `--- HISTORY (${historySegments.length}) ---\n${historySnapshot || '(empty)'}\n`;
    const fullMessage = header + part1 + part2 + part3;

    try {
        const resp = await fetch(LOG_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: fullMessage }),
        });
        if (resp.ok) {
            dbg('REPORT SENT ✓');
            if (els.btnSendReport) {
                els.btnSendReport.textContent = '✓ Sent';
                els.btnSendReport.style.background = '#0f9';
                els.btnSendReport.style.color = '#0a0a1a';
            }
        } else {
            dbg('REPORT FAIL ' + resp.status);
            if (els.btnSendReport) {
                els.btnSendReport.textContent = '✗ Failed ' + resp.status;
                els.btnSendReport.style.background = '#a33';
                els.btnSendReport.style.color = '#fff';
            }
        }
    } catch (e) {
        dbg('REPORT ERROR ' + e.message);
        if (els.btnSendReport) {
            els.btnSendReport.textContent = '✗ Error';
            els.btnSendReport.style.background = '#a33';
            els.btnSendReport.style.color = '#fff';
        }
    } finally {
        if (els.btnSendReport) {
            setTimeout(() => {
                els.btnSendReport.textContent = originalText;
                els.btnSendReport.style.background = '';
                els.btnSendReport.style.color = '';
                els.btnSendReport.disabled = false;
            }, 2000);
        }
    }
}

// ============== Tab switching ==============
els.tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        const target = tab.dataset.tab;
        els.tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === target));
        els.tabContents.forEach(c => c.classList.toggle('active', c.id === `tab-${target}`));
    });
});

// ============== Status ==============
function setStatus(text, kind = '') {
    els.status.textContent = text;
    els.status.className = 'status ' + kind;
}

// ============== Speech Recognition ==============
function initRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        setStatus('Speech recognition not supported in this browser', 'error');
        els.btnToggle.disabled = true;
        return false;
    }

    recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onstart = () => {
        isListening = true;
        isStoppingIntentionally = false;
        dbg('LIFE: onstart');
        setStatus('Listening...', 'listening');
        els.btnToggle.textContent = 'Stop';
        els.btnToggle.classList.add('listening');
    };

    recognition.onresult = (event) => {
        let interimText = '';
        let finalText = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                finalText += transcript;
            } else {
                interimText += transcript;
            }
        }

        // Show interim live in the bottom slot and translate it (debounced).
        const trimmedInterim = interimText.trim();
        if (trimmedInterim) {
            interimEnglish = trimmedInterim;
            renderCurrent();
            scheduleInterimTranslation(trimmedInterim);
        }

        // When the browser finalizes a segment, commit it to the sliding window.
        // We rely purely on the browser's own isFinal — no forced restart, so the
        // microphone never stops and no audio is lost.
        if (finalText.trim()) {
            const segment = finalText.trim();
            dbg(`FINAL: "${segment.slice(0, 30)}"`);
            cancelInterimTranslation();
            handleFinalSegment(segment);
        }
    };

    // Lifecycle events used only for diagnostic logging (no behavior change).
    recognition.onaudiostart  = () => dbg('LIFE: onaudiostart');
    recognition.onaudioend    = () => dbg('LIFE: onaudioend');
    recognition.onsoundstart  = () => dbg('LIFE: onsoundstart');
    recognition.onsoundend    = () => dbg('LIFE: onsoundend');
    recognition.onspeechstart = () => dbg('LIFE: onspeechstart');
    recognition.onspeechend   = () => dbg('LIFE: onspeechend');
    recognition.onnomatch     = () => dbg('LIFE: onnomatch');

    recognition.onerror = (event) => {
        console.error('Recognition error:', event.error);
        dbg(`LIFE: onerror ${event.error}`);
        if (event.error === 'no-speech') {
            // Common, ignore — recognition will auto-restart via onend
            return;
        }
        setStatus(`Error: ${event.error}`, 'error');
    };

    recognition.onend = () => {
        isListening = false;
        dbg(`LIFE: onend (intentional=${isStoppingIntentionally})`);
        // Safari auto-stops recognition after a while. Auto-restart unless user pressed Stop.
        if (!isStoppingIntentionally) {
            try {
                recognition.start();
            } catch (e) {
                dbg(`LIFE: restart failed ${e.message}`);
                setStatus('Stopped', 'idle');
                els.btnToggle.textContent = 'Start';
                els.btnToggle.classList.remove('listening');
            }
        } else {
            setStatus('Stopped', 'idle');
            els.btnToggle.textContent = 'Start';
            els.btnToggle.classList.remove('listening');
        }
    };

    return true;
}

// ============== Translation ==============
async function translate(englishText) {
    if (translationCache.has(englishText)) {
        return translationCache.get(englishText);
    }

    try {
        const resp = await fetch(TRANSLATE_WORKER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: englishText }),
        });

        if (!resp.ok) {
            const err = await resp.text();
            throw new Error(`HTTP ${resp.status}: ${err}`);
        }

        const data = await resp.json();
        const hebrew = data.translatedText;
        translationCache.set(englishText, hebrew);
        return hebrew;
    } catch (err) {
        console.error('Translation error:', err);
        throw err;
    }
}

// ============== Debounced interim translation ==============
const INTERIM_DEBOUNCE_MS = 300;
let interimTimer = null;
let lastInterimRequest = '';
let interimRequestId = 0;

function scheduleInterimTranslation(text) {
    cancelInterimTranslation();
    interimTimer = setTimeout(() => {
        const trimmed = text.trim();
        if (!trimmed || trimmed === lastInterimRequest) return;
        lastInterimRequest = trimmed;

        const myId = ++interimRequestId;
        translate(trimmed)
            .then(hebrew => {
                if (myId === interimRequestId) {
                    interimHebrew = hebrew;
                    renderCurrent();
                }
            })
            .catch(() => { /* ignore interim errors silently */ });
    }, INTERIM_DEBOUNCE_MS);
}

function cancelInterimTranslation() {
    if (interimTimer) {
        clearTimeout(interimTimer);
        interimTimer = null;
    }
}

// ============== Handle a finalized speech segment ==============
async function handleFinalSegment(englishSegment) {
    // Create the segment object and push it into the window IMMEDIATELY, in
    // arrival order, with a placeholder Hebrew. Keeping a reference means the
    // async translation below updates THIS exact line — even if it's already
    // rendered, or later evicted into history, or if translations complete
    // out of order relative to other segments.
    const seg = { english: englishSegment, hebrew: '…' };
    windowSegments.push(seg);
    dbg(`PUSH win=${windowSegments.length} hist=${historySegments.length}`);

    // Evict oldest to history if the window is over capacity.
    while (windowSegments.length > CURRENT_WINDOW_SIZE) {
        const evicted = windowSegments.shift();
        historySegments.unshift(evicted);
        if (historySegments.length > MAX_HISTORY) {
            historySegments = historySegments.slice(0, MAX_HISTORY);
        }
        dbg(`EVICT to hist. win=${windowSegments.length} hist=${historySegments.length}`);
    }

    // The just-finalized text is no longer "in progress" — clear the interim
    // line so the green line reflects only genuinely live speech.
    interimEnglish = '';
    interimHebrew = '';

    renderCurrent();
    renderHistory();

    // Translate asynchronously and update this segment by reference.
    try {
        const hebrew = await translate(englishSegment);
        seg.hebrew = hebrew;
    } catch (err) {
        seg.hebrew = '[translation error]';
    }
    renderCurrent();
    renderHistory();
}

// ============== Render current view ==============
// Layout (top → bottom):
//   [ up to CURRENT_WINDOW_SIZE finalized lines, oldest → newest ]
//   [ live interim line, highlighted green ]  ← only if speech is in progress
// The interim line is ALWAYS separate from the finalized lines, so the most
// recent finalized line is never hidden.
function renderCurrent() {
    const enLines = windowSegments.map(s => ({ text: s.english, live: false }));
    const heLines = windowSegments.map(s => ({ text: s.hebrew, live: false }));

    if (interimEnglish) {
        enLines.push({ text: interimEnglish, live: true });
        heLines.push({ text: interimHebrew || '…', live: true });
    }

    if (enLines.length === 0) {
        els.currentEnglish.textContent = 'Start listening to see the live transcript';
        els.currentHebrew.textContent = 'התחל האזנה כדי לראות תרגום חי';
        return;
    }

    const renderLines = (arr) => arr
        .map(l => `<div class="current-line${l.live ? ' live' : ''}">${escapeHtml(l.text)}</div>`)
        .join('');

    els.currentEnglish.innerHTML = renderLines(enLines);
    els.currentHebrew.innerHTML = renderLines(heLines);

    maybeAutoScroll();
}

// ============== Render history ==============
function renderHistory() {
    els.historyHebrew.innerHTML = historySegments
        .map(s => `<div class="history-item rtl" dir="rtl">${escapeHtml(s.hebrew)}</div>`)
        .join('');
    els.historyEnglish.innerHTML = historySegments
        .map(s => `<div class="history-item">${escapeHtml(s.english)}</div>`)
        .join('');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============== Sound effects (Web Audio API) ==============
let audioCtx = null;
function getAudioCtx() {
    if (!audioCtx) {
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) { return null; }
    }
    // Some browsers require user-gesture to resume the context
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
}

function playTone(freq, duration, startOffset = 0, type = 'sine', volume = 0.15) {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const t0 = ctx.currentTime + startOffset;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(volume, t0 + 0.01);
    gain.gain.linearRampToValueAtTime(0, t0 + duration);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
}

function playStartSound() {
    // Pleasant rising chirp: A4 → E5 (two short tones going up)
    playTone(440, 0.08, 0);
    playTone(659.25, 0.12, 0.08);
}

function playStopSound() {
    // Descending soft thunk: E5 → A4 → low (going down)
    playTone(659.25, 0.08, 0);
    playTone(440, 0.10, 0.08);
    playTone(293.66, 0.14, 0.18);
}

// ============== Controls ==============
els.btnToggle.addEventListener('click', async () => {
    if (!recognition && !initRecognition()) return;

    if (isListening) {
        // Stop
        playStopSound();
        isStoppingIntentionally = true;
        cancelInterimTranslation();
        recognition.stop();
    } else {
        // Start
        playStartSound();
        try {
            setStatus('Preparing...', 'preparing');
            recognition.start();
        } catch (err) {
            setStatus(`Failed to start: ${err.message}`, 'error');
        }
    }
});

els.btnClear.addEventListener('click', () => {
    historySegments = [];
    windowSegments = [];
    interimEnglish = '';
    interimHebrew = '';
    renderCurrent();
    renderHistory();
});

// ============== Initialize ==============
initRecognition();

// Pre-warm the connection to the Cloudflare Worker so the first real
// translation request doesn't pay the full TLS handshake + DNS lookup cost.
// Fires immediately on page load. Safe: /warmup returns instantly without
// calling the Google API, no cost, no rate limit concerns.
(function preWarmWorker() {
    try {
        fetch(WARMUP_ENDPOINT, { method: 'GET', keepalive: true })
            .then(() => dbg('WARMUP: ok'))
            .catch((e) => dbg('WARMUP: failed ' + e.message));
    } catch (e) { /* no-op */ }
})();

// Register service worker for PWA offline shell
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(err => {
        console.log('Service worker registration failed:', err);
    });
}

// Keep screen awake while listening (where supported)
let wakeLock = null;
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
        }
    } catch (e) { /* no-op */ }
}
function releaseWakeLock() {
    if (wakeLock) { wakeLock.release(); wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isListening) requestWakeLock();
});
els.btnToggle.addEventListener('click', () => {
    if (isListening) releaseWakeLock();
    else requestWakeLock();
});
