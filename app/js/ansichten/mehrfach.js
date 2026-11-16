// Mehrfachauswahl für Poster-Raster: auswählen (auch mit Umschalt für Bereiche), dann gesammelt bearbeiten
'use strict';
import { el, icon, meldung, dialog } from '../ui.js';
import { api } from '../api.js';

const schluessel = (x) => `${x.art}:${x.id}`;

/**
 * Macht ein Raster aus Kacheln auswählbar.
 * titel: Liste der Objekte (gleiche Reihenfolge wie die Kacheln im Raster)
 * Rückgabe: { knopf, raster } – knopf schaltet den Modus, raster ist das übergebene Element
 */
export function mehrfachAuswahl(raster, titelListe, app) {
    // mehrere Raster möglich (z. B. Suche): raster = [el, el], titelListe = [[…], […]]
    const rasterListe = Array.isArray(raster) ? raster : [raster];
    const titel = Array.isArray(raster) ? titelListe.flat() : titelListe;
    const admin = app.konto.rolle === 'admin';
    const gewaehlt = new Set();
    let an = false;
    let letzter = null;
    const kacheln = rasterListe.flatMap((r) => [...r.children]);
    kacheln.forEach((k, i) => { k.dataset.i = i; k.append(el('span.wahl-kreis', icon('haken'))); });

    const zahl = el('b');
    const leiste = el('div.auswahl-leiste.glass-panel',
        zahl,
        el('button.knopf.klein', { onclick: () => { titel.forEach((t) => gewaehlt.add(schluessel(t))); zeigen(); } }, 'Alle'),
        el('button.knopf.klein', { onclick: () => { gewaehlt.clear(); zeigen(); } }, 'Keine'),
        el('span.trenner'),
        admin ? el('button.knopf.klein.haupt.aktion', { onclick: () => zuUniversum() }, icon('universum'), 'Zu Universum') : null,
        el('button.knopf.klein.aktion', { onclick: () => gesehen(true) }, icon('haken'), 'Gesehen'),
        el('button.knopf.klein.aktion', { onclick: () => gesehen(false) }, 'Ungesehen'),
        el('button.mini-knopf', { title: 'Auswahl beenden', onclick: () => umschalten(false) }, icon('schliessen')));

    const auswahlListe = () => titel.filter((t) => gewaehlt.has(schluessel(t)));
    const zeigen = () => {
        kacheln.forEach((k, i) => k.classList.toggle('gewaehlt', gewaehlt.has(schluessel(titel[i]))));
        const n = gewaehlt.size;
        zahl.textContent = n === 1 ? '1 ausgewählt' : `${n} ausgewählt`;
        leiste.querySelectorAll('button.aktion').forEach((b) => { b.disabled = n === 0; });
    };
    const umschalten = (wert = !an) => {
        an = wert;
        rasterListe.forEach((r) => r.classList.toggle('auswahl-an', an));
        knopf.classList.toggle('an', an);
        if (an) { document.body.append(leiste); zeigen(); } else { leiste.remove(); gewaehlt.clear(); zeigen(); }
    };
    const klick = (e) => {
        if (!an) return;
        const k = e.target.closest('.kachel');
        if (!k || k.dataset.i === undefined) return;
        e.preventDefault();
        e.stopPropagation();
        const i = Number(k.dataset.i);
        const s = schluessel(titel[i]);
        if (e.shiftKey && letzter !== null) {
            const [a, b] = [Math.min(letzter, i), Math.max(letzter, i)];
            const ziel = !gewaehlt.has(s);
            for (let j = a; j <= b; j++) { if (ziel) gewaehlt.add(schluessel(titel[j])); else gewaehlt.delete(schluessel(titel[j])); }
        } else if (gewaehlt.has(s)) gewaehlt.delete(s); else gewaehlt.add(s);
        letzter = i;
        zeigen();
    };
    rasterListe.forEach((r) => r.addEventListener('click', klick, true));
    // Seitenwechsel beendet die Auswahl
    window.addEventListener('hashchange', () => leiste.remove(), { once: true });

    async function gesehen(wert) {
        const liste = auswahlListe();
        if (!liste.length) return;
        try {
            await api('wiedergabe/gesehen_mehrere', 'POST', { titel: liste.map((t) => ({ art: t.art, id: t.id })), gesehen: wert });
            meldung(`${liste.length} als ${wert ? 'gesehen' : 'ungesehen'} markiert.`);
            umschalten(false);
            app.neuLaden();
        } catch (x) { meldung(x.message, true); }
    }

    async function zuUniversum() {
        const liste = auswahlListe();
        if (liste.length && await zuUniversumDialog(liste)) umschalten(false);
    }

    const knopf = el('button.knopf', { onclick: () => umschalten() }, icon('haken'), 'Auswählen');
    return { knopf, umschalten };
}

