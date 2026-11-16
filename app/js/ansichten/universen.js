// Universen (Liste und Detail) und Reihen
'use strict';
import { el, icon, kachel } from '../ui.js';
import { api } from '../api.js';
import { hero } from './film.js';

let letzterTitel = 'Universen';
export const titel = () => letzterTitel + ' – Bluewave';

export async function zeigen(r, app) {
    if (r.name === 'universen') return liste(app);
    if (r.name === 'reihe') return reihe(parseInt(r.teile[1], 10));
    return universum(parseInt(r.teile[1], 10), app);
}

async function liste(app) {
    letzterTitel = 'Universen';
    const d = await api('universen');
    return el('div.seite',
        el('div.seiten-kopf', el('h1', 'Universen'), el('span.zahl', String(d.universen.length)),
            app.konto.rolle === 'admin' ? el('div.werkzeuge', el('a.knopf', { href: '#/verwaltung/universen' }, icon('bearbeiten'), 'Verwalten')) : null),
        d.universen.length ? el('div.raster', d.universen.map(kachel)) : el('div.leer', el('h2', 'Noch keine Universen'),
            el('p', 'Universen fassen Reihen, Filme und Serien zusammen – zum Beispiel das Marvel Cinematic Universe.'),
            app.konto.rolle === 'admin' ? el('a.knopf.haupt', { href: '#/verwaltung/universen' }, icon('plus'), 'Universum anlegen') : null));
}

async function universum(id, app) {
    const d = await api('universum/' + id);
    letzterTitel = d.name;
    const reihen = d.eintraege.filter((e) => e.art === 'reihe').length;
    const filme = d.eintraege.filter((e) => e.art === 'film').length;
    const serien = d.eintraege.filter((e) => e.art === 'serie').length;
    const zusammenfassung = [reihen ? `${reihen} ${reihen === 1 ? 'Reihe' : 'Reihen'}` : null, filme ? `${filme} ${filme === 1 ? 'Film' : 'Filme'}` : null,
        serien ? `${serien} ${serien === 1 ? 'Serie' : 'Serien'}` : null].filter(Boolean).join(' · ');
    return el('div',
        hero({ ...d, titel: d.name, logo: null }, app.konto.rolle === 'admin' ? el('div.knoepfe', el('a.knopf', { href: `#/verwaltung/universen?id=${id}` }, icon('bearbeiten'), 'Bearbeiten')) : null,
            [el('div.meta', el('span', 'Universum'), zusammenfassung ? [el('span.trenn'), el('span', zusammenfassung)] : null), d.beschreibung ? el('p.text', d.beschreibung) : null]),
        el('div.seite', d.eintraege.length ? el('div.raster', d.eintraege.map(kachel)) : el('div.leer', el('p', 'Dieses Universum ist noch leer.'))));
}

async function reihe(id) {
    const d = await api('reihe/' + id);
    letzterTitel = d.name;
    return el('div',
        hero({ ...d, titel: d.name, logo: null }, null, [el('div.meta', el('span', 'Reihe'), el('span.trenn'), el('span', `${d.filme.length} ${d.filme.length === 1 ? 'Film' : 'Filme'}`)),
            el('div.chips', d.universen.map((u) => el('a.chip.akzent', { href: `#/universum/${u.id}` }, icon('universum'), u.name))),
            d.beschreibung ? el('p.text', d.beschreibung) : null]),
        el('div.seite', el('div.raster', d.filme.map(kachel))));
}

