// Universen: Liste, Universum-Ansicht (alle Titel einzeln, in Abschnitten), Editor; dazu die Reihen-Seite
'use strict';
import { el, icon, kachel, bild, meldung, bestaetigen } from '../ui.js';
import { api } from '../api.js';
import { hero } from './film.js';
import { bearbeitenDialog } from './bearbeiten_dialog.js';

let letzterTitel = 'Universen';
export const titel = () => letzterTitel + ' – Bluewave';

const zielLink = (t) => (t.art === 'serie' ? `#/serie/${t.id}${t.staffel ? '?staffel=' + t.staffel : ''}` : `#/film/${t.id}`);
const anzahl = (n, eins, mehr) => `${n} ${n === 1 ? eins : mehr}`;

export async function zeigen(r, app) {
    if (r.name === 'universen') return liste(app);
    if (r.name === 'reihe') return reihe(parseInt(r.teile[1], 10), app);
    const id = parseInt(r.teile[1], 10);
    if (r.teile[2] === 'bearbeiten' && app.konto.rolle === 'admin') return editor(id, app);
    return universum(id, r, app);
}

function collage(poster, n) {
    const liste = poster.filter(Boolean);
    if (!liste.length) return null;
    const aus = [];
    for (let i = 0; i < n; i++) aus.push(liste[i % liste.length]);
    return el('div.collage', aus.map((p) => el('div', el('img', { src: p, alt: '', loading: 'lazy' }))));
}

// ---------- Liste ----------
async function liste(app) {
    letzterTitel = 'Universen';
    const d = await api('universen');
    const admin = app.konto.rolle === 'admin';
    const neu = async () => {
        const name = prompt('Name des neuen Universums');
        if (!name?.trim()) return;
        try {
            const n = await api('universen', 'POST', { name: name.trim() });
            location.hash = `#/universum/${n.id}/bearbeiten`;
        } catch (x) { meldung(x.message, true); }
    };
    return el('div.seite',
        el('div.bib-kopf',
            el('div', el('h1', 'Universen'), el('p', 'Filme und Serien, die zusammengehören – jeder Titel einzeln, in deiner Reihenfolge.')),
            admin ? el('div.werkzeuge', { style: { marginLeft: 'auto' } }, el('button.knopf.haupt', { onclick: neu }, icon('plus'), 'Neues Universum')) : null),
        d.universen.length ? el('div.universum-karten', d.universen.map((u) => el('a.universum-karte' + (u.eigenes_poster ? '.mit-poster' : ''), { href: `#/universum/${u.id}` },
            u.eigenes_poster ? el('div.karten-poster', el('img', { src: u.eigenes_poster, alt: '', loading: 'lazy' })) : collage(u.collage, 6),
            el('div.t',
                el('small', 'UNIVERSUM'),
                el('b', u.name),
                el('div.z', [u.filme ? anzahl(u.filme, 'Film', 'Filme') : null, u.serien ? anzahl(u.serien, 'Serie', 'Serien') : null,
                    u.von ? (u.bis && u.bis !== u.von ? `${u.von}–${u.bis}` : String(u.von)) : null].filter(Boolean).join(' · ') || 'Noch leer'),
                u.eintraege ? el('div', { style: { marginTop: '16px' } },
                    el('div.balken-klein', { style: { margin: 0 } }, el('span', { style: { width: Math.round((u.gesehen / u.eintraege) * 100) + '%' } })),
                    el('div.leise', { style: { fontSize: '0.82rem', marginTop: '6px' } }, `${u.gesehen} von ${u.eintraege} gesehen`)) : null))))
            : el('div.leer', el('h2', 'Noch keine Universen'),
                el('p', 'Universen fassen Filme und Serien zusammen – zum Beispiel das Marvel Cinematic Universe. Reihen kannst du komplett hinzufügen, ihre Filme erscheinen dann einzeln.'),
                admin ? el('button.knopf.haupt', { onclick: neu }, icon('plus'), 'Universum anlegen') : null));
}

