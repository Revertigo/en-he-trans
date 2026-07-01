// DriveTranslate PWA — main app logic
// Uses Web Speech API for EN speech-to-text, calls Cloudflare Worker for EN→HE translation.

const TRANSLATE_WORKER_URL = 'https://en-he-translator.dekel241.workers.dev';
const LOG_ENDPOINT = TRANSLATE_WORKER_URL + '/log';
const MAX_HISTORY = 12;
const CURRENT_WINDOW_SIZE = 3;  // max lines shown in the "current" card

// Force-finalize logic: some browsers (e.g., Chrome iOS) rarely emit `isFinal`,
// causing interim text to grow forever. We synthesize finalization ourselves.
const FORCE_FINALIZE_STABLE_MS = 3000;  // finalize if interim hasn't changed for this long
const FORCE_FINALIZE_MAX_WORDS = 5;     // or if interim has at least this many words

// Zombie-detection watchdog: after the recognizer starts, we expect SOME activity
// (onresult, onspeechstart, or onspeechend) within this window. If not, the
// recognizer likely entered a silent-stall state — we log it (no auto-recovery yet).
const ZOMBIE_WATCHDOG_MS = 4000;

// ============== Feature flags ==============
// Toggle this true/false to show/hide the on-screen debug overlay.
// When false, dbg() becomes a no-op (no performance impact).
const DEBUG_MODE = true;
const DEBUG_BUFFER_SIZE = 200;  // entries kept for "Send Report"

// ============== State ==============
let recognition = null;
let isListening = false;
let isStoppingIntentionally = false;
// Sliding window of recent finalized sentences (oldest first, newest last).
// englishWindow[i] corresponds to hebrewWindow[i].
let englishWindow = [];
let hebrewWindow = [];
// Interim (in-progress) sentence — shown as the bottom line, gets replaced when finalized.
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
};

// ============== Feature flag: show/hide debug UI ==============
if (!DEBUG_MODE) {
    if (els.debugBox) els.debugBox.style.display = 'none';
    if (els.btnSendReport) els.btnSendReport.style.display = 'none';
} else {
    if (els.btnSendReport) {
        els.btnSendReport.addEventListener('click', sendDebugReport);
    }
}

// ============== Debug helper ==============
// Maintains a rolling buffer for "Send Report". Only renders the last few lines
// in the on-screen overlay (when DEBUG_MODE is true).
const debugBuffer = [];      // full history for reports
const ON_SCREEN_LINES = 8;
function dbg(msg) {
    if (!DEBUG_MODE) return;
    const t = new Date().toLocaleTimeString('he-IL', { hour12: false });
    const line = `[${t}] ${msg}`;
    debugBuffer.push(line);
    if (debugBuffer.length > DEBUG_BUFFER_SIZE) debugBuffer.shift();
    if (els.debugBox) {
        const tail = debugBuffer.slice(-ON_SCREEN_LINES).join('\n');
        els.debugBox.textContent = tail;
    }
    console.log(msg);
}

