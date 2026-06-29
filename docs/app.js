// DriveTranslate PWA — main app logic
// Uses Web Speech API for EN speech-to-text, calls Cloudflare Worker for EN→HE translation.

const TRANSLATE_WORKER_URL = 'https://en-he-translator.dekel241.workers.dev';
const MAX_HISTORY = 12;

// ============== State ==============
let recognition = null;
let isListening = false;
let isStoppingIntentionally = false;
let currentEnglishText = '';
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
};

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

        // Show interim text live in English tab + translate it (debounced)
        if (interimText) {
            currentEnglishText = interimText;
            els.currentEnglish.textContent = interimText;
            scheduleInterimTranslation(interimText);
        }

        // When we get a finalized segment, translate it
        if (finalText.trim()) {
            const segment = finalText.trim();
            els.currentEnglish.textContent = segment;
            // Cancel any pending interim translation since we have the final
            cancelInterimTranslation();
            handleFinalSegment(segment);
        }
    };

    recognition.onerror = (event) => {
        console.error('Recognition error:', event.error);
        if (event.error === 'no-speech') {
            // Common, ignore — recognition will auto-restart via onend
            return;
        }
        setStatus(`Error: ${event.error}`, 'error');
    };

    recognition.onend = () => {
        isListening = false;
        // Safari auto-stops recognition after a while. Auto-restart unless user pressed Stop.
        if (!isStoppingIntentionally) {
            try {
                recognition.start();
            } catch (e) {
                // Already running or other error
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
const MIN_GROWTH_CHARS = 3;  // skip translation if text grew by less than N chars
let interimTimer = null;
let lastInterimRequest = '';
let interimRequestId = 0;

function scheduleInterimTranslation(text) {
    cancelInterimTranslation();
    interimTimer = setTimeout(() => {
        const trimmed = text.trim();
        if (!trimmed) return;

        // Skip if identical to last request
        if (trimmed === lastInterimRequest) return;

        // Skip if text didn't grow enough (avoid wasteful per-character requests)
        const growth = trimmed.length - lastInterimRequest.length;
        if (growth > 0 && growth < MIN_GROWTH_CHARS && trimmed.startsWith(lastInterimRequest)) {
            return;
        }

        lastInterimRequest = trimmed;

        const myId = ++interimRequestId;
        translate(trimmed)
            .then(hebrew => {
                if (myId === interimRequestId) {
                    els.currentHebrew.textContent = hebrew;
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
    // Reset interim tracking so next sentence starts fresh
    lastInterimRequest = '';

    // Show "translating" indicator immediately
    els.currentHebrew.textContent = '...';

    try {
        const hebrew = await translate(englishSegment);
        els.currentHebrew.textContent = hebrew;

        // Add to history
        historySegments.unshift({ english: englishSegment, hebrew });
        if (historySegments.length > MAX_HISTORY) {
            historySegments = historySegments.slice(0, MAX_HISTORY);
        }
        renderHistory();
    } catch (err) {
        els.currentHebrew.textContent = '[Translation error]';
        setStatus(`Translation failed: ${err.message}`, 'error');
        setTimeout(() => {
            if (isListening) setStatus('Listening...', 'listening');
        }, 3000);
    }
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

// ============== Controls ==============
els.btnToggle.addEventListener('click', async () => {
    if (!recognition && !initRecognition()) return;

    if (isListening) {
        // Stop
        isStoppingIntentionally = true;
        recognition.stop();
    } else {
        // Start
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
    renderHistory();
    els.currentEnglish.textContent = 'Start listening to see the live transcript';
    els.currentHebrew.textContent = 'התחל האזנה כדי לראות תרגום חי';
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
