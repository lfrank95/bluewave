// Optimierte Fassungen eines Films bzw. einer Serie: anlegen (1080p / 720p), Stand sehen, löschen
import { el, icon, meldung, dialog, bestaetigen } from '../ui.js';
import { api } from '../api.js';

export const STATUS_TEXT = { wartet: 'wartet', laeuft: 'wird erstellt', fertig: 'fertig', fehler: 'Fehler' };

export function groesseText(b) {
    if (!b && b !== 0) return '';
    return b >= 1e9 ? `${(b / 1e9).toFixed(1).replace('.', ',')} GB` : `${Math.round(b / 1e6)} MB`;
}

/** Eine Zeile der Liste (Titel, Stufe, Stand, Größe, Löschen) */
export function optimiertZeile(o, nachLoeschen) {
    return el('tr',
        el('td', o.titel),
        el('td', `${o.hoehe}p`),
        el('td', o.status === 'laeuft'
            ? el('div', el('b', `${Math.round(o.fortschritt)} %`), el('div.balken', el('span', { style: { width: Math.round(o.fortschritt) + '%' } })))
            : el('span' + (o.status === 'fehler' ? '.schlecht' : o.status === 'fertig' ? '' : '.leise'), STATUS_TEXT[o.status] || o.status,
                o.status === 'fehler' && o.fehler ? el('div.leise', { style: { fontSize: '0.78rem', maxWidth: '420px' } }, o.fehler.slice(0, 200)) : null)),
        el('td.leise', groesseText(o.groesse)),
        el('td', { style: { textAlign: 'right' } }, el('button.knopf.klein', { title: 'Löschen', 'aria-label': 'Löschen', onclick: async () => {
            if (!await bestaetigen('Optimierte Fassung löschen', `${o.titel} (${o.hoehe}p) löschen?`, 'Löschen', true)) return;
            await api('optimiert/' + o.id, 'DELETE');
            nachLoeschen?.();
        } }, icon('loeschen'))));
}

/** Dialog für Film (art 'film') oder Serie (art 'serie', optional mit aktueller Staffel) */
export async function optimiertDialog(art, id, titel, staffel = null) {
    const liste = el('div');
    const staffelNur = el('input', { type: 'checkbox', checked: false });
    const laden = async () => {
        const d = await api(`optimiert?art=${art}&id=${id}`);
        liste.replaceChildren(d.liste.length
            ? el('table.tabelle', d.liste.map((o) => optimiertZeile(o, laden)))
            : el('p.leise', 'Noch keine optimierte Fassung.'),
        el('p.leise', { style: { fontSize: '0.82rem', marginTop: '10px' } },
            `Speicherort: ${d.ordner}` + (d.frei ? ` · frei: ${groesseText(d.frei)}` : '')
            + (d.arbeiter?.jemand_schaut ? ' · pausiert, solange jemand schaut' : '')));
    };
    const anlegen = async (hoehe) => {
        try {
            const r = await api('optimiert', 'POST', { art, id, hoehe, staffel: art === 'serie' && staffelNur.checked ? staffel : null });
            meldung(r.neu ? `${r.neu} ${r.neu === 1 ? 'Fassung' : 'Fassungen'} eingereiht${r.uebersprungen ? `, ${r.uebersprungen} schon klein genug` : ''}.`
                : r.uebersprungen ? 'Schon klein genug – eine Kopie bringt hier nichts.' : 'Schon eingereiht.');
            await laden();
        } catch (x) { meldung(x.message, true); }
    };
    await laden();
    await dialog(`Optimierte Fassung · ${titel}`, el('div', { style: { maxWidth: '640px' } },
        el('p.leise', 'Eine vorab umgewandelte Kopie (H.264, Ton als AAC Stereo) läuft unterwegs direkt im Browser – Start und Spulen ohne Wartezeit. '
            + 'Sie wird automatisch genommen, wenn die Qualitätsgrenze sonst Umwandeln erzwingen würde. Erstellt wird im Hintergrund, angehalten, solange jemand schaut.'),
        art === 'serie' && staffel !== null ? el('label.schalter', { style: { margin: '10px 0' } }, staffelNur, `Nur Staffel ${staffel}`) : null,
        el('div.knoepfe', { style: { margin: '12px 0' } },
            el('button.knopf.haupt', { onclick: () => anlegen(1080) }, icon('plus'), '1080p erstellen (8 Mbit/s)'),
            el('button.knopf', { onclick: () => anlegen(720) }, icon('plus'), '720p erstellen (4 Mbit/s)')),
        liste), [{ text: 'Schließen', wert: null }]);
}
