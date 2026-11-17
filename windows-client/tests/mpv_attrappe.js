#!/usr/bin/env node
// Attrappe für mpv (Tests des Spielers ohne Windows): JSON-IPC über den Unix-Socket aus --input-ipc-server, Uhr mit
// pause/speed, loadfile/seek/stop, observe_property. Jede Anfrage landet als Zeile in $MPV_PROTOKOLL.
const net = require('net');
const fs = require('fs');
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const pfad = arg('input-ipc-server');
const protokoll = process.env.MPV_PROTOKOLL;
const DAUER = Number(process.env.MPV_DAUER || 120);
const p = { pause: false, speed: 1, aid: 'auto', sid: 'no', start: '0', volume: 100, mute: false, af: '', ao: arg('ao') || 'wasapi', duration: DAUER, width: 1920, height: 1080 };
let pos = 0, am = Date.now(), datei = null, ende = false;
const jetzt = () => (datei && !p.pause ? pos + ((Date.now() - am) / 1000) * p.speed : pos);
const fest = () => { pos = jetzt(); am = Date.now(); };
let sock = null;
const beobachtet = new Map();
const senden = (o) => { if (sock) sock.write(JSON.stringify(o) + '\n'); };
const aendern = (name) => { for (const [n, id] of beobachtet) if (n === name) senden({ event: 'property-change', id, name, data: wert(name) }); };
const wert = (n) => (n === 'time-pos' ? (datei ? jetzt() : null) : n === 'eof-reached' ? ende : n === 'track-list' ? [] : n === 'demuxer-cache-duration' ? 30 : p[n] ?? null);
try { fs.unlinkSync(pfad); } catch (e) { /* neu */ }
net.createServer((s) => {
  sock = s;
  let rest = '';
  s.setEncoding('utf8');
  s.on('data', (d) => {
    rest += d;
    let i;
    while ((i = rest.indexOf('\n')) >= 0) {
      const z = rest.slice(0, i); rest = rest.slice(i + 1);
      if (!z.trim()) continue;
      const m = JSON.parse(z);
      if (protokoll) fs.appendFileSync(protokoll, JSON.stringify(m.command) + '\n');
      const [c, ...a] = m.command;
      let data = null, error = 'success';
      if (c === 'observe_property') { beobachtet.set(a[1], a[0]); setTimeout(() => aendern(a[1]), 5); }
      else if (c === 'get_property') { data = wert(a[0]); }
      else if (c === 'set_property') {
        if (a[0] === 'pause' || a[0] === 'speed') fest();
        p[a[0]] = a[1];
        aendern(a[0]);
      } else if (c === 'loadfile') {
        datei = a[0]; pos = Number(p.start) || 0; am = Date.now(); ende = false;
        setTimeout(() => { senden({ event: 'file-loaded' }); aendern('duration'); senden({ event: 'playback-restart' }); }, 30);
      } else if (c === 'seek') {
        fest(); pos = Number(a[0]); am = Date.now();
        aendern('seeking');
        setTimeout(() => { senden({ event: 'playback-restart' }); aendern('time-pos'); }, 20);
      } else if (c === 'stop') { datei = null; }
      else if (c === 'quit') { setTimeout(() => process.exit(0), 10); }
      senden({ request_id: m.request_id, error, data });
    }
  });
}).listen(pfad);
// Zeit wie mpv laufend melden
setInterval(() => { if (datei && !p.pause) { aendern('time-pos'); if (jetzt() >= DAUER && !ende) { ende = true; aendern('eof-reached'); } } }, 50);
