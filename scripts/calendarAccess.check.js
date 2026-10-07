// Who may open a provider's calendar, and whose diary the answer is scoped to.
//
//   node scripts/calendarAccess.check.js
//
// No database and no network. The stand-ins are behavioural on purpose: the
// appointment lookup matches the filter it is handed the way MongoDB would, so a
// resolution that never got awaited — or that scoped to the wrong account —
// produces an empty diary and fails the run rather than passing quietly.
//
// This is the fix for the half-empty calendar. A team member granted Calendar
// Access works inside the provider's workspace with their OWN token, so the
// request arrives naming the member while asking for the provider's appointments.
// The check this replaced compared the two and refused, which is why the page
// loaded with a 403 and nothing on it.

const mongoose = require('mongoose');
const User = require('../models/user.js');
const Appointment = require('../models/appointment.js');

const PROVIDER = 'a'.repeat(24);
const ADMIN = 'b'.repeat(24);
const MEMBER = 'c'.repeat(24);          // holds 'View Calender'
const UNGRANTED = 'd'.repeat(24);       // holds only another privilege
const MISSPELLED = 'e'.repeat(24);      // holds 'View Calendar', which matches nothing
const PENDING = 'f'.repeat(24);         // invited, never accepted
const STRANGER = '9'.repeat(24);        // no relationship at all
const THIRD_PARTY = '8'.repeat(24);     // on an appointment the provider is not on

const APPOINTMENT = '7'.repeat(24);
const FOREIGN_APPOINTMENT = '6'.repeat(24);

const flag = (value, checked = true) => ({ value, checked });

const entry = (ownerId, privileges, status = 'accepted') => ({
  ownerId,
  tutorId: ownerId === PROVIDER ? MEMBER : PROVIDER,
  status,
  privileges,
});

const PEOPLE = {
  [PROVIDER]: { _id: PROVIDER, role: 'tutor', fullname: 'Provider', premiumPlan: 'pro', teamMembers: [] },
  [ADMIN]: { _id: ADMIN, role: 'admin', fullname: 'Admin', teamMembers: [] },
  [MEMBER]: {
    _id: MEMBER,
    role: 'tutor',
    fullname: 'Member',
    teamMembers: [entry(PROVIDER, [flag('View Calender')])],
  },
  [UNGRANTED]: {
    _id: UNGRANTED,
    role: 'tutor',
    fullname: 'Ungranted',
    teamMembers: [entry(PROVIDER, [flag('Send Email')])],
  },
  [MISSPELLED]: {
    _id: MISSPELLED,
    role: 'tutor',
    fullname: 'Misspelled',
    teamMembers: [entry(PROVIDER, [flag('View Calendar')])],
  },
  [PENDING]: {
    _id: PENDING,
    role: 'tutor',
    fullname: 'Pending',
    teamMembers: [entry(PROVIDER, [flag('View Calender')], 'pending')],
  },
  [STRANGER]: { _id: STRANGER, role: 'tutor', fullname: 'Stranger', teamMembers: [] },
};

// Every appointment between the provider and a third party, plus one that is
// nobody's business here.
const APPOINTMENTS = [
  { _id: APPOINTMENT, from: PROVIDER, to: THIRD_PARTY, title: 'Check-in' },
  { _id: FOREIGN_APPOINTMENT, from: UNGRANTED, to: THIRD_PARTY, title: 'Not ours' },
];

// --- the stand-ins -----------------------------------------------------------

const seen = { appointmentFilter: null };

// A thenable that also offers `.lean()`, because the resolver awaits `.select(...)`
// directly while the controllers chain through it.
const loaded = (value) => {
  const promise = Promise.resolve(value);
  promise.lean = async () => value;
  promise.populate = () => loaded(value);
  return promise;
};

User.findById = (id) => ({ select: () => loaded(PEOPLE[String(id)] || null) });

Appointment.find = (filter) => {
  seen.appointmentFilter = filter;
  // Matched the way MongoDB would: the `$or` is read, and anything else — an
  // un-awaited resolution leaving the filter undefined — matches nothing.
  const wanted = (filter?.$or || []).map((clause) => Object.values(clause)[0]);
  const rows = wanted.length
    ? APPOINTMENTS.filter(
        (row) => wanted.includes(String(row.from)) || wanted.includes(String(row.to)),
      )
    : [];
  return { populate: () => loaded(rows) };
};

// `.populate({ path: 'from to' })` replaces the id with the participant
// document, which is what the single-appointment check reads: `from?._id`, not
// `from`. The stand-in does the same, so a controller reading the wrong field
// finds nothing and fails rather than passing on the raw id.
const populated = (row) => (row ? { ...row, from: { _id: row.from }, to: { _id: row.to } } : null);

Appointment.findById = (id) => ({
  populate: () => loaded(populated(APPOINTMENTS.find((row) => row._id === id))),
});

