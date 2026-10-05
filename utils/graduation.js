/**
 * Whether a student has earned a certificate: paid up, and passed.
 *
 * `User.graduate` is a single boolean on the account, and it is that flag which
 * unlocks the certificate. So the graduation gate is deliberately a
 * whole-student one rather than a per-course one: a student enrolled on three of
 * a provider's courses is graduated once, and all three have to be finished
 * before that is true. A per-course rule would set the same global flag on the
 * strength of one course and hand out a certificate for a course still owing
 * money.
 *
 * The assessment rule is one platform-wide pass mark rather than a per-assessment
 * setting. A provider who wants a harder bar writes more questions, and "passed"
 * has to mean the same thing on every certificate the platform issues — which is
 * also why the mark is not stored on the assessment: a provider editing it would
 * silently re-decide certificates already in students' hands.
 */

const DEFAULT_PASS_MARK_PERCENT = 50;

/**
 * The pass mark in force, as a percentage of an assessment's questions.
 *
 * Overridable so a demo or a pilot cohort can move the bar without a deploy. An
 * override that is not a number in 0..100 is ignored rather than clamped: an
 * empty env var reads as 0 through Number(), and a typo silently becoming
 * "everybody passes" is a worse outcome than the built-in default.
 */
function passMarkPercent() {
  const configured = process.env.ASSESSMENT_PASS_MARK_PERCENT;
  if (configured === undefined || String(configured).trim() === '') {
    return DEFAULT_PASS_MARK_PERCENT;
  }

  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    console.warn(
      `ASSESSMENT_PASS_MARK_PERCENT is not a percentage (got "${configured}");`
      + ` using ${DEFAULT_PASS_MARK_PERCENT}.`,
    );
    return DEFAULT_PASS_MARK_PERCENT;
  }

  return parsed;
}

/** How many questions an assessment asks. */
function questionCount(assessment) {
  return Array.isArray(assessment?.assesment) ? assessment.assesment.length : 0;
}

/** The student's own response, or undefined when they never sat it. */
function responseFor(assessment, studentId) {
  return (assessment?.responses || []).find(
    (entry) => String(entry?.student) === String(studentId),
  );
}

/**
 * One assessment judged against the pass mark.
 *
 * The three failing outcomes are kept apart because each needs a different
 * person to do something: `not_attempted` needs the student, `awaiting_grade`
 * needs the provider, and `below_pass_mark` is simply a fail. Collapsing them
 * into a boolean would leave the provider reading "not passed" and going to look
 * for a response that does not exist.
 *
 * A score is a count of correct answers, not a percentage — the result page
 * renders it as `score / total` and the scored-email formats it the same way —
 * so the comparison has to divide by the question count first.
 */
function judgeAssessment(assessment, studentId, mark) {
  const total = questionCount(assessment);
  // Nothing to pass. An assessment with no questions can never produce a score
  // that reaches the mark, so counting it would block graduation permanently
  // over what is really a half-built assessment; it is left out of the gate.
  if (total <= 0) return { status: 'not_assessable', total: 0 };

  const response = responseFor(assessment, studentId);
  if (!response) return { status: 'not_attempted', total };

  const score = Number(response.score);
  // A theory assessment has no score until a provider grades it, and an
  // ungraded one must not read as a zero.
  if (!Number.isFinite(score)) return { status: 'awaiting_grade', total };

  const percent = (score / total) * 100;
  // The epsilon is for the mark landing exactly on a fraction that does not
  // divide cleanly in binary — 3 of 6 is 50%, and the provider should not be
  // told their student failed on a rounding artefact.
  if (percent + 1e-9 >= mark) return { status: 'passed', score, total, percent };

  return { status: 'below_pass_mark', score, total, percent };
}

/**
 * Where one student stands across every assessment assigned to them.
 *
 * Not scoped to the provider asking: `assignedStudents` is the only grouping an
 * assessment has (there is no course on it), and ignoring an assessment because
 * a different provider set it would issue a certificate to a student who has
 * not passed everything. An assessment the caller cannot act on is reported by
 * title in `outstanding`, so it is visible rather than silent.
 *
 * `outstanding` carries the reason as well as the title, so the refusal can name
 * what is missing instead of a count nobody can act on.
 */
function summarizeAssessments(assessments, studentId, mark = passMarkPercent()) {
  const outstanding = [];
  let passed = 0;
  let judged = 0;

  for (const assessment of assessments || []) {
    const verdict = judgeAssessment(assessment, studentId, mark);
    if (verdict.status === 'not_assessable') continue;

    judged += 1;
    if (verdict.status === 'passed') {
      passed += 1;
      continue;
    }

    outstanding.push({
      id: assessment?._id ? String(assessment._id) : null,
      title: assessment?.title || 'Untitled assessment',
      reason: verdict.status,
      score: verdict.score ?? null,
      total: verdict.total ?? null,
      percent: verdict.percent === undefined
        ? null
        : Math.round(verdict.percent * 10) / 10,
    });
  }

  return { total: judged, passed, outstanding, allPassed: outstanding.length === 0, passMark: mark };
}

/**
 * What to tell the provider when graduation is refused.
 *
 * Names the shortfalls rather than saying "requirements not met": the two have
 * completely different fixes — collect the balance, or chase the assessment —
 * and a provider told only that something is missing has to go hunting for what.
 */
function graduationRefusalMessage({ unpaidCourses = [], assessments = [] } = {}) {
  const parts = [];

  if (unpaidCourses.length === 1) {
    parts.push(`the balance on ${unpaidCourses[0].title || 'one course'} is unpaid`);
  } else if (unpaidCourses.length > 1) {
    parts.push(`${unpaidCourses.length} courses still have an unpaid balance`);
  }

  if (assessments.length === 1) {
    parts.push(`the assessment "${assessments[0].title}" has not been passed`);
  } else if (assessments.length > 1) {
    parts.push(`${assessments.length} assessments have not been passed`);
  }

  if (!parts.length) return 'This student is not eligible to graduate yet.';

  return `This student cannot be made a graduate yet: ${parts.join(', and ')}.`;
}

module.exports = {
  DEFAULT_PASS_MARK_PERCENT,
  passMarkPercent,
  questionCount,
  responseFor,
  judgeAssessment,
  summarizeAssessments,
  graduationRefusalMessage,
};
