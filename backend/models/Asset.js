const mongoose = require('mongoose');

// A KIND of company asset — "Laptop", "Phone", "Office chair" — that is issued
// to many people. Reworked 2026-09-23 (user decision): an asset used to be one
// physical unit with one holder; now it is the catalogue entry, and each
// person's actual item lives on their AssetAssignment ("MacBook i5",
// "Asus i7, 6GB RAM, 1TB ROM", its own serial), so one "Laptop" can be with
// forty people at once, each with a different machine.
//
// `serialNumber`, `assignedTo` and `assignedAt` are LEGACY single-unit fields:
// read (the one asset created before the rework still carries them) but no
// longer written. Who holds what is answered by AssetAssignment alone.
const ASSET_CATEGORIES = ['Laptop', 'Desktop', 'Monitor', 'Phone', 'SIM', 'Furniture', 'Vehicle', 'Other'];
// Available = can be issued; InRepair / Retired take the kind out of the
// "assign" picker without touching anyone's existing holding. 'Assigned' is
// only ever found on legacy single-unit rows.
const ASSET_STATUS = ['Available', 'Assigned', 'InRepair', 'Retired'];

const assetSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // A short code for the kind. Optional on the form — the unique index on the
    // collection (from the single-unit days) is kept, so a blank one is minted
    // as AST-<year>-<n> below rather than dropping an index on a live database.
    assetTag: { type: String, required: true, unique: true, trim: true, uppercase: true },
    category: { type: String, enum: ASSET_CATEGORIES, default: 'Other' },
    serialNumber: { type: String, trim: true }, // legacy (single unit)
    status: { type: String, enum: ASSET_STATUS, default: 'Available' },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }, // legacy (single unit)
    assignedAt: Date, // legacy (single unit)
    notes: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Mint the code before `required` is checked, so every creation path (the web
// form, the app, a script) gets one.
assetSchema.pre('validate', async function mintTag() {
  if (!this.assetTag) {
    const { nextCode } = require('../services/sequence');
    this.assetTag = await nextCode('AST', this.createdAt || new Date());
  }
});

module.exports = mongoose.model('Asset', assetSchema);
module.exports.ASSET_CATEGORIES = ASSET_CATEGORIES;
module.exports.ASSET_STATUS = ASSET_STATUS;
