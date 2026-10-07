// Who gets reminded about a provider's sessions, now that a team member can hold
// Calendar Access.
//
//   node scripts/calendarAudience.check.js
//
// No database and no network. The user lookup is a stand-in keyed by id, so the
// owner's stored team is the only thing the rule can be reading.
//
// The sharp edge is the privilege string. `View Calender` is stored with a
// historical typo and matched literally, so a member whose grant says
// `View Calendar` — the spelling the UI displays, and the one anybody would
// "fix" it to — matches nothing at all. That member receives no reminders and
// nothing reports an error, so it is asserted here rather than left to be
// discovered as silence.

const User = require('../models/user.js');

const PROVIDER = 'a'.repeat(24);
const OTHER_PROVIDER = 'b'.repeat(24);
const WATCHER = 'c'.repeat(24);
const WRONG_SPELLING = 'd'.repeat(24);
const OTHER_GRANT = 'e'.repeat(24);
const UNCHECKED = 'f'.repeat(24);
const PENDING = '1'.repeat(24);
const WATCHER_AND_TUTOR = '2'.repeat(24);
const MIXED_GRANTS = '3'.repeat(24);
const NO_PRIVILEGES = '4'.repeat(24);
const STRANGER = '9'.repeat(24);

const flag = (value, checked = true) => ({ value, checked });

const approved = (tutorId, privileges) => ({
  ownerId: PROVIDER,
  tutorId,
  memberRole: 'tutor',
  status: 'accepted',
  privileges,
});

const TEAMS = {
  [PROVIDER]: {
    _id: PROVIDER,
    teamMembers: [
      approved(WATCHER, [flag('View Calender')]),
      // The typo trap: the correctly-spelled grant matches nothing.
      approved(WRONG_SPELLING, [flag('View Calendar')]),
      approved(OTHER_GRANT, [flag('Send Email')]),
      approved(UNCHECKED, [flag('View Calender', false)]),
      // An invitation that was never accepted grants nothing.
      { ...approved(PENDING, [flag('View Calender')]), status: 'pending' },
      // Also assigned to the course below, so this one appears in both lists and
      // must still be reminded exactly once.
      approved(WATCHER_AND_TUTOR, [flag('View Calender')]),
      // One ticked grant among several is enough.
      approved(MIXED_GRANTS, [flag('Send Email'), flag('View Calender')]),
      // A legacy entry with no privileges array must not throw.
      approved(NO_PRIVILEGES, undefined),
    ],
  },
  // Another provider's team, to prove the lookup is keyed on the session's owner.
  [OTHER_PROVIDER]: {
    _id: OTHER_PROVIDER,
    teamMembers: [approved(STRANGER, [flag('View Calender')])],
  },
};

// --- the stand-ins -----------------------------------------------------------

User.findById = (id) => ({
  select: async () => TEAMS[String(id)] || null,
});

const {
  CALENDAR_PRIVILEGE,
  providerCalendarWatchers,
  sessionOwners,
  deliveryAudience,
  reminderAudience,
} = require('../services/sessionReminderService.js');

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
  console.log('--- the stored grant ---\n');

  check(
    "the privilege is the stored 'View Calender', typo and all",
    CALENDAR_PRIVILEGE === 'View Calender',
    `it is '${CALENDAR_PRIVILEGE}'`,
  );

  console.log('');
  console.log("--- who counts as a watcher ---\n");

  const watchers = await providerCalendarWatchers(PROVIDER);
  const has = (id) => watchers.includes(id);

  check('a member granted Calendar Access is a watcher', has(WATCHER));
  check(
    'a member whose grant uses the corrected spelling is NOT — the stored string is matched literally',
    !has(WRONG_SPELLING),
    'the correctly-spelled grant matched, so it would silently never fire',
  );
  check('a member holding only another privilege is not', !has(OTHER_GRANT));
  check('an unticked grant is not', !has(UNCHECKED));
  check('an unaccepted invitation is not', !has(PENDING));
  check('one ticked grant among several is enough', has(MIXED_GRANTS));
  check('an entry with no privileges array is skipped, not thrown on', !has(NO_PRIVILEGES));
  check('nobody from another provider is included', !has(STRANGER));
  check(
    'exactly three members qualify',
    watchers.length === 3,
    `it returned ${watchers.length}: ${watchers.join(', ')}`,
  );

  console.log('');
  console.log('--- the lookup itself ---\n');

  check('a provider with no team has no watchers', (await providerCalendarWatchers(OTHER_PROVIDER)).length === 1);
  check('an unknown account has none', (await providerCalendarWatchers(STRANGER)).length === 0);
  check('a malformed id has none, and does not query', (await providerCalendarWatchers('nope')).length === 0);
  check('a missing id has none', (await providerCalendarWatchers(undefined)).length === 0);

  console.log('');
  console.log('--- whose calendar a session belongs to ---\n');

  check(
    'a course session belongs to its instructor',
    sessionOwners({ instructorId: PROVIDER }).join() === PROVIDER,
  );
  check(
    'an event session belongs to its author',
    sessionOwners({ authorId: PROVIDER }).join() === PROVIDER,
  );
  // The privacy line: an appointment is a private two-party meeting, and pushing
  // it to a member's own inbox and Google account is not what a view grant buys.
  check(
    'an appointment has no owner, so no watcher is added to it',
    sessionOwners({ from: PROVIDER, to: WATCHER }).length === 0,
  );

  console.log('');
  console.log('--- the merged audience ---\n');

  const course = {
    _id: '5'.repeat(24),
    title: 'Web Development',
    instructorId: PROVIDER,
    assignedTutors: [WATCHER_AND_TUTOR],
    enrolledStudents: [STRANGER],
    enrollments: [],
  };

  const merged = deliveryAudience(course, 'course', [WATCHER, WATCHER_AND_TUTOR]);
  check('the learners are still in the audience', merged.includes(STRANGER));
  check("the course's own tutor is still in the audience", merged.includes(WATCHER_AND_TUTOR));
  check('the watcher is added', merged.includes(WATCHER));
  check(
    'a member who is also the assigned tutor appears once',
    merged.filter((id) => id === WATCHER_AND_TUTOR).length === 1,
    `they appear ${merged.filter((id) => id === WATCHER_AND_TUTOR).length} times`,
  );
  check(
    'the merge adds exactly the new watchers and nothing else',
    merged.length === reminderAudience(course, 'course').length + 1,
    `merged ${merged.length} against ${reminderAudience(course, 'course').length} + 1`,
  );
  check(
    'no watchers leaves the audience exactly as it was',
    deliveryAudience(course, 'course', []).length === reminderAudience(course, 'course').length,
  );

  console.log('');
  if (failed) {
    console.log(`${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('the calendar audience resolves, dedupes and stays off appointments');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