// ---------- Ansicht ----------
async function universum(id, r, app) {
    const gemerkt = app.sortierung('universum:' + id, 'eigen');
    const sort = (r.query.get('sort') || gemerkt) === 'erscheinung' ? 'erscheinung' : 'eigen';
    if (r.query.get('sort')) app.sortierungMerken('universum:' + id, sort);
    const d = await api(`universum/${id}?sort=${sort}`);
    letzterTitel = d.name;
    const admin = app.konto.rolle === 'admin';
    const z = d.zahlen;
    const n = d.naechstes;

    const naechstesBox = n ? el('div.naechstes-box',
        el('small', z.gesehen ? 'ALS NÄCHSTES IM UNIVERSUM' : 'HIER ANFANGEN'),
        el('div.reihe',
            el('a.p', { href: zielLink(n) }, bild(n.poster, n.titel)),
            el('div', el('b', n.titel),
                el('div.z', [`Nr. ${n.nr}`, n.art === 'serie' ? `Serie · ${n.folge.kennung}` : 'Film', n.jahr].filter(Boolean).join(' · ')),
                n.prozent ? el('div.balken-klein', { style: { margin: '10px 0 0' } }, el('span', { style: { width: n.prozent + '%' } })) : null)),
        el('button.knopf.weiss', { onclick: () => app.abspielen(n.art === 'serie' ? { art: 'folge', id: n.folge.id } : { art: 'film', id: n.id }) },
            icon('play'), n.prozent ? 'Weiterschauen' : 'Abspielen')) : null;

    const jahre = z.von ? (z.bis && z.bis !== z.von ? `${z.von}–${z.bis}` : String(z.von)) : null;
    const heroEl = el('section.universum-hero' + (d.eigener_hintergrund ? '.mit-hintergrund' : ''),
        d.eigener_hintergrund ? el('div.hg', { style: { backgroundImage: `url("${d.eigener_hintergrund}")` } })
            : collage(d.bild ? [d.bild, ...d.collage] : d.collage, 18),
        el('div.inhalt',
            el('div.links',
                el('div.augenbraue', 'Universum'),
                el('h1', d.name),
                d.beschreibung ? el('p', d.beschreibung) : null,
                el('div.zahlen',
                    el('div', el('b', String(z.filme)), el('small', z.filme === 1 ? 'Film' : 'Filme')),
                    z.serien ? el('div', el('b', String(z.serien)), el('small', z.serien === 1 ? 'Serie' : 'Serien')) : null,
                    jahre ? el('div', el('b', jahre), el('small', 'Zeitraum')) : null,
                    el('div', el('b', String(z.gesehen), el('span', ` / ${z.gesamt}`)), el('small', 'gesehen'))),
                admin ? el('div.knoepfe', { style: { marginTop: '24px' } }, el('a.knopf', { href: `#/universum/${id}/bearbeiten` }, icon('bearbeiten'), 'Bearbeiten')) : null),
            naechstesBox));

    // Filter laufen im Browser, die Reihenfolge kommt vom Server
    let filter = 'alle';
    const inhalt = el('div.seite');
    const zeichnen = () => {
        const passt = (t) => filter === 'alle' || (filter === 'film' && t.art === 'film') || (filter === 'serie' && t.art === 'serie') || (filter === 'ungesehen' && !t.gesehen);
        // Abschnitte bleiben sichtbar, wenn sie selbst oder ein Unterabschnitt passende Titel haben
        const alle = d.abschnitte.map((g) => ({ ...g, titel: g.titel.filter(passt) }));
        const sichtbar = alle.map(() => false);
        for (let i = alle.length - 1; i >= 0; i--) {
            if (alle[i].titel.length) sichtbar[i] = true;
            if (sichtbar[i]) {
                let grenze = alle[i].tiefe || 0;
                for (let j = i - 1; j >= 0 && grenze > 0; j--) {
                    if (alle[j].id !== null && alle[j].tiefe < grenze) { sichtbar[j] = true; grenze = alle[j].tiefe; }
                }
            }
        }
        const gruppen = alle.filter((g, i) => sichtbar[i]);
        const kopf = (g) => {
            const t = g.tiefe || 0;
            return el('div.abschnitt-kopf.tiefe-' + Math.min(t, 3), el(t ? 'h3' : 'h2', g.name), el('span.leise', g.info), el('span.linie'));
        };
        inhalt.replaceChildren(...(gruppen.length ? gruppen.map((g) => el('section' + (g.tiefe ? '.unterabschnitt' : ''),
            g.name ? kopf(g) : el('div', { style: { height: '30px' } }),
            !g.titel.length ? null : el('div.raster', g.titel.map((t) => el('a.kachel' + (t.gesehen ? '.gesehen-ab' : ''), { href: zielLink(t), title: t.titel },
                el('div.bild', bild(t.poster, t.titel) || el('div.ersatz', t.titel),
                    el('span.nr-marke', String(t.nr)),
                    el('span.art-marke' + (t.art === 'serie' ? '.serie' : ''), t.art === 'serie' ? (t.staffel ? 'STAFFEL ' + t.staffel : 'SERIE') : 'FILM'),
                    t.gesehen ? el('span.gesehen-haken.unten', icon('haken')) : null,
                    !t.gesehen && t.prozent > 1 ? el('div.fortschritt', el('span', { style: { width: t.prozent + '%' } })) : null),
                el('div.titel', t.titel),
                el('div.zusatz', [t.zusatz, t.vorhanden ? null : 'nicht vorhanden'].filter(Boolean).join(' · '))))))) 
            : [el('div.leer', el('p', z.gesamt ? 'Mit diesem Filter gibt es hier nichts.' : 'Dieses Universum ist noch leer.'),
                admin && !z.gesamt ? el('a.knopf.haupt', { href: `#/universum/${id}/bearbeiten` }, icon('plus'), 'Titel hinzufügen') : null)]));
    };
    const filterPillen = [['alle', 'Alle'], ['film', 'Filme'], ['serie', 'Serien'], ['ungesehen', 'Ungesehen']].map(([w, t]) => {
        const b = el('button.pille' + (w === filter ? '.an' : ''), { onclick: () => {
            filter = w;
            filterPillen.forEach((x) => x.classList.toggle('an', x === b));
            zeichnen();
        } }, t);
        return b;
    });
    zeichnen();
    const steuer = el('div.steuerleiste',
        el('span.beschr', 'Reihenfolge'),
        el('a.pille' + (sort === 'eigen' ? '.an' : ''), { href: `#/universum/${id}?sort=eigen`, onclick: (e) => { e.preventDefault(); location.replace(e.currentTarget.getAttribute('href')); } }, 'Eigene'),
        el('a.pille' + (sort === 'erscheinung' ? '.an' : ''), { href: `#/universum/${id}?sort=erscheinung`, onclick: (e) => { e.preventDefault(); location.replace(e.currentTarget.getAttribute('href')); } }, 'Erscheinung'),
        el('span.trenner'),
        el('span.beschr', 'Zeigen'),
        filterPillen);
    return el('div', heroEl, steuer, inhalt, el('div', { style: { height: '40px' } }));
}

