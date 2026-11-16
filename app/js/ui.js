// Bausteine der Oberfläche: Elemente, Symbole, Kacheln, Reihen, Dialoge, Meldungen, Formatierung
'use strict';

/** Element bauen: el('div.klasse.andere', {attr}, kinder…) */
export function el(spec, attrs, ...kinder) {
    const [tag, ...klassen] = spec.split('.');
    const e = document.createElement(tag || 'div');
    if (klassen.length) e.className = klassen.join(' ');
    if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
        kinder.unshift(attrs);
        attrs = null;
    }
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v === undefined || v === null || v === false) continue;
        if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else if (k === 'text') e.textContent = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
        else e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kinder.flat(Infinity)) {
        if (k === null || k === undefined || k === false) continue;
        e.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
    return e;
}

const PFADE = {
    start: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    serie: '<rect x="3" y="5" width="18" height="12" rx="2.5"/><path d="M8 21h8M12 17v4"/>',
    universum: '<circle cx="12" cy="12" r="3"/><ellipse cx="12" cy="12" rx="10" ry="4.2"/><ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(60 12 12)"/>',
    suche: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    play: '<path d="M7 4.5v15l13-7.5z" />',
    pause: '<path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z"/>',
    zurueck10: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.7"/><path d="M4 4v4.7h4.7"/><text x="12" y="15.5" font-size="7" text-anchor="middle" stroke="none" fill="currentColor" font-weight="700">10</text>',
    vor10: '<path d="M20 12a8 8 0 1 1-2.4-5.7L20 8.7"/><path d="M20 4v4.7h-4.7"/><text x="12" y="15.5" font-size="7" text-anchor="middle" stroke="none" fill="currentColor" font-weight="700">10</text>',
    vollbild: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    vollbildAus: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
    einstellungen: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    untertitel: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M6 14h4M12 14h6M6 10.5h7M15 10.5h3"/>',
    ton: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>',
    schliessen: '<path d="M6 6l12 12M18 6L6 18"/>',
    zurueck: '<path d="M15 5l-7 7 7 7"/>',
    weiter: '<path d="M9 5l7 7-7 7"/>',
    links: '<path d="M15 5l-7 7 7 7"/>',
    rechts: '<path d="M9 5l7 7-7 7"/>',
    haken: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    loeschen: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    hoch: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    runter: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    bearbeiten: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
    naechste: '<path d="M5 5v14l10-7z"/><path d="M18 5v14"/>',
    nutzer: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
    verwaltung: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    abmelden: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
    stern: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
    mond: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    neu: '<path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5"/>',
};

export function icon(name, voll = false) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', 'ic' + (voll || name === 'play' || name === 'pause' ? ' voll' : ''));
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = PFADE[name] || '';
    return s;
}

// ---------- Formatierung ----------
export function dauer(min) {
    if (!min) return '';
    const h = Math.floor(min / 60), m = min % 60;
    return h ? `${h} Std.${m ? ' ' + m + ' Min.' : ''}` : `${m} Min.`;
}

export function zeit(sek) {
    sek = Math.max(0, Math.floor(sek || 0));
    const h = Math.floor(sek / 3600), m = Math.floor((sek % 3600) / 60), s = sek % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

export function bytes(n) {
    if (!n) return '';
    const e = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < e.length - 1) { n /= 1024; i++; }
    return n.toFixed(i >= 3 ? 1 : 0).replace('.', ',') + ' ' + e[i];
}

