// Brücke zum Bluewave Windows-Client (preload: window.bluewaveNativ) – im Browser null.
// Gleiche Schnittstelle wie in Amberwave, damit die übernommene Ausgabe-Sektion unverändert läuft.
export const nativ = typeof window !== 'undefined' && window.bluewaveNativ ? window.bluewaveNativ : null;

/** Ist die gewählte Ausgabe ein ASIO-Treiber? */
export const istAsio = (geraet) => String(geraet || '').startsWith('asio:');
/** Wie die Engine ausgibt, kurz */
export const ausgabeWeg = (f) => (!f ? '' : f.asio ? 'ASIO' : f.exklusiv ? 'WASAPI exklusiv' : 'WASAPI geteilt');
