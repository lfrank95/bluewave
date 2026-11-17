// Ersatz für Amberwaves ui.js in der übernommenen Ausgabe-Sektion (Windows-Client): Escaping, Symbole als SVG-Text,
// Hinweise und Dialoge in Amberwave-Form (Klassen aw-dialog …, Regeln in css/client.css).
import { t } from './aw_i18n.js';
import { meldung } from '../ui.js';

/** HTML-Escaping für alle eingesetzten Texte */
export function h(wert) {
  return String(wert ?? '').replace(/[&<>"']/g, (z) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[z]));
}


const pfade = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    zu: '<path d="M6 6l12 12M18 6 6 18"/>',
    stift: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17z"/>',
    haken: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    computer: '<rect x="3" y="4" width="18" height="12" rx="1.8"/><path d="M8 20h8M12 16v4"/>',
    warnung: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.01"/>',
};

export function icon(name, groesse = 20, extra = '') {
  return `<svg viewBox="0 0 24 24" width="${groesse}" height="${groesse}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${pfade[name] || ''}</svg>`;
}

// ---------- Hinweise (Toasts) ----------
let toastBereich = null;
export function toast(text, art = 'info', ms = 3800, extra = null) {
  // einfache Hinweise wie überall in Bluewave (eine Meldung unten), nur mit Knopf in Amberwave-Form
  if (!extra) { meldung(text, art === 'fehler'); return; }
  if (!toastBereich) {
    toastBereich = document.createElement('div');
    toastBereich.className = 'toast-bereich';
    toastBereich.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastBereich);
  }
  const t = document.createElement('div');
  t.className = 'toast' + (art === 'fehler' ? ' fehler-toast' : art === 'gut' ? ' gut-toast' : '');
  if (art === 'fehler' || art === 'gut') t.innerHTML = `${icon(art === 'gut' ? 'haken' : 'warnung', 18)}<span>${h(text)}</span>`;
  else t.textContent = text;
  // extra: { unter: zweite Zeile, knopf: { text, aktion } } – z. B. „Trotzdem Ultra“
  if (extra) {
    t.classList.add('toast-mit');
    const tx = document.createElement('span'); tx.className = 'toast-tx';
    tx.innerHTML = `<b>${h(text)}</b>${extra.unter ? `<small>${h(extra.unter)}</small>` : ''}`;
    t.replaceChildren(...(art === 'fehler' || art === 'gut' ? [t.firstElementChild] : []), tx);
    if (extra.knopf) {
      const k = document.createElement('button'); k.type = 'button'; k.className = 'toast-knopf'; k.textContent = extra.knopf.text;
      k.addEventListener('click', () => { extra.knopf.aktion(); t.classList.add('raus'); setTimeout(() => t.remove(), 220); });
      t.appendChild(k);
    }
  }
  toastBereich.appendChild(t);
  setTimeout(() => { t.classList.add('raus'); setTimeout(() => t.remove(), 220); }, ms);
}


export function dialog({ titel, inhalt, knoepfe = [{ text: 'OK', wert: 'ok', art: 'haupt' }], breit = false, beimOeffnen = null }) {
  return new Promise((fertig) => {
    const d = document.createElement('dialog');
    d.className = 'aw-dialog';
    if (breit) d.style.width = 'min(760px, calc(100vw - 24px))';
    d.innerHTML = `<form method="dialog">
      <div class="aw-dialog-kopf"><h3>${h(titel)}</h3><button type="button" class="btn-ico" data-zu aria-label="${h(t('Schließen'))}">${icon('zu')}</button></div>
      <div class="aw-dialog-inhalt">${inhalt}</div>
      <div class="aw-dialog-fuss">${knoepfe.map((k) => `<button type="submit" value="${h(k.wert)}" class="btn ${k.art === 'zweit' ? 'btn-zweit' : k.art === 'gefahr' ? 'btn-gefahr' : ''}">${h(k.text)}</button>`).join('')}</div>
    </form>`;
    document.body.appendChild(d);
    const form = d.querySelector('form');
    let ergebnis = null;
    d.querySelector('[data-zu]').addEventListener('click', () => d.close());
    // Sanft ausblenden, bevor der Dialog wirklich schließt (Knopf, Esc, d.close())
    const echtZu = d.close.bind(d);
    let schliesst = false;
    const sanftZu = (rv) => {
      if (schliesst || !d.open) return;
      schliesst = true;
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) { echtZu(rv); return; }
      d.classList.add('schliesst');
      let fertigZu = false;
      const ende = () => { if (!fertigZu) { fertigZu = true; echtZu(rv); } };
      d.addEventListener('animationend', (ev) => { if (ev.target === d) ende(); });
      setTimeout(ende, 300);
    };
    d.close = sanftZu;
    d.addEventListener('cancel', (e) => { e.preventDefault(); sanftZu(); });
    form.addEventListener('submit', (e) => {
      const wert = e.submitter?.value || 'ok';
      if (wert !== 'abbrechen' && !form.reportValidity()) { e.preventDefault(); return; }
      ergebnis = wert === 'abbrechen' ? null : { wert, form: new FormData(form), element: d };
      e.preventDefault();
      sanftZu(wert);
    });
    // Enter bestätigt immer: löst den Hauptknopf aus, egal wo der Fokus steht (auch auf „Abbrechen“ oder dem X).
    // Ausnahmen: Textfelder mit mehreren Zeilen und Bedienelemente im Inhalt, die Enter selbst brauchen.
    const rang = (k) => (k.art === 'zweit' ? 0 : k.art === 'gefahr' ? 1 : 2);
    let hauptIdx = 0;
    knoepfe.forEach((k, i) => { if (rang(k) >= rang(knoepfe[hauptIdx])) hauptIdx = i; });
    const hauptKnopf = d.querySelectorAll('.aw-dialog-fuss button')[hauptIdx];
    hauptKnopf?.setAttribute('data-haupt', '');
    d.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.repeat || e.isComposing || e.defaultPrevented || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      const t = e.target;
      if (!(t instanceof Element) || t.closest('dialog') !== d) return;
      if (t.closest('textarea, [contenteditable]:not([contenteditable="false"])')) return;
      if (t.closest('.aw-dialog-inhalt') && t.closest('button, a[href], summary, [role="button"], [role="option"], [role="listbox"], [tabindex]:not(input):not(select)')) return;
      if (!hauptKnopf || hauptKnopf.disabled) return;
      e.preventDefault();
      form.requestSubmit(hauptKnopf);
    });
    d.addEventListener('close', () => { d.remove(); fertig(ergebnis); });
    d.showModal();
    if (beimOeffnen) beimOeffnen(d);
    const erstes = d.querySelector('input:not([type=hidden]), select, textarea');
    if (erstes) erstes.focus();
  });
}


export async function bestaetigen(titel, text, ja = t('Ja'), gefahr = false) {
  const r = await dialog({ titel, inhalt: `<p>${h(text)}</p>`, knoepfe: [{ text: t('Abbrechen'), wert: 'abbrechen', art: 'zweit' }, { text: ja, wert: 'ja', art: gefahr ? 'gefahr' : 'haupt' }] });
  return !!r;
}
