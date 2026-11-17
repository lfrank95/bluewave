// Bluewave Web-App: Rahmen (Kopf, Navigation, Tabs), Router, Anmeldung und Einrichtung
'use strict';
import { el, icon, initialen, meldung, feld } from './ui.js';
import { api, wennAbgemeldet } from './api.js';

// Windows-Client: Hauptfenster (Bibliothek) oder Spielerfenster (durchsichtige Bedienung über dem mpv-Bild)
const NATIV = window.bluewaveNativ || null;
if (NATIV) {
    document.documentElement.classList.add('bw-nativ', NATIV.rolle === 'spieler' ? 'bw-spieler' : 'bw-haupt');
    document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/css/client.css' }));
}

const app = {
    konto: null,
    abspielen: async (ziel) => {
        // im Client spielt mpv in einem eigenen Fenster (jede Datei unverändert, Ton über WASAPI, ASIO oder Bitstream)
        if (NATIV?.video && NATIV.rolle === 'haupt') { NATIV.video.oeffnen(ziel); return; }
        const { spielen } = await import('./player.js');
        spielen(ziel, app);
    },
    neuLaden: () => route(true, true),
    routeMerken: () => { letzteRoute = location.hash; },
    // gemerkte Sortierung je Ansicht (am Konto gespeichert, gilt also auf allen Geräten)
    sortierung: (schluessel, standard) => app.konto?.einstellungen?.sortierung?.[schluessel] || standard,
    sortierungMerken: (schluessel, wert) => {
        const e = app.konto?.einstellungen;
        if (!e) return;
        const s = Array.isArray(e.sortierung) || !e.sortierung ? {} : { ...e.sortierung };
        if (s[schluessel] === wert) return;
        s[schluessel] = wert;
        e.sortierung = s;
        api('ich/einstellungen', 'PUT', { sortierung: s }).catch(() => {});
    },
};
window.__bluewave = app;

const ANSICHTEN = {
    '': () => import('./ansichten/start.js'),
    filme: () => import('./ansichten/liste.js'),
    serien: () => import('./ansichten/liste.js'),
    film: () => import('./ansichten/film.js'),
    serie: () => import('./ansichten/serie.js'),
    universen: () => import('./ansichten/universen.js'),
    universum: () => import('./ansichten/universen.js'),
    reihe: () => import('./ansichten/universen.js'),
    suche: () => import('./ansichten/suche.js'),
    profil: () => import('./ansichten/profil.js'),
    verwaltung: () => import('./ansichten/verwaltung.js'),
};
const MIT_HERO = new Set(['', 'film', 'serie', 'universum', 'reihe']);

let hauptEl = null;
let kopfEl = null;

function rahmen() {
    const nav = [['', 'start', 'Start'], ['filme', 'film', 'Filme'], ['serien', 'serie', 'Serien'], ['universen', 'universum', 'Universen']];
    const suche = el('input', { type: 'search', placeholder: 'Suchen …', 'aria-label': 'Suchen' });
    let sucheTimer = null;
    // Das Kopf-Suchfeld ist der Eingang: Tippen oder Enter öffnet die Suchseite, dort geht es im großen Feld weiter
    // Fokus bleibt im Kopffeld, bis die Suchseite steht – sie übernimmt dann Text und Fokus (kein Tastendruck geht verloren)
    app.kopfSuche = suche;
    const zurSuche = () => {
        if (parsen().name !== 'suche') location.hash = '#/suche';
    };
    suche.addEventListener('input', () => {
        clearTimeout(sucheTimer);
        sucheTimer = setTimeout(zurSuche, 0);
    });
    suche.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); zurSuche(); } });
    // „/“ oder Strg+K springt überall in die Suche
    document.addEventListener('keydown', (e) => {
        const tippt = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
        if ((e.key === '/' && !tippt) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
            e.preventDefault();
            if (parsen().name === 'suche') document.querySelector('.such-gross')?.focus();
            else location.hash = '#/suche';
        }
    });
    const avatar = el('button.avatar', { 'aria-label': 'Menü', title: app.konto.anzeigename }, initialen(app.konto.anzeigename));
    avatar.addEventListener('click', (e) => {
        e.stopPropagation();
        const offen = document.querySelector('.menue');
        if (offen) { offen.remove(); return; }
        const m = el('div.menue.glass-panel',
            el('div.name', app.konto.anzeigename),
            el('a', { href: '#/profil' }, icon('nutzer'), 'Profil & Wiedergabe'),
            app.konto.rolle === 'admin' ? el('a', { href: '#/verwaltung/bibliothek' }, icon('verwaltung'), 'Verwaltung') : null,
            el('button', { onclick: abmelden }, icon('abmelden'), 'Abmelden'));
        document.body.append(m);
        setTimeout(() => document.addEventListener('click', () => m.remove(), { once: true }));
    });
    kopfEl = el('header.kopf',
        el('button.zurueck-knopf', { 'aria-label': 'Zurück', title: 'Zurück', onclick: zurueck }, icon('zurueck')),
        el('a.marke', { href: '#/' }, el('img', { src: '/img/logo.svg', alt: '' }), el('span', 'Bluewave')),
        el('nav.nav', nav.map(([r, i, t]) => el('a', { href: '#/' + r, 'data-route': r }, icon(i), t))),
        el('div.kopf-rechts', el('label.suche-feld', icon('suche'), suche),
            el('a.rund-knopf', { href: '#/suche', 'aria-label': 'Suchen', style: { display: 'none' }, class: 'rund-knopf nur-mobil' }, icon('suche')), avatar));
    const tabs = el('nav.tabs-unten', [...nav, ['suche', 'suche', 'Suche']].map(([r, i, t]) => el('a', { href: '#/' + r, 'data-route': r }, icon(i), t)));
    hauptEl = el('main');
    document.getElementById('app').replaceChildren(kopfEl, hauptEl, tabs);
    window.addEventListener('scroll', kopfStil, { passive: true });
}

