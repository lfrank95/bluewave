// Suche über Filme, Serien, Reihen und Universen
'use strict';
import { el, icon, kachel } from '../ui.js';
import { api } from '../api.js';
import { mehrfachAuswahl } from './mehrfach.js';

export const titel = () => 'Suche – Bluewave';

export async function zeigen(r, app) {
    const q = r.query.get('q') || '';
    const feld = el('input.eingabe', { type: 'search', value: q, placeholder: 'Film, Serie, Reihe oder Universum …', style: { width: '100%', fontSize: '1.1rem', padding: '12px 16px' } });
    let t = null;
    feld.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => history.replaceState(null, '', '#/suche?q=' + encodeURIComponent(feld.value.trim())) || ergebnisZeigen(feld.value.trim()), 280);
    });
    const ergebnis = el('div');
    const ergebnisZeigen = async (wort) => {
        if (wort.length < 2) {
            ergebnis.replaceChildren(el('p.leise', { style: { marginTop: '20px' } }, 'Mindestens zwei Buchstaben eingeben.'));
            return;
        }
        const d = await api('suche?q=' + encodeURIComponent(wort));
        const gruppen = [['Universen', d.universen], ['Reihen', d.reihen], ['Filme', d.filme], ['Serien', d.serien]].filter(([, l]) => l.length);
        if (!gruppen.length) {
            ergebnis.replaceChildren(el('div.leer', el('h2', 'Nichts gefunden'), el('p', `Zu „${wort}“ gibt es nichts in deiner Bibliothek.`)));
            return;
        }
        // Mehrfachauswahl über Reihen, Filme und Serien (Universen lassen sich nicht verschachteln)
        const waehlbar = gruppen.filter(([n]) => n !== 'Universen').map(([n, l]) => [n, l, el('div.raster', l.map(kachel))]);
        const wahl = waehlbar.length ? mehrfachAuswahl(waehlbar.map((g) => g[2]), waehlbar.map((g) => g[1]), app) : null;
        ergebnis.replaceChildren(
            wahl ? el('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '18px' } }, wahl.knopf) : null,
            ...gruppen.map(([n, l]) => el('section.abschnitt', { style: { marginTop: '24px' } }, el('h2', n),
                waehlbar.find((g) => g[0] === n)?.[2] || el('div.raster', l.map(kachel)))));
    };
    ergebnisZeigen(q);
    setTimeout(() => { feld.focus(); feld.setSelectionRange(q.length, q.length); });
    return el('div.seite', el('div.seiten-kopf', el('h1', icon('suche'), ' Suche')), feld, ergebnis);
}
