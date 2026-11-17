// Wiedergabe-Diagnose im Browser: sammelt Ereignisse mit Zeitstempel und schickt sie gebündelt an den Server
'use strict';
import { api, diagSetzen } from './api.js';

let aktuell = null;

function neueKennung() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/** Neue Wiedergabe beginnen; alle folgenden API-Anfragen und Ströme tragen ihre Kennung */
export function diagNeu(info) {
    diagEnde();
    aktuell = { k: neueKennung(), beginn: performance.now(), puffer: [], start: info, gesendetStart: false, timer: null };
    diagSetzen(aktuell.k);
    aktuell.timer = setInterval(senden, 4000);
    diag('beginn', info);
    return aktuell.k;
}

export function diagKennung() { return aktuell?.k || null; }

/** Ereignis merken: d = kleine Zusatzdaten */
export function diag(e, d = {}) {
    if (!aktuell) return;
    aktuell.puffer.push({ t: Date.now(), e, d: { ...d, ms: Math.round(performance.now() - aktuell.beginn) } });
    if (aktuell.puffer.length > 200) senden();
    if (window.__bluewaveDiagKonsole) console.debug('[diag]', e, d);
}

function senden(keepalive = false) {
    const a = aktuell;
    if (!a || (!a.puffer.length && a.gesendetStart)) return;
    const ereignisse = a.puffer.splice(0);
    const daten = { k: a.k, ereignisse, ...(a.gesendetStart ? {} : { start: a.start }) };
    a.gesendetStart = true;
    if (keepalive) {
        fetch('/api/v1/diagnose', { method: 'POST', keepalive: true, credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-Bluewave': '1' }, body: JSON.stringify(daten) }).catch(() => {});
    } else {
        api('diagnose', 'POST', daten).catch(() => {});
    }
}

export function diagEnde() {
    if (!aktuell) return;
    diag('ende');
    clearInterval(aktuell.timer);
    senden(true);
    aktuell = null;
    diagSetzen(null);
}

window.addEventListener('pagehide', () => { if (aktuell) { diag('seite_verlassen'); senden(true); } });

/** Video-Element beobachten: Ladephasen, Warten (mit Dauer), Fehler, Qualität */
export function diagVideo(v, info = () => ({})) {
    let wartenSeit = null;
    const zustand = () => {
        const b = v.buffered;
        let voraus = 0;
        for (let i = 0; i < b.length; i++) if (v.currentTime >= b.start(i) - 0.3 && v.currentTime <= b.end(i)) voraus = b.end(i) - v.currentTime;
        return { pos: +v.currentTime.toFixed(2), bereit: v.readyState, netz: v.networkState, voraus: +voraus.toFixed(1), ...info() };
    };
    const ereignisse = ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'playing', 'pause', 'seeking', 'seeked', 'stalled', 'suspend', 'emptied', 'ended'];
    const fn = {};
    for (const e of ereignisse) {
        fn[e] = () => {
            if (e === 'playing' && wartenSeit !== null) {
                diag('warten_vorbei', { ...zustand(), dauer_ms: Math.round(performance.now() - wartenSeit) });
                wartenSeit = null;
            }
            if (e === 'suspend' || e === 'canplaythrough') return; // zu häufig, sagt wenig
            diag('video_' + e, zustand());
        };
        v.addEventListener(e, fn[e]);
    }
    fn.waiting = () => { wartenSeit = performance.now(); diag('video_waiting', zustand()); };
    v.addEventListener('waiting', fn.waiting);
    fn.error = () => diag('video_fehler', { code: v.error?.code, text: v.error?.message || '', ...zustand() });
    v.addEventListener('error', fn.error);
    // alle 10 s ein Stand: Puffer, verworfene Bilder
    const stand = setInterval(() => {
        if (v.paused && v.readyState >= 3) return;
        const q = v.getVideoPlaybackQuality?.();
        diag('stand', { ...zustand(), bilder: q?.totalVideoFrames, verworfen: q?.droppedVideoFrames, aufloesung: `${v.videoWidth}x${v.videoHeight}` });
    }, 10000);
    return () => {
        clearInterval(stand);
        for (const [e, f] of Object.entries(fn)) v.removeEventListener(e, f);
    };
}
