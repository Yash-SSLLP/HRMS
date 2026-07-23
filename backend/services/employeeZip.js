/**
 * Builds ZIP archives for employee export — a per-employee bundle containing a
 * human-readable details file plus every uploaded document.
 *
 * External systems: the Document collection (looked up per employee) and the
 * local storage service (streams the stored files into the archive). Works with
 * an already-open `archiver` instance supplied by the caller.
 */
const Document = require('../models/Document');
const storage = require('./storage');

/**
 * Sanitise an arbitrary string into a filesystem-safe archive entry name.
 * @param {string} name - Raw name (category, filename, …).
 * @returns {string} Safe name; 'file' when nothing usable remains.
 */
function safe(name) {
  return String(name || '').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'file';
}

function fmtDate(d) {
  if (!d) return '-';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '-';
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Compose a readable details.txt for one (populated) employee profile.
 * @param {Object} profile - EmployeeProfile with `user` and `hrPartner` populated (bank/address/etc. inline).
 * @returns {string} A plain-text, section-formatted employee summary.
 */
function buildDetailsText(profile) {
  const u = profile.user || {};
  const hr = profile.hrPartner || {};
  const bank = profile.bankDetails || {};
  const cur = profile.address?.current || {};
  const perm = profile.address?.permanent || {};
  const ec = profile.emergencyContact || {};

  const line = (k, v) => `${k.padEnd(22)}: ${v ?? '-'}`;
  const addr = (a) =>
    [a.line1, a.line2, a.city, a.state, a.pincode, a.country].filter(Boolean).join(', ') || '-';

  return [
    '==================================================',
    `  EMPLOYEE DETAILS - ${`${u.firstName || ''} ${u.lastName || ''}`.trim()}`,
    '==================================================',
    '',
    '[ Identity ]',
    line('Employee Code', profile.employeeCode),
    line('Name', `${u.firstName || ''} ${u.lastName || ''}`.trim()),
    line('Email', u.email),
    line('Phone', u.phone),
    line('Role', u.role),
    line('Active', u.isActive === false ? 'No' : 'Yes'),
    '',
    '[ Employment ]',
    line('Designation', profile.designation),
    line('Department', profile.department),
    line('Employment Type', profile.employmentType),
    line('Work Location', profile.workLocation),
    line('Date of Joining', fmtDate(profile.dateOfJoining)),
    line('Date of Exit', profile.dateOfExit ? fmtDate(profile.dateOfExit) : '-'),
    line('HR Partner', hr.firstName ? `${hr.firstName} ${hr.lastName} (${hr.email || ''})` : '-'),
    line('Documents Verified', profile.documentsVerified ? 'Yes' : 'No'),
    '',
    '[ Personal ]',
    line('Date of Birth', fmtDate(profile.dateOfBirth)),
    line('Gender', profile.gender),
    line('Marital Status', profile.maritalStatus),
    '',
    '[ Statutory IDs ]',
    line('PAN', profile.pan),
    line('UAN', profile.uan),
    line('PF Number', profile.pfNumber),
    line('ESIC Number', profile.esicNumber),
    '',
    '[ Bank Details ]',
    line('Account Holder', bank.accountHolderName),
    line('Bank', bank.bankName),
    line('Branch', bank.branch),
    line('Account Number', bank.accountNumber),
    line('IFSC', bank.ifsc),
    line('Account Type', bank.accountType),
    '',
    '[ Address ]',
    line('Current', addr(cur)),
    line('Permanent', addr(perm)),
    '',
    '[ Emergency Contact ]',
    line('Name', ec.name),
    line('Relation', ec.relation),
    line('Phone', ec.phone),
    '',
    `Generated: ${new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })}`,
    '',
  ].join('\n');
}

/**
 * Append one employee's details + documents into an open archiver instance,
 * nested under `folder` (use '' for a single-employee archive at root).
 * Missing/unreadable files are noted as placeholder .txt entries rather than
 * failing the whole archive.
 * @param {import('archiver').Archiver} archive - An open archiver instance to append entries to.
 * @param {Object} profile - Populated EmployeeProfile (see buildDetailsText).
 * @param {string} [folder=''] - Sub-folder prefix inside the archive; '' places entries at root.
 * @returns {Promise<void>}
 * @sideEffects Queries the Document collection and reads stored files via the storage service.
 */
async function appendEmployee(archive, profile, folder = '') {
  const prefix = folder ? `${folder}/` : '';
  archive.append(buildDetailsText(profile), { name: `${prefix}details.txt` });

  const docs = await Document.find({ employee: profile._id }).sort({ category: 1, createdAt: 1 });
  const usedNames = new Set();
  for (const doc of docs) {
    try {
      const stream = storage.readStream(doc.storagePath);
      let name = `${prefix}documents/${safe(doc.category)}-${safe(doc.fileName)}`;
      // De-duplicate identical filenames within the same archive.
      let n = 1;
      const base = name;
      while (usedNames.has(name)) {
        const dot = base.lastIndexOf('.');
        name = dot > -1 ? `${base.slice(0, dot)}(${n})${base.slice(dot)}` : `${base}(${n})`;
        n += 1;
      }
      usedNames.add(name);
      archive.append(stream, { name });
    } catch (_) {
      // Missing/unreadable file on disk — note it rather than failing the whole zip.
      archive.append(`Could not read file for ${doc.category} (${doc.fileName})`, {
        name: `${prefix}documents/MISSING-${safe(doc.category)}-${safe(doc.fileName)}.txt`,
      });
    }
  }
  if (docs.length === 0) {
    archive.append('No documents uploaded for this employee.', {
      name: `${prefix}documents/_no-documents.txt`,
    });
  }
}

module.exports = { buildDetailsText, appendEmployee, safe };