let heroAktiv = false;
function kopfStil() {
    kopfEl?.classList.toggle('ueber-hero', heroAktiv && window.scrollY < 60);
}

function parsen() {
    const h = location.hash.replace(/^#\/?/, '');
    const [pfad, query] = h.split('?');
    const teile = pfad.split('/').filter(Boolean);
    return { name: teile[0] || '', teile, query: new URLSearchParams(query || '') };
}

// ---------- Verlauf: Zurück (Knopf und Browser) führt zur letzten Seite an die letzte Position ----------
const OBEN = new Set(['', 'filme', 'serien', 'universen']);
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
let positionen = {};
try { positionen = JSON.parse(sessionStorage.getItem('bluewave.positionen') || '{}'); } catch { /* privat */ }
let positionSperre = false;
let speicherTimer = null;
window.addEventListener('scroll', () => {
    const id = history.state?.bw;
    if (positionSperre || !id) return;
    positionen[id] = window.scrollY;
    clearTimeout(speicherTimer);
    speicherTimer = setTimeout(() => {
        try { sessionStorage.setItem('bluewave.positionen', JSON.stringify(positionen)); } catch { /* voll/privat */ }
    }, 250);
}, { passive: true });

function elternSeite(r) {
    if (r.name === 'film') return '#/filme';
    if (r.name === 'serie') return '#/serien';
    if (r.name === 'universum') return r.teile[2] === 'bearbeiten' ? `#/universum/${r.teile[1]}` : '#/universen';
    if (r.name === 'reihe') return '#/filme?filter=reihen';
    return '#/';
}
function zurueck() {
    if (history.state?.vor) history.back();
    else location.hash = elternSeite(parsen());
}

let letzteRoute = '';
async function route(erzwingen = false, neuLadenAufPlatz = false) {
    if (!app.konto) return;
    const r = parsen();
    const schluessel = location.hash;
    if (!erzwingen && schluessel === letzteRoute) return;
    // neuer Verlaufseintrag (Link, Eingabe) oder Rückkehr (Zurück/Vor)?
    let rueckkehr = !!history.state?.bw;
    if (!rueckkehr) history.replaceState({ bw: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), vor: letzteRoute !== '' }, '');
    if (neuLadenAufPlatz) rueckkehr = true;
    const ziel = rueckkehr ? (neuLadenAufPlatz ? window.scrollY : positionen[history.state.bw] || 0) : 0;
    positionSperre = true;
    letzteRoute = schluessel;
    kopfEl?.classList.toggle('mit-zurueck', !OBEN.has(r.name));
    if (r.name !== 'suche') kopfEl?.classList.remove('auf-suche');
    document.querySelectorAll('[data-route]').forEach((a) => a.classList.toggle('aktiv', a.dataset.route === r.name
        || (r.name === 'film' && a.dataset.route === 'filme') || (r.name === 'serie' && a.dataset.route === 'serien')
        || ((r.name === 'universum' || r.name === 'reihe') && a.dataset.route === 'universen')));
    document.querySelector('.menue')?.remove();
    heroAktiv = MIT_HERO.has(r.name) && r.teile[2] !== 'bearbeiten';
    kopfStil();
    const laden = ANSICHTEN[r.name];
    if (!laden) {
        positionSperre = false;
        hauptEl.replaceChildren(el('div.leer', el('h2', 'Seite nicht gefunden'), el('a', { href: '#/' }, 'Zur Startseite')));
        return;
    }
    try {
        const modul = await laden();
        const inhalt = await modul.zeigen(r, app);
        if (letzteRoute !== schluessel) return; // inzwischen weiternavigiert
        if (inhalt) hauptEl.replaceChildren(inhalt);
        document.title = (modul.titel?.(r) || 'Bluewave');
        // Position setzen; nachgeladene Inhalte (Bilder, Vorschläge) können die Seite noch wachsen lassen
        const setzen = () => window.scrollTo(0, Math.min(ziel, document.documentElement.scrollHeight - window.innerHeight));
        setzen();
        if (ziel > 0) {
            for (const ms of [80, 250, 600]) setTimeout(() => { if (letzteRoute === schluessel && Math.abs(window.scrollY - ziel) > 4) setzen(); }, ms);
        }
        setTimeout(() => { if (letzteRoute === schluessel) positionSperre = false; }, ziel > 0 ? 650 : 0);
    } catch (e) {
        positionSperre = false;
        if (e.status === 401) return;
        hauptEl.replaceChildren(el('div.leer', el('h2', 'Das hat nicht geklappt'), el('p', e.message)));
    }
}

