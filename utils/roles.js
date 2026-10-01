// Shared authorization role groups.
//
// `provider` is the same product persona as `tutor`. Users who register through
// the sign-up form are stored with role `provider` (the form sends
// userType "provider", and determineRole("provider") -> "provider"), and the
// login redirect groups tutor/provider/team_member onto the same /tutor
// dashboard. Any route a tutor can reach must therefore also admit `provider`,
// or every form-registered tutor gets a 403. (This was the cause of the empty
// "Select Student" list in the Enroll Student modal: GET /user/students only
// allowed tutor/admin/team_member, so provider tutors were rejected and the
// frontend surfaced it as an empty list.)

// Full tutor family, including delegated team members. Controllers still
// enforce per-action privileges for team members.
const TUTOR_ROLES = ['tutor', 'provider', 'admin', 'team_member'];

// Tutor family without team members, for owner/admin-only actions.
const TUTOR_ONLY = ['tutor', 'provider', 'admin'];

// Everyone who is here to learn. `client` is the same product persona as
// `student`, for the same reason `provider` is the same persona as `tutor`
// above: the public sign-up form sends userType "client" for a student
// (SignUpComp.tsx), so every self-registered student is stored as `client`
// while learners created by other paths — an enrolled student, a registrar's
// account — are stored as `student`.
//
// Checking for 'student' alone therefore silently excludes exactly the people
// who signed themselves up. That is what made "Make Graduate" answer "Only
// students can be marked as graduates" for a student plainly visible in the
// list, and what kept those graduates out of the tutor and admin graduate
// counts. Any query or guard about learners must use this set.
const LEARNER_ROLES = ['student', 'client'];

/** True when the role belongs to a learner, in either of its two spellings. */
const isLearnerRole = (role) => LEARNER_ROLES.includes(role);

module.exports = { TUTOR_ROLES, TUTOR_ONLY, LEARNER_ROLES, isLearnerRole };
