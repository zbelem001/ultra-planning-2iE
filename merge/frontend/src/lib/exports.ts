// Exports de l'emploi du temps (BF-22) : Excel (.xlsx), iCalendar (.ics).
// Le PDF passe par l'impression du navigateur (feuille de styles @media print).
// Aucun paquet externe : un .xlsx est un ZIP de quelques fichiers XML, écrit ici
// sans compression.

export function telecharger(nom: string, contenu: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([contenu], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nom;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- XLSX ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Archive ZIP « stockée » (méthode 0), suffisante pour Excel et LibreOffice. */
function zip(fichiers: { nom: string; contenu: string }[]): Uint8Array {
  const enc = new TextEncoder();
  const locaux: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of fichiers) {
    const nom = enc.encode(f.nom);
    const data = enc.encode(f.contenu);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30 + nom.length));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // noms en UTF-8
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nom.length, true);
    new Uint8Array(local.buffer).set(nom, 30);
    locaux.push(new Uint8Array(local.buffer), data);

    const entree = new DataView(new ArrayBuffer(46 + nom.length));
    entree.setUint32(0, 0x02014b50, true);
    entree.setUint16(4, 20, true);
    entree.setUint16(6, 20, true);
    entree.setUint16(8, 0x0800, true);
    entree.setUint32(16, crc, true);
    entree.setUint32(20, data.length, true);
    entree.setUint32(24, data.length, true);
    entree.setUint16(28, nom.length, true);
    entree.setUint32(42, offset, true);
    new Uint8Array(entree.buffer).set(nom, 46);
    central.push(new Uint8Array(entree.buffer));
    offset += 30 + nom.length + data.length;
  }
  const tailleCentral = central.reduce((t, x) => t + x.length, 0);
  const fin = new DataView(new ArrayBuffer(22));
  fin.setUint32(0, 0x06054b50, true);
  fin.setUint16(8, fichiers.length, true);
  fin.setUint16(10, fichiers.length, true);
  fin.setUint32(12, tailleCentral, true);
  fin.setUint32(16, offset, true);
  const morceaux = [...locaux, ...central, new Uint8Array(fin.buffer)];
  const res = new Uint8Array(morceaux.reduce((t, x) => t + x.length, 0));
  let pos = 0;
  for (const m of morceaux) {
    res.set(m, pos);
    pos += m.length;
  }
  return res;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colonne(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Classeur d'une feuille ; la première ligne est l'en-tête (en gras). */
export function classeurXlsx(feuille: string, lignes: (string | number)[][]): Uint8Array {
  const rows = lignes
    .map((ligne, r) => {
      const cells = ligne
        .map((v, c) => {
          const ref = `${colonne(c)}${r + 1}`;
          const style = r === 0 ? ' s="1"' : '';
          return typeof v === 'number'
            ? `<c r="${ref}"${style}><v>${v}</v></c>`
            : `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  const largeurs = (lignes[0] ?? [])
    .map((_, c) => {
      const max = Math.max(...lignes.map((l) => String(l[c] ?? '').length));
      return `<col min="${c + 1}" max="${c + 1}" width="${Math.min(60, max + 3)}" customWidth="1"/>`;
    })
    .join('');
  const ns = 'http://schemas.openxmlformats.org';
  return zip([
    {
      nom: '[Content_Types].xml',
      contenu: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${ns}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      nom: '_rels/.rels',
      contenu: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      nom: 'xl/workbook.xml',
      contenu: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${ns}/officeDocument/2006/relationships"><sheets><sheet name="${xml(feuille.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      nom: 'xl/_rels/workbook.xml.rels',
      contenu: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${ns}/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      nom: 'xl/styles.xml',
      contenu: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${ns}/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`,
    },
    {
      nom: 'xl/worksheets/sheet1.xml',
      contenu: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${ns}/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews><cols>${largeurs}</cols><sheetData>${rows}</sheetData></worksheet>`,
    },
  ]);
}

// ---------- iCalendar (RFC 5545) ----------

export interface EvenementIcs {
  uid: string;
  date: string; // YYYY-MM-DD
  debut: string; // HH:MM
  fin: string;
  titre: string;
  lieu: string;
  description: string;
}

const echapper = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

/** Plie les lignes à 75 caractères, comme l'exige la RFC. */
const plier = (ligne: string) => ligne.match(/.{1,74}/g)?.join('\r\n ') ?? ligne;

// Ouagadougou est à UTC+0 toute l'année : les heures locales s'écrivent en UTC.
const horodatage = (date: string, heure: string) => `${date.replace(/-/g, '')}T${heure.replace(':', '')}00Z`;

export function calendrierIcs(nom: string, evenements: EvenementIcs[]): string {
  const maintenant = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const lignes = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//2iE//Ultra Planning//FR',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${echapper(nom)}`,
    ...evenements.flatMap((e) => [
      'BEGIN:VEVENT',
      `UID:${e.uid}@planning.2ie-edu.org`,
      `DTSTAMP:${maintenant}`,
      `DTSTART:${horodatage(e.date, e.debut)}`,
      `DTEND:${horodatage(e.date, e.fin)}`,
      `SUMMARY:${echapper(e.titre)}`,
      `LOCATION:${echapper(e.lieu)}`,
      `DESCRIPTION:${echapper(e.description)}`,
      'END:VEVENT',
    ]),
    'END:VCALENDAR',
  ];
  return lignes.map(plier).join('\r\n') + '\r\n';
}
