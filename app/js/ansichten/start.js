// Startseite: großes Titelbild, Weiterschauen, Als Nächstes, Neu, Universen
'use strict';
import { el, icon, kachel, breitKachel, zeile, dauer } from '../ui.js';
import { api } from '../api.js';

export const titel = () => 'Bluewave';

export async function zeigen(r, app) {
    const d = await api('start');
    if (d.leer) {
        return el('div.seite', el('div.leer',
            el('h2', 'Noch ist die Bibliothek leer'),
            el('p', app.konto.rolle === 'admin'
                ? 'Trag in der Verwaltung deinen TMDB-Schlüssel ein und starte den ersten Scan – danach erscheinen hier deine Filme und Serien.'
                : 'Sobald der Admin Filme und Serien eingelesen hat, erscheinen sie hier.'),
            app.konto.rolle === 'admin' ? el('div.knoepfe', { style: { justifyContent: 'center' } }, el('a.knopf.haupt', { href: '#/verwaltung/bibliothek' }, 'Zur Verwaltung')) : null));
    }
    const teile = [];
    if (d.hero) {
        const h = d.hero;
        teile.push(el('section.hero',
            el('div.hg', { style: { backgroundImage: `url("${h.hintergrund}")` } }),
            el('div.inhalt',
                h.logo ? el('img.logo', { src: h.logo, alt: h.titel }) : el('h1.gross', h.titel),
                el('div.meta', h.jahr ? el('span', h.jahr) : null, h.laufzeit_min ? el('span.trenn') : null, h.laufzeit_min ? el('span', dauer(h.laufzeit_min)) : null),
                h.text ? el('p.text', h.text) : null,
                el('div.knoepfe',
                    el('button.knopf.weiss', { onclick: () => app.abspielen({ art: 'film', id: h.id }) }, icon('play'), 'Abspielen'),
                    el('a.knopf', { href: `#/film/${h.id}` }, icon('info'), 'Mehr Infos')))));
    } else {
        teile.push(el('div', { style: { height: '20px' } }));
    }
    teile.push(
        zeile('Weiterschauen', d.weiterschauen.map((x) => breitKachel(x, app.abspielen)), { breit: true }),
        zeile('Als Nächstes', d.als_naechstes.map((x) => breitKachel(x, app.abspielen)), { breit: true }),
        zeile('Neu bei den Filmen', d.neue_filme.map(kachel), { link: '#/filme?sort=neu' }),
        zeile('Neue Folgen', d.neue_serien.map(kachel), { link: '#/serien?sort=neu' }),
        zeile('Universen', d.universen.map(kachel), { link: '#/universen' }),
    );
    return el('div', teile);
}