const appointmentControllers = require('../controllers/appointmentController.js');

const call = (controller, req) =>
  new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body });
        return this;
      },
    };
    try {
      controller(req, res).catch(reject);
    } catch (error) {
      reject(error);
    }
  });

const viewDiary = (actorId, requested, acting) =>
  call(appointmentControllers.getAppointments, {
    params: { id: requested },
    user: { id: actorId, role: PEOPLE[actorId]?.role },
    headers: acting ? { 'x-acting-owner': acting } : {},
  });

const viewOne = (actorId, appointmentId, acting) =>
  call(appointmentControllers.getAppointment, {
    params: { id: appointmentId },
    user: { id: actorId, role: PEOPLE[actorId]?.role },
    headers: acting ? { 'x-acting-owner': acting } : {},
  });

let failed = 0;
const check = (name, ok, detail) => {
  if (ok) {
    console.log(`ok   ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
};

async function main() {
  console.log('--- the diary ---\n');

  const own = await viewDiary(PROVIDER, PROVIDER);
  check('a provider opening their own calendar is served', own.status === 200, `answered ${own.status}`);
  check(
    'and it is scoped to them',
    JSON.stringify(seen.appointmentFilter) === JSON.stringify({ $or: [{ from: PROVIDER }, { to: PROVIDER }] }),
    JSON.stringify(seen.appointmentFilter),
  );

  const member = await viewDiary(MEMBER, PROVIDER, PROVIDER);
  check(
    'a member granted Calendar Access opening the provider calendar is served, not refused',
    member.status === 200,
    `answered ${member.status} — ${member.body?.message || ''}`,
  );
  check(
    'and it is scoped to the PROVIDER, not to the member — otherwise the page loads empty',
    JSON.stringify(seen.appointmentFilter) === JSON.stringify({ $or: [{ from: PROVIDER }, { to: PROVIDER }] }),
    JSON.stringify(seen.appointmentFilter),
  );
  check(
    'so the provider appointments come back',
    (member.body?.appointment || []).length === 1,
    `it returned ${(member.body?.appointment || []).length}`,
  );

  const admin = await viewDiary(ADMIN, PROVIDER);
  check('an admin may open anybody calendar', admin.status === 200, `answered ${admin.status}`);

  console.log('');
  console.log('--- the refusals ---\n');

  const ungranted = await viewDiary(UNGRANTED, PROVIDER, PROVIDER);
  check(
    'a member without Calendar Access is refused',
    ungranted.status === 403,
    `answered ${ungranted.status}`,
  );

  const misspelled = await viewDiary(MISSPELLED, PROVIDER, PROVIDER);
  check(
    "a member whose grant says 'View Calendar' is refused — the stored string is matched literally",
    misspelled.status === 403,
    `answered ${misspelled.status}`,
  );

  const pending = await viewDiary(PENDING, PROVIDER, PROVIDER);
  check('an unaccepted invitation is refused', pending.status === 403, `answered ${pending.status}`);

  const stranger = await viewDiary(STRANGER, PROVIDER, PROVIDER);
  check('a stranger naming a provider is refused', stranger.status === 403, `answered ${stranger.status}`);

  // The diary resolves the account from the path, which is the whole reason the
  // member's calendar works without a frontend change: the page already asks for
  // the provider's id. The header is not what opens this one.
  const noHeader = await viewDiary(MEMBER, PROVIDER);
  check(
    'the member needs no acting header for the diary — the id in the path is the request',
    noHeader.status === 200,
    `answered ${noHeader.status}`,
  );

  const noHeaderStranger = await viewDiary(STRANGER, PROVIDER);
  check(
    'while a stranger sending the same request is still refused',
    noHeaderStranger.status === 403,
    `answered ${noHeaderStranger.status}`,
  );

  console.log('');
  console.log('--- one appointment ---\n');

  const one = await viewOne(MEMBER, APPOINTMENT, PROVIDER);
  check(
    'a member granted Calendar Access may open an appointment the provider is on',
    one.status === 200,
    `answered ${one.status} — ${one.body?.message || ''}`,
  );

  const foreign = await viewOne(MEMBER, FOREIGN_APPOINTMENT, PROVIDER);
  check(
    'but not one the provider is not on — the privilege is a view of that diary, not of every diary',
    foreign.status === 403,
    `answered ${foreign.status}`,
  );

  const ownOne = await viewOne(PROVIDER, APPOINTMENT);
  check('a provider may open their own appointment', ownOne.status === 200, `answered ${ownOne.status}`);

  const strangerOne = await viewOne(STRANGER, APPOINTMENT);
  check(
    "a stranger may not open somebody else's appointment",
    strangerOne.status === 403,
    `answered ${strangerOne.status}`,
  );

  console.log('');
  if (failed) {
    console.log(`${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('the calendar delegation serves the granted member and refuses everybody else');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