async function sendDebugReport() {
    if (!debugBuffer.length && englishWindow.length === 0 && historySegments.length === 0) {
        if (els.btnSendReport) {
            els.btnSendReport.textContent = '(empty)';
            setTimeout(() => { els.btnSendReport.textContent = '📤 Send Report'; }, 1500);
        }
        return;
    }
    const originalText = '📤 Send Report';
    if (els.btnSendReport) {
        els.btnSendReport.disabled = true;
        els.btnSendReport.textContent = '⏳ Sending...';
    }
    const userAgent = navigator.userAgent;
    const version = document.querySelector('.version')?.textContent || 'unknown';

    // Snapshot of what the user currently sees on screen.
    const windowSnapshot = englishWindow.map((en, i) => {
        const he = hebrewWindow[i] || '';
        return `  [${i}] EN: ${en}\n      HE: ${he}`;
    }).join('\n');
    const interimSnapshot = interimEnglish
        ? `  [interim] EN: ${interimEnglish}\n            HE: ${interimHebrew || '...'}`
        : '  (no interim)';
    const historySnapshot = historySegments.map((s, i) =>
        `  [${i}] EN: ${s.english}\n      HE: ${s.hebrew}`
    ).join('\n');

    const header = `=== Report ${new Date().toISOString()} ===\nVersion: ${version}\nUA: ${userAgent}\n`;
    const part1 = `--- EVENT LOG (${debugBuffer.length} entries) ---\n${debugBuffer.join('\n') || '(empty)'}\n`;
    const part2 = `--- CURRENT WINDOW (${englishWindow.length}/${CURRENT_WINDOW_SIZE}) ---\n${windowSnapshot || '(empty)'}\n${interimSnapshot}\n`;
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
        restartingForFinalize = false;
        dbg('LIFE: onstart');
        armZombieWatchdog('onstart');
        setStatus('Listening...', 'listening');
        els.btnToggle.textContent = 'Stop';
        els.btnToggle.classList.add('listening');
    };

    recognition.onresult = (event) => {
        // Any result event is a heartbeat — the recognizer is alive.
        armZombieWatchdog('onresult');

        // Ignore any results that arrive while we're in the middle of a restart.
        // (Otherwise multiple onresult events fire back-to-back with the same
        // interim transcript, each triggering its own FORCE-FIN.)
        if (restartingForFinalize) return;

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

        const trimmedInterim = interimText.trim();

        if (trimmedInterim) {
            interimEnglish = trimmedInterim;
            renderCurrent();
            scheduleInterimTranslation(trimmedInterim);

            // Once interim crosses N words, emit EXACTLY N words as a finalized line.
            // Then restart the recognizer so the leftover words come back as fresh interim.
            const words = trimmedInterim.split(/\s+/).filter(Boolean);
            if (words.length >= FORCE_FINALIZE_MAX_WORDS) {
                const chunk = words.slice(0, FORCE_FINALIZE_MAX_WORDS).join(' ');
                dbg(`FORCE-FIN (words=${words.length}, emit=${FORCE_FINALIZE_MAX_WORDS}) → restart`);
                cancelInterimTranslation();
                cancelStabilityTimer();
                handleFinalSegment(chunk);
                restartRecognition();
            } else {
                scheduleStabilityFinalize(trimmedInterim);
            }
        }

        if (finalText.trim()) {
            const segment = finalText.trim();
            dbg(`FINAL: "${segment.slice(0, 30)}"`);
            cancelInterimTranslation();
            cancelStabilityTimer();
            handleFinalSegment(segment);
        }
    };

    // Lifecycle events used only for diagnostic logging (no behavior change).
    recognition.onaudiostart  = () => { dbg('LIFE: onaudiostart'); armZombieWatchdog('onaudiostart'); };
    recognition.onaudioend    = () => dbg('LIFE: onaudioend');
    recognition.onsoundstart  = () => { dbg('LIFE: onsoundstart'); armZombieWatchdog('onsoundstart'); };
    recognition.onsoundend    = () => dbg('LIFE: onsoundend');
    recognition.onspeechstart = () => { dbg('LIFE: onspeechstart'); armZombieWatchdog('onspeechstart'); };
    recognition.onspeechend   = () => { dbg('LIFE: onspeechend'); armZombieWatchdog('onspeechend'); };
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
        cancelZombieWatchdog();
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

// ============== Stability-based force finalization ==============
let stabilityTimer = null;
function scheduleStabilityFinalize(text) {
    cancelStabilityTimer();
    stabilityTimer = setTimeout(() => {
        if (text && interimEnglish === text) {
            dbg(`FORCE-FIN (stable ${FORCE_FINALIZE_STABLE_MS}ms) → restart`);
            cancelInterimTranslation();
            handleFinalSegment(text);
            restartRecognition();
        }
    }, FORCE_FINALIZE_STABLE_MS);
}
function cancelStabilityTimer() {
    if (stabilityTimer) {
        clearTimeout(stabilityTimer);
        stabilityTimer = null;
    }
}

