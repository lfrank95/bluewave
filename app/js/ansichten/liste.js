// Filme bzw. Serien als Raster, mit Sortierung und Genre-Filter
'use strict';
import { el, kachel, auswahl } from '../ui.js';
import { api } from '../api.js';

export const titel = (r) => (r.name === 'serien' ? 'Serien' : 'Filme') + ' – Bluewave';

export async function zeigen(r) {
    const serien = r.name === 'serien';
    const sort = r.query.get('sort') || 'titel';
    const genre = r.query.get('genre') || '';
    const q = new URLSearchParams({ sort });
    if (genre) q.set('genre', genre);
    const d = await api((serien ? 'serien' : 'filme') + '?' + q);
    const liste = serien ? d.serien : d.filme;
    const setzen = (k, v) => {
        const p = new URLSearchParams(r.query);
        if (v) p.set(k, v); else p.delete(k);
        location.hash = '#/' + r.name + (p.toString() ? '?' + p : '');
    };
    const sortWahl = auswahl(serien ? { titel: 'Titel', neu: 'Zuletzt hinzugefügt', jahr: 'Jahr' } : { titel: 'Titel', neu: 'Zuletzt hinzugefügt', jahr: 'Jahr', bewertung: 'Bewertung' },
        sort, { 'aria-label': 'Sortierung', onchange: (e) => setzen('sort', e.target.value) });
    const genreWahl = auswahl({ '': 'Alle Genres', ...Object.fromEntries(d.genres.map((g) => [g.id, `${g.name} (${g.anzahl})`])) }, genre,
        { 'aria-label': 'Genre', onchange: (e) => setzen('genre', e.target.value) });
    return el('div.seite',
        el('div.seiten-kopf', el('h1', serien ? 'Serien' : 'Filme'), el('span.zahl', String(liste.length)),
            el('div.werkzeuge', d.genres.length ? genreWahl : null, sortWahl)),
        liste.length ? el('div.raster', liste.map(kachel)) : el('div.leer', el('h2', 'Nichts gefunden'), el('p', genre ? 'In diesem Genre gibt es noch nichts.' : 'Die Bibliothek ist noch leer.')));
}
