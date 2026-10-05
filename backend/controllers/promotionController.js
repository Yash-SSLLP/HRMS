/**
 * Promotions — change an employee's designation and/or department, and keep a
 * record of it.
 *
 * WHO: SuperAdmin, CEO and MD (whichever mode a CEO/MD is in — giving a
 * promotion is an executive decision, the same reasoning that lets them run
 * Companies), and anybody holding `employees.manage`, who could already retype
 * both fields on the employee form. The route guard is canPromote below.
 *
 * WALLS: the company wall and "nobody administers their own record"
 * (cannotManageProfile), and — for an HR — the manager-profile grant on a
 * Manager's record (assertCanEditProfileOf). A CEO/MD/Super Admin sits above
 * that grant: it exists to keep HR off Managers' records, not the executives.
 *
 * The change applies at once; `effectiveDate` is the date the promotion counts
 * from, shown on the history and in the employee's mail.
 * Once saved the employee gets a notification and an email.
 */
const asyncHandler = require('express-async-handler');
const EmployeeProfile = require('../models/EmployeeProfile');
const Promotion = require('../models/Promotion');
const Department = require('../models/Department');
const OrgMaster = require('../models/OrgMaster');
const User = require('../models/User');
const Company = require('../models/Company');
const { hasPermission } = require('../middleware/authMiddleware');
const {
  employeeProfileScope, cannotManageProfile, assertCanEditProfileOf, scopeEmployeeFilter,
} = require('../utils/employeeScope');
const { stillHereProfileFilter } = require('../utils/departed');
const { notify } = require('../services/notify');
const { enqueueMail } = require('../services/email');
const { renderMail } = require('../services/templates');
const COMPANY = require('../config/company');
const { ensureDepartment, ensureDesignation } = require('../services/orgMasterSync');
const { renderEmployeeLetter, resolveLetterBody } = require('../services/letterPdf');
const { getBranding } = require('../services/branding');

const PROMOTER_ROLES = ['SuperAdmin', 'CEO', 'MD'];

/** May this account give promotions? */
const canPromote = (user) => !!user
  && (PROMOTER_ROLES.includes(user.role) || hasPermission(user, 'employees.manage'));

/** Route guard: reads for every promoter and the God viewer; writes for promoters. */
function requirePromoter(req, res, next) {
  const u = req.user;
  if (canPromote(u) || (u?.role === 'God' && req.method === 'GET')) return next();
  res.status(403);
  return next(new Error('Promotions are given by HR, the CEO/MD or the Super Admin.'));
}

const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();
const clean = (v) => String(v ?? '').trim();
const fmtDate = (d) => new Date(d).toLocaleDateString('en-GB', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata',
});

/**
 * The people a promotion can be given to, plus the designation and department
 * lists the form offers.
 * @route GET /api/promotions/options
 * @returns {{employees: Object[], designations: string[], departments: string[]}}
 */