// ============== Zombie-recognizer watchdog ==============
let zombieTimer = null;
function armZombieWatchdog(reason) {
    cancelZombieWatchdog();
    zombieTimer = setTimeout(() => {
        if (isListening) {
            dbg(`ZOMBIE? no activity in ${ZOMBIE_WATCHDOG_MS}ms after ${reason}`);
        }
    }, ZOMBIE_WATCHDOG_MS);
}
function cancelZombieWatchdog() {
    if (zombieTimer) {
        clearTimeout(zombieTimer);
        zombieTimer = null;
    }
}

// Stops the recognizer and lets onend auto-restart it. This clears the
// recognizer's internal interim transcript so we don't have to track
// consumed prefixes ourselves.
let restartingForFinalize = false;
function restartRecognition() {
    if (!recognition || !isListening || restartingForFinalize) return;
    restartingForFinalize = true;
    try {
        recognition.stop();
    } catch (e) { /* ignore */ }
    // restartingForFinalize will be cleared on next onstart
}

// ============== Handle a finalized speech segment ==============
async function handleFinalSegment(englishSegment) {
    // Show the new sentence in the bottom slot as interim with a "translating" placeholder.
    interimEnglish = englishSegment;
    interimHebrew = '...';
    renderCurrent();

    try {
        const hebrew = await translate(englishSegment);

        // Append the finalized pair to the sliding window
        englishWindow.push(englishSegment);
        hebrewWindow.push(hebrew);
        dbg(`PUSH win=${englishWindow.length} hist=${historySegments.length}`);

        // If window exceeded capacity, push oldest into history
        while (englishWindow.length > CURRENT_WINDOW_SIZE) {
            const evictedEn = englishWindow.shift();
            const evictedHe = hebrewWindow.shift();
            historySegments.unshift({ english: evictedEn, hebrew: evictedHe });
            if (historySegments.length > MAX_HISTORY) {
                historySegments = historySegments.slice(0, MAX_HISTORY);
            }
            dbg(`EVICT to hist. win=${englishWindow.length} hist=${historySegments.length}`);
        }

        // Clear interim — the sentence is now in the window
        interimEnglish = '';
        interimHebrew = '';

        renderCurrent();
        renderHistory();
    } catch (err) {
        interimHebrew = '[Translation error]';
        renderCurrent();
        setStatus(`Translation failed: ${err.message}`, 'error');
        setTimeout(() => {
            if (isListening) setStatus('Listening...', 'listening');
        }, 3000);
    }
}

// ============== Render current (sliding window of up to 3 lines) ==============
function renderCurrent() {
    const englishLines = [...englishWindow];
    const hebrewLines = [...hebrewWindow];

    if (interimEnglish) {
        // Option Y: interim replaces the bottom slot (max 3 visible lines).
        if (englishLines.length >= CURRENT_WINDOW_SIZE) {
            englishLines[CURRENT_WINDOW_SIZE - 1] = interimEnglish;
            hebrewLines[CURRENT_WINDOW_SIZE - 1] = interimHebrew || '...';
        } else {
            englishLines.push(interimEnglish);
            hebrewLines.push(interimHebrew || '...');
        }
    }

    if (englishLines.length === 0) {
        els.currentEnglish.textContent = 'Start listening to see the live transcript';
        els.currentHebrew.textContent = 'התחל האזנה כדי לראות תרגום חי';
        return;
    }

    els.currentEnglish.innerHTML = englishLines
        .map(line => `<div class="current-line">${escapeHtml(line)}</div>`)
        .join('');
    els.currentHebrew.innerHTML = hebrewLines
        .map(line => `<div class="current-line">${escapeHtml(line)}</div>`)
        .join('');
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
        cancelStabilityTimer();
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
    englishWindow = [];
    hebrewWindow = [];
    interimEnglish = '';
    interimHebrew = '';
    renderCurrent();
    renderHistory();
});

// ============== Initialize ==============
initRecognition();

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
