// API-Zugriff: JSON rein, JSON raus; 401 → Anmeldung
'use strict';

export class ApiFehler extends Error {
    constructor(text, status, daten) {
        super(text);
        this.status = status;
        this.daten = daten;
    }
}

let beiAbmeldung = null;
export function wennAbgemeldet(fn) { beiAbmeldung = fn; }

export async function api(pfad, methode = 'GET', daten = undefined) {
    const opt = { method: methode, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
    if (methode !== 'GET') {
        opt.headers['X-Bluewave'] = '1';
        if (daten !== undefined) {
            opt.headers['Content-Type'] = 'application/json';
            opt.body = JSON.stringify(daten);
        }
    }
    let r;
    try {
        r = await fetch('/api/v1/' + pfad, opt);
    } catch (e) {
        throw new ApiFehler('Server nicht erreichbar.', 0);
    }
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && beiAbmeldung && !pfad.startsWith('auth/')) {
        beiAbmeldung(j);
    }
    if (!r.ok) throw new ApiFehler(j.fehler || 'Fehler ' + r.status, r.status, j);
    return j;
}