/** Dialog: mehrere Titel in ein (neues) Universum, wahlweise in einen Abschnitt */
export async function zuUniversumDialog(liste) {
    const d = await api('universen');
    const wahl = el('select', { 'aria-label': 'Universum' },
        d.universen.map((u) => el('option', { value: u.id }, `${u.name} (${u.eintraege} Titel)`)),
        el('option', { value: 'neu' }, '+ Neues Universum …'));
    const neuName = el('input.eingabe', { placeholder: 'Name des neuen Universums', style: { display: d.universen.length ? 'none' : '' } });
    if (!d.universen.length) wahl.value = 'neu';
    const abschnitt = el('select', { 'aria-label': 'Abschnitt' });
    const abschnittFeld = el('div.feld', el('label', 'Abschnitt'), abschnitt);
    const abschnitteLaden = async () => {
        neuName.style.display = wahl.value === 'neu' ? '' : 'none';
        abschnitt.replaceChildren();
        if (wahl.value === 'neu') { abschnittFeld.style.display = 'none'; return; }
        const u = await api(`universum/${wahl.value}`);
        const ab = u.abschnitte.filter((g) => g.id !== null);
        abschnittFeld.style.display = ab.length ? '' : 'none';
        abschnitt.append(...ab.map((g) => el('option', { value: g.id }, g.name)), el('option', { value: '' }, 'Ohne Abschnitt'));
        if (ab.length) abschnitt.value = String(ab[ab.length - 1].id);
    };
    wahl.addEventListener('change', abschnitteLaden);
    abschnitteLaden();
    const namen = liste.slice(0, 4).map((t) => t.titel).join(', ') + (liste.length > 4 ? ` und ${liste.length - 4} weitere` : '');
    const ergebnis = await dialog(`${liste.length} ${liste.length === 1 ? 'Titel' : 'Titel'} zu einem Universum`, el('div',
        el('p.leise', namen),
        el('div.feld', el('label', 'Universum'), wahl, neuName),
        abschnittFeld,
        el('p.hinweis-leise', 'Titel, die schon drin sind, werden übersprungen. Reihen kommen als einzelne Filme hinein.')), [
        { text: 'Abbrechen', wert: null },
        { text: 'Hinzufügen', haupt: true, aktion: async () => {
            try {
                let uid = wahl.value;
                if (uid === 'neu') {
                    if (!neuName.value.trim()) { meldung('Bitte einen Namen eingeben.', true); return false; }
                    uid = (await api('universen', 'POST', { name: neuName.value.trim() })).id;
                }
                const r = await api(`universum/${uid}/liste`, 'POST', {
                    titel: liste.map((t) => ({ art: t.art, id: t.id })),
                    abschnitt_id: abschnitt.value ? Number(abschnitt.value) : null,
                });
                return { uid, n: r.hinzugefuegt };
            } catch (x) { meldung(x.message, true); return false; }
        } },
    ]);
    if (!ergebnis) return false;
    meldung(`${ergebnis.n} ${ergebnis.n === 1 ? 'Titel' : 'Titel'} hinzugefügt.`);
    return ergebnis;
}