// ---------- Editor ----------
async function editor(id, app) {
    let d = await api(`universum/${id}?sort=eigen`);
    letzterTitel = d.name + ' bearbeiten';
    const seite = el('div.seite');
    let ziehen = null; // eintrag_id, der gerade gezogen wird
    const markiert = new Set(); // Mehrfachauswahl (eintrag_id)
    // eingeklappte Abschnitte (pro Universum auf diesem Gerät gemerkt)
    const zuSchluessel = `bluewave.eingeklappt.${id}`;
    let zu = new Set();
    try { zu = new Set(JSON.parse(localStorage.getItem(zuSchluessel) || '[]')); } catch { /* privat */ }
    const zuMerken = () => { try { localStorage.setItem(zuSchluessel, JSON.stringify([...zu])); } catch { /* privat */ } };
    const gKey = (g, gi) => (gi === 0 ? 'ohne' : g.id ? String(g.id) : 'neu' + gi);
    let letzteMarke = null;

    // Gruppen in bearbeitbare Form: [{id, name, eintraege: [titel…]}], erste Gruppe = ohne Abschnitt
    let gruppen = [];
    const ausDaten = () => {
        const ohne = d.abschnitte.find((g) => g.id === null);
        gruppen = [{ id: null, name: null, tiefe: -1, eintraege: ohne ? [...ohne.titel] : [] },
            ...d.abschnitte.filter((g) => g.id !== null).map((g) => ({ id: g.id, name: g.name, tiefe: g.tiefe || 0, eintraege: [...g.titel] }))];
    };
    ausDaten();

    const neuLaden = async () => {
        d = await api(`universum/${id}?sort=eigen`);
        ausDaten();
        const da = new Set(gruppen.flatMap((g) => g.eintraege.map((t) => t.eintrag_id)));
        [...markiert].forEach((m) => { if (!da.has(m)) markiert.delete(m); });
        zeichnen();
    };
    const ordnungSpeichern = async () => {
        try {
            await api(`universum/${id}/ordnung`, 'PUT', { ohne: gruppen[0].eintraege.map((t) => t.eintrag_id), abschnitte: baum() });
            await neuLaden();
        } catch (x) { meldung(x.message, true); }
    };
    // ---- Gliederung: flache Liste mit Tiefe ⇄ Baum ----
    const baum = () => {
        const wurzel = [];
        const stapel = [{ tiefe: -1, unter: wurzel }];
        for (const g of gruppen.slice(1)) {
            while (stapel.length > 1 && stapel[stapel.length - 1].tiefe >= g.tiefe) stapel.pop();
            const knoten = { id: g.id, name: g.name, eintraege: g.eintraege.map((t) => t.eintrag_id), unter: [] };
            stapel[stapel.length - 1].unter.push(knoten);
            stapel.push({ tiefe: g.tiefe, unter: knoten.unter });
        }
        return wurzel;
    };
    const ende = (gi) => { // Index hinter dem Unterbaum von gi
        let j = gi + 1;
        while (j < gruppen.length && gruppen[j].tiefe > gruppen[gi].tiefe) j++;
        return j;
    };
    const elternVon = (gi) => { for (let j = gi - 1; j >= 1; j--) if (gruppen[j].tiefe < gruppen[gi].tiefe) return j; return 0; };
    const vorigerGeschwister = (gi) => { for (let j = gi - 1; j >= 1; j--) { if (gruppen[j].tiefe === gruppen[gi].tiefe) return j; if (gruppen[j].tiefe < gruppen[gi].tiefe) return -1; } return -1; };
    const naechsterGeschwister = (gi) => { const j = ende(gi); return j < gruppen.length && gruppen[j].tiefe === gruppen[gi].tiefe ? j : -1; };
    const abschnittHoch = (gi) => {
        const v = vorigerGeschwister(gi);
        if (v < 0) return;
        const block = gruppen.splice(gi, ende(gi) - gi);
        gruppen.splice(v, 0, ...block);
        ordnungSpeichern();
    };
    const abschnittRunter = (gi) => {
        const n = naechsterGeschwister(gi);
        if (n >= 0) abschnittHoch(n);
    };
    const einruecken = (gi) => { // wird Unterabschnitt des vorigen Abschnitts gleicher Ebene
        if (vorigerGeschwister(gi) < 0 || gruppen[gi].tiefe >= 4) return;
        for (let j = gi; j < ende(gi); j++) gruppen[j].tiefe++;
        ordnungSpeichern();
    };
    const ausruecken = (gi) => {
        if (gruppen[gi].tiefe <= 0) return;
        // folgende Geschwister werden zu Kindern (damit die Reihenfolge erhalten bleibt)
        const e = ende(gi);
        let j = e;
        const t = gruppen[gi].tiefe;
        while (j < gruppen.length && gruppen[j].tiefe >= t) j++;
        const block = gruppen.splice(gi, e - gi);
        block.forEach((g) => { g.tiefe--; });
        gruppen.splice(j - block.length, 0, ...block);
        ordnungSpeichern();
    };
    const unterabschnitt = (gi) => {
        gruppen.splice(ende(gi), 0, { id: null, name: 'Neuer Unterabschnitt', tiefe: gruppen[gi].tiefe + 1, eintraege: [] });
        ordnungSpeichern();
    };
    const aufloesen = (gi) => { // Titel wandern in den übergeordneten Abschnitt, Unterabschnitte rücken eine Ebene hoch
        const e = elternVon(gi);
        for (let j = gi + 1; j < ende(gi); j++) gruppen[j].tiefe--;
        const [weg] = gruppen.splice(gi, 1);
        gruppen[e].eintraege.push(...weg.eintraege);
        ordnungSpeichern();
    };
    const gruppenName = (g, gi) => (gi === 0 ? 'Ohne Abschnitt' : '\u2003'.repeat(g.tiefe) + (g.tiefe ? '└ ' : '') + (g.name || `Abschnitt ${gi}`));

    const verschieben = (eid, zielGruppe, vorEid = null) => {
        // ist der gezogene Titel markiert, wandern alle markierten mit (in ihrer Reihenfolge)
        const ids = markiert.has(eid) ? gruppen.flatMap((g) => g.eintraege.map((t) => t.eintrag_id)).filter((m) => markiert.has(m)) : [eid];
        if (vorEid !== null && ids.includes(vorEid)) return;
        const titel = [];
        for (const g of gruppen) {
            for (let i = g.eintraege.length - 1; i >= 0; i--) {
                if (ids.includes(g.eintraege[i].eintrag_id)) titel.unshift(...g.eintraege.splice(i, 1));
            }
        }
        titel.sort((a, b) => ids.indexOf(a.eintrag_id) - ids.indexOf(b.eintrag_id));
        if (!titel.length) return;
        const ziel = gruppen[zielGruppe];
        const j = vorEid === null ? -1 : ziel.eintraege.findIndex((t) => t.eintrag_id === vorEid);
        if (j >= 0) ziel.eintraege.splice(j, 0, ...titel); else ziel.eintraege.push(...titel);
        ordnungSpeichern();
    };
    const schritt = (gi, i, rich) => {
        const g = gruppen[gi];
        const j = i + rich;
        if (j >= 0 && j < g.eintraege.length) {
            [g.eintraege[i], g.eintraege[j]] = [g.eintraege[j], g.eintraege[i]];
            ordnungSpeichern();
        } else if (gruppen[gi + rich]) {
            // über den Rand: in den Nachbar-Abschnitt
            const [t] = g.eintraege.splice(i, 1);
            if (rich < 0) gruppen[gi - 1].eintraege.push(t); else gruppen[gi + 1].eintraege.unshift(t);
            ordnungSpeichern();
        }
    };

    // linke Spalte: Stammdaten + Abschnitte
    const nameIn = el('input.eingabe', { value: d.name, 'aria-label': 'Name' });
    const beschrIn = el('textarea.eingabe', { rows: 3, placeholder: 'Kurze Beschreibung (optional)' }, d.beschreibung || '');
    let bildWahl = d.bild;
    const linkFeld = (typ, text) => {
        const eingabe = el('input.eingabe', { type: 'url', placeholder: 'https://theposterdb.com/api/assets/…', spellcheck: 'false' });
        const knopf = el('button.knopf', { onclick: async () => {
            if (!eingabe.value.trim()) return;
            knopf.classList.add('laedt');
            try {
                const r = await api('poster', 'POST', { art: 'universum', id, typ, url: eingabe.value.trim() });
                meldung(typ === 'poster' ? 'Poster gespeichert.' : 'Hintergrund gespeichert.');
                if (typ === 'poster') bildWahl = r.poster;
                await neuLaden();
            } catch (x) { meldung(x.message, true); } finally { knopf.classList.remove('laedt'); }
        } }, 'Übernehmen');
        eingabe.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); knopf.click(); } });
        return el('div', { style: { marginTop: '14px' } }, el('label.bearb-label', text), el('div.link-zeile', eingabe, knopf));
    };
    const stamm = () => {
        const poster = [...new Map(d.abschnitte.flatMap((g) => g.titel).filter((t) => t.poster).map((t) => [t.poster, t])).values()].slice(0, 24);
        const wahl = el('div.bild-wahl',
            el('button' + (!bildWahl ? '.an' : ''), { title: 'Automatisch', style: { display: 'grid', placeItems: 'center', color: 'var(--text-leise)', fontSize: '0.8rem', fontWeight: 700 },
                onclick: () => { bildWahl = null; zeichnen(); } }, 'Auto'),
            poster.map((t) => el('button' + (bildWahl === t.poster ? '.an' : ''), { title: t.titel, onclick: () => { bildWahl = t.poster; zeichnen(); } }, el('img', { src: t.poster, alt: t.titel, loading: 'lazy' }))));
        return el('div.editor-karte',
            el('div', { style: { display: 'grid', gap: '12px' } }, nameIn, beschrIn),
            el('h3', { style: { margin: '20px 0 10px', fontSize: '1rem' } }, 'Titelbild'),
            wahl,
            linkFeld('poster', 'Eigenes Poster per Link (z. B. ein Collection-Poster von ThePosterDB)'),
            linkFeld('hintergrund', 'Eigener Hintergrund per Link'),
            el('div.knoepfe', { style: { marginTop: '16px' } },
                el('button.knopf.haupt', { onclick: async () => {
                    try {
                        await api(`universum/${id}`, 'PUT', { name: nameIn.value, beschreibung: beschrIn.value, bild: bildWahl || '' });
                        meldung('Gespeichert.');
                        d.name = nameIn.value;
                    } catch (x) { meldung(x.message, true); }
                } }, icon('haken'), 'Speichern'),
                el('a.knopf', { href: `#/universum/${id}` }, 'Zur Ansicht')));
    };

    const eintragZeile = (t, gi, i, nr) => {
        const marke = el('input.marke', { type: 'checkbox', checked: markiert.has(t.eintrag_id), 'aria-label': 'Auswählen', onclick: (e) => {
            const flach = gruppen.flatMap((g) => g.eintraege.map((x) => x.eintrag_id));
            if (e.shiftKey && letzteMarke !== null) {
                const [a, b] = [flach.indexOf(letzteMarke), flach.indexOf(t.eintrag_id)].sort((x, y) => x - y);
                flach.slice(a, b + 1).forEach((m) => { if (e.target.checked) markiert.add(m); else markiert.delete(m); });
            } else if (e.target.checked) markiert.add(t.eintrag_id); else markiert.delete(t.eintrag_id);
            letzteMarke = t.eintrag_id;
            markierungZeigen();
        } });
        const z = el('div.eintrag' + (markiert.has(t.eintrag_id) ? '.markiert' : ''), { draggable: 'true', 'data-eid': t.eintrag_id },
            marke,
            el('span.griff', { title: 'Ziehen zum Verschieben' }, icon('verwaltung')),
            el('span.nr', String(nr)),
            t.poster ? el('img', { src: t.poster, alt: '', loading: 'lazy' }) : el('span.p'),
            el('div.mitte', el('b', t.titel), el('span', [t.jahr, t.vorhanden ? null : 'nicht vorhanden'].filter(Boolean).join(' · '))),
            el('span.art-marke' + (t.art === 'serie' ? '.serie' : ''), t.art === 'serie' ? (t.staffel ? 'STAFFEL' : 'SERIE') : 'FILM'),
            t.art === 'serie' && (t.staffel || t.staffeln > 1) ? el('button.chip-klein', {
                title: t.staffel ? 'Alle Staffeln wieder zu einem Eintrag zusammenführen' : 'Für die Watch-Order in einzelne Staffeln aufteilen (lassen sich dann einzeln verschieben)',
                onclick: async () => {
                    try {
                        const r = await api(`universum/${id}/eintrag/${t.eintrag_id}/staffeln`, 'POST', { teilen: !t.staffel });
                        meldung(t.staffel ? `„${t.serie_titel}“ wieder als ganze Serie.` : `„${t.serie_titel}“ in ${r.eintraege} Staffeln aufgeteilt.`);
                        neuLaden();
                    } catch (x) { meldung(x.message, true); }
                } }, t.staffel ? 'Zusammenführen' : 'In Staffeln') : null,
            el('button.mini-knopf', { title: 'Nach oben', onclick: () => schritt(gi, i, -1) }, icon('hoch')),
            el('button.mini-knopf', { title: 'Nach unten', onclick: () => schritt(gi, i, 1) }, icon('runter')),
            el('button.mini-knopf', { title: 'Aus dem Universum entfernen', onclick: async () => {
                await api(`universum/${id}/eintrag/${t.eintrag_id}`, 'DELETE');
                meldung(`„${t.titel}“ entfernt.`);
                neuLaden();
            } }, icon('schliessen')));
        z.addEventListener('dragstart', (e) => { ziehen = t.eintrag_id; z.classList.add('zieht'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(t.eintrag_id)); });
        z.addEventListener('dragend', () => { z.classList.remove('zieht'); ziehen = null; });
        z.addEventListener('dragover', (e) => { if (ziehen && ziehen !== t.eintrag_id) { e.preventDefault(); z.classList.add('drueber'); } });
        z.addEventListener('dragleave', () => z.classList.remove('drueber'));
        z.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            z.classList.remove('drueber');
            if (ziehen && ziehen !== t.eintrag_id) verschieben(ziehen, gi, t.eintrag_id);
        });
        return z;
    };

    const abschnitteEl = () => {
        let nr = 0;
        let verstecktUnter = null; // Tiefe eines eingeklappten Abschnitts, dessen Unterabschnitte ausgeblendet sind
        return gruppen.map((g, gi) => {
            if (gi > 0 && verstecktUnter !== null) {
                if (g.tiefe > verstecktUnter) { nr += g.eintraege.length; return null; }
                verstecktUnter = null;
            }
            if (gi === 0 && !g.eintraege.length && gruppen.length > 1) return null;
            const eingeklappt = zu.has(gKey(g, gi));
            if (eingeklappt && gi > 0) verstecktUnter = g.tiefe;
            const umschalter = el('button.mini-knopf.klapp' + (eingeklappt ? '.zu' : ''), { title: eingeklappt ? 'Aufklappen' : 'Einklappen', 'aria-expanded': String(!eingeklappt), onclick: () => {
                if (eingeklappt) zu.delete(gKey(g, gi)); else zu.add(gKey(g, gi));
                zuMerken();
                zeichnen();
            } }, icon('weiter'));
            const box = el('div.abschnitt-box' + (gi > 0 && g.tiefe > 0 ? '.unter' : ''), { style: { marginLeft: gi > 0 ? `calc(${g.tiefe} * var(--einzug))` : 0 } },
                el('div.kopf-a',
                    umschalter,
                    g.id === null && gi === 0
                        ? el('b', { style: { padding: '6px 8px', fontFamily: 'var(--font-display)' } }, gruppen.length > 1 ? 'Ohne Abschnitt' : 'Titel')
                        : el('input', { value: g.name || '', 'aria-label': 'Name des Abschnitts', onchange: (e) => { g.name = e.target.value; ordnungSpeichern(); } }),
                    el('span.leise', { style: { fontSize: '0.82rem', whiteSpace: 'nowrap' } }, (() => {
                        const unter = gi > 0 ? gruppen.slice(gi + 1, ende(gi)).reduce((n, x) => n + x.eintraege.length, 0) : 0;
                        return anzahl(g.eintraege.length + unter, 'Titel', 'Titel') + (unter && !g.eintraege.length ? ' darunter' : '');
                    })()),
                    g.eintraege.length ? el('button.mini-knopf', { title: 'Alle in diesem Abschnitt auswählen', onclick: () => {
                        const alle = g.eintraege.every((t) => markiert.has(t.eintrag_id));
                        g.eintraege.forEach((t) => (alle ? markiert.delete(t.eintrag_id) : markiert.add(t.eintrag_id)));
                        markierungZeigen();
                    } }, icon('haken')) : null,
                    gi > 0 && vorigerGeschwister(gi) >= 0 ? el('button.mini-knopf', { title: 'Abschnitt nach oben (samt Unterabschnitten)', onclick: () => abschnittHoch(gi) }, icon('hoch')) : null,
                    gi > 0 && naechsterGeschwister(gi) >= 0 ? el('button.mini-knopf', { title: 'Abschnitt nach unten (samt Unterabschnitten)', onclick: () => abschnittRunter(gi) }, icon('runter')) : null,
                    gi > 0 && g.tiefe > 0 ? el('button.mini-knopf', { title: 'Eine Ebene höher', onclick: () => ausruecken(gi) }, icon('links')) : null,
                    gi > 0 && vorigerGeschwister(gi) >= 0 && g.tiefe < 4 ? el('button.mini-knopf', { title: 'Einrücken (wird Unterabschnitt des Abschnitts darüber)', onclick: () => einruecken(gi) }, icon('rechts')) : null,
                    gi > 0 && g.tiefe < 4 ? el('button.mini-knopf', { title: 'Unterabschnitt anlegen', onclick: () => unterabschnitt(gi) }, icon('plus')) : null,
                    gi > 0 ? el('button.mini-knopf', { title: 'Abschnitt auflösen (Titel wandern eine Ebene höher)', onclick: () => aufloesen(gi) }, icon('loeschen')) : null),
                eingeklappt ? (() => { nr += g.eintraege.length; return null; })()
                    : g.eintraege.length ? g.eintraege.map((t, i) => eintragZeile(t, gi, i, ++nr))
                    : gi > 0 && gruppen[gi + 1]?.tiefe > g.tiefe ? el('div.leer-hinweis', { style: { padding: '8px 16px' } }, 'Titel stehen in den Unterabschnitten – oder zieh welche direkt hierher.')
                        : el('div.leer-hinweis', 'Leer – zieh Titel hierher oder füge sie rechts hinzu.'));
            box.addEventListener('dragover', (e) => { if (ziehen) { e.preventDefault(); box.classList.add('ziel'); } });
            box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove('ziel'); });
            box.addEventListener('drop', (e) => {
                e.preventDefault();
                box.classList.remove('ziel');
                if (ziehen) verschieben(ziehen, gi, null);
            });
            return box;
        });
    };

    // rechte Spalte: Suche, Vorschläge, Gefahr
    let reiter = '';
    let suchText = '';
    const trefferEl = el('div', { style: { marginTop: '12px', maxHeight: '420px', overflowY: 'auto' } });
    const suchen = async () => {
        const p = new URLSearchParams({ q: suchText, u: id });
        if (reiter) p.set('art', reiter);
        try {
            const t = await api('auswahl?' + p);
            const offen = t.treffer.filter((x) => !x.drin);
            const alleKnopf = offen.length > 1 ? el('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: '6px' } },
                el('button.knopf.klein', { onclick: async () => {
                    const letzter = gruppen.length > 1 ? gruppen[gruppen.length - 1].id : null;
                    const r = await api(`universum/${id}/liste`, 'POST', { titel: offen.map((x) => ({ art: x.art, id: x.id })), abschnitt_id: letzter });
                    meldung(`${anzahl(r.hinzugefuegt, 'Titel', 'Titel')} hinzugefügt.`);
                    await neuLaden();
                    suchen();
                } }, icon('plus'), `Alle ${offen.length} Treffer hinzufügen`)) : null;
            trefferEl.replaceChildren(...(alleKnopf ? [alleKnopf] : []), ...(t.treffer.length ? t.treffer.map((x) => el('div.treffer',
                x.poster ? el('img', { src: x.poster, alt: '', loading: 'lazy' }) : el('span.p'),
                el('div.mitte', el('b', x.titel), el('span', x.zusatz)),
                el('button.knopf-dazu', { disabled: x.drin, onclick: async (e) => {
                    e.target.disabled = true;
                    const letzter = gruppen.length > 1 ? gruppen[gruppen.length - 1].id : null;
                    const r = await api(`universum/${id}/eintraege`, 'POST', { art: x.art, id: x.id, abschnitt_id: letzter });
                    meldung(x.art === 'reihe' ? `${anzahl(r.hinzugefuegt, 'Film', 'Filme')} aus „${x.titel}“ einzeln hinzugefügt.` : `„${x.titel}“ hinzugefügt.`);
                    await neuLaden();
                    suchen();
                } }, x.drin ? 'Drin' : '+ Dazu'))) : [el('p.leise', 'Keine Treffer.')]));
        } catch (x) { trefferEl.replaceChildren(el('p.schlecht', x.message)); }
    };
    let suchTimer = null;
    const suchFeld = el('input.eingabe', { type: 'search', placeholder: 'Filme, Serien, Reihen suchen …', oninput: (e) => {
        suchText = e.target.value;
        clearTimeout(suchTimer);
        suchTimer = setTimeout(suchen, 250);
    } });
    const reiterEl = el('div.segment', { style: { marginTop: '12px' } }, [['', 'Alle'], ['film', 'Filme'], ['serie', 'Serien'], ['reihe', 'Reihen']].map(([w, t]) => {
        const b = el('button' + (w === reiter ? '.an' : ''), { onclick: () => {
            reiter = w;
            reiterEl.querySelectorAll('button').forEach((x) => x.classList.toggle('an', x === b));
            suchen();
        } }, t);
        return b;
    }));
    const vorschlagEl = el('div');
    const vorschlaegeLaden = async () => {
        try {
            const v = (await api(`universum/${id}/vorschlaege`)).vorschlaege;
            vorschlagEl.replaceChildren(...(v.length ? [
                el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
                    el('h3', { style: { margin: 0, fontSize: '1rem' } }, 'Vorschläge'), el('span.leise', { style: { fontSize: '0.82rem' } }, String(v.length)),
                    el('button.knopf.klein', { style: { marginLeft: 'auto' }, onclick: async () => {
                        const r = await api(`universum/${id}/liste`, 'POST', { titel: v.map((x) => ({ art: x.art, id: x.id })) });
                        meldung(`${anzahl(r.hinzugefuegt, 'Titel', 'Titel')} hinzugefügt.`);
                        neuLaden();
                    } }, 'Alle hinzufügen')),
                el('div', { style: { marginTop: '10px' } }, v.slice(0, 12).map((x) => el('div.treffer',
                    x.poster ? el('img', { src: x.poster, alt: '', loading: 'lazy' }) : el('span.p'),
                    el('div.mitte', el('b', x.titel), el('span', [x.jahr, x.grund].filter(Boolean).join(' · '))),
                    el('button.knopf-dazu', { onclick: async () => {
                        await api(`universum/${id}/eintraege`, 'POST', { art: x.art, id: x.id });
                        meldung(`„${x.titel}“ hinzugefügt.`);
                        neuLaden();
                    } }, '+ Dazu'))))] : [el('h3', { style: { margin: 0, fontSize: '1rem' } }, 'Vorschläge'),
                el('p.leise', { style: { fontSize: '0.88rem', margin: '8px 0 0' } }, 'Gerade nichts – Vorschläge kommen aus Reihen und typischen TMDB-Stichwörtern der Titel.')]));
        } catch { vorschlagEl.replaceChildren(); }
    };

    const auswahlLeiste = () => {
        if (!markiert.size) return null;
        const ziel = el('select', { 'aria-label': 'Ziel-Abschnitt' },
            gruppen.map((g, gi) => el('option', { value: gi }, gruppenName(g, gi))),
            el('option', { value: 'neu' }, '+ Neuer Abschnitt'));
        ziel.value = String(gruppen.length > 1 ? gruppen.length - 1 : 0);
        return el('div.editor-auswahl.glass-panel',
            el('b', markiert.size === 1 ? '1 ausgewählt' : `${markiert.size} ausgewählt`),
            el('span.leise', { style: { fontSize: '0.85rem' } }, 'verschieben nach'), ziel,
            el('button.knopf.klein.haupt', { onclick: () => {
                let gi = ziel.value;
                if (gi === 'neu') {
                    const name = prompt('Name des neuen Abschnitts', `Abschnitt ${gruppen.length}`);
                    if (!name) return;
                    gruppen.push({ id: null, name, tiefe: 0, eintraege: [] });
                    gi = gruppen.length - 1;
                }
                verschieben([...markiert][0], Number(gi), null);
                markiert.clear();
            } }, 'Verschieben'),
            el('button.knopf.klein.gefahr', { onclick: async () => {
                if (!await bestaetigen('Aus dem Universum entfernen', `${anzahl(markiert.size, 'Titel', 'Titel')} aus „${d.name}“ entfernen? Die Filme und Serien selbst bleiben erhalten.`, 'Entfernen', true)) return;
                const r = await api(`universum/${id}/eintraege`, 'DELETE', { ids: [...markiert] });
                meldung(`${anzahl(r.entfernt, 'Titel', 'Titel')} entfernt.`);
                markiert.clear();
                neuLaden();
            } }, icon('loeschen'), 'Entfernen'),
            el('button.mini-knopf', { title: 'Auswahl aufheben', style: { marginLeft: 'auto' }, onclick: () => { markiert.clear(); markierungZeigen(); } }, icon('schliessen')));
    };
    // Häkchen ändern nur Klassen und die Leiste – kein Neuzeichnen, kein Springen
    const leisteHalter = el('div');
    const markierungZeigen = () => {
        seite.querySelectorAll('.eintrag[data-eid]').forEach((z) => {
            const an = markiert.has(Number(z.dataset.eid));
            z.classList.toggle('markiert', an);
            const c = z.querySelector('input.marke');
            if (c) c.checked = an;
        });
        leisteHalter.replaceChildren(...[auswahlLeiste()].filter(Boolean));
    };

    const zeichnen = () => {
        const gesamt = gruppen.reduce((s, g) => s + g.eintraege.length, 0);
        const y = window.scrollY;
        leisteHalter.replaceChildren(...[auswahlLeiste()].filter(Boolean));
        seite.replaceChildren(
            el('div.bib-kopf',
                el('div', el('div.augenbraue', 'Universum bearbeiten'), el('h1', d.name), el('p', `${anzahl(gesamt, 'Titel', 'Titel')} · Reihen kommen als einzelne Filme hinein`)),
                el('div.werkzeuge', { style: { marginLeft: 'auto' } },
                    el('button.knopf', { onclick: async () => {
                        if (!await bestaetigen('Nach Erscheinung sortieren', 'Die Titel werden innerhalb jedes Abschnitts nach dem Erscheinungsdatum sortiert. Die bisherige eigene Reihenfolge geht dabei verloren.', 'Sortieren')) return;
                        await api(`universum/${id}/sortieren`, 'POST');
                        neuLaden();
                    } }, 'Nach Erscheinung sortieren'),
                gruppen.length > 1 ? el('button.knopf', { onclick: () => {
                        const alleZu = gruppen.every((g, gi) => (gi === 0 && !g.eintraege.length) || zu.has(gKey(g, gi)));
                        zu = alleZu ? new Set() : new Set(gruppen.map((g, gi) => gKey(g, gi)));
                        zuMerken();
                        zeichnen();
                    } }, gruppen.every((g, gi) => (gi === 0 && !g.eintraege.length) || zu.has(gKey(g, gi))) ? 'Alle aufklappen' : 'Alle einklappen') : null,
                    el('button.knopf', { onclick: () => {
                        gruppen.push({ id: null, name: `Abschnitt ${gruppen.length}`, tiefe: 0, eintraege: [] });
                        ordnungSpeichern();
                    } }, icon('plus'), 'Abschnitt'))),
            el('div.editor',
                el('div.links', stamm(), el('div', { style: { height: '18px' } }), leisteHalter, abschnitteEl()),
                el('aside',
                    el('div.editor-karte', el('h3', { style: { margin: 0, fontSize: '1rem' } }, 'Hinzufügen'), el('div', { style: { marginTop: '12px' } }, suchFeld), reiterEl, trefferEl),
                    el('div.editor-karte.vorschlag', vorschlagEl),
                    el('div.editor-karte', el('button.knopf.gefahr', { onclick: async () => {
                        if (!await bestaetigen('Universum löschen', `„${d.name}“ wird gelöscht. Die Filme und Serien selbst bleiben erhalten.`, 'Löschen', true)) return;
                        await api(`universum/${id}`, 'DELETE');
                        meldung('Universum gelöscht.');
                        location.hash = '#/universen';
                    } }, icon('loeschen'), 'Universum löschen')))));
        window.scrollTo(0, y);
        vorschlaegeLaden();
    };
    zeichnen();
    suchen();
    return seite;
}

// ---------- Reihe ----------
async function reihe(id, app) {
    const d = await api('reihe/' + id);
    letzterTitel = d.name;
    const admin = app?.konto.rolle === 'admin';
    return el('div',
        hero({ ...d, titel: d.name, logo: null }, admin ? el('div.knoepfe',
            el('button.knopf', { onclick: () => bearbeitenDialog('reihe', id) }, icon('bearbeiten'), 'Bearbeiten'),
            el('button.knopf', { onclick: () => bearbeitenDialog('reihe', id, { bilderStaffel: true }) }, icon('bild'), 'Poster')) : null,
            [el('div.meta', el('span', 'Reihe'), el('span.trenn'), el('span', anzahl(d.filme.length, 'Film', 'Filme'))),
            el('div.chips', d.universen.map((u) => el('a.chip.akzent', { href: `#/universum/${u.id}` }, icon('universum'), u.name))),
            d.beschreibung ? el('p.text', d.beschreibung) : null], el('div.augenbraue', 'Reihe')),
        el('div.seite', el('div.raster', d.filme.map(kachel))));
}
