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

module.exports = { TUTOR_ROLES, TUTOR_ONLY };
