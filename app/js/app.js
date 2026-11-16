// Bluewave Web-App: Rahmen (Kopf, Navigation, Tabs), Router, Anmeldung und Einrichtung
'use strict';
import { el, icon, initialen, meldung, feld } from './ui.js';
import { api, wennAbgemeldet } from './api.js';

const app = {
    konto: null,
    abspielen: async (ziel) => {
        const { spielen } = await import('./player.js');
        spielen(ziel, app);
    },
    neuLaden: () => route(true),
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
    suche.addEventListener('input', () => {
        clearTimeout(sucheTimer);
        sucheTimer = setTimeout(() => { location.hash = '#/suche?q=' + encodeURIComponent(suche.value.trim()); }, 300);
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
        el('a.marke', { href: '#/' }, el('img', { src: '/img/logo.svg', alt: '' }), 'Bluewave'),
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

let letzteRoute = '';
async function route(erzwingen = false) {
    if (!app.konto) return;
    const r = parsen();
    const schluessel = location.hash;
    if (!erzwingen && schluessel === letzteRoute) return;
    const gleicheSeite = letzteRoute.split('?')[0] === schluessel.split('?')[0] && r.name === 'suche';
    letzteRoute = schluessel;
    document.querySelectorAll('[data-route]').forEach((a) => a.classList.toggle('aktiv', a.dataset.route === r.name
        || (r.name === 'film' && a.dataset.route === 'filme') || (r.name === 'serie' && a.dataset.route === 'serien')
        || ((r.name === 'universum' || r.name === 'reihe') && a.dataset.route === 'universen')));
    document.querySelector('.menue')?.remove();
    heroAktiv = MIT_HERO.has(r.name) && r.teile[2] !== 'bearbeiten';
    kopfStil();
    const laden = ANSICHTEN[r.name];
    if (!laden) {
        hauptEl.replaceChildren(el('div.leer', el('h2', 'Seite nicht gefunden'), el('a', { href: '#/' }, 'Zur Startseite')));
        return;
    }
    try {
        const modul = await laden();
        const inhalt = await modul.zeigen(r, app);
        if (letzteRoute !== schluessel) return; // inzwischen weiternavigiert
        if (inhalt) hauptEl.replaceChildren(inhalt);
        if (!gleicheSeite) window.scrollTo(0, 0);
        document.title = (modul.titel?.(r) || 'Bluewave');
    } catch (e) {
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
    rahmen();
    letzteRoute = '';
    route(true);
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
