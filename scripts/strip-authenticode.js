'use strict';
// Fjerner Authenticode-signaturen fra en Windows .exe (svarer til "signtool remove /s").
// Node.exe er signeret af Node.js; efter indsprøjtning ville signaturen være ugyldig.
// Brug: node scripts/strip-authenticode.js fil.exe
const fs = require('fs');

const file = process.argv[2];
const buf = fs.readFileSync(file);
const pe = buf.readUInt32LE(0x3c);
if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('Ikke en PE-fil');
const opt = pe + 24;
const magic = buf.readUInt16LE(opt);
const dataDirs = opt + (magic === 0x20b ? 112 : 96);
const securityEntry = dataDirs + 4 * 8; // IMAGE_DIRECTORY_ENTRY_SECURITY
const certOffset = buf.readUInt32LE(securityEntry);
const certSize = buf.readUInt32LE(securityEntry + 4);
if (!certOffset) {
  console.log('Ingen signatur.');
  process.exit(0);
}
if (certOffset + certSize < buf.length - 8) throw new Error('Signaturen ligger ikke sidst i filen - stopper.');
buf.writeUInt32LE(0, securityEntry);
buf.writeUInt32LE(0, securityEntry + 4);
fs.writeFileSync(file, buf.subarray(0, certOffset));
console.log(`Signatur fjernet (${certSize} bytes).`);