const promotionOptions = asyncHandler(async (req, res) => {
  const [profiles, designations, departments] = await Promise.all([
    EmployeeProfile.find(await stillHereProfileFilter({ ...employeeProfileScope(req) }))
      .select('employeeCode designation department user')
      .populate('user', 'firstName lastName role photo isActive')
      .lean(),
    OrgMaster.find({ kind: 'Designation', isActive: { $ne: false } }).select('name').sort({ name: 1 }).lean(),
    Department.find({ isActive: { $ne: false } }).select('name').sort({ name: 1 }).lean(),
  ]);

  const employees = profiles
    .filter((p) => p.user && !cannotManageProfile(req, p))
    .map((p) => ({
      _id: p._id,
      userId: p.user._id,
      name: fullName(p.user) || p.employeeCode || 'Employee',
      employeeCode: p.employeeCode || '',
      role: p.user.role,
      photo: p.user.photo || null,
      designation: p.designation || '',
      department: p.department || '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json({
    employees,
    designations: designations.map((d) => d.name),
    departments: departments.map((d) => d.name),
  });
});

/**
 * Promotion history, newest first, inside the viewer's company wall.
 * @route GET /api/promotions  (?employee=<profileId>)
 * @returns {{count: number, items: Object[]}}
 */
const listPromotions = asyncHandler(async (req, res) => {
  const filter = await scopeEmployeeFilter(req, req.query.employee ? { employee: req.query.employee } : {});
  const rows = await Promotion.find(filter)
    .sort({ createdAt: -1 })
    .limit(500)
    .populate({ path: 'employee', select: 'employeeCode', populate: { path: 'user', select: 'firstName lastName photo' } })
    .lean();
  const items = rows.map((r) => ({
    _id: r._id,
    employeeId: r.employee?._id,
    userId: r.employee?.user?._id || r.user,
    name: fullName(r.employee?.user) || 'Employee',
    employeeCode: r.employee?.employeeCode || '',
    photo: r.employee?.user?.photo || null,
    previousDesignation: r.previousDesignation,
    newDesignation: r.newDesignation,
    previousDepartment: r.previousDepartment,
    newDepartment: r.newDepartment,
    effectiveDate: r.effectiveDate,
    remarks: r.remarks,
    promotedByName: r.promotedByName,
    createdAt: r.createdAt,
  }));
  res.json({ count: items.length, items });
});

/**
 * The promotion letter — or, for a department move with the same designation,
 * the transfer letter — as PDF bytes. Shared by the email attachment and
 * GET /promotions/:id/letter.pdf so the two can never differ.
 * @param {Object} promo - Promotion document (lean is fine)
 * @param {Object} [profile] - its EmployeeProfile, when the caller has it
 * @returns {Promise<{pdf: Buffer, fileName: string}>}
 */
async function buildPromotionLetter(promo, profile = null) {
  const prof = profile || await EmployeeProfile.findById(promo.employee).select('user company employeeCode').lean();
  const user = await User.findById(prof?.user || promo.user).select('firstName lastName').lean();
  const companyId = promo.company || prof?.company;
  const company = companyId ? await Company.findById(companyId).select('name').lean() : null;
  const promoted = promo.newDesignation !== promo.previousDesignation;
  const kind = promoted ? 'promotion' : 'transfer';
  const data = {
    kind,
    employeeName: fullName(user) || 'Employee',
    employeeCode: prof?.employeeCode,
    companyName: company?.name || COMPANY.name,
    previousDesignation: promoted ? promo.previousDesignation : '',
    newDesignation: promo.newDesignation,
    previousDepartment: promo.previousDepartment,
    // A promotion that keeps the department does not name it again.
    newDepartment: kind === 'transfer' || promo.newDepartment !== promo.previousDepartment ? promo.newDepartment : '',
    effectiveDate: promo.effectiveDate,
    brand: await getBranding(),
  };
  data.body = await resolveLetterBody(kind, data);
  const pdf = await renderEmployeeLetter(data);
  const safe = data.employeeName.replace(/[^\w.-]+/g, '-').toLowerCase();
  return { pdf, fileName: `${kind}-letter-${safe}.pdf` };
}

/**
 * The letter for one promotion, inside the viewer's company wall.
 * @route GET /api/promotions/:id/letter.pdf
 */
const promotionLetterPdf = asyncHandler(async (req, res) => {
  const promo = await Promotion.findById(req.params.id).lean();
  const filter = promo ? await scopeEmployeeFilter(req, { employee: promo.employee }) : null;
  if (!promo || !(await Promotion.exists({ _id: promo._id, ...filter }))) {
    res.status(404);
    throw new Error('Promotion not found');
  }
  const { pdf, fileName } = await buildPromotionLetter(promo);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  res.send(pdf);
});

/**
 * Tell the employee — a notification and an email. Never throws: the
 * promotion is already saved.
 */
async function announcePromotion(profile, promo, actor) {
  try {
    const user = await User.findById(profile.user).select('firstName lastName email isActive').lean();
    if (!user || user.isActive === false) return;
    const promoted = promo.newDesignation !== promo.previousDesignation;
    const effective = fmtDate(promo.effectiveDate);

    await notify({
      recipient: user._id,
      sender: actor?._id,
      type: 'promotion',
      audience: 'employee',
      title: promoted ? 'Congratulations on your promotion!' : 'Your department has changed',
      body: promoted
        ? `You have been promoted to ${promo.newDesignation}${promo.newDepartment ? ` (${promo.newDepartment})` : ''}, effective ${effective}.`
        : `You have moved to the ${promo.newDepartment} department, effective ${effective}.`,
      link: '/employee/profile',
    }).catch((err) => console.error('promotion notify failed:', err.message));

    if (!user.email) return;
    const company = profile.company ? await Company.findById(profile.company).select('name').lean() : null;
    const vars = {
      employeeName: fullName(user) || 'Employee',
      employeeCode: profile.employeeCode || '',
      companyName: company?.name || COMPANY.name,
      previousDesignation: promo.previousDesignation || '—',
      newDesignation: promo.newDesignation || '—',
      previousDepartment: promo.previousDepartment || '—',
      newDepartment: promo.newDepartment || '—',
      effectiveDate: effective,
      hrName: fullName(actor) || 'HR Team',
      // A department move with the same designation is not a promotion, and
      // the mail must not congratulate anybody on one.
      changeTitle: promoted ? 'Promotion' : 'Department change',
      // "(previously …)" only on the line that actually changed.
      designationChange: promoted && promo.previousDesignation
        ? `${promo.newDesignation} (previously ${promo.previousDesignation})` : (promo.newDesignation || '—'),
      departmentChange: promo.newDepartment !== promo.previousDepartment && promo.previousDepartment
        ? `${promo.newDepartment} (previously ${promo.previousDepartment})` : (promo.newDepartment || '—'),
      headline: promoted
        ? `Congratulations! We are pleased to inform you that you have been promoted to ${promo.newDesignation}, effective ${effective}.`
        : `This is to inform you that you have moved to the ${promo.newDepartment} department, effective ${effective}.`,
    };
    const fallbackBody = `Dear ${vars.employeeName},\n\n${vars.headline}\n\n`
      + `Designation: ${vars.designationChange}\n`
      + `Department: ${vars.departmentChange}\n\n`
      + `We wish you continued success in your new role. Your letter is attached.\n\n`
      + `Regards,\n${vars.hrName}\n${vars.companyName}`;
    // The letter rides along; one that fails to render must not stop the mail.
    let attachments;
    try {
      const { pdf, fileName } = await buildPromotionLetter(promo, profile);
      attachments = [{ filename: fileName, content: pdf.toString('base64'), contentType: 'application/pdf' }];
    } catch (err) {
      console.error('promotion letter render failed:', err.message);
    }
    const rendered = await renderMail('promotion.mail', vars, {
      subject: `${vars.changeTitle} · ${vars.newDesignation}`,
      body: fallbackBody,
    });
    await enqueueMail(
      { to: user.email, subject: rendered.subject, text: rendered.text, replyTo: actor?.email || undefined, attachments },
      { type: 'promotion', id: promo._id }
    );
  } catch (err) {
    console.error('promotion mail failed:', err.message);
  }
}

/**
 * Give a promotion: new designation and/or department, applied now.
 * @route POST /api/promotions
 * @param {string} req.body.employee - EmployeeProfile id
 * @param {string} req.body.designation - the new designation (required)
 * @param {string} [req.body.department] - the new department (blank = keep)
 * @param {string} [req.body.effectiveDate] - YYYY-MM-DD, defaults to today
 * @param {string} [req.body.remarks]
 * @returns 201 {promotion, profile: {_id, designation, department}}
 */
const createPromotion = asyncHandler(async (req, res) => {
  const profile = await EmployeeProfile.findById(req.body?.employee).populate('user', 'role isActive');
  if (!profile || !profile.user) {
    res.status(404);
    throw new Error('Employee not found');
  }
  if (cannotManageProfile(req, profile)) {
    res.status(403);
    throw new Error('This employee is in a company you do not cover, or this is your own record — nobody promotes themselves.');
  }
  if (profile.user.isActive === false || (profile.dateOfExit && new Date(profile.dateOfExit) <= new Date())) {
    res.status(400);
    throw new Error('This employee has left the company.');
  }
  if (!PROMOTER_ROLES.includes(req.user.role)) await assertCanEditProfileOf(req, profile);

  let designation = clean(req.body.designation).slice(0, 120);
  let department = clean(req.body.department).slice(0, 120) || clean(profile.department);
  if (!designation) {
    res.status(400);
    throw new Error('Enter the new designation.');
  }
  // A name typed in another case is the entry that already exists ("sales
  // manager" is "Sales Manager"), so the lists never grow near-duplicates.
  const sameName = (v) => new RegExp(`^${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const knownDesignation = await OrgMaster.findOne({ kind: 'Designation', name: sameName(designation) }).select('name').lean();
  if (knownDesignation) designation = knownDesignation.name;
  const prevDesignation = clean(profile.designation);
  const prevDepartment = clean(profile.department);
  let createDepartment = false;
  if (department !== prevDepartment) {
    const knownDepartment = await Department.findOne({ name: sameName(department) }).select('name').lean();
    if (knownDepartment) department = knownDepartment.name;
    // A department nobody has created yet is made only when the form said so
    // (its "＋ Add" row) — a typo arriving any other way is refused.
    else if (req.body.newDepartment === true) createDepartment = true;
    else {
      res.status(400);
      throw new Error(`There is no "${department}" department. Pick one from the list, or add it.`);
    }
  }
  if (designation === prevDesignation && department === prevDepartment) {
    res.status(400);
    throw new Error('Nothing has changed — pick a new designation or department.');
  }

  let effectiveDate = new Date();
  if (req.body.effectiveDate) {
    const d = new Date(`${String(req.body.effectiveDate).slice(0, 10)}T00:00:00+05:30`);
    if (Number.isNaN(d.getTime())) {
      res.status(400);
      throw new Error('Pick a valid effective date.');
    }
    effectiveDate = d;
  }

  // New names join the managed lists (Org Masters / Departments). The profile's
  // post-save hook would register them too, but best-effort and after the fact;
  // the department is created first so the list is right the moment this returns.
  if (createDepartment) await ensureDepartment(department);
  if (!knownDesignation) await ensureDesignation(designation);

  profile.designation = designation;
  profile.department = department;
  await profile.save();

  const promotion = await Promotion.create({
    employee: profile._id,
    user: profile.user._id,
    company: profile.company || undefined,
    previousDesignation: prevDesignation,
    newDesignation: designation,
    previousDepartment: prevDepartment,
    newDepartment: department,
    effectiveDate,
    remarks: clean(req.body.remarks).slice(0, 500) || undefined,
    promotedBy: req.user._id,
    promotedByName: fullName(req.user) || req.user.email,
  });

  announcePromotion(profile, promotion, req.user);

  res.status(201).json({
    promotion,
    profile: { _id: profile._id, designation: profile.designation, department: profile.department },
  });
});

module.exports = {
  requirePromoter,
  canPromote,
  promotionOptions,
  listPromotions,
  createPromotion,
  announcePromotion,
  buildPromotionLetter,
  promotionLetterPdf,
};
