// Admin: Poster per Link setzen (z. B. von ThePosterDB) – wird in den Medienordner gelegt und in Bluewave fest gesetzt
'use strict';
import { el, icon, meldung, dialog } from '../ui.js';
import { api } from '../api.js';

/**
 * @param ziele Liste von {art: 'film'|'serie'|'staffel', id, staffel?, name, poster, datei}  (erstes = vorausgewählt)
 */
export async function posterDialog(ziele, start = 0) {
    const wahl = el('select', { 'aria-label': 'Für' }, ziele.map((z, i) => el('option', { value: i }, z.name)));
    wahl.value = String(start);
    const jetzt = el('div.poster-vorschau');
    const dateiName = el('code.poster-datei');
    const zeigen = () => {
        const z = ziele[Number(wahl.value)];
        jetzt.replaceChildren(z.poster ? el('img', { src: z.poster, alt: '' }) : el('span', 'kein Poster'));
        dateiName.textContent = z.datei;
    };
    wahl.addEventListener('change', zeigen);
    zeigen();
    const url = el('input.eingabe', { type: 'url', placeholder: 'https://theposterdb.com/api/assets/12345', autocomplete: 'off', spellcheck: 'false' });
    setTimeout(() => url.focus(), 50);
    const inhalt = el('div.poster-dialog',
        jetzt,
        el('div',
            ziele.length > 1 ? el('div.feld', el('label', 'Für'), wahl) : null,
            el('div.feld', el('label', 'Link zum Bild'), url),
            el('p.hinweis-leise', 'Auf ThePosterDB beim gewünschten Poster mit Rechtsklick auf „Download“ den Link kopieren – oder die Adresse der Poster-Seite einfügen. Jede andere Bild-URL geht auch.'),
            el('p.hinweis-leise', 'Wird im Ordner gespeichert als ', dateiName, ' – ein vorhandenes Bild mit diesem Namen landet in den Sicherungen.')));
    const ergebnis = await dialog('Poster ändern', inhalt, [
        { text: 'Abbrechen', wert: null },
        { text: 'Übernehmen', haupt: true, aktion: async (knopf) => {
            if (!url.value.trim()) { meldung('Bitte einen Link einfügen.', true); return false; }
            const z = ziele[Number(wahl.value)];
            if (knopf) { knopf.disabled = true; knopf.textContent = 'Lädt …'; }
            try {
                return await api('poster', 'POST', { art: z.art, id: z.id, staffel: z.staffel ?? 0, url: url.value.trim() });
            } catch (x) {
                meldung(x.message, true);
                if (knopf) { knopf.disabled = false; knopf.textContent = 'Übernehmen'; }
                return false;
            }
        } },
    ]);
    if (!ergebnis) return;
    meldung(ergebnis.hinweis || 'Poster gespeichert' + (ergebnis.datei ? ': ' + ergebnis.datei.split('/').slice(-2).join('/') : '.'), !!ergebnis.hinweis);
    window.__bluewave.neuLaden();
}
