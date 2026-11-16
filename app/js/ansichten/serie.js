// Serienseite: Titelbild, Weiterschauen, Episodenreihenfolge, Staffeln, Folgen
'use strict';
import { el, icon, bild, meldung, auswahl } from '../ui.js';
import { api } from '../api.js';
import { hero, besetzung, tmdbZuordnen } from './film.js';

let letzterTitel = 'Serie';
export const titel = () => letzterTitel + ' – Bluewave';

const STATUS = { laufend: 'Läuft', beendet: 'Beendet', abgesetzt: 'Abgesetzt', geplant: 'Geplant' };

export async function zeigen(r, app) {
    const id = parseInt(r.teile[1], 10);
    const q = r.query.has('reihenfolge') ? '?reihenfolge=' + encodeURIComponent(r.query.get('reihenfolge')) : '';
    const d = await api('serie/' + id + q);
    letzterTitel = d.titel;
    const admin = app.konto.rolle === 'admin';
    const n = d.naechste;
    let staffelNr = parseInt(r.query.get('staffel') || '', 10);
    if (!d.staffeln.some((s) => s.nummer === staffelNr)) {
        // Staffel der nächsten Folge vorauswählen, sonst die erste reguläre
        const mitNaechster = n ? d.staffeln.find((s) => s.folgen.some((f) => f.id === n.id)) : null;
        staffelNr = (mitNaechster || d.staffeln.find((s) => s.nummer > 0) || d.staffeln[0])?.nummer ?? 1;
    }

    const knoepfe = el('div.knoepfe',
        n ? el('button.knopf.weiss', { onclick: () => app.abspielen({ art: 'folge', id: n.id }) }, icon('play'),
            n.modus === 'weiter' ? `${n.kennung} weiterschauen` : n.modus === 'naechste' ? `${n.kennung} abspielen` : 'Abspielen') : el('span.chip', 'Alles gesehen'),
        admin ? el('button.knopf', { onclick: () => tmdbZuordnen('serie', id, d.originaltitel || d.titel, d.jahr) }, icon('bearbeiten'), 'TMDB-Zuordnung') : null);
    const meta = el('div.meta', d.zeitraum ? el('span', d.zeitraum) : null, STATUS[d.status] ? [el('span.trenn'), el('span', STATUS[d.status])] : null,
        d.sender ? [el('span.trenn'), el('span', d.sender)] : null, d.freigabe ? el('span.freigabe', 'FSK ' + d.freigabe) : null,
        d.bewertung ? el('span.stern', '★ ' + String(d.bewertung).replace('.', ',')) : null);
    const extra = [meta, el('div.chips', d.genres.map((g) => el('a.chip', { href: `#/serien?genre=${g.id}` }, g.name)),
        d.universen.map((u) => el('a.chip.akzent', { href: `#/universum/${u.id}` }, icon('universum'), u.name)))];

    // Episodenreihenfolge (z. B. Ausstrahlung vs. Netflix-Schnitt)
    let reihenfolgeWahl = null;
    if (d.reihenfolgen.length > 1) {
        const werte = Object.fromEntries(d.reihenfolgen.map((x) => [x.id ?? '', x.name + (x.id === d.reihenfolge_standard ? ' (Standard)' : '')]));
        const sel = auswahl(werte, d.reihenfolge ?? '', { 'aria-label': 'Episodenreihenfolge', onchange: (e) => {
            location.hash = `#/serie/${id}?reihenfolge=${e.target.value}`;
        } });
        reihenfolgeWahl = el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
            el('span.leise', 'Reihenfolge'), sel,
            admin && (d.reihenfolge ?? null) !== (d.reihenfolge_standard ?? null) ? el('button.knopf.klein', { onclick: async () => {
                await api(`serie/${id}/reihenfolge`, 'PUT', { reihenfolge_id: d.reihenfolge });
                meldung('Als Standard für alle gespeichert.');
                app.neuLaden();
            } }, 'Als Standard festlegen') : null);
    }

    const folgenEl = el('div.folgen');
    const tabs = el('div.staffel-wahl');
    const staffelZeigen = () => {
        tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('aktiv', Number(b.dataset.nr) === staffelNr));
        const st = d.staffeln.find((s) => s.nummer === staffelNr);
        folgenEl.replaceChildren(...(st?.folgen || []).map((f) => folgeZeile(f, app, id)));
    };
    tabs.append(...d.staffeln.map((s) => el('button', { 'data-nr': s.nummer, onclick: () => { staffelNr = s.nummer; staffelZeigen(); } }, s.name)));
    staffelZeigen();

    const staffelGesehen = el('button.knopf.klein', { onclick: async () => {
        const st = d.staffeln.find((s) => s.nummer === staffelNr);
        const alle = st.folgen.every((f) => f.fortschritt?.gesehen);
        for (const f of st.folgen) await api('wiedergabe/gesehen', 'POST', { art: 'folge', id: f.id, gesehen: !alle });
        meldung(alle ? 'Staffel als ungesehen markiert.' : 'Staffel als gesehen markiert.');
        app.neuLaden();
    } }, icon('haken'), 'Staffel gesehen');

    return el('div',
        hero(d, knoepfe, extra),
        el('div.seite',
            d.beschreibung ? el('section.abschnitt', el('p.beschreibung', d.beschreibung)) : null,
            el('section.abschnitt',
                el('div', { style: { display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '14px' } },
                    el('h2', { style: { margin: 0 } }, 'Folgen'), reihenfolgeWahl, el('div', { style: { marginLeft: 'auto' } }, staffelGesehen)),
                tabs, folgenEl),
            besetzung(d.besetzung)));
}

function folgeZeile(f, app, serieId) {
    const fs = f.fortschritt;
    const haken = el('button.icon-knopf' + (fs?.gesehen ? '.an' : ''), { title: fs?.gesehen ? 'Als ungesehen markieren' : 'Als gesehen markieren', onclick: async (e) => {
        e.stopPropagation();
        const neu = !haken.classList.contains('an');
        await api('wiedergabe/gesehen', 'POST', { art: 'folge', id: f.id, gesehen: neu });
        haken.classList.toggle('an', neu);
    } }, icon('haken'));
    const zeile = el('div.folge' + (f.vorhanden ? '' : '.fehlt'),
        el('div.bild', bild(f.standbild, ''), el('span.marke-klein.nr', String(f.nummer)),
            fs && !fs.gesehen && fs.prozent > 1 ? el('div.fortschritt', el('span', { style: { width: fs.prozent + '%' } })) : null),
        el('div',
            el('h3', `${f.nummer}. ${f.titel}`),
            f.beschreibung ? el('div.text', f.beschreibung) : null,
            el('div.klein-meta', [f.laufzeit_min ? f.laufzeit_min + ' Min.' : null, f.erstausstrahlung ? new Date(f.erstausstrahlung).toLocaleDateString('de-DE') : null,
                f.qualitaet, f.vorhanden ? null : 'nicht vorhanden'].filter(Boolean).join(' · '))),
        f.vorhanden ? el('div.aktionen', haken) : null);
    if (f.vorhanden) zeile.addEventListener('click', () => app.abspielen({ art: 'folge', id: f.id, serie_id: serieId }));
    return zeile;
}