export function datum(s) {
    if (!s) return '';
    const d = new Date(s);
    return isNaN(d) ? s : d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function initialen(name) {
    return (name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

// ---------- Kacheln ----------
export function bild(src, alt = '') {
    if (!src) return null;
    const i = el('img', { src, alt, loading: 'lazy', decoding: 'async' });
    i.addEventListener('error', () => i.remove(), { once: true });
    return i;
}

export function zielLink(x) {
    return { film: `#/film/${x.id}`, serie: `#/serie/${x.serie_id || x.id}`, universum: `#/universum/${x.id}`, reihe: `#/reihe/${x.id}`, folge: `#/serie/${x.serie_id}` }[x.art] || '#/';
}

/** Poster-Kachel (Film, Serie, Reihe, Universum) */
export function kachel(x) {
    const marken = el('div.marken');
    if (x.qualitaet === '4K') marken.append(el('span.marke-klein', '4K'));
    if (x.hdr) marken.append(el('span.marke-klein.hdr', 'HDR'));
    const fs = x.fortschritt;
    const zusatz = x.zusatz || [x.zeitraum || x.jahr, x.art === 'serie' && x.folgen ? `${x.folgen} ${x.folgen === 1 ? 'Folge' : 'Folgen'}` : null,
        x.art === 'universum' ? `${x.eintraege} Einträge` : null].filter(Boolean).join(' · ');
    return el('a.kachel', { href: zielLink(x), title: x.titel },
        el('div.bild', bild(x.poster, x.titel) || el('div.ersatz', x.titel), marken.childElementCount ? marken : null,
            fs?.gesehen ? el('span.gesehen-haken', icon('haken')) : null,
            fs && !fs.gesehen && fs.prozent > 1 ? el('div.fortschritt', el('span', { style: { width: fs.prozent + '%' } })) : null),
        el('div.titel', x.titel), zusatz ? el('div.zusatz', zusatz) : null);
}

/** Breite Kachel (Weiterschauen, Folgen) – Klick spielt direkt ab */
export function breitKachel(x, abspielen) {
    const a = el('a.breit', { href: zielLink(x), title: x.titel },
        el('div.bild', bild(x.bild, x.titel), x.logo ? el('img.logo-auf', { src: x.logo, alt: '' }) : null,
            el('div.abspielen-ueber', el('span', icon('play'))),
            x.prozent > 0 ? el('div.fortschritt', el('span', { style: { width: x.prozent + '%' } })) : null),
        el('div.titel', x.titel), el('div.zusatz', [x.untertitel, x.rest_min ? `noch ${dauer(x.rest_min)}` : null].filter(Boolean).join(' · ')));
    if (abspielen) {
        a.addEventListener('click', (e) => {
            e.preventDefault();
            abspielen({ art: x.art, id: x.id });
        });
    }
    return a;
}

/** Horizontale Reihe mit Pfeilen */
export function zeile(titel, elemente, { breit = false, link = null } = {}) {
    if (!elemente.length) return null;
    const spur = el('div.spur', elemente);
    const links = el('button.pfeil.links', { 'aria-label': 'Zurück', onclick: () => spur.scrollBy({ left: -spur.clientWidth * 0.85, behavior: 'smooth' }) }, icon('links'));
    const rechts = el('button.pfeil.rechts', { 'aria-label': 'Weiter', onclick: () => spur.scrollBy({ left: spur.clientWidth * 0.85, behavior: 'smooth' }) }, icon('rechts'));
    const pruefen = () => {
        links.disabled = spur.scrollLeft < 10;
        rechts.disabled = spur.scrollLeft + spur.clientWidth >= spur.scrollWidth - 10;
    };
    spur.addEventListener('scroll', pruefen, { passive: true });
    requestAnimationFrame(pruefen);
    return el('section.zeile',
        el('div.zeile-kopf', el('h2', titel), link ? el('a', { href: link }, 'Alle anzeigen') : null),
        el('div.scroller' + (breit ? '.breit-spur' : ''), links, spur, rechts));
}

// ---------- Meldungen und Dialoge ----------
let meldungTimer = null;
export function meldung(text, fehler = false) {
    document.querySelector('.meldung')?.remove();
    const m = el('div.meldung' + (fehler ? '.fehler' : ''), text);
    document.body.append(m);
    clearTimeout(meldungTimer);
    meldungTimer = setTimeout(() => m.remove(), fehler ? 6000 : 3200);
}

export function dialog(titel, inhalt, knoepfe = []) {
    return new Promise((fertig) => {
        const hg = el('div.dialog-hg');
        const schliessen = (wert) => {
            hg.remove();
            document.removeEventListener('keydown', taste);
            fertig(wert);
        };
        const taste = (e) => { if (e.key === 'Escape') schliessen(null); };
        document.addEventListener('keydown', taste);
        hg.addEventListener('click', (e) => { if (e.target === hg) schliessen(null); });
        const leiste = el('div.knoepfe', knoepfe.map((k) => el('button.knopf' + (k.haupt ? '.haupt' : '') + (k.gefahr ? '.gefahr' : ''), {
            onclick: async () => {
                if (k.wert === undefined && k.aktion) {
                    const r = await k.aktion();
                    if (r !== false) schliessen(r);
                } else schliessen(k.wert);
            },
        }, k.text)));
        hg.append(el('div.dialog.glass-panel', el('h2', titel), inhalt, knoepfe.length ? leiste : null));
        document.body.append(hg);
        hg.querySelector('input, select, textarea, button')?.focus();
    });
}

export async function bestaetigen(titel, text, ja = 'OK', gefahr = false) {
    return (await dialog(titel, el('p.leise', text), [{ text: 'Abbrechen', wert: false }, { text: ja, wert: true, haupt: !gefahr, gefahr }])) === true;
}

export function feld(label, eingabe, hilfe) {
    return el('div.feld', el('label', label), eingabe, hilfe ? el('div.hilfe', hilfe) : null);
}

export function auswahl(werte, aktuell, attrs = {}) {
    return el('select', attrs, Object.entries(werte).map(([w, t]) => el('option', { value: w, selected: String(w) === String(aktuell) }, t)));
}

/** FSK-Abzeichen in den offiziellen Farben (0 weiß, 6 gelb, 12 grün, 16 blau, 18 rot) */
export function fsk(wert) {
    if (wert === null || wert === undefined || wert === '') return null;
    const n = parseInt(String(wert).replace(/\D/g, ''), 10);
    const stufe = [0, 6, 12, 16, 18].includes(n) ? n : null;
    return el('span.fsk' + (stufe !== null ? '.fsk-' + stufe : ''), { title: stufe !== null ? `FSK ab ${stufe} freigegeben` : `Freigabe ${wert}` },
        el('small', 'FSK'), el('b', stufe !== null ? String(stufe) : String(wert)));
}