async function abmelden() {
    await api('auth/logout', 'POST').catch(() => {});
    app.konto = null;
    location.hash = '#/';
    anmeldenZeigen();
}

// ---------- Anmeldung und Einrichtung ----------
function anmeldenZeigen(einrichtung = false) {
    const name = el('input.eingabe', { autocomplete: 'username', required: true });
    const anzeige = el('input.eingabe', { autocomplete: 'name' });
    const pw = el('input.eingabe', { type: 'password', autocomplete: einrichtung ? 'new-password' : 'current-password', required: true });
    const pw2 = el('input.eingabe', { type: 'password', autocomplete: 'new-password' });
    const merken = el('input', { type: 'checkbox', checked: true });
    const geraet = el('input', { type: 'checkbox' });
    const fehler = el('div.fehler-text');
    const knopf = el('button.knopf.haupt', { type: 'submit' }, einrichtung ? 'Admin anlegen & loslegen' : 'Anmelden');
    const form = el('form.karte.glass-panel',
        el('div.marke', el('img', { src: '/img/logo.svg', alt: '' }), 'Bluewave'),
        el('p.leise', einrichtung ? 'Willkommen! Lege zuerst dein Admin-Konto an.' : 'Melde dich an, um weiterzuschauen.'),
        feld('Benutzername', name),
        einrichtung ? feld('Anzeigename', anzeige, 'So erscheinst du in der App, z. B. „Lorenzo“.') : null,
        feld('Passwort', pw, einrichtung ? 'Mindestens 8 Zeichen.' : null),
        einrichtung ? feld('Passwort wiederholen', pw2) : null,
        einrichtung ? null : el('label.schalter', merken, 'Angemeldet bleiben'),
        einrichtung ? null : el('label.schalter', { style: { marginTop: '8px' }, title: 'Für Fernseher: bleibt dauerhaft angemeldet, bis du das Gerät im Profil entfernst.' }, geraet, 'Dieses Gerät fest anmelden (Fernseher)'),
        fehler, knopf);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        fehler.textContent = '';
        knopf.disabled = true;
        try {
            if (einrichtung) {
                if (pw.value !== pw2.value) throw new Error('Die Passwörter stimmen nicht überein.');
                await api('einrichtung', 'POST', { benutzername: name.value, anzeigename: anzeige.value, passwort: pw.value });
            } else {
                await api('auth/login', 'POST', { benutzername: name.value, passwort: pw.value, merken: merken.checked,
                    geraet: geraet.checked ? (navigator.userAgent.match(/AFT|Android TV|BRAVIA|SMART-TV|Tizen|Web0S/i) ? 'Fernseher' : 'Gerät') : '', cookie: true });
            }
            await starten();
        } catch (x) {
            fehler.textContent = x.message;
        } finally {
            knopf.disabled = false;
        }
    });
    document.getElementById('app').replaceChildren(el('div.anmelden', form));
    name.focus();
}

async function starten() {
    try {
        app.konto = await api('ich');
    } catch (e) {
        if (e.status === 401) {
            anmeldenZeigen(!!e.daten?.einrichtung);
            return;
        }
        document.getElementById('app').replaceChildren(el('div.leer', el('h2', 'Bluewave ist nicht erreichbar'), el('p', e.message)));
        return;
    }
    if (NATIV?.rolle === 'spieler') {
        // Spielerfenster: nur der Player; Schließen beendet das Fenster, das Hauptfenster lädt seine Ansicht neu
        app.neuLaden = () => NATIV.video.zu();
        const ziel = await NATIV.video.auftrag();
        if (!ziel) { NATIV.video.zu(); return; }
        const { spielen } = await import('./player.js');
        spielen(ziel, app);
        return;
    }
    rahmen();
    letzteRoute = '';
    route(true);
    NATIV?.video?.aufEnde?.(() => app.neuLaden());
}

wennAbgemeldet((daten) => {
    if (!app.konto) return;
    app.konto = null;
    meldung('Bitte erneut anmelden.');
    anmeldenZeigen(!!daten?.einrichtung);
});
window.addEventListener('hashchange', () => route());
starten();

// Mobil: Suche-Symbol im Kopf zeigen, wenn das Suchfeld ausgeblendet ist
const mq = window.matchMedia('(max-width: 1023px)');
const mobilSuche = () => document.querySelectorAll('.nur-mobil').forEach((a) => { a.style.display = mq.matches ? 'grid' : 'none'; });
mq.addEventListener('change', mobilSuche);
new MutationObserver(mobilSuche).observe(document.getElementById('app'), { childList: true });
